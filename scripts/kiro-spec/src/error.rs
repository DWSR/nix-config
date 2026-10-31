//! Error categories, shared error types, and exit-code mapping.
//!
//! Every failure the CLI reports belongs to exactly one category from the
//! design's error strategy. The category fixes the process exit code and the
//! diagnostic shape, so call sites choose a category once and `run()` can map
//! it without inspecting messages.

use std::fmt;

/// The five failure categories the CLI can report.
///
/// Success is not a category: it is the absence of an error and always exits
/// zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCategory {
    /// Unknown command or option, missing value, malformed task ID or reason.
    Usage,
    /// Invalid spec name or absent spec directory.
    Resolution,
    /// Required artifact missing, unreadable, or invalid for the command.
    Read,
    /// Unknown or ambiguous identifier and unsupported transitions.
    Conflict,
    /// Failed temporary-file creation, write, sync, or rename.
    Write,
}

impl ErrorCategory {
    /// Process exit code for a failure in this category.
    pub const fn exit_code(self) -> i32 {
        match self {
            Self::Usage => 2,
            Self::Resolution | Self::Read | Self::Conflict | Self::Write => 1,
        }
    }
}

/// A spec resolution or artifact-read failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpecError {
    category: ErrorCategory,
    context: String,
    detail: String,
}

impl SpecError {
    /// The spec name or resolved spec directory is unusable.
    pub fn resolution(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Resolution, context, detail)
    }

    /// A required artifact is missing, unreadable, or invalid.
    pub fn read(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Read, context, detail)
    }

    fn new(category: ErrorCategory, context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            category,
            context: context.into(),
            detail: detail.into(),
        }
    }

    /// The category this failure belongs to.
    pub const fn category(&self) -> ErrorCategory {
        self.category
    }

    /// What the diagnostic is about, usually a path or identifier.
    pub fn context(&self) -> &str {
        &self.context
    }

    /// The actionable explanation of the failure.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for SpecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.context, self.detail)
    }
}

impl std::error::Error for SpecError {}

/// A refused or failed `tasks.md` mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationError {
    category: ErrorCategory,
    context: String,
    detail: String,
}

impl MutationError {
    /// The identifier is unknown or ambiguous, or the transition is unsupported.
    pub fn conflict(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Conflict, context, detail)
    }

    /// Publishing the replacement file failed; the original file stays intact.
    pub fn write(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Write, context, detail)
    }

    fn new(category: ErrorCategory, context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            category,
            context: context.into(),
            detail: detail.into(),
        }
    }

    /// The category this failure belongs to.
    pub const fn category(&self) -> ErrorCategory {
        self.category
    }

    /// The identifier or path the diagnostic is about.
    pub fn context(&self) -> &str {
        &self.context
    }

    /// The actionable explanation of the failure.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for MutationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.context, self.detail)
    }
}

impl std::error::Error for MutationError {}

/// Any failure that terminates a command with a non-zero exit code.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppError {
    /// The arguments themselves are unusable.
    Usage { context: String, detail: String },
    /// The spec or one of its artifacts could not be resolved or read.
    Spec(SpecError),
    /// A requested task mutation was refused or could not be published.
    Mutation(MutationError),
}

impl AppError {
    /// A usage failure; rejected before any filesystem access.
    pub fn usage(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Usage {
            context: context.into(),
            detail: detail.into(),
        }
    }

    /// A spec resolution failure.
    pub fn resolution(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Spec(SpecError::resolution(context, detail))
    }

    /// A required artifact could not be read.
    pub fn read(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Spec(SpecError::read(context, detail))
    }

    /// A mutation was refused because of an identifier or transition.
    pub fn conflict(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Mutation(MutationError::conflict(context, detail))
    }

    /// A write failed; the previous file contents remain intact.
    pub fn write(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Mutation(MutationError::write(context, detail))
    }

    /// The category this failure belongs to.
    pub const fn category(&self) -> ErrorCategory {
        match self {
            Self::Usage { .. } => ErrorCategory::Usage,
            Self::Spec(error) => error.category(),
            Self::Mutation(error) => error.category(),
        }
    }

    /// Process exit code for this failure.
    pub const fn exit_code(&self) -> i32 {
        self.category().exit_code()
    }

    /// What the diagnostic is about, usually a path or identifier.
    pub fn context(&self) -> &str {
        match self {
            Self::Usage { context, .. } => context,
            Self::Spec(error) => error.context(),
            Self::Mutation(error) => error.context(),
        }
    }

    /// The actionable explanation of the failure.
    pub fn detail(&self) -> &str {
        match self {
            Self::Usage { detail, .. } => detail,
            Self::Spec(error) => error.detail(),
            Self::Mutation(error) => error.detail(),
        }
    }

    /// The single stderr line for this failure: `kiro-spec: <context>: <detail>`.
    pub fn diagnostic(&self) -> String {
        format!("kiro-spec: {self}")
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.context(), self.detail())
    }
}

impl std::error::Error for AppError {}

impl From<SpecError> for AppError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

impl From<MutationError> for AppError {
    fn from(error: MutationError) -> Self {
        Self::Mutation(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_failures_exit_two_and_every_other_category_exits_one() {
        assert_eq!(ErrorCategory::Usage.exit_code(), 2);
        for category in [
            ErrorCategory::Resolution,
            ErrorCategory::Read,
            ErrorCategory::Conflict,
            ErrorCategory::Write,
        ] {
            assert_eq!(category.exit_code(), 1, "{category:?} must exit 1");
        }
    }

    #[test]
    fn constructors_carry_the_documented_category() {
        assert_eq!(
            AppError::usage("usage", "unknown option `--bogus`").category(),
            ErrorCategory::Usage
        );
        assert_eq!(
            AppError::resolution(".kiro/specs/missing", "spec directory not found").category(),
            ErrorCategory::Resolution
        );
        assert_eq!(
            AppError::read(".kiro/specs/demo/spec.json", "expected value").category(),
            ErrorCategory::Read
        );
        assert_eq!(
            AppError::conflict("7.2", "no task matches this identifier").category(),
            ErrorCategory::Conflict
        );
        assert_eq!(
            AppError::write(".kiro/specs/demo/tasks.md", "permission denied").category(),
            ErrorCategory::Write
        );
    }

    #[test]
    fn app_errors_map_their_category_onto_the_process_exit_code() {
        let cases = [
            (AppError::usage("usage", "unrecognized subcommand"), 2),
            (
                AppError::resolution(".kiro/specs/missing", "spec directory not found"),
                1,
            ),
            (
                AppError::read(".kiro/specs/demo/spec.json", "invalid JSON"),
                1,
            ),
            (AppError::conflict("7.2", "duplicate identifier"), 1),
            (
                AppError::write(".kiro/specs/demo/tasks.md", "rename failed"),
                1,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.exit_code(), expected, "{error:?}");
        }
    }

    #[test]
    fn diagnostic_uses_the_documented_prefix_and_shape() {
        let error = AppError::read(".kiro/specs/demo/tasks.md", "file is not valid UTF-8");
        assert_eq!(
            error.diagnostic(),
            "kiro-spec: .kiro/specs/demo/tasks.md: file is not valid UTF-8"
        );
    }

    #[test]
    fn spec_and_mutation_errors_expose_their_category_and_parts() {
        let spec = SpecError::resolution(".kiro/specs/missing", "not a directory");
        assert_eq!(spec.category(), ErrorCategory::Resolution);
        assert_eq!(spec.context(), ".kiro/specs/missing");
        assert_eq!(spec.detail(), "not a directory");
        assert_eq!(spec.to_string(), ".kiro/specs/missing: not a directory");

        let mutation = MutationError::write(".kiro/specs/demo/tasks.md", "sync failed");
        assert_eq!(mutation.category(), ErrorCategory::Write);
        assert_eq!(mutation.context(), ".kiro/specs/demo/tasks.md");
        assert_eq!(mutation.detail(), "sync failed");

        let conflict = MutationError::conflict("3", "identifier is ambiguous");
        assert_eq!(conflict.category(), ErrorCategory::Conflict);
    }

    #[test]
    fn display_omits_the_tool_prefix_that_diagnostic_adds() {
        let error = AppError::usage("usage", "missing --spec <name>");
        assert_eq!(error.to_string(), "usage: missing --spec <name>");
        assert_eq!(
            error.diagnostic(),
            "kiro-spec: usage: missing --spec <name>"
        );
    }
}
