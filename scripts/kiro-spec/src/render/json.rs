use serde::Serialize;
use serde_json::to_string_pretty;

use super::{entry_view, EntryView, JSON_SCHEMA_VERSION};
use crate::tasks::{TaskCounts, TaskDocument, TaskEntry};
use crate::validate::{Finding, Severity, ValidationReport};

#[derive(Serialize)]
struct TasksDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    tasks: Vec<EntryView<'a>>,
}

#[derive(Serialize)]
struct NextDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    task: Option<EntryView<'a>>,
}

#[derive(Serialize)]
struct StatusDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    stage: &'a str,
    total: usize,
    counts: StatusCounts,
    optional_pending: usize,
}

#[derive(Serialize)]
struct StatusCounts {
    completed: usize,
    pending: usize,
    blocked: usize,
}

#[derive(Serialize)]
struct ValidationDocument<'a> {
    schema_version: u32,
    spec: &'a str,
    valid: bool,
    findings: Vec<FindingView<'a>>,
}

#[derive(Serialize)]
struct FindingView<'a> {
    severity: &'static str,
    code: &'a str,
    message: &'a str,
    file: &'a str,
    line: Option<usize>,
}

pub fn render_tasks(doc: &TaskDocument, spec: &str) -> String {
    document(&TasksDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        tasks: doc.entries().iter().map(entry_view).collect(),
    })
}

pub fn render_next(entry: Option<&TaskEntry>, spec: &str) -> String {
    document(&NextDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        task: entry.map(entry_view),
    })
}

pub fn render_status(stage: &str, counts: &TaskCounts, spec: &str) -> String {
    document(&StatusDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        stage,
        total: counts.total,
        counts: StatusCounts {
            completed: counts.completed,
            pending: counts.pending,
            blocked: counts.blocked,
        },
        optional_pending: counts.optional_pending,
    })
}

pub fn render_validation(report: &ValidationReport, spec: &str) -> String {
    document(&ValidationDocument {
        schema_version: JSON_SCHEMA_VERSION,
        spec,
        valid: !report.has_errors(),
        findings: report.findings.iter().map(finding_view).collect(),
    })
}

fn finding_view(finding: &Finding) -> FindingView<'_> {
    FindingView {
        severity: severity_name(finding.severity),
        code: finding.code,
        message: &finding.message,
        file: &finding.file,
        line: finding.line,
    }
}

fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

fn document<T: Serialize>(value: &T) -> String {
    let mut text = to_string_pretty(value).expect("render JSON document");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::parse_tasks;

    const SPEC: &str = "example";

    fn task_document() -> TaskDocument {
        parse_tasks(
            "- [ ] 1. Foundation\n\
             - [x] 1.1 Pin inputs\n\
             - [!]* 1.2 Blocked work\n\
             \x20 - _Blocked: Waiting on credentials_\n",
        )
    }

    #[test]
    fn tasks_document_matches_schema_golden() {
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "tasks": [
    {
      "id": "1",
      "description": "Foundation",
      "state": "pending",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "1.1",
      "description": "Pin inputs",
      "state": "completed",
      "optional": false,
      "blocked_reason": null
    },
    {
      "id": "1.2",
      "description": "Blocked work",
      "state": "blocked",
      "optional": true,
      "blocked_reason": "Waiting on credentials"
    }
  ]
}
"#;
        assert_eq!(render_tasks(&task_document(), SPEC), expected);
    }

    #[test]
    fn empty_task_document_renders_an_empty_array() {
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "tasks": []
}
"#;
        assert_eq!(render_tasks(&parse_tasks(""), SPEC), expected);
    }

    #[test]
    fn next_renders_null_task_when_nothing_is_actionable() {
        let document = parse_tasks("- [x] 1. Done\n");
        assert!(document.next_actionable().is_none());
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "task": null
}
"#;
        assert_eq!(render_next(document.next_actionable(), SPEC), expected);
    }

    #[test]
    fn next_renders_the_actionable_task_entry() {
        let document = parse_tasks("- [x] 1. Done\n- [ ] 2. Next up\n");
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "task": {
    "id": "2",
    "description": "Next up",
    "state": "pending",
    "optional": false,
    "blocked_reason": null
  }
}
"#;
        assert_eq!(render_next(document.next_actionable(), SPEC), expected);
    }

    #[test]
    fn next_renders_a_blocked_task_with_its_reason() {
        let document = parse_tasks("- [!] 2. Waiting\n  - _Blocked: Waiting on credentials_\n");
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "task": {
    "id": "2",
    "description": "Waiting",
    "state": "blocked",
    "optional": false,
    "blocked_reason": "Waiting on credentials"
  }
}
"#;
        assert_eq!(render_next(document.next_actionable(), SPEC), expected);
    }

    #[test]
    fn status_document_matches_schema_golden() {
        let counts = TaskCounts {
            total: 3,
            completed: 1,
            pending: 1,
            blocked: 1,
            optional_pending: 0,
        };
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "stage": "tasks-generated",
  "total": 3,
  "counts": {
    "completed": 1,
    "pending": 1,
    "blocked": 1
  },
  "optional_pending": 0
}
"#;
        assert_eq!(render_status("tasks-generated", &counts, SPEC), expected);
    }

    #[test]
    fn validation_document_matches_schema_golden() {
        let report = ValidationReport::new(vec![
            Finding::error(
                "spec.field.missing",
                "required field `language` is missing",
                "spec.json",
                None,
            ),
            Finding::warning(
                "tasks.line.unnumbered",
                "checkbox line has no numeric identifier",
                "tasks.md",
                Some(4),
            ),
        ]);
        let expected = r#"{
  "schema_version": 1,
  "spec": "example",
  "valid": false,
  "findings": [
    {
      "severity": "error",
      "code": "spec.field.missing",
      "message": "required field `language` is missing",
      "file": "spec.json",
      "line": null
    },
    {
      "severity": "warning",
      "code": "tasks.line.unnumbered",
      "message": "checkbox line has no numeric identifier",
      "file": "tasks.md",
      "line": 4
    }
  ]
}
"#;
        assert_eq!(render_validation(&report, SPEC), expected);
    }

    #[test]
    fn warnings_only_are_valid_and_empty_reports_are_valid() {
        let warning = ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "checkbox line has no numeric identifier",
            "tasks.md",
            Some(4),
        )]);
        assert!(!warning.has_errors());
        let text = render_validation(&warning, SPEC);
        assert!(text.contains("\"valid\": true"));
        assert!(!text.contains("\"valid\": false"));

        let empty = ValidationReport::default();
        assert!(render_validation(&empty, SPEC).contains("\"valid\": true"));
    }

    #[test]
    fn schema_version_and_spec_lead_every_document() {
        let document = task_document();
        let counts = document.counts();
        let report = ValidationReport::new(vec![Finding::error(
            "spec.field.missing",
            "missing field",
            "spec.json",
            None,
        )]);
        let documents = [
            ("tasks", render_tasks(&document, SPEC)),
            ("next", render_next(document.next_actionable(), SPEC)),
            ("status", render_status("tasks-generated", &counts, SPEC)),
            ("validate", render_validation(&report, SPEC)),
        ];
        for (name, text) in documents {
            let version = text
                .find("\"schema_version\": 1")
                .unwrap_or_else(|| panic!("{name}: schema_version"));
            let spec = text
                .find("\"spec\": \"example\"")
                .unwrap_or_else(|| panic!("{name}: spec"));
            assert_eq!(version, 4, "{name}: schema_version is the first key");
            assert!(version < spec, "{name}: spec follows schema_version");
        }
    }

    #[test]
    fn repeated_rendering_is_identical() {
        let document = task_document();
        let counts = document.counts();
        let report = ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "checkbox line has no numeric identifier",
            "tasks.md",
            Some(4),
        )]);
        assert_eq!(render_tasks(&document, SPEC), render_tasks(&document, SPEC));
        assert_eq!(
            render_next(document.next_actionable(), SPEC),
            render_next(document.next_actionable(), SPEC)
        );
        assert_eq!(
            render_status("tasks-generated", &counts, SPEC),
            render_status("tasks-generated", &counts, SPEC)
        );
        assert_eq!(
            render_validation(&report, SPEC),
            render_validation(&report, SPEC)
        );
    }

    #[test]
    fn documents_contain_no_root_path() {
        let document = task_document();
        let counts = document.counts();
        let report = ValidationReport::default();
        let documents = [
            render_tasks(&document, SPEC),
            render_next(document.next_actionable(), SPEC),
            render_status("tasks-generated", &counts, SPEC),
            render_validation(&report, SPEC),
        ];
        for text in documents {
            assert!(!text.contains(".kiro"));
            assert!(!text.contains("/specs/"));
            assert!(!text.contains("root"));
            assert!(text.ends_with("}\n"));
            assert!(!text.ends_with("}\n\n"));
        }
    }
}
