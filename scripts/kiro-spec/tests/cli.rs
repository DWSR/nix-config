mod support;

use std::fs;
use std::path::{Path, PathBuf};

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
