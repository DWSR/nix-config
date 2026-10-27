//! Output rendering: the format selector and shared result field access.
//!
//! Human and JSON renderers read the same model through [`entry_fields`] and
//! [`severity_label`], so neither re-derives task state or finding severity.

use crate::tasks::TaskEntry;
use crate::validate::Severity;

pub mod human;
pub mod json;

/// The output format selected for a command result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    /// Plain text for humans.
    Human,
    /// The schema-versioned JSON document.
    Json,
}

/// The JSON schema version every rendered document declares.
pub const JSON_SCHEMA_VERSION: u32 = 1;

/// The task entry attributes shared by every rendering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EntryFields<'a> {
    /// Canonical dotted identifier.
    pub id: &'a str,
    /// The trimmed description text.
    pub description: &'a str,
    /// `pending`, `completed`, or `blocked`.
    pub state: &'static str,
    /// Whether the entry carried the `*` optional marker.
    pub optional: bool,
    /// The joined reason of a blocked entry.
    pub blocked_reason: Option<&'a str>,
}

/// Read the shared entry fields from the parsed task model.
pub fn entry_fields(entry: &TaskEntry) -> EntryFields<'_> {
    EntryFields {
        id: &entry.id.text,
        description: &entry.description,
        state: entry.state.as_str(),
        optional: entry.optional,
        blocked_reason: entry.blocked_reason.as_deref(),
    }
}

/// The lowercase severity name used by both renderers.
pub const fn severity_label(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::parse_tasks;
    use crate::validate::Severity;

    #[test]
    fn entry_fields_expose_the_shared_entry_contract() {
        let doc = parse_tasks(concat!(
            "- [!]* 2.1 Blocked work\n",
            "  - _Blocked: Waiting on credentials_\n",
            "- [x] 2.2 Done\n",
        ));

        let blocked = entry_fields(&doc.entries()[0]);
        assert_eq!(blocked.id, "2.1");
        assert_eq!(blocked.description, "Blocked work");
        assert_eq!(blocked.state, "blocked");
        assert!(blocked.optional);
        assert_eq!(blocked.blocked_reason, Some("Waiting on credentials"));

        let completed = entry_fields(&doc.entries()[1]);
        assert_eq!(completed.id, "2.2");
        assert_eq!(completed.description, "Done");
        assert_eq!(completed.state, "completed");
        assert!(!completed.optional);
        assert_eq!(completed.blocked_reason, None);
    }

    #[test]
    fn severity_labels_are_the_lowercase_schema_names() {
        assert_eq!(severity_label(Severity::Error), "error");
        assert_eq!(severity_label(Severity::Warning), "warning");
    }
}
