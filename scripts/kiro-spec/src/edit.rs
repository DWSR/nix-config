use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::MutationError;
use crate::tasks::{MetadataKind, TaskDocument, TaskEntry, TaskState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Change {
    Complete,
    Block { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditPlan {
    pub id: String,
    pub state: TaskState,
    pub bytes: Option<Vec<u8>>,
    pub reason: Option<String>,
}

pub fn replacement_bytes(original: &[u8], reassembled: &[u8]) -> Option<Vec<u8>> {
    if original == reassembled {
        None
    } else {
        Some(reassembled.to_vec())
    }
}

pub fn plan_edit(
    id: &str,
    state: TaskState,
    reason: Option<String>,
    original: &[u8],
    reassembled: &[u8],
) -> EditPlan {
    EditPlan {
        id: id.to_owned(),
        state,
        bytes: replacement_bytes(original, reassembled),
        reason,
    }
}

pub fn mutate(
    document: &TaskDocument,
    id: &str,
    change: Change,
) -> Result<EditPlan, MutationError> {
    let entry = document.find_unique(id)?;
    match change {
        Change::Complete => complete_entry(document, entry),
        Change::Block { reason } => block_entry(document, entry, reason),
    }
}

fn block_entry(
    document: &TaskDocument,
    entry: &TaskEntry,
    reason: String,
) -> Result<EditPlan, MutationError> {
    let original = document.to_bytes();

    if entry.state() == TaskState::Completed {
        return Err(MutationError::conflict(
            "tasks.md",
            format!(
                "unsupported transition: completed task `{}` cannot be blocked",
                entry.id()
            ),
        ));
    }

    if entry.state() == TaskState::Blocked && entry.blocked_reason() == Some(reason.as_str()) {
        return Ok(plan_edit(
            entry.id(),
            TaskState::Blocked,
            Some(reason),
            &original,
            &original,
        ));
    }

    let target = entry.line() - 1;
    let replacement = if entry.state() == TaskState::Blocked {
        entry
            .block()
            .metadata_for(MetadataKind::Blocked)
            .next()
            .map(|bullet| bullet.line() - 1)
    } else {
        None
    };

    let mut removals = reason_removals(document, entry);
    if let Some(index) = replacement {
        removals.remove(&index);
    }

    let fallback = document_terminator(document);
    let bullet = format!("  - _Blocked: {reason}_");
    let mut reassembled = Vec::with_capacity(original.len() + bullet.len() + 2);

    for (index, line) in document.lines().iter().enumerate() {
        if index == target {
            let text = line.text();
            reassembled.extend_from_slice(text[..3].as_bytes());
            reassembled.push(b'!');
            reassembled.extend_from_slice(text[4..].as_bytes());
            let terminator = if line.terminator().is_empty() {
                fallback
            } else {
                line.terminator()
            };
            reassembled.extend_from_slice(terminator.as_bytes());
            if replacement.is_none() {
                reassembled.extend_from_slice(bullet.as_bytes());
                reassembled.extend_from_slice(terminator.as_bytes());
            }
        } else if Some(index) == replacement {
            let text = line.text();
            let indent = &text[..text.len() - text.trim_start().len()];
            reassembled.extend_from_slice(indent.as_bytes());
            reassembled.extend_from_slice(bullet[2..].as_bytes());
            reassembled.extend_from_slice(line.terminator().as_bytes());
        } else if !removals.contains(&index) {
            reassembled.extend_from_slice(line.text().as_bytes());
            reassembled.extend_from_slice(line.terminator().as_bytes());
        }
    }

    Ok(plan_edit(
        entry.id(),
        TaskState::Blocked,
        Some(reason),
        &original,
        &reassembled,
    ))
}

fn document_terminator(document: &TaskDocument) -> &'static str {
    if document
        .lines()
        .iter()
        .any(|line| line.terminator() == "\r\n")
    {
        "\r\n"
    } else {
        "\n"
    }
}

fn complete_entry(document: &TaskDocument, entry: &TaskEntry) -> Result<EditPlan, MutationError> {
    let original = document.to_bytes();
    if entry.state() == TaskState::Completed {
        return Ok(plan_edit(
            entry.id(),
            TaskState::Completed,
            None,
            &original,
            &original,
        ));
    }

    let removals = reason_removals(document, entry);
    let target = entry.line() - 1;
    let mut reassembled = Vec::with_capacity(original.len());

    for (index, line) in document.lines().iter().enumerate() {
        if index == target {
            let text = line.text();
            reassembled.extend_from_slice(text[..3].as_bytes());
            reassembled.push(b'x');
            reassembled.extend_from_slice(text[4..].as_bytes());
            reassembled.extend_from_slice(line.terminator().as_bytes());
        } else if !removals.contains(&index) {
            reassembled.extend_from_slice(line.text().as_bytes());
            reassembled.extend_from_slice(line.terminator().as_bytes());
        }
    }

    Ok(plan_edit(
        entry.id(),
        TaskState::Completed,
        None,
        &original,
        &reassembled,
    ))
}

fn reason_removals(document: &TaskDocument, entry: &TaskEntry) -> HashSet<usize> {
    let mut removals = HashSet::new();
    let block_end = entry.block().end();

    for bullet in entry.block().metadata_for(MetadataKind::Blocked) {
        let start = bullet.line() - 1;
        removals.insert(start);
        let mut index = start + 1;
        while index < block_end {
            if !is_reason_continuation(document.lines()[index].text()) {
                break;
            }
            removals.insert(index);
            index += 1;
        }
    }

    removals
}

fn is_reason_continuation(text: &str) -> bool {
    !text.trim().is_empty()
        && !is_fence(text)
        && !is_heading(text)
        && !is_candidate(text)
        && !is_indented_bullet(text)
        && !is_metadata_bullet(text)
}

fn is_fence(text: &str) -> bool {
    text.trim_start().starts_with("```")
}

fn is_heading(text: &str) -> bool {
    let hashes = text.bytes().take_while(|byte| *byte == b'#').count();
    if hashes == 0 || hashes > 6 {
        return false;
    }
    let rest = &text[hashes..];
    rest.starts_with(' ') || rest.starts_with('\t')
}

fn is_candidate(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("- [") else {
        return false;
    };
    let mut chars = rest.chars();
    let Some(marker) = chars.next() else {
        return false;
    };
    if !matches!(marker, ' ' | 'x' | '!') {
        return false;
    }
    let Some(rest) = chars.as_str().strip_prefix(']') else {
        return false;
    };
    let rest = rest.strip_prefix('*').unwrap_or(rest);
    rest.starts_with(' ')
}

fn is_indented_bullet(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.len() < text.len() && trimmed.starts_with("- ")
}

fn is_metadata_bullet(text: &str) -> bool {
    let trimmed = text.trim_start();
    if trimmed.len() == text.len() {
        return false;
    }
    let Some(rest) = trimmed.strip_prefix("- ") else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('_') else {
        return false;
    };
    let Some((label, _)) = rest.split_once(':') else {
        return false;
    };
    matches!(label, "Requirements" | "Boundary" | "Depends" | "Blocked")
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), MutationError> {
    let context = path.display().to_string();
    let directory = path.parent().ok_or_else(|| {
        MutationError::write(context.clone(), "target path has no parent directory")
    })?;
    let temp = temporary_path(directory);

    publish_temp(&temp, path, bytes, &context)?;

    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        MutationError::write(
            context,
            format!("cannot rename temporary file over target: {error}"),
        )
    })
}

fn temporary_path(directory: &Path) -> PathBuf {
    directory.join(format!(
        ".tasks.md.kiro-spec.{}.tmp",
        std::process::id()
    ))
}

fn publish_temp(
    temp: &Path,
    target: &Path,
    bytes: &[u8],
    context: &str,
) -> Result<(), MutationError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .map_err(|error| {
            MutationError::write(
                context.to_owned(),
                format!("cannot create temporary file {}: {error}", temp.display()),
            )
        })?;

    if let Err(error) = write_and_sync(&mut file, temp, target, bytes, context) {
        drop(file);
        let _ = fs::remove_file(temp);
        return Err(error);
    }
    drop(file);
    Ok(())
}

fn write_and_sync(
    file: &mut File,
    temp: &Path,
    target: &Path,
    bytes: &[u8],
    context: &str,
) -> Result<(), MutationError> {
    if let Ok(metadata) = fs::metadata(target) {
        fs::set_permissions(temp, metadata.permissions()).map_err(|error| {
            MutationError::write(
                context.to_owned(),
                format!(
                    "cannot copy permissions to temporary file {}: {error}",
                    temp.display()
                ),
            )
        })?;
    }

    file.write_all(bytes).map_err(|error| {
        MutationError::write(
            context.to_owned(),
            format!("cannot write temporary file {}: {error}", temp.display()),
        )
    })?;
    file.sync_all().map_err(|error| {
        MutationError::write(
            context.to_owned(),
            format!("cannot flush temporary file {}: {error}", temp.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{mutate, plan_edit, replacement_bytes, write_atomic, Change, EditPlan};
    use crate::error::ErrorCategory;
    use crate::tasks::{parse_tasks, TaskState};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let unique = format!(
                "kiro-spec-edit-{tag}-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("create temp dir");
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

    fn tasks_path(directory: &Path) -> PathBuf {
        directory.join("tasks.md")
    }

    fn temp_path(directory: &Path) -> PathBuf {
        directory.join(format!(
            ".tasks.md.kiro-spec.{}.tmp",
            std::process::id()
        ))
    }

    fn write_tasks(directory: &Path, bytes: &[u8]) -> PathBuf {
        let path = tasks_path(directory);
        fs::write(&path, bytes).expect("write tasks.md");
        path
    }

    #[test]
    fn atomic_replace_publishes_exact_bytes_and_leaves_no_temp() {
        let temp = TempDir::new("replace");
        let path = write_tasks(temp.path(), b"- [ ] 1. Task\n");
        let replacement = b"- [x] 1. Task\n  - _Boundary: kept_\n";

        write_atomic(&path, replacement).expect("atomic write");

        assert_eq!(fs::read(&path).expect("read tasks.md"), replacement);
        assert!(!temp_path(temp.path()).exists());
        let leftovers: Vec<String> = fs::read_dir(temp.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn a_stale_temporary_file_is_left_untouched_and_tasks_md_is_unchanged() {
        let temp = TempDir::new("stale");
        let original = b"- [ ] 1. Task\n";
        let path = write_tasks(temp.path(), original);
        let stale = temp_path(temp.path());
        fs::write(&stale, b"stale contents").expect("write stale temp");

        let error = write_atomic(&path, b"- [x] 1. Task\n").expect_err("create_new must fail");

        assert_eq!(error.category(), ErrorCategory::MutationWrite);
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert_eq!(fs::read(&stale).expect("read stale temp"), b"stale contents");
    }

    #[cfg(unix)]
    #[test]
    fn replacement_keeps_the_original_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("permissions");
        let path = write_tasks(temp.path(), b"- [ ] 1. Task\n");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("chmod tasks.md");

        write_atomic(&path, b"- [x] 1. Task\n").expect("atomic write");

        let mode = fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_spec_directory_leaves_tasks_md_unchanged() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("readonly");
        let original = b"- [ ] 1. Task\n";
        let path = write_tasks(temp.path(), original);
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o555)).expect("chmod dir");

        let still_writable = {
            let probe = temp.path().join(format!(".kiro-spec-probe.{}", std::process::id()));
            match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    true
                }
                Err(_) => false,
            }
        };
        if still_writable {
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))
                .expect("restore dir mode");
            eprintln!("skipping: process can still write in a read-only directory");
            return;
        }

        let error = write_atomic(&path, b"- [x] 1. Task\n").expect_err("write must fail");

        assert_eq!(error.category(), ErrorCategory::MutationWrite);
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert!(!temp_path(temp.path()).exists());

        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).expect("restore dir mode");
    }

    #[test]
    fn reassembly_reproduces_original_bytes_and_equal_bytes_are_a_no_op() {
        let lf = "- [ ] 1. Task\n  - _Requirements: 1.1_\n";
        let crlf = "# Plan\r\n\r\n- [ ] 1. Task\r\n  - _Requirements: 1.1_\r\n";
        let no_final_newline = "- [ ] 1. Task\n  - _Requirements: 1.1_";

        for text in [lf, crlf, no_final_newline] {
            let document = parse_tasks(text);
            let reassembled = document.to_bytes();
            assert_eq!(reassembled, text.as_bytes(), "{text:?}");

            let plan = plan_edit(
                document.entries()[0].id(),
                document.entries()[0].state(),
                None,
                text.as_bytes(),
                &reassembled,
            );
            assert_eq!(plan.id, "1");
            assert!(plan.bytes.is_none(), "{text:?}");
            assert_eq!(plan.reason, None);
        }
    }

    #[test]
    fn differing_reassembly_produces_replacement_bytes() {
        let original = b"- [ ] 1. Task\n";
        let reassembled = b"- [x] 1. Task\n";

        assert_eq!(
            replacement_bytes(original, reassembled),
            Some(reassembled.to_vec())
        );
        assert_eq!(replacement_bytes(original, original), None);
    }

    fn complete(text: &str, id: &str) -> EditPlan {
        let document = parse_tasks(text);
        mutate(&document, id, Change::Complete).expect("complete plan")
    }

    fn planned(plan: &EditPlan) -> &[u8] {
        plan.bytes.as_deref().expect("replacement bytes")
    }

    #[test]
    fn completing_a_pending_entry_changes_only_the_state_character() {
        let text = "# Plan\n\n- [ ] 1. First task\n  - _Requirements: 1.1, 1.2_\n  - _Boundary: scripts/kiro-spec/src/edit.rs_\n  - _Depends: 0.1_\n- [ ] 2. Second task\n  - _Requirements: 2.1_\n";
        let expected = "# Plan\n\n- [x] 1. First task\n  - _Requirements: 1.1, 1.2_\n  - _Boundary: scripts/kiro-spec/src/edit.rs_\n  - _Depends: 0.1_\n- [ ] 2. Second task\n  - _Requirements: 2.1_\n";
        let plan = complete(text, "1.");

        assert_eq!(plan.id, "1");
        assert_eq!(plan.state, TaskState::Completed);
        assert_eq!(plan.reason, None);
        assert_eq!(planned(&plan), expected.as_bytes());
    }

    #[test]
    fn completing_a_blocked_entry_removes_every_reason_bullet_and_its_continuations() {
        let text = "- [!] 1. Blocked work\n  - _Requirements: 1.1_\n  - _Blocked: first reason,\n    with a continuation_\n  - _Boundary: keep this boundary_\n  - _Blocked: second reason_\n  - _Depends: 2.1_\n- [ ] 2. Sibling\n";
        let expected = "- [x] 1. Blocked work\n  - _Requirements: 1.1_\n  - _Boundary: keep this boundary_\n  - _Depends: 2.1_\n- [ ] 2. Sibling\n";
        let plan = complete(text, "1");

        assert_eq!(planned(&plan), expected.as_bytes());
    }

    #[test]
    fn a_reason_continuation_stops_at_an_indented_non_metadata_bullet() {
        let text = "- [!] 1. Blocked\n  - _Blocked: reason_\n  - prose bullet that is not metadata\n  - _Boundary: kept_\n";
        let expected = "- [x] 1. Blocked\n  - prose bullet that is not metadata\n  - _Boundary: kept_\n";

        assert_eq!(planned(&complete(text, "1")), expected.as_bytes());
    }

    #[test]
    fn an_already_completed_entry_is_a_byte_identical_no_op() {
        let text = "- [x] 1. Done\n  - _Requirements: 1.1_\n  - _Blocked: stray bullet stays_\n- [x]* 2. Optional done\n";
        let document = parse_tasks(text);
        let plan = mutate(&document, "1", Change::Complete).expect("no-op plan");

        assert_eq!(plan.id, "1");
        assert_eq!(plan.state, TaskState::Completed);
        assert!(plan.bytes.is_none());
        assert_eq!(plan.reason, None);
        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn the_optional_marker_is_preserved_in_both_directions() {
        let pending = "- [ ]* 1. Optional pending\n";
        let blocked = "- [!]* 2. Optional blocked\n  - _Blocked: reason_\n";

        assert_eq!(
            planned(&complete(pending, "1")),
            b"- [x]* 1. Optional pending\n"
        );
        assert_eq!(
            planned(&complete(blocked, "2")),
            b"- [x]* 2. Optional blocked\n"
        );
    }

    #[test]
    fn parents_children_and_siblings_stay_byte_identical() {
        let text = "- [ ] 1. Parent group\n  - _Requirements: 1.1_\n- [!] 1.1 First child\n  - _Boundary: child boundary_\n- [ ] 1.2 Second child\n  - _Depends: 1.1_\n- [ ] 2. Sibling\n  - _Blocked: stray on a pending entry_\n";
        let expected = "- [ ] 1. Parent group\n  - _Requirements: 1.1_\n- [x] 1.1 First child\n  - _Boundary: child boundary_\n- [ ] 1.2 Second child\n  - _Depends: 1.1_\n- [ ] 2. Sibling\n  - _Blocked: stray on a pending entry_\n";

        assert_eq!(planned(&complete(text, "1.1")), expected.as_bytes());
    }

    #[test]
    fn malformed_unknown_and_duplicate_identifiers_fail_with_exit_category_one() {
        let text = "- [ ] 1. First\n- [ ] 1. Duplicate\n- [ ] 2. Second\n";
        let document = parse_tasks(text);

        for (id, fragment) in [
            ("", "malformed"),
            ("1.2.3", "malformed"),
            ("a", "malformed"),
            ("9", "unknown"),
            ("1", "ambiguous"),
        ] {
            let error = mutate(&document, id, Change::Complete).expect_err(id);
            assert_eq!(error.category(), ErrorCategory::MutationConflict, "{id:?}");
            assert_eq!(error.exit_code(), 1, "{id:?}");
            assert!(error.detail().contains(fragment), "{id:?}: {}", error.detail());
        }
    }

    #[test]
    fn crlf_documents_keep_their_terminators() {
        let text = "# Plan\r\n\r\n- [ ] 1. Task\r\n  - _Requirements: 1.1_\r\n- [!] 2. Blocked\r\n  - _Blocked: reason_\r\n";
        let expected = "# Plan\r\n\r\n- [x] 1. Task\r\n  - _Requirements: 1.1_\r\n- [!] 2. Blocked\r\n  - _Blocked: reason_\r\n";

        assert_eq!(planned(&complete(text, "1")), expected.as_bytes());
        assert_eq!(
            planned(&complete(text, "2")),
            "# Plan\r\n\r\n- [ ] 1. Task\r\n  - _Requirements: 1.1_\r\n- [x] 2. Blocked\r\n"
                .as_bytes()
        );
    }

    #[test]
    fn a_missing_final_newline_survives_completion_and_reason_removal() {
        let pending = "- [ ] 1. Task\n  - _Requirements: 1.1_";
        assert_eq!(
            planned(&complete(pending, "1")),
            b"- [x] 1. Task\n  - _Requirements: 1.1_"
        );

        let blocked = "- [!] 1. Blocked\n  - _Blocked: reason_";
        assert_eq!(planned(&complete(blocked, "1")), b"- [x] 1. Blocked\n");
    }

    #[test]
    fn planning_never_writes_or_creates_a_temporary_file() {
        let temp = TempDir::new("plan-no-write");
        let original = b"- [ ] 1. Task\n  - _Blocked: reason_\n- [ ] 2. Other\n";
        let path = write_tasks(temp.path(), original);
        let text = std::str::from_utf8(original).expect("utf-8");
        let document = parse_tasks(text);

        let plan = mutate(&document, "1", Change::Complete).expect("plan");
        assert!(plan.bytes.is_some());
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert!(!temp_path(temp.path()).exists());

        let error = mutate(&document, "9", Change::Complete).expect_err("unknown id");
        assert_eq!(error.category(), ErrorCategory::MutationConflict);
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert!(!temp_path(temp.path()).exists());

        let entries: Vec<String> = fs::read_dir(temp.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["tasks.md"]);
    }

    fn block(text: &str, id: &str, reason: &str) -> EditPlan {
        let document = parse_tasks(text);
        mutate(
            &document,
            id,
            Change::Block {
                reason: reason.to_owned(),
            },
        )
        .expect("block plan")
    }

    #[test]
    fn blocking_a_pending_entry_inserts_one_canonical_bullet_beneath_the_task_line() {
        let text = "# Plan\n\n- [ ] 1. First task\n  - _Requirements: 1.1, 1.2_\n  - _Boundary: scripts/kiro-spec/src/edit.rs_\n- [ ] 2. Second task\n  - _Requirements: 2.1_\n";
        let expected = "# Plan\n\n- [!] 1. First task\n  - _Blocked: waiting on review_\n  - _Requirements: 1.1, 1.2_\n  - _Boundary: scripts/kiro-spec/src/edit.rs_\n- [ ] 2. Second task\n  - _Requirements: 2.1_\n";
        let plan = block(text, "1.", "waiting on review");

        assert_eq!(plan.id, "1");
        assert_eq!(plan.state, TaskState::Blocked);
        assert_eq!(plan.reason.as_deref(), Some("waiting on review"));
        assert_eq!(planned(&plan), expected.as_bytes());
    }

    #[test]
    fn blocking_preserves_the_optional_marker() {
        let text = "- [ ]* 1. Optional pending\n- [ ] 2. Normal\n  - _Requirements: 2.1_\n";
        let expected = "- [!]* 1. Optional pending\n  - _Blocked: waiting_\n- [ ] 2. Normal\n  - _Requirements: 2.1_\n";

        assert_eq!(planned(&block(text, "1", "waiting")), expected.as_bytes());
    }

    #[test]
    fn blocking_a_blocked_entry_replaces_the_reason_bullet_in_place() {
        let text = "- [!] 2. Blocked task\n  - _Requirements: 2.1_\n    - _Blocked: old reason,\n      with a continuation_\n  - _Boundary: blocked boundary_\n  - _Blocked: stray reason_\n  - _Depends: 2.2_\n- [ ] 3. Sibling\n";
        let expected = "- [!] 2. Blocked task\n  - _Requirements: 2.1_\n    - _Blocked: new reason_\n  - _Boundary: blocked boundary_\n  - _Depends: 2.2_\n- [ ] 3. Sibling\n";
        let plan = block(text, "2", "new reason");

        assert_eq!(plan.id, "2");
        assert_eq!(plan.state, TaskState::Blocked);
        assert_eq!(plan.reason.as_deref(), Some("new reason"));
        assert_eq!(planned(&plan), expected.as_bytes());
    }

    #[test]
    fn blocking_with_the_same_reason_is_a_byte_identical_no_op() {
        let text = "- [!] 1. Blocked\n  - _Requirements: 1.1_\n  - _Boundary: kept_\n  - _Blocked: keep me,\n    as is_\n  - _Depends: 1.2_\n- [!] 2. Other\n  - _Blocked: keep me, as is_\n";
        let document = parse_tasks(text);
        let plan = mutate(
            &document,
            "1",
            Change::Block {
                reason: "keep me, as is".to_owned(),
            },
        )
        .expect("no-op plan");

        assert_eq!(plan.id, "1");
        assert_eq!(plan.state, TaskState::Blocked);
        assert_eq!(plan.reason.as_deref(), Some("keep me, as is"));
        assert!(plan.bytes.is_none());
        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn blocking_a_completed_entry_is_an_unsupported_transition_with_no_write() {
        let temp = TempDir::new("block-completed");
        let original = b"- [x] 1. Done\n  - _Requirements: 1.1_\n- [ ] 2. Pending\n";
        let path = write_tasks(temp.path(), original);
        let text = std::str::from_utf8(original).expect("utf-8");
        let document = parse_tasks(text);

        let error = mutate(
            &document,
            "1",
            Change::Block {
                reason: "waiting".to_owned(),
            },
        )
        .expect_err("completed entries cannot be blocked");

        assert_eq!(error.category(), ErrorCategory::MutationConflict);
        assert_eq!(error.exit_code(), 1);
        assert!(
            error.detail().contains("unsupported transition"),
            "{}",
            error.detail()
        );
        assert!(
            error.detail().contains("completed"),
            "{}",
            error.detail()
        );
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert!(!temp_path(temp.path()).exists());
        let entries: Vec<String> = fs::read_dir(temp.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["tasks.md"]);
    }

    #[test]
    fn blocking_in_a_crlf_document_inserts_crlf_and_keeps_all_terminators() {
        let text = "# Plan\r\n\r\n- [ ] 1. Task\r\n  - _Requirements: 1.1_\r\n- [ ] 2. Other\r\n";
        let expected = "# Plan\r\n\r\n- [!] 1. Task\r\n  - _Blocked: waiting_\r\n  - _Requirements: 1.1_\r\n- [ ] 2. Other\r\n";

        assert_eq!(planned(&block(text, "1", "waiting")), expected.as_bytes());
    }

    #[test]
    fn a_blocked_entry_without_a_reason_bullet_gains_exactly_one() {
        let text = "- [!] 1. Blocked\n  - _Requirements: 1.1_\n  - _Boundary: kept_\n";
        let expected = "- [!] 1. Blocked\n  - _Blocked: waiting_\n  - _Requirements: 1.1_\n  - _Boundary: kept_\n";

        assert_eq!(planned(&block(text, "1", "waiting")), expected.as_bytes());
    }

    #[test]
    fn multiple_preexisting_reason_bullets_collapse_to_a_single_canonical_bullet() {
        let text = "- [ ] 1. Task\n  - _Blocked: first reason,\n    with continuation_\n  - _Boundary: keep this boundary_\n  - _Blocked: second reason_\n- [ ] 2. Sibling\n";
        let expected = "- [!] 1. Task\n  - _Blocked: new reason_\n  - _Boundary: keep this boundary_\n- [ ] 2. Sibling\n";

        assert_eq!(planned(&block(text, "1", "new reason")), expected.as_bytes());
    }

    #[test]
    fn blocking_terminates_a_final_unterminated_line_with_the_document_convention() {
        assert_eq!(
            planned(&block("- [ ] 1. Task", "1", "waiting")),
            b"- [!] 1. Task\n  - _Blocked: waiting_\n"
        );
        assert_eq!(
            planned(&block("# Plan\r\n- [ ] 1. Task", "1", "waiting")),
            b"# Plan\r\n- [!] 1. Task\r\n  - _Blocked: waiting_\r\n"
        );
    }
}
