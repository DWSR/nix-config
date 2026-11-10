pub mod json;

use serde::Serialize;

use crate::tasks::{TaskEntry, TaskState};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    Human,
    Json,
}

pub const JSON_SCHEMA_VERSION: u32 = 1;

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
    use crate::tasks::parse_tasks;

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
}
