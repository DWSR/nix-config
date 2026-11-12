mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use support::{copy_tree, read_only, tree_hash, SpecTree, TempDir};

const SPEC_JSON: &str = "{\n  \"feature_name\": \"demo\",\n  \"phase\": \"tasks-generated\"\n}\n";
const TASKS: &str = "# Implementation Plan\n\n- [ ] 1. First task\n- [ ] 2. Second task\n";
const REQUIREMENTS: &str = "# Requirements\n\n### Requirement 1: Demo\n\n#### Acceptance Criteria\n\n1. The demo shall exist.\n";
const DESIGN: &str = "# Design\n";

fn repository_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn declarative_spec_tree_round_trips_and_reports_streams() {
    let tree = SpecTree::new("demo", "roundtrip");
    tree.write("spec.json", SPEC_JSON)
        .write("tasks.md", TASKS)
        .write("requirements.md", REQUIREMENTS)
        .write("design.md", DESIGN);
    assert!(tree.root().starts_with(std::env::temp_dir()));
    let before = tree.tree_hash();

    let help = tree.run(&["--help"]).assert_success();
    assert!(help.stdout_text().contains("Subcommands:"));
    assert!(help.stderr().is_empty());

    let tasks = tree.run(&["tasks"]).assert_success();
    assert_eq!(
        tasks.stdout_text(),
        "1 First task [pending]\n2 Second task [pending]\n"
    );
    assert_eq!(tasks.code(), Some(0));
    assert!(tasks.stderr().is_empty());
    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn harness_uses_compiled_binary_and_explicit_root_not_cwd() {
    let binary = Path::new(env!("CARGO_BIN_EXE_kiro-spec"));
    assert!(binary.is_file(), "missing binary: {}", binary.display());

    let tree = SpecTree::new("demo", "explicit-root");
    tree.write("tasks.md", TASKS);
    let elsewhere = TempDir::new("cwd-elsewhere");

    let tasks = tree.run_in(elsewhere.path(), &["tasks"]).assert_success();
    assert_eq!(
        tasks.stdout_text(),
        "1 First task [pending]\n2 Second task [pending]\n"
    );
    assert!(!tree.root().starts_with(repository_root()));
    assert!(!elsewhere.path().starts_with(repository_root()));
    assert!(elsewhere.path().starts_with(std::env::temp_dir()));
    assert!(!elsewhere.path().join(".kiro").exists());
}

#[test]
fn copy_tree_preserves_nested_bytes_and_leaves_the_source_unchanged() {
    let source = SpecTree::new("demo", "copy-source");
    source
        .write("spec.json", SPEC_JSON)
        .write("tasks.md", TASKS);
    source.write_at("extras/nested/blob.bin", [0u8, 1, 2, 0xFF]);
    let source_hash = source.tree_hash();

    let destination = TempDir::new("copy-destination");
    let target = destination.path().join("copied");
    copy_tree(source.root(), &target).expect("copy fixture tree");

    assert_eq!(
        fs::read(target.join(".kiro/specs/demo/tasks.md")).expect("copied tasks.md"),
        TASKS.as_bytes()
    );
    assert_eq!(
        fs::read(target.join("extras/nested/blob.bin")).expect("copied blob"),
        [0u8, 1, 2, 0xFF]
    );
    assert_eq!(tree_hash(&target), source_hash);
    assert_eq!(source.tree_hash(), source_hash);
}

#[test]
fn tree_hash_is_stable_detects_changes_and_honours_exclusions() {
    let tree = SpecTree::new("demo", "hash");
    tree.write("spec.json", SPEC_JSON).write("tasks.md", TASKS);

    let first = tree.tree_hash();
    assert_eq!(first, tree.tree_hash());

    let without_tasks = tree.tree_hash_excluding(&["tasks.md"]);
    tree.write("tasks.md", "# Changed\n");
    assert_ne!(tree.tree_hash(), first);
    assert_eq!(tree.tree_hash_excluding(&["tasks.md"]), without_tasks);

    tree.write("spec.json", "{}\n");
    assert_ne!(tree.tree_hash_excluding(&["tasks.md"]), without_tasks);
}

#[test]
fn read_only_guard_blocks_writes_and_restores_permissions() {
    let tree = SpecTree::new("demo", "read-only");
    tree.write("tasks.md", TASKS);

    let guard = read_only(tree.spec_dir());
    if !guard.is_supported() {
        eprintln!("skipping read-only assertion: platform does not expose unix modes");
        return;
    }
    if guard.can_still_write() {
        eprintln!("skipping read-only assertion: process can still write this directory");
        return;
    }

    let probe = tree.spec_dir().join("probe.txt");
    let error = fs::write(&probe, b"blocked").expect_err("write to read-only directory");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

    drop(guard);
    fs::write(&probe, b"allowed").expect("write succeeds after permissions are restored");
    assert_eq!(fs::read(&probe).expect("read probe"), b"allowed");
}

#[test]
fn only_declared_artifacts_exist_in_the_temp_tree() {
    let tree = SpecTree::new("demo", "declared");
    assert!(!tree.spec_dir().join("tasks.md").exists());
    assert!(!tree.spec_dir().join("spec.json").exists());

    tree.write("spec.json", SPEC_JSON);
    assert!(tree.spec_dir().join("spec.json").exists());
    assert!(!tree.spec_dir().join("tasks.md").exists());

    let missing = tree.run(&["tasks"]).assert_exit(1);
    assert!(missing.stdout().is_empty());
    assert!(!missing.stderr().is_empty());
}

#[test]
fn harness_paths_live_outside_the_repository() {
    let tree = SpecTree::new("demo", "outside-repo");
    let scratch = TempDir::new("outside-repo");

    assert!(tree.root().starts_with(std::env::temp_dir()));
    assert!(scratch.path().starts_with(std::env::temp_dir()));
    assert!(!tree.root().starts_with(repository_root()));
    assert!(!scratch.path().starts_with(repository_root()));
    assert!(!tree.spec_dir().starts_with(repository_root()));
}

fn fixture_directory(relative: &str) -> PathBuf {
    repository_root()
        .join("tests")
        .join("fixtures")
        .join(relative)
}

fn copy_fixture(spec_name: &str, relative: &str, tag: &str) -> (SpecTree, u64) {
    let source = fixture_directory(relative);
    let source_hash = tree_hash(&source);
    let tree = SpecTree::new(spec_name, tag);
    copy_tree(&source, tree.root()).unwrap_or_else(|error| {
        panic!(
            "cannot copy fixture {} into {}: {error}",
            source.display(),
            tree.root().display()
        )
    });
    assert_eq!(
        tree.tree_hash(),
        source_hash,
        "copied fixture {relative} does not match its source"
    );
    (tree, source_hash)
}

fn finding_codes(document: &Value) -> Vec<&str> {
    let mut codes: Vec<&str> = document["findings"]
        .as_array()
        .unwrap_or_else(|| panic!("findings array missing: {document}"))
        .iter()
        .map(|finding| {
            finding["code"]
                .as_str()
                .unwrap_or_else(|| panic!("finding code missing: {finding}"))
        })
        .collect();
    codes.sort_unstable();
    codes
}

fn find_task<'a>(document: &'a Value, id: &str) -> &'a Value {
    document["tasks"]
        .as_array()
        .expect("tasks array")
        .iter()
        .find(|entry| entry["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("task {id} is missing"))
}

const BASIC_TASKS_OUTPUT: &str = "\
1 Foundation [pending]
  1.1 First child [pending]
  1.2 Optional child [pending] (optional)
2 Completed task [completed]
3 Blocked task [blocked] - blocked: Waiting on credentials
4 Legacy prose entry [pending]
5 Adjacent first [pending]
6 Adjacent second [pending] (optional)
7 Completed optional [completed] (optional)
";

const BASIC_STATUS_OUTPUT: &str = "\
spec: basic
stage: initialized
total: 9
completed: 2
pending: 6 (optional: 2)
blocked: 1
";

#[test]
fn basic_fixture_exercises_all_parse_states_through_the_cli() {
    let (tree, source_hash) = copy_fixture("basic", "basic", "fixture-basic");

    let tasks = tree.run(&["tasks"]).assert_success();
    assert_eq!(tasks.stdout_text(), BASIC_TASKS_OUTPUT);

    let document = tree.run(&["--json", "tasks"]).assert_success().json();
    assert_eq!(find_task(&document, "1")["state"].as_str(), Some("pending"));
    let optional_pending = find_task(&document, "1.2");
    assert_eq!(optional_pending["state"].as_str(), Some("pending"));
    assert_eq!(optional_pending["optional"].as_bool(), Some(true));
    let blocked = find_task(&document, "3");
    assert_eq!(blocked["state"].as_str(), Some("blocked"));
    assert_eq!(
        blocked["blocked_reason"].as_str(),
        Some("Waiting on credentials")
    );
    let legacy = find_task(&document, "4");
    assert_eq!(legacy["state"].as_str(), Some("pending"));
    assert!(legacy["blocked_reason"].is_null());
    let completed_optional = find_task(&document, "7");
    assert_eq!(completed_optional["state"].as_str(), Some("completed"));
    assert_eq!(completed_optional["optional"].as_bool(), Some(true));

    let next = tree.run(&["next"]).assert_success();
    assert_eq!(next.stdout_text(), "  1.1 First child [pending]\n");

    let status = tree.run(&["status"]).assert_success();
    assert_eq!(status.stdout_text(), BASIC_STATUS_OUTPUT);

    let report = tree.run(&["--json", "validate"]).assert_success().json();
    assert_eq!(report["valid"].as_bool(), Some(true));
    assert!(finding_codes(&report).is_empty());
    assert_eq!(
        tree.run(&["validate"]).assert_success().stdout_text(),
        "0 errors, 0 warnings\n"
    );

    assert_eq!(tree_hash(&fixture_directory("basic")), source_hash);
}

struct MalformedCase {
    name: &'static str,
    codes: &'static [&'static str],
    lines: &'static [usize],
    exit: i32,
}

const MALFORMED_CASES: [MalformedCase; 6] = [
    MalformedCase {
        name: "depth",
        codes: &["tasks.id.depth"],
        lines: &[3],
        exit: 1,
    },
    MalformedCase {
        name: "non-numeric",
        codes: &["tasks.id.non-numeric"],
        lines: &[3],
        exit: 1,
    },
    MalformedCase {
        name: "duplicate",
        codes: &["tasks.id.duplicate", "tasks.id.duplicate"],
        lines: &[4, 5],
        exit: 1,
    },
    MalformedCase {
        name: "malformed",
        codes: &["tasks.line.malformed"],
        lines: &[3],
        exit: 1,
    },
    MalformedCase {
        name: "unnumbered",
        codes: &["tasks.line.unnumbered"],
        lines: &[3],
        exit: 0,
    },
    MalformedCase {
        name: "fifty-entries",
        codes: &["tasks.limit.exceeded"],
        lines: &[52],
        exit: 1,
    },
];

#[test]
fn malformed_fixtures_report_exactly_their_intended_finding_codes() {
    for case in MALFORMED_CASES {
        let relative = format!("malformed/{}", case.name);
        let (tree, source_hash) = copy_fixture(
            case.name,
            &relative,
            &format!("fixture-malformed-{}", case.name),
        );
        let output = tree.run(&["--json", "validate"]);
        assert_eq!(output.code(), Some(case.exit), "{}", case.name);
        assert!(output.stderr().is_empty(), "{}", case.name);
        let document = output.json();
        assert_eq!(
            finding_codes(&document),
            case.codes.to_vec(),
            "{}",
            case.name
        );
        let lines: Vec<usize> = document["findings"]
            .as_array()
            .expect("findings array")
            .iter()
            .map(|finding| finding["line"].as_u64().expect("finding line") as usize)
            .collect();
        assert_eq!(lines, case.lines.to_vec(), "{}", case.name);
        assert_eq!(
            document["valid"].as_bool(),
            Some(case.exit == 0),
            "{}",
            case.name
        );
        assert_eq!(
            tree_hash(&fixture_directory(&relative)),
            source_hash,
            "{}",
            case.name
        );
    }
}

struct SpecJsonCase {
    name: &'static str,
    code: Option<&'static str>,
    file: &'static str,
    message_fragment: &'static str,
}

const SPEC_JSON_CASES: [SpecJsonCase; 24] = [
    SpecJsonCase {
        name: "missing-feature-name",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`feature_name`",
    },
    SpecJsonCase {
        name: "missing-created-at",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`created_at`",
    },
    SpecJsonCase {
        name: "missing-updated-at",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`updated_at`",
    },
    SpecJsonCase {
        name: "missing-language",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`language`",
    },
    SpecJsonCase {
        name: "missing-phase",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`phase`",
    },
    SpecJsonCase {
        name: "missing-requirements-generated",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`approvals.requirements.generated`",
    },
    SpecJsonCase {
        name: "missing-requirements-approved",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`approvals.requirements.approved`",
    },
    SpecJsonCase {
        name: "missing-design-generated",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`approvals.design.generated`",
    },
    SpecJsonCase {
        name: "missing-design-approved",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`approvals.design.approved`",
    },
    SpecJsonCase {
        name: "missing-tasks-generated",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`approvals.tasks.generated`",
    },
    SpecJsonCase {
        name: "missing-tasks-approved",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`approvals.tasks.approved`",
    },
    SpecJsonCase {
        name: "missing-ready-for-implementation",
        code: Some("spec.field.missing"),
        file: "spec.json",
        message_fragment: "`ready_for_implementation`",
    },
    SpecJsonCase {
        name: "wrong-type-language",
        code: Some("spec.field.type"),
        file: "spec.json",
        message_fragment: "`language`",
    },
    SpecJsonCase {
        name: "wrong-type-ready",
        code: Some("spec.field.type"),
        file: "spec.json",
        message_fragment: "`ready_for_implementation`",
    },
    SpecJsonCase {
        name: "feature-name-mismatch",
        code: Some("spec.feature-name.mismatch"),
        file: "spec.json",
        message_fragment: "other-spec",
    },
    SpecJsonCase {
        name: "unknown-phase",
        code: Some("spec.phase.unknown"),
        file: "spec.json",
        message_fragment: "future-phase",
    },
    SpecJsonCase {
        name: "phase-requirements-generated-false",
        code: Some("spec.phase.generated-false"),
        file: "spec.json",
        message_fragment: "`approvals.requirements.generated`",
    },
    SpecJsonCase {
        name: "phase-design-generated-false",
        code: Some("spec.phase.generated-false"),
        file: "spec.json",
        message_fragment: "`approvals.design.generated`",
    },
    SpecJsonCase {
        name: "phase-tasks-generated-false",
        code: Some("spec.phase.generated-false"),
        file: "spec.json",
        message_fragment: "`approvals.tasks.generated`",
    },
    SpecJsonCase {
        name: "phase-approved-false",
        code: Some("spec.phase.approved-false"),
        file: "spec.json",
        message_fragment: "`approvals.requirements.approved`",
    },
    SpecJsonCase {
        name: "approval-without-generated",
        code: Some("spec.approval.without-generated"),
        file: "spec.json",
        message_fragment: "`approvals.requirements.approved`",
    },
    SpecJsonCase {
        name: "ready-without-tasks-approval",
        code: Some("spec.ready.without-tasks-approval"),
        file: "spec.json",
        message_fragment: "`ready_for_implementation`",
    },
    SpecJsonCase {
        name: "generated-artifact-missing",
        code: Some("spec.generated.artifact-missing"),
        file: "requirements.md",
        message_fragment: "requirements.md",
    },
    SpecJsonCase {
        name: "valid-control",
        code: None,
        file: "",
        message_fragment: "",
    },
];

#[test]
fn spec_json_fixtures_isolate_each_validation_rule() {
    for case in SPEC_JSON_CASES {
        let relative = format!("spec-json-cases/{}", case.name);
        let (tree, source_hash) = copy_fixture(
            case.name,
            &relative,
            &format!("fixture-spec-json-{}", case.name),
        );
        let output = tree.run(&["--json", "validate"]);
        assert!(output.stderr().is_empty(), "{}", case.name);
        let document = output.json();
        match case.code {
            Some(code) => {
                assert_eq!(output.code(), Some(1), "{}", case.name);
                assert_eq!(finding_codes(&document), vec![code], "{}", case.name);
                assert_eq!(document["valid"].as_bool(), Some(false), "{}", case.name);
                let finding = &document["findings"][0];
                assert_eq!(
                    finding["severity"].as_str(),
                    Some("error"),
                    "{}",
                    case.name
                );
                assert_eq!(finding["file"].as_str(), Some(case.file), "{}", case.name);
                let message = finding["message"].as_str().expect("finding message");
                assert!(
                    message.contains(case.message_fragment),
                    "{}: {message}",
                    case.name
                );
                assert!(finding["line"].is_null(), "{}", case.name);
            }
            None => {
                assert_eq!(output.code(), Some(0), "{}", case.name);
                assert_eq!(document["valid"].as_bool(), Some(true), "{}", case.name);
                assert!(finding_codes(&document).is_empty(), "{}", case.name);
                assert_eq!(
                    document["findings"].as_array().map(|findings| findings.len()),
                    Some(0),
                    "{}",
                    case.name
                );
            }
        }
        assert_eq!(
            tree_hash(&fixture_directory(&relative)),
            source_hash,
            "{}",
            case.name
        );
    }
}

#[test]
fn validate_is_deterministic_and_fixture_trees_stay_read_only() {
    for relative in ["basic", "malformed/duplicate"] {
        let name = relative.rsplit('/').next().expect("fixture name");
        let (tree, source_hash) = copy_fixture(
            name,
            relative,
            &format!("fixture-determinism-{name}"),
        );
        let first = tree.run(&["--json", "validate"]);
        let second = tree.run(&["--json", "validate"]);
        assert_eq!(first.stdout(), second.stdout(), "{relative}");
        assert_eq!(first.code(), second.code(), "{relative}");
        assert!(first.stderr().is_empty(), "{relative}");
        assert!(second.stderr().is_empty(), "{relative}");
        assert_eq!(tree.tree_hash(), source_hash, "{relative}");
        assert_eq!(
            tree_hash(&fixture_directory(relative)),
            source_hash,
            "{relative}"
        );
    }
}

fn raw_run(cwd: Option<&Path>, args: &[&str]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kiro-spec"));
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command
        .args(args)
        .output()
        .expect("compiled kiro-spec binary runs")
}

fn raw_stdout(output: &std::process::Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout is valid UTF-8")
}

fn raw_stderr(output: &std::process::Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr is valid UTF-8")
}

fn single_json_document(text: &str) -> Value {
    assert!(
        text.starts_with('{'),
        "JSON document must start at byte 0: {text}"
    );
    assert!(
        text.trim_end().ends_with('}'),
        "JSON document must end with `}}`: {text}"
    );
    serde_json::from_str(text).expect("stdout is exactly one JSON document")
}

fn complete_spec_tree(tag: &str) -> SpecTree {
    let tree = SpecTree::new("demo", tag);
    tree.write("spec.json", SPEC_JSON)
        .write("tasks.md", TASKS)
        .write("requirements.md", REQUIREMENTS)
        .write("design.md", DESIGN);
    tree
}

#[test]
fn help_lists_the_synopsis_every_subcommand_and_every_option() {
    for args in [&["--help"][..], &["-h"][..]] {
        let output = raw_run(None, args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}");
        let stdout = raw_stdout(&output);
        assert!(
            stdout.contains("kiro-spec [--root <path>] --spec <name>"),
            "{args:?}: {stdout}"
        );
        for command in ["next", "tasks", "status", "validate", "complete", "block"] {
            assert!(stdout.contains(command), "{args:?}: missing `{command}`");
        }
        for option in [
            "--root",
            "--spec",
            "--json",
            "--reason",
            "--help",
            "--version",
        ] {
            assert!(stdout.contains(option), "{args:?}: missing `{option}`");
        }
    }
}

#[test]
fn version_prints_the_cargo_package_version_for_both_flags() {
    let expected = format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION"));
    for args in [&["--version"][..], &["-V"][..]] {
        let output = raw_run(None, args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}");
        assert_eq!(raw_stdout(&output), expected, "{args:?}");
    }
}

#[test]
fn usage_errors_exit_two_with_a_diagnostic_and_leave_the_tree_unchanged() {
    let tree = complete_spec_tree("contract-usage-errors");
    let before = tree.tree_hash();

    let cases: &[(&[&str], &str)] = &[
        (&["bogus"], "bogus"),
        (&["--bogus", "tasks"], "--bogus"),
        (&["-x", "tasks"], "-x"),
        (&["--json", "complete", "1"], "--json"),
        (&["--json", "block", "1", "--reason", "waiting"], "--json"),
        (&["complete", "abc"], "abc"),
        (&["complete", "1.2.3"], "1.2.3"),
        (&["block", "abc", "--reason", "waiting"], "abc"),
        (&["block", "1.2.3", "--reason", "waiting"], "1.2.3"),
    ];

    for (args, fragment) in cases {
        let output = tree.run(args);
        assert_eq!(output.code(), Some(2), "{args:?}: {}", output.describe());
        assert!(
            output.stdout().is_empty(),
            "{args:?}: {}",
            output.describe()
        );
        let stderr = output.stderr_text();
        assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
        assert!(stderr.contains(fragment), "{args:?}: {stderr}");
    }

    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn missing_spec_and_missing_option_values_are_usage_errors() {
    let tree = complete_spec_tree("contract-missing-values");
    let before = tree.tree_hash();

    let cases: &[(&[&str], &str)] = &[
        (&["tasks"], "--spec"),
        (&["--json", "validate"], "--spec"),
        (&["--spec"], "--spec"),
        (&["--spec", "demo", "--root"], "--root"),
        (&["--spec", "demo", "block", "1", "--reason"], "--reason"),
        (&["--spec=demo", "block", "1", "--reason="], "--reason"),
        (&["--spec=demo", "--root=", "tasks"], "--root"),
        (&["--spec=demo", "--json=yes", "tasks"], "value"),
    ];

    for (args, fragment) in cases {
        let output = raw_run(Some(tree.root()), args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        let stderr = raw_stderr(&output);
        assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
        assert!(stderr.contains(fragment), "{args:?}: {stderr}");
    }

    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn invalid_spec_names_are_rejected_with_their_real_categories() {
    let tree = complete_spec_tree("contract-invalid-names");
    let before = tree.tree_hash();
    let root = tree.root().to_str().expect("temporary root is UTF-8");

    let empty = raw_run(Some(tree.root()), &["--spec", "", "tasks"]);
    assert_eq!(empty.status.code(), Some(2), "empty name");
    assert!(empty.stdout.is_empty(), "empty name");
    let stderr = raw_stderr(&empty);
    assert!(stderr.starts_with("kiro-spec: "), "{stderr}");
    assert!(stderr.contains("--spec"), "{stderr}");
    assert!(stderr.contains("value"), "{stderr}");

    for name in [".", "..", "/absolute", "nested/demo", "trailing/"] {
        let output = raw_run(
            Some(tree.root()),
            &["--root", root, "--spec", name, "tasks"],
        );
        assert_eq!(
            output.status.code(),
            Some(1),
            "{name:?}: {}",
            raw_stderr(&output)
        );
        assert!(output.stdout.is_empty(), "{name:?}");
        let stderr = raw_stderr(&output);
        assert!(stderr.starts_with("kiro-spec: "), "{name:?}: {stderr}");
        assert!(stderr.contains("--spec"), "{name:?}: {stderr}");
        assert!(stderr.contains(&format!("{name:?}")), "{name:?}: {stderr}");
        assert!(
            stderr.contains("requires a relative single path component"),
            "{name:?}: {stderr}"
        );
    }

    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn missing_spec_directory_exits_one_and_names_the_joined_path() {
    let tree = complete_spec_tree("contract-missing-spec-dir");
    let before = tree.tree_hash();
    let expected = tree.root().join(".kiro/specs/absent");

    let output = tree.run(&["--spec", "absent", "tasks"]);
    assert_eq!(output.code(), Some(1), "{}", output.describe());
    assert!(output.stdout().is_empty(), "{}", output.describe());
    let stderr = output.stderr_text();
    assert!(stderr.starts_with("kiro-spec: "), "{stderr}");
    assert!(stderr.contains(&expected.display().to_string()), "{stderr}");
    assert!(stderr.contains("does not exist"), "{stderr}");
    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn missing_artifact_diagnostics_exit_one_with_empty_stdout() {
    let tree = SpecTree::new("demo", "contract-missing-artifacts");
    let before = tree.tree_hash();
    let tasks_path = tree.spec_dir().join("tasks.md");
    let spec_json_path = tree.spec_dir().join("spec.json");

    for command in ["tasks", "next"] {
        let output = tree.run(&[command]);
        assert_eq!(output.code(), Some(1), "{command}: {}", output.describe());
        assert!(
            output.stdout().is_empty(),
            "{command}: {}",
            output.describe()
        );
        let stderr = output.stderr_text();
        assert!(stderr.starts_with("kiro-spec: "), "{command}: {stderr}");
        assert!(
            stderr.contains(&tasks_path.display().to_string()),
            "{command}: {stderr}"
        );
    }

    let status = tree.run(&["status"]);
    assert_eq!(status.code(), Some(1), "{}", status.describe());
    assert!(status.stdout().is_empty(), "{}", status.describe());
    assert!(
        status
            .stderr_text()
            .contains(&spec_json_path.display().to_string()),
        "{}",
        status.describe()
    );

    assert_eq!(tree.tree_hash(), before);

    let human = tree.run(&["validate"]);
    assert_eq!(human.code(), Some(1), "{}", human.describe());
    assert!(human.stderr().is_empty(), "{}", human.describe());
    assert_eq!(
        human.stdout_text(),
        "spec.json: error [spec.json.missing] `spec.json` is missing\n1 error, 0 warnings\n"
    );

    let json = tree.run(&["--json", "validate"]);
    assert_eq!(json.code(), Some(1), "{}", json.describe());
    assert!(json.stderr().is_empty(), "{}", json.describe());
    let document = single_json_document(&json.stdout_text());
    assert_eq!(document["schema_version"].as_u64(), Some(1));
    assert_eq!(document["spec"].as_str(), Some("demo"));
    assert_eq!(document["valid"].as_bool(), Some(false));
    assert_eq!(finding_codes(&document), vec!["spec.json.missing"]);

    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn default_root_uses_the_current_directory_and_override_ignores_it() {
    let tree = SpecTree::new("demo", "contract-default-root");
    tree.write("tasks.md", "# Plan\n\n- [ ] 1. From current directory\n");

    let output = raw_run(Some(tree.root()), &["--spec", "demo", "tasks"]);
    assert_eq!(output.status.code(), Some(0), "{}", raw_stderr(&output));
    assert!(output.stderr.is_empty());
    assert_eq!(raw_stdout(&output), "1 From current directory [pending]\n");

    let cwd_tree = SpecTree::new("demo", "contract-override-cwd");
    cwd_tree.write("tasks.md", "# Plan\n\n- [ ] 1. From the cwd tree\n");
    let root_tree = SpecTree::new("demo", "contract-override-root");
    root_tree.write("tasks.md", "# Plan\n\n- [ ] 1. From the override root\n");
    let cwd_before = cwd_tree.tree_hash();

    let output = root_tree.run_in(cwd_tree.root(), &["tasks"]);
    assert_eq!(output.code(), Some(0), "{}", output.describe());
    assert!(output.stderr().is_empty(), "{}", output.describe());
    assert_eq!(output.stdout_text(), "1 From the override root [pending]\n");
    assert_eq!(cwd_tree.tree_hash(), cwd_before);
}

#[test]
fn inline_option_forms_match_space_separated_forms() {
    let tree = complete_spec_tree("contract-inline-options");
    let root = tree.root().to_str().expect("temporary root is UTF-8");
    let root_inline = format!("--root={root}");

    let spaced = raw_run(None, &["--root", root, "--spec", "demo", "tasks"]);
    let inline = raw_run(None, &[&root_inline, "--spec=demo", "tasks"]);
    assert_eq!(spaced.status.code(), Some(0));
    assert_eq!(inline.status.code(), Some(0));
    assert!(spaced.stderr.is_empty());
    assert!(inline.stderr.is_empty());
    assert_eq!(spaced.stdout, inline.stdout);

    let spaced_json = raw_run(
        None,
        &["--root", root, "--spec", "demo", "--json", "status"],
    );
    let inline_json = raw_run(None, &[&root_inline, "--spec=demo", "--json", "status"]);
    assert_eq!(spaced_json.status.code(), Some(0));
    assert_eq!(inline_json.status.code(), Some(0));
    assert_eq!(spaced_json.stdout, inline_json.stdout);

    let cwd_inline = raw_run(Some(tree.root()), &["--spec=demo", "next"]);
    let cwd_spaced = raw_run(Some(tree.root()), &["--spec", "demo", "next"]);
    assert_eq!(cwd_inline.status.code(), Some(0));
    assert_eq!(cwd_inline.stdout, cwd_spaced.stdout);
    assert_eq!(cwd_inline.stderr, cwd_spaced.stderr);
}

#[test]
fn basic_fixture_read_commands_match_the_documented_human_text() {
    let (tree, _) = copy_fixture("basic", "basic", "contract-basic-human");
    let before = tree.tree_hash();

    let tasks = tree.run(&["tasks"]).assert_success();
    assert_eq!(tasks.stdout_text(), BASIC_TASKS_OUTPUT);

    let next = tree.run(&["next"]).assert_success();
    assert_eq!(next.stdout_text(), "  1.1 First child [pending]\n");

    let status = tree.run(&["status"]).assert_success();
    assert_eq!(status.stdout_text(), BASIC_STATUS_OUTPUT);

    let validate = tree.run(&["validate"]).assert_success();
    assert_eq!(validate.stdout_text(), "0 errors, 0 warnings\n");

    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn basic_fixture_read_commands_emit_the_documented_json_schemas() {
    let (tree, _) = copy_fixture("basic", "basic", "contract-basic-json");

    let tasks_run = tree.run(&["--json", "tasks"]).assert_success();
    let tasks_text = tasks_run.stdout_text();
    assert!(!tasks_text.contains("[pending]"), "{tasks_text}");
    let tasks = single_json_document(&tasks_text);
    assert_eq!(tasks["schema_version"].as_u64(), Some(1));
    assert_eq!(tasks["spec"].as_str(), Some("basic"));
    let entries = tasks["tasks"].as_array().expect("flat tasks array");
    let ids: Vec<&str> = entries
        .iter()
        .map(|entry| entry["id"].as_str().expect("task id"))
        .collect();
    assert_eq!(ids, ["1", "1.1", "1.2", "2", "3", "4", "5", "6", "7"]);
    for entry in entries {
        assert_eq!(
            entry.as_object().map(|object| object.len()),
            Some(5),
            "{entry}"
        );
        assert!(entry["id"].is_string(), "{entry}");
        assert!(entry["description"].is_string(), "{entry}");
        assert!(entry["state"].is_string(), "{entry}");
        assert!(entry["optional"].is_boolean(), "{entry}");
        assert!(
            entry
                .as_object()
                .is_some_and(|object| object.contains_key("blocked_reason")),
            "{entry}"
        );
    }

    let next_run = tree.run(&["--json", "next"]).assert_success();
    let next_text = next_run.stdout_text();
    assert!(!next_text.contains("[pending]"), "{next_text}");
    let next = single_json_document(&next_text);
    assert_eq!(next["schema_version"].as_u64(), Some(1));
    assert_eq!(next["spec"].as_str(), Some("basic"));
    let task = next["task"].as_object().expect("next task object");
    assert_eq!(task["id"].as_str(), Some("1.1"));
    assert_eq!(task["description"].as_str(), Some("First child"));
    assert_eq!(task["state"].as_str(), Some("pending"));
    assert_eq!(task["optional"].as_bool(), Some(false));
    assert!(task["blocked_reason"].is_null());

    let status_run = tree.run(&["--json", "status"]).assert_success();
    let status_text = status_run.stdout_text();
    assert!(!status_text.contains("stage: "), "{status_text}");
    let status = single_json_document(&status_text);
    assert_eq!(status["schema_version"].as_u64(), Some(1));
    assert_eq!(status["spec"].as_str(), Some("basic"));
    assert_eq!(status["stage"].as_str(), Some("initialized"));
    assert_eq!(status["total"].as_u64(), Some(9));
    assert_eq!(status["counts"]["completed"].as_u64(), Some(2));
    assert_eq!(status["counts"]["pending"].as_u64(), Some(6));
    assert_eq!(status["counts"]["blocked"].as_u64(), Some(1));
    assert_eq!(status["optional_pending"].as_u64(), Some(2));

    let validate_run = tree.run(&["--json", "validate"]).assert_success();
    let validate_text = validate_run.stdout_text();
    assert!(!validate_text.contains(" errors, "), "{validate_text}");
    assert!(!validate_text.contains(" error ["), "{validate_text}");
    let validate = single_json_document(&validate_text);
    assert_eq!(validate["schema_version"].as_u64(), Some(1));
    assert_eq!(validate["spec"].as_str(), Some("basic"));
    assert_eq!(validate["valid"].as_bool(), Some(true));
    assert_eq!(
        validate["findings"]
            .as_array()
            .map(|findings| findings.len()),
        Some(0)
    );
}

#[test]
fn validate_exit_status_is_zero_for_warnings_and_clean_specs_and_one_for_errors() {
    let (clean, _) = copy_fixture("basic", "basic", "contract-validate-clean");
    for args in [&["validate"][..], &["--json", "validate"][..]] {
        let output = clean.run(args);
        assert_eq!(output.code(), Some(0), "{args:?}: {}", output.describe());
        assert!(
            output.stderr().is_empty(),
            "{args:?}: {}",
            output.describe()
        );
        assert!(!output.stdout().is_empty(), "{args:?}");
    }
    let clean_json = single_json_document(&clean.run(&["--json", "validate"]).stdout_text());
    assert_eq!(clean_json["valid"].as_bool(), Some(true));
    assert_eq!(
        clean_json["findings"]
            .as_array()
            .map(|findings| findings.len()),
        Some(0)
    );

    let (warnings, _) = copy_fixture(
        "unnumbered",
        "malformed/unnumbered",
        "contract-validate-warnings",
    );
    let human = warnings.run(&["validate"]);
    assert_eq!(human.code(), Some(0), "{}", human.describe());
    assert!(human.stderr().is_empty(), "{}", human.describe());
    assert_eq!(
        human.stdout_text(),
        "tasks.md:3: warning [tasks.line.unnumbered] checkbox line has no numeric task identifier\n0 errors, 1 warning\n"
    );
    let json = warnings.run(&["--json", "validate"]);
    assert_eq!(json.code(), Some(0), "{}", json.describe());
    assert!(json.stderr().is_empty(), "{}", json.describe());
    let document = single_json_document(&json.stdout_text());
    assert_eq!(document["valid"].as_bool(), Some(true));
    let findings = document["findings"].as_array().expect("findings array");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["severity"].as_str(), Some("warning"));
    assert_eq!(findings[0]["code"].as_str(), Some("tasks.line.unnumbered"));
    assert_eq!(findings[0]["file"].as_str(), Some("tasks.md"));
    assert_eq!(findings[0]["line"].as_u64(), Some(3));
    assert!(findings[0]["message"].as_str().is_some());

    let (errors, _) = copy_fixture("depth", "malformed/depth", "contract-validate-errors");
    let human = errors.run(&["validate"]);
    assert_eq!(human.code(), Some(1), "{}", human.describe());
    assert!(human.stderr().is_empty(), "{}", human.describe());
    assert_eq!(
        human.stdout_text(),
        "tasks.md:3: error [tasks.id.depth] task identifier `1.2.3` has more than two numeric levels\n1 error, 0 warnings\n"
    );
    let json = errors.run(&["--json", "validate"]);
    assert_eq!(json.code(), Some(1), "{}", json.describe());
    assert!(json.stderr().is_empty(), "{}", json.describe());
    let document = single_json_document(&json.stdout_text());
    assert_eq!(document["valid"].as_bool(), Some(false));
    let findings = document["findings"].as_array().expect("findings array");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["severity"].as_str(), Some("error"));
    assert_eq!(findings[0]["code"].as_str(), Some("tasks.id.depth"));
    assert_eq!(findings[0]["file"].as_str(), Some("tasks.md"));
    assert_eq!(findings[0]["line"].as_u64(), Some(3));
    assert!(findings[0]["message"].as_str().is_some());
}

#[test]
fn read_command_exit_status_matches_with_and_without_json() {
    let (tree, _) = copy_fixture("basic", "basic", "contract-exit-parity-success");
    for command in ["tasks", "next", "status", "validate"] {
        let human = tree.run(&[command]);
        let json = tree.run(&["--json", command]);
        assert_eq!(human.code(), Some(0), "{command}: {}", human.describe());
        assert_eq!(json.code(), Some(0), "{command}: {}", json.describe());
        assert!(human.stderr().is_empty(), "{command}");
        assert!(json.stderr().is_empty(), "{command}");
        assert!(!human.stdout().is_empty(), "{command}");
        single_json_document(&json.stdout_text());
    }

    let empty = SpecTree::new("demo", "contract-exit-parity-failure");
    for command in ["tasks", "next", "status"] {
        let human = empty.run(&[command]);
        let json = empty.run(&["--json", command]);
        assert_eq!(human.code(), Some(1), "{command}: {}", human.describe());
        assert_eq!(json.code(), Some(1), "{command}: {}", json.describe());
        assert!(human.stdout().is_empty(), "{command}");
        assert!(json.stdout().is_empty(), "{command}");
        assert!(!human.stderr().is_empty(), "{command}");
        assert!(!json.stderr().is_empty(), "{command}");
    }
    let human = empty.run(&["validate"]);
    let json = empty.run(&["--json", "validate"]);
    assert_eq!(human.code(), Some(1));
    assert_eq!(json.code(), Some(1));
    assert!(!human.stdout().is_empty());
    assert!(!json.stdout().is_empty());
    assert!(human.stderr().is_empty());
    assert!(json.stderr().is_empty());
}

#[test]
fn read_commands_leave_trees_byte_identical_in_both_formats() {
    let reads: [&[&str]; 8] = [
        &["tasks"],
        &["next"],
        &["status"],
        &["validate"],
        &["--json", "tasks"],
        &["--json", "next"],
        &["--json", "status"],
        &["--json", "validate"],
    ];

    for (name, relative) in [
        ("basic", "basic"),
        ("unnumbered", "malformed/unnumbered"),
        ("depth", "malformed/depth"),
    ] {
        let (tree, _) = copy_fixture(name, relative, &format!("contract-read-only-{name}"));
        let before = tree.tree_hash();
        for args in reads {
            let output = tree.run(args);
            assert!(
                matches!(output.code(), Some(0) | Some(1)),
                "{relative} {args:?}: {}",
                output.describe()
            );
            assert!(output.stderr().is_empty(), "{relative} {args:?}");
            assert_eq!(tree.tree_hash(), before, "{relative} after {args:?}");
        }
    }

    let empty = SpecTree::new("demo", "contract-read-only-diagnostics");
    let before = empty.tree_hash();
    for args in [
        &["tasks"][..],
        &["next"][..],
        &["status"][..],
        &["--json", "tasks"][..],
        &["--json", "next"][..],
        &["--json", "status"][..],
    ] {
        let output = empty.run(args);
        assert_eq!(output.code(), Some(1), "{args:?}: {}", output.describe());
        assert!(
            output.stdout().is_empty(),
            "{args:?}: {}",
            output.describe()
        );
        assert!(
            !output.stderr().is_empty(),
            "{args:?}: {}",
            output.describe()
        );
        assert_eq!(empty.tree_hash(), before, "after {args:?}");
    }
    for args in [&["validate"][..], &["--json", "validate"][..]] {
        let output = empty.run(args);
        assert_eq!(output.code(), Some(1), "{args:?}: {}", output.describe());
        assert!(
            !output.stdout().is_empty(),
            "{args:?}: {}",
            output.describe()
        );
        assert!(
            output.stderr().is_empty(),
            "{args:?}: {}",
            output.describe()
        );
        assert_eq!(empty.tree_hash(), before, "after {args:?}");
    }
}
