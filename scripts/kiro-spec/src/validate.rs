#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Finding {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    pub file: String,
    pub line: Option<usize>,
}

impl Finding {
    pub fn error(
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self::new(Severity::Error, code, message, file, line)
    }

    pub fn warning(
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self::new(Severity::Warning, code, message, file, line)
    }

    fn new(
        severity: Severity,
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self {
            severity,
            code,
            message: message.into(),
            file: file.into(),
            line,
        }
    }
}
