//! Schema-versioned JSON renderings of `next`, `tasks`, `status`, and `validate`.
//!
//! Every document is one object whose keys are emitted in declaration order,
//! pretty-printed with a single trailing newline. The documents carry the spec
//! name and never the resolved root path, so output is identical across
//! checkouts of the same spec.

use serde::Serialize;

use crate::render::{entry_fields, severity_label, EntryFields, JSON_SCHEMA_VERSION};
use crate::tasks::{TaskCounts, TaskDocument, TaskEntry};
use crate::validate::ValidationReport;

/// The `next` result document.
#[derive(Serialize)]
struct NextDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    task: Option<EntryDocument<'a>>,
}

/// The `tasks` result document.
#[derive(Serialize)]
struct TasksDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    tasks: Vec<EntryDocument<'a>>,
}

/// The `status` result document.
#[derive(Serialize)]
struct StatusDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    stage: &'a str,
    total: usize,
    counts: CountsDocument,
    optional_pending: usize,
}

/// The `validate` result document.
#[derive(Serialize)]
struct ValidationDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    valid: bool,
    findings: Vec<FindingDocument<'a>>,
}

/// One task entry as the JSON schema exposes it.
#[derive(Serialize)]
struct EntryDocument<'a> {
    id: &'a str,
    description: &'a str,
    state: &'static str,
    optional: bool,
    blocked_reason: Option<&'a str>,
}

impl<'a> EntryDocument<'a> {
    fn new(entry: &'a TaskEntry) -> Self {
        let EntryFields {
            id,
            description,
            state,
            optional,
            blocked_reason,
        } = entry_fields(entry);
        Self {
            id,
            description,
            state,
            optional,
            blocked_reason,
        }
    }
}

/// The per-state counts nested inside a `status` document.
#[derive(Serialize)]
struct CountsDocument {
    completed: usize,
    pending: usize,
    blocked: usize,
}

impl From<&TaskCounts> for CountsDocument {
    fn from(counts: &TaskCounts) -> Self {
        Self {
            completed: counts.completed,
            pending: counts.pending,
            blocked: counts.blocked,
        }
    }
}

/// One finding as the JSON schema exposes it.
#[derive(Serialize)]
struct FindingDocument<'a> {
    severity: &'static str,
    code: &'a str,
    message: &'a str,
    file: &'a str,
    line: Option<usize>,
}

impl<'a> From<&'a crate::validate::Finding> for FindingDocument<'a> {
    fn from(finding: &'a crate::validate::Finding) -> Self {
        Self {
            severity: severity_label(finding.severity),
            code: finding.code,
            message: &finding.message,
            file: &finding.file,
            line: finding.line,
        }
    }
}

/// Serialize one document with pretty printing and a trailing newline.
fn finish<T: Serialize>(document: &T) -> String {
    let mut rendered = serde_json::to_string_pretty(document)
        .expect("a result document of plain fields always serialises");
    rendered.push('\n');
    rendered
}

/// Render the `next` result, whose `task` is `null` when nothing is actionable.
pub fn render_next(entry: Option<&TaskEntry>, spec: &str) -> String {
    finish(&NextDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        task: entry.map(EntryDocument::new),
    })
}

/// Render the `tasks` result as one flat array in document order.
pub fn render_tasks(document: &TaskDocument, spec: &str) -> String {
    finish(&TasksDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        tasks: document.entries().iter().map(EntryDocument::new).collect(),
    })
}

/// Render the `status` result from the raw phase string and the task counts.
pub fn render_status(stage: &str, counts: &TaskCounts, spec: &str) -> String {
    finish(&StatusDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        stage,
        total: counts.total,
        counts: CountsDocument::from(counts),
        optional_pending: counts.optional_pending,
    })
}

/// Render the `validate` result; `valid` means "no error-severity finding".
pub fn render_validation(report: &ValidationReport, spec: &str) -> String {
    finish(&ValidationDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        valid: !report.has_errors(),
        findings: report.findings.iter().map(FindingDocument::from).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::parse_tasks;
    use crate::validate::{Finding, Severity};

    fn document(source: &str) -> TaskDocument {
        parse_tasks(source)
    }

    fn report(findings: Vec<Finding>) -> ValidationReport {
        ValidationReport { findings }
    }

    #[test]
    fn next_document_carries_the_schema_version_spec_and_entry_fields() {
        let doc = document("- [ ] 1.2 Implement the parser\n");
        let rendered = render_next(doc.next_actionable(), "example");

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"task\": {\n",
                "    \"id\": \"1.2\",\n",
                "    \"description\": \"Implement the parser\",\n",
                "    \"state\": \"pending\",\n",
                "    \"optional\": false,\n",
                "    \"blocked_reason\": null\n",
                "  }\n",
                "}\n",
            )
        );
    }

    #[test]
    fn next_document_renders_a_null_task_when_nothing_is_actionable() {
        let doc = document("- [x] 1. Foundation\n");
        let rendered = render_next(doc.next_actionable(), "example");

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"task\": null\n",
                "}\n",
            )
        );
    }

    #[test]
    fn next_document_exposes_the_reason_of_a_blocked_entry() {
        let doc = document(concat!(
            "- [!]* 1.2 Blocked work\n",
            "  - _Blocked: Waiting on credentials_\n",
        ));
        let rendered = render_next(doc.next_actionable(), "example");
        let parsed: serde_json::Value =
            serde_json::from_str(&rendered).expect("the rendering is one JSON document");

        assert_eq!(parsed["task"]["id"], serde_json::json!("1.2"));
        assert_eq!(parsed["task"]["state"], serde_json::json!("blocked"));
        assert_eq!(parsed["task"]["optional"], serde_json::json!(true));
        assert_eq!(
            parsed["task"]["blocked_reason"],
            serde_json::json!("Waiting on credentials")
        );
    }

    #[test]
    fn tasks_document_is_a_flat_document_order_array_with_entry_fields() {
        let doc = document(concat!(
            "- [ ] 1. Foundation\n",
            "- [x] 1.1 Pin inputs\n",
            "- [!]* 1.2 Blocked work\n",
            "  - _Blocked: Waiting on credentials_\n",
        ));
        let rendered = render_tasks(&doc, "example");

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"tasks\": [\n",
                "    {\n",
                "      \"id\": \"1\",\n",
                "      \"description\": \"Foundation\",\n",
                "      \"state\": \"pending\",\n",
                "      \"optional\": false,\n",
                "      \"blocked_reason\": null\n",
                "    },\n",
                "    {\n",
                "      \"id\": \"1.1\",\n",
                "      \"description\": \"Pin inputs\",\n",
                "      \"state\": \"completed\",\n",
                "      \"optional\": false,\n",
                "      \"blocked_reason\": null\n",
                "    },\n",
                "    {\n",
                "      \"id\": \"1.2\",\n",
                "      \"description\": \"Blocked work\",\n",
                "      \"state\": \"blocked\",\n",
                "      \"optional\": true,\n",
                "      \"blocked_reason\": \"Waiting on credentials\"\n",
                "    }\n",
                "  ]\n",
                "}\n",
            )
        );
    }

    #[test]
    fn tasks_document_renders_an_empty_array_for_an_empty_document() {
        let doc = document("");
        let rendered = render_tasks(&doc, "example");

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"tasks\": []\n",
                "}\n",
            )
        );
    }

    #[test]
    fn status_document_exposes_stage_total_nested_counts_and_optional_pending() {
        let doc = document(concat!(
            "- [ ]* 1. Foundation\n",
            "- [x] 1.1 Pin inputs\n",
            "- [!] 1.2 Blocked work\n",
        ));
        let rendered = render_status("tasks-generated", &doc.counts(), "example");

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"stage\": \"tasks-generated\",\n",
                "  \"total\": 3,\n",
                "  \"counts\": {\n",
                "    \"completed\": 1,\n",
                "    \"pending\": 1,\n",
                "    \"blocked\": 1\n",
                "  },\n",
                "  \"optional_pending\": 1\n",
                "}\n",
            )
        );
    }

    #[test]
    fn validation_document_maps_valid_to_the_absence_of_errors() {
        let rendered = render_validation(
            &report(vec![Finding {
                severity: Severity::Error,
                code: "spec.field.missing",
                message: "required field `language` is missing".to_string(),
                file: "spec.json".to_string(),
                line: None,
            }]),
            "example",
        );

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"valid\": false,\n",
                "  \"findings\": [\n",
                "    {\n",
                "      \"severity\": \"error\",\n",
                "      \"code\": \"spec.field.missing\",\n",
                "      \"message\": \"required field `language` is missing\",\n",
                "      \"file\": \"spec.json\",\n",
                "      \"line\": null\n",
                "    }\n",
                "  ]\n",
                "}\n",
            )
        );
    }

    #[test]
    fn validation_document_stays_valid_for_warnings_and_carries_line_numbers() {
        let rendered = render_validation(
            &report(vec![Finding {
                severity: Severity::Warning,
                code: "tasks.line.unnumbered",
                message: "checkbox line has no numeric identifier".to_string(),
                file: "tasks.md".to_string(),
                line: Some(12),
            }]),
            "example",
        );

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"valid\": true,\n",
                "  \"findings\": [\n",
                "    {\n",
                "      \"severity\": \"warning\",\n",
                "      \"code\": \"tasks.line.unnumbered\",\n",
                "      \"message\": \"checkbox line has no numeric identifier\",\n",
                "      \"file\": \"tasks.md\",\n",
                "      \"line\": 12\n",
                "    }\n",
                "  ]\n",
                "}\n",
            )
        );
    }

    #[test]
    fn an_empty_report_is_valid_with_no_findings() {
        let rendered = render_validation(&report(Vec::new()), "example");

        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"schema_version\": 1,\n",
                "  \"spec\": \"example\",\n",
                "  \"valid\": true,\n",
                "  \"findings\": []\n",
                "}\n",
            )
        );
    }

    #[test]
    fn repeated_rendering_is_identical_and_parses_as_one_document() {
        let doc = document(concat!("- [ ] 1. Foundation\n", "- [x] 1.1 Pin inputs\n",));
        let first = render_tasks(&doc, "example");
        let second = render_tasks(&doc, "example");

        assert_eq!(first, second, "repeated output must be byte-identical");
        assert!(first.ends_with('\n'));
        assert!(!first.ends_with("\n\n"));
        let parsed: serde_json::Value =
            serde_json::from_str(&first).expect("the rendering is one JSON document");
        assert_eq!(parsed["schema_version"], serde_json::json!(1));
        assert_eq!(parsed["spec"], serde_json::json!("example"));
        assert_eq!(parsed["tasks"][1]["state"], serde_json::json!("completed"));
    }
}
