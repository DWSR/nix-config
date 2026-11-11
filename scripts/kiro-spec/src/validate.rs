use std::cmp::Ordering;
use std::path::Path;

use serde_json::{Map, Value};

use crate::paths::SpecPaths;
use crate::requirements::{
    tokenize_references, ReferenceOutcome, ReferenceToken, ReferenceValue, RequirementsIndex,
};
use crate::spec_json::Phase;
use crate::tasks::{parse_tasks, MetadataKind, TaskDocument};

pub const SPEC_JSON_FILE: &str = "spec.json";
pub const DESIGN_MD_FILE: &str = "design.md";
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

const GENERATED_STAGE_PHASES: [(&str, Phase); 3] = [
    ("requirements", Phase::RequirementsGenerated),
    ("design", Phase::DesignGenerated),
    ("tasks", Phase::TasksGenerated),
];

pub fn validate_phase_relationships(facts: &SpecJsonFacts) -> Vec<Finding> {
    let mut findings = Vec::new();

    if let Some(phase_text) = facts.phase() {
        if let Some(phase) = Phase::parse(phase_text) {
            for (stage, required_at) in GENERATED_STAGE_PHASES {
                if phase.rank() >= required_at.rank()
                    && facts.approval(stage, "generated") == Some(false)
                {
                    let flag = format!("approvals.{stage}.generated");
                    findings.push(Finding::error(
                        "spec.phase.generated-false",
                        format!("phase `{phase_text}` requires `{flag}`"),
                        SPEC_JSON_FILE,
                        None,
                    ));
                }
            }

            if phase.rank() >= Phase::TasksApproved.rank() {
                for stage in APPROVAL_STAGES {
                    if facts.approval(stage, "approved") == Some(false) {
                        let flag = format!("approvals.{stage}.approved");
                        findings.push(Finding::error(
                            "spec.phase.approved-false",
                            format!("phase `{phase_text}` requires `{flag}`"),
                            SPEC_JSON_FILE,
                            None,
                        ));
                    }
                }
            }
        }
    }

    for stage in APPROVAL_STAGES {
        if facts.approval(stage, "approved") == Some(true)
            && facts.approval(stage, "generated") == Some(false)
        {
            findings.push(Finding::error(
                "spec.approval.without-generated",
                format!(
                    "`approvals.{stage}.approved` is true while `approvals.{stage}.generated` is false"
                ),
                SPEC_JSON_FILE,
                None,
            ));
        }
    }

    if facts.ready_for_implementation() == Some(true)
        && facts.approval("tasks", "approved") == Some(false)
    {
        findings.push(Finding::error(
            "spec.ready.without-tasks-approval",
            "`ready_for_implementation` is true while `approvals.tasks.approved` is false",
            SPEC_JSON_FILE,
            None,
        ));
    }

    findings
}

fn artifact_for_stage(stage: &str) -> Option<&'static str> {
    match stage {
        "requirements" => Some(REQUIREMENTS_MD_FILE),
        "design" => Some(DESIGN_MD_FILE),
        "tasks" => Some(TASKS_MD_FILE),
        _ => None,
    }
}

pub fn artifact_present(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => std::fs::File::open(path).is_ok(),
        _ => false,
    }
}

pub fn validate_artifact_presence(
    facts: &SpecJsonFacts,
    paths: &SpecPaths,
    has_requirement_refs: bool,
) -> Vec<Finding> {
    let mut findings = Vec::new();
    let phase = facts.phase().and_then(Phase::parse);

    for (stage, required_at) in GENERATED_STAGE_PHASES {
        let Some(artifact) = artifact_for_stage(stage) else {
            continue;
        };
        let flag_is_true = facts.approval(stage, "generated") == Some(true);
        let phase_requires = phase.is_some_and(|phase| phase.rank() >= required_at.rank());
        if !(flag_is_true || phase_requires) {
            continue;
        }
        if !artifact_present(&paths.directory().join(artifact)) {
            findings.push(Finding::error(
                "spec.generated.artifact-missing",
                format!("required artifact `{artifact}` is missing"),
                artifact,
                None,
            ));
        }
    }

    if let Some(finding) = requirements_artifact_finding(paths, has_requirement_refs) {
        findings.push(finding);
    }

    findings
}

fn requirements_artifact_finding(paths: &SpecPaths, has_requirement_refs: bool) -> Option<Finding> {
    let path = paths.requirements_md();
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => match std::fs::read(&path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(_) => None,
                Err(_) => Some(Finding::error(
                    "requirements.unreadable",
                    "`requirements.md` is not valid UTF-8",
                    REQUIREMENTS_MD_FILE,
                    None,
                )),
            },
            Err(error) => Some(Finding::error(
                "requirements.unreadable",
                format!("cannot read `requirements.md`: {error}"),
                REQUIREMENTS_MD_FILE,
                None,
            )),
        },
        _ if has_requirement_refs => Some(Finding::error(
            "requirements.artifact-missing",
            "`requirements.md` is missing while `_Requirements:` references exist",
            REQUIREMENTS_MD_FILE,
            None,
        )),
        _ => None,
    }
}

pub fn tasks_unreadable() -> Finding {
    Finding::error(
        "tasks.unreadable",
        "`tasks.md` is not valid UTF-8",
        TASKS_MD_FILE,
        None,
    )
}

pub fn parse_tasks_bytes(bytes: &[u8]) -> Result<TaskDocument, Finding> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(parse_tasks(text)),
        Err(_) => Err(tasks_unreadable()),
    }
}

pub fn task_findings(document: &TaskDocument) -> Vec<Finding> {
    document.findings().to_vec()
}

pub fn requirements_reference_findings(
    document: &TaskDocument,
    index: &RequirementsIndex,
) -> Vec<Finding> {
    let mut findings = Vec::new();

    for entry in document.entries() {
        for bullet in entry.block().metadata_for(MetadataKind::Requirements) {
            for token in tokenize_references(bullet.body()) {
                let finding = match index.resolve(&token) {
                    ReferenceOutcome::Resolved => None,
                    ReferenceOutcome::Malformed => Some(Finding::error(
                        "requirements.ref.malformed",
                        format!("malformed requirement reference `{}`", token.raw()),
                        TASKS_MD_FILE,
                        Some(bullet.line()),
                    )),
                    ReferenceOutcome::Unresolved => Some(Finding::error(
                        "requirements.ref.unresolved",
                        unresolved_reference_message(&token),
                        TASKS_MD_FILE,
                        Some(bullet.line()),
                    )),
                };
                findings.extend(finding);
            }
        }
    }

    findings
}

fn unresolved_reference_message(token: &ReferenceToken) -> String {
    match token.value() {
        Some(ReferenceValue::Requirement(number)) => format!(
            "requirement reference `{}` does not resolve: requirement {number} is absent",
            token.raw()
        ),
        Some(ReferenceValue::Criterion {
            requirement,
            criterion,
        }) => format!(
            "requirement reference `{}` does not resolve: requirement {requirement} has no acceptance criterion {criterion}",
            token.raw()
        ),
        None => format!("requirement reference `{}` does not resolve", token.raw()),
    }
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

    fn spec_json(phase: &str, generated: [bool; 3], approved: [bool; 3], ready: bool) -> Value {
        json!({
            "feature_name": "demo",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
            "language": "en",
            "phase": phase,
            "approvals": {
                "requirements": {"generated": generated[0], "approved": approved[0]},
                "design": {"generated": generated[1], "approved": approved[1]},
                "tasks": {"generated": generated[2], "approved": approved[2]}
            },
            "ready_for_implementation": ready
        })
    }

    fn relationships(value: &Value) -> Vec<Finding> {
        validate_phase_relationships(&SpecJsonFacts::new(value))
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
    fn initialized_requires_no_generated_flags() {
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn requirements_generated_requires_the_requirements_flag() {
        let missing = spec_json(
            "requirements-generated",
            [false, false, false],
            [false, false, false],
            false,
        );
        let findings = relationships(&missing);

        assert_eq!(codes(&findings), vec!["spec.phase.generated-false"]);
        assert!(
            findings[0]
                .message
                .contains("`approvals.requirements.generated`"),
            "{findings:?}"
        );
        assert_spec_json_location(&findings);

        let satisfied = spec_json(
            "requirements-generated",
            [true, false, false],
            [false, false, false],
            false,
        );

        assert_eq!(relationships(&satisfied), Vec::new());
    }

    #[test]
    fn design_generated_requires_the_design_flag() {
        let missing = spec_json(
            "design-generated",
            [true, false, false],
            [false, false, false],
            false,
        );
        let findings = relationships(&missing);

        assert_eq!(codes(&findings), vec!["spec.phase.generated-false"]);
        assert!(
            findings[0].message.contains("`approvals.design.generated`"),
            "{findings:?}"
        );

        let satisfied = spec_json(
            "design-generated",
            [true, true, false],
            [false, false, false],
            false,
        );

        assert_eq!(relationships(&satisfied), Vec::new());
    }

    #[test]
    fn design_generated_reports_both_missing_generated_flags() {
        let value = spec_json(
            "design-generated",
            [false, false, false],
            [false, false, false],
            false,
        );
        let findings = relationships(&value);

        assert_eq!(findings.len(), 2);
        assert!(findings
            .iter()
            .all(|finding| finding.code == "spec.phase.generated-false"));
        let messages = messages(&findings);
        assert!(messages
            .iter()
            .any(|message| message.contains("`approvals.requirements.generated`")));
        assert!(messages
            .iter()
            .any(|message| message.contains("`approvals.design.generated`")));
    }

    #[test]
    fn tasks_generated_requires_the_tasks_flag() {
        let missing = spec_json(
            "tasks-generated",
            [true, true, false],
            [false, false, false],
            false,
        );
        let findings = relationships(&missing);

        assert_eq!(codes(&findings), vec!["spec.phase.generated-false"]);
        assert!(
            findings[0].message.contains("`approvals.tasks.generated`"),
            "{findings:?}"
        );

        let satisfied = spec_json(
            "tasks-generated",
            [true, true, true],
            [false, false, false],
            false,
        );

        assert_eq!(relationships(&satisfied), Vec::new());
    }

    #[test]
    fn tasks_approved_requires_every_approved_flag() {
        for (approved, expected_false) in [
            (
                [false, false, false],
                vec!["requirements", "design", "tasks"],
            ),
            ([true, false, false], vec!["design", "tasks"]),
            ([true, true, false], vec!["tasks"]),
        ] {
            let value = spec_json("tasks-approved", [true, true, true], approved, false);
            let findings = relationships(&value);

            assert_eq!(findings.len(), expected_false.len(), "{approved:?}");
            assert!(findings
                .iter()
                .all(|finding| finding.code == "spec.phase.approved-false"));
            assert_spec_json_location(&findings);
            for stage in expected_false {
                let flag = format!("`approvals.{stage}.approved`");
                assert!(
                    findings
                        .iter()
                        .any(|finding| finding.message.contains(&flag)),
                    "{stage}: {findings:?}"
                );
            }
        }

        let satisfied = spec_json(
            "tasks-approved",
            [true, true, true],
            [true, true, true],
            false,
        );

        assert_eq!(relationships(&satisfied), Vec::new());
    }

    #[test]
    fn implemented_requires_every_approved_flag() {
        for (approved, expected_false) in [
            (
                [false, false, false],
                vec!["requirements", "design", "tasks"],
            ),
            ([true, false, false], vec!["design", "tasks"]),
            ([true, true, false], vec!["tasks"]),
        ] {
            let value = spec_json("implemented", [true, true, true], approved, false);
            let findings = relationships(&value);

            assert_eq!(findings.len(), expected_false.len(), "{approved:?}");
            assert!(findings
                .iter()
                .all(|finding| finding.code == "spec.phase.approved-false"));
            assert_spec_json_location(&findings);
            for stage in expected_false {
                let flag = format!("`approvals.{stage}.approved`");
                assert!(
                    findings
                        .iter()
                        .any(|finding| finding.message.contains(&flag)),
                    "{stage}: {findings:?}"
                );
            }
        }
    }

    #[test]
    fn implemented_requires_the_generated_flags() {
        let value = spec_json(
            "implemented",
            [true, false, true],
            [true, false, true],
            false,
        );
        let findings = relationships(&value);
        let generated: Vec<&Finding> = findings
            .iter()
            .filter(|finding| finding.code == "spec.phase.generated-false")
            .collect();

        assert_eq!(generated.len(), 1, "{findings:?}");
        assert!(
            generated[0]
                .message
                .contains("`approvals.design.generated`"),
            "{findings:?}"
        );
        assert_spec_json_location(&findings);
    }

    #[test]
    fn implemented_requires_no_approval_finding_when_all_approvals_are_true() {
        let value = spec_json("implemented", [true, true, true], [true, true, true], false);

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn an_approval_ahead_of_the_phase_is_valid() {
        let value = spec_json(
            "requirements-generated",
            [true, true, false],
            [false, true, false],
            false,
        );

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn an_approval_without_its_generated_flag_is_reported_at_any_phase() {
        let value = spec_json(
            "requirements-generated",
            [true, false, false],
            [false, true, false],
            false,
        );
        let findings = relationships(&value);

        assert_eq!(codes(&findings), vec!["spec.approval.without-generated"]);
        assert!(
            findings[0].message.contains("`approvals.design.approved`"),
            "{findings:?}"
        );
        assert!(
            findings[0].message.contains("`approvals.design.generated`"),
            "{findings:?}"
        );
        assert_spec_json_location(&findings);
    }

    #[test]
    fn readiness_without_tasks_approval_is_reported() {
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            true,
        );
        let findings = relationships(&value);

        assert_eq!(codes(&findings), vec!["spec.ready.without-tasks-approval"]);
        assert!(findings[0].message.contains("ready_for_implementation"));
        assert!(
            findings[0].message.contains("`approvals.tasks.approved`"),
            "{findings:?}"
        );
        assert_spec_json_location(&findings);
    }

    #[test]
    fn readiness_with_tasks_approval_reports_nothing() {
        let value = spec_json(
            "initialized",
            [false, false, true],
            [false, false, true],
            true,
        );

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn readiness_false_reports_nothing() {
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn a_missing_phase_skips_the_phase_dependent_rules() {
        let mut value = spec_json(
            "tasks-approved",
            [true, true, true],
            [false, false, false],
            false,
        );
        value.as_object_mut().expect("object").remove("phase");

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn an_unknown_phase_skips_the_phase_dependent_rules() {
        let value = spec_json(
            "future-phase",
            [true, true, true],
            [false, false, false],
            false,
        );

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn approval_without_generated_is_reported_when_the_phase_is_missing() {
        let mut value = spec_json(
            "initialized",
            [false, false, false],
            [true, false, false],
            false,
        );
        value.as_object_mut().expect("object").remove("phase");
        let findings = relationships(&value);

        assert_eq!(codes(&findings), vec!["spec.approval.without-generated"]);
        assert!(
            findings[0]
                .message
                .contains("`approvals.requirements.approved`"),
            "{findings:?}"
        );
        assert!(
            findings[0]
                .message
                .contains("`approvals.requirements.generated`"),
            "{findings:?}"
        );
        assert_spec_json_location(&findings);
    }

    #[test]
    fn readiness_without_tasks_approval_is_reported_for_an_unknown_phase() {
        let value = spec_json(
            "future-phase",
            [false, false, false],
            [false, false, false],
            true,
        );
        let findings = relationships(&value);

        assert_eq!(codes(&findings), vec!["spec.ready.without-tasks-approval"]);
        assert!(findings[0].message.contains("ready_for_implementation"));
        assert!(
            findings[0].message.contains("`approvals.tasks.approved`"),
            "{findings:?}"
        );
        assert_spec_json_location(&findings);
    }

    #[test]
    fn phase_independent_relationships_survive_a_missing_or_unknown_phase() {
        for phase in [None, Some("future-phase")] {
            let mut value = spec_json(
                "initialized",
                [false, false, false],
                [true, false, false],
                true,
            );
            match phase {
                Some(phase) => value["phase"] = json!(phase),
                None => {
                    value.as_object_mut().expect("object").remove("phase");
                }
            }

            let findings = relationships(&value);

            assert_eq!(
                codes(&findings),
                vec![
                    "spec.approval.without-generated",
                    "spec.ready.without-tasks-approval"
                ],
                "{phase:?}"
            );
            assert_spec_json_location(&findings);
        }
    }

    #[test]
    fn phase_relationship_findings_are_errors_on_spec_json_without_a_line() {
        let value = spec_json(
            "tasks-approved",
            [true, true, true],
            [false, false, false],
            true,
        );
        let findings = relationships(&value);

        assert_eq!(findings.len(), 4);
        assert_spec_json_location(&findings);
        for finding in findings
            .iter()
            .filter(|finding| finding.code == "spec.phase.approved-false")
        {
            assert!(finding.message.contains("tasks-approved"), "{finding:?}");
        }
        let readiness = findings
            .iter()
            .find(|finding| finding.code == "spec.ready.without-tasks-approval")
            .expect("readiness finding");
        assert!(
            readiness.message.contains("ready_for_implementation"),
            "{readiness:?}"
        );
    }

    #[test]
    fn a_missing_generated_flag_skips_the_phase_and_approval_relationships() {
        let mut value = spec_json(
            "tasks-generated",
            [true, true, true],
            [false, false, false],
            false,
        );
        value["approvals"]["design"]
            .as_object_mut()
            .expect("design object")
            .remove("generated");

        assert_eq!(relationships(&value), Vec::new());
    }

    #[test]
    fn a_missing_tasks_approval_skips_the_readiness_rule() {
        let mut value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            true,
        );
        value["approvals"]["tasks"]
            .as_object_mut()
            .expect("tasks object")
            .remove("approved");

        assert_eq!(relationships(&value), Vec::new());
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

    fn spec_paths(temp: &TempDir) -> (SpecPaths, PathBuf) {
        let directory = temp.path().join(".kiro").join("specs").join("demo");
        fs::create_dir_all(&directory).expect("create spec directory");
        let paths = SpecPaths::resolve(temp.path(), "demo").expect("resolve");
        (paths, directory)
    }

    fn presence(value: &Value, paths: &SpecPaths, has_requirement_refs: bool) -> Vec<Finding> {
        validate_artifact_presence(&SpecJsonFacts::new(value), paths, has_requirement_refs)
    }

    fn write_all_artifacts(directory: &Path) {
        fs::write(
            directory.join(REQUIREMENTS_MD_FILE),
            "### Requirement 1: One\n",
        )
        .expect("write requirements");
        fs::write(directory.join(DESIGN_MD_FILE), "# Design\n").expect("write design");
        fs::write(directory.join(TASKS_MD_FILE), "- [ ] 1. One\n").expect("write tasks");
    }

    fn assert_artifact_missing(finding: &Finding, artifact: &str) {
        assert_eq!(finding.severity, Severity::Error, "{finding:?}");
        assert_eq!(finding.code, "spec.generated.artifact-missing");
        assert_eq!(finding.file, artifact, "{finding:?}");
        assert_eq!(finding.line, None, "{finding:?}");
        assert!(finding.message.contains(artifact), "{finding:?}");
    }

    #[test]
    fn a_true_generated_flag_without_its_artifact_is_reported() {
        let temp = TempDir::new("flag-missing");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "initialized",
            [true, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_artifact_missing(&findings[0], REQUIREMENTS_MD_FILE);
    }

    #[test]
    fn a_true_generated_flag_is_reported_without_a_phase() {
        let mut value = spec_json(
            "initialized",
            [false, false, true],
            [false, false, false],
            false,
        );
        value.as_object_mut().expect("object").remove("phase");
        let temp = TempDir::new("flag-no-phase");
        let (paths, _) = spec_paths(&temp);

        let findings = presence(&value, &paths, false);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_artifact_missing(&findings[0], TASKS_MD_FILE);
    }

    #[test]
    fn a_phase_required_artifact_is_reported_while_its_flag_is_false() {
        let temp = TempDir::new("phase-missing");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "requirements-generated",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_artifact_missing(&findings[0], REQUIREMENTS_MD_FILE);
    }

    #[test]
    fn every_phase_required_artifact_is_reported() {
        let temp = TempDir::new("phase-missing-all");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "tasks-generated",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        assert_eq!(findings.len(), 3, "{findings:?}");
        let artifacts: Vec<&str> = findings
            .iter()
            .map(|finding| finding.file.as_str())
            .collect();
        assert_eq!(
            artifacts,
            vec![REQUIREMENTS_MD_FILE, DESIGN_MD_FILE, TASKS_MD_FILE]
        );
        for finding in &findings {
            assert_eq!(finding.code, "spec.generated.artifact-missing");
        }
    }

    #[test]
    fn a_flag_and_a_phase_pointing_at_one_artifact_yield_one_finding() {
        let temp = TempDir::new("dedupe");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "requirements-generated",
            [true, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_artifact_missing(&findings[0], REQUIREMENTS_MD_FILE);
    }

    #[test]
    fn a_directory_in_place_of_an_artifact_counts_as_missing() {
        let temp = TempDir::new("directory-artifact");
        let (paths, directory) = spec_paths(&temp);
        fs::write(
            directory.join(REQUIREMENTS_MD_FILE),
            "### Requirement 1: One\n",
        )
        .expect("write requirements");
        fs::create_dir(directory.join(DESIGN_MD_FILE)).expect("create design directory");
        let value = spec_json(
            "design-generated",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_artifact_missing(&findings[0], DESIGN_MD_FILE);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_artifact_counts_as_missing() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("unreadable-artifact");
        let (paths, directory) = spec_paths(&temp);
        let tasks = directory.join(TASKS_MD_FILE);
        fs::write(&tasks, "- [ ] 1. One\n").expect("write tasks");
        fs::set_permissions(&tasks, fs::Permissions::from_mode(0o000)).expect("chmod");
        if fs::File::open(&tasks).is_ok() {
            fs::set_permissions(&tasks, fs::Permissions::from_mode(0o600)).expect("restore");
            return;
        }
        let value = spec_json(
            "initialized",
            [false, false, true],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        fs::set_permissions(&tasks, fs::Permissions::from_mode(0o600)).expect("restore");
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_artifact_missing(&findings[0], TASKS_MD_FILE);
    }

    #[test]
    fn all_present_artifacts_produce_no_findings() {
        let temp = TempDir::new("all-present");
        let (paths, directory) = spec_paths(&temp);
        write_all_artifacts(&directory);
        let value = spec_json("implemented", [true, true, true], [true, true, true], false);

        assert_eq!(presence(&value, &paths, true), Vec::new());
    }

    #[test]
    fn requirement_references_without_requirements_md_report_one_artifact_missing() {
        let temp = TempDir::new("refs-missing");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, true);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].severity, Severity::Error);
        assert_eq!(findings[0].code, "requirements.artifact-missing");
        assert_eq!(findings[0].file, REQUIREMENTS_MD_FILE);
        assert_eq!(findings[0].line, None);
        assert!(
            findings[0].message.contains(REQUIREMENTS_MD_FILE),
            "{findings:?}"
        );
    }

    #[test]
    fn a_directory_in_place_of_requirements_md_is_artifact_missing() {
        let temp = TempDir::new("requirements-directory");
        let (paths, directory) = spec_paths(&temp);
        fs::create_dir(directory.join(REQUIREMENTS_MD_FILE)).expect("create directory");
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, true);

        assert_eq!(codes(&findings), vec!["requirements.artifact-missing"]);
        assert_eq!(findings[0].file, REQUIREMENTS_MD_FILE);
    }

    #[test]
    fn a_missing_requirements_md_satisfies_both_independent_rules() {
        let temp = TempDir::new("requirements-both-codes");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "requirements-generated",
            [true, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, true);

        let mut codes = codes(&findings);
        codes.sort_unstable();
        assert_eq!(
            codes,
            vec![
                "requirements.artifact-missing",
                "spec.generated.artifact-missing"
            ]
        );
        assert_eq!(findings.len(), 2, "{findings:?}");
        assert!(findings
            .iter()
            .all(|finding| finding.file == REQUIREMENTS_MD_FILE));
    }

    #[test]
    fn no_references_and_no_requirements_md_report_nothing() {
        let temp = TempDir::new("no-refs-missing");
        let (paths, _) = spec_paths(&temp);
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        assert_eq!(presence(&value, &paths, false), Vec::new());
    }

    #[test]
    fn a_non_utf8_requirements_md_is_unreadable() {
        let temp = TempDir::new("non-utf8-requirements");
        let (paths, directory) = spec_paths(&temp);
        fs::write(directory.join(REQUIREMENTS_MD_FILE), [0xff, 0xfe, 0x00]).expect("write");
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, true);

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].severity, Severity::Error);
        assert_eq!(findings[0].code, "requirements.unreadable");
        assert_eq!(findings[0].file, REQUIREMENTS_MD_FILE);
        assert_eq!(findings[0].line, None);
        assert!(
            !findings
                .iter()
                .any(|finding| finding.code == "requirements.artifact-missing"),
            "{findings:?}"
        );
    }

    #[test]
    fn a_non_utf8_requirements_md_is_unreadable_without_references() {
        let temp = TempDir::new("non-utf8-requirements-no-refs");
        let (paths, directory) = spec_paths(&temp);
        fs::write(directory.join(REQUIREMENTS_MD_FILE), [0x80]).expect("write");
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, false);

        assert_eq!(codes(&findings), vec!["requirements.unreadable"]);
    }

    #[cfg(unix)]
    #[test]
    fn an_unopenable_requirements_md_is_unreadable_not_artifact_missing() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("unopenable-requirements");
        let (paths, directory) = spec_paths(&temp);
        let requirements = directory.join(REQUIREMENTS_MD_FILE);
        fs::write(&requirements, "### Requirement 1: One\n").expect("write");
        fs::set_permissions(&requirements, fs::Permissions::from_mode(0o000)).expect("chmod");
        if fs::File::open(&requirements).is_ok() {
            fs::set_permissions(&requirements, fs::Permissions::from_mode(0o600)).expect("restore");
            return;
        }
        let value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );

        let findings = presence(&value, &paths, true);

        fs::set_permissions(&requirements, fs::Permissions::from_mode(0o600)).expect("restore");
        assert_eq!(
            codes(&findings),
            vec!["requirements.unreadable"],
            "{findings:?}"
        );
    }

    #[test]
    fn a_missing_or_unknown_phase_skips_the_phase_required_artifacts() {
        for phase in [None, Some("future-phase")] {
            let temp = TempDir::new("phase-skip");
            let (paths, _) = spec_paths(&temp);
            let mut value = spec_json(
                "initialized",
                [false, false, false],
                [false, false, false],
                false,
            );
            match phase {
                Some(phase) => value["phase"] = json!(phase),
                None => {
                    value.as_object_mut().expect("object").remove("phase");
                }
            }

            assert_eq!(presence(&value, &paths, false), Vec::new(), "{phase:?}");
        }
    }

    #[test]
    fn mistyped_generated_flags_skip_the_flag_rule_without_panicking() {
        let temp = TempDir::new("mistyped-flags");
        let (paths, _) = spec_paths(&temp);
        let mut value = spec_json(
            "initialized",
            [false, false, false],
            [false, false, false],
            false,
        );
        value["approvals"]["requirements"]["generated"] = json!("yes");
        value["approvals"]["design"]["generated"] = json!(1);
        value["approvals"]["tasks"]["generated"] = json!(null);

        assert_eq!(presence(&value, &paths, false), Vec::new());
    }

    #[test]
    fn artifact_presence_requires_a_readable_regular_file() {
        let temp = TempDir::new("presence");
        let present = temp.path().join("present.md");
        fs::write(&present, "text").expect("write");
        let directory = temp.path().join("directory.md");
        fs::create_dir(&directory).expect("create directory");

        assert!(artifact_present(&present));
        assert!(!artifact_present(&directory));
        assert!(!artifact_present(&temp.path().join("absent.md")));
    }

    fn requirements_document() -> &'static str {
        "\
### Requirement 1: One

#### Acceptance Criteria

1. First.
2. Second.

### Requirement 2: Two

#### Acceptance Criteria

1. First.
"
    }

    fn reference_findings(tasks: &str, requirements: &str) -> Vec<Finding> {
        let document = crate::tasks::parse_tasks(tasks);
        let index = crate::requirements::RequirementsIndex::parse(requirements);
        requirements_reference_findings(&document, &index)
    }

    fn merged_report(tasks: &str, requirements: &str) -> ValidationReport {
        let document = crate::tasks::parse_tasks(tasks);
        let index = crate::requirements::RequirementsIndex::parse(requirements);
        ValidationReport::new(
            task_findings(&document)
                .into_iter()
                .chain(requirements_reference_findings(&document, &index))
                .collect(),
        )
    }

    #[test]
    fn task_and_reference_defects_are_both_reported_in_deterministic_order() {
        let report = merged_report(
            "- [ ] 1. First\n  - _Requirements: 1.x_\n- [ ] 1. Duplicate\n",
            requirements_document(),
        );

        assert_eq!(
            keys(&report.findings),
            vec![
                (
                    "tasks.md",
                    Some(2),
                    "requirements.ref.malformed",
                    "malformed requirement reference `1.x`"
                ),
                (
                    "tasks.md",
                    Some(3),
                    "tasks.id.duplicate",
                    "duplicate task identifier `1` (first occurrence at line 1)"
                ),
            ]
        );
        assert!(report.has_errors());
    }

    #[test]
    fn a_valid_task_document_with_resolved_references_reports_no_findings() {
        let report = merged_report(
            "- [ ] 1. First\n  - _Requirements: 1, 1.1, 2.1_\n- [ ] 2. Second\n",
            requirements_document(),
        );

        assert_eq!(report.findings, Vec::new());
    }

    #[test]
    fn malformed_reference_tokens_are_reported_at_the_bullet_line_and_named() {
        let findings = reference_findings(
            "- [ ] 1. First\n  - _Requirements: 1.x, 1.2.3, 1-2_\n",
            requirements_document(),
        );

        assert_eq!(findings.len(), 3, "{findings:?}");
        for finding in &findings {
            assert_eq!(finding.severity, Severity::Error, "{finding:?}");
            assert_eq!(finding.code, "requirements.ref.malformed", "{finding:?}");
            assert_eq!(finding.file, TASKS_MD_FILE, "{finding:?}");
            assert_eq!(finding.line, Some(2), "{finding:?}");
        }
        let messages = messages(&findings);
        for token in ["`1.x`", "`1.2.3`", "`1-2`"] {
            assert!(
                messages.iter().any(|message| message.contains(token)),
                "{token}: {messages:?}"
            );
        }
    }

    #[test]
    fn unresolved_requirement_and_criterion_references_are_reported_at_the_bullet_line() {
        let findings = reference_findings(
            "- [ ] 1. First\n  - _Requirements: 3, 1.3_\n",
            requirements_document(),
        );

        assert_eq!(findings.len(), 2, "{findings:?}");
        for finding in &findings {
            assert_eq!(finding.severity, Severity::Error, "{finding:?}");
            assert_eq!(finding.code, "requirements.ref.unresolved", "{finding:?}");
            assert_eq!(finding.file, TASKS_MD_FILE, "{finding:?}");
            assert_eq!(finding.line, Some(2), "{finding:?}");
        }
        let messages = messages(&findings);
        assert!(
            messages
                .iter()
                .any(|message| message.contains("`3`") && message.contains("requirement 3")),
            "{messages:?}"
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("`1.3`") && message.contains("criterion 3")),
            "{messages:?}"
        );
    }

    #[test]
    fn resolved_requirement_and_criterion_references_report_nothing() {
        let findings = reference_findings(
            "- [ ] 1. First\n  - _Requirements: 2, 1.1_\n",
            requirements_document(),
        );

        assert_eq!(findings, Vec::new());
    }

    #[test]
    fn a_bullet_with_valid_and_invalid_tokens_reports_only_the_invalid_one() {
        let findings = reference_findings(
            "- [ ] 1. First\n  - _Requirements: 1.1, 9_\n",
            requirements_document(),
        );

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].code, "requirements.ref.unresolved");
        assert_eq!(findings[0].line, Some(2));
        assert!(findings[0].message.contains("`9`"), "{findings:?}");
    }

    #[test]
    fn continuation_tokens_resolve_at_the_metadata_bullet_line() {
        let findings = reference_findings(
            "- [ ] 1. First\n  - _Requirements: 1.1,\n    2.9, 2.1_\n",
            requirements_document(),
        );

        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].code, "requirements.ref.unresolved");
        assert_eq!(findings[0].line, Some(2));
        assert!(findings[0].message.contains("`2.9`"), "{findings:?}");
    }

    #[test]
    fn non_requirements_metadata_bullets_are_not_resolved() {
        let findings = reference_findings(
            "- [ ] 1. First\n  - _Boundary: 1.x, 9_\n  - _Depends: 1.x_\n",
            requirements_document(),
        );

        assert_eq!(findings, Vec::new());
    }

    #[test]
    fn parser_warnings_keep_their_severity_after_the_merge() {
        let report = merged_report(
            "- [ ] 1. First\n  - _Requirements: 9_\n- [ ] Unnumbered\n",
            requirements_document(),
        );

        assert_eq!(report.findings.len(), 2, "{report:?}");
        let warning = report
            .findings
            .iter()
            .find(|finding| finding.code == "tasks.line.unnumbered")
            .expect("parser warning");
        assert_eq!(warning.severity, Severity::Warning, "{warning:?}");
        assert_eq!(warning.line, Some(3), "{warning:?}");
        let error = report
            .findings
            .iter()
            .find(|finding| finding.code == "requirements.ref.unresolved")
            .expect("reference error");
        assert_eq!(error.severity, Severity::Error, "{error:?}");
    }

    #[test]
    fn parser_errors_are_carried_into_the_report_unchanged() {
        let document = crate::tasks::parse_tasks("- [ ] 1. First\n- [ ] 1.2.3 Too deep\n");
        let parser_findings = task_findings(&document);

        assert_eq!(parser_findings, document.findings());
        assert_eq!(parser_findings.len(), 1, "{parser_findings:?}");
        assert_eq!(parser_findings[0].severity, Severity::Error);
        assert_eq!(parser_findings[0].code, "tasks.id.depth");
        assert_eq!(parser_findings[0].file, TASKS_MD_FILE);
        assert_eq!(parser_findings[0].line, Some(2));

        let mut report = ValidationReport::new(parser_findings.clone());
        report.extend(parser_findings);
        assert_eq!(report.findings.len(), 2);
        assert!(report
            .findings
            .iter()
            .all(|finding| finding == &document.findings()[0]));
    }

    #[test]
    fn tasks_unreadable_is_an_error_on_tasks_md_without_a_line() {
        let finding = tasks_unreadable();

        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.code, "tasks.unreadable");
        assert_eq!(finding.file, TASKS_MD_FILE);
        assert_eq!(finding.line, None);
        assert!(finding.message.contains("UTF-8"), "{finding:?}");
    }

    #[test]
    fn a_non_utf8_tasks_file_is_undecodable() {
        let temp = TempDir::new("non-utf8-tasks");
        let path = temp.path().join(TASKS_MD_FILE);
        fs::write(&path, [0xff, 0xfe, 0x00]).expect("write");
        let bytes = fs::read(&path).expect("read");

        let finding = parse_tasks_bytes(&bytes).expect_err("non-utf8");

        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.code, "tasks.unreadable");
        assert_eq!(finding.file, TASKS_MD_FILE);
        assert_eq!(finding.line, None);
    }

    #[test]
    fn utf8_task_bytes_decode_into_a_document() {
        let document = parse_tasks_bytes(b"- [ ] 1. One\n").expect("utf8");

        assert_eq!(document.entries().len(), 1);
        assert!(document.findings().is_empty());
    }
}
