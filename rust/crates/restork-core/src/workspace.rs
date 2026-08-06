//! Symlink-safe, hash-checked access to the user's explicitly configured Vault.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_FILES: usize = 4_000;
const MAX_WORK_FILE_BYTES: u64 = 200_000;
const MAX_WORK_FILES: usize = 2_000;
const MAX_WORK_BYTES: u64 = 20_000_000;

#[derive(Clone, Debug)]
pub struct SafeWorkspace {
    root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceSearchHit {
    pub relative_path: String,
    pub excerpt: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WritePreview {
    pub relative_path: String,
    pub existed: bool,
    pub current_sha256: Option<String>,
    pub next_sha256: String,
    pub changed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceFileSnapshot {
    pub relative_path: String,
    pub sha256: String,
    pub byte_count: u64,
    pub language: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceSnapshot {
    pub workspace_id: String,
    pub snapshot_sha256: String,
    pub files: Vec<WorkspaceFileSnapshot>,
}

#[derive(Debug)]
pub enum WorkspaceError {
    InvalidRoot,
    InvalidPath,
    OutsideRoot,
    SymlinkDenied,
    TooLarge,
    Conflict,
    Io(io::Error),
}

impl From<io::Error> for WorkspaceError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl SafeWorkspace {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let root = root
            .as_ref()
            .canonicalize()
            .map_err(|_| WorkspaceError::InvalidRoot)?;
        if !root.is_dir() {
            return Err(WorkspaceError::InvalidRoot);
        }
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn read_note(&self, relative_path: &str) -> Result<(String, String), WorkspaceError> {
        self.read_text(relative_path, MAX_NOTE_BYTES)
    }

    pub fn read_text(
        &self,
        relative_path: &str,
        maximum_bytes: u64,
    ) -> Result<(String, String), WorkspaceError> {
        let path = self.resolve_existing(relative_path)?;
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() || maximum_bytes == 0 || metadata.len() > maximum_bytes {
            return Err(WorkspaceError::TooLarge);
        }
        let bytes = fs::read(path)?;
        let content = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidPath)?;
        let digest = sha256_hex(content.as_bytes());
        Ok((content, digest))
    }

    pub fn validate_work_path(&self, relative_path: &str) -> Result<String, WorkspaceError> {
        let relative = validate_relative(relative_path)?;
        if denied_work_path(relative) || !allowed_work_file(relative) {
            return Err(WorkspaceError::InvalidPath);
        }
        Ok(relative.to_string_lossy().replace('\\', "/"))
    }

    pub fn work_file_exists(&self, relative_path: &str) -> Result<bool, WorkspaceError> {
        let relative_path = self.validate_work_path(relative_path)?;
        let path = self.root.join(&relative_path);
        if !path.exists() {
            validate_missing_parent(&self.root, &path)?;
            return Ok(false);
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkDenied);
        }
        let canonical = path.canonicalize()?;
        Ok(metadata.is_file() && canonical.starts_with(&self.root))
    }

    pub fn work_snapshot(&self) -> Result<WorkspaceSnapshot, WorkspaceError> {
        let mut files = Vec::new();
        let mut total_bytes = 0_u64;
        let mut stack = vec![self.root.clone()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                let relative = path
                    .strip_prefix(&self.root)
                    .map_err(|_| WorkspaceError::OutsideRoot)?;
                if file_type.is_dir() {
                    if !denied_work_path(relative) {
                        stack.push(path);
                    }
                    continue;
                }
                if !file_type.is_file()
                    || denied_work_path(relative)
                    || !allowed_work_file(relative)
                {
                    continue;
                }
                let metadata = entry.metadata()?;
                if metadata.len() > MAX_WORK_FILE_BYTES {
                    continue;
                }
                total_bytes = total_bytes.saturating_add(metadata.len());
                if files.len() >= MAX_WORK_FILES || total_bytes > MAX_WORK_BYTES {
                    return Err(WorkspaceError::TooLarge);
                }
                let bytes = fs::read(&path)?;
                if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                    continue;
                }
                files.push(WorkspaceFileSnapshot {
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    sha256: sha256_hex(&bytes),
                    byte_count: metadata.len(),
                    language: work_language(relative),
                });
            }
        }
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let mut digest = Sha256::new();
        for file in &files {
            digest.update(file.relative_path.as_bytes());
            digest.update(b"\0");
            digest.update(file.sha256.as_bytes());
            digest.update(b"\0");
            digest.update(file.byte_count.to_string().as_bytes());
            digest.update(b"\n");
        }
        let workspace_id = format!(
            "workspace-{}",
            &sha256_hex(self.root.to_string_lossy().as_bytes())[..24]
        );
        Ok(WorkspaceSnapshot {
            workspace_id,
            snapshot_sha256: digest
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            files,
        })
    }

    pub fn search_notes(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<WorkspaceSearchHit>, WorkspaceError> {
        let query = query.trim().to_lowercase();
        if query.is_empty() || query.len() > 512 || !(1..=50).contains(&limit) {
            return Err(WorkspaceError::InvalidPath);
        }
        let terms = query.split_whitespace().collect::<Vec<_>>();
        let mut candidates = Vec::new();
        let mut stack = vec![self.root.clone()];
        let mut visited = 0_usize;
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() {
                    let name = entry.file_name();
                    if !matches!(name.to_str(), Some(".git" | ".obsidian" | ".trash")) {
                        stack.push(path);
                    }
                    continue;
                }
                if path.extension().and_then(|value| value.to_str()) != Some("md") {
                    continue;
                }
                visited = visited.saturating_add(1);
                if visited > MAX_SEARCH_FILES {
                    break;
                }
                let metadata = entry.metadata()?;
                if metadata.len() > MAX_NOTE_BYTES {
                    continue;
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                let relative = path
                    .strip_prefix(&self.root)
                    .map_err(|_| WorkspaceError::OutsideRoot)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let haystack = format!("{}\n{}", relative.to_lowercase(), content.to_lowercase());
                let score = terms
                    .iter()
                    .filter(|term| haystack.contains(**term))
                    .count();
                if score != terms.len() {
                    continue;
                }
                let excerpt = matching_excerpt(&content, &terms);
                candidates.push((
                    score,
                    WorkspaceSearchHit {
                        relative_path: relative,
                        excerpt,
                        sha256: sha256_hex(content.as_bytes()),
                    },
                ));
            }
            if visited > MAX_SEARCH_FILES {
                break;
            }
        }
        candidates.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.relative_path.cmp(&right.1.relative_path))
        });
        candidates.truncate(limit);
        Ok(candidates.into_iter().map(|(_, hit)| hit).collect())
    }

    pub fn markdown_paths(&self, maximum: usize) -> Result<Vec<String>, WorkspaceError> {
        if maximum == 0 || maximum > MAX_SEARCH_FILES {
            return Err(WorkspaceError::InvalidPath);
        }
        let mut paths = Vec::new();
        let mut stack = vec![self.root.clone()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() {
                    let name = entry.file_name();
                    if !matches!(name.to_str(), Some(".git" | ".obsidian" | ".trash")) {
                        stack.push(path);
                    }
                } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
                    let relative = path
                        .strip_prefix(&self.root)
                        .map_err(|_| WorkspaceError::OutsideRoot)?
                        .to_string_lossy()
                        .replace('\\', "/");
                    paths.push(relative);
                    if paths.len() >= maximum {
                        paths.sort();
                        return Ok(paths);
                    }
                }
            }
        }
        paths.sort();
        Ok(paths)
    }

    pub fn preview_write(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<WritePreview, WorkspaceError> {
        if content.len() as u64 > MAX_NOTE_BYTES {
            return Err(WorkspaceError::TooLarge);
        }
        let path = self.resolve_write_target(relative_path)?;
        let current = if path.exists() {
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(WorkspaceError::SymlinkDenied);
            }
            let bytes = fs::read(&path)?;
            if bytes.len() as u64 > MAX_NOTE_BYTES {
                return Err(WorkspaceError::TooLarge);
            }
            Some(sha256_hex(&bytes))
        } else {
            None
        };
        let next = sha256_hex(content.as_bytes());
        Ok(WritePreview {
            relative_path: relative_path.to_owned(),
            existed: current.is_some(),
            changed: current.as_deref() != Some(next.as_str()),
            current_sha256: current,
            next_sha256: next,
        })
    }

    pub fn apply_write(
        &self,
        relative_path: &str,
        content: &str,
        expected_sha256: Option<&str>,
    ) -> Result<WritePreview, WorkspaceError> {
        let preview = self.preview_write(relative_path, content)?;
        if preview.current_sha256.as_deref() != expected_sha256 {
            return Err(WorkspaceError::Conflict);
        }
        if !preview.changed {
            return Ok(preview);
        }
        let target = self.resolve_write_target(relative_path)?;
        let parent = target.parent().ok_or(WorkspaceError::InvalidPath)?;
        let mut entropy = [0_u8; 12];
        getrandom::fill(&mut entropy).map_err(|_| WorkspaceError::InvalidPath)?;
        let suffix = entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temporary = parent.join(format!(".restork-write-{suffix}.tmp"));
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        output.write_all(content.as_bytes())?;
        output.sync_all()?;
        drop(output);
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(WorkspaceError::Io(error));
        }
        Ok(preview)
    }

    fn resolve_existing(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
        let relative = validate_relative(relative_path)?;
        let joined = self.root.join(relative);
        let metadata = fs::symlink_metadata(&joined)?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkDenied);
        }
        let canonical = joined.canonicalize()?;
        if !canonical.starts_with(&self.root) {
            return Err(WorkspaceError::OutsideRoot);
        }
        Ok(canonical)
    }

    fn resolve_write_target(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
        let relative = validate_relative(relative_path)?;
        if relative.extension().and_then(|value| value.to_str()) != Some("md") {
            return Err(WorkspaceError::InvalidPath);
        }
        let target = self.root.join(relative);
        let parent = target.parent().ok_or(WorkspaceError::InvalidPath)?;
        let canonical_parent = parent.canonicalize()?;
        if !canonical_parent.starts_with(&self.root) {
            return Err(WorkspaceError::OutsideRoot);
        }
        Ok(canonical_parent.join(target.file_name().ok_or(WorkspaceError::InvalidPath)?))
    }
}

fn validate_relative(value: &str) -> Result<&Path, WorkspaceError> {
    if value.is_empty() || value.len() > 4_096 || value.contains(['\0', '\n', '\r']) {
        return Err(WorkspaceError::InvalidPath);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(path)
}

fn validate_missing_parent(root: &Path, target: &Path) -> Result<(), WorkspaceError> {
    let mut parent = target.parent().ok_or(WorkspaceError::InvalidPath)?;
    while !parent.exists() && parent != root {
        parent = parent.parent().ok_or(WorkspaceError::OutsideRoot)?;
    }
    let metadata = fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkDenied);
    }
    if !parent.canonicalize()?.starts_with(root) {
        return Err(WorkspaceError::OutsideRoot);
    }
    Ok(())
}

fn denied_work_path(path: &Path) -> bool {
    const DENIED: [&str; 16] = [
        ".git",
        ".hg",
        ".idea",
        ".obsidian",
        ".svn",
        ".vscode",
        "__pycache__",
        "artifacts",
        "build",
        "cache",
        "coverage",
        "dist",
        "node_modules",
        "secrets",
        "target",
        "vendor",
    ];
    path.components().any(|component| {
        let Component::Normal(part) = component else {
            return true;
        };
        let folded = part.to_string_lossy().to_ascii_lowercase();
        (folded.starts_with('.') && folded != ".github") || DENIED.contains(&folded.as_str())
    })
}

fn allowed_work_file(path: &Path) -> bool {
    const EXTENSIONS: [&str; 33] = [
        "c", "cc", "cpp", "css", "go", "h", "hpp", "html", "java", "js", "json", "jsx", "kt",
        "lock", "md", "mjs", "php", "py", "rb", "rs", "scss", "sh", "sql", "swift", "toml", "ts",
        "tsx", "txt", "xml", "yaml", "yml", "ini", "cfg",
    ];
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["dockerfile", "license", "makefile", "procfile"].contains(&name.as_str()) {
        return true;
    }
    if name.starts_with(".env")
        || [
            "secret",
            "token",
            "password",
            "passwd",
            "credential",
            "private_key",
        ]
        .iter()
        .any(|marker| name.contains(marker))
    {
        return false;
    }
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| EXTENSIONS.contains(&extension.as_str()))
}

fn work_language(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("text")
                .to_ascii_lowercase()
        })
}

fn matching_excerpt(content: &str, terms: &[&str]) -> String {
    content
        .lines()
        .find(|line| {
            let line = line.to_lowercase();
            terms.iter().any(|term| line.contains(*term))
        })
        .unwrap_or_else(|| content.lines().next().unwrap_or_default())
        .chars()
        .take(360)
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{SafeWorkspace, WorkspaceError};

    #[test]
    fn write_requires_the_reviewed_hash_and_rejects_traversal() {
        let directory = tempfile::tempdir().expect("temporary directory");
        std::fs::write(directory.path().join("note.md"), "before").expect("fixture");
        let workspace = SafeWorkspace::open(directory.path()).expect("workspace");
        let preview = workspace
            .preview_write("note.md", "after")
            .expect("preview");
        assert!(matches!(
            workspace.apply_write("note.md", "after", Some("wrong")),
            Err(WorkspaceError::Conflict)
        ));
        workspace
            .apply_write("note.md", "after", preview.current_sha256.as_deref())
            .expect("approved write");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("note.md")).expect("note"),
            "after"
        );
        assert!(matches!(
            workspace.preview_write("../outside.md", "bad"),
            Err(WorkspaceError::InvalidPath)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reads_do_not_follow_symlinks_outside_the_vault() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary directory");
        let outside = tempfile::NamedTempFile::new().expect("outside file");
        symlink(outside.path(), directory.path().join("escape.md")).expect("symlink");
        let workspace = SafeWorkspace::open(directory.path()).expect("workspace");
        assert!(matches!(
            workspace.read_note("escape.md"),
            Err(WorkspaceError::SymlinkDenied)
        ));
    }
}
