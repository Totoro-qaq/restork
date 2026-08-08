//! Symlink-safe, hash-checked access to the user's explicitly configured Vault.

use std::{
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_FILES: usize = 4_000;
const MAX_WORK_FILE_BYTES: u64 = 200_000;
const MAX_WORK_FILES: usize = 2_000;
const MAX_WORK_BYTES: u64 = 20_000_000;

pub struct SafeWorkspace {
    root: PathBuf,
    directory: Dir,
}

impl std::fmt::Debug for SafeWorkspace {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SafeWorkspace")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceSearchHit {
    pub relative_path: String,
    pub excerpt: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceNoteMetadata {
    pub relative_path: String,
    pub byte_count: u64,
    pub modified_unix_ms: u64,
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
        let directory = Dir::open_ambient_dir(&root, ambient_authority())
            .map_err(|_| WorkspaceError::InvalidRoot)?;
        Ok(Self { root, directory })
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
        let bytes = self.read_regular_file(&path, maximum_bytes)?;
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
        let path = Path::new(&relative_path);
        let metadata = match self.directory.symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkDenied);
        }
        Ok(metadata.is_file())
    }

    pub fn work_snapshot(&self) -> Result<WorkspaceSnapshot, WorkspaceError> {
        let mut files = Vec::new();
        let mut total_bytes = 0_u64;
        let mut stack = vec![(self.directory.try_clone()?, PathBuf::new())];
        while let Some((directory, directory_path)) = stack.pop() {
            for entry in directory.entries()? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let relative = directory_path.join(entry.file_name());
                if file_type.is_dir() {
                    if !denied_work_path(&relative) {
                        stack.push((entry.open_dir()?, relative));
                    }
                    continue;
                }
                if !file_type.is_file()
                    || denied_work_path(&relative)
                    || !allowed_work_file(&relative)
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
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                let mut bytes = Vec::with_capacity(
                    usize::try_from(metadata.len()).unwrap_or(MAX_WORK_FILE_BYTES as usize),
                );
                entry
                    .open_with(&options)?
                    .take(MAX_WORK_FILE_BYTES.saturating_add(1))
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 > MAX_WORK_FILE_BYTES
                    || bytes.contains(&0)
                    || std::str::from_utf8(&bytes).is_err()
                {
                    continue;
                }
                files.push(WorkspaceFileSnapshot {
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    sha256: sha256_hex(&bytes),
                    byte_count: metadata.len(),
                    language: work_language(&relative),
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
        let mut stack = vec![(self.directory.try_clone()?, PathBuf::new())];
        let mut visited = 0_usize;
        while let Some((directory, directory_path)) = stack.pop() {
            for entry in directory.entries()? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let relative_path = directory_path.join(entry.file_name());
                if file_type.is_dir() {
                    let name = entry.file_name();
                    if !matches!(name.to_str(), Some(".git" | ".obsidian" | ".trash")) {
                        stack.push((entry.open_dir()?, relative_path));
                    }
                    continue;
                }
                if relative_path.extension().and_then(|value| value.to_str()) != Some("md") {
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
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                let mut content = String::new();
                let Ok(_) = entry
                    .open_with(&options)
                    .map(|file| file.take(MAX_NOTE_BYTES.saturating_add(1)))
                    .and_then(|mut file| file.read_to_string(&mut content))
                else {
                    continue;
                };
                if content.len() as u64 > MAX_NOTE_BYTES {
                    continue;
                }
                let relative = relative_path.to_string_lossy().replace('\\', "/");
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
        let mut stack = vec![(self.directory.try_clone()?, PathBuf::new())];
        while let Some((directory, directory_path)) = stack.pop() {
            for entry in directory.entries()? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let relative_path = directory_path.join(entry.file_name());
                if file_type.is_dir() {
                    let name = entry.file_name();
                    if !matches!(name.to_str(), Some(".git" | ".obsidian" | ".trash")) {
                        stack.push((entry.open_dir()?, relative_path));
                    }
                } else if relative_path.extension().and_then(|value| value.to_str()) == Some("md") {
                    let relative = relative_path.to_string_lossy().replace('\\', "/");
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

    /// Return a bounded, symlink-free inventory of Markdown notes without
    /// reading their contents. The modification stamp is used only to detect
    /// that a client should request a fresh list or preview; it is never used
    /// as an authorization or conflict token.
    pub fn markdown_index(
        &self,
        maximum: usize,
    ) -> Result<Vec<WorkspaceNoteMetadata>, WorkspaceError> {
        if maximum == 0 || maximum > MAX_SEARCH_FILES {
            return Err(WorkspaceError::InvalidPath);
        }
        let mut notes = Vec::new();
        let mut stack = vec![(self.directory.try_clone()?, PathBuf::new())];
        while let Some((directory, directory_path)) = stack.pop() {
            for entry in directory.entries()? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let relative_path = directory_path.join(entry.file_name());
                if file_type.is_dir() {
                    let name = entry.file_name();
                    if !matches!(name.to_str(), Some(".git" | ".obsidian" | ".trash")) {
                        stack.push((entry.open_dir()?, relative_path));
                    }
                    continue;
                }
                if relative_path.extension().and_then(|value| value.to_str()) != Some("md") {
                    continue;
                }
                let metadata = entry.metadata()?;
                if !metadata.is_file() || metadata.len() > MAX_NOTE_BYTES {
                    continue;
                }
                let modified_unix_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.into_std().duration_since(UNIX_EPOCH).ok())
                    .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
                    .unwrap_or_default();
                notes.push(WorkspaceNoteMetadata {
                    relative_path: relative_path.to_string_lossy().replace('\\', "/"),
                    byte_count: metadata.len(),
                    modified_unix_ms,
                });
                if notes.len() >= maximum {
                    notes.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
                    return Ok(notes);
                }
            }
        }
        notes.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(notes)
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
        let current = match self.directory.symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(WorkspaceError::SymlinkDenied);
                }
                if !metadata.is_file() || metadata.len() > MAX_NOTE_BYTES {
                    return Err(WorkspaceError::TooLarge);
                }
                let bytes = self.read_regular_file(&path, MAX_NOTE_BYTES)?;
                Some(sha256_hex(&bytes))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
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
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        let mut output = self.directory.open_with(&temporary, &options)?;
        output.write_all(content.as_bytes())?;
        output.sync_all()?;
        drop(output);
        if let Err(error) = self.directory.rename(&temporary, &self.directory, &target) {
            let _ = self.directory.remove_file(&temporary);
            return Err(WorkspaceError::Io(error));
        }
        Ok(preview)
    }

    fn resolve_existing(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
        let relative = validate_relative(relative_path)?;
        let metadata = self.directory.symlink_metadata(relative)?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkDenied);
        }
        self.directory.canonicalize(relative).map_err(Into::into)
    }

    fn read_regular_file(
        &self,
        relative_path: &Path,
        maximum_bytes: u64,
    ) -> Result<Vec<u8>, WorkspaceError> {
        if maximum_bytes == 0 {
            return Err(WorkspaceError::TooLarge);
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = self.directory.open_with(relative_path, &options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > maximum_bytes {
            return Err(WorkspaceError::TooLarge);
        }
        let mut bytes =
            Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(maximum_bytes as usize));
        file.take(maximum_bytes.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > maximum_bytes {
            return Err(WorkspaceError::TooLarge);
        }
        Ok(bytes)
    }

    fn resolve_write_target(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
        let relative = validate_relative(relative_path)?;
        if relative.extension().and_then(|value| value.to_str()) != Some("md") {
            return Err(WorkspaceError::InvalidPath);
        }
        let parent = relative
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let canonical_parent = self.directory.canonicalize(parent)?;
        Ok(canonical_parent.join(relative.file_name().ok_or(WorkspaceError::InvalidPath)?))
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

    #[cfg(unix)]
    #[test]
    fn capability_directory_blocks_intermediate_symlink_escape() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary directory");
        let outside = tempfile::tempdir().expect("outside directory");
        std::fs::write(outside.path().join("private.md"), "outside").expect("outside note");
        symlink(outside.path(), directory.path().join("escape")).expect("directory symlink");

        let workspace = SafeWorkspace::open(directory.path()).expect("workspace");
        assert!(workspace.read_note("escape/private.md").is_err());
        assert!(
            workspace
                .markdown_paths(50)
                .expect("markdown paths")
                .is_empty()
        );
        assert!(
            workspace
                .search_notes("outside", 10)
                .expect("search")
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn capability_remains_bound_to_the_reviewed_root_after_rename() {
        let parent = tempfile::tempdir().expect("temporary parent");
        let configured = parent.path().join("vault");
        let reviewed = parent.path().join("reviewed-vault");
        std::fs::create_dir(&configured).expect("configured root");
        std::fs::write(configured.join("note.md"), "reviewed").expect("reviewed note");
        let workspace = SafeWorkspace::open(&configured).expect("workspace");

        std::fs::rename(&configured, &reviewed).expect("move reviewed root");
        std::fs::create_dir(&configured).expect("replacement root");
        std::fs::write(configured.join("note.md"), "replacement").expect("replacement note");

        assert_eq!(
            workspace.read_note("note.md").expect("bound note").0,
            "reviewed"
        );
    }
}
