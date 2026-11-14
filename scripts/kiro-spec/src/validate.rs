use std::cmp::Ordering;
use std::path::Path;

use serde_json::{Map, Value};

use crate::spec_json::Phase;

pub const SPEC_JSON_FILE: &str = "spec.json";
pub const TASKS_MD_FILE: &str = "tasks.md";
pub const REQUIREMENTS_MD_FILE: &str = "requirements.md";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Finding {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    pub file: String,
    pub line: Option<usize>,
}

impl Finding {
    pub fn error(
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self::new(Severity::Error, code, message, file, line)
    }

    pub fn warning(
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self::new(Severity::Warning, code, message, file, line)
    }

    fn new(
        severity: Severity,
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self {
            severity,
            code,
            message: message.into(),
            file: file.into(),
            line,
        }
    }

    pub fn sort_key(&self) -> (&str, (u8, usize), &str, &str) {
        let line_key = match self.line {
            None => (0, 0),
            Some(line) => (1, line),
        };
        (&self.file, line_key, self.code, &self.message)
    }
}

pub fn compare_findings(left: &Finding, right: &Finding) -> Ordering {
    left.sort_key().cmp(&right.sort_key())
}

pub fn sort_findings(findings: &mut [Finding]) {
    findings.sort_by(compare_findings);
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ValidationReport {
    pub findings: Vec<Finding>,
}

impl ValidationReport {
    pub fn new(mut findings: Vec<Finding>) -> Self {
        sort_findings(&mut findings);
        Self { findings }
    }

    pub fn push(&mut self, finding: Finding) {
        let index = self
            .findings
            .partition_point(|existing| compare_findings(existing, &finding) != Ordering::Greater);
        self.findings.insert(index, finding);
    }

    pub fn extend(&mut self, findings: impl IntoIterator<Item = Finding>) {
        self.findings.extend(findings);
        sort_findings(&mut self.findings);
    }

    pub fn has_errors(&self) -> bool {
        self.findings
            .iter()
            .any(|finding| finding.severity == Severity::Error)
    }
}

pub const REQUIRED_STRING_FIELDS: [&str; 5] = [
    "feature_name",
    "created_at",
    "updated_at",
    "language",
    "phase",
];
pub const APPROVAL_STAGES: [&str; 3] = ["requirements", "design", "tasks"];
pub const APPROVAL_FLAGS: [&str; 2] = ["generated", "approved"];

pub fn spec_json_missing() -> Finding {
    Finding::error(
        "spec.json.missing",
        "`spec.json` is missing",
        SPEC_JSON_FILE,
        None,
    )
}

pub fn spec_json_unreadable(detail: impl Into<String>) -> Finding {
    Finding::error(
        "spec.json.unreadable",
        format!("cannot read `spec.json`: {}", detail.into()),
        SPEC_JSON_FILE,
        None,
    )
}

pub fn spec_json_parse(detail: impl Into<String>) -> Finding {
    Finding::error(
        "spec.json.parse",
        format!("invalid `spec.json`: {}", detail.into()),
        SPEC_JSON_FILE,
        None,
    )
}

pub fn spec_field_missing(path: impl Into<String>) -> Finding {
    let path = path.into();
    Finding::error(
        "spec.field.missing",
        format!("required field `{path}` is missing"),
        SPEC_JSON_FILE,
        None,
    )
}

pub fn spec_field_type(path: impl Into<String>, expected: &str, found: &Value) -> Finding {
    let path = path.into();
    Finding::error(
        "spec.field.type",
        format!(
            "field `{path}` has the wrong type: expected {expected}, found {}",
            json_kind(found)
        ),
        SPEC_JSON_FILE,
        None,
    )
}

pub fn read_spec_json_lenient(path: &Path) -> Result<Value, Finding> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(spec_json_missing())
        }
        Err(error) => return Err(spec_json_unreadable(error.to_string())),
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return Err(spec_json_unreadable("file is not valid UTF-8")),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value @ Value::Object(_)) => Ok(value),
        Ok(value) => Err(spec_json_parse(format!(
            "top-level value is not an object (found {})",
            json_kind(&value)
        ))),
        Err(error) => Err(spec_json_parse(format!("not valid JSON: {error}"))),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SpecJsonFacts<'a> {
    value: &'a Value,
}

impl<'a> SpecJsonFacts<'a> {
    pub fn new(value: &'a Value) -> Self {
        Self { value }
    }

    pub fn object(&self) -> Option<&'a Map<String, Value>> {
        self.value.as_object()
    }

    pub fn string(&self, field: &str) -> Option<&'a str> {
        self.object()?.get(field)?.as_str()
    }

    pub fn boolean(&self, field: &str) -> Option<bool> {
        self.object()?.get(field)?.as_bool()
    }

    pub fn phase(&self) -> Option<&'a str> {
        self.string("phase")
    }

    pub fn ready_for_implementation(&self) -> Option<bool> {
        self.boolean("ready_for_implementation")
    }

    pub fn approval(&self, stage: &str, flag: &str) -> Option<bool> {
        self.object()?
            .get("approvals")?
            .as_object()?
            .get(stage)?
            .as_object()?
            .get(flag)?
            .as_bool()
    }
}

pub fn validate_spec_json_value(value: &Value, spec_name: &str) -> Vec<Finding> {
    let Some(object) = value.as_object() else {
        return vec![spec_json_parse(format!(
            "top-level value is not an object (found {})",
            json_kind(value)
        ))];
    };

    let mut findings = Vec::new();

    for field in REQUIRED_STRING_FIELDS {
        match object.get(field) {
            None => findings.push(spec_field_missing(field)),
            Some(Value::String(_)) => {}
            Some(other) => findings.push(spec_field_type(field, "string", other)),
        }
    }

    match object.get("approvals") {
        None => {
            for stage in APPROVAL_STAGES {
                for flag in APPROVAL_FLAGS {
                    findings.push(spec_field_missing(format!("approvals.{stage}.{flag}")));
                }
            }
        }
        Some(Value::Object(approvals)) => {
            for stage in APPROVAL_STAGES {
                let stage_path = format!("approvals.{stage}");
                match approvals.get(stage) {
                    None => {
                        for flag in APPROVAL_FLAGS {
                            findings.push(spec_field_missing(format!("{stage_path}.{flag}")));
                        }
                    }
                    Some(Value::Object(stage_object)) => {
                        for flag in APPROVAL_FLAGS {
                            let flag_path = format!("{stage_path}.{flag}");
                            match stage_object.get(flag) {
                                None => findings.push(spec_field_missing(flag_path)),
                                Some(Value::Bool(_)) => {}
                                Some(other) => {
                                    findings.push(spec_field_type(flag_path, "boolean", other))
                                }
                            }
                        }
                    }
                    Some(other) => findings.push(spec_field_type(stage_path, "object", other)),
                }
            }
        }
        Some(other) => findings.push(spec_field_type("approvals", "object", other)),
    }

    match object.get("ready_for_implementation") {
        None => findings.push(spec_field_missing("ready_for_implementation")),
        Some(Value::Bool(_)) => {}
        Some(other) => findings.push(spec_field_type(
            "ready_for_implementation",
            "boolean",
            other,
        )),
    }

    let facts = SpecJsonFacts::new(value);

    if let Some(feature_name) = facts.string("feature_name") {
        if feature_name != spec_name {
            findings.push(Finding::error(
                "spec.feature-name.mismatch",
                format!(
                    "feature_name `{feature_name}` does not match the spec directory `{spec_name}`"
                ),
                SPEC_JSON_FILE,
                None,
            ));
        }
    }

    if let Some(phase) = facts.phase() {
        if Phase::parse(phase).is_none() {
            findings.push(Finding::error(
                "spec.phase.unknown",
                format!("unknown phase `{phase}`"),
                SPEC_JSON_FILE,
                None,
            ));
        }
    }

    findings
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn finding(code: &'static str, message: &str, file: &str, line: Option<usize>) -> Finding {
        Finding::error(code, message, file, line)
    }

    fn keys(findings: &[Finding]) -> Vec<(&str, Option<usize>, &str, &str)> {
        findings
            .iter()
            .map(|finding| {
                (
                    finding.file.as_str(),
                    finding.line,
                    finding.code,
                    finding.message.as_str(),
                )
            })
            .collect()
    }

    fn sample_findings() -> Vec<Finding> {
        vec![
            finding("tasks.line.unnumbered", "c", TASKS_MD_FILE, Some(2)),
            finding("spec.field.missing", "b", SPEC_JSON_FILE, None),
            finding(
                "requirements.ref.unresolved",
                "a",
                REQUIREMENTS_MD_FILE,
                Some(3),
            ),
            finding("spec.field.type", "b", SPEC_JSON_FILE, Some(1)),
            finding("tasks.id.depth", "a", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.duplicate", "a", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.depth", "a", TASKS_MD_FILE, None),
        ]
    }

    #[test]
    fn spec_relative_file_names_are_the_documented_constants() {
        assert_eq!(SPEC_JSON_FILE, "spec.json");
        assert_eq!(TASKS_MD_FILE, "tasks.md");
        assert_eq!(REQUIREMENTS_MD_FILE, "requirements.md");
    }

    #[test]
    fn sort_orders_by_file_then_line_then_code_then_message() {
        let mut findings = sample_findings();
        sort_findings(&mut findings);
        assert_eq!(
            keys(&findings),
            vec![
                (
                    "requirements.md",
                    Some(3),
                    "requirements.ref.unresolved",
                    "a"
                ),
                ("spec.json", None, "spec.field.missing", "b"),
                ("spec.json", Some(1), "spec.field.type", "b"),
                ("tasks.md", None, "tasks.id.depth", "a"),
                ("tasks.md", Some(1), "tasks.id.depth", "a"),
                ("tasks.md", Some(1), "tasks.id.duplicate", "a"),
                ("tasks.md", Some(2), "tasks.line.unnumbered", "c"),
            ]
        );
    }

    #[test]
    fn a_missing_line_sorts_before_line_one() {
        let mut findings = vec![
            finding("tasks.line.malformed", "line one", TASKS_MD_FILE, Some(1)),
            finding("tasks.line.malformed", "no line", TASKS_MD_FILE, None),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].line, None);
        assert_eq!(findings[1].line, Some(1));
    }

    #[test]
    fn line_one_sorts_before_line_two() {
        let mut findings = vec![
            finding("tasks.line.malformed", "line two", TASKS_MD_FILE, Some(2)),
            finding("tasks.line.malformed", "line one", TASKS_MD_FILE, Some(1)),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].line, Some(1));
        assert_eq!(findings[1].line, Some(2));
    }

    #[test]
    fn code_breaks_a_tie_on_file_and_line() {
        let mut findings = vec![
            finding("tasks.line.malformed", "same", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.depth", "same", TASKS_MD_FILE, Some(1)),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].code, "tasks.id.depth");
        assert_eq!(findings[1].code, "tasks.line.malformed");
    }

    #[test]
    fn message_breaks_a_tie_on_file_line_and_code() {
        let mut findings = vec![
            finding("tasks.id.duplicate", "beta", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.duplicate", "alpha", TASKS_MD_FILE, Some(1)),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].message, "alpha");
        assert_eq!(findings[1].message, "beta");
    }

    #[test]
    fn sorting_does_not_depend_on_input_order() {
        let mut forward = sample_findings();
        sort_findings(&mut forward);

        let mut reversed = sample_findings();
        reversed.reverse();
        sort_findings(&mut reversed);

        assert_eq!(forward, reversed);
        assert_eq!(forward, ValidationReport::new(sample_findings()).findings);
    }

    #[test]
    fn new_sorts_findings_before_exposing_them() {
        let report = ValidationReport::new(vec![
            finding("b", "second", TASKS_MD_FILE, Some(2)),
            finding("a", "first", SPEC_JSON_FILE, None),
        ]);
        assert_eq!(
            report
                .findings
                .iter()
                .map(|finding| finding.file.as_str())
                .collect::<Vec<_>>(),
            vec!["spec.json", "tasks.md"]
        );
    }

    #[test]
    fn push_keeps_findings_sorted() {
        let mut report = ValidationReport::default();
        report.push(finding("b", "second", TASKS_MD_FILE, Some(2)));
        report.push(finding("a", "first", SPEC_JSON_FILE, None));
        report.push(finding("a", "first", TASKS_MD_FILE, Some(1)));
        report.push(finding("a", "first", TASKS_MD_FILE, None));
        assert_eq!(
            keys(&report.findings),
            vec![
                ("spec.json", None, "a", "first"),
                ("tasks.md", None, "a", "first"),
                ("tasks.md", Some(1), "a", "first"),
                ("tasks.md", Some(2), "b", "second"),
            ]
        );
    }

    #[test]
    fn extend_merges_new_findings_and_keeps_the_order() {
        let mut report =
            ValidationReport::new(vec![finding("b", "second", TASKS_MD_FILE, Some(2))]);
        report.extend(vec![
            finding("a", "first", SPEC_JSON_FILE, None),
            finding("a", "first", TASKS_MD_FILE, None),
        ]);
        assert_eq!(
            keys(&report.findings),
            vec![
                ("spec.json", None, "a", "first"),
                ("tasks.md", None, "a", "first"),
                ("tasks.md", Some(2), "b", "second"),
            ]
        );
    }

    #[test]
    fn has_errors_is_true_for_a_report_with_an_error() {
        let report = ValidationReport::new(vec![finding("a", "error", SPEC_JSON_FILE, None)]);
        assert!(report.has_errors());
    }

    #[test]
    fn has_errors_is_false_for_a_warning_only_report() {
        let report = ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "warning",
            TASKS_MD_FILE,
            Some(1),
        )]);
        assert!(!report.has_errors());
    }

    #[test]
    fn has_errors_is_false_for_an_empty_report() {
        assert!(!ValidationReport::default().has_errors());
    }

    #[test]
    fn has_errors_is_true_when_warnings_and_errors_are_mixed() {
        let report = ValidationReport::new(vec![
            Finding::warning("a", "warning", TASKS_MD_FILE, Some(1)),
            finding("b", "error", SPEC_JSON_FILE, None),
        ]);
        assert!(report.has_errors());
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let unique = format!(
                "kiro-spec-validate-{tag}-{}-{}-{}",
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

    fn valid_spec_json(feature_name: &str) -> Value {
        json!({
            "feature_name": feature_name,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
            "language": "en",
            "phase": "initialized",
            "approvals": {
                "requirements": {"generated": false, "approved": false},
                "design": {"generated": false, "approved": false},
                "tasks": {"generated": false, "approved": false}
            },
            "ready_for_implementation": false
        })
    }

    fn validate(value: &Value) -> Vec<Finding> {
        validate_spec_json_value(value, "demo")
    }

    fn codes(findings: &[Finding]) -> Vec<&str> {
        findings.iter().map(|finding| finding.code).collect()
    }

    fn messages(findings: &[Finding]) -> Vec<&str> {
        findings
            .iter()
            .map(|finding| finding.message.as_str())
            .collect()
    }

    fn assert_spec_json_location(findings: &[Finding]) {
        for finding in findings {
            assert_eq!(finding.severity, Severity::Error, "{finding:?}");
            assert_eq!(finding.file, SPEC_JSON_FILE, "{finding:?}");
            assert_eq!(finding.line, None, "{finding:?}");
        }
    }

    #[test]
    fn a_valid_spec_json_reports_no_findings() {
        assert_eq!(validate(&valid_spec_json("demo")), Vec::new());
    }

    #[test]
    fn an_empty_object_reports_all_twelve_required_fields_missing() {
        let findings = validate(&json!({}));

        assert_eq!(findings.len(), 12);
        assert!(findings
            .iter()
            .all(|finding| finding.code == "spec.field.missing"));
        assert_spec_json_location(&findings);
        let messages = messages(&findings);
        for path in [
            "feature_name",
            "created_at",
            "updated_at",
            "language",
            "phase",
            "approvals.requirements.generated",
            "approvals.requirements.approved",
            "approvals.design.generated",
            "approvals.design.approved",
            "approvals.tasks.generated",
            "approvals.tasks.approved",
            "ready_for_implementation",
        ] {
            let expected = format!("required field `{path}` is missing");
            assert!(
                messages.contains(&expected.as_str()),
                "{path}: {messages:?}"
            );
        }
    }

    #[test]
    fn a_missing_top_level_field_is_named() {
        let mut value = valid_spec_json("demo");
        value.as_object_mut().expect("object").remove("language");

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.field.missing");
        assert_eq!(findings[0].message, "required field `language` is missing");
        assert_spec_json_location(&findings);
    }

    #[test]
    fn a_missing_nested_parent_reports_each_missing_leaf_path() {
        let mut value = valid_spec_json("demo");
        value["approvals"]
            .as_object_mut()
            .expect("approvals object")
            .remove("design");

        let findings = validate(&value);

        assert_eq!(findings.len(), 2);
        assert_eq!(
            codes(&findings),
            vec!["spec.field.missing", "spec.field.missing"]
        );
        let messages = messages(&findings);
        assert!(messages.contains(&"required field `approvals.design.generated` is missing"));
        assert!(messages.contains(&"required field `approvals.design.approved` is missing"));
    }

    #[test]
    fn a_missing_approvals_object_reports_all_six_nested_leaves() {
        let mut value = valid_spec_json("demo");
        value.as_object_mut().expect("object").remove("approvals");

        let findings = validate(&value);

        assert_eq!(findings.len(), 6);
        assert!(findings
            .iter()
            .all(|finding| finding.code == "spec.field.missing"));
        let messages = messages(&findings);
        for stage in ["requirements", "design", "tasks"] {
            for flag in ["generated", "approved"] {
                let expected = format!("required field `approvals.{stage}.{flag}` is missing");
                assert!(messages.contains(&expected.as_str()), "{expected}");
            }
        }
    }

    #[test]
    fn a_wrongly_typed_string_field_names_the_field_and_the_expected_type() {
        let mut value = valid_spec_json("demo");
        value["language"] = json!(3);

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.field.type");
        assert!(findings[0].message.contains("`language`"), "{findings:?}");
        assert!(findings[0].message.contains("string"), "{findings:?}");
        assert_spec_json_location(&findings);
    }

    #[test]
    fn a_wrongly_typed_boolean_field_names_the_field_and_the_expected_type() {
        let mut value = valid_spec_json("demo");
        value["ready_for_implementation"] = json!("no");

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.field.type");
        assert!(
            findings[0].message.contains("`ready_for_implementation`"),
            "{findings:?}"
        );
        assert!(findings[0].message.contains("boolean"), "{findings:?}");
    }

    #[test]
    fn a_wrongly_typed_nested_boolean_names_its_dotted_path() {
        let mut value = valid_spec_json("demo");
        value["approvals"]["design"]["generated"] = json!("yes");

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.field.type");
        assert!(
            findings[0].message.contains("`approvals.design.generated`"),
            "{findings:?}"
        );
        assert!(findings[0].message.contains("boolean"), "{findings:?}");
    }

    #[test]
    fn a_wrongly_typed_approvals_object_names_the_parent_path() {
        let mut value = valid_spec_json("demo");
        value["approvals"] = json!("yes");

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.field.type");
        assert!(findings[0].message.contains("`approvals`"), "{findings:?}");
        assert!(findings[0].message.contains("object"), "{findings:?}");
    }

    #[test]
    fn a_wrongly_typed_stage_object_names_the_stage_path() {
        let mut value = valid_spec_json("demo");
        value["approvals"]["tasks"] = json!(["generated"]);

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.field.type");
        assert!(
            findings[0].message.contains("`approvals.tasks`"),
            "{findings:?}"
        );
        assert!(findings[0].message.contains("object"), "{findings:?}");
    }

    #[test]
    fn a_feature_name_mismatch_names_both_values() {
        let findings = validate_spec_json_value(&valid_spec_json("other"), "demo");

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.feature-name.mismatch");
        assert!(findings[0].message.contains("`other`"), "{findings:?}");
        assert!(findings[0].message.contains("`demo`"), "{findings:?}");
        assert_spec_json_location(&findings);
    }

    #[test]
    fn a_missing_feature_name_skips_the_mismatch_rule() {
        let mut value = valid_spec_json("other");
        value
            .as_object_mut()
            .expect("object")
            .remove("feature_name");

        let findings = validate_spec_json_value(&value, "demo");

        assert_eq!(codes(&findings), vec!["spec.field.missing"]);
    }

    #[test]
    fn a_mistyped_feature_name_skips_the_mismatch_rule() {
        let mut value = valid_spec_json("other");
        value["feature_name"] = json!(42);

        let findings = validate_spec_json_value(&value, "demo");

        assert_eq!(codes(&findings), vec!["spec.field.type"]);
    }

    #[test]
    fn an_unknown_phase_names_the_value() {
        let mut value = valid_spec_json("demo");
        value["phase"] = json!("future-phase");

        let findings = validate(&value);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "spec.phase.unknown");
        assert!(findings[0].message.contains("future-phase"), "{findings:?}");
        assert_spec_json_location(&findings);
    }

    #[test]
    fn a_missing_phase_skips_the_vocabulary_rule() {
        let mut value = valid_spec_json("demo");
        value.as_object_mut().expect("object").remove("phase");

        let findings = validate(&value);

        assert_eq!(codes(&findings), vec!["spec.field.missing"]);
    }

    #[test]
    fn a_mistyped_phase_skips_the_vocabulary_rule() {
        let mut value = valid_spec_json("demo");
        value["phase"] = json!(true);

        let findings = validate(&value);

        assert_eq!(codes(&findings), vec!["spec.field.type"]);
    }

    #[test]
    fn phase_and_approval_relationships_are_not_checked_here() {
        let mut value = valid_spec_json("demo");
        value["phase"] = json!("implemented");
        value["ready_for_implementation"] = json!(true);

        assert_eq!(validate(&value), Vec::new());
    }

    #[test]
    fn a_non_object_value_is_a_parse_finding_with_no_field_findings() {
        let findings = validate(&json!([1, 2, 3]));

        assert_eq!(codes(&findings), vec!["spec.json.parse"]);
        assert_spec_json_location(&findings);
    }

    #[test]
    fn a_missing_spec_json_is_a_missing_finding() {
        let temp = TempDir::new("missing");
        let path = temp.path().join("spec.json");

        let finding = read_spec_json_lenient(&path).expect_err("missing");

        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.code, "spec.json.missing");
        assert_eq!(finding.file, SPEC_JSON_FILE);
        assert_eq!(finding.line, None);
        assert!(finding.message.contains("spec.json"), "{finding:?}");
    }

    #[test]
    fn a_non_utf8_spec_json_is_an_unreadable_finding() {
        let temp = TempDir::new("non-utf8");
        let path = temp.path().join("spec.json");
        fs::write(&path, [0xff, 0xfe, 0x00]).expect("write");

        let finding = read_spec_json_lenient(&path).expect_err("non-utf8");

        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.code, "spec.json.unreadable");
        assert_eq!(finding.file, SPEC_JSON_FILE);
        assert_eq!(finding.line, None);
        assert!(finding.message.contains("UTF-8"), "{finding:?}");
    }

    #[test]
    fn an_io_error_other_than_not_found_is_an_unreadable_finding() {
        let temp = TempDir::new("directory");
        let path = temp.path().join("spec.json");
        fs::create_dir(&path).expect("create directory");

        let finding = read_spec_json_lenient(&path).expect_err("directory");

        assert_eq!(finding.code, "spec.json.unreadable");
        assert_eq!(finding.file, SPEC_JSON_FILE);
        assert_eq!(finding.line, None);
    }

    #[test]
    fn invalid_json_is_a_parse_finding() {
        let temp = TempDir::new("invalid");
        let path = temp.path().join("spec.json");
        fs::write(&path, "{ not json").expect("write");

        let finding = read_spec_json_lenient(&path).expect_err("invalid");

        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.code, "spec.json.parse");
        assert_eq!(finding.file, SPEC_JSON_FILE);
        assert_eq!(finding.line, None);
        assert!(finding.message.contains("JSON"), "{finding:?}");
    }

    #[test]
    fn a_json_array_is_a_parse_finding() {
        let temp = TempDir::new("array");
        let path = temp.path().join("spec.json");
        fs::write(&path, "[1, 2, 3]").expect("write");

        let finding = read_spec_json_lenient(&path).expect_err("array");

        assert_eq!(finding.code, "spec.json.parse");
        assert!(finding.message.contains("array"), "{finding:?}");
    }

    #[test]
    fn a_json_scalar_is_a_parse_finding() {
        for text in ["true", "3", "\"text\"", "null"] {
            let temp = TempDir::new("scalar");
            let path = temp.path().join("spec.json");
            fs::write(&path, text).expect("write");

            let finding = read_spec_json_lenient(&path).expect_err("scalar");

            assert_eq!(finding.code, "spec.json.parse", "{text}");
            assert_eq!(finding.file, SPEC_JSON_FILE, "{text}");
        }
    }

    #[test]
    fn a_parseable_object_is_returned_from_a_lenient_read() {
        let temp = TempDir::new("object");
        let path = temp.path().join("spec.json");
        fs::write(&path, r#"{"phase":"initialized"}"#).expect("write");

        let value = read_spec_json_lenient(&path).expect("object");

        assert_eq!(value["phase"], "initialized");
    }

    #[test]
    fn facts_expose_typed_fields_only_when_present_and_correctly_typed() {
        let value = valid_spec_json("demo");
        let facts = SpecJsonFacts::new(&value);

        assert_eq!(facts.string("feature_name"), Some("demo"));
        assert_eq!(facts.string("language"), Some("en"));
        assert_eq!(facts.phase(), Some("initialized"));
        assert_eq!(facts.boolean("ready_for_implementation"), Some(false));
        assert_eq!(facts.ready_for_implementation(), Some(false));
        assert_eq!(facts.approval("design", "generated"), Some(false));
        assert_eq!(facts.approval("tasks", "approved"), Some(false));
        assert_eq!(facts.string("absent"), None);
    }

    #[test]
    fn facts_return_none_for_mistyped_or_non_object_values() {
        assert_eq!(SpecJsonFacts::new(&json!("nope")).phase(), None);

        let value = json!({
            "phase": 1,
            "ready_for_implementation": "yes",
            "approvals": "none"
        });
        let facts = SpecJsonFacts::new(&value);

        assert_eq!(facts.phase(), None);
        assert_eq!(facts.ready_for_implementation(), None);
        assert_eq!(facts.approval("design", "generated"), None);
    }
}
