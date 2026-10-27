//! Validation rules, findings, and deterministic report ordering.
//!
//! A finding carries a spec-relative file name: `spec.json`, `tasks.md`,
//! `requirements.md`, or another artifact name inside the spec directory, never
//! a joined filesystem path. Every rule set returns findings whose order is
//! fully described by [`Finding::sort_key`], and [`ValidationReport::sort`]
//! applies that order once so renderers and callers never re-sort.

use std::cmp::Ordering;

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

#[cfg(test)]
mod tests {
    use super::*;

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
        let errors = ValidationReport {
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
            errors.has_errors(),
            "one error finding makes the report invalid"
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
}
