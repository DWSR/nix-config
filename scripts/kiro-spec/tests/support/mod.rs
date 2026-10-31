//! Shared temp-tree harness for the process-level integration tests.
//!
//! Every fixture is materialised under [`std::env::temp_dir`], never inside the
//! repository, and is removed when its [`TempTree`] is dropped. The harness
//! also spawns the compiled binary through `CARGO_BIN_EXE_kiro-spec` so tests
//! observe the same process boundary as an operator.
//!
//! Each integration test binary includes this module separately, so a helper
//! used by one test file is unused in another; the complete harness API stays
//! available without per-binary dead-code warnings.
#![allow(dead_code)]

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// A disposable repository root containing `.kiro/specs/<name>/` trees.
pub struct TempTree {
    root: PathBuf,
}

impl TempTree {
    /// Create an empty disposable tree whose directory name starts with `label`.
    pub fn new(label: &str) -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "kiro-spec-{}-{}-{id}",
            sanitize(label),
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temporary tree root is created");
        Self { root }
    }

    /// Create a tree with one spec directory populated from declarative files.
    ///
    /// Each `(path, contents)` pair is written relative to the spec directory.
    pub fn with_spec(label: &str, spec: &str, files: &[(&str, &str)]) -> Self {
        let tree = Self::new(label);
        tree.add_spec(spec, files);
        tree
    }

    /// Add `.kiro/specs/<spec>/` and write every declarative file beneath it.
    pub fn add_spec(&self, spec: &str, files: &[(&str, &str)]) {
        let directory = self.spec_dir(spec);
        fs::create_dir_all(&directory).expect("spec directory is created");
        for (relative, contents) in files {
            let path = join_relative(&directory, relative);
            write_file(&path, contents.as_bytes());
        }
    }

    /// The disposable repository root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The root rendered for a `--root` argument.
    pub fn root_arg(&self) -> String {
        self.root
            .to_str()
            .expect("temporary root is valid UTF-8")
            .to_string()
    }

    /// The directory for one spec beneath `.kiro/specs/`.
    pub fn spec_dir(&self, spec: &str) -> PathBuf {
        let mut components = Path::new(spec).components();
        let normal = matches!(components.next(), Some(Component::Normal(_)));
        assert!(
            normal && components.next().is_none(),
            "spec name must be one normal path component: {spec:?}"
        );
        self.root.join(".kiro/specs").join(spec)
    }

    /// Write a file relative to the tree root, creating parent directories.
    pub fn write(&self, relative: &str, contents: &str) {
        self.write_bytes(relative, contents.as_bytes());
    }

    /// Write arbitrary bytes relative to the tree root.
    pub fn write_bytes(&self, relative: &str, contents: &[u8]) {
        write_file(&join_relative(&self.root, relative), contents);
    }

    /// Materialise a copy of an existing fixture tree in a fresh temp root.
    ///
    /// The source is read-only: only the destination is modified.
    pub fn copy_fixture(label: &str, source: &Path) -> Self {
        let tree = Self::new(label);
        copy_tree(source, tree.root()).expect("fixture tree is copied into temporary storage");
        tree
    }

    /// The stable content hash of every file and directory beneath the root.
    pub fn hash(&self) -> TreeHash {
        hash_tree(&self.root)
    }

    /// Run the compiled binary with exactly `args`, inheriting no root or spec.
    pub fn run(&self, args: &[&str]) -> Run {
        run_binary(args)
    }

    /// Run the compiled binary from `cwd` with exactly `args`.
    pub fn run_in(&self, cwd: &Path, args: &[&str]) -> Run {
        let mut command = binary();
        command.current_dir(cwd).args(args);
        Run::capture(command)
    }

    /// Run the compiled binary against this tree's spec with `args`.
    pub fn run_spec(&self, spec: &str, args: &[&str]) -> Run {
        let mut command = binary();
        command
            .arg("--root")
            .arg(&self.root)
            .arg("--spec")
            .arg(spec)
            .args(args);
        Run::capture(command)
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Run the compiled binary from the process working directory.
///
/// Tests that inspect a tree outside temporary storage, such as the checked-in
/// spec corpus, pass an absolute `--root` instead of building a [`TempTree`].
pub fn run_binary(args: &[&str]) -> Run {
    let mut command = binary();
    command.args(args);
    Run::capture(command)
}

/// The captured result of one binary invocation.
pub struct Run {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Run {
    fn capture(mut command: Command) -> Self {
        let output = command.output().expect("kiro-spec binary runs");
        Self {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        }
    }

    /// The process exit status.
    pub fn status(&self) -> ExitStatus {
        self.status
    }

    /// The numeric exit code, or `-1` when the process was terminated by signal.
    pub fn code(&self) -> i32 {
        self.status.code().unwrap_or(-1)
    }

    /// Whether the process exited zero.
    pub fn success(&self) -> bool {
        self.status.success()
    }

    /// Captured stdout as UTF-8.
    pub fn stdout(&self) -> &str {
        std::str::from_utf8(&self.stdout).expect("captured stdout is valid UTF-8")
    }

    /// Captured stdout bytes, for non-UTF-8 diagnostics tests.
    pub fn stdout_bytes(&self) -> &[u8] {
        &self.stdout
    }

    /// Captured stderr as UTF-8.
    pub fn stderr(&self) -> &str {
        std::str::from_utf8(&self.stderr).expect("captured stderr is valid UTF-8")
    }

    /// Captured stderr bytes, for non-UTF-8 diagnostics tests.
    pub fn stderr_bytes(&self) -> &[u8] {
        &self.stderr
    }
}

/// A stable FNV-1a digest over a tree's relative paths and contents.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TreeHash(u64);

impl TreeHash {
    /// The raw digest value.
    pub const fn value(self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for TreeHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:016x}", self.0)
    }
}

/// Hash every directory, file, and symlink beneath `root` in sorted order.
pub fn hash_tree(root: &Path) -> TreeHash {
    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries).expect("tree is readable for hashing");
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));

    let mut hash = FNV_OFFSET;
    for entry in entries {
        fnv(&mut hash, entry.relative.to_string_lossy().as_bytes());
        fnv(&mut hash, &[0]);
        fnv(&mut hash, &[entry.kind]);
        fnv(&mut hash, &(entry.bytes.len() as u64).to_le_bytes());
        fnv(&mut hash, &entry.bytes);
    }
    TreeHash(hash)
}

/// Recursively copy a fixture tree, preserving its file and directory layout.
pub fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, io::Error>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_tree(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to)?;
        } else if file_type.is_symlink() {
            copy_symlink(&from, &to)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported fixture entry: {}", from.display()),
            ));
        }
    }
    Ok(())
}

/// A guard that removes every write bit from a directory until it is dropped.
pub struct ReadOnlyDir {
    path: PathBuf,
    #[cfg(unix)]
    original_mode: u32,
}

impl ReadOnlyDir {
    /// Make `path` read-only for this process, restoring the mode on drop.
    pub fn new(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("not a directory: {}", path.display()),
                ));
            }
            let original_mode = metadata.permissions().mode();
            fs::set_permissions(path, fs::Permissions::from_mode(original_mode & !0o222))?;
            Ok(Self {
                path: path.to_path_buf(),
                original_mode,
            })
        }

        #[cfg(not(unix))]
        {
            let _ = path;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "forcing a read-only directory requires Unix permissions",
            ))
        }
    }

    /// The guarded directory.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Probe whether the permission bits actually block this process.
    ///
    /// A root process can still create files in a read-only directory, so
    /// callers use this to skip write-failure assertions instead of assuming
    /// the mode bits are effective.
    pub fn blocks_writes(&self) -> bool {
        let probe = self.path.join(format!(
            ".kiro-spec-probe-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
        {
            Ok(file) => {
                drop(file);
                let _ = fs::remove_file(&probe);
                false
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
            Err(_) => true,
        }
    }
}

impl Drop for ReadOnlyDir {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.original_mode));
        }
    }
}

struct TreeEntry {
    relative: PathBuf,
    kind: u8,
    bytes: Vec<u8>,
}

fn collect_entries(directory: &Path, root: &Path, entries: &mut Vec<TreeEntry>) -> io::Result<()> {
    let mut children = fs::read_dir(directory)?.collect::<Result<Vec<_>, io::Error>>()?;
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .expect("walked entry stays beneath the hash root")
            .to_path_buf();
        let file_type = entry.file_type()?;

        if file_type.is_symlink() {
            let target = fs::read_link(&path)?;
            entries.push(TreeEntry {
                relative,
                kind: 2,
                bytes: target.to_string_lossy().into_owned().into_bytes(),
            });
        } else if file_type.is_dir() {
            entries.push(TreeEntry {
                relative: relative.clone(),
                kind: 0,
                bytes: Vec::new(),
            });
            collect_entries(&path, root, entries)?;
        } else if file_type.is_file() {
            entries.push(TreeEntry {
                relative,
                kind: 1,
                bytes: fs::read(&path)?,
            });
        } else {
            entries.push(TreeEntry {
                relative,
                kind: 3,
                bytes: Vec::new(),
            });
        }
    }
    Ok(())
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
}

fn join_relative(base: &Path, relative: &str) -> PathBuf {
    let relative = Path::new(relative);
    assert!(
        !relative.is_absolute(),
        "fixture path must be relative: {relative:?}"
    );
    assert!(
        relative
            .components()
            .all(|component| matches!(component, Component::Normal(_))),
        "fixture path must stay beneath its base directory: {relative:?}"
    );
    base.join(relative)
}

fn write_file(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("fixture parent directory is created");
    }
    fs::write(path, contents).expect("fixture file is written");
}

fn sanitize(label: &str) -> String {
    let mut sanitized = String::with_capacity(label.len());
    for character in label.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            sanitized.push(character);
        } else {
            sanitized.push('-');
        }
    }
    if sanitized.is_empty() {
        "tree".to_string()
    } else {
        sanitized
    }
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(source)?, destination)
}

#[cfg(not(unix))]
fn copy_symlink(source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("cannot copy symlink: {}", source.display()),
    ))
}
