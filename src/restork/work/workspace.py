"""OS-independent, read-only workspace inspection with fail-closed path handling."""

from __future__ import annotations

import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath

from restork.artifacts.work import safe_relative_path

MAX_FILE_BYTES = 200_000
MAX_SCAN_FILES = 2_000
MAX_SCAN_BYTES = 20_000_000

_ALLOWED_SUFFIXES = frozenset(
    {
        ".c",
        ".cc",
        ".cpp",
        ".css",
        ".go",
        ".h",
        ".hpp",
        ".html",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".kt",
        ".lock",
        ".md",
        ".mjs",
        ".php",
        ".py",
        ".rb",
        ".rs",
        ".scss",
        ".sh",
        ".sql",
        ".swift",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".xml",
        ".yaml",
        ".yml",
    }
)
_ALLOWED_NAMES = frozenset({"dockerfile", "license", "makefile", "procfile"})
_DENIED_PARTS = frozenset(
    {
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
        "logs",
        "node_modules",
        "secrets",
        "target",
        "vendor",
        "venv",
    }
)
_SENSITIVE_NAME = re.compile(
    r"(?:^|[._-])(?:credential|credentials|id_rsa|id_ed25519|password|passwd|"
    r"private[-_]?key|secret|token)(?:$|[._-])",
    re.IGNORECASE,
)
_PRIVATE_PATH = re.compile(
    r"(?:/Users/[^/\s]+(?:/[^\s'\"`]*)?|/home/[^/\s]+(?:/[^\s'\"`]*)?|"
    r"[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s'\"`]*)?)"
)
_KNOWN_CREDENTIAL = re.compile(
    r"(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})"
)
_ASSIGNMENT_SECRET = re.compile(
    r"(?im)^(\s*(?:api[_-]?key|authorization|credential|password|passwd|secret|token)"
    r"\s*[:=]\s*)([^\s#]+)"
)
_PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?"
    r"-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    re.DOTALL,
)
_INSTRUCTION_NAMES = frozenset(
    {"agents.md", "claude.md", "contributing.md", "readme.md"}
)


class WorkspacePathError(ValueError):
    """A selected root or relative file violates the read-only workspace boundary."""


@dataclass(frozen=True)
class WorkspaceFile:
    relative_path: str
    content_hash: str
    byte_count: int
    language: str
    content: str


@dataclass(frozen=True)
class WorkspaceSnapshot:
    workspace_id: str
    snapshot_hash: str
    files: dict[str, WorkspaceFile]


class ReadOnlyWorkspace:
    """Read bounded UTF-8 source files without following links or invoking tools."""

    def __init__(self, root: Path) -> None:
        expanded = root.expanduser()
        if not expanded.is_absolute():
            raise WorkspacePathError("workspace root must be an absolute path")
        if expanded.is_symlink():
            raise WorkspacePathError("workspace root cannot be a symbolic link")
        try:
            resolved = expanded.resolve(strict=True)
        except OSError as error:
            raise WorkspacePathError(
                "workspace root must be an existing readable directory"
            ) from error
        if not resolved.is_dir():
            raise WorkspacePathError("workspace root must be an existing directory")
        self._root = resolved
        self._workspace_id = "workspace-" + sha256(str(resolved).encode()).hexdigest()[:24]

    @property
    def root(self) -> Path:
        return self._root

    @property
    def workspace_id(self) -> str:
        return self._workspace_id

    def read(self, relative_path: str) -> WorkspaceFile:
        canonical = self.validate_relative_path(relative_path)
        candidate = self._root.joinpath(*PurePosixPath(canonical).parts)
        if candidate.is_symlink() or not candidate.is_file():
            raise WorkspacePathError("workspace file must be a regular file")
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(self._root):
            raise WorkspacePathError("workspace file escapes the selected root")
        size = candidate.stat().st_size
        if size > MAX_FILE_BYTES:
            raise WorkspacePathError("workspace file exceeds the read limit")
        payload = candidate.read_bytes()
        if b"\x00" in payload:
            raise WorkspacePathError("binary workspace files are not supported")
        try:
            content = payload.decode("utf-8")
        except UnicodeDecodeError as error:
            raise WorkspacePathError("workspace file is not valid UTF-8 text") from error
        return WorkspaceFile(
            relative_path=canonical,
            content_hash=sha256(payload).hexdigest(),
            byte_count=len(payload),
            language=_language(candidate),
            content=content,
        )

    def exists(self, relative_path: str) -> bool:
        canonical = self.validate_relative_path(relative_path)
        candidate = self._root.joinpath(*PurePosixPath(canonical).parts)
        if candidate.is_symlink():
            raise WorkspacePathError("workspace file cannot be a symbolic link")
        if not candidate.exists():
            self._validate_missing_parent(candidate)
            return False
        return candidate.is_file() and candidate.resolve(strict=True).is_relative_to(self._root)

    def snapshot(self) -> WorkspaceSnapshot:
        files: dict[str, WorkspaceFile] = {}
        total_bytes = 0
        for candidate in sorted(self._root.rglob("*")):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            relative = candidate.relative_to(self._root).as_posix()
            try:
                self.validate_relative_path(relative)
                item = self.read(relative)
            except WorkspacePathError:
                continue
            files[relative] = item
            total_bytes += item.byte_count
            if len(files) > MAX_SCAN_FILES or total_bytes > MAX_SCAN_BYTES:
                raise WorkspacePathError("workspace exceeds the bounded inspection limit")
        digest = sha256()
        for path, item in sorted(files.items()):
            digest.update(f"{path}\0{item.content_hash}\0{item.byte_count}\n".encode())
        return WorkspaceSnapshot(self._workspace_id, digest.hexdigest(), files)

    def instruction_refs(self, snapshot: WorkspaceSnapshot) -> tuple[str, ...]:
        refs = [
            path
            for path in snapshot.files
            if PurePosixPath(path).name.casefold() in _INSTRUCTION_NAMES
            or path.casefold() == ".github/copilot-instructions.md"
        ]
        return tuple(sorted(refs))

    @staticmethod
    def validate_relative_path(value: str) -> str:
        try:
            canonical = safe_relative_path(value)
        except ValueError as error:
            raise WorkspacePathError(str(error)) from error
        path = PurePosixPath(canonical)
        folded = tuple(part.casefold() for part in path.parts)
        if any(part in _DENIED_PARTS for part in folded):
            raise WorkspacePathError("workspace path is excluded by policy")
        if any(part.startswith(".") and part != ".github" for part in folded):
            raise WorkspacePathError("hidden workspace paths are excluded by policy")
        name = path.name.casefold()
        if _SENSITIVE_NAME.search(name) or name.startswith(".env"):
            raise WorkspacePathError("sensitive workspace filenames are excluded")
        suffix = path.suffix.casefold()
        if suffix not in _ALLOWED_SUFFIXES and name not in _ALLOWED_NAMES:
            raise WorkspacePathError("workspace file type is not in the text allowlist")
        return canonical

    def _validate_missing_parent(self, candidate: Path) -> None:
        parent = candidate.parent
        while not parent.exists() and parent != self._root:
            parent = parent.parent
        if parent.is_symlink():
            raise WorkspacePathError("new workspace target has a symlink parent")
        resolved = parent.resolve(strict=True)
        if not resolved.is_relative_to(self._root):
            raise WorkspacePathError("new workspace target escapes the selected root")


def sanitize_context(content: str, root: Path) -> tuple[str, tuple[str, ...]]:
    """Redact known credential forms and absolute personal paths before packaging."""

    redactions: set[str] = set()
    sanitized = content.replace(str(root), "[WORKSPACE]")
    if sanitized != content:
        redactions.add("workspace_absolute_path")
    sanitized, count = _PRIVATE_PATH.subn("[PRIVATE_PATH]", sanitized)
    if count:
        redactions.add("personal_absolute_path")
    sanitized, count = _PRIVATE_KEY_BLOCK.subn("[REDACTED PRIVATE KEY]", sanitized)
    if count:
        redactions.add("private_key")
    sanitized, count = _KNOWN_CREDENTIAL.subn("[REDACTED CREDENTIAL]", sanitized)
    if count:
        redactions.add("credential_pattern")
    sanitized, count = _ASSIGNMENT_SECRET.subn(r"\1[REDACTED]", sanitized)
    if count:
        redactions.add("secret_assignment")
    return sanitized, tuple(sorted(redactions))


def redact_private_paths(value: str, root: Path) -> str:
    sanitized = value.replace(str(root), "[WORKSPACE]")
    return _PRIVATE_PATH.sub("[PRIVATE_PATH]", sanitized)


def _language(path: Path) -> str:
    name = path.name.casefold()
    if name in _ALLOWED_NAMES:
        return name
    return path.suffix.casefold().lstrip(".") or "text"
