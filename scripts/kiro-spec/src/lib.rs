pub mod cli;
pub mod edit;
pub mod error;
pub mod paths;
pub mod render;
pub mod requirements;
pub mod spec_json;
pub mod tasks;
pub mod validate;

use std::ffi::OsString;
use std::io::Write;
use std::path::Path;

use crate::cli::{Command, Invocation};
use crate::edit::Change;
use crate::error::{AppError, ErrorCategory, SpecError};
use crate::paths::SpecPaths;
use crate::render::Format;
use crate::tasks::{parse_tasks, TaskDocument};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Outcome {
    stdout: Option<String>,
    stderr: Option<String>,
    code: i32,
}

impl Outcome {
    pub fn new(stdout: Option<String>, stderr: Option<String>, code: i32) -> Self {
        Self {
            stdout,
            stderr,
            code,
        }
    }

    pub fn success(stdout: Option<String>) -> Self {
        Self::new(stdout, None, 0)
    }

    pub fn failure(error: AppError) -> Self {
        Self::new(None, Some(format!("{}\n", error.diagnostic())), error.exit_code())
    }

    pub fn stdout(&self) -> Option<&str> {
        self.stdout.as_deref()
    }

    pub fn stderr(&self) -> Option<&str> {
        self.stderr.as_deref()
    }

    pub fn stdout_bytes(&self) -> &[u8] {
        self.stdout.as_deref().unwrap_or("").as_bytes()
    }

    pub fn code(&self) -> i32 {
        self.code
    }

    pub fn emit(&self) {
        if let Some(stderr) = &self.stderr {
            let mut handle = std::io::stderr().lock();
            let _ = handle.write_all(stderr.as_bytes());
            let _ = handle.flush();
        }
        if let Some(stdout) = &self.stdout {
            let mut handle = std::io::stdout().lock();
            let _ = handle.write_all(stdout.as_bytes());
            let _ = handle.flush();
        }
    }
}

pub fn execute(args: impl IntoIterator<Item = OsString>) -> Outcome {
    match cli::parse(args.into_iter().skip(1)) {
        Ok(cli::Parsed::Help) => Outcome::success(Some(cli::help_text().to_owned())),
        Ok(cli::Parsed::Version) => Outcome::success(Some(cli::version_text())),
        Ok(cli::Parsed::Run(invocation)) => dispatch(&invocation),
        Err(error) => Outcome::failure(error),
    }
}

fn dispatch(invocation: &Invocation) -> Outcome {
    let result = match invocation.command() {
        Command::Tasks => read_tasks(invocation),
        Command::Next => read_next(invocation),
        Command::Status => read_status(invocation),
        Command::Validate => return run_validate(invocation),
        Command::Complete { task } => return run_mutation(invocation, task, Change::Complete),
        Command::Block { task, reason } => {
            return run_mutation(
                invocation,
                task,
                Change::Block {
                    reason: reason.clone(),
                },
            )
        }
    };
    match result {
        Ok(stdout) => Outcome::success(Some(stdout)),
        Err(error) => Outcome::failure(error),
    }
}

fn run_validate(invocation: &Invocation) -> Outcome {
    let paths = match SpecPaths::resolve(invocation.root(), invocation.spec()) {
        Ok(paths) => paths,
        Err(error) => return Outcome::failure(error.into()),
    };
    let report = validate::validate(&paths);
    let document = render::render_validation(&report, paths.name(), selected_format(invocation));
    let code = if report.has_errors() { 1 } else { 0 };
    Outcome::new(Some(document), None, code)
}

fn run_mutation(invocation: &Invocation, task: &str, change: Change) -> Outcome {
    if let Err(error) = validate_task_id(task) {
        return Outcome::failure(error);
    }
    let change = match change {
        Change::Complete => Change::Complete,
        Change::Block { reason } => match validate_reason(&reason) {
            Ok(reason) => Change::Block { reason },
            Err(error) => return Outcome::failure(error),
        },
    };
    let paths = match SpecPaths::resolve(invocation.root(), invocation.spec()) {
        Ok(paths) => paths,
        Err(error) => return Outcome::failure(error.into()),
    };
    let document = match read_task_document_at(&paths) {
        Ok(document) => document,
        Err(error) => return Outcome::failure(error),
    };
    let plan = match edit::mutate(&document, task, change) {
        Ok(plan) => plan,
        Err(error) => return Outcome::failure(error.into()),
    };
    if let Some(bytes) = plan.bytes.as_deref() {
        if let Err(error) = edit::write_atomic(&paths.tasks_md(), bytes) {
            return Outcome::failure(error.into());
        }
    }
    let mut result = format!("{} {}", plan.id, render::state_name(plan.state));
    if plan.bytes.is_none() {
        result.push_str(" (no change)");
    }
    result.push('\n');
    Outcome::success(Some(result))
}

fn validate_task_id(task: &str) -> Result<(), AppError> {
    let canonical = task.strip_suffix('.').unwrap_or(task);
    let parts: Vec<&str> = canonical.split('.').collect();
    let valid = !parts.is_empty()
        && parts.len() <= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    if valid {
        Ok(())
    } else {
        Err(AppError::usage(
            "usage",
            format!("malformed task identifier `{task}`; expected `N` or `N.M`"),
        ))
    }
}

fn validate_reason(reason: &str) -> Result<String, AppError> {
    let trimmed = reason.trim();
    let has_line_break = trimmed.chars().any(|character| {
        matches!(
            character,
            '\n' | '\r' | '\u{000B}' | '\u{000C}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
        )
    });
    if trimmed.is_empty() || has_line_break {
        return Err(AppError::usage(
            "usage",
            "invalid `--reason`: must be non-empty after trimming and contain no line break",
        ));
    }
    Ok(trimmed.to_owned())
}

fn read_tasks(invocation: &Invocation) -> Result<String, AppError> {
    let (paths, document) = read_task_document(invocation)?;
    Ok(render::render_tasks(
        &document,
        paths.name(),
        selected_format(invocation),
    ))
}

fn read_next(invocation: &Invocation) -> Result<String, AppError> {
    let (paths, document) = read_task_document(invocation)?;
    Ok(render::render_next(
        document.next_actionable(),
        paths.name(),
        selected_format(invocation),
    ))
}

fn read_status(invocation: &Invocation) -> Result<String, AppError> {
    let paths = SpecPaths::resolve(invocation.root(), invocation.spec())?;
    let spec_json_path = paths.spec_json();
    let value = spec_json::read_value(&spec_json_path)?;
    let phase =
        spec_json::phase_of(&value).map_err(|error| named_artifact(&spec_json_path, error))?;
    let document = read_task_document_at(&paths)?;
    Ok(render::render_status(
        &phase,
        &document.counts(),
        paths.name(),
        selected_format(invocation),
    ))
}

fn named_artifact(path: &Path, error: SpecError) -> AppError {
    AppError::new(
        error.category(),
        path.display().to_string(),
        error.detail().to_string(),
    )
}

fn read_task_document(invocation: &Invocation) -> Result<(SpecPaths, TaskDocument), AppError> {
    let paths = SpecPaths::resolve(invocation.root(), invocation.spec())?;
    let document = read_task_document_at(&paths)?;
    Ok((paths, document))
}

fn read_task_document_at(paths: &SpecPaths) -> Result<TaskDocument, AppError> {
    let path = paths.tasks_md();
    let context = path.display().to_string();
    let bytes = std::fs::read(&path).map_err(|error| {
        AppError::new(
            ErrorCategory::ArtifactRead,
            context.clone(),
            format!("cannot read file: {error}"),
        )
    })?;
    let text = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorCategory::ArtifactRead,
            context,
            "file is not valid UTF-8",
        )
    })?;
    Ok(parse_tasks(&text))
}

fn selected_format(invocation: &Invocation) -> Format {
    if invocation.json() {
        Format::Json
    } else {
        Format::Human
    }
}

pub fn run(args: impl IntoIterator<Item = OsString>) -> i32 {
    let outcome = execute(args);
    outcome.emit();
    outcome.code()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    #[test]
    fn success_outcome_exits_zero() {
        let outcome = Outcome::success(Some("result\n".to_owned()));
        assert_eq!(outcome.code(), 0);
        assert_eq!(outcome.stdout(), Some("result\n"));
        assert_eq!(outcome.stderr(), None);
    }

    #[test]
    fn failure_outcome_emits_nothing_on_stdout() {
        let outcome = Outcome::failure(AppError::usage("usage", "missing subcommand"));
        assert_eq!(outcome.code(), 2);
        assert_eq!(outcome.stdout(), None);
        assert_eq!(outcome.stdout_bytes().len(), 0);
        assert_eq!(
            outcome.stderr(),
            Some("kiro-spec: usage: missing subcommand\n")
        );
    }

    #[test]
    fn validation_failure_keeps_complete_result_on_stdout() {
        let outcome = Outcome::new(Some("{}\n".to_owned()), None, 1);
        assert_eq!(outcome.code(), 1);
        assert_eq!(outcome.stdout(), Some("{}\n"));
        assert_eq!(outcome.stderr(), None);
    }

    #[test]
    fn execute_without_arguments_is_a_usage_failure_with_no_stdout() {
        let outcome = execute(std::iter::empty::<OsString>());
        assert_eq!(outcome.code(), 2);
        assert_eq!(outcome.stdout(), None);
        assert!(outcome.stderr().unwrap().starts_with("kiro-spec: "));
    }

    #[test]
    fn execute_with_unknown_arguments_is_a_usage_failure_with_no_stdout() {
        let outcome = execute([OsString::from("unknown")]);
        assert_eq!(outcome.code(), 2);
        assert_eq!(outcome.stdout(), None);
    }

    #[test]
    fn execute_skips_the_program_name() {
        let outcome = execute([
            OsString::from("kiro-spec"),
            OsString::from("--spec"),
            OsString::from(".."),
            OsString::from("validate"),
        ]);
        assert_eq!(outcome.code(), 1);
        assert_eq!(outcome.stdout(), None);
        assert_eq!(
            outcome.stderr(),
            Some(
                "kiro-spec: --spec \"..\": requires a relative single path component (`--spec <name>`)\n"
            )
        );
    }
}
