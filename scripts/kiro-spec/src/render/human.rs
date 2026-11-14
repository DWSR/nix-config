use std::fmt::Write;

use crate::render::state_name;
use crate::tasks::{TaskCounts, TaskDocument, TaskEntry, TaskState};
use crate::validate::{Severity, ValidationReport};

pub fn render_tasks(doc: &TaskDocument) -> String {
    if doc.entries().is_empty() {
        return "No tasks.\n".to_owned();
    }
    let mut text = String::new();
    for entry in doc.entries() {
        text.push_str(&entry_line(entry));
        text.push('\n');
    }
    text
}

pub fn render_next(entry: Option<&TaskEntry>) -> String {
    match entry {
        Some(entry) => {
            let mut text = entry_line(entry);
            text.push('\n');
            text
        }
        None => "No incomplete task.\n".to_owned(),
    }
}

pub fn render_status(stage: &str, counts: &TaskCounts, spec: &str) -> String {
    format!(
        "spec: {spec}\nstage: {stage}\ntotal: {}\ncompleted: {}\npending: {} (optional: {})\nblocked: {}\n",
        counts.total, counts.completed, counts.pending, counts.optional_pending, counts.blocked
    )
}

pub fn render_validation(report: &ValidationReport) -> String {
    let mut text = String::new();
    let mut errors = 0usize;
    let mut warnings = 0usize;
    for finding in &report.findings {
        let severity = match finding.severity {
            Severity::Error => {
                errors += 1;
                "error"
            }
            Severity::Warning => {
                warnings += 1;
                "warning"
            }
        };
        match finding.line {
            Some(line) => {
                let _ = writeln!(
                    text,
                    "{}:{}: {} [{}] {}",
                    finding.file, line, severity, finding.code, finding.message
                );
            }
            None => {
                let _ = writeln!(
                    text,
                    "{}: {} [{}] {}",
                    finding.file, severity, finding.code, finding.message
                );
            }
        }
    }
    let error_noun = if errors == 1 { "error" } else { "errors" };
    let warning_noun = if warnings == 1 { "warning" } else { "warnings" };
    let _ = writeln!(text, "{errors} {error_noun}, {warnings} {warning_noun}");
    text
}

fn entry_line(entry: &TaskEntry) -> String {
    let indent = "  ".repeat(usize::from(entry.level().saturating_sub(1)));
    let mut line = format!(
        "{indent}{} {} [{}]",
        entry.id(),
        entry.description(),
        state_name(entry.state())
    );
    if entry.optional() {
        line.push_str(" (optional)");
    }
    if entry.state() == TaskState::Blocked {
        if let Some(reason) = entry.blocked_reason() {
            line.push_str(" - blocked: ");
            line.push_str(reason);
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{parse_tasks, TaskCounts};
    use crate::validate::Finding;

    fn tasks(text: &str) -> String {
        render_tasks(&parse_tasks(text))
    }

    #[test]
    fn pending_major_entry_renders_one_line() {
        assert_eq!(tasks("- [ ] 1. Foundation\n"), "1 Foundation [pending]\n");
    }

    #[test]
    fn optional_pending_entry_appends_the_optional_suffix() {
        assert_eq!(
            tasks("- [ ]* 2. Polish\n"),
            "2 Polish [pending] (optional)\n"
        );
    }

    #[test]
    fn completed_entry_renders_completed_state() {
        assert_eq!(tasks("- [x] 3. Done\n"), "3 Done [completed]\n");
    }

    #[test]
    fn optional_completed_entry_keeps_both_annotations() {
        assert_eq!(
            tasks("- [x]* 3. Done\n"),
            "3 Done [completed] (optional)\n"
        );
    }

    #[test]
    fn blocked_entry_appends_its_reason() {
        assert_eq!(
            tasks("- [!] 4. Wait\n  - _Blocked: Waiting on credentials_\n"),
            "4 Wait [blocked] - blocked: Waiting on credentials\n"
        );
    }

    #[test]
    fn optional_blocked_entry_orders_optional_before_the_reason() {
        assert_eq!(
            tasks("- [!]* 5. Wait\n  - _Blocked: Waiting on credentials_\n"),
            "5 Wait [blocked] (optional) - blocked: Waiting on credentials\n"
        );
    }

    #[test]
    fn blocked_entry_without_a_reason_has_no_reason_suffix() {
        assert_eq!(tasks("- [!] 6. Stuck\n"), "6 Stuck [blocked]\n");
    }

    #[test]
    fn subtasks_indent_two_spaces_per_level_in_document_order() {
        let text = "- [ ] 1. Build\n- [ ] 1.2 Detail\n- [ ] 1.10 Another\n- [ ] 2. Next\n";
        assert_eq!(
            tasks(text),
            "1 Build [pending]\n  1.2 Detail [pending]\n  1.10 Another [pending]\n2 Next [pending]\n"
        );
    }

    #[test]
    fn empty_document_prints_no_tasks() {
        assert_eq!(tasks(""), "No tasks.\n");
    }

    #[test]
    fn every_entry_line_is_terminated_even_the_last() {
        let text = tasks("- [ ] 1. One\n- [ ] 2. Two\n");
        assert!(text.ends_with("[pending]\n"));
        assert!(!text.ends_with("\n\n"));
        assert_eq!(text.matches('\n').count(), 2);
    }

    #[test]
    fn next_prints_no_incomplete_task_when_none_is_actionable() {
        assert_eq!(render_next(None), "No incomplete task.\n");
    }

    #[test]
    fn next_prints_the_single_selected_entry_line() {
        let document = parse_tasks("- [x] 1. Done\n- [ ] 2. Next up\n");
        assert_eq!(
            render_next(document.next_actionable()),
            "2 Next up [pending]\n"
        );
    }

    #[test]
    fn next_keeps_a_blocked_reason_on_the_selected_line() {
        let document = parse_tasks("- [!] 2. Waiting\n  - _Blocked: Waiting on credentials_\n");
        assert_eq!(
            render_next(document.next_actionable()),
            "2 Waiting [blocked] - blocked: Waiting on credentials\n"
        );
    }

    #[test]
    fn status_prints_exactly_the_six_documented_lines() {
        let counts = TaskCounts {
            total: 5,
            completed: 1,
            pending: 2,
            blocked: 2,
            optional_pending: 1,
        };
        assert_eq!(
            render_status("tasks-generated", &counts, "demo"),
            "spec: demo\nstage: tasks-generated\ntotal: 5\ncompleted: 1\npending: 2 (optional: 1)\nblocked: 2\n"
        );
    }

    #[test]
    fn status_prints_zero_counts_and_zero_optional_pending() {
        let counts = TaskCounts::default();
        assert_eq!(
            render_status("initialized", &counts, "empty"),
            "spec: empty\nstage: initialized\ntotal: 0\ncompleted: 0\npending: 0 (optional: 0)\nblocked: 0\n"
        );
    }

    #[test]
    fn validation_prints_file_line_and_summary_in_given_order() {
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
        assert_eq!(
            render_validation(&report),
            "spec.json: error [spec.field.missing] required field `language` is missing\n\
             tasks.md:4: warning [tasks.line.unnumbered] checkbox line has no numeric identifier\n\
             1 error, 1 warning\n"
        );
    }

    #[test]
    fn empty_validation_prints_zero_plural_summary() {
        assert_eq!(
            render_validation(&ValidationReport::default()),
            "0 errors, 0 warnings\n"
        );
    }

    #[test]
    fn summaries_use_singular_nouns_exactly_at_one() {
        let one_error = ValidationReport::new(vec![Finding::error(
            "spec.field.missing",
            "missing",
            "spec.json",
            None,
        )]);
        assert!(render_validation(&one_error).ends_with("1 error, 0 warnings\n"));

        let one_warning = ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "unnumbered",
            "tasks.md",
            Some(1),
        )]);
        assert!(render_validation(&one_warning).ends_with("0 errors, 1 warning\n"));

        let two_errors = ValidationReport::new(vec![
            Finding::error("a", "first", "spec.json", None),
            Finding::error("b", "second", "spec.json", None),
        ]);
        assert!(render_validation(&two_errors).ends_with("2 errors, 0 warnings\n"));
    }

    #[test]
    fn validation_with_a_line_uses_the_colon_line_form() {
        let report = ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "checkbox line has no numeric identifier",
            "tasks.md",
            Some(12),
        )]);
        assert_eq!(
            render_validation(&report),
            "tasks.md:12: warning [tasks.line.unnumbered] checkbox line has no numeric identifier\n\
             0 errors, 1 warning\n"
        );
    }

    #[test]
    fn no_rendering_contains_ansi_escapes() {
        let document = parse_tasks(
            "- [ ] 1. Build\n- [ ] 1.2 Detail\n- [x]* 2. Done\n- [!] 3. Wait\n  - _Blocked: reason_\n",
        );
        let counts = document.counts();
        let report = ValidationReport::new(vec![
            Finding::error("spec.field.missing", "missing", "spec.json", None),
            Finding::warning("tasks.line.unnumbered", "unnumbered", "tasks.md", Some(1)),
        ]);
        let outputs = [
            render_tasks(&document),
            render_next(document.next_actionable()),
            render_status("tasks-generated", &counts, "demo"),
            render_validation(&report),
        ];
        for text in outputs {
            assert!(!text.contains('\u{1b}'));
        }
    }
}
