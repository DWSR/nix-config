//! Validation rules, findings, and deterministic report ordering.

/// The severity of one validation finding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
