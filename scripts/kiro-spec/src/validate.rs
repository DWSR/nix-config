//! Validation rules, findings, and deterministic report ordering.
//!
//! A finding carries a spec-relative file name: `spec.json`, `tasks.md`,
//! `requirements.md`, or another artifact name inside the spec directory, never
//! a joined filesystem path. Every rule set returns findings whose order is
//! fully described by [`Finding::sort_key`], and [`ValidationReport::sort`]
//! applies that order once so renderers and callers never re-sort.

use std::cmp::Ordering;
use std::path::Path;

use serde_json::Value;

use crate::paths::SpecPaths;
use crate::spec_json::Phase;

/// The severity of one validation finding.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Severity {
    /// The finding makes the spec invalid.
    Error,
    /// The finding is advisory and does not change the exit status.
    Warning,
}

/// One validation observation with a stable code and an optional source line.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Finding {
    /// Whether the finding is an error or a warning.
    pub severity: Severity,
    /// The stable finding code documented by the design.
    pub code: &'static str,
    /// The human-readable explanation.
    pub message: String,
    /// The spec-relative file name the finding belongs to.
    pub file: String,
    /// The 1-based source line, when the finding applies to a line.
    pub line: Option<usize>,
}

impl Finding {
    /// The deterministic report key: `(file, line, code, message)`.
    ///
    /// `line` is `None` when the finding applies to a whole file rather than a
    /// line. Because `Option` orders `None` before `Some`, a file-level finding
    /// sorts before line 1 of the same file. The key is total over the model, so
    /// every rule set can emit findings in any order and the reporter applies
    /// one sort.
    pub fn sort_key(&self) -> (&str, Option<usize>, &str, &str) {
        (&self.file, self.line, self.code, &self.message)
    }
}

impl Ord for Finding {
    fn cmp(&self, other: &Self) -> Ordering {
        // Severity only breaks a tie that the documented key cannot express;
        // it never reorders findings that differ in file, line, code, or
        // message.
        self.sort_key()
            .cmp(&other.sort_key())
            .then_with(|| self.severity.cmp(&other.severity))
    }
}

impl PartialOrd for Finding {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// The findings produced by one validation run.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ValidationReport {
    /// Every finding, in the order the reporter renders it.
    pub findings: Vec<Finding>,
}

impl ValidationReport {
    /// Whether any finding has error severity.
    pub fn has_errors(&self) -> bool {
        self.findings
            .iter()
            .any(|finding| finding.severity == Severity::Error)
    }

    /// Order the findings by [`Finding::sort_key`].
    ///
    /// Every report is sorted once before it is returned or rendered; no caller
    /// re-sorts. An already sorted report keeps its order.
    pub fn sort(&mut self) {
        self.findings.sort();
    }
}

/// The spec-relative name of the `spec.json` artifact.
const SPEC_JSON: &str = "spec.json";

/// The JSON type a required field must have.
#[derive(Clone, Copy, Debug)]
enum FieldType {
    String,
    Boolean,
}

impl FieldType {
    /// The type name used in a `spec.field.type` message.
    fn name(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Boolean => "boolean",
        }
    }

    /// Whether `value` has this JSON type; no value is ever coerced.
    fn accepts(self, value: &Value) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Boolean => value.is_boolean(),
        }
    }
}

/// The twelve required `spec.json` fields of Requirement 6.4, as leaf paths.
///
/// Intermediate objects are traversed, so `approvals` and `approvals.requirements`
/// are type-checked as objects before their boolean leaves are read.
const REQUIRED_FIELDS: [(&str, FieldType); 12] = [
    ("feature_name", FieldType::String),
    ("created_at", FieldType::String),
    ("updated_at", FieldType::String),
    ("language", FieldType::String),
    ("phase", FieldType::String),
    ("approvals.requirements.generated", FieldType::Boolean),
    ("approvals.requirements.approved", FieldType::Boolean),
    ("approvals.design.generated", FieldType::Boolean),
    ("approvals.design.approved", FieldType::Boolean),
    ("approvals.tasks.generated", FieldType::Boolean),
    ("approvals.tasks.approved", FieldType::Boolean),
    ("ready_for_implementation", FieldType::Boolean),
];

/// The outcome of walking one required field path through the document.
enum Lookup<'a> {
    /// The field is present; its type still has to be checked.
    Found(&'a Value),
    /// The first absent segment, reported as its own path.
    Missing(String),
    /// An intermediate value that is not an object, reported as its own path.
    WrongType(String),
}

/// Walk a dotted field path, reporting the first defect it meets.
///
/// Reporting the defect at the segment that is absent or mistyped rather than
/// at every leaf beneath it keeps one broken container from producing six
/// findings; the caller skips the remaining paths under that segment.
fn lookup_field<'a>(root: &'a Value, path: &str) -> Lookup<'a> {
    let segments: Vec<&str> = path.split('.').collect();
    let mut current = root;
    for (index, segment) in segments.iter().enumerate() {
        let Some(object) = current.as_object() else {
            return Lookup::WrongType(segments[..index].join("."));
        };
        match object.get(*segment) {
            None => return Lookup::Missing(segments[..=index].join(".")),
            Some(value) if index + 1 == segments.len() => return Lookup::Found(value),
            Some(value) => current = value,
        }
    }
    unreachable!("every required field path has at least one segment")
}

/// One error-severity, file-level finding in `spec.json`.
fn spec_json_finding(code: &'static str, message: impl Into<String>) -> Finding {
    Finding {
        severity: Severity::Error,
        code,
        message: message.into(),
        file: SPEC_JSON.to_string(),
        line: None,
    }
}

/// Read `spec.json` for validation, classifying an access failure as the one
/// finding that replaces all field rules.
///
/// A missing file, unreadable bytes, invalid JSON, and a document that is not an
/// object each produce one finding and suppress the dependent field rules, since
/// nothing can be checked without an object.
fn read_spec_json(path: &Path) -> Result<Value, Finding> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(spec_json_finding("spec.json.missing", "file not found"));
        }
        Err(error) => {
            return Err(spec_json_finding(
                "spec.json.unreadable",
                format!("file could not be read: {error}"),
            ));
        }
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| spec_json_finding("spec.json.unreadable", "file is not valid UTF-8"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| spec_json_finding("spec.json.parse", format!("invalid JSON: {error}")))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(spec_json_finding(
            "spec.json.parse",
            "expected a JSON object at the document root",
        ))
    }
}

/// Report `spec.json` access, required-field, feature-name, and phase defects.
///
/// The rules are Requirements 6.3, 6.4, 6.5, and 6.6. Access failures and a
/// non-object document short-circuit the field rules; a field that is absent or
/// mistyped short-circuits only the rules that read it, so a missing
/// `feature_name` never produces a mismatch and a non-string `phase` never
/// produces an unknown-phase finding.
///
/// This is one rule set of the eventual `validate()` report; it is public so the
/// assembler and integration tests can exercise the rules without a CLI run.
pub fn spec_json_findings(paths: &SpecPaths) -> Vec<Finding> {
    let mut findings = Vec::new();
    let value = match read_spec_json(&paths.spec_json()) {
        Ok(value) => value,
        Err(finding) => return vec![finding],
    };

    // Prefixes already reported as absent or mistyped; every required path
    // beneath one of them is covered by that single finding.
    let mut broken: Vec<String> = Vec::new();
    for (path, expected) in REQUIRED_FIELDS {
        if broken
            .iter()
            .any(|prefix| path.starts_with(&format!("{prefix}.")))
        {
            continue;
        }
        match lookup_field(&value, path) {
            Lookup::Found(field) => {
                if !expected.accepts(field) {
                    findings.push(spec_json_finding(
                        "spec.field.type",
                        format!("field `{path}` must be a {}", expected.name()),
                    ));
                }
            }
            Lookup::Missing(reported) => {
                findings.push(spec_json_finding(
                    "spec.field.missing",
                    format!("required field `{reported}` is missing"),
                ));
                broken.push(reported);
            }
            Lookup::WrongType(reported) => {
                findings.push(spec_json_finding(
                    "spec.field.type",
                    format!("field `{reported}` must be a JSON object"),
                ));
                broken.push(reported);
            }
        }
    }

    let feature_name = value.get("feature_name").and_then(Value::as_str);
    if let Some(feature_name) = feature_name {
        if feature_name != paths.name() {
            findings.push(spec_json_finding(
                "spec.feature-name.mismatch",
                format!(
                    "`feature_name` {feature_name:?} does not match the spec directory `{}`",
                    paths.name()
                ),
            ));
        }
    }

    let phase = value.get("phase").and_then(Value::as_str);
    if let Some(phase) = phase {
        if Phase::parse(phase).is_none() {
            let known: Vec<&str> = Phase::ALL.iter().map(|phase| phase.as_str()).collect();
            findings.push(spec_json_finding(
                "spec.phase.unknown",
                format!(
                    "`phase` {phase:?} is not one of the six documented phases: {}",
                    known.join(", ")
                ),
            ));
        }
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::SpecPaths;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    /// One finding with the given report key.
    fn finding(
        severity: Severity,
        code: &'static str,
        message: &str,
        file: &str,
        line: Option<usize>,
    ) -> Finding {
        Finding {
            severity,
            code,
            message: message.to_string(),
            file: file.to_string(),
            line,
        }
    }

    /// The documented report key of every finding, in order.
    fn keys(report: &ValidationReport) -> Vec<(&str, Option<usize>, &str, &str)> {
        report.findings.iter().map(Finding::sort_key).collect()
    }

    fn error() -> Severity {
        Severity::Error
    }

    fn warning() -> Severity {
        Severity::Warning
    }

    #[test]
    fn sorts_findings_by_file_then_line_then_code_then_message() {
        let mut report = ValidationReport {
            findings: vec![
                finding(
                    error(),
                    "tasks.id.duplicate",
                    "duplicate `1`",
                    "tasks.md",
                    Some(9),
                ),
                finding(
                    error(),
                    "spec.field.missing",
                    "missing `phase`",
                    "spec.json",
                    None,
                ),
                finding(
                    error(),
                    "tasks.line.malformed",
                    "malformed line",
                    "tasks.md",
                    Some(2),
                ),
                finding(
                    warning(),
                    "tasks.line.unnumbered",
                    "no identifier",
                    "tasks.md",
                    Some(9),
                ),
                finding(
                    error(),
                    "requirements.ref.unresolved",
                    "unresolved `9.1`",
                    "requirements.md",
                    None,
                ),
                finding(
                    error(),
                    "tasks.line.malformed",
                    "another line",
                    "tasks.md",
                    Some(2),
                ),
                finding(
                    error(),
                    "tasks.line.malformed",
                    "a line",
                    "tasks.md",
                    Some(2),
                ),
            ],
        };

        report.sort();

        assert_eq!(
            keys(&report),
            vec![
                (
                    "requirements.md",
                    None,
                    "requirements.ref.unresolved",
                    "unresolved `9.1`"
                ),
                ("spec.json", None, "spec.field.missing", "missing `phase`"),
                ("tasks.md", Some(2), "tasks.line.malformed", "a line"),
                ("tasks.md", Some(2), "tasks.line.malformed", "another line"),
                (
                    "tasks.md",
                    Some(2),
                    "tasks.line.malformed",
                    "malformed line"
                ),
                ("tasks.md", Some(9), "tasks.id.duplicate", "duplicate `1`"),
                (
                    "tasks.md",
                    Some(9),
                    "tasks.line.unnumbered",
                    "no identifier"
                ),
            ],
            "the report key is (file, line, code, message)"
        );
        assert!(
            report
                .findings
                .iter()
                .all(|finding| !finding.file.contains('/')),
            "finding files are spec-relative names, not joined paths"
        );
    }

    #[test]
    fn a_finding_without_a_line_sorts_before_line_one() {
        let mut report = ValidationReport {
            findings: vec![
                finding(
                    error(),
                    "spec.field.type",
                    "line three",
                    "spec.json",
                    Some(3),
                ),
                finding(error(), "spec.field.type", "no line", "spec.json", None),
                finding(error(), "spec.field.type", "line one", "spec.json", Some(1)),
                finding(
                    error(),
                    "spec.field.type",
                    "also no line",
                    "spec.json",
                    None,
                ),
            ],
        };

        report.sort();

        assert_eq!(
            keys(&report),
            vec![
                ("spec.json", None, "spec.field.type", "also no line"),
                ("spec.json", None, "spec.field.type", "no line"),
                ("spec.json", Some(1), "spec.field.type", "line one"),
                ("spec.json", Some(3), "spec.field.type", "line three"),
            ],
            "`None` sorts before line 1"
        );
        assert_eq!(
            report.findings[2].sort_key().1,
            Some(1),
            "line numbers stay 1-based in the key"
        );
    }

    #[test]
    fn sorting_an_empty_or_already_sorted_report_is_unchanged() {
        let mut empty = ValidationReport::default();
        empty.sort();
        assert!(empty.findings.is_empty());

        let sorted = vec![
            finding(
                warning(),
                "tasks.line.unnumbered",
                "no identifier",
                "tasks.md",
                Some(4),
            ),
            finding(
                error(),
                "tasks.limit.exceeded",
                "50 entries",
                "tasks.md",
                Some(50),
            ),
        ];
        let mut report = ValidationReport {
            findings: sorted.clone(),
        };
        report.sort();
        assert_eq!(
            report.findings, sorted,
            "already sorted findings keep their order"
        );
    }

    #[test]
    fn has_errors_reports_error_only_warning_only_and_empty_reports() {
        let error_only = ValidationReport {
            findings: vec![
                finding(error(), "spec.json.missing", "missing", "spec.json", None),
                finding(
                    error(),
                    "spec.field.missing",
                    "missing `phase`",
                    "spec.json",
                    None,
                ),
            ],
        };
        assert!(
            error_only.has_errors(),
            "a report whose findings are all errors is invalid"
        );
        assert!(
            error_only
                .findings
                .iter()
                .all(|finding| finding.severity == Severity::Error),
            "the error-only case carries no warnings"
        );

        let warnings = ValidationReport {
            findings: vec![
                finding(
                    warning(),
                    "tasks.line.unnumbered",
                    "no identifier",
                    "tasks.md",
                    Some(1),
                ),
                finding(
                    warning(),
                    "tasks.line.unnumbered",
                    "another",
                    "tasks.md",
                    Some(2),
                ),
            ],
        };
        assert!(!warnings.has_errors(), "warning-only reports are valid");

        let empty = ValidationReport::default();
        assert!(!empty.has_errors(), "an empty report is valid");
    }

    #[test]
    fn has_errors_is_true_for_a_report_mixing_errors_and_warnings() {
        let mixed = ValidationReport {
            findings: vec![
                finding(error(), "spec.json.missing", "missing", "spec.json", None),
                finding(
                    warning(),
                    "tasks.line.unnumbered",
                    "no identifier",
                    "tasks.md",
                    Some(1),
                ),
            ],
        };
        assert!(
            mixed.has_errors(),
            "a warning beside an error does not hide the error"
        );
    }

    /// A disposable spec tree rooted under the temporary directory.
    struct SpecFixture {
        root: PathBuf,
    }

    impl SpecFixture {
        fn new() -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("kiro-spec-validate-{}-{id}", std::process::id()));
            std::fs::create_dir_all(&root).expect("temporary root is created");
            Self { root }
        }

        fn paths(&self, name: &str) -> SpecPaths {
            let directory = self.root.join(".kiro").join("specs").join(name);
            std::fs::create_dir_all(&directory).expect("spec directory is created");
            SpecPaths::resolve(&self.root, name).expect("the fixture spec resolves")
        }

        fn write(&self, paths: &SpecPaths, name: &str, contents: &[u8]) {
            std::fs::write(paths.directory().join(name), contents)
                .expect("fixture file is written");
        }
    }

    impl Drop for SpecFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A minimal `spec.json` that satisfies every required-field rule.
    fn valid_spec(name: &str) -> String {
        format!(
            r#"{{
  "feature_name": "{name}",
  "created_at": "2026-10-26T02:32:24Z",
  "updated_at": "2026-10-26T02:32:24Z",
  "language": "en",
  "phase": "tasks-generated",
  "approvals": {{
    "requirements": {{ "generated": true, "approved": true }},
    "design": {{ "generated": true, "approved": true }},
    "tasks": {{ "generated": true, "approved": true }}
  }},
  "ready_for_implementation": true
}}"#
        )
    }

    fn codes(findings: &[Finding]) -> Vec<&'static str> {
        findings.iter().map(|finding| finding.code).collect()
    }

    fn messages(findings: &[Finding]) -> Vec<&str> {
        findings
            .iter()
            .map(|finding| finding.message.as_str())
            .collect()
    }

    /// The finding whose message names `path`, panicking with every message
    /// when no finding names it.
    fn field_finding<'a>(findings: &'a [Finding], path: &str) -> &'a Finding {
        let needle = format!("`{path}`");
        findings
            .iter()
            .find(|finding| finding.message.contains(&needle))
            .unwrap_or_else(|| {
                panic!(
                    "no finding names the field {path}; findings were {:?}",
                    messages(findings)
                )
            })
    }

    #[test]
    fn spec_json_access_failures_use_their_documented_codes() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");

        let missing = spec_json_findings(&paths);
        assert_eq!(codes(&missing), vec!["spec.json.missing"]);
        assert_eq!(missing[0].severity, Severity::Error);
        assert_eq!(missing[0].file, "spec.json");
        assert_eq!(missing[0].line, None, "an access finding has no line");
        assert!(
            missing[0].message.contains("not found"),
            "the diagnostic must state the file is absent, got {:?}",
            missing[0].message
        );

        fixture.write(&paths, "spec.json", b"{\"\xff\": 1}");
        let unreadable = spec_json_findings(&paths);
        assert_eq!(codes(&unreadable), vec!["spec.json.unreadable"]);
        assert_eq!(unreadable[0].severity, Severity::Error);
        assert!(
            unreadable[0].message.contains("UTF-8"),
            "the diagnostic must state the decoding problem, got {:?}",
            unreadable[0].message
        );

        fixture.write(&paths, "spec.json", b"{ \"phase\": }");
        let parse = spec_json_findings(&paths);
        assert_eq!(codes(&parse), vec!["spec.json.parse"]);
        assert!(
            parse[0].message.starts_with("invalid JSON"),
            "the diagnostic must state the JSON problem, got {:?}",
            parse[0].message
        );

        fixture.write(&paths, "spec.json", b"[]");
        let not_object = spec_json_findings(&paths);
        assert_eq!(
            codes(&not_object),
            vec!["spec.json.parse"],
            "a non-object document is a parse finding"
        );
        assert!(
            not_object[0].message.contains("object"),
            "the diagnostic must state the expected shape, got {:?}",
            not_object[0].message
        );
    }

    #[test]
    fn absent_required_fields_are_reported_with_their_field_path() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        fixture.write(&paths, "spec.json", br#"{"feature_name": "demo"}"#);

        let findings = spec_json_findings(&paths);

        assert_eq!(
            codes(&findings),
            vec!["spec.field.missing"; 6],
            "each absent top-level required field is reported once: {:?}",
            messages(&findings)
        );
        for path in [
            "created_at",
            "updated_at",
            "language",
            "phase",
            "approvals",
            "ready_for_implementation",
        ] {
            assert_eq!(field_finding(&findings, path).code, "spec.field.missing");
        }
        assert!(
            findings
                .iter()
                .all(|finding| finding.severity == Severity::Error
                    && finding.file == "spec.json"
                    && finding.line.is_none()),
            "field findings are errors at file level in spec.json"
        );
    }

    #[test]
    fn absent_nested_booleans_are_reported_with_their_full_path() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        fixture.write(
            &paths,
            "spec.json",
            br#"{
  "feature_name": "demo",
  "created_at": "2026-10-26T02:32:24Z",
  "updated_at": "2026-10-26T02:32:24Z",
  "language": "en",
  "phase": "initialized",
  "approvals": {
    "requirements": { "generated": true },
    "design": { "approved": false },
    "tasks": { "generated": true, "approved": true }
  },
  "ready_for_implementation": false
}"#,
        );

        let findings = spec_json_findings(&paths);

        assert_eq!(
            codes(&findings),
            vec!["spec.field.missing"; 2],
            "only the two absent leaves are reported: {:?}",
            messages(&findings)
        );
        assert_eq!(
            field_finding(&findings, "approvals.requirements.approved").code,
            "spec.field.missing"
        );
        assert_eq!(
            field_finding(&findings, "approvals.design.generated").code,
            "spec.field.missing"
        );
    }

    #[test]
    fn wrongly_typed_required_fields_name_the_field_path() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        fixture.write(
            &paths,
            "spec.json",
            br#"{
  "feature_name": 7,
  "created_at": "2026-10-26T02:32:24Z",
  "updated_at": "2026-10-26T02:32:24Z",
  "language": 7,
  "phase": true,
  "approvals": {
    "requirements": { "generated": "yes", "approved": 1 },
    "design": { "generated": true, "approved": true },
    "tasks": { "generated": true, "approved": true }
  },
  "ready_for_implementation": "true"
}"#,
        );

        let findings = spec_json_findings(&paths);

        assert_eq!(
            codes(&findings),
            vec!["spec.field.type"; 6],
            "each wrongly typed field is reported once: {:?}",
            messages(&findings)
        );
        for (path, expected) in [
            ("feature_name", "string"),
            ("language", "string"),
            ("phase", "string"),
            ("approvals.requirements.generated", "boolean"),
            ("approvals.requirements.approved", "boolean"),
            ("ready_for_implementation", "boolean"),
        ] {
            let finding = field_finding(&findings, path);
            assert_eq!(finding.code, "spec.field.type");
            assert!(
                finding.message.contains(expected),
                "the message for {path} must state the expected {expected} type, got {:?}",
                finding.message
            );
        }
    }

    #[test]
    fn a_wrongly_typed_approvals_container_is_one_type_finding() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        fixture.write(
            &paths,
            "spec.json",
            br#"{
  "feature_name": "demo",
  "created_at": "2026-10-26T02:32:24Z",
  "updated_at": "2026-10-26T02:32:24Z",
  "language": "en",
  "phase": "initialized",
  "approvals": "none",
  "ready_for_implementation": false
}"#,
        );

        let findings = spec_json_findings(&paths);

        assert_eq!(
            codes(&findings),
            vec!["spec.field.type"],
            "nested booleans are not reported separately: {:?}",
            messages(&findings)
        );
        assert_eq!(
            field_finding(&findings, "approvals").code,
            "spec.field.type"
        );
    }

    #[test]
    fn feature_name_mismatch_names_the_value_and_the_spec_directory() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        let document = valid_spec("other");
        fixture.write(&paths, "spec.json", document.as_bytes());

        let findings = spec_json_findings(&paths);

        assert_eq!(codes(&findings), vec!["spec.feature-name.mismatch"]);
        assert_eq!(findings[0].severity, Severity::Error);
        assert_eq!(findings[0].file, "spec.json");
        assert_eq!(findings[0].line, None);
        for needle in ["feature_name", "other", "demo"] {
            assert!(
                findings[0].message.contains(needle),
                "the message must name {needle:?}, got {:?}",
                findings[0].message
            );
        }
    }

    #[test]
    fn unknown_phase_is_reported_once_and_names_the_value() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        let document = valid_spec("demo").replace("tasks-generated", "future-phase");
        fixture.write(&paths, "spec.json", document.as_bytes());

        let findings = spec_json_findings(&paths);

        assert_eq!(codes(&findings), vec!["spec.phase.unknown"]);
        assert_eq!(findings[0].severity, Severity::Error);
        assert_eq!(findings[0].file, "spec.json");
        for needle in ["phase", "future-phase"] {
            assert!(
                findings[0].message.contains(needle),
                "the message must name {needle:?}, got {:?}",
                findings[0].message
            );
        }
    }

    #[test]
    fn all_six_documented_phases_are_accepted() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");

        for phase in Phase::ALL {
            let document = valid_spec("demo").replace("tasks-generated", phase.as_str());
            fixture.write(&paths, "spec.json", document.as_bytes());
            assert!(
                spec_json_findings(&paths).is_empty(),
                "{:?} is a documented phase and must not produce findings",
                phase
            );
        }
    }

    #[test]
    fn dependent_rules_are_skipped_when_their_fields_are_absent_or_mistyped() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");

        let without_feature = valid_spec("demo").replace("\"feature_name\": \"demo\",", "");
        fixture.write(&paths, "spec.json", without_feature.as_bytes());
        let findings = spec_json_findings(&paths);
        assert_eq!(codes(&findings), vec!["spec.field.missing"]);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.code == "spec.feature-name.mismatch"),
            "a missing feature_name cannot be compared with the directory"
        );

        let numeric_feature =
            valid_spec("demo").replace("\"feature_name\": \"demo\"", "\"feature_name\": 7");
        fixture.write(&paths, "spec.json", numeric_feature.as_bytes());
        let findings = spec_json_findings(&paths);
        assert_eq!(codes(&findings), vec!["spec.field.type"]);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.code == "spec.feature-name.mismatch"),
            "a mistyped feature_name cannot be compared with the directory"
        );

        let without_phase = valid_spec("demo").replace("\"phase\": \"tasks-generated\",", "");
        fixture.write(&paths, "spec.json", without_phase.as_bytes());
        let findings = spec_json_findings(&paths);
        assert_eq!(codes(&findings), vec!["spec.field.missing"]);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.code == "spec.phase.unknown"),
            "a missing phase is not an unknown phase"
        );

        let numeric_phase =
            valid_spec("demo").replace("\"phase\": \"tasks-generated\"", "\"phase\": 7");
        fixture.write(&paths, "spec.json", numeric_phase.as_bytes());
        let findings = spec_json_findings(&paths);
        assert_eq!(codes(&findings), vec!["spec.field.type"]);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.code == "spec.phase.unknown"),
            "a mistyped phase is not an unknown phase"
        );
    }

    #[test]
    fn a_valid_spec_json_produces_no_findings() {
        let fixture = SpecFixture::new();
        let paths = fixture.paths("demo");
        let document = valid_spec("demo");
        fixture.write(&paths, "spec.json", document.as_bytes());

        assert!(
            spec_json_findings(&paths).is_empty(),
            "a well-formed spec.json has no spec.json findings"
        );
    }
}
