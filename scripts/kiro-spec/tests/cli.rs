//! Read-command contract tests for the compiled `kiro-spec` binary.
//!
//! Every case runs the real executable through the shared temp-tree harness, so
//! the suite observes the same argv parsing, path resolution, stream
//! separation, exit status, and file-system effects an operator sees. Read
//! commands are expected to write nothing; every case hashes the tree before
//! and after the run to prove it.

mod support;

use std::fs;

use serde_json::Value;
use support::{Run, TempTree};

/// A complete, finding-free `spec.json` for the `demo` fixture spec.
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

/// Pending, completed, blocked, optional, grouping, and adjacent entries.
const TASKS: &str = "\
# Implementation Plan

- [ ] 1. Foundation
- [x] 1.1 Prepare the crate
  - _Requirements: 1.1_
- [!]* 1.2 Wait for review
  - _Blocked: waiting on approval_
  - _Requirements: 1.2_
- [ ] 2. Reporting
- [x] 2.1 Print the list
  - _Requirements: 2.1_
";

/// Requirements resolvable by every `_Requirements:_` token in [`TASKS`].
const REQUIREMENTS: &str = "\
# Requirements Document

## Requirements

### Requirement 1: Foundation

#### Acceptance Criteria

1. When the crate is prepared, it shall build.
2. When the review completes, it shall proceed.

### Requirement 2: Reporting

#### Acceptance Criteria

1. The reporter shall print the list.
";

/// The design artifact every generated spec must provide.
const DESIGN: &str = "\
# Design Document

## Overview

Read-command contract fixture.
";

/// The documented human `tasks` rendering for [`TASKS`].
const TASKS_HUMAN: &str = "\
1 Foundation [pending]
  1.1 Prepare the crate [completed]
  1.2 Wait for review [blocked] (optional) - blocked: waiting on approval
2 Reporting [pending]
  2.1 Print the list [completed]
";

/// The documented human `next` rendering for [`TASKS`].
const NEXT_HUMAN: &str =
    "  1.2 Wait for review [blocked] (optional) - blocked: waiting on approval\n";

/// The documented six-line human `status` rendering for [`TASKS`].
const STATUS_HUMAN: &str = "\
spec: demo
stage: tasks-generated
total: 5
completed: 2
pending: 2 (optional: 0)
blocked: 1
";

/// The complete set of artifacts for a clean `demo` spec.
fn read_tree(label: &str) -> TempTree {
    TempTree::with_spec(
        label,
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("tasks.md", TASKS),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    )
}

/// Assert the run failed as an operational diagnostic: exit `code`, no stdout,
/// one `kiro-spec:` line on stderr.
fn assert_diagnostic(run: &Run, code: i32, context: &str) {
    assert_eq!(run.code(), code, "{context}: exit status");
    assert_eq!(
        run.stdout(),
        "",
        "{context}: diagnostics never reach stdout"
    );
    assert!(
        run.stderr().starts_with("kiro-spec: "),
        "{context}: stderr must be a kiro-spec diagnostic, got {:?}",
        run.stderr()
    );
    assert!(
        run.stderr().ends_with('\n'),
        "{context}: the diagnostic must be one terminated line, got {:?}",
        run.stderr()
    );
}

/// Assert a successful result: exit zero, no stderr, non-empty stdout.
fn assert_result(run: &Run, context: &str) {
    assert_eq!(run.code(), 0, "{context}: exit status");
    assert_eq!(run.stderr(), "", "{context}: a result writes no diagnostic");
    assert!(
        !run.stdout().is_empty(),
        "{context}: a result reaches stdout"
    );
}

/// Parse exactly one JSON document from a successful run.
fn json_document(run: &Run) -> Value {
    assert_eq!(run.stderr(), "", "JSON results write no diagnostic");
    assert!(
        run.stdout().ends_with('\n'),
        "a JSON document ends with one newline: {:?}",
        run.stdout()
    );
    serde_json::from_str(run.stdout()).unwrap_or_else(|error| {
        panic!(
            "stdout must be exactly one JSON document: {error}\nstdout:\n{}\nstderr:\n{}",
            run.stdout(),
            run.stderr()
        )
    })
}

/// The `id` of every entry in a `tasks --json` document, in document order.
fn document_ids(document: &Value) -> Vec<&str> {
    document["tasks"]
        .as_array()
        .unwrap_or_else(|| panic!("tasks document has an entries array:\n{document}"))
        .iter()
        .map(|entry| entry["id"].as_str().expect("entry id"))
        .collect()
}

#[test]
fn help_lists_the_synopsis_every_subcommand_and_every_flag() {
    let tree = TempTree::new("cli-help");
    for flag in ["--help", "-h"] {
        let output = tree.run(&[flag]);
        assert_result(&output, flag);
        assert!(
            output.stdout().starts_with("Usage:\n"),
            "{flag} must print the synopsis first:\n{}",
            output.stdout()
        );
        for command in ["next", "tasks", "status", "validate", "complete", "block"] {
            assert!(
                output.stdout().contains(command),
                "{flag} must list subcommand {command}:\n{}",
                output.stdout()
            );
        }
        for option in [
            "--root",
            "--spec",
            "--json",
            "--reason",
            "-h",
            "--help",
            "-V",
            "--version",
        ] {
            assert!(
                output.stdout().contains(option),
                "{flag} must list option {option}:\n{}",
                output.stdout()
            );
        }
    }
}

#[test]
fn version_matches_the_cargo_package_version() {
    let tree = TempTree::new("cli-version");
    let expected = format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION"));
    for flag in ["--version", "-V"] {
        let output = tree.run(&[flag]);
        assert_result(&output, flag);
        assert_eq!(
            output.stdout(),
            expected,
            "{flag} must print the package version"
        );
    }
}

#[test]
fn rejected_argv_exits_two_with_a_diagnostic_and_touches_no_file() {
    let tree = read_tree("cli-usage");
    let root = tree.root_arg();
    let before = tree.hash();

    let accepted = tree.run(&["--root", &root, "--spec", "demo", "next"]);
    assert_result(&accepted, "a readable invocation");

    let cases: Vec<Vec<&str>> = vec![
        // Unknown command or option.
        vec!["--root", &root, "--spec", "demo", "frobnicate"],
        vec!["--root", &root, "--spec", "demo", "next", "--bogus"],
        vec!["--root", &root, "--spec", "demo", "--bogus", "next"],
        vec!["--root", &root, "--spec", "demo", "next", "--json=yes"],
        vec!["--root", &root, "--spec", "demo", "next", "-x"],
        vec!["--spec", "demo", "next", "-1"],
        // Missing `--spec`, a missing value, and a missing subcommand.
        vec!["--root", &root, "next"],
        vec!["--root", &root, "--spec"],
        vec!["--root", &root, "--spec="],
        vec!["--root"],
        vec!["--root", &root],
        vec!["--root", &root, "--spec", "demo"],
        vec!["--spec", "demo", "next", "extra"],
        // `--json` and `--reason` are rejected on the wrong commands.
        vec!["--root", &root, "--spec", "demo", "--json", "complete", "1"],
        vec![
            "--root", &root, "--spec", "demo", "--json", "block", "1", "--reason", "x",
        ],
        vec!["--root", &root, "--spec", "demo", "next", "--reason", "x"],
        // Mutation argument problems are usage errors before any read.
        vec!["--root", &root, "--spec", "demo", "complete"],
        vec!["--root", &root, "--spec", "demo", "block", "1"],
        vec!["--root", &root, "--spec", "demo", "complete", "not-an-id"],
        vec!["--root", &root, "--spec", "demo", "complete", "1.2.3"],
        vec!["--root", &root, "--spec", "demo", "complete", "01"],
        vec!["--root", &root, "--spec", "demo", "complete", ""],
        vec![
            "--root", &root, "--spec", "demo", "block", "1..2", "--reason", "x",
        ],
        vec![
            "--root", &root, "--spec", "demo", "complete", "1", "--reason", "x",
        ],
        vec![
            "--root", &root, "--spec", "demo", "block", "1", "--reason", "",
        ],
        vec![
            "--root", &root, "--spec", "demo", "block", "1", "--reason", "   ",
        ],
        vec!["--root", &root, "--spec", "demo", "complete", "1", "extra"],
    ];

    for args in cases {
        let output = tree.run(&args);
        assert_diagnostic(&output, 2, &format!("argv {args:?} must be a usage error"));
        assert!(
            output.stderr().starts_with("kiro-spec: usage: "),
            "argv {args:?} must name the usage context, got {:?}",
            output.stderr()
        );
    }

    assert_eq!(
        tree.hash(),
        before,
        "rejected argv must leave the spec tree byte-identical"
    );
}

#[test]
fn malformed_task_identifiers_are_usage_errors_before_resolution() {
    let tree = TempTree::new("cli-ids");
    let before = tree.hash();
    for id in [
        "not-an-id",
        "1.2.3",
        "01",
        "1..2",
        ".1",
        "",
        " 1",
        "1 ",
        "١",
    ] {
        for command in ["complete", "block"] {
            let mut args = vec!["--spec", "demo", command, id];
            if command == "block" {
                args.extend(["--reason", "waiting"]);
            }
            let output = tree.run(&args);
            assert_diagnostic(&output, 2, &format!("{command} {id:?}"));
            assert!(
                output.stderr().contains("task identifier"),
                "{command} {id:?} must explain the identifier grammar, got {:?}",
                output.stderr()
            );
        }
    }
    assert_eq!(
        tree.hash(),
        before,
        "an unreadable spec is never resolved for a usage error"
    );
}

#[test]
fn default_root_is_the_current_directory_and_is_never_searched_from_parents() {
    let tree = read_tree("cli-default-root");

    let default = tree.run_in(tree.root(), &["--spec", "demo", "tasks"]);
    assert_result(&default, "default root");
    assert_eq!(default.stdout(), TASKS_HUMAN);

    let explicit = tree.run_in(tree.root(), &["--root", ".", "--spec", "demo", "tasks"]);
    assert_result(&explicit, "explicit dot root");
    assert_eq!(
        explicit.stdout(),
        default.stdout(),
        "`.` is the default root"
    );

    let nested = tree.root().join("nested");
    fs::create_dir_all(&nested).expect("nested working directory is created");
    let from_nested = tree.run_in(&nested, &["--spec", "demo", "tasks"]);
    assert_diagnostic(
        &from_nested,
        1,
        "no parent-directory search for the default root",
    );
    assert!(
        from_nested.stderr().contains(".kiro/specs/demo"),
        "the diagnostic names the path relative to the working directory, got {:?}",
        from_nested.stderr()
    );
}

#[test]
fn root_override_takes_precedence_over_the_current_directory() {
    let current = TempTree::with_spec(
        "cli-root-current",
        "current",
        &[("tasks.md", "- [ ] 1. Current task\n")],
    );
    let target = TempTree::with_spec(
        "cli-root-target",
        "target",
        &[("tasks.md", "- [ ] 1. Target task\n")],
    );
    let target_root = target.root_arg();

    let default = current.run_in(current.root(), &["--spec", "current", "tasks", "--json"]);
    assert_result(&default, "default root result");
    let default = json_document(&default);
    assert_eq!(default["spec"].as_str(), Some("current"));

    let overridden = current.run_in(
        current.root(),
        &[
            "--root",
            &target_root,
            "--spec",
            "target",
            "tasks",
            "--json",
        ],
    );
    assert_result(&overridden, "root override result");
    let overridden = json_document(&overridden);
    assert_eq!(
        overridden["spec"].as_str(),
        Some("target"),
        "`--root` selects the supplied tree instead of the working directory"
    );
    assert_eq!(
        overridden["tasks"][0]["description"].as_str(),
        Some("Target task"),
        "the overridden root supplies the entries"
    );

    let unreachable = current.run_in(current.root(), &["--spec", "target", "tasks"]);
    assert_diagnostic(
        &unreachable,
        1,
        "the target spec is only reachable through the override",
    );
    assert!(unreachable.stderr().contains(".kiro/specs/target"));
}

#[test]
fn rejected_spec_names_exit_one_with_the_offending_value_and_no_write() {
    let tree = read_tree("cli-spec-names");
    let root = tree.root_arg();
    let before = tree.hash();

    for name in [
        ".",
        "..",
        "a/b",
        "./demo",
        "demo/..",
        "/absolute",
        "../demo",
    ] {
        let output = tree.run(&["--root", &root, "--spec", name, "tasks"]);
        assert_diagnostic(&output, 1, &format!("rejected spec name {name:?}"));
        assert!(
            output.stderr().contains("invalid name"),
            "{name:?} must be refused as an invalid name, got {:?}",
            output.stderr()
        );
        assert!(
            output.stderr().contains(name),
            "{name:?} must be named in the diagnostic, got {:?}",
            output.stderr()
        );
    }

    // An empty name is an argv usage problem, rejected before resolution.
    for args in [
        vec!["--root", &root, "--spec", "", "tasks"],
        vec!["--root", &root, "--spec=", "tasks"],
    ] {
        let output = tree.run(&args);
        assert_diagnostic(&output, 2, &format!("empty spec name {args:?}"));
    }

    assert_eq!(
        tree.hash(),
        before,
        "rejected spec names must leave the tree byte-identical"
    );
}

#[test]
fn missing_spec_directory_exits_one_naming_the_resolved_path() {
    let tree = read_tree("cli-missing-spec");
    let before = tree.hash();

    for command in ["tasks", "next", "status", "validate"] {
        for args in [vec![command], vec![command, "--json"]] {
            let output = tree.run_spec("absent", &args);
            assert_diagnostic(&output, 1, &format!("missing spec directory for {args:?}"));
            assert!(
                output.stderr().contains(".kiro/specs/absent"),
                "{args:?} must name the resolved path, got {:?}",
                output.stderr()
            );
        }
    }

    // A file where the spec directory should be is a resolution failure too.
    let not_a_directory = tree.root().join(".kiro/specs/not-a-directory");
    fs::write(&not_a_directory, "not a spec directory\n")
        .expect("the non-directory spec path is written");
    let output = tree.run_spec("not-a-directory", &["tasks"]);
    assert_diagnostic(&output, 1, "spec path is not a directory");
    assert!(
        output.stderr().contains("not a directory"),
        "the diagnostic explains the path kind, got {:?}",
        output.stderr()
    );

    let _ = fs::remove_file(&not_a_directory);
    assert_eq!(
        tree.hash(),
        before,
        "missing spec directories are never created or repaired"
    );
}

#[test]
fn missing_artifact_diagnostics_name_the_path_and_leave_the_tree_unchanged() {
    // No tasks.md: every read command fails, but validate still reports a
    // complete finding document rather than an operational diagnostic.
    let missing_tasks = TempTree::with_spec(
        "cli-missing-tasks",
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    );
    let before = missing_tasks.hash();
    let tasks_path = missing_tasks.spec_dir("demo").join("tasks.md");
    let tasks_path = tasks_path.display().to_string();

    for command in ["tasks", "next", "status"] {
        for args in [vec![command], vec![command, "--json"]] {
            let output = missing_tasks.run_spec("demo", &args);
            assert_diagnostic(&output, 1, &format!("missing tasks.md for {args:?}"));
            assert!(
                output.stderr().contains(&tasks_path),
                "{args:?} must name the missing artifact path, got {:?}",
                output.stderr()
            );
        }
    }

    for args in [vec!["validate"], vec!["validate", "--json"]] {
        let output = missing_tasks.run_spec("demo", &args);
        assert_eq!(
            output.code(),
            1,
            "a missing generated artifact is an error finding"
        );
        assert_eq!(
            output.stderr(),
            "",
            "validation findings are result data, not diagnostics"
        );
        assert!(
            !output.stdout().is_empty(),
            "validate still writes a complete result document"
        );
    }
    assert_eq!(
        missing_tasks.hash(),
        before,
        "a missing artifact is never created"
    );

    // No spec.json: `tasks` and `next` do not need it, `status` does.
    let missing_spec = TempTree::with_spec(
        "cli-missing-spec-json",
        "demo",
        &[
            ("tasks.md", TASKS),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    );
    let before = missing_spec.hash();
    let spec_json_path = missing_spec.spec_dir("demo").join("spec.json");
    let spec_json_path = spec_json_path.display().to_string();

    for command in ["tasks", "next"] {
        let output = missing_spec.run_spec("demo", &[command]);
        assert_result(&output, &format!("{command} does not require spec.json"));
    }

    for args in [vec!["status"], vec!["status", "--json"]] {
        let output = missing_spec.run_spec("demo", &args);
        assert_diagnostic(&output, 1, &format!("missing spec.json for {args:?}"));
        assert!(
            output.stderr().contains(&spec_json_path),
            "{args:?} must name the missing artifact path, got {:?}",
            output.stderr()
        );
    }

    let validate = missing_spec.run_spec("demo", &["validate", "--json"]);
    assert_eq!(validate.code(), 1, "missing spec.json is an error finding");
    assert_eq!(validate.stderr(), "");
    let document = json_document(&validate);
    assert_eq!(document["valid"].as_bool(), Some(false));
    assert!(
        document["findings"]
            .as_array()
            .is_some_and(|findings| !findings.is_empty()),
        "validate reports the missing artifact as a finding:\n{document}"
    );
    assert_eq!(
        missing_spec.hash(),
        before,
        "a missing spec.json is never created"
    );
}

#[test]
fn unreadable_and_unparseable_artifacts_are_read_diagnostics() {
    let tree = TempTree::with_spec(
        "cli-unreadable",
        "demo",
        &[
            ("spec.json", "{ not json\n"),
            ("tasks.md", TASKS),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    );
    let before = tree.hash();
    let spec_json_path = tree.spec_dir("demo").join("spec.json");
    let spec_json_path = spec_json_path.display().to_string();

    for args in [vec!["status"], vec!["status", "--json"]] {
        let output = tree.run_spec("demo", &args);
        assert_diagnostic(&output, 1, &format!("unparseable spec.json for {args:?}"));
        assert!(
            output.stderr().contains(&spec_json_path),
            "{args:?} must name the unparseable file, got {:?}",
            output.stderr()
        );
    }
    assert_result(
        &tree.run_spec("demo", &["tasks"]),
        "tasks does not read spec.json",
    );

    let invalid_utf8 = TempTree::with_spec(
        "cli-invalid-utf8",
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    );
    invalid_utf8.write_bytes(".kiro/specs/demo/tasks.md", &[0xff, 0xfe, 0x00]);
    let before_bytes = invalid_utf8.hash();
    let tasks_path = invalid_utf8.spec_dir("demo").join("tasks.md");
    let tasks_path = tasks_path.display().to_string();

    for command in ["tasks", "next"] {
        let output = invalid_utf8.run_spec("demo", &[command]);
        assert_diagnostic(&output, 1, &format!("non-UTF-8 tasks.md for {command}"));
        assert!(
            output.stderr().contains(&tasks_path),
            "{command} must name the undecodable file, got {:?}",
            output.stderr()
        );
    }

    let validate = invalid_utf8.run_spec("demo", &["validate", "--json"]);
    assert_eq!(
        validate.code(),
        1,
        "an undecodable tasks.md is an error finding"
    );
    assert_eq!(validate.stderr(), "");
    let document = json_document(&validate);
    assert_eq!(document["valid"].as_bool(), Some(false));

    assert_eq!(
        tree.hash(),
        before,
        "unparseable artifacts are never rewritten"
    );
    assert_eq!(
        invalid_utf8.hash(),
        before_bytes,
        "undecodable artifacts are never rewritten"
    );
}

#[test]
fn read_commands_emit_exact_human_text_and_one_json_document() {
    let tree = read_tree("cli-output");

    let tasks = tree.run_spec("demo", &["tasks"]);
    assert_result(&tasks, "tasks human");
    assert_eq!(tasks.stdout(), TASKS_HUMAN, "documented tasks rendering");

    let tasks_json = json_document(&tree.run_spec("demo", &["tasks", "--json"]));
    assert_eq!(tasks_json["schema_version"].as_u64(), Some(1));
    assert_eq!(tasks_json["spec"].as_str(), Some("demo"));
    assert_eq!(
        document_ids(&tasks_json),
        vec!["1", "1.1", "1.2", "2", "2.1"],
        "tasks lists every entry in document order"
    );
    assert_eq!(tasks_json["tasks"][0]["state"].as_str(), Some("pending"));
    assert_eq!(tasks_json["tasks"][1]["state"].as_str(), Some("completed"));
    assert_eq!(tasks_json["tasks"][2]["state"].as_str(), Some("blocked"));
    assert_eq!(
        tasks_json["tasks"][2]["optional"].as_bool(),
        Some(true),
        "the optional marker is preserved"
    );
    assert_eq!(
        tasks_json["tasks"][2]["blocked_reason"].as_str(),
        Some("waiting on approval")
    );

    let next = tree.run_spec("demo", &["next"]);
    assert_result(&next, "next human");
    assert_eq!(next.stdout(), NEXT_HUMAN, "documented next rendering");

    let next_json = json_document(&tree.run_spec("demo", &["next", "--json"]));
    assert_eq!(next_json["schema_version"].as_u64(), Some(1));
    assert_eq!(next_json["spec"].as_str(), Some("demo"));
    assert_eq!(next_json["task"]["id"].as_str(), Some("1.2"));
    assert_eq!(next_json["task"]["state"].as_str(), Some("blocked"));
    assert_eq!(next_json["task"]["optional"].as_bool(), Some(true));
    assert_eq!(
        next_json["task"]["blocked_reason"].as_str(),
        Some("waiting on approval")
    );

    let status = tree.run_spec("demo", &["status"]);
    assert_result(&status, "status human");
    assert_eq!(status.stdout(), STATUS_HUMAN, "documented status rendering");

    let status_json = json_document(&tree.run_spec("demo", &["status", "--json"]));
    assert_eq!(status_json["schema_version"].as_u64(), Some(1));
    assert_eq!(status_json["spec"].as_str(), Some("demo"));
    assert_eq!(status_json["stage"].as_str(), Some("tasks-generated"));
    assert_eq!(status_json["total"].as_u64(), Some(5));
    assert_eq!(status_json["counts"]["completed"].as_u64(), Some(2));
    assert_eq!(status_json["counts"]["pending"].as_u64(), Some(2));
    assert_eq!(status_json["counts"]["blocked"].as_u64(), Some(1));
    assert_eq!(status_json["optional_pending"].as_u64(), Some(0));

    let validate = tree.run_spec("demo", &["validate"]);
    assert_result(&validate, "validate human");
    assert_eq!(
        validate.stdout(),
        "0 errors, 0 warnings\n",
        "a clean spec has the documented summary"
    );

    let validate_json = json_document(&tree.run_spec("demo", &["validate", "--json"]));
    assert_eq!(validate_json["schema_version"].as_u64(), Some(1));
    assert_eq!(validate_json["spec"].as_str(), Some("demo"));
    assert_eq!(validate_json["valid"].as_bool(), Some(true));
    assert_eq!(
        validate_json["findings"].as_array().map(Vec::len),
        Some(0),
        "a clean spec reports no findings"
    );
}

#[test]
fn read_commands_exit_identically_in_both_formats_and_leave_the_tree_unchanged() {
    let tree = read_tree("cli-read-only");
    let before = tree.hash();

    for command in ["tasks", "next", "status", "validate"] {
        let human = tree.run_spec("demo", &[command]);
        assert_result(&human, &format!("{command} human"));

        let json = tree.run_spec("demo", &[command, "--json"]);
        assert_result(&json, &format!("{command} JSON"));

        assert_eq!(
            human.code(),
            json.code(),
            "{command} exits identically with and without --json"
        );
        json_document(&json);

        assert_eq!(tree.hash(), before, "{command} must not write to any file");
    }
}

#[test]
fn validate_exit_status_follows_error_severity_in_both_formats() {
    let clean = read_tree("cli-validate-clean");
    let clean_before = clean.hash();

    let warning_tasks = "\
- [ ] 1. Foundation
- [ ] 1.1 Ready
- [ ] Unnumbered note
";
    let warnings = TempTree::with_spec(
        "cli-validate-warning",
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("tasks.md", warning_tasks),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    );
    let warnings_before = warnings.hash();

    let error_tasks = "\
- [ ] 1. Foundation
- [ ] 1. Duplicate foundation
";
    let errors = TempTree::with_spec(
        "cli-validate-error",
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("tasks.md", error_tasks),
            ("requirements.md", REQUIREMENTS),
            ("design.md", DESIGN),
        ],
    );
    let errors_before = errors.hash();

    // No findings: exit 0 in both formats.
    let clean_human = clean.run_spec("demo", &["validate"]);
    assert_eq!(clean_human.code(), 0, "validate human on a clean spec");
    assert_eq!(clean_human.stderr(), "");
    assert_eq!(clean_human.stdout(), "0 errors, 0 warnings\n");

    let clean_json_run = clean.run_spec("demo", &["validate", "--json"]);
    assert_eq!(clean_json_run.code(), 0, "validate JSON on a clean spec");
    assert_eq!(clean_json_run.stderr(), "");

    let clean_json = json_document(&clean_json_run);
    assert_eq!(clean_json["valid"].as_bool(), Some(true));

    // Warnings only: exit 0 in both formats, findings remain result data.
    let warning_human = warnings.run_spec("demo", &["validate"]);
    assert_eq!(warning_human.code(), 0, "warnings do not fail validation");
    assert_eq!(warning_human.stderr(), "");
    assert!(
        warning_human
            .stdout()
            .starts_with("tasks.md:3: warning [tasks.line.unnumbered] "),
        "the warning uses the documented line form:\n{}",
        warning_human.stdout()
    );
    assert!(
        warning_human.stdout().ends_with("0 errors, 1 warning\n"),
        "singular warning summary:\n{}",
        warning_human.stdout()
    );

    let warning_json_run = warnings.run_spec("demo", &["validate", "--json"]);
    assert_eq!(
        warning_json_run.code(),
        warning_human.code(),
        "validate exit status is independent of --json"
    );
    assert_eq!(warning_json_run.stderr(), "");

    let warning_json = json_document(&warning_json_run);
    assert_eq!(warning_json["valid"].as_bool(), Some(true));
    let findings = warning_json["findings"]
        .as_array()
        .expect("warning findings array");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["severity"].as_str(), Some("warning"));
    assert_eq!(findings[0]["code"].as_str(), Some("tasks.line.unnumbered"));
    assert_eq!(findings[0]["file"].as_str(), Some("tasks.md"));
    assert_eq!(findings[0]["line"].as_u64(), Some(3));

    // Errors: exit 1 in both formats, with a complete result document.
    let error_human = errors.run_spec("demo", &["validate"]);
    assert_eq!(error_human.code(), 1, "an error finding fails validation");
    assert_eq!(error_human.stderr(), "");
    assert!(
        error_human
            .stdout()
            .starts_with("tasks.md:2: error [tasks.id.duplicate] "),
        "the error uses the documented line form:\n{}",
        error_human.stdout()
    );
    assert!(
        error_human.stdout().ends_with("1 error, 0 warnings\n"),
        "singular error summary:\n{}",
        error_human.stdout()
    );

    let error_json_run = errors.run_spec("demo", &["validate", "--json"]);
    assert_eq!(error_json_run.code(), 1);
    assert_eq!(error_json_run.stderr(), "");
    let error_json = json_document(&error_json_run);
    assert_eq!(error_json["valid"].as_bool(), Some(false));
    let findings = error_json["findings"]
        .as_array()
        .expect("error findings array");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["severity"].as_str(), Some("error"));
    assert_eq!(findings[0]["code"].as_str(), Some("tasks.id.duplicate"));
    assert_eq!(findings[0]["line"].as_u64(), Some(2));

    assert_eq!(
        clean_human.code(),
        clean_json_run.code(),
        "validate exit status is independent of --json on a clean spec"
    );
    assert_eq!(
        error_human.code(),
        error_json_run.code(),
        "validate exit status is independent of --json on an error report"
    );

    assert_eq!(clean.hash(), clean_before, "validate never writes");
    assert_eq!(warnings.hash(), warnings_before, "validate never writes");
    assert_eq!(errors.hash(), errors_before, "validate never writes");
}
