use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ErrorCategory {
    Usage,
    Resolution,
    ArtifactRead,
    Validation,
    MutationConflict,
    MutationWrite,
}

impl ErrorCategory {
    pub fn exit_code(self) -> i32 {
        match self {
            Self::Usage => 2,
            Self::Resolution
            | Self::ArtifactRead
            | Self::Validation
            | Self::MutationConflict
            | Self::MutationWrite => 1,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppError {
    category: ErrorCategory,
    context: String,
    detail: String,
}

impl AppError {
    pub fn new(
        category: ErrorCategory,
        context: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            category,
            context: context.into(),
            detail: detail.into(),
        }
    }

    pub fn usage(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Usage, context, detail)
    }

    pub fn validation(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Validation, context, detail)
    }

    pub fn category(&self) -> ErrorCategory {
        self.category
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn exit_code(&self) -> i32 {
        self.category.exit_code()
    }

    pub fn diagnostic(&self) -> String {
        format!("kiro-spec: {}: {}", self.context, self.detail)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "kiro-spec: {}: {}", self.context, self.detail)
    }
}

impl std::error::Error for AppError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpecError {
    category: ErrorCategory,
    context: String,
    detail: String,
}

impl SpecError {
    fn new(
        category: ErrorCategory,
        context: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            category,
            context: context.into(),
            detail: detail.into(),
        }
    }

    pub fn resolution(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Resolution, context, detail)
    }

    pub fn read(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::ArtifactRead, context, detail)
    }

    pub fn category(&self) -> ErrorCategory {
        self.category
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn exit_code(&self) -> i32 {
        self.category.exit_code()
    }

    pub fn into_app(self) -> AppError {
        AppError::new(self.category, self.context, self.detail)
    }
}

impl From<SpecError> for AppError {
    fn from(error: SpecError) -> Self {
        error.into_app()
    }
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "kiro-spec: {}: {}", self.context, self.detail)
    }
}

impl std::error::Error for SpecError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationError {
    category: ErrorCategory,
    context: String,
    detail: String,
}

impl MutationError {
    fn new(
        category: ErrorCategory,
        context: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            category,
            context: context.into(),
            detail: detail.into(),
        }
    }

    pub fn conflict(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::MutationConflict, context, detail)
    }

    pub fn write(context: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(ErrorCategory::MutationWrite, context, detail)
    }

    pub fn category(&self) -> ErrorCategory {
        self.category
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn exit_code(&self) -> i32 {
        self.category.exit_code()
    }

    pub fn into_app(self) -> AppError {
        AppError::new(self.category, self.context, self.detail)
    }
}

impl From<MutationError> for AppError {
    fn from(error: MutationError) -> Self {
        error.into_app()
    }
}

impl fmt::Display for MutationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "kiro-spec: {}: {}", self.context, self.detail)
    }
}

impl std::error::Error for MutationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_category_maps_to_exit_two() {
        assert_eq!(ErrorCategory::Usage.exit_code(), 2);
        assert_eq!(
            AppError::usage("usage", "missing subcommand").exit_code(),
            2
        );
    }

    #[test]
    fn non_usage_categories_map_to_exit_one() {
        for category in [
            ErrorCategory::Resolution,
            ErrorCategory::ArtifactRead,
            ErrorCategory::Validation,
            ErrorCategory::MutationConflict,
            ErrorCategory::MutationWrite,
        ] {
            assert_eq!(category.exit_code(), 1, "{category:?}");
            assert_eq!(
                AppError::new(category, "context", "detail").exit_code(),
                1,
                "{category:?}"
            );
        }
    }

    #[test]
    fn diagnostic_uses_required_format() {
        let error = AppError::new(
            ErrorCategory::ArtifactRead,
            ".kiro/specs/demo/tasks.md",
            "missing",
        );
        assert_eq!(
            error.diagnostic(),
            "kiro-spec: .kiro/specs/demo/tasks.md: missing"
        );
        assert_eq!(
            error.to_string(),
            "kiro-spec: .kiro/specs/demo/tasks.md: missing"
        );
    }

    #[test]
    fn spec_errors_carry_categories_and_convert() {
        let resolution =
            SpecError::resolution(".kiro/specs/demo", "not a directory").into_app();
        assert_eq!(resolution.category(), ErrorCategory::Resolution);
        assert_eq!(resolution.context(), ".kiro/specs/demo");
        assert_eq!(resolution.detail(), "not a directory");
        assert_eq!(resolution.exit_code(), 1);

        let read = SpecError::read(".kiro/specs/demo/spec.json", "invalid json").into_app();
        assert_eq!(read.category(), ErrorCategory::ArtifactRead);
        assert_eq!(read.exit_code(), 1);
    }

    #[test]
    fn mutation_errors_carry_categories_and_convert() {
        let conflict = MutationError::conflict("task 2.3", "unknown identifier").into_app();
        assert_eq!(conflict.category(), ErrorCategory::MutationConflict);
        assert_eq!(conflict.context(), "task 2.3");
        assert_eq!(conflict.exit_code(), 1);

        let write = MutationError::write("tasks.md", "rename failed").into_app();
        assert_eq!(write.category(), ErrorCategory::MutationWrite);
        assert_eq!(write.exit_code(), 1);
    }
}
