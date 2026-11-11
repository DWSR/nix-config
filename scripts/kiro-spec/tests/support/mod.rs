#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;

static COUNTER: AtomicU32 = AtomicU32::new(0);

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn unique_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "kiro-spec-support-{tag}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&root)
        .unwrap_or_else(|error| panic!("cannot create temporary root {}: {error}", root.display()));
    root
}

fn write_file(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", parent.display()));
    }
    fs::write(path, contents)
        .unwrap_or_else(|error| panic!("cannot write {}: {error}", path.display()));
}

pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        Self {
            path: unique_root(tag),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.path.join(relative)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        cleanup_root(&self.path);
    }
}

pub struct SpecTree {
    root: PathBuf,
    spec_dir: PathBuf,
    name: String,
}

impl SpecTree {
    pub fn new(name: &str, tag: &str) -> Self {
        let root = unique_root(tag);
        let spec_dir = root.join(".kiro").join("specs").join(name);
        fs::create_dir_all(&spec_dir).unwrap_or_else(|error| {
            panic!(
                "cannot create spec directory {}: {error}",
                spec_dir.display()
            )
        });
        Self {
            root,
            spec_dir,
            name: name.to_owned(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn spec_dir(&self) -> &Path {
        &self.spec_dir
    }

    pub fn write(&self, relative: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> &Self {
        write_file(&self.spec_dir.join(relative), contents.as_ref());
        self
    }

    pub fn write_at(&self, relative: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> &Self {
        write_file(&self.root.join(relative), contents.as_ref());
        self
    }

    pub fn read(&self, relative: impl AsRef<Path>) -> Vec<u8> {
        let path = self.spec_dir.join(relative);
        fs::read(&path).unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
    }

    pub fn remove(&self, relative: impl AsRef<Path>) {
        let path = self.spec_dir.join(relative);
        fs::remove_file(&path)
            .unwrap_or_else(|error| panic!("cannot remove {}: {error}", path.display()));
    }

    pub fn run(&self, args: &[&str]) -> Run {
        self.run_from(None, args)
    }

    pub fn run_in(&self, cwd: &Path, args: &[&str]) -> Run {
        self.run_from(Some(cwd), args)
    }

    fn run_from(&self, cwd: Option<&Path>, args: &[&str]) -> Run {
        let program = PathBuf::from(env!("CARGO_BIN_EXE_kiro-spec"));
        let root = self.root.to_str().expect("temporary root is UTF-8");
        let mut full_args = vec![
            "--root".to_owned(),
            root.to_owned(),
            "--spec".to_owned(),
            self.name.clone(),
        ];
        full_args.extend(args.iter().map(|argument| (*argument).to_owned()));

        let mut command = Command::new(&program);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command.args(&full_args);

        let output = command.output().unwrap_or_else(|error| {
            panic!(
                "cannot run {} {}: {error}",
                program.display(),
                full_args.join(" ")
            )
        });
        Run {
            program,
            args: full_args,
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        }
    }

    pub fn tree_hash(&self) -> u64 {
        tree_hash(&self.root)
    }

    pub fn tree_hash_excluding(&self, exclusions: &[&str]) -> u64 {
        tree_hash_excluding(&self.root, exclusions)
    }
}

impl Drop for SpecTree {
    fn drop(&mut self) {
        cleanup_root(&self.root);
    }
}

pub struct Run {
    program: PathBuf,
    args: Vec<String>,
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Run {
    pub fn code(&self) -> Option<i32> {
        self.status.code()
    }

    pub fn success(&self) -> bool {
        self.status.success()
    }

    pub fn exit_status(&self) -> &ExitStatus {
        &self.status
    }

    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8(self.stdout.clone()).unwrap_or_else(|error| {
            panic!("stdout is not valid UTF-8: {error}\n{}", self.describe())
        })
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8(self.stderr.clone()).unwrap_or_else(|error| {
            panic!("stderr is not valid UTF-8: {error}\n{}", self.describe())
        })
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.stdout).unwrap_or_else(|error| {
            panic!(
                "stdout is not exactly one JSON document: {error}\n{}",
                self.describe()
            )
        })
    }

    pub fn assert_success(self) -> Self {
        assert!(
            self.status.success(),
            "expected exit 0\n{}",
            self.describe()
        );
        assert!(
            self.stderr.is_empty(),
            "expected empty stderr\n{}",
            self.describe()
        );
        self
    }

    pub fn assert_exit(self, code: i32) -> Self {
        assert_eq!(
            self.status.code(),
            Some(code),
            "expected exit {code}\n{}",
            self.describe()
        );
        self
    }

    pub fn assert_failure(self, code: i32) -> Self {
        assert_eq!(
            self.status.code(),
            Some(code),
            "expected exit {code}\n{}",
            self.describe()
        );
        assert!(
            !self.stderr.is_empty(),
            "expected a diagnostic on stderr\n{}",
            self.describe()
        );
        self
    }

    pub fn describe(&self) -> String {
        format!(
            "command: {} {}\nstatus: {}\nstdout:\n{}\nstderr:\n{}",
            self.program.display(),
            self.args.join(" "),
            self.status,
            String::from_utf8_lossy(&self.stdout),
            String::from_utf8_lossy(&self.stderr),
        )
    }
}

pub fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    let mut entries: Vec<PathBuf> = fs::read_dir(source)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort();
    for entry in entries {
        let name = entry
            .file_name()
            .expect("directory entry has a file name")
            .to_owned();
        let target = destination.join(name);
        if entry.is_dir() {
            copy_tree(&entry, &target)?;
        } else if entry.is_file() {
            fs::copy(&entry, &target)?;
        }
    }
    Ok(())
}

pub fn tree_hash(root: &Path) -> u64 {
    tree_hash_excluding(root, &[])
}

pub fn tree_hash_excluding(root: &Path, exclusions: &[&str]) -> u64 {
    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries);
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    let mut hash = FNV_OFFSET;
    for (relative, path) in entries {
        if is_excluded(&relative, exclusions) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .unwrap_or_else(|error| panic!("cannot stat {}: {error}", path.display()));
        hash_bytes(&mut hash, relative.as_bytes());
        hash_bytes(&mut hash, b"\0");
        if metadata.is_dir() {
            hash_bytes(&mut hash, b"dir\0");
        } else {
            let contents = fs::read(&path)
                .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
            hash_bytes(&mut hash, b"file\0");
            hash_bytes(&mut hash, &(contents.len() as u64).to_le_bytes());
            hash_bytes(&mut hash, &contents);
        }
    }
    hash
}

fn collect_entries(root: &Path, directory: &Path, entries: &mut Vec<(String, PathBuf)>) {
    let mut children: Vec<PathBuf> = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("cannot read directory {}: {error}", directory.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| {
                    panic!("cannot read an entry in {}: {error}", directory.display())
                })
                .path()
        })
        .collect();
    children.sort();
    for child in children {
        let relative = child
            .strip_prefix(root)
            .expect("tree entry is beneath the tree root")
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        entries.push((relative, child.clone()));
        if child.is_dir() {
            collect_entries(root, &child, entries);
        }
    }
}

fn is_excluded(relative: &str, exclusions: &[&str]) -> bool {
    exclusions.iter().any(|exclusion| {
        let exclusion = exclusion.trim_matches('/');
        if exclusion.is_empty() {
            return false;
        }
        relative == exclusion
            || relative.starts_with(&format!("{exclusion}/"))
            || relative.rsplit('/').next() == Some(exclusion)
    })
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = (*hash).wrapping_mul(FNV_PRIME);
    }
}

pub fn read_only(directory: &Path) -> ReadOnlyDir {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = fs::metadata(directory)
            .unwrap_or_else(|error| panic!("cannot stat {}: {error}", directory.display()));
        let original = metadata.permissions();
        let mut read_only_permissions = original.clone();
        read_only_permissions.set_mode(0o555);
        fs::set_permissions(directory, read_only_permissions).unwrap_or_else(|error| {
            panic!("cannot make {} read-only: {error}", directory.display())
        });
        ReadOnlyDir {
            path: directory.to_path_buf(),
            original: Some(original),
        }
    }
    #[cfg(not(unix))]
    {
        ReadOnlyDir {
            path: directory.to_path_buf(),
            original: None,
        }
    }
}

pub struct ReadOnlyDir {
    path: PathBuf,
    original: Option<fs::Permissions>,
}

impl ReadOnlyDir {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_supported(&self) -> bool {
        self.original.is_some()
    }

    pub fn can_still_write(&self) -> bool {
        let probe = self.path.join(".kiro-spec-write-probe");
        match fs::write(&probe, b"probe") {
            Ok(()) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    }

    pub fn restore(mut self) {
        self.restore_permissions();
    }

    fn restore_permissions(&mut self) {
        if let Some(permissions) = self.original.take() {
            let _ = fs::set_permissions(&self.path, permissions);
        }
    }
}

impl Drop for ReadOnlyDir {
    fn drop(&mut self) {
        self.restore_permissions();
    }
}

fn cleanup_root(root: &Path) {
    restore_tree_permissions(root);
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
fn restore_tree_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };
    if !metadata.is_dir() {
        return;
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(permissions.mode() | 0o700);
    let _ = fs::set_permissions(path, permissions);
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            restore_tree_permissions(&entry.path());
        }
    }
}

#[cfg(not(unix))]
fn restore_tree_permissions(_path: &Path) {}
