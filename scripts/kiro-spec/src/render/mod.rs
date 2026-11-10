pub mod human;
pub mod json;

use serde::Serialize;

use crate::tasks::{TaskCounts, TaskDocument, TaskEntry, TaskState};
use crate::validate::ValidationReport;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    Human,
    Json,
}

pub const JSON_SCHEMA_VERSION: u32 = 1;

pub fn render_tasks(doc: &TaskDocument, spec: &str, format: Format) -> String {
    match format {
        Format::Human => human::render_tasks(doc),
        Format::Json => json::render_tasks(doc, spec),
    }
}

pub fn render_next(entry: Option<&TaskEntry>, spec: &str, format: Format) -> String {
    match format {
        Format::Human => human::render_next(entry),
        Format::Json => json::render_next(entry, spec),
    }
}

pub fn render_status(stage: &str, counts: &TaskCounts, spec: &str, format: Format) -> String {
    match format {
        Format::Human => human::render_status(stage, counts, spec),
        Format::Json => json::render_status(stage, counts, spec),
    }
}

pub fn render_validation(report: &ValidationReport, spec: &str, format: Format) -> String {
    match format {
        Format::Human => human::render_validation(report),
        Format::Json => json::render_validation(report, spec),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct EntryView<'a> {
    pub id: &'a str,
    pub description: &'a str,
    pub state: &'static str,
    pub optional: bool,
    pub blocked_reason: Option<&'a str>,
}

pub fn entry_view(entry: &TaskEntry) -> EntryView<'_> {
    EntryView {
        id: entry.id(),
        description: entry.description(),
        state: state_name(entry.state()),
        optional: entry.optional(),
        blocked_reason: entry.blocked_reason(),
    }
}

pub fn state_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Pending => "pending",
        TaskState::Completed => "completed",
        TaskState::Blocked => "blocked",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{parse_tasks, TaskCounts};
    use crate::validate::{Finding, ValidationReport};

    #[test]
    fn entry_view_exposes_canonical_fields() {
        let document =
            parse_tasks("- [!]* 7.2 Wait on credentials\n  - _Blocked: Waiting on credentials_\n");
        let view = entry_view(&document.entries()[0]);
        assert_eq!(view.id, "7.2");
        assert_eq!(view.description, "Wait on credentials");
        assert_eq!(view.state, "blocked");
        assert!(view.optional);
        assert_eq!(view.blocked_reason, Some("Waiting on credentials"));
    }

    #[test]
    fn entry_view_maps_every_state_to_a_stable_name() {
        assert_eq!(state_name(TaskState::Pending), "pending");
        assert_eq!(state_name(TaskState::Completed), "completed");
        assert_eq!(state_name(TaskState::Blocked), "blocked");
    }

    const DISPATCH_SPEC: &str = "example";

    fn dispatch_document() -> TaskDocument {
        parse_tasks("- [ ] 1. Foundation\n- [x] 1.1 Pin inputs\n")
    }

    fn dispatch_counts() -> TaskCounts {
        dispatch_document().counts()
    }

    fn dispatch_report() -> ValidationReport {
        ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "checkbox line has no numeric identifier",
            "tasks.md",
            Some(4),
        )])
    }

    #[test]
    fn tasks_dispatch_selects_the_requested_format() {
        let document = dispatch_document();
        assert_eq!(
            render_tasks(&document, DISPATCH_SPEC, Format::Human),
            "1 Foundation [pending]\n  1.1 Pin inputs [completed]\n"
        );
        assert_eq!(
            render_tasks(&document, DISPATCH_SPEC, Format::Json),
            json::render_tasks(&document, DISPATCH_SPEC)
        );
    }

    #[test]
    fn next_dispatch_selects_the_requested_format() {
        let document = parse_tasks("- [ ] 1. Foundation\n- [x] 2. Done\n");
        assert_eq!(
            render_next(document.next_actionable(), DISPATCH_SPEC, Format::Human),
            "1 Foundation [pending]\n"
        );
        assert_eq!(
            render_next(document.next_actionable(), DISPATCH_SPEC, Format::Json),
            json::render_next(document.next_actionable(), DISPATCH_SPEC)
        );
        assert_eq!(
            render_next(None, DISPATCH_SPEC, Format::Human),
            "No incomplete task.\n"
        );
    }

    #[test]
    fn status_dispatch_selects_the_requested_format() {
        let counts = dispatch_counts();
        assert_eq!(
            render_status("tasks-generated", &counts, DISPATCH_SPEC, Format::Human),
            "spec: example\nstage: tasks-generated\ntotal: 2\ncompleted: 1\npending: 1 (optional: 0)\nblocked: 0\n"
        );
        assert_eq!(
            render_status("tasks-generated", &counts, DISPATCH_SPEC, Format::Json),
            json::render_status("tasks-generated", &counts, DISPATCH_SPEC)
        );
    }

    #[test]
    fn validation_dispatch_selects_the_requested_format() {
        let report = dispatch_report();
        assert_eq!(
            render_validation(&report, DISPATCH_SPEC, Format::Human),
            "tasks.md:4: warning [tasks.line.unnumbered] checkbox line has no numeric identifier\n0 errors, 1 warning\n"
        );
        assert_eq!(
            render_validation(&report, DISPATCH_SPEC, Format::Json),
            json::render_validation(&report, DISPATCH_SPEC)
        );
    }
}
