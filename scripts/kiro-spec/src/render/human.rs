//! Plain-text renderings of `next`, `tasks`, `status`, and `validate`.
//!
//! Every rendering is built in memory and ends with a newline. The text is
//! pure: it never inspects the terminal and never emits ANSI escapes, so piped
//! and interactive output are identical.

use crate::render::{entry_fields, severity_label};
use crate::tasks::{TaskCounts, TaskDocument, TaskEntry};
use crate::validate::{Severity, ValidationReport};

/// The `tasks` result for a document without task entries.
const NO_TASKS: &str = "No tasks.";

/// The `next` result when every childless entry is completed.
const NO_INCOMPLETE_TASK: &str = "No incomplete task.";

/// The indentation applied to one entry, two spaces per level below the first.
fn indent(level: u8) -> String {
    "  ".repeat(level.saturating_sub(1) as usize)
}

/// Append the single-line entry form that `tasks` and `next` share.
fn push_entry_line(rendered: &mut String, entry: &TaskEntry) {
    let fields = entry_fields(entry);
    rendered.push_str(&indent(entry.id.level));
    rendered.push_str(fields.id);
    rendered.push(' ');
    rendered.push_str(fields.description);
    rendered.push_str(" [");
    rendered.push_str(fields.state);
    rendered.push(']');
    if fields.optional {
        rendered.push_str(" (optional)");
    }
    if let Some(reason) = fields.blocked_reason {
        rendered.push_str(" - blocked: ");
        rendered.push_str(reason);
    }
    rendered.push('\n');
}

/// The singular or plural noun for a summary count.
const fn noun(count: usize, singular: &'static str, plural: &'static str) -> &'static str {
    if count == 1 {
        singular
    } else {
        plural
    }
}

/// Render `tasks`: one line per entry in document order, subtasks indented.
///
/// The spec name is part of the shared renderer signature but the human task
/// listing never prints it.
pub fn render_tasks(document: &TaskDocument, _spec: &str) -> String {
    if document.entries().is_empty() {
        return format!("{NO_TASKS}\n");
    }
    let mut rendered = String::new();
    for entry in document.entries() {
        push_entry_line(&mut rendered, entry);
    }
    rendered
}

/// Render `next`: the selected entry's single-line form, or the empty result.
pub fn render_next(entry: Option<&TaskEntry>, _spec: &str) -> String {
    match entry {
        Some(entry) => {
            let mut rendered = String::new();
            push_entry_line(&mut rendered, entry);
            rendered
        }
        None => format!("{NO_INCOMPLETE_TASK}\n"),
    }
}

/// Render `status` as the six documented lines, in order.
pub fn render_status(stage: &str, counts: &TaskCounts, spec: &str) -> String {
    format!(
        "spec: {spec}\n\
         stage: {stage}\n\
         total: {total}\n\
         completed: {completed}\n\
         pending: {pending} (optional: {optional_pending})\n\
         blocked: {blocked}\n",
        total = counts.total,
        completed = counts.completed,
        pending = counts.pending,
        optional_pending = counts.optional_pending,
        blocked = counts.blocked,
    )
}

/// Render `validate`: each finding in the report's order, then the summary.
pub fn render_validation(report: &ValidationReport, _spec: &str) -> String {
    let mut rendered = String::new();
    let mut errors = 0;
    let mut warnings = 0;
    for finding in &report.findings {
        match finding.severity {
            Severity::Error => errors += 1,
            Severity::Warning => warnings += 1,
        }
        match finding.line {
            Some(line) => rendered.push_str(&format!(
                "{}:{}: {} [{}] {}\n",
                finding.file,
                line,
                severity_label(finding.severity),
                finding.code,
                finding.message
            )),
            None => rendered.push_str(&format!(
                "{}: {} [{}] {}\n",
                finding.file,
                severity_label(finding.severity),
                finding.code,
                finding.message
            )),
        }
    }
    rendered.push_str(&format!(
        "{errors} {}, {warnings} {}\n",
        noun(errors, "error", "errors"),
        noun(warnings, "warning", "warnings")
    ));
    rendered
}

#[cfg(test)]
mod tests {
    use crate::tasks::{parse_tasks, TaskDocument};
    use crate::validate::{Finding, Severity, ValidationReport};

    fn report(findings: Vec<Finding>) -> ValidationReport {
        ValidationReport { findings }
    }

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

    fn document(source: &str) -> TaskDocument {
        parse_tasks(source)
    }

    #[test]
    fn tasks_renders_every_entry_shape_in_document_order() {
        let doc = document(concat!(
            "- [ ] 1. Foundation\n",
            "- [ ]* 1.1 Optional pending\n",
            "- [x] 1.2 Completed\n",
            "- [!]* 1.3 Blocked work\n",
            "  - _Blocked: Waiting on credentials_\n",
            "- [!] 2. Blocked major\n",
            "  - _Blocked: Needs a decision_\n",
            "- [x] 3. Done major\n",
        ));

        assert_eq!(
            super::render_tasks(&doc, "example"),
            concat!(
                "1 Foundation [pending]\n",
                "  1.1 Optional pending [pending] (optional)\n",
                "  1.2 Completed [completed]\n",
                "  1.3 Blocked work [blocked] (optional) - blocked: Waiting on credentials\n",
                "2 Blocked major [blocked] - blocked: Needs a decision\n",
                "3 Done major [completed]\n",
            )
        );
    }

    #[test]
    fn tasks_renders_no_tasks_for_an_empty_document() {
        assert_eq!(
            super::render_tasks(&document("# Implementation Plan\n"), "example"),
            "No tasks.\n"
        );
    }

    #[test]
    fn a_blocked_entry_without_a_reason_omits_the_reason_suffix() {
        let doc = document("- [!] 1. Blocked without reason\n");

        assert_eq!(
            super::render_tasks(&doc, "example"),
            "1 Blocked without reason [blocked]\n"
        );
    }

    #[test]
    fn next_renders_the_selected_entry_line() {
        let pending = document("- [ ] 1. Do work\n");
        assert_eq!(
            super::render_next(pending.next_actionable(), "example"),
            "1 Do work [pending]\n"
        );

        let blocked = document(concat!(
            "- [!]* 1. Do work\n",
            "  - _Blocked: Waiting on credentials_\n",
        ));
        assert_eq!(
            super::render_next(blocked.next_actionable(), "example"),
            "1 Do work [blocked] (optional) - blocked: Waiting on credentials\n"
        );
    }

    #[test]
    fn next_renders_no_incomplete_task_when_none_is_actionable() {
        let completed = document("- [x] 1. Done\n");
        assert_eq!(
            super::render_next(completed.next_actionable(), "example"),
            "No incomplete task.\n"
        );
        assert_eq!(
            super::render_next(document("").next_actionable(), "example"),
            "No incomplete task.\n"
        );
    }

    #[test]
    fn status_renders_exactly_the_six_documented_lines() {
        let doc = document(concat!(
            "- [ ]* 1. Pending optional\n",
            "- [x] 2. Completed\n",
            "- [!] 3. Blocked\n",
        ));

        assert_eq!(
            super::render_status("tasks-generated", &doc.counts(), "example"),
            concat!(
                "spec: example\n",
                "stage: tasks-generated\n",
                "total: 3\n",
                "completed: 1\n",
                "pending: 1 (optional: 1)\n",
                "blocked: 1\n",
            )
        );
    }

    #[test]
    fn validation_renders_line_and_file_findings_then_a_summary() {
        let rendered = super::render_validation(
            &report(vec![
                finding(
                    Severity::Error,
                    "tasks.id.depth",
                    "task identifier `1.2.3` has more than two numeric levels",
                    "tasks.md",
                    Some(12),
                ),
                finding(
                    Severity::Warning,
                    "spec.field.missing",
                    "required field `language` is missing",
                    "spec.json",
                    None,
                ),
            ]),
            "example",
        );

        assert_eq!(
            rendered,
            concat!(
                "tasks.md:12: error [tasks.id.depth] task identifier `1.2.3` has more than two numeric levels\n",
                "spec.json: warning [spec.field.missing] required field `language` is missing\n",
                "1 error, 1 warning\n",
            )
        );
    }

    #[test]
    fn validation_summary_uses_singular_nouns_at_one() {
        let one_error = report(vec![finding(
            Severity::Error,
            "spec.json.parse",
            "spec.json is not valid JSON",
            "spec.json",
            None,
        )]);
        assert!(super::render_validation(&one_error, "example").ends_with("1 error, 0 warnings\n"));

        let one_warning = report(vec![finding(
            Severity::Warning,
            "tasks.line.unnumbered",
            "checkbox line has no numeric identifier",
            "tasks.md",
            Some(3),
        )]);
        assert!(
            super::render_validation(&one_warning, "example").ends_with("0 errors, 1 warning\n")
        );

        assert_eq!(
            super::render_validation(&report(Vec::new()), "example"),
            "0 errors, 0 warnings\n"
        );
    }

    #[test]
    fn renderings_are_repeatable_and_free_of_ansi_escapes() {
        let doc = document(concat!(
            "- [ ] 1. Foundation\n",
            "- [x] 1.1 Done child\n",
            "- [!]* 1.2 Blocked child\n",
            "  - _Blocked: Waiting_\n",
        ));
        let findings = report(vec![finding(
            Severity::Error,
            "tasks.line.malformed",
            "checkbox line does not match the supported task grammar",
            "tasks.md",
            Some(4),
        )]);

        let rendered = [
            super::render_tasks(&doc, "example"),
            super::render_next(doc.next_actionable(), "example"),
            super::render_status("tasks-generated", &doc.counts(), "example"),
            super::render_validation(&findings, "example"),
        ];
        for text in rendered {
            assert!(!text.contains('\u{1b}'), "no ANSI escape may be emitted");
            assert!(text.ends_with('\n'));
        }

        assert_eq!(
            super::render_tasks(&doc, "example"),
            super::render_tasks(&doc, "example"),
            "repeated rendering must be byte-identical"
        );
    }
}
