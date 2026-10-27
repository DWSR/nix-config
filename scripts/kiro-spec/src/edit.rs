//! Atomic, byte-preserving `tasks.md` edits for `complete` and `block`.
//!
//! The editor never opens the original file for writing. It writes a complete
//! replacement to a uniquely named temporary file in the same directory, copies
//! the original permissions onto it, syncs it, and renames it over `tasks.md`.
//! A failure removes the temporary file that this process created, leaving the
//! original path intact; readers continue to open only `tasks.md`, so a stale
//! temporary file from an interrupted run is ignored.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;

use crate::error::MutationError;
use crate::tasks::{MetadataKind, TaskDocument, TaskEntry, TaskState};

/// The byte offset of the checkbox state character in a parsed task line.
///
/// Every entry line starts with `- [` at column zero, so the character between
/// the brackets is always at this offset; the parser guarantees the shape.
const STATE_OFFSET: usize = 3;

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

/// A mutation a caller asks the editor to plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Change {
    /// Mark the entry completed and remove every blocked reason bullet.
    Complete,
}

/// Plan one mutation of a uniquely identified entry.
///
/// Resolution happens before any bytes are planned, so a malformed, unknown,
/// or ambiguous identifier is refused without touching the filesystem. The
/// entry's state character and its blocked reason bullet lines are the only
/// bytes that can change; every other source line, terminator included, is
/// re-emitted unchanged. A request that would produce the same document is a
/// no-op plan with `bytes = None`.
pub fn mutate(
    document: &TaskDocument,
    id: &str,
    change: Change,
) -> Result<EditPlan, MutationError> {
    let entry = document.find_unique(id)?;
    match change {
        Change::Complete => Ok(plan_complete(document, entry)),
    }
}

/// Plan the `complete` change for one resolved entry.
fn plan_complete(document: &TaskDocument, entry: &TaskEntry) -> EditPlan {
    let original = document.to_bytes();
    if entry.state == TaskState::Completed {
        return EditPlan::new(
            entry.id.text.clone(),
            TaskState::Completed,
            None,
            &original,
            original.clone(),
        );
    }

    let removed = entry
        .block
        .metadata()
        .iter()
        .filter(|bullet| bullet.kind() == MetadataKind::Blocked)
        .flat_map(|bullet| bullet.line()..=bullet.last_line())
        .collect::<BTreeSet<_>>();

    let mut replacement = Vec::with_capacity(original.len());
    for (index, line) in document.source_lines().iter().enumerate() {
        let line_number = index + 1;
        if removed.contains(&line_number) {
            continue;
        }
        if line_number == entry.line {
            let mut text = line.text().as_bytes().to_vec();
            text[STATE_OFFSET] = b'x';
            replacement.extend_from_slice(&text);
        } else {
            replacement.extend_from_slice(line.text().as_bytes());
        }
        replacement.extend_from_slice(line.terminator().bytes());
    }

    EditPlan::new(
        entry.id.text.clone(),
        TaskState::Completed,
        None,
        &original,
        replacement,
    )
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
    fn completing_a_pending_entry_changes_only_its_checkbox() {
        let source = "\
# Plan\r
\r
- [ ] 1. Parent\r
- [ ]* 1.1 Do the thing\r
  - _Requirements: 7.2_\r
  - _Boundary: editor_\r
- [ ] 1.2 Sibling\r
";
        let document = parse_tasks(source);

        let plan = mutate(&document, "1.1", Change::Complete).expect("the entry completes");

        assert_eq!(plan.id, "1.1");
        assert_eq!(plan.state, TaskState::Completed);
        assert_eq!(plan.reason, None);
        let expected = "\
# Plan\r
\r
- [ ] 1. Parent\r
- [x]* 1.1 Do the thing\r
  - _Requirements: 7.2_\r
  - _Boundary: editor_\r
- [ ] 1.2 Sibling\r
";
        assert_eq!(
            plan.bytes.as_deref(),
            Some(expected.as_bytes()),
            "only the target checkbox changes; parent, sibling, metadata, and CRLF survive"
        );
    }

    #[test]
    fn completing_a_blocked_entry_removes_its_reason_and_continuations() {
        let source = "\
- [ ] 2. Parent\r
- [!]* 2.1 Blocked child\r
  - _Requirements: 8.1_\r
  - _Blocked: waiting on the\r
    security review\r
  - _Depends: 1_\r
- [x] 2.2 Done sibling\r
- [ ] 2.3 Later sibling\r
";
        let document = parse_tasks(source);

        let plan = mutate(&document, "2.1", Change::Complete).expect("the entry completes");

        let expected = "\
- [ ] 2. Parent\r
- [x]* 2.1 Blocked child\r
  - _Requirements: 8.1_\r
  - _Depends: 1_\r
- [x] 2.2 Done sibling\r
- [ ] 2.3 Later sibling\r
";
        assert_eq!(
            plan.bytes.as_deref(),
            Some(expected.as_bytes()),
            "the reason bullet and its continuation lines are removed, nothing else changes"
        );
    }

    #[test]
    fn completion_removes_every_blocked_bullet_from_the_whole_block() {
        let source = "\
- [!] 3. Blocked work
  - _Blocked: first reason
  - _Requirements: 10.1_
  - _Blocked: second reason
    with a continuation
  - _Boundary: keep this_
- [ ] 4. Untouched
";
        let document = parse_tasks(source);

        let plan = mutate(&document, "3", Change::Complete).expect("the entry completes");

        let expected = "\
- [x] 3. Blocked work
  - _Requirements: 10.1_
  - _Boundary: keep this_
- [ ] 4. Untouched
";
        assert_eq!(plan.bytes.as_deref(), Some(expected.as_bytes()));
    }

    #[test]
    fn completing_a_pending_entry_drops_a_stale_blocked_bullet() {
        let source = "\
- [ ] 5. Pending with stale wording
  - _Blocked: no longer applies_
  - _Requirements: 7.4_
";
        let document = parse_tasks(source);

        let plan = mutate(&document, "5", Change::Complete).expect("the entry completes");

        assert_eq!(
            plan.bytes.as_deref(),
            Some(b"- [x] 5. Pending with stale wording\n  - _Requirements: 7.4_\n".as_slice())
        );
    }

    #[test]
    fn completing_a_parent_leaves_its_children_untouched() {
        let source = "\
- [ ] 6. Grouping parent
- [ ] 6.1 Child one
  - _Requirements: 7.5_
- [x] 6.2 Child two
- [ ] 7. Sibling major
";
        let document = parse_tasks(source);

        let plan = mutate(&document, "6", Change::Complete).expect("the parent completes");

        let expected = "\
- [x] 6. Grouping parent
- [ ] 6.1 Child one
  - _Requirements: 7.5_
- [x] 6.2 Child two
- [ ] 7. Sibling major
";
        assert_eq!(plan.bytes.as_deref(), Some(expected.as_bytes()));
    }

    #[test]
    fn completing_an_already_completed_entry_is_a_byte_identical_noop() {
        let source = "- [x]* 4. Already done\r\n  - _Requirements: 7.2_\r\n";
        let document = parse_tasks(source);

        let plan = mutate(&document, "4", Change::Complete).expect("completion succeeds");

        assert_eq!(plan.id, "4");
        assert_eq!(plan.state, TaskState::Completed);
        assert_eq!(plan.reason, None);
        assert_eq!(
            plan.bytes, None,
            "an already completed entry, including stale metadata, is left alone"
        );
    }

    #[test]
    fn completing_the_last_line_preserves_a_missing_final_newline() {
        let source = "- [ ] 1. One\n- [ ] 2. Two";
        let document = parse_tasks(source);

        let plan = mutate(&document, "2", Change::Complete).expect("the entry completes");

        assert_eq!(
            plan.bytes.as_deref(),
            Some(b"- [ ] 1. One\n- [x] 2. Two".as_slice()),
            "the final line keeps its absent terminator"
        );
    }

    #[test]
    fn publishing_a_complete_plan_replaces_only_the_target_line() {
        let directory = TempDir::new("complete-publish");
        let path = directory.path().join("tasks.md");
        let source = "- [ ] 1. One\r\n- [!] 2. Two\r\n  - _Blocked: wait_\r\n";
        fs::write(&path, source).expect("fixture is written");
        let document = parse_tasks(source);

        let plan = mutate(&document, "2", Change::Complete).expect("the entry completes");
        plan.publish(&path).expect("the plan is published");

        assert_eq!(
            fs::read(&path).expect("published file is readable"),
            b"- [ ] 1. One\r\n- [x] 2. Two\r\n",
            "the sibling and every affected line keep their bytes"
        );
        assert_eq!(
            names(directory.path()),
            vec!["tasks.md"],
            "publishing leaves no temporary file behind"
        );
    }

    #[test]
    fn malformed_unknown_and_ambiguous_identifiers_produce_no_plan() {
        let document = parse_tasks("- [ ] 1. First\n- [ ] 1. Duplicate\n- [ ] 2. Only\n");

        for query in ["1", "1.2.3", "9"] {
            let error = mutate(&document, query, Change::Complete)
                .expect_err(&format!("{query:?} must be refused"));
            assert_eq!(error.category(), ErrorCategory::Conflict, "{query:?}");
            assert_eq!(error.context(), query, "{query:?}");
        }
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
