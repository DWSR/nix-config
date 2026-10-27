//! Atomic, byte-preserving `tasks.md` edits for `complete` and `block`.
//!
//! The editor never opens the original file for writing. It writes a complete
//! replacement to a uniquely named temporary file in the same directory, copies
//! the original permissions onto it, syncs it, and renames it over `tasks.md`.
//! A failure removes the temporary file that this process created, leaving the
//! original path intact; readers continue to open only `tasks.md`, so a stale
//! temporary file from an interrupted run is ignored.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;

use crate::error::MutationError;
use crate::tasks::TaskState;

/// A planned mutation and the bytes that publish it.
///
/// `bytes` is `None` when the reassembled document is byte-identical to the
/// source, so a no-op never touches the filesystem.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditPlan {
    /// The canonical identifier of the mutated entry.
    pub id: String,
    /// The state the entry has after the mutation.
    pub state: TaskState,
    /// The complete replacement document, or `None` for a no-op.
    pub bytes: Option<Vec<u8>>,
    /// The resulting `_Blocked:` reason, when the mutation sets one.
    pub reason: Option<String>,
}

impl EditPlan {
    /// Plan a replacement by comparing it with the bytes that were read.
    ///
    /// The comparison is on complete documents, so a change that reassembles
    /// to the same bytes is recorded as a no-op and can never rewrite the file.
    pub fn new(
        id: impl Into<String>,
        state: TaskState,
        reason: Option<String>,
        original: &[u8],
        replacement: Vec<u8>,
    ) -> Self {
        let bytes = if replacement.as_slice() == original {
            None
        } else {
            Some(replacement)
        };
        Self {
            id: id.into(),
            state,
            bytes,
            reason,
        }
    }

    /// Publish this plan, doing nothing when it changes no bytes.
    pub fn publish(&self, path: &Path) -> Result<(), MutationError> {
        match &self.bytes {
            Some(bytes) => write_atomic(path, bytes),
            None => Ok(()),
        }
    }
}

/// Atomically replace `path` with `bytes`.
///
/// The temporary file is created with `create_new` so an existing stale
/// temporary path is never reused or removed, and it lives in the target's
/// directory so the final rename stays on one filesystem. The temporary file is
/// removed if any step before or during the rename fails.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), MutationError> {
    let permissions = fs::metadata(path)
        .map_err(|error| write_failure(path, error))?
        .permissions();
    let temporary = temporary_path(path)?;

    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
    {
        Ok(file) => file,
        Err(error) => return Err(write_failure(path, error)),
    };

    let written = file
        .set_permissions(permissions)
        .and_then(|()| file.write_all(bytes))
        .and_then(|()| file.sync_all());
    drop(file);

    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(write_failure(path, error));
    }

    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(write_failure(path, error));
    }

    Ok(())
}

/// The hidden temporary path this process uses beside `path`.
///
/// The file name includes the process id, matching the documented
/// `.tasks.md.kiro-spec.<pid>.tmp` shape.
fn temporary_path(path: &Path) -> Result<PathBuf, MutationError> {
    let file_name = path.file_name().ok_or_else(|| {
        MutationError::write(
            path.display().to_string(),
            "path has no file name for a temporary file",
        )
    })?;
    let mut temporary = OsString::from(".");
    temporary.push(file_name);
    temporary.push(format!(".kiro-spec.{}.tmp", process::id()));
    Ok(path.with_file_name(temporary))
}

/// Build the single mutation-write diagnostic for this path.
fn write_failure(path: &Path, error: impl std::fmt::Display) -> MutationError {
    MutationError::write(path.display().to_string(), error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use crate::tasks::{parse_tasks, TaskState};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "kiro-spec-edit-{}-{label}-{suffix}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("temporary directory is created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temporary_path(path: &Path) -> PathBuf {
        path.with_file_name(format!(
            ".{}.kiro-spec.{}.tmp",
            path.file_name().unwrap().to_string_lossy(),
            std::process::id()
        ))
    }

    fn names(directory: &Path) -> Vec<String> {
        let mut names = fs::read_dir(directory)
            .expect("directory is readable")
            .map(|entry| {
                entry
                    .expect("directory entry is readable")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn replacing_file_publishes_planned_bytes_atomically() {
        let directory = TempDir::new("publish");
        let path = directory.path().join("tasks.md");
        let original = b"- [ ] 1. Pending\r\n";
        let replacement = b"- [x] 1. Pending\r\n  - note\r\n";
        fs::write(&path, original).expect("fixture is written");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640))
                .expect("fixture permissions are set");
        }

        write_atomic(&path, replacement).expect("the replacement is published");

        assert_eq!(
            fs::read(&path).expect("published file is readable"),
            replacement
        );
        assert_eq!(names(directory.path()), vec!["tasks.md"]);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .expect("published file is readable")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o640, "the original permissions are preserved");
        }
    }

    #[test]
    fn reassembling_an_unchanged_document_produces_a_noop_plan() {
        let source = "- [ ] 1. Pending\r\n  - _Requirements: 6.1_\r\n- [x] 2. Done";
        let document = parse_tasks(source);

        let plan = EditPlan::new(
            "1",
            TaskState::Pending,
            None,
            source.as_bytes(),
            document.to_bytes(),
        );

        assert_eq!(plan.bytes, None, "an identical document is a no-op");
        assert_eq!(plan.id, "1");
        assert_eq!(plan.state, TaskState::Pending);
        assert_eq!(plan.reason, None);
    }

    #[test]
    fn differing_bytes_are_planned_for_publication() {
        let source = "- [ ] 1. Pending\n";
        let replacement = b"- [x] 1. Pending\n".to_vec();

        let plan = EditPlan::new(
            "1",
            TaskState::Completed,
            None,
            source.as_bytes(),
            replacement.clone(),
        );

        assert_eq!(plan.bytes, Some(replacement));
    }

    #[test]
    fn a_noop_plan_publishes_nothing() {
        let directory = TempDir::new("noop");
        let path = directory.path().join("tasks.md");
        let source = "- [x] 1. Done\r\n";
        fs::write(&path, source).expect("fixture is written");
        let plan = EditPlan::new(
            "1",
            TaskState::Completed,
            None,
            source.as_bytes(),
            source.as_bytes().to_vec(),
        );

        plan.publish(&path).expect("a no-op succeeds");

        assert_eq!(
            fs::read(&path).expect("fixture is readable"),
            source.as_bytes()
        );
        assert_eq!(names(directory.path()), vec!["tasks.md"]);
    }

    #[test]
    fn an_existing_temporary_path_is_never_clobbered() {
        let directory = TempDir::new("stale");
        let path = directory.path().join("tasks.md");
        let original = b"- [ ] 1. Pending\n";
        fs::write(&path, original).expect("fixture is written");
        let stale = temporary_path(&path);
        fs::write(&stale, b"stale contents").expect("stale fixture is written");

        let error = write_atomic(&path, b"- [x] 1. Pending\n")
            .expect_err("an existing temporary path is not reused");

        assert_eq!(error.category(), ErrorCategory::Write);
        assert_eq!(fs::read(&path).expect("fixture is readable"), original);
        assert_eq!(
            fs::read(&stale).expect("stale fixture is readable"),
            b"stale contents",
            "a file the editor did not create is never removed"
        );
    }

    #[test]
    fn a_failed_rename_removes_the_temporary_file() {
        let directory = TempDir::new("rename");
        let path = directory.path().join("tasks.md");
        fs::create_dir(&path).expect("a conflicting directory is created");

        let error = write_atomic(&path, b"- [x] 1. Pending\n")
            .expect_err("renaming a file over a directory fails");

        assert_eq!(error.category(), ErrorCategory::Write);
        assert!(path.is_dir(), "the original path is untouched");
        assert!(
            !temporary_path(&path).exists(),
            "the editor removes the temporary file it created"
        );
        assert_eq!(names(directory.path()), vec!["tasks.md"]);
    }

    #[test]
    fn a_write_failure_leaves_tasks_md_intact() {
        let directory = TempDir::new("readonly");
        let path = directory.path().join("tasks.md");
        let original = b"- [ ] 1. Pending\n";
        fs::write(&path, original).expect("fixture is written");
        let original_permissions = fs::metadata(directory.path())
            .expect("temporary directory is readable")
            .permissions();
        let mut readonly = original_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(directory.path(), readonly).expect("fixture directory is read-only");

        let probe = directory.path().join("write-probe");
        if fs::write(&probe, b"").is_ok() {
            let _ = fs::remove_file(&probe);
            fs::set_permissions(directory.path(), original_permissions)
                .expect("fixture permissions are restored");
            eprintln!("skipping: the process can still write to a read-only directory");
            return;
        }

        let error = write_atomic(&path, b"- [x] 1. Pending\n")
            .expect_err("creating a temporary file in a read-only directory fails");
        fs::set_permissions(directory.path(), original_permissions)
            .expect("fixture permissions are restored");

        assert_eq!(error.category(), ErrorCategory::Write);
        assert_eq!(
            fs::read(&path).expect("fixture is readable"),
            original,
            "the original tasks.md is never opened for writing"
        );
        assert!(!temporary_path(&path).exists());
    }
}
