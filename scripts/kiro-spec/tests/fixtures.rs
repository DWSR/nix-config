//! Checks for the checked-in fixture spec trees.
//!
//! Every fixture is a read-only input: the harness copies it under temporary
//! storage and runs the compiled binary there, so these tests prove the fixture
//! trees parse through the same process boundary an operator uses and report
//! exactly the findings they document.

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use support::{Run, TempTree};

/// A fixture finding as the `validate` JSON document exposes it.
type Expected = (&'static str, &'static str, Option<usize>, &'static str);

const NO_FINDINGS: &[Expected] = &[];

const DEPTH: &[Expected] = &[("tasks.id.depth", "tasks.md", Some(1), "error")];
const NON_NUMERIC: &[Expected] = &[("tasks.id.non-numeric", "tasks.md", Some(1), "error")];
const DUPLICATE: &[Expected] = &[("tasks.id.duplicate", "tasks.md", Some(2), "error")];
const MALFORMED: &[Expected] = &[("tasks.line.malformed", "tasks.md", Some(1), "error")];
const UNNUMBERED: &[Expected] = &[("tasks.line.unnumbered", "tasks.md", Some(1), "warning")];
const LIMIT: &[Expected] = &[("tasks.limit.exceeded", "tasks.md", Some(50), "error")];

const FEATURE_NAME: &[Expected] = &[("spec.feature-name.mismatch", "spec.json", None, "error")];
const PHASE_UNKNOWN: &[Expected] = &[("spec.phase.unknown", "spec.json", None, "error")];
const PHASE_GENERATED: &[Expected] = &[("spec.phase.generated-false", "spec.json", None, "error")];
const PHASE_APPROVED: &[Expected] = &[("spec.phase.approved-false", "spec.json", None, "error")];
const APPROVAL_WITHOUT_GENERATED: &[Expected] = &[(
    "spec.approval.without-generated",
    "spec.json",
    None,
    "error",
)];
const READY_WITHOUT_APPROVAL: &[Expected] = &[(
    "spec.ready.without-tasks-approval",
    "spec.json",
    None,
    "error",
)];
const ARTIFACT_MISSING: &[Expected] = &[(
    "spec.generated.artifact-missing",
    "design.md",
    None,
    "error",
)];

/// One per-field fixture: `(case directory, spec.json field path, required type)`.
///
/// Each tree removes exactly one of the twelve required fields so the
/// `spec.field.missing` rule is observed in isolation.
const MISSING_FIELD_CASES: [(&str, &str, &str); 12] = [
    ("missing-feature-name", "feature_name", "string"),
    ("missing-created-at", "created_at", "string"),
    ("missing-updated-at", "updated_at", "string"),
    ("missing-language", "language", "string"),
    ("missing-phase", "phase", "string"),
    (
        "missing-approvals-requirements-generated",
        "approvals.requirements.generated",
        "boolean",
    ),
    (
        "missing-approvals-requirements-approved",
        "approvals.requirements.approved",
        "boolean",
    ),
    (
        "missing-approvals-design-generated",
        "approvals.design.generated",
        "boolean",
    ),
    (
        "missing-approvals-design-approved",
        "approvals.design.approved",
        "boolean",
    ),
    (
        "missing-approvals-tasks-generated",
        "approvals.tasks.generated",
        "boolean",
    ),
    (
        "missing-approvals-tasks-approved",
        "approvals.tasks.approved",
        "boolean",
    ),
    (
        "missing-ready-for-implementation",
        "ready_for_implementation",
        "boolean",
    ),
];

/// One per-field fixture: each tree gives exactly one required field the wrong
/// JSON type so the `spec.field.type` rule is observed in isolation.
const TYPE_FIELD_CASES: [(&str, &str, &str); 12] = [
    ("type-feature-name", "feature_name", "string"),
    ("type-created-at", "created_at", "string"),
    ("type-updated-at", "updated_at", "string"),
    ("type-language", "language", "string"),
    ("type-phase", "phase", "string"),
    (
        "type-approvals-requirements-generated",
        "approvals.requirements.generated",
        "boolean",
    ),
    (
        "type-approvals-requirements-approved",
        "approvals.requirements.approved",
        "boolean",
    ),
    (
        "type-approvals-design-generated",
        "approvals.design.generated",
        "boolean",
    ),
    (
        "type-approvals-design-approved",
        "approvals.design.approved",
        "boolean",
    ),
    (
        "type-approvals-tasks-generated",
        "approvals.tasks.generated",
        "boolean",
    ),
    (
        "type-approvals-tasks-approved",
        "approvals.tasks.approved",
        "boolean",
    ),
    (
        "type-ready-for-implementation",
        "ready_for_implementation",
        "boolean",
    ),
];

/// The fixture directory holding every checked-in spec tree.
fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Copy one fixture tree into disposable storage.
fn copy_fixture(label: &str, relative: &str) -> TempTree {
    let source = fixtures_root().join(relative);
    assert!(
        source.is_dir(),
        "fixture tree is missing: {}",
        source.display()
    );
    TempTree::copy_fixture(label, &source)
}

/// The sorted names of the directories beneath `directory`.
fn case_directories(directory: &Path) -> Vec<String> {
    let mut names = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("read fixture directory {}: {error}", directory.display()))
        .map(|entry| entry.expect("fixture entry is readable").file_name())
        .map(|name| name.into_string().expect("fixture name is UTF-8"))
        .filter(|name| directory.join(name).is_dir())
        .collect::<Vec<_>>();
    names.sort();
    names
}

/// Parse exactly one JSON document from a successful result.
fn json_document(run: &Run) -> Value {
    serde_json::from_str(run.stdout()).unwrap_or_else(|error| {
        panic!(
            "stdout must be exactly one JSON document: {error}\nstdout:\n{}\nstderr:\n{}",
            run.stdout(),
            run.stderr()
        )
    })
}

/// Assert one `validate --json` result carries exactly `expected` and the
/// matching exit status.
fn assert_validation(tree: &TempTree, spec: &str, expected: &[Expected]) {
    let run = tree.run_spec(spec, &["validate", "--json"]);
    assert_eq!(
        run.stderr(),
        "",
        "validate {spec}: findings are data on stdout, not diagnostics"
    );
    let has_errors = expected
        .iter()
        .any(|(_, _, _, severity)| *severity == "error");
    let expected_code = if has_errors { 1 } else { 0 };
    assert_eq!(
        run.code(),
        expected_code,
        "validate {spec}: exit status for {} findings",
        expected.len()
    );

    let result = json_document(&run);
    assert_eq!(
        result["schema_version"].as_u64(),
        Some(1),
        "validate {spec}: schema version"
    );
    assert_eq!(
        result["spec"].as_str(),
        Some(spec),
        "validate {spec}: document names the spec"
    );
    assert_eq!(
        result["valid"].as_bool(),
        Some(!has_errors),
        "validate {spec}: validity follows error-severity findings"
    );

    let findings = result["findings"]
        .as_array()
        .unwrap_or_else(|| panic!("validate {spec}: findings array\n{result}"));
    assert_eq!(
        findings.len(),
        expected.len(),
        "validate {spec}: exactly the documented findings:\n{result}"
    );
    for (index, (finding, (code, file, line, severity))) in
        findings.iter().zip(expected).enumerate()
    {
        assert_eq!(
            finding["code"].as_str(),
            Some(*code),
            "validate {spec}: finding {index} code"
        );
        assert_eq!(
            finding["file"].as_str(),
            Some(*file),
            "validate {spec}: finding {index} file"
        );
        assert_eq!(
            finding["line"].as_u64().map(|value| value as usize),
            *line,
            "validate {spec}: finding {index} line"
        );
        assert_eq!(
            finding["severity"].as_str(),
            Some(*severity),
            "validate {spec}: finding {index} severity"
        );
        assert!(
            finding["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()),
            "validate {spec}: finding {index} message is not empty"
        );
    }
}

/// Assert one per-field fixture reports exactly the documented field finding.
///
/// The message must name the broken field path, and a wrongly typed field must
/// also state the type it should have had.
fn assert_field_fixture(case: &str, field: &str, expected_type: Option<&str>, code: &'static str) {
    let tree = copy_fixture(case, &format!("spec-json-cases/{case}"));
    let run = tree.run_spec(case, &["validate", "--json"]);
    assert_eq!(run.stderr(), "", "validate {case}: no diagnostics");
    assert_eq!(
        run.code(),
        1,
        "validate {case}: the field defect is an error"
    );

    let result = json_document(&run);
    assert_eq!(result["spec"].as_str(), Some(case), "validate {case}: spec");
    assert_eq!(
        result["valid"].as_bool(),
        Some(false),
        "validate {case}: an error finding makes the spec invalid"
    );
    let findings = result["findings"]
        .as_array()
        .unwrap_or_else(|| panic!("validate {case}: findings array\n{result}"));
    assert_eq!(
        findings.len(),
        1,
        "validate {case}: isolates exactly one finding:\n{result}"
    );

    let finding = &findings[0];
    assert_eq!(
        finding["code"].as_str(),
        Some(code),
        "validate {case}: finding code"
    );
    assert_eq!(
        finding["file"].as_str(),
        Some("spec.json"),
        "validate {case}: finding file"
    );
    assert_eq!(
        finding["line"].as_u64(),
        None,
        "validate {case}: field findings are file-level"
    );
    assert_eq!(
        finding["severity"].as_str(),
        Some("error"),
        "validate {case}: finding severity"
    );
    let message = finding["message"]
        .as_str()
        .unwrap_or_else(|| panic!("validate {case}: message\n{result}"));
    assert!(
        message.contains(field),
        "validate {case}: message names `{field}`, got {message:?}"
    );
    if let Some(expected_type) = expected_type {
        assert!(
            message.contains(expected_type),
            "validate {case}: message names the `{expected_type}` type, got {message:?}"
        );
    }
}

/// The `id`/`state`/`optional`/`blocked_reason` view of one task entry.
fn entry_view(entry: &Value) -> (&str, &str, bool, Option<&str>) {
    (
        entry["id"].as_str().expect("entry id"),
        entry["state"].as_str().expect("entry state"),
        entry["optional"].as_bool().expect("entry optional"),
        entry["blocked_reason"].as_str(),
    )
}

#[test]
fn basic_fixture_reports_every_entry_shape_without_findings() {
    let source = fixtures_root().join("basic");
    let source_before = support::hash_tree(&source);
    let tree = copy_fixture("basic", "basic");
    let before = tree.hash();

    let tasks = tree.run_spec("demo", &["tasks", "--json"]);
    assert_eq!(tasks.code(), 0, "tasks reads the basic fixture");
    assert_eq!(tasks.stderr(), "", "tasks writes no diagnostic");
    let document = json_document(&tasks);
    assert_eq!(document["spec"].as_str(), Some("demo"));
    let entries = document["tasks"]
        .as_array()
        .unwrap_or_else(|| panic!("tasks document has an entries array:\n{document}"));
    let summary = entries.iter().map(entry_view).collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            ("1", "pending", false, None),
            ("1.1", "completed", false, None),
            (
                "1.2",
                "blocked",
                false,
                Some("waits for the operator to approve the release.")
            ),
            ("1.3", "completed", true, None),
            ("2", "pending", false, None),
            ("2.1", "pending", false, None),
            ("2.2", "completed", false, None),
            ("3", "pending", true, None),
            ("4", "pending", false, None),
            // A legacy prose reason bullet on a pending entry is ignored.
            ("5", "pending", false, None),
        ],
        "the basic fixture exposes pending, optional, completed, blocked, grouping and adjacent entries"
    );

    let next = tree.run_spec("demo", &["next", "--json"]);
    assert_eq!(next.code(), 0, "next reads the basic fixture");
    let next = json_document(&next);
    let task = &next["task"];
    assert_eq!(
        task["id"].as_str(),
        Some("1.2"),
        "next skips the grouping entry"
    );
    assert_eq!(task["state"].as_str(), Some("blocked"));
    assert_eq!(
        task["blocked_reason"].as_str(),
        Some("waits for the operator to approve the release."),
        "next reports the blocked reason"
    );

    let status = tree.run_spec("demo", &["status", "--json"]);
    assert_eq!(status.code(), 0, "status reads the basic fixture");
    let status = json_document(&status);
    assert_eq!(status["stage"].as_str(), Some("tasks-generated"));
    assert_eq!(status["total"].as_u64(), Some(10));
    assert_eq!(status["counts"]["completed"].as_u64(), Some(3));
    assert_eq!(status["counts"]["pending"].as_u64(), Some(6));
    assert_eq!(status["counts"]["blocked"].as_u64(), Some(1));
    assert_eq!(status["optional_pending"].as_u64(), Some(1));

    assert_validation(&tree, "demo", NO_FINDINGS);

    assert_eq!(
        tree.hash(),
        before,
        "read commands leave the fixture tree unchanged"
    );
    assert_eq!(
        support::hash_tree(&source),
        source_before,
        "the basic fixture is a read-only input"
    );
}

#[test]
fn malformed_fixture_specs_report_exactly_their_grammar_findings() {
    let source = fixtures_root().join("malformed");
    let cases = case_directories(&source.join(".kiro/specs"));
    assert_eq!(
        cases.iter().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "depth",
            "duplicate",
            "limit",
            "malformed",
            "non-numeric",
            "unnumbered"
        ],
        "the malformed fixture declares one spec per grammar defect"
    );

    let tree = copy_fixture("malformed", "malformed");
    let before = tree.hash();
    let source_before = support::hash_tree(&source);
    for case in cases {
        let expected = match case.as_str() {
            "depth" => DEPTH,
            "duplicate" => DUPLICATE,
            "limit" => LIMIT,
            "malformed" => MALFORMED,
            "non-numeric" => NON_NUMERIC,
            "unnumbered" => UNNUMBERED,
            other => panic!("unexpected malformed fixture case `{other}`"),
        };

        let tasks = tree.run_spec(&case, &["tasks", "--json"]);
        assert_eq!(
            tasks.code(),
            0,
            "tasks parses the `{case}` fixture despite its grammar defect"
        );
        assert_eq!(tasks.stderr(), "", "tasks `{case}` writes no diagnostic");
        let parsed = json_document(&tasks);
        assert_eq!(parsed["spec"].as_str(), Some(case.as_str()));

        assert_validation(&tree, &case, expected);
    }
    assert_eq!(
        tree.hash(),
        before,
        "validation leaves the fixture tree unchanged"
    );
    assert_eq!(
        support::hash_tree(&source),
        source_before,
        "the malformed fixture is a read-only input"
    );
}

#[test]
fn spec_json_fixture_trees_report_exactly_their_rule_findings() {
    let expected = [
        ("approval-without-generated", APPROVAL_WITHOUT_GENERATED),
        ("feature-name-mismatch", FEATURE_NAME),
        ("generated-artifact-missing", ARTIFACT_MISSING),
        ("phase-approved-false", PHASE_APPROVED),
        ("phase-generated-false", PHASE_GENERATED),
        ("phase-unknown", PHASE_UNKNOWN),
        ("ready-without-tasks-approval", READY_WITHOUT_APPROVAL),
    ];

    let mut expected_cases = expected
        .iter()
        .map(|(case, _)| *case)
        .chain(MISSING_FIELD_CASES.iter().map(|(case, _, _)| *case))
        .chain(TYPE_FIELD_CASES.iter().map(|(case, _, _)| *case))
        .collect::<Vec<_>>();
    expected_cases.sort_unstable();

    let cases = case_directories(&fixtures_root().join("spec-json-cases"));
    assert_eq!(
        cases, expected_cases,
        "every spec.json rule fixture, including one tree per required field, is covered"
    );

    let before_root = fixtures_root().join("spec-json-cases");
    let before = support::hash_tree(&before_root);
    for (case, findings) in expected {
        let tree = copy_fixture(case, &format!("spec-json-cases/{case}"));
        let tasks = tree.run_spec(case, &["tasks", "--json"]);
        assert_eq!(
            tasks.code(),
            0,
            "tasks parses the `{case}` spec.json fixture"
        );
        assert_eq!(tasks.stderr(), "", "tasks `{case}` writes no diagnostic");
        assert_validation(&tree, case, findings);
    }
    assert_eq!(
        support::hash_tree(&before_root),
        before,
        "the spec.json fixtures are read-only inputs"
    );
}

#[test]
fn required_field_fixture_trees_isolate_each_field() {
    let before_root = fixtures_root().join("spec-json-cases");
    let before = support::hash_tree(&before_root);

    for (case, field, _) in MISSING_FIELD_CASES {
        assert_field_fixture(case, field, None, "spec.field.missing");
    }
    for (case, field, expected_type) in TYPE_FIELD_CASES {
        assert_field_fixture(case, field, Some(expected_type), "spec.field.type");
    }

    assert_eq!(
        support::hash_tree(&before_root),
        before,
        "the per-field fixtures are read-only inputs"
    );
}
