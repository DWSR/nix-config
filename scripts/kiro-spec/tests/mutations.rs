mod support;

use std::fs;
use std::path::Path;

use serde_json::Value;
use support::{copy_tree, read_only, SpecTree};

const SPEC_JSON: &str = r#"{
  "feature_name": "demo",
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-02T00:00:00Z",
  "language": "en",
  "phase": "tasks-generated",
  "approvals": {
    "requirements": {"generated": true, "approved": true},
    "design": {"generated": true, "approved": true},
    "tasks": {"generated": true, "approved": true}
  },
  "ready_for_implementation": false
}"#;

const BASIC_TASKS: &str = "# Implementation Plan\n\n- [ ] 1. Foundation\n- [ ] 1.1 First child\n  - _Requirements: 1.1_\n- [ ]* 1.2 Optional child\n  - _Requirements: 1, 2_\n    2.1\n- [x] 2. Completed task\n  - _Requirements: 2.1_\n- [!] 3. Blocked task\n  - _Blocked: Waiting on credentials_\n  - _Requirements: 1.2_\n- [ ] 4. Legacy prose entry\n  - _Blocked: this is not a state marker_\n- [ ] 5. Adjacent first\n- [ ]* 6. Adjacent second\n- [x]* 7. Completed optional\n";

const BASIC_TASKS_AFTER_COMPLETE: &str = "# Implementation Plan\n\n- [ ] 1. Foundation\n- [ ] 1.1 First child\n  - _Requirements: 1.1_\n- [x]* 1.2 Optional child\n  - _Requirements: 1, 2_\n    2.1\n- [x] 2. Completed task\n  - _Requirements: 2.1_\n- [!] 3. Blocked task\n  - _Blocked: Waiting on credentials_\n  - _Requirements: 1.2_\n- [ ] 4. Legacy prose entry\n  - _Blocked: this is not a state marker_\n- [ ] 5. Adjacent first\n- [ ]* 6. Adjacent second\n- [x]* 7. Completed optional\n";

const DUPLICATE_FIXTURE_TASKS: &str = "# Implementation Plan\n\n- [ ] 1. First occurrence\n- [ ] 1. Second occurrence\n- [x] 1. Third occurrence\n";

const BLOCKED_BEFORE: &str = "# Plan\n\n- [!]* 1. Blocked work\n  - _Requirements: 1.1_\n    - _Blocked: first reason,\n      with a continuation_\n  - _Boundary: scripts/kiro-spec/tests/mutations.rs_\n  - _Blocked: second reason_\n  - _Depends: 2.1_\n- [!] 2. Other blocked\n  - _Blocked: untouched_\n- [ ] 3. Pending sibling\n";

const BLOCKED_AFTER_FIRST: &str = "# Plan\n\n- [x]* 1. Blocked work\n  - _Requirements: 1.1_\n  - _Boundary: scripts/kiro-spec/tests/mutations.rs_\n  - _Depends: 2.1_\n- [!] 2. Other blocked\n  - _Blocked: untouched_\n- [ ] 3. Pending sibling\n";

const BLOCKED_AFTER_SECOND: &str = "# Plan\n\n- [x]* 1. Blocked work\n  - _Requirements: 1.1_\n  - _Boundary: scripts/kiro-spec/tests/mutations.rs_\n  - _Depends: 2.1_\n- [x] 2. Other blocked\n- [ ] 3. Pending sibling\n";

const COMPLETED_NOOP: &str = "- [x] 1. Done\n  - _Requirements: 1.1_\n- [x]* 2. Optional done\n  - _Blocked: stray bullet on a completed entry stays_\n- [ ] 3. Pending\n";

const BLOCK_INSERT_BEFORE: &str = "# Plan\n\n- [ ]* 2. Optional pending task\n  - _Blocked: stale stray reason_\n  - _Requirements: 2.1_\n  - _Boundary: scripts/kiro-spec/tests/mutations.rs_\n- [ ] 3. Sibling\n";

const BLOCK_INSERT_AFTER: &str = "# Plan\n\n- [!]* 2. Optional pending task\n  - _Blocked: waiting on review_\n  - _Requirements: 2.1_\n  - _Boundary: scripts/kiro-spec/tests/mutations.rs_\n- [ ] 3. Sibling\n";

const BLOCK_REPLACE_BEFORE: &str = "# Plan\n\n- [!] 2. Blocked task\n  - _Requirements: 2.1_\n    - _Blocked: old reason,\n      with a continuation_\n  - _Boundary: boundary stays_\n  - _Blocked: stale second reason_\n  - _Depends: 2.2_\n- [ ] 3. Sibling stays\n";

const BLOCK_REPLACE_AFTER: &str = "# Plan\n\n- [!] 2. Blocked task\n  - _Requirements: 2.1_\n    - _Blocked: new reason_\n  - _Boundary: boundary stays_\n  - _Depends: 2.2_\n- [ ] 3. Sibling stays\n";

const SAME_REASON_BEFORE: &str = "- [!] 1. Blocked\n  - _Requirements: 1.1_\n    - _Blocked: waiting on\n      credentials_\n  - _Boundary: kept_\n- [ ] 2. Other\n";

const COMPLETED_BEFORE_BLOCK: &str = "- [x] 1. Done\n  - _Requirements: 1.1_\n- [x]* 2. Optional done\n  - _Blocked: stray on a completed entry_\n- [ ] 3. Pending\n";

const CRLF_BEFORE: &str = "# Plan\r\n\r\n- [ ] 1. First task\r\n  - _Requirements: 1.1_\r\n- [ ] 2. Second task\r\n  - _Requirements: 2.1_\r\n";

const CRLF_AFTER_COMPLETE: &str = "# Plan\r\n\r\n- [x] 1. First task\r\n  - _Requirements: 1.1_\r\n- [ ] 2. Second task\r\n  - _Requirements: 2.1_\r\n";

const CRLF_AFTER_BLOCK: &str = "# Plan\r\n\r\n- [x] 1. First task\r\n  - _Requirements: 1.1_\r\n- [!] 2. Second task\r\n  - _Blocked: waiting_\r\n  - _Requirements: 2.1_\r\n";

fn tree(tag: &str, tasks: impl AsRef<[u8]>) -> SpecTree {
    let tree = SpecTree::new("demo", tag);
    tree.write("spec.json", SPEC_JSON).write("tasks.md", tasks);
    tree
}

fn copy_fixture(relative: &str, name: &str, tag: &str) -> SpecTree {
    let tree = SpecTree::new(name, tag);
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    copy_tree(&source, tree.root())
        .unwrap_or_else(|error| panic!("cannot copy fixture {}: {error}", source.display()));
    tree
}

#[cfg(unix)]
fn tasks_inode(tree: &SpecTree) -> u64 {
    use std::os::unix::fs::MetadataExt;

    fs::metadata(tree.spec_dir().join("tasks.md"))
        .expect("stat tasks.md")
        .ino()
}

#[cfg(not(unix))]
fn tasks_inode(_tree: &SpecTree) -> u64 {
    0
}

fn assert_no_temp_files(tree: &SpecTree) {
    let leftovers: Vec<String> = fs::read_dir(tree.spec_dir())
        .expect("read spec directory")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "leftover temporary files: {leftovers:?}"
    );
}

fn assert_siblings_unchanged(tree: &SpecTree, before: u64) {
    assert_eq!(
        tree.tree_hash_excluding(&["tasks.md"]),
        before,
        "a mutation changed a file other than tasks.md"
    );
}

fn assert_mutation(tree: &SpecTree, args: &[&str], expected_stdout: &str, expected_tasks: &[u8]) {
    let siblings = tree.tree_hash_excluding(&["tasks.md"]);
    let output = tree.run(args).assert_success();
    assert_eq!(output.stdout_text(), expected_stdout, "{args:?}");
    assert_eq!(tree.read("tasks.md"), expected_tasks, "{args:?}");
    assert_siblings_unchanged(tree, siblings);
    assert_no_temp_files(tree);
}

fn assert_no_change(tree: &SpecTree, args: &[&str], expected_stdout: &str) {
    let before = tree.read("tasks.md");
    let siblings = tree.tree_hash_excluding(&["tasks.md"]);
    let inode = tasks_inode(tree);

    let output = tree.run(args).assert_success();
    assert_eq!(output.stdout_text(), expected_stdout, "{args:?}");
    assert_eq!(tree.read("tasks.md"), before, "{args:?}");
    assert_siblings_unchanged(tree, siblings);
    assert_no_temp_files(tree);
    assert_eq!(tasks_inode(tree), inode, "no-op rewrote tasks.md: {args:?}");
}

fn assert_conflict(tree: &SpecTree, args: &[&str], fragments: &[&str]) {
    let before = tree.read("tasks.md");
    let siblings = tree.tree_hash_excluding(&["tasks.md"]);

    let output = tree.run(args);
    assert_eq!(output.code(), Some(1), "{args:?}");
    assert!(output.stdout().is_empty(), "{args:?}");
    let stderr = output.stderr_text();
    assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
    for fragment in fragments {
        assert!(
            stderr.contains(fragment),
            "{args:?}: missing {fragment:?} in {stderr}"
        );
    }
    assert_eq!(tree.read("tasks.md"), before, "{args:?}");
    assert_siblings_unchanged(tree, siblings);
    assert_no_temp_files(tree);
}

fn read_json(tree: &SpecTree, args: &[&str]) -> Value {
    tree.run(args).assert_success().json()
}

fn task<'a>(document: &'a Value, id: &str) -> &'a Value {
    document["tasks"]
        .as_array()
        .expect("tasks array")
        .iter()
        .find(|entry| entry["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("missing task `{id}` in {document}"))
}

fn assert_task(document: &Value, id: &str, state: &str, optional: bool, reason: Option<&str>) {
    let entry = task(document, id);
    assert_eq!(entry["state"].as_str(), Some(state), "task `{id}`: {entry}");
    assert_eq!(
        entry["optional"].as_bool(),
        Some(optional),
        "task `{id}`: {entry}"
    );
    assert_eq!(
        entry["blocked_reason"].as_str(),
        reason,
        "task `{id}`: {entry}"
    );
}

fn assert_description(document: &Value, id: &str, description: &str) {
    assert_eq!(
        task(document, id)["description"].as_str(),
        Some(description),
        "task `{id}` description"
    );
}

fn assert_next(document: &Value, id: Option<&str>, state: &str, reason: Option<&str>) {
    let next = &document["task"];
    match id {
        Some(id) => {
            assert_eq!(next["id"].as_str(), Some(id), "{document}");
            assert_eq!(next["state"].as_str(), Some(state), "{document}");
            assert_eq!(next["blocked_reason"].as_str(), reason, "{document}");
        }
        None => assert!(next.is_null(), "{document}"),
    }
}

fn assert_counts(
    document: &Value,
    total: u64,
    completed: u64,
    pending: u64,
    blocked: u64,
    optional_pending: u64,
) {
    assert_eq!(document["total"].as_u64(), Some(total), "{document}");
    assert_eq!(
        document["counts"]["completed"].as_u64(),
        Some(completed),
        "{document}"
    );
    assert_eq!(
        document["counts"]["pending"].as_u64(),
        Some(pending),
        "{document}"
    );
    assert_eq!(
        document["counts"]["blocked"].as_u64(),
        Some(blocked),
        "{document}"
    );
    assert_eq!(
        document["optional_pending"].as_u64(),
        Some(optional_pending),
        "{document}"
    );
}

fn occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count()
}

fn assert_crlf_terminators(bytes: &[u8]) {
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            assert!(
                index > 0 && bytes[index - 1] == b'\r',
                "bare LF at byte {index}"
            );
        }
        if *byte == b'\r' {
            assert_eq!(
                bytes.get(index + 1),
                Some(&b'\n'),
                "bare CR at byte {index}"
            );
        }
    }
}

#[test]
fn complete_pending_preserves_optional_marker_metadata_indentation_and_siblings() {
    let tree = copy_fixture("tests/fixtures/basic", "basic", "basic-complete-pending");
    assert_eq!(tree.read("tasks.md"), BASIC_TASKS.as_bytes());
    let siblings = tree.tree_hash_excluding(&["tasks.md"]);

    assert_mutation(
        &tree,
        &["complete", "1.2"],
        "1.2 completed\n",
        BASIC_TASKS_AFTER_COMPLETE.as_bytes(),
    );
    assert_siblings_unchanged(&tree, siblings);

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_description(&tasks, "1.2", "Optional child");
    assert_task(&tasks, "1.2", "completed", true, None);
    assert_task(&tasks, "1", "pending", false, None);
    assert_task(&tasks, "1.1", "pending", false, None);
    assert_task(&tasks, "2", "completed", false, None);
    assert_task(
        &tasks,
        "3",
        "blocked",
        false,
        Some("Waiting on credentials"),
    );
    assert_task(&tasks, "4", "pending", false, None);
    assert_task(&tasks, "5", "pending", false, None);
    assert_task(&tasks, "6", "pending", true, None);
    assert_task(&tasks, "7", "completed", true, None);

    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("1.1"), "pending", None);

    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 9, 3, 5, 1, 1);
}

#[test]
fn complete_blocked_removes_reason_bullets_and_continuations_for_both_markers() {
    let tree = tree("complete-blocked", BLOCKED_BEFORE);
    assert_mutation(
        &tree,
        &["complete", "1"],
        "1 completed\n",
        BLOCKED_AFTER_FIRST.as_bytes(),
    );
    assert_eq!(occurrences(&tree.read("tasks.md"), b"_Blocked:"), 1);

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_task(&tasks, "1", "completed", true, None);
    assert_task(&tasks, "2", "blocked", false, Some("untouched"));
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("2"), "blocked", Some("untouched"));
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 3, 1, 1, 1, 0);

    assert_mutation(
        &tree,
        &["complete", "2"],
        "2 completed\n",
        BLOCKED_AFTER_SECOND.as_bytes(),
    );
    assert_eq!(occurrences(&tree.read("tasks.md"), b"_Blocked:"), 0);

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_task(&tasks, "1", "completed", true, None);
    assert_task(&tasks, "2", "completed", false, None);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("3"), "pending", None);
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 3, 2, 1, 0, 0);
}

#[test]
fn complete_on_completed_entries_is_a_byte_identical_no_op_without_rewrite() {
    let tree = tree("complete-noop", COMPLETED_NOOP);

    assert_no_change(&tree, &["complete", "1"], "1 completed (no change)\n");
    assert_no_change(&tree, &["complete", "2"], "2 completed (no change)\n");
    assert_eq!(tree.read("tasks.md"), COMPLETED_NOOP.as_bytes());

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_task(&tasks, "1", "completed", false, None);
    assert_task(&tasks, "2", "completed", true, None);
    assert_task(&tasks, "3", "pending", false, None);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("3"), "pending", None);
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 3, 2, 1, 0, 0);
}

#[test]
fn block_pending_inserts_one_canonical_bullet_and_removes_a_stray_reason() {
    let tree = tree("block-insert", BLOCK_INSERT_BEFORE);
    assert_mutation(
        &tree,
        &["block", "2", "--reason", "  waiting on review  "],
        "2 blocked\n",
        BLOCK_INSERT_AFTER.as_bytes(),
    );
    assert_eq!(occurrences(&tree.read("tasks.md"), b"_Blocked:"), 1);

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_description(&tasks, "2", "Optional pending task");
    assert_task(&tasks, "2", "blocked", true, Some("waiting on review"));
    assert_task(&tasks, "3", "pending", false, None);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("2"), "blocked", Some("waiting on review"));
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 2, 0, 1, 1, 0);
}

#[test]
fn block_blocked_replaces_the_reason_bullet_in_place_and_collapses_duplicates() {
    let tree = tree("block-replace", BLOCK_REPLACE_BEFORE);
    assert_mutation(
        &tree,
        &["block", "2", "--reason", "new reason"],
        "2 blocked\n",
        BLOCK_REPLACE_AFTER.as_bytes(),
    );
    assert_eq!(occurrences(&tree.read("tasks.md"), b"_Blocked:"), 1);
    assert!(!tree
        .read("tasks.md")
        .windows(10)
        .any(|window| window == b"old reason"));

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_description(&tasks, "2", "Blocked task");
    assert_task(&tasks, "2", "blocked", false, Some("new reason"));
    assert_task(&tasks, "3", "pending", false, None);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("2"), "blocked", Some("new reason"));
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 2, 0, 1, 1, 0);
}

#[test]
fn block_with_the_same_reason_is_a_byte_identical_no_op_for_a_non_canonical_bullet() {
    let tree = tree("block-same-reason", SAME_REASON_BEFORE);
    assert_no_change(
        &tree,
        &["block", "1", "--reason", "  waiting on credentials  "],
        "1 blocked (no change)\n",
    );
    assert_eq!(tree.read("tasks.md"), SAME_REASON_BEFORE.as_bytes());

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_task(
        &tasks,
        "1",
        "blocked",
        false,
        Some("waiting on credentials"),
    );
    assert_task(&tasks, "2", "pending", false, None);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("1"), "blocked", Some("waiting on credentials"));
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 2, 0, 1, 1, 0);
}

#[test]
fn block_on_completed_entries_is_rejected_without_writing() {
    let tree = tree("block-completed", COMPLETED_BEFORE_BLOCK);

    assert_conflict(
        &tree,
        &["block", "1", "--reason", "waiting"],
        &["unsupported transition", "completed", "`1`"],
    );
    assert_conflict(
        &tree,
        &["block", "2", "--reason", "waiting"],
        &["unsupported transition", "completed", "`2`"],
    );
    assert_eq!(tree.read("tasks.md"), COMPLETED_BEFORE_BLOCK.as_bytes());

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_task(&tasks, "1", "completed", false, None);
    assert_task(&tasks, "2", "completed", true, None);
    assert_task(&tasks, "3", "pending", false, None);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("3"), "pending", None);
}

#[test]
fn unknown_and_duplicate_identifiers_are_conflicts_without_writing() {
    let unknown = tree("unknown-id", "- [ ] 1. First\n- [ ] 2. Second\n");
    assert_conflict(
        &unknown,
        &["complete", "9"],
        &["unknown task identifier", "`9`"],
    );
    assert_conflict(
        &unknown,
        &["block", "9", "--reason", "waiting"],
        &["unknown task identifier", "`9`"],
    );

    let duplicate = copy_fixture(
        "tests/fixtures/malformed/duplicate",
        "duplicate",
        "duplicate-id",
    );
    assert_eq!(
        duplicate.read("tasks.md"),
        DUPLICATE_FIXTURE_TASKS.as_bytes()
    );
    assert_conflict(
        &duplicate,
        &["complete", "1"],
        &["ambiguous task identifier", "`1`", "matches 3 entries"],
    );
    assert_conflict(
        &duplicate,
        &["block", "1", "--reason", "waiting"],
        &["ambiguous task identifier", "`1`", "matches 3 entries"],
    );
    assert_eq!(
        duplicate.read("tasks.md"),
        DUPLICATE_FIXTURE_TASKS.as_bytes()
    );
}

#[test]
fn crlf_document_keeps_every_terminator_for_complete_and_block() {
    let tree = tree("crlf-mutations", CRLF_BEFORE);

    assert_mutation(
        &tree,
        &["complete", "1"],
        "1 completed\n",
        CRLF_AFTER_COMPLETE.as_bytes(),
    );
    assert_crlf_terminators(&tree.read("tasks.md"));

    assert_mutation(
        &tree,
        &["block", "2", "--reason", "waiting"],
        "2 blocked\n",
        CRLF_AFTER_BLOCK.as_bytes(),
    );
    assert_crlf_terminators(&tree.read("tasks.md"));

    let tasks = read_json(&tree, &["--json", "tasks"]);
    assert_task(&tasks, "1", "completed", false, None);
    assert_task(&tasks, "2", "blocked", false, Some("waiting"));
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("2"), "blocked", Some("waiting"));
    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 2, 1, 0, 1, 0);
}

#[test]
fn missing_final_newline_is_preserved_by_complete_and_block() {
    let complete = tree(
        "missing-newline-complete",
        b"- [ ] 1. Task\n  - _Requirements: 1.1_".as_slice(),
    );
    assert_mutation(
        &complete,
        &["complete", "1"],
        "1 completed\n",
        b"- [x] 1. Task\n  - _Requirements: 1.1_",
    );
    assert!(!complete.read("tasks.md").ends_with(b"\n"));
    let tasks = read_json(&complete, &["--json", "tasks"]);
    assert_task(&tasks, "1", "completed", false, None);
    let next = read_json(&complete, &["--json", "next"]);
    assert_next(&next, None, "pending", None);
    let status = read_json(&complete, &["--json", "status"]);
    assert_counts(&status, 1, 1, 0, 0, 0);

    let block = tree(
        "missing-newline-block",
        b"- [ ] 1. Task\n- [ ] 2. Other".as_slice(),
    );
    assert_mutation(
        &block,
        &["block", "1", "--reason", "waiting"],
        "1 blocked\n",
        b"- [!] 1. Task\n  - _Blocked: waiting_\n- [ ] 2. Other",
    );
    assert!(!block.read("tasks.md").ends_with(b"\n"));
    let tasks = read_json(&block, &["--json", "tasks"]);
    assert_task(&tasks, "1", "blocked", false, Some("waiting"));
    assert_task(&tasks, "2", "pending", false, None);
    let next = read_json(&block, &["--json", "next"]);
    assert_next(&next, Some("1"), "blocked", Some("waiting"));
    let status = read_json(&block, &["--json", "status"]);
    assert_counts(&status, 2, 0, 1, 1, 0);

    let crlf = tree(
        "missing-newline-crlf-block",
        b"# Plan\r\n- [ ] 1. Task".as_slice(),
    );
    assert_mutation(
        &crlf,
        &["block", "1", "--reason", "waiting"],
        "1 blocked\n",
        b"# Plan\r\n- [!] 1. Task\r\n  - _Blocked: waiting_\r\n",
    );
    assert_crlf_terminators(&crlf.read("tasks.md"));
    let tasks = read_json(&crlf, &["--json", "tasks"]);
    assert_task(&tasks, "1", "blocked", false, Some("waiting"));
    let next = read_json(&crlf, &["--json", "next"]);
    assert_next(&next, Some("1"), "blocked", Some("waiting"));
    let status = read_json(&crlf, &["--json", "status"]);
    assert_counts(&status, 1, 0, 0, 1, 0);
}

#[cfg(unix)]
#[test]
fn a_failed_write_leaves_tasks_md_intact_and_no_temp_file() {
    let tree = tree("read-only-mutation", "- [ ] 1. First\n- [ ] 2. Second\n");
    tree.write("requirements.md", b"# Requirements\n")
        .write("design.md", b"# Design\n");
    let before = tree.read("tasks.md");
    let siblings = tree.tree_hash_excluding(&["tasks.md"]);

    let guard = read_only(tree.spec_dir());
    if !guard.is_supported() {
        eprintln!("skipping: platform does not expose unix directory modes");
        return;
    }
    if guard.can_still_write() {
        eprintln!("skipping: process can still write in a read-only directory");
        return;
    }

    for args in [
        &["complete", "1"][..],
        &["block", "2", "--reason", "waiting"][..],
    ] {
        let output = tree.run(args);
        assert_eq!(output.code(), Some(1), "{args:?}");
        assert!(output.stdout().is_empty(), "{args:?}");
        let stderr = output.stderr_text();
        assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
        assert!(stderr.contains("tasks.md"), "{args:?}: {stderr}");
        assert!(
            stderr.contains("cannot create temporary file"),
            "{args:?}: {stderr}"
        );
        assert_eq!(tree.read("tasks.md"), before, "{args:?}");
        assert_siblings_unchanged(&tree, siblings);
        assert_no_temp_files(&tree);
    }

    guard.restore();
}

#[test]
fn successful_mutations_change_only_tasks_md() {
    let tree = tree("only-tasks-md", "- [ ] 1. First\n- [ ] 2. Second\n");
    tree.write("requirements.md", b"# Requirements\n\n- 1. Thing\n")
        .write("design.md", b"# Design\n")
        .write("brief.md", b"# Brief\n");
    tree.write_at("notes/extra.txt", b"keep me\n");

    let spec_json = tree.read("spec.json");
    let requirements = tree.read("requirements.md");
    let design = tree.read("design.md");
    let brief = tree.read("brief.md");
    let extra_path = tree.root().join("notes/extra.txt");
    let extra = fs::read(&extra_path).expect("read extra file");
    let siblings = tree.tree_hash_excluding(&["tasks.md"]);

    assert_eq!(
        tree.run(&["complete", "1"]).assert_success().code(),
        Some(0)
    );
    assert_eq!(
        tree.run(&["block", "2", "--reason", "waiting"])
            .assert_success()
            .code(),
        Some(0)
    );

    assert_siblings_unchanged(&tree, siblings);
    assert_eq!(tree.read("spec.json"), spec_json);
    assert_eq!(tree.read("requirements.md"), requirements);
    assert_eq!(tree.read("design.md"), design);
    assert_eq!(tree.read("brief.md"), brief);
    assert_eq!(fs::read(&extra_path).expect("read extra file"), extra);
    assert_eq!(
        tree.read("tasks.md"),
        b"- [x] 1. First\n- [!] 2. Second\n  - _Blocked: waiting_\n"
    );
    assert_no_temp_files(&tree);

    let status = read_json(&tree, &["--json", "status"]);
    assert_counts(&status, 2, 1, 0, 1, 0);
    let next = read_json(&tree, &["--json", "next"]);
    assert_next(&next, Some("2"), "blocked", Some("waiting"));
}
