//! Mutation contract tests for the compiled `kiro-spec` binary.
//!
//! Every case runs the real executable through the shared temp-tree harness, so
//! the suite observes the same argv parsing, publication, and rendering an
//! operator sees. Each mutation is checked three ways: the exact bytes left in
//! `tasks.md`, a before/after snapshot proving no other artifact changed and no
//! temporary file survived publication, and a follow-up `tasks`, `next`, and
//! `status` run reporting the new state.

mod support;

use std::collections::BTreeMap;
use std::fs;

use serde_json::Value;
use support::{ReadOnlyDir, TempTree};

/// A parseable `spec.json` whose phase is a documented rung.
const SPEC_JSON: &str = r#"{
  "feature_name": "demo",
  "created_at": "2026-10-26T00:00:00Z",
  "updated_at": "2026-10-26T01:00:00Z",
  "language": "en",
  "approvals": {
    "requirements": {
      "generated": true,
      "approved": false
    },
    "design": {
      "generated": true,
      "approved": false
    },
    "tasks": {
      "generated": true,
      "approved": false
    }
  },
  "phase": "tasks-generated",
  "ready_for_implementation": false
}
"#;

/// The requirements artifact that must survive a mutation untouched.
const REQUIREMENTS: &str = "\
# Requirements Document

### Requirement 1: Foundation

#### Acceptance Criteria

1. The foundation shall exist.
";

/// The design artifact that must survive a mutation untouched.
const DESIGN: &str = "\
# Design Document

## Overview

Mutation contract fixture.
";

/// The state of one entry as the read commands expose it.
///
/// `(identifier, description, state, optional, blocked_reason)`.
type EntryState<'a> = (&'a str, &'a str, &'a str, bool, Option<&'a str>);

/// The per-state counts `status` reports.
///
/// `(total, completed, pending, blocked, optional_pending)`.
type Counts = (u64, u64, u64, u64, u64);

/// A spec tree whose only interesting artifact is `tasks.md`.
fn mutation_tree(label: &str, tasks: &str) -> TempTree {
    TempTree::with_spec(
        label,
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("tasks.md", tasks),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    )
}

/// Every file directly beneath the spec directory, keyed by file name.
///
/// A directory entry where a file belongs (such as a leftover temporary
/// directory) fails the snapshot instead of being silently ignored.
fn spec_files(tree: &TempTree, spec: &str) -> BTreeMap<String, Vec<u8>> {
    let directory = tree.spec_dir(spec);
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(&directory).expect("the spec directory is readable") {
        let entry = entry.expect("every directory entry is readable");
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().expect("the entry type is readable");
        assert!(
            file_type.is_file(),
            "a mutation must not leave a non-file entry behind: {name}"
        );
        files.insert(
            name,
            fs::read(entry.path()).expect("every artifact is readable"),
        );
    }
    files
}

/// Assert neither a file was created nor removed and only `tasks.md` differs.
fn assert_only_tasks_md_changed(
    before: &BTreeMap<String, Vec<u8>>,
    after: &BTreeMap<String, Vec<u8>>,
) {
    let before_names = before.keys().collect::<Vec<_>>();
    let after_names = after.keys().collect::<Vec<_>>();
    assert_eq!(
        before_names, after_names,
        "a mutation creates no file and leaves no temporary file behind"
    );
    for (name, bytes) in before {
        if name == "tasks.md" {
            continue;
        }
        assert_eq!(
            after.get(name),
            Some(bytes),
            "{name} must stay byte-identical across a tasks.md mutation"
        );
    }
}

/// The checkbox state character of the first line starting with `prefix`.
fn state_offset(bytes: &[u8], prefix: &str) -> usize {
    let start = bytes
        .windows(prefix.len())
        .position(|window| window == prefix.as_bytes())
        .unwrap_or_else(|| panic!("tasks.md starts a line with {prefix:?}"));
    start + 3
}

/// Assert the replacement differs from the source only in the checkbox state.
fn assert_only_state_byte_changed(before: &[u8], after: &[u8], offset: usize, state: u8) {
    assert_eq!(
        after.len(),
        before.len(),
        "rewriting a checkbox adds and removes no byte"
    );
    assert_eq!(
        before[offset], b' ',
        "the fixture starts from a pending checkbox"
    );
    assert_eq!(
        after[offset], state,
        "the checkbox state character is rewritten"
    );
    assert_eq!(
        &before[..offset],
        &after[..offset],
        "every byte before the checkbox is preserved"
    );
    assert_eq!(
        &before[offset + 1..],
        &after[offset + 1..],
        "every byte after the checkbox is preserved"
    );
}

/// Run a read command with `--json` and parse its single document.
fn read_json(tree: &TempTree, command: &str) -> Value {
    let run = tree.run_spec("demo", &[command, "--json"]);
    assert_eq!(
        run.code(),
        0,
        "{command} must succeed after the mutation: {}",
        run.stderr()
    );
    assert_eq!(run.stderr(), "", "{command} writes no diagnostic");
    serde_json::from_str(run.stdout()).unwrap_or_else(|error| {
        panic!(
            "{command} must write exactly one JSON document: {error}\nstdout:\n{}\nstderr:\n{}",
            run.stdout(),
            run.stderr()
        )
    })
}

/// Assert `tasks`, `next`, and `status` report the given post-mutation state.
fn assert_reads(
    tree: &TempTree,
    expected_tasks: &[EntryState<'_>],
    expected_next: Option<EntryState<'_>>,
    expected_counts: Counts,
) {
    let tasks = read_json(tree, "tasks");
    let actual = tasks["tasks"]
        .as_array()
        .unwrap_or_else(|| panic!("tasks writes an entries array:\n{tasks}"))
        .iter()
        .map(|entry| {
            (
                entry["id"].as_str().expect("entry id"),
                entry["description"].as_str().expect("entry description"),
                entry["state"].as_str().expect("entry state"),
                entry["optional"].as_bool().expect("entry optional flag"),
                entry["blocked_reason"].as_str(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        actual, expected_tasks,
        "a later tasks run reports the mutated state"
    );

    let next = read_json(tree, "next");
    match expected_next {
        Some((id, description, state, optional, reason)) => {
            let task = &next["task"];
            assert!(
                task.is_object(),
                "next selects the actionable entry after the mutation:\n{next}"
            );
            assert_eq!(task["id"].as_str(), Some(id), "next identifier");
            assert_eq!(
                task["description"].as_str(),
                Some(description),
                "next description"
            );
            assert_eq!(task["state"].as_str(), Some(state), "next state");
            assert_eq!(task["optional"].as_bool(), Some(optional), "next optional");
            assert_eq!(
                task["blocked_reason"].as_str(),
                reason,
                "next blocked reason"
            );
        }
        None => assert!(
            next["task"].is_null(),
            "next reports no actionable entry after the mutation:\n{next}"
        ),
    }

    let status = read_json(tree, "status");
    let (total, completed, pending, blocked, optional_pending) = expected_counts;
    assert_eq!(status["spec"].as_str(), Some("demo"));
    assert_eq!(status["stage"].as_str(), Some("tasks-generated"));
    assert_eq!(status["total"].as_u64(), Some(total), "status total");
    assert_eq!(
        status["counts"]["completed"].as_u64(),
        Some(completed),
        "status completed count"
    );
    assert_eq!(
        status["counts"]["pending"].as_u64(),
        Some(pending),
        "status pending count"
    );
    assert_eq!(
        status["counts"]["blocked"].as_u64(),
        Some(blocked),
        "status blocked count"
    );
    assert_eq!(
        status["optional_pending"].as_u64(),
        Some(optional_pending),
        "status optional pending count"
    );
}

/// The exact `tasks.md` bytes an assertion compares against.
fn tasks_bytes(tree: &TempTree) -> Vec<u8> {
    fs::read(tree.spec_dir("demo").join("tasks.md")).expect("tasks.md is readable")
}

#[test]
fn complete_rewrites_only_the_checkbox_of_a_pending_entry() {
    let original = "\
# Implementation Plan

- [ ] 1. Foundation
- [ ] 1.1 Write the parser — naïve café
  - _Requirements: 7.1, 7.2_
  - _Boundary: parser (src/tasks.rs)_
  - _Depends: 1_
- [x] 1.2 Done earlier
- [ ] 2. Wrap up   
";
    let expected = "\
# Implementation Plan

- [ ] 1. Foundation
- [x] 1.1 Write the parser — naïve café
  - _Requirements: 7.1, 7.2_
  - _Boundary: parser (src/tasks.rs)_
  - _Depends: 1_
- [x] 1.2 Done earlier
- [ ] 2. Wrap up   
";
    let tree = mutation_tree("mutations-complete-pending", original);
    let before_files = spec_files(&tree, "demo");
    let before_bytes = tasks_bytes(&tree);

    // The fixture starts with 1.1 as the next actionable entry.
    let initial = read_json(&tree, "next");
    assert_eq!(initial["task"]["id"].as_str(), Some("1.1"));

    let run = tree.run_spec("demo", &["complete", "1.1"]);
    assert_eq!(run.code(), 0, "a successful mutation exits zero");
    assert_eq!(
        run.stderr(),
        "",
        "a successful mutation writes no diagnostic"
    );
    assert_eq!(
        run.stdout(),
        "1.1 [completed]\n",
        "the result names the identifier and resulting state"
    );

    let after_bytes = tasks_bytes(&tree);
    assert_eq!(
        after_bytes,
        expected.as_bytes(),
        "description, identifier, optional marker, metadata bullets, indentation, \
         line endings, and trailing whitespace are preserved"
    );
    assert_only_state_byte_changed(
        &before_bytes,
        &after_bytes,
        state_offset(&before_bytes, "- [ ] 1.1 Write the parser"),
        b'x',
    );

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Foundation", "pending", false, None),
            (
                "1.1",
                "Write the parser — naïve café",
                "completed",
                false,
                None,
            ),
            ("1.2", "Done earlier", "completed", false, None),
            ("2", "Wrap up", "pending", false, None),
        ],
        Some(("2", "Wrap up", "pending", false, None)),
        (4, 2, 2, 0, 0),
    );
}

#[test]
fn complete_removes_the_blocked_reason_bullet_and_its_continuations() {
    let original = "\
- [ ] 1. Foundation
- [!]* 1.1 Wait for the review
  - _Blocked: waiting on approval
    and a second signature_
  - _Requirements: 7.3_
  - _Boundary: reviewer gate_
- [ ] 2. Wrap up
";
    let expected = "\
- [ ] 1. Foundation
- [x]* 1.1 Wait for the review
  - _Requirements: 7.3_
  - _Boundary: reviewer gate_
- [ ] 2. Wrap up
";
    let tree = mutation_tree("mutations-complete-blocked", original);
    let before_files = spec_files(&tree, "demo");
    let before_bytes = tasks_bytes(&tree);

    let run = tree.run_spec("demo", &["complete", "1.1"]);
    assert_eq!(run.code(), 0);
    assert_eq!(run.stderr(), "");
    assert_eq!(run.stdout(), "1.1 [completed]\n");

    let after_bytes = tasks_bytes(&tree);
    assert_eq!(
        after_bytes,
        expected.as_bytes(),
        "the reason bullet and its continuation lines are removed and \
         every other line is re-emitted unchanged"
    );
    assert!(
        !after_bytes
            .windows(b"_Blocked:".len())
            .any(|window| window == b"_Blocked:"),
        "no blocked reason bullet survives completion"
    );
    // Only the state character changed among the retained source lines.
    let offset = state_offset(&before_bytes, "- [!]* 1.1 Wait for the review");
    assert_eq!(after_bytes[offset], b'x');
    assert_eq!(&before_bytes[..offset], &after_bytes[..offset]);
    assert_eq!(
        &before_bytes[offset + 1..offset + 2],
        &after_bytes[offset + 1..offset + 2],
        "the optional marker after the checkbox is preserved"
    );

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Foundation", "pending", false, None),
            ("1.1", "Wait for the review", "completed", true, None),
            ("2", "Wrap up", "pending", false, None),
        ],
        Some(("2", "Wrap up", "pending", false, None)),
        (3, 1, 2, 0, 0),
    );
}

#[test]
fn complete_of_a_completed_entry_is_a_byte_identical_no_op() {
    let original = "\
- [x] 1. Already done
- [ ] 2. Next
";
    let tree = mutation_tree("mutations-complete-noop", original);
    let before_files = spec_files(&tree, "demo");
    let before_hash = tree.hash();

    let run = tree.run_spec("demo", &["complete", "1"]);
    assert_eq!(run.code(), 0, "a no-op mutation still exits zero");
    assert_eq!(run.stderr(), "");
    assert_eq!(
        run.stdout(),
        "1 [completed] (no change)\n",
        "a no-op reports the identifier, the resulting state, and that nothing changed"
    );
    assert_eq!(
        tree.hash(),
        before_hash,
        "an already completed entry leaves every byte of the tree unchanged"
    );
    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Already done", "completed", false, None),
            ("2", "Next", "pending", false, None),
        ],
        Some(("2", "Next", "pending", false, None)),
        (2, 1, 1, 0, 0),
    );
}

#[test]
fn block_inserts_one_reason_bullet_beneath_the_task_line() {
    let original = "\
- [ ] 1. Foundation
- [ ]* 1.1 Wait for review
  - _Requirements: 8.1_
- [ ] 2. Wrap up
";
    let expected = "\
- [ ] 1. Foundation
- [!]* 1.1 Wait for review
  - _Blocked: waiting on approval_
  - _Requirements: 8.1_
- [ ] 2. Wrap up
";
    let tree = mutation_tree("mutations-block-insert", original);
    let before_files = spec_files(&tree, "demo");

    let before_status = read_json(&tree, "status");
    assert_eq!(
        before_status["optional_pending"].as_u64(),
        Some(1),
        "the optional pending entry is counted before the mutation"
    );

    let run = tree.run_spec("demo", &["block", "1.1", "--reason", "waiting on approval"]);
    assert_eq!(run.code(), 0);
    assert_eq!(
        run.stderr(),
        "",
        "a successful mutation writes no diagnostic"
    );
    assert_eq!(run.stdout(), "1.1 [blocked]\n");

    let after_bytes = tasks_bytes(&tree);
    assert_eq!(
        after_bytes,
        expected.as_bytes(),
        "the blocked marker is rewritten and one canonical reason bullet is \
         inserted directly beneath the task line"
    );
    assert_eq!(
        after_bytes
            .windows(b"_Blocked:".len())
            .filter(|window| *window == b"_Blocked:")
            .count(),
        1,
        "exactly one reason bullet exists after blocking"
    );

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Foundation", "pending", false, None),
            (
                "1.1",
                "Wait for review",
                "blocked",
                true,
                Some("waiting on approval"),
            ),
            ("2", "Wrap up", "pending", false, None),
        ],
        Some((
            "1.1",
            "Wait for review",
            "blocked",
            true,
            Some("waiting on approval"),
        )),
        (3, 0, 2, 1, 0),
    );
}

#[test]
fn block_replaces_an_existing_reason_bullet_in_place() {
    let original = "\
- [ ] 1. Foundation
- [!] 1.1 Wait for review
  - _Requirements: 8.2_
  - _Blocked: old reason
    with an outdated signature_
  - _Boundary: reviewer gate_
- [ ] 2. Wrap up
";
    let expected = "\
- [ ] 1. Foundation
- [!] 1.1 Wait for review
  - _Requirements: 8.2_
  - _Blocked: new reason_
  - _Boundary: reviewer gate_
- [ ] 2. Wrap up
";
    let tree = mutation_tree("mutations-block-replace", original);
    let before_files = spec_files(&tree, "demo");

    let run = tree.run_spec("demo", &["block", "1.1", "--reason", "new reason"]);
    assert_eq!(run.code(), 0);
    assert_eq!(run.stderr(), "");
    assert_eq!(run.stdout(), "1.1 [blocked]\n");

    let after_bytes = tasks_bytes(&tree);
    assert_eq!(
        after_bytes,
        expected.as_bytes(),
        "the existing bullet is replaced in place, its continuation lines are \
         removed, and surrounding metadata keeps its identity and indentation"
    );
    assert_eq!(
        after_bytes
            .windows(b"_Blocked:".len())
            .filter(|window| *window == b"_Blocked:")
            .count(),
        1,
        "exactly one reason bullet survives replacement"
    );
    assert!(
        !after_bytes
            .windows(b"old reason".len())
            .any(|window| window == b"old reason"),
        "the replaced reason text is gone"
    );

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Foundation", "pending", false, None),
            (
                "1.1",
                "Wait for review",
                "blocked",
                false,
                Some("new reason"),
            ),
            ("2", "Wrap up", "pending", false, None),
        ],
        Some((
            "1.1",
            "Wait for review",
            "blocked",
            false,
            Some("new reason"),
        )),
        (3, 0, 2, 1, 0),
    );
}

#[test]
fn block_with_the_same_reason_is_a_byte_identical_no_op() {
    // The reason bullet is not in canonical position; a same-reason request is
    // still a no-op because the request already describes the document.
    let original = "\
- [!] 1. Wait for review
  - _Requirements: 8.4_
  - _Blocked: waiting on approval_
  - _Boundary: reviewer gate_
";
    let tree = mutation_tree("mutations-block-noop", original);
    let before_files = spec_files(&tree, "demo");
    let before_hash = tree.hash();

    let run = tree.run_spec("demo", &["block", "1", "--reason", "waiting on approval"]);
    assert_eq!(run.code(), 0, "a no-op mutation still exits zero");
    assert_eq!(run.stderr(), "");
    assert_eq!(
        run.stdout(),
        "1 [blocked] (no change)\n",
        "a no-op reports the identifier, the blocked state, and that nothing changed"
    );
    assert_eq!(
        tree.hash(),
        before_hash,
        "an identical reason leaves every byte of the tree unchanged"
    );
    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[(
            "1",
            "Wait for review",
            "blocked",
            false,
            Some("waiting on approval"),
        )],
        Some((
            "1",
            "Wait for review",
            "blocked",
            false,
            Some("waiting on approval"),
        )),
        (1, 0, 0, 1, 0),
    );
}

#[test]
fn block_refuses_a_completed_entry_without_writing() {
    let original = "\
- [x] 1. Already done
- [ ] 2. Next
";
    let tree = mutation_tree("mutations-block-completed", original);
    let before_files = spec_files(&tree, "demo");
    let before_hash = tree.hash();

    let run = tree.run_spec("demo", &["block", "1", "--reason", "waiting"]);
    assert_eq!(run.code(), 1, "an unsupported transition is a conflict");
    assert_eq!(
        run.stdout(),
        "",
        "a refused mutation publishes no result document"
    );
    assert!(
        run.stderr().starts_with("kiro-spec: "),
        "a refused mutation writes one diagnostic, got {:?}",
        run.stderr()
    );
    assert!(
        run.stderr().contains('1'),
        "the diagnostic names the identifier, got {:?}",
        run.stderr()
    );
    assert!(
        run.stderr().contains("unsupported transition"),
        "the diagnostic names the unsupported transition, got {:?}",
        run.stderr()
    );
    assert_eq!(
        tree.hash(),
        before_hash,
        "a refused transition leaves every byte of the tree unchanged"
    );
    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Already done", "completed", false, None),
            ("2", "Next", "pending", false, None),
        ],
        Some(("2", "Next", "pending", false, None)),
        (2, 1, 1, 0, 0),
    );
}

#[test]
fn unknown_and_duplicate_identifiers_are_refused_without_writing() {
    let unknown = mutation_tree("mutations-unknown-id", "- [ ] 1. Foundation\n");
    let unknown_files = spec_files(&unknown, "demo");
    let unknown_hash = unknown.hash();

    for args in [
        vec!["complete", "9"],
        vec!["block", "9", "--reason", "waiting"],
    ] {
        let run = unknown.run_spec("demo", &args);
        assert_eq!(
            run.code(),
            1,
            "{args:?}: an unknown identifier is a conflict"
        );
        assert_eq!(run.stdout(), "", "{args:?}: no result document");
        assert!(
            run.stderr().starts_with("kiro-spec: "),
            "{args:?}: one diagnostic, got {:?}",
            run.stderr()
        );
        assert!(
            run.stderr().contains('9'),
            "{args:?}: the diagnostic names the identifier, got {:?}",
            run.stderr()
        );
        assert!(
            run.stderr().contains("no task matches"),
            "{args:?}: the diagnostic explains the unknown identifier, got {:?}",
            run.stderr()
        );
    }
    assert_eq!(
        unknown.hash(),
        unknown_hash,
        "an unknown identifier writes nothing"
    );
    assert_only_tasks_md_changed(&unknown_files, &spec_files(&unknown, "demo"));

    let duplicate = mutation_tree(
        "mutations-duplicate-id",
        "\
- [ ] 1. First
- [ ] 1. Second
- [ ] 2. Next
",
    );
    let duplicate_files = spec_files(&duplicate, "demo");
    let duplicate_hash = duplicate.hash();

    for args in [
        vec!["complete", "1"],
        vec!["block", "1", "--reason", "waiting"],
    ] {
        let run = duplicate.run_spec("demo", &args);
        assert_eq!(
            run.code(),
            1,
            "{args:?}: an ambiguous identifier is a conflict"
        );
        assert_eq!(run.stdout(), "", "{args:?}: no result document");
        assert!(
            run.stderr().starts_with("kiro-spec: "),
            "{args:?}: one diagnostic, got {:?}",
            run.stderr()
        );
        assert!(
            run.stderr().contains("more than one entry"),
            "{args:?}: the diagnostic explains the ambiguity, got {:?}",
            run.stderr()
        );
    }
    assert_eq!(
        duplicate.hash(),
        duplicate_hash,
        "an ambiguous identifier writes nothing"
    );
    assert_only_tasks_md_changed(&duplicate_files, &spec_files(&duplicate, "demo"));

    // A malformed identifier is an argv usage problem, so it is rejected
    // before the spec is even read.
    let malformed = mutation_tree("mutations-malformed-id", "- [ ] 1. Foundation\n");
    let malformed_hash = malformed.hash();
    let run = malformed.run_spec("demo", &["complete", "1.2.3"]);
    assert_eq!(run.code(), 2, "a malformed identifier is a usage error");
    assert_eq!(run.stdout(), "");
    assert!(
        run.stderr().contains("task identifier"),
        "the diagnostic explains the identifier grammar, got {:?}",
        run.stderr()
    );
    assert_eq!(
        malformed.hash(),
        malformed_hash,
        "a usage error writes nothing"
    );
}

#[test]
fn crlf_line_endings_round_trip_through_block_and_complete() {
    let original = "\
# Implementation Plan\r
\r
- [ ] 1. Foundation\r
- [ ]* 1.1 Wait for review\r
  - _Requirements: 8.1_\r
- [ ] 2. Wrap up\r
";
    let blocked = "\
# Implementation Plan\r
\r
- [ ] 1. Foundation\r
- [!]* 1.1 Wait for review\r
  - _Blocked: blocked on CRLF_\r
  - _Requirements: 8.1_\r
- [ ] 2. Wrap up\r
";
    let completed = "\
# Implementation Plan\r
\r
- [ ] 1. Foundation\r
- [x]* 1.1 Wait for review\r
  - _Requirements: 8.1_\r
- [ ] 2. Wrap up\r
";
    let tree = mutation_tree("mutations-crlf", original);
    let before_files = spec_files(&tree, "demo");

    let run = tree.run_spec("demo", &["block", "1.1", "--reason", "blocked on CRLF"]);
    assert_eq!(run.code(), 0);
    assert_eq!(run.stderr(), "");
    assert_eq!(run.stdout(), "1.1 [blocked]\n");
    let after_block = tasks_bytes(&tree);
    assert_eq!(
        after_block,
        blocked.as_bytes(),
        "blocking preserves CRLF terminators, including the inserted bullet"
    );
    assert_crlf_only(&after_block);

    let run = tree.run_spec("demo", &["complete", "1.1"]);
    assert_eq!(run.code(), 0);
    assert_eq!(run.stderr(), "");
    assert_eq!(run.stdout(), "1.1 [completed]\n");
    let after_complete = tasks_bytes(&tree);
    assert_eq!(
        after_complete,
        completed.as_bytes(),
        "completing removes the CRLF reason bullet without normalising a line ending"
    );
    assert_crlf_only(&after_complete);

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Foundation", "pending", false, None),
            ("1.1", "Wait for review", "completed", true, None),
            ("2", "Wrap up", "pending", false, None),
        ],
        Some(("2", "Wrap up", "pending", false, None)),
        (3, 1, 2, 0, 0),
    );
}

/// Assert every `\n` in `bytes` is preceded by `\r`.
fn assert_crlf_only(bytes: &[u8]) {
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            assert!(
                index > 0 && bytes[index - 1] == b'\r',
                "a lone LF was written at byte {index}: {:?}",
                String::from_utf8_lossy(bytes)
            );
        }
    }
}

#[test]
fn a_missing_final_newline_is_never_added() {
    let tree = mutation_tree("mutations-no-final-newline", "- [ ] 1. Only task");
    let before_files = spec_files(&tree, "demo");

    let run = tree.run_spec("demo", &["complete", "1"]);
    assert_eq!(run.code(), 0);
    assert_eq!(run.stderr(), "");
    assert_eq!(run.stdout(), "1 [completed]\n");
    let after = tasks_bytes(&tree);
    assert_eq!(
        after, b"- [x] 1. Only task",
        "completion keeps the absent final terminator"
    );
    assert!(!after.ends_with(b"\n"), "no newline is appended");

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[("1", "Only task", "completed", false, None)],
        None,
        (1, 1, 0, 0, 0),
    );
}

#[test]
fn a_reason_bullet_on_an_unterminated_final_line_is_added_once() {
    let tree = mutation_tree("mutations-no-final-newline-block", "- [ ] 1. Only task");
    let before_files = spec_files(&tree, "demo");

    let run = tree.run_spec("demo", &["block", "1", "--reason", "held for review"]);
    assert_eq!(run.code(), 0);
    assert_eq!(run.stderr(), "");
    assert_eq!(run.stdout(), "1 [blocked]\n");
    let after = tasks_bytes(&tree);
    assert_eq!(
        after, b"- [!] 1. Only task\n  - _Blocked: held for review_",
        "the inserted bullet ends the file without inventing a final terminator"
    );
    assert!(
        !after.ends_with(b"\n"),
        "no newline is appended after the bullet"
    );

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[("1", "Only task", "blocked", false, Some("held for review"))],
        Some(("1", "Only task", "blocked", false, Some("held for review"))),
        (1, 0, 0, 1, 0),
    );
}

#[test]
fn a_failed_write_reports_an_error_and_leaves_tasks_md_intact() {
    let original = "\
- [ ] 1. Wait
- [ ] 2. More
";
    let tree = mutation_tree("mutations-readonly", original);
    let before_files = spec_files(&tree, "demo");

    let guard = match ReadOnlyDir::new(&tree.spec_dir("demo")) {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("skipping the no-write failure path: {error}");
            return;
        }
    };
    if !guard.blocks_writes() {
        eprintln!(
            "skipping the no-write failure path: this process can still write to a read-only \
             directory (running as root)"
        );
        return;
    }

    let run = tree.run_spec("demo", &["complete", "1"]);
    assert_eq!(run.code(), 1, "a failed write exits non-zero");
    assert_eq!(
        run.stdout(),
        "",
        "a failed mutation publishes no result document"
    );
    assert!(
        run.stderr().starts_with("kiro-spec: "),
        "a failed write writes one diagnostic, got {:?}",
        run.stderr()
    );
    assert!(
        run.stderr().contains("tasks.md"),
        "the diagnostic names the artifact, got {:?}",
        run.stderr()
    );
    assert_eq!(
        tasks_bytes(&tree),
        original.as_bytes(),
        "a failed write leaves tasks.md byte-identical"
    );

    drop(guard);

    assert_only_tasks_md_changed(&before_files, &spec_files(&tree, "demo"));

    assert_reads(
        &tree,
        &[
            ("1", "Wait", "pending", false, None),
            ("2", "More", "pending", false, None),
        ],
        Some(("1", "Wait", "pending", false, None)),
        (2, 0, 2, 0, 0),
    );
}
