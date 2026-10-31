//! Argument grammar, help text, subcommand dispatch, and usage diagnostics.
//!
//! Arguments are interpreted completely before any command runs, so an unknown
//! subcommand, an unknown option, a missing value, or a `--json` flag on a
//! mutation is rejected without touching the filesystem. The parser accepts
//! long options as either `--opt value` or `--opt=value`, and the last
//! occurrence of a value option wins.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::edit::{mutate, Change};
use crate::error::AppError;
use crate::paths::SpecPaths;
use crate::render::{human, Format};
use crate::spec_json;
use crate::tasks::{parse_tasks, TaskDocument};
use crate::validate;

/// The single help document, kept in one place so tests can assert it lists
/// every subcommand and option.
pub const HELP_TEXT: &str = "\
Usage:
  kiro-spec [--root <path>] --spec <name> <next|tasks|status|validate> [--json]
  kiro-spec [--root <path>] --spec <name> <complete <task-id>|block <task-id> --reason <text>>

Commands:
  next       Print the next incomplete task entry.
  tasks      List every parsed task entry.
  status     Print task counts and the current stage.
  validate   Report well-formedness findings.
  complete   Mark one task entry completed.
  block      Mark one task entry blocked and record a reason.

Options:
  --root <path>    Repository or worktree root (default: .).
  --spec <name>    Spec directory name beneath <root>/.kiro/specs.
  --json           Emit one JSON document (read commands only).
  --reason <text>  Block reason: one non-empty line (block only).
  -h, --help       Print this help and exit zero.
  -V, --version    Print the version and exit zero.
";

/// The crate version reported by `--version` and `-V`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A subcommand selected by the first positional argument.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Next,
    Tasks,
    Status,
    Validate,
    Complete { task: String },
    Block { task: String, reason: String },
}

impl Command {
    /// Whether this command only reads the spec.
    pub const fn is_read(&self) -> bool {
        matches!(
            self,
            Self::Next | Self::Tasks | Self::Status | Self::Validate
        )
    }
}

/// One fully validated invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invocation {
    /// Repository or worktree root; `.` when `--root` is absent.
    pub root: PathBuf,
    /// Raw `--spec` value, still subject to spec-name validation.
    pub spec: String,
    /// The selected subcommand.
    pub command: Command,
    /// Whether `--json` was requested; only ever true for read commands.
    pub json: bool,
}

/// The result of interpreting argv.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Parsed {
    /// `--help` or `-h` was requested.
    Help,
    /// `--version` or `-V` was requested.
    Version,
    /// A subcommand and its options were accepted.
    Command(Invocation),
}

/// The complete result of one command.
///
/// The document is fully rendered before it is published, so a partially built
/// result can never reach stdout. `exit_code` separates a successful result from
/// a complete validation report that contains error-severity findings; every
/// other failure is an [`AppError`], so this value is always `0` or `1`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Outcome {
    document: Option<String>,
    exit_code: i32,
}

impl Outcome {
    /// A successful command result; `None` means the command has no result.
    pub fn success(document: Option<String>) -> Self {
        Self {
            document,
            exit_code: 0,
        }
    }

    /// A complete validation report whose findings include an error.
    pub fn validation_errors(document: String) -> Self {
        Self {
            document: Some(document),
            exit_code: 1,
        }
    }

    /// The document to publish on stdout, if the command produces one.
    pub fn document(&self) -> Option<&str> {
        self.document.as_deref()
    }

    /// The process exit code for this outcome: `0` or `1`.
    pub const fn exit_code(&self) -> i32 {
        self.exit_code
    }

    /// Consume the outcome and return its document.
    pub fn into_document(self) -> Option<String> {
        self.document
    }
}

/// Interpret an argv sequence, including the leading program name.
///
/// `--help` and `-h` return [`Parsed::Help`], `--version` and `-V` return
/// [`Parsed::Version`], and anything else must be one of the six subcommands
/// with an explicit `--spec`. No filesystem access happens here.
pub fn parse<I>(args: I) -> Result<Parsed, AppError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    let _program = args.next();

    let mut root: Option<PathBuf> = None;
    let mut spec: Option<String> = None;
    let mut json = false;
    let mut reason: Option<String> = None;
    let mut command: Option<String> = None;
    let mut task: Option<String> = None;

    while let Some(token) = args.next() {
        let argument = token
            .into_string()
            .map_err(|_| AppError::usage("usage", "argument is not valid UTF-8"))?;
        match argument.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            "--json" => json = true,
            "--root" => {
                root = Some(PathBuf::from(take_value(&mut args, "--root <path>")?));
            }
            "--spec" => {
                spec = Some(take_value(&mut args, "--spec <name>")?);
            }
            "--reason" => {
                reason = Some(take_value(&mut args, "--reason <text>")?);
            }
            _ if argument.starts_with("--") => {
                let (name, value) = argument
                    .split_once('=')
                    .map_or((argument.as_str(), None), |(name, value)| {
                        (name, Some(value))
                    });
                let inline = value
                    .ok_or_else(|| AppError::usage("usage", format!("unknown option `{name}`")))?;
                match name {
                    "--root" => {
                        root = Some(PathBuf::from(require_non_empty(inline, "--root <path>")?))
                    }
                    "--spec" => spec = Some(require_non_empty(inline, "--spec <name>")?),
                    "--reason" => reason = Some(require_non_empty(inline, "--reason <text>")?),
                    "--json" => {
                        return Err(AppError::usage(
                            "usage",
                            "option `--json` does not take a value",
                        ))
                    }
                    _ => return Err(AppError::usage("usage", format!("unknown option `{name}`"))),
                }
            }
            _ if argument.starts_with('-') && argument != "-" => {
                return Err(AppError::usage(
                    "usage",
                    format!("unknown option `{argument}`"),
                ));
            }
            _ => positional(&argument, &mut command, &mut task)?,
        }
    }

    finish(root, spec, json, reason, command, task)
}

/// Consume the value that follows a space-separated option.
fn take_value<I>(args: &mut I, form: &str) -> Result<String, AppError>
where
    I: Iterator<Item = OsString>,
{
    let raw = args.next().ok_or_else(|| missing_value(form))?;
    let value = raw
        .into_string()
        .map_err(|_| AppError::usage("usage", format!("value for {form} is not valid UTF-8")))?;
    if value.starts_with("--") {
        return Err(missing_value(form));
    }
    require_non_empty(&value, form)
}

fn missing_value(form: &str) -> AppError {
    AppError::usage("usage", format!("missing value for {form}"))
}

fn require_non_empty(value: &str, form: &str) -> Result<String, AppError> {
    if value.is_empty() {
        Err(missing_value(form))
    } else {
        Ok(value.to_string())
    }
}

/// Assign one positional argument to the subcommand or its task identifier.
fn positional(
    argument: &str,
    command: &mut Option<String>,
    task: &mut Option<String>,
) -> Result<(), AppError> {
    if command.is_none() {
        match argument {
            "next" | "tasks" | "status" | "validate" | "complete" | "block" => {
                *command = Some(argument.to_string());
                return Ok(());
            }
            _ => {
                return Err(AppError::usage(
                    "usage",
                    format!("unknown subcommand `{argument}`"),
                ))
            }
        }
    }
    let needs_task = matches!(command.as_deref(), Some("complete" | "block"));
    if needs_task && task.is_none() {
        *task = Some(argument.to_string());
        return Ok(());
    }
    Err(AppError::usage(
        "usage",
        format!("unexpected argument `{argument}`"),
    ))
}

/// Validate the collected pieces and build the invocation.
fn finish(
    root: Option<PathBuf>,
    spec: Option<String>,
    json: bool,
    reason: Option<String>,
    command: Option<String>,
    task: Option<String>,
) -> Result<Parsed, AppError> {
    let spec = spec.ok_or_else(|| AppError::usage("usage", "missing --spec <name>"))?;
    let name = command.ok_or_else(|| {
        AppError::usage(
            "usage",
            "missing subcommand; expected one of next, tasks, status, validate, complete, block",
        )
    })?;

    let command = match name.as_str() {
        "next" => {
            reject_reason(reason)?;
            Command::Next
        }
        "tasks" => {
            reject_reason(reason)?;
            Command::Tasks
        }
        "status" => {
            reject_reason(reason)?;
            Command::Status
        }
        "validate" => {
            reject_reason(reason)?;
            Command::Validate
        }
        "complete" => {
            reject_json_for_mutation(json)?;
            reject_reason(reason)?;
            let task = task.ok_or_else(|| {
                AppError::usage("usage", "missing <task-id> for complete; expected N or N.M")
            })?;
            validate_task_id(&task)?;
            Command::Complete { task }
        }
        "block" => {
            reject_json_for_mutation(json)?;
            let task = task.ok_or_else(|| {
                AppError::usage("usage", "missing <task-id> for block; expected N or N.M")
            })?;
            validate_task_id(&task)?;
            let reason = reason
                .ok_or_else(|| AppError::usage("usage", "missing --reason <text> for block"))?;
            validate_reason(&reason)?;
            Command::Block { task, reason }
        }
        _ => {
            return Err(AppError::usage(
                "usage",
                format!("unknown subcommand `{name}`"),
            ))
        }
    };

    Ok(Parsed::Command(Invocation {
        root: root.unwrap_or_else(|| PathBuf::from(".")),
        spec,
        command,
        json,
    }))
}

fn reject_json_for_mutation(json: bool) -> Result<(), AppError> {
    if json {
        Err(AppError::usage(
            "usage",
            "`--json` is only valid for next, tasks, status, and validate",
        ))
    } else {
        Ok(())
    }
}

fn reject_reason(reason: Option<String>) -> Result<(), AppError> {
    if reason.is_some() {
        Err(AppError::usage(
            "usage",
            "`--reason` is only valid for block",
        ))
    } else {
        Ok(())
    }
}

/// A task identifier is `N` or `N.M`, with one optional trailing `.`.
fn validate_task_id(value: &str) -> Result<(), AppError> {
    let core = value.strip_suffix('.').unwrap_or(value);
    let mut parts = core.split('.');
    let first = parts.next().unwrap_or_default();
    let well_formed = is_digits(first)
        && match parts.next() {
            None => true,
            Some(second) => is_digits(second) && parts.next().is_none(),
        };
    if well_formed {
        Ok(())
    } else {
        Err(AppError::usage(
            "usage",
            format!("invalid task identifier `{value}`; expected N or N.M"),
        ))
    }
}

/// A canonical numeric segment: digits with no leading zero.
fn is_digits(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value.len() == 1 || !value.starts_with('0'))
}

/// A reason is one non-empty line.
fn validate_reason(value: &str) -> Result<(), AppError> {
    if value.contains('\n') || value.contains('\r') {
        return Err(AppError::usage(
            "usage",
            "invalid --reason; expected a single line without line breaks",
        ));
    }
    if value.trim().is_empty() {
        return Err(AppError::usage(
            "usage",
            "invalid --reason; expected a non-empty line",
        ));
    }
    Ok(())
}

/// The `--version`/`-V` document.
pub fn version_text() -> String {
    format!("kiro-spec {VERSION}\n")
}

/// Execute one invocation and return its complete result.
///
/// The document and the process status are built together before anything is
/// written, so `run()` can never publish a partial document. A validation
/// report that contains error-severity findings still yields its complete
/// document, with exit code `1`.
pub fn execute<I>(args: I) -> Result<Outcome, AppError>
where
    I: IntoIterator<Item = OsString>,
{
    match parse(args)? {
        Parsed::Help => Ok(Outcome::success(Some(HELP_TEXT.to_string()))),
        Parsed::Version => Ok(Outcome::success(Some(version_text()))),
        Parsed::Command(invocation) => dispatch(&invocation),
    }
}

/// Select the rendering format requested by `--json`.
const fn format_of(json: bool) -> Format {
    if json {
        Format::Json
    } else {
        Format::Human
    }
}

/// Resolve the spec directory named by the invocation.
fn resolve_paths(invocation: &Invocation) -> Result<SpecPaths, AppError> {
    Ok(SpecPaths::resolve(&invocation.root, &invocation.spec)?)
}

/// Read and parse `tasks.md` for an already resolved spec.
///
/// A missing, unreadable, or undecodable file is a read failure naming its
/// path; nothing is ever written.
fn read_tasks(paths: &SpecPaths) -> Result<TaskDocument, AppError> {
    let path = paths.tasks_md();
    let context = path.display().to_string();
    let bytes = std::fs::read(&path).map_err(|error| {
        let detail = if error.kind() == std::io::ErrorKind::NotFound {
            "task list not found".to_string()
        } else {
            format!("file could not be read: {error}")
        };
        AppError::read(context.clone(), detail)
    })?;
    let text =
        String::from_utf8(bytes).map_err(|_| AppError::read(context, "file is not valid UTF-8"))?;
    Ok(parse_tasks(&text))
}

/// Resolve the spec and read only `tasks.md`.
///
/// `tasks` and `next` never open `spec.json` or `requirements.md`, so a spec
/// directory holding a task list is enough for both commands. Nothing is ever
/// written.
fn load_tasks(invocation: &Invocation) -> Result<(SpecPaths, TaskDocument), AppError> {
    let paths = resolve_paths(invocation)?;
    let document = read_tasks(&paths)?;
    Ok((paths, document))
}

/// Resolve the spec and read `spec.json` before `tasks.md`.
///
/// `status` needs a raw stage string, so an absent, unparseable, or wrongly
/// shaped `spec.json` is a hard read failure naming the file (Requirement 5.5);
/// the count rules come from the same parsed task model as `tasks` and `next`.
fn load_status(invocation: &Invocation) -> Result<(SpecPaths, String, TaskDocument), AppError> {
    let paths = resolve_paths(invocation)?;
    let spec_json_path = paths.spec_json();
    let value = spec_json::read_value(&spec_json_path)?;
    let stage = spec_json::phase_of(&value).map_err(|error| {
        AppError::read(
            spec_json_path.display().to_string(),
            error.detail().to_string(),
        )
    })?;
    let document = read_tasks(&paths)?;
    Ok((paths, stage, document))
}

/// Plan, publish, and render one `complete` or `block` mutation.
///
/// The plan is built and published before any result text exists, so a refused
/// transition or a failed write leaves `tasks.md` untouched and publishes no
/// document. A plan that changes no bytes is published as a no-op and still
/// reports the entry's resulting state.
fn run_mutation(
    paths: &SpecPaths,
    document: &TaskDocument,
    task: &str,
    change: Change,
) -> Result<Outcome, AppError> {
    let plan = mutate(document, task, change)?;
    plan.publish(&paths.tasks_md())?;
    Ok(Outcome::success(Some(human::render_mutation(&plan))))
}

/// Run one parsed subcommand and return its complete rendering.
///
/// `validate` reads every artifact leniently and renders the whole report: a
/// missing or malformed artifact is a finding inside a complete document, not a
/// command failure. Only an error-severity finding changes the exit status, and
/// the document is written either way.
fn dispatch(invocation: &Invocation) -> Result<Outcome, AppError> {
    let format = format_of(invocation.json);
    match &invocation.command {
        Command::Tasks => {
            let (paths, document) = load_tasks(invocation)?;
            Ok(Outcome::success(Some(match format {
                Format::Human => human::render_tasks(&document, paths.name()),
                Format::Json => crate::render::json::render_tasks(&document, paths.name()),
            })))
        }
        Command::Next => {
            let (paths, document) = load_tasks(invocation)?;
            let next = document.next_actionable();
            Ok(Outcome::success(Some(match format {
                Format::Human => human::render_next(next, paths.name()),
                Format::Json => crate::render::json::render_next(next, paths.name()),
            })))
        }
        Command::Status => {
            let (paths, stage, document) = load_status(invocation)?;
            let counts = document.counts();
            Ok(Outcome::success(Some(match format {
                Format::Human => human::render_status(&stage, &counts, paths.name()),
                Format::Json => crate::render::json::render_status(&stage, &counts, paths.name()),
            })))
        }
        Command::Validate => {
            let paths = resolve_paths(invocation)?;
            let report = validate::validate(&paths);
            let rendered = match format {
                Format::Human => human::render_validation(&report, paths.name()),
                Format::Json => crate::render::json::render_validation(&report, paths.name()),
            };
            Ok(if report.has_errors() {
                Outcome::validation_errors(rendered)
            } else {
                Outcome::success(Some(rendered))
            })
        }
        Command::Complete { task } => {
            let (paths, document) = load_tasks(invocation)?;
            run_mutation(&paths, &document, task, Change::Complete)
        }
        Command::Block { task, reason } => {
            let (paths, document) = load_tasks(invocation)?;
            run_mutation(
                &paths,
                &document,
                task,
                Change::Block {
                    reason: reason.clone(),
                },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    /// The result document of one invocation, for the tests that only assert on
    /// stdout content.
    fn document<I>(args: I) -> Result<Option<String>, AppError>
    where
        I: IntoIterator<Item = OsString>,
    {
        execute(args).map(Outcome::into_document)
    }

    fn parse_args(args: &[&str]) -> Result<Parsed, AppError> {
        let mut argv = vec![OsString::from("kiro-spec")];
        argv.extend(args.iter().map(OsString::from));
        parse(argv)
    }

    fn invocation(args: &[&str]) -> Invocation {
        match parse_args(args) {
            Ok(Parsed::Command(invocation)) => invocation,
            other => panic!("expected a parsed command, got {other:?}"),
        }
    }

    fn usage_error(args: &[&str]) -> AppError {
        match parse_args(args) {
            Err(error) => {
                assert_eq!(error.category(), crate::error::ErrorCategory::Usage);
                assert_eq!(error.exit_code(), 2);
                error
            }
            other => panic!("expected a usage error, got {other:?}"),
        }
    }

    #[test]
    fn help_and_version_actions_are_recognized_for_both_aliases() {
        assert_eq!(parse_args(&["--help"]).unwrap(), Parsed::Help);
        assert_eq!(parse_args(&["-h"]).unwrap(), Parsed::Help);
        assert_eq!(parse_args(&["--version"]).unwrap(), Parsed::Version);
        assert_eq!(parse_args(&["-V"]).unwrap(), Parsed::Version);
    }

    #[test]
    fn help_and_version_do_not_require_a_spec() {
        assert_eq!(parse_args(&["next", "--help"]).unwrap(), Parsed::Help);
        assert_eq!(parse_args(&["status", "-V"]).unwrap(), Parsed::Version);
    }

    #[test]
    fn read_commands_parse_with_the_default_root() {
        for (name, expected) in [
            ("next", Command::Next),
            ("tasks", Command::Tasks),
            ("status", Command::Status),
            ("validate", Command::Validate),
        ] {
            let parsed = invocation(&["--spec", "demo", name]);
            assert_eq!(parsed.command, expected, "{name}");
            assert_eq!(parsed.root, PathBuf::from("."));
            assert_eq!(parsed.spec, "demo");
            assert!(!parsed.json);
        }
    }

    #[test]
    fn value_options_accept_both_forms_and_last_value_wins() {
        let parsed = invocation(&[
            "--spec",
            "first",
            "--spec=second",
            "--root",
            "one",
            "--root=two",
            "next",
        ]);
        assert_eq!(parsed.spec, "second");
        assert_eq!(parsed.root, PathBuf::from("two"));
    }

    #[test]
    fn options_may_follow_the_subcommand() {
        let parsed = invocation(&["next", "--spec", "demo", "--json", "--root=checkout"]);
        assert_eq!(parsed.command, Command::Next);
        assert_eq!(parsed.spec, "demo");
        assert_eq!(parsed.root, PathBuf::from("checkout"));
        assert!(parsed.json);
    }

    #[test]
    fn complete_and_block_capture_the_task_identifier() {
        assert_eq!(
            invocation(&["--spec", "demo", "complete", "7.2"]).command,
            Command::Complete {
                task: "7.2".to_string()
            }
        );
        assert_eq!(
            invocation(&[
                "--spec",
                "demo",
                "block",
                "3",
                "--reason",
                "needs a decision"
            ])
            .command,
            Command::Block {
                task: "3".to_string(),
                reason: "needs a decision".to_string(),
            }
        );
        assert_eq!(
            invocation(&["--spec", "demo", "block", "--reason=waiting", "3"]).command,
            Command::Block {
                task: "3".to_string(),
                reason: "waiting".to_string(),
            }
        );
    }

    #[test]
    fn a_trailing_dot_is_accepted_in_a_task_identifier() {
        assert_eq!(
            invocation(&["--spec", "demo", "complete", "4."]).command,
            Command::Complete {
                task: "4.".to_string()
            }
        );
    }

    #[test]
    fn unknown_options_and_subcommands_are_usage_errors() {
        let option = usage_error(&["--spec", "demo", "next", "--bogus"]);
        assert!(option.detail().contains("--bogus"), "{:?}", option.detail());
        let subcommand = usage_error(&["--spec", "demo", "frobnicate"]);
        assert!(
            subcommand.detail().contains("frobnicate"),
            "{:?}",
            subcommand.detail()
        );
        let short = usage_error(&["--spec", "demo", "next", "-x"]);
        assert!(short.detail().contains("-x"), "{:?}", short.detail());
    }

    #[test]
    fn a_missing_spec_is_named_in_the_diagnostic() {
        let missing = usage_error(&["next"]);
        assert!(
            missing.detail().contains("--spec"),
            "{:?}",
            missing.detail()
        );
        assert!(
            missing.detail().contains("<name>"),
            "{:?}",
            missing.detail()
        );
    }

    #[test]
    fn a_missing_subcommand_is_a_usage_error() {
        let missing = usage_error(&["--spec", "demo"]);
        assert!(
            missing.detail().contains("missing subcommand"),
            "{:?}",
            missing.detail()
        );
    }

    #[test]
    fn missing_option_values_are_usage_errors() {
        for args in [
            vec!["--root"],
            vec!["--spec"],
            vec!["--reason"],
            vec!["--spec", "--json", "next"],
            vec!["--root=", "--spec", "demo", "next"],
            vec!["--spec=", "next"],
        ] {
            let error = usage_error(&args);
            assert!(
                error.detail().contains("missing value"),
                "{args:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn json_is_rejected_on_mutations() {
        for args in [
            vec!["--spec", "demo", "--json", "complete", "1"],
            vec!["--spec", "demo", "--json", "block", "1", "--reason", "x"],
        ] {
            let error = usage_error(&args);
            assert!(
                error.detail().contains("--json"),
                "{args:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn json_does_not_take_a_value() {
        let error = usage_error(&["--spec", "demo", "next", "--json=yes"]);
        assert!(
            error.detail().contains("does not take a value"),
            "{:?}",
            error.detail()
        );
    }

    #[test]
    fn reason_is_rejected_outside_block() {
        for args in [
            vec!["--spec", "demo", "next", "--reason", "x"],
            vec!["--spec", "demo", "complete", "1", "--reason", "x"],
        ] {
            let error = usage_error(&args);
            assert!(
                error.detail().contains("--reason"),
                "{args:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn malformed_task_identifiers_are_usage_errors() {
        for task in ["", "x", "1.2.3", "1..2", ".1", "1.x", "1 ", "01", "1.02"] {
            let args = ["--spec", "demo", "complete", task];
            let error = usage_error(&args);
            assert!(
                error.detail().contains("task identifier"),
                "{task:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn a_block_reason_must_be_a_non_empty_single_line() {
        for reason in ["", "   ", "first\nsecond", "first\rsecond"] {
            let args = ["--spec", "demo", "block", "1", "--reason", reason];
            let error = usage_error(&args);
            assert!(
                error.detail().contains("--reason"),
                "{reason:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn a_block_without_a_reason_is_a_usage_error() {
        let missing = usage_error(&["--spec", "demo", "block", "1"]);
        assert!(
            missing.detail().contains("--reason"),
            "{:?}",
            missing.detail()
        );
    }

    #[test]
    fn mutations_require_a_task_identifier() {
        for command in ["complete", "block"] {
            let missing = usage_error(&["--spec", "demo", command]);
            assert!(
                missing.detail().contains("<task-id>"),
                "{command}: {:?}",
                missing.detail()
            );
        }
    }

    #[test]
    fn extra_positionals_are_usage_errors() {
        for args in [
            vec!["--spec", "demo", "next", "extra"],
            vec!["--spec", "demo", "complete", "1", "2"],
        ] {
            let error = usage_error(&args);
            assert!(
                error.detail().contains("unexpected argument"),
                "{args:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn an_empty_argv_is_a_usage_error_without_panicking() {
        let error = usage_error(&[]);
        assert!(error.detail().contains("--spec"), "{:?}", error.detail());
    }

    #[test]
    fn help_text_lists_every_command_and_option() {
        for command in ["next", "tasks", "status", "validate", "complete", "block"] {
            assert!(HELP_TEXT.contains(command), "help is missing {command}");
        }
        for option in [
            "--root",
            "--spec",
            "--json",
            "--reason",
            "--help",
            "--version",
        ] {
            assert!(HELP_TEXT.contains(option), "help is missing {option}");
        }
        for alias in ["-h", "-V"] {
            assert!(HELP_TEXT.contains(alias), "help is missing {alias}");
        }
        assert!(HELP_TEXT.contains("Usage:"));
        assert!(HELP_TEXT.ends_with('\n'));
    }

    #[test]
    fn version_text_matches_the_package_version() {
        assert_eq!(
            version_text(),
            format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn execute_renders_help_and_version() {
        let argv = vec![OsString::from("kiro-spec"), OsString::from("--help")];
        assert_eq!(document(argv).unwrap(), Some(HELP_TEXT.to_string()));

        let argv = vec![OsString::from("kiro-spec"), OsString::from("-V")];
        assert_eq!(document(argv).unwrap(), Some(version_text()));
    }

    /// A disposable spec tree for the read-command dispatch tests.
    struct SpecTree {
        root: PathBuf,
        name: String,
    }

    impl SpecTree {
        /// Create `.kiro/specs/<name>/` and, when supplied, its `tasks.md`.
        ///
        /// No `spec.json` is written: the read commands under test must not
        /// require it.
        fn new(name: &str, tasks: Option<&str>) -> Self {
            let id = NEXT_TREE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("kiro-spec-dispatch-{}-{id}", std::process::id()));
            let spec = root.join(".kiro").join("specs").join(name);
            std::fs::create_dir_all(&spec).expect("fixture spec directory is created");
            if let Some(text) = tasks {
                std::fs::write(spec.join("tasks.md"), text).expect("fixture tasks.md is written");
            }
            Self {
                root,
                name: name.to_string(),
            }
        }

        fn args(&self, command: &str) -> Vec<OsString> {
            let root = self.root.to_str().expect("fixture root is valid UTF-8");
            vec![
                OsString::from("kiro-spec"),
                OsString::from("--root"),
                OsString::from(root),
                OsString::from("--spec"),
                OsString::from(&self.name),
                OsString::from(command),
            ]
        }

        fn json_args(&self, command: &str) -> Vec<OsString> {
            let mut args = self.args(command);
            args.push(OsString::from("--json"));
            args
        }

        /// Arguments for `complete <task-id>`.
        fn mutation_args(&self, command: &str, task: &str) -> Vec<OsString> {
            let mut args = self.args(command);
            args.push(OsString::from(task));
            args
        }

        /// Arguments for `block <task-id> --reason <text>`.
        fn block_args(&self, task: &str, reason: &str) -> Vec<OsString> {
            let mut args = self.mutation_args("block", task);
            args.push(OsString::from("--reason"));
            args.push(OsString::from(reason));
            args
        }

        fn spec_dir(&self) -> PathBuf {
            self.root.join(".kiro").join("specs").join(&self.name)
        }

        fn tasks_path(&self) -> PathBuf {
            self.spec_dir().join("tasks.md")
        }

        /// Write the fixture's `spec.json` verbatim, for commands that need it.
        fn write_spec_json(&self, text: &str) {
            std::fs::write(self.spec_dir().join("spec.json"), text)
                .expect("fixture spec.json is written");
        }

        /// Every file beneath the fixture root with its exact bytes.
        fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
            fn collect(directory: &std::path::Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
                for entry in std::fs::read_dir(directory).expect("fixture directory is readable") {
                    let path = entry.expect("fixture entry is readable").path();
                    if path.is_dir() {
                        collect(&path, files);
                    } else {
                        files.push((
                            path.clone(),
                            std::fs::read(&path).expect("fixture file is readable"),
                        ));
                    }
                }
            }

            let mut files = Vec::new();
            collect(&self.root, &mut files);
            files.sort_by(|left, right| left.0.cmp(&right.0));
            files
        }
    }

    impl Drop for SpecTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    static NEXT_TREE: AtomicU64 = AtomicU64::new(0);

    fn run_json(args: Vec<OsString>) -> (String, serde_json::Value) {
        let rendered = document(args)
            .expect("the read command succeeds")
            .expect("the read command produces a result");
        let parsed = serde_json::from_str(&rendered).expect("the result is one JSON document");
        (rendered, parsed)
    }

    /// Execute one invocation through the process plumbing, capturing both
    /// streams and the exit status.
    fn run_capturing(args: Vec<OsString>) -> (i32, String, String) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = crate::run_with(args, &mut stdout, &mut stderr, execute);
        (
            code,
            String::from_utf8(stdout).expect("stdout is valid UTF-8"),
            String::from_utf8(stderr).expect("stderr is valid UTF-8"),
        )
    }

    /// The paths whose bytes differ between two fixture snapshots.
    fn changed_paths(before: &[(PathBuf, Vec<u8>)], after: &[(PathBuf, Vec<u8>)]) -> Vec<PathBuf> {
        let mut changed = Vec::new();
        for (path, bytes) in after {
            let previous = before
                .iter()
                .find(|(other, _)| other == path)
                .map(|(_, previous)| previous);
            if previous != Some(bytes) {
                changed.push(path.clone());
            }
        }
        for (path, _) in before {
            if !after.iter().any(|(other, _)| other == path) {
                changed.push(path.clone());
            }
        }
        changed
    }

    /// A `spec.json` with every required field at the `initialized` phase, so
    /// validation reports no `spec.json` finding for a spec named `name`.
    fn valid_spec_json(name: &str) -> String {
        concat!(
            "{\n",
            "  \"feature_name\": \"basic\",\n",
            "  \"created_at\": \"2026-10-26T02:32:24Z\",\n",
            "  \"updated_at\": \"2026-10-26T02:59:19Z\",\n",
            "  \"language\": \"en\",\n",
            "  \"phase\": \"initialized\",\n",
            "  \"approvals\": {\n",
            "    \"requirements\": { \"generated\": false, \"approved\": false },\n",
            "    \"design\": { \"generated\": false, \"approved\": false },\n",
            "    \"tasks\": { \"generated\": false, \"approved\": false }\n",
            "  },\n",
            "  \"ready_for_implementation\": false\n",
            "}\n",
        )
        .replace("basic", name)
    }

    #[test]
    fn validate_renders_a_clean_spec_and_exits_zero_in_both_formats() {
        let tree = SpecTree::new("basic", Some("- [ ] 1. Foundation\n"));
        tree.write_spec_json(&valid_spec_json("basic"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.args("validate"));
        assert_eq!(code, 0, "a clean spec with no findings exits zero");
        assert_eq!(stderr, "", "findings are result data, not diagnostics");
        assert_eq!(stdout, "0 errors, 0 warnings\n");

        let (code, stdout, stderr) = run_capturing(tree.json_args("validate"));
        assert_eq!(code, 0, "--json must not change the exit status");
        assert_eq!(stderr, "");
        let parsed: serde_json::Value =
            serde_json::from_str(&stdout).expect("validate emits one JSON document");
        assert_eq!(parsed["schema_version"], serde_json::json!(1));
        assert_eq!(parsed["spec"], serde_json::json!("basic"));
        assert_eq!(parsed["valid"], serde_json::json!(true));
        assert_eq!(parsed["findings"], serde_json::json!([]));

        assert_eq!(
            tree.snapshot(),
            before,
            "validate must leave every fixture file byte-identical"
        );
    }

    #[test]
    fn validate_writes_the_complete_report_and_exits_one_for_errors() {
        let tree = SpecTree::new(
            "basic",
            Some("- [ ] 1. Foundation\n- [ ] 1. Duplicate identifier\n"),
        );
        tree.write_spec_json(&valid_spec_json("basic"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.args("validate"));
        assert_eq!(code, 1, "an error-severity finding exits non-zero");
        assert_eq!(stderr, "", "findings are result data, not diagnostics");
        assert_eq!(
            stdout,
            concat!(
                "tasks.md:2: error [tasks.id.duplicate] ",
                "duplicate task identifier `1`; first occurrence is line 1\n",
                "1 error, 0 warnings\n",
            )
        );

        let (code, stdout, stderr) = run_capturing(tree.json_args("validate"));
        assert_eq!(code, 1, "--json must report the same exit status");
        assert_eq!(stderr, "");
        let parsed: serde_json::Value = serde_json::from_str(&stdout)
            .expect("a failing validate still emits one JSON document");
        assert_eq!(parsed["schema_version"], serde_json::json!(1));
        assert_eq!(parsed["spec"], serde_json::json!("basic"));
        assert_eq!(parsed["valid"], serde_json::json!(false));
        let findings = parsed["findings"]
            .as_array()
            .expect("the complete report carries every finding");
        assert_eq!(findings.len(), 1, "the whole report is written: {parsed:?}");
        assert_eq!(findings[0]["severity"], serde_json::json!("error"));
        assert_eq!(findings[0]["code"], serde_json::json!("tasks.id.duplicate"));
        assert_eq!(findings[0]["file"], serde_json::json!("tasks.md"));
        assert_eq!(findings[0]["line"], serde_json::json!(2));
        assert_eq!(
            findings[0]["message"],
            serde_json::json!("duplicate task identifier `1`; first occurrence is line 1")
        );

        assert_eq!(
            tree.snapshot(),
            before,
            "a failing validate must not change any file"
        );
    }

    #[test]
    fn validate_exits_zero_when_the_only_findings_are_warnings() {
        let tree = SpecTree::new("basic", Some("- [ ] a checkbox without a number\n"));
        tree.write_spec_json(&valid_spec_json("basic"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.args("validate"));
        assert_eq!(code, 0, "warnings alone do not change the exit status");
        assert_eq!(stderr, "");
        assert_eq!(
            stdout,
            concat!(
                "tasks.md:1: warning [tasks.line.unnumbered] ",
                "checkbox line has no numeric identifier\n",
                "0 errors, 1 warning\n",
            )
        );

        let (code, stdout, stderr) = run_capturing(tree.json_args("validate"));
        assert_eq!(code, 0, "--json must report the same exit status");
        assert_eq!(stderr, "");
        let parsed: serde_json::Value =
            serde_json::from_str(&stdout).expect("validate emits one JSON document");
        assert_eq!(parsed["valid"], serde_json::json!(true));
        assert_eq!(
            parsed["findings"][0]["severity"],
            serde_json::json!("warning")
        );
        assert_eq!(
            parsed["findings"][0]["code"],
            serde_json::json!("tasks.line.unnumbered")
        );

        assert_eq!(tree.snapshot(), before, "validate never writes a file");
    }

    #[test]
    fn validate_reports_a_missing_artifact_as_a_finding_instead_of_failing() {
        let tree = SpecTree::new("basic", Some("- [ ] 1. Foundation\n"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.args("validate"));
        assert_eq!(
            code, 1,
            "a missing artifact is an error finding, not an abort"
        );
        assert_eq!(stderr, "", "the report is a result document");
        assert_eq!(
            stdout,
            concat!(
                "spec.json: error [spec.json.missing] file not found\n",
                "1 error, 0 warnings\n",
            )
        );

        let (code, stdout, stderr) = run_capturing(tree.json_args("validate"));
        assert_eq!(code, 1, "--json must report the same exit status");
        assert_eq!(stderr, "");
        let parsed: serde_json::Value =
            serde_json::from_str(&stdout).expect("validate emits one JSON document");
        assert_eq!(parsed["valid"], serde_json::json!(false));
        assert_eq!(
            parsed["findings"][0]["code"],
            serde_json::json!("spec.json.missing")
        );
        assert_eq!(parsed["findings"][0]["line"], serde_json::Value::Null);

        assert_eq!(tree.snapshot(), before, "validate writes nothing");
    }

    #[test]
    fn validate_repeats_identically_without_changing_any_file() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ] 1. Foundation\n",
                "- [!] 1.1 Blocked work\n",
                "  - _Blocked: Waiting on credentials_\n",
            )),
        );
        tree.write_spec_json(&valid_spec_json("basic"));
        let before = tree.snapshot();

        for args in [tree.args("validate"), tree.json_args("validate")] {
            let once = run_capturing(args.clone());
            let twice = run_capturing(args);
            assert_eq!(once, twice, "validate output must repeat byte-identically");
            assert_eq!(once.0, 0, "a valid spec exits zero");
            assert_eq!(once.2, "", "a valid spec writes no diagnostic");
            assert!(
                !once.1.is_empty(),
                "validate always renders a complete report"
            );
        }

        assert_eq!(tree.snapshot(), before, "validate writes nothing");
    }

    #[test]
    fn validate_writes_a_diagnostic_to_stderr_when_the_spec_directory_is_absent() {
        let tree = SpecTree::new("basic", Some("- [ ] 1. Foundation\n"));
        let root = tree
            .root
            .to_str()
            .expect("fixture root is valid UTF-8")
            .to_string();
        let args = vec![
            OsString::from("kiro-spec"),
            OsString::from("--root"),
            OsString::from(root),
            OsString::from("--spec"),
            OsString::from("absent"),
            OsString::from("validate"),
        ];

        let (code, stdout, stderr) = run_capturing(args);
        assert_eq!(code, 1, "an absent spec directory is a resolution failure");
        assert_eq!(stdout, "", "a resolution failure emits no result document");
        assert!(
            stderr.starts_with("kiro-spec: ") && stderr.contains("absent"),
            "the diagnostic names the resolved path, got {stderr:?}"
        );
    }

    #[test]
    fn tasks_dispatches_every_entry_in_document_order_without_spec_json() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ] 1. Foundation\n",
                "- [x] 1.1 Pin inputs\n",
                "- [!]* 1.2 Blocked work\n",
                "  - _Blocked: Waiting on credentials_\n",
                "- [ ]* 2. Optional major\n",
            )),
        );
        let human = document(tree.args("tasks"))
            .expect("tasks succeeds without spec.json")
            .expect("tasks produces a result");
        assert_eq!(
            human,
            concat!(
                "1 Foundation [pending]\n",
                "  1.1 Pin inputs [completed]\n",
                "  1.2 Blocked work [blocked] (optional) - blocked: Waiting on credentials\n",
                "2 Optional major [pending] (optional)\n",
            )
        );

        let (_, parsed) = run_json(tree.json_args("tasks"));
        assert_eq!(parsed["schema_version"], serde_json::json!(1));
        assert_eq!(parsed["spec"], serde_json::json!("basic"));
        let entries = parsed["tasks"]
            .as_array()
            .expect("tasks is an array in document order");
        let ids: Vec<&str> = entries
            .iter()
            .map(|entry| entry["id"].as_str().expect("every entry carries an id"))
            .collect();
        assert_eq!(ids, ["1", "1.1", "1.2", "2"]);
        assert_eq!(entries[2]["state"], serde_json::json!("blocked"));
        assert_eq!(entries[2]["optional"], serde_json::json!(true));
        assert_eq!(
            entries[2]["blocked_reason"],
            serde_json::json!("Waiting on credentials")
        );
    }

    #[test]
    fn next_reports_the_actionable_entry_with_its_blocked_reason() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ] 1. Foundation\n",
                "- [x] 1.1 Done child\n",
                "- [!]* 1.2 Blocked work\n",
                "  - _Blocked: Waiting on credentials_\n",
            )),
        );
        let human = document(tree.args("next"))
            .expect("next succeeds without spec.json")
            .expect("next produces a result");
        assert_eq!(
            human,
            "  1.2 Blocked work [blocked] (optional) - blocked: Waiting on credentials\n"
        );

        let (_, parsed) = run_json(tree.json_args("next"));
        assert_eq!(parsed["spec"], serde_json::json!("basic"));
        assert_eq!(parsed["task"]["id"], serde_json::json!("1.2"));
        assert_eq!(parsed["task"]["state"], serde_json::json!("blocked"));
        assert_eq!(
            parsed["task"]["blocked_reason"],
            serde_json::json!("Waiting on credentials")
        );
    }

    #[test]
    fn next_never_selects_a_grouping_entry_or_reports_a_remaining_task() {
        let grouping = SpecTree::new(
            "grouping",
            Some("- [ ] 1. Foundation\n- [x] 1.1 Done child\n"),
        );
        assert_eq!(
            document(grouping.args("next")).unwrap(),
            Some("No incomplete task.\n".to_string())
        );
        let (_, parsed) = run_json(grouping.json_args("next"));
        assert_eq!(parsed["task"], serde_json::Value::Null);

        let empty = SpecTree::new("empty", Some("# Implementation Plan\n"));
        assert_eq!(
            document(empty.args("next")).unwrap(),
            Some("No incomplete task.\n".to_string())
        );
        assert_eq!(
            document(empty.args("tasks")).unwrap(),
            Some("No tasks.\n".to_string())
        );
    }

    #[test]
    fn read_commands_repeat_identically_and_leave_tasks_md_unchanged() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ] 1. Foundation\n",
                "- [x] 1.1 Pin inputs\n",
                "- [!] 1.2 Blocked work\n",
                "  - _Blocked: Waiting on credentials_\n",
            )),
        );
        let before = tree.snapshot();

        for command in ["tasks", "next"] {
            let human_once = document(tree.args(command)).unwrap();
            let human_twice = document(tree.args(command)).unwrap();
            assert_eq!(human_once, human_twice, "{command} human output repeats");

            let json_once = document(tree.json_args(command)).unwrap();
            let json_twice = document(tree.json_args(command)).unwrap();
            assert_eq!(json_once, json_twice, "{command} JSON output repeats");
            let rendered = json_once.expect("the read command produces a result");
            let parsed: serde_json::Value =
                serde_json::from_str(&rendered).expect("the result is one JSON document");
            assert_eq!(parsed["schema_version"], serde_json::json!(1));
        }

        assert_eq!(
            tree.snapshot(),
            before,
            "read commands must leave every fixture file byte-identical"
        );
    }

    #[test]
    fn a_missing_or_undecodable_tasks_md_is_a_read_error_naming_the_path() {
        for command in ["tasks", "next"] {
            let missing = SpecTree::new("missing-tasks", None);
            let error = document(missing.args(command)).expect_err("the read must fail");
            assert_eq!(error.category(), crate::error::ErrorCategory::Read);
            assert_eq!(error.exit_code(), 1);
            assert!(
                error.context().ends_with("missing-tasks/tasks.md"),
                "{command}: {:?}",
                error.context()
            );

            let undecodable = SpecTree::new("undecodable", Some("placeholder"));
            std::fs::write(undecodable.tasks_path(), [0xff, 0xfe])
                .expect("fixture tasks.md is rewritten");
            let error = document(undecodable.args(command)).expect_err("the read must fail");
            assert_eq!(error.category(), crate::error::ErrorCategory::Read);
            assert!(
                error.detail().contains("UTF-8"),
                "{command}: {:?}",
                error.detail()
            );
        }
    }

    /// A complete `spec.json` whose phase is a documented rung.
    const STATUS_SPEC_JSON: &str = concat!(
        "{\n",
        "  \"feature_name\": \"basic\",\n",
        "  \"phase\": \"tasks-generated\",\n",
        "  \"ready_for_implementation\": true\n",
        "}\n",
    );

    #[test]
    fn status_reports_counts_and_the_raw_phase_in_both_formats() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ]* 1. Optional pending\n",
                "- [ ] 2. Pending\n",
                "- [x] 3. Completed\n",
                "- [!]* 4. Blocked work\n",
                "  - _Blocked: Waiting on credentials_\n",
            )),
        );
        tree.write_spec_json(STATUS_SPEC_JSON);

        let human = document(tree.args("status"))
            .expect("status succeeds with spec.json")
            .expect("status produces a result");
        assert_eq!(
            human,
            concat!(
                "spec: basic\n",
                "stage: tasks-generated\n",
                "total: 4\n",
                "completed: 1\n",
                "pending: 2 (optional: 1)\n",
                "blocked: 1\n",
            )
        );

        let (_, parsed) = run_json(tree.json_args("status"));
        assert_eq!(parsed["schema_version"], serde_json::json!(1));
        assert_eq!(parsed["spec"], serde_json::json!("basic"));
        assert_eq!(parsed["stage"], serde_json::json!("tasks-generated"));
        assert_eq!(parsed["total"], serde_json::json!(4));
        assert_eq!(parsed["counts"]["completed"], serde_json::json!(1));
        assert_eq!(parsed["counts"]["pending"], serde_json::json!(2));
        assert_eq!(parsed["counts"]["blocked"], serde_json::json!(1));
        assert_eq!(parsed["optional_pending"], serde_json::json!(1));
    }

    #[test]
    fn status_reports_the_spec_json_phase_and_never_infers_it_from_progress() {
        let completed = SpecTree::new("done", Some("- [x] 1. Done\n"));
        completed.write_spec_json("{\"phase\": \"initialized\"}");
        assert_eq!(
            document(completed.args("status")).unwrap(),
            Some(
                concat!(
                    "spec: done\n",
                    "stage: initialized\n",
                    "total: 1\n",
                    "completed: 1\n",
                    "pending: 0 (optional: 0)\n",
                    "blocked: 0\n",
                )
                .to_string()
            ),
            "a completed task list must not advance the reported stage"
        );

        let unknown = SpecTree::new("unknown", Some("- [ ] 1. Pending\n"));
        unknown.write_spec_json("{\"phase\": \"future-phase\"}");
        let human = document(unknown.args("status")).unwrap().unwrap();
        assert!(
            human.contains("stage: future-phase\n"),
            "the raw phase string is reported verbatim, got {human:?}"
        );
        let (_, parsed) = run_json(unknown.json_args("status"));
        assert_eq!(parsed["stage"], serde_json::json!("future-phase"));
    }

    #[test]
    fn status_fails_naming_spec_json_when_the_document_or_phase_is_unusable() {
        for (spec_json, expected_detail) in [
            (None, "file not found"),
            (Some("{ \"phase\": }"), "invalid JSON"),
            (Some("[]"), "object"),
            (Some("{\"phase\": 3}"), "string"),
        ] {
            let tree = SpecTree::new("broken", Some("- [ ] 1. Pending\n"));
            if let Some(text) = spec_json {
                tree.write_spec_json(text);
            }

            let error = document(tree.args("status")).expect_err("status must fail");
            assert_eq!(
                error.category(),
                crate::error::ErrorCategory::Read,
                "{spec_json:?}"
            );
            assert_eq!(error.exit_code(), 1, "{spec_json:?}");
            assert!(
                error.context().ends_with("broken/spec.json"),
                "the diagnostic must name spec.json, got {:?}",
                error.context()
            );
            match spec_json {
                None => assert_eq!(error.detail(), expected_detail),
                Some("{ \"phase\": }") => assert!(
                    error.detail().starts_with(expected_detail),
                    "{spec_json:?}: {:?}",
                    error.detail()
                ),
                Some(_) => assert!(
                    error.detail().contains("phase") && error.detail().contains(expected_detail),
                    "{spec_json:?}: {:?}",
                    error.detail()
                ),
            }
        }
    }

    #[test]
    fn status_reports_zero_counts_for_an_empty_task_list() {
        let tree = SpecTree::new("empty", Some("# Implementation Plan\n"));
        tree.write_spec_json("{\"phase\": \"initialized\"}");

        assert_eq!(
            document(tree.args("status")).unwrap(),
            Some(
                concat!(
                    "spec: empty\n",
                    "stage: initialized\n",
                    "total: 0\n",
                    "completed: 0\n",
                    "pending: 0 (optional: 0)\n",
                    "blocked: 0\n",
                )
                .to_string()
            )
        );
        let (_, parsed) = run_json(tree.json_args("status"));
        assert_eq!(parsed["total"], serde_json::json!(0));
        assert_eq!(parsed["counts"]["pending"], serde_json::json!(0));
        assert_eq!(parsed["optional_pending"], serde_json::json!(0));
    }

    #[test]
    fn status_reads_spec_json_before_tasks_md() {
        let tree = SpecTree::new("broken", None);
        tree.write_spec_json("{ \"phase\": }");

        let error = document(tree.args("status")).expect_err("status must fail");
        assert!(
            error.context().ends_with("broken/spec.json"),
            "spec.json is checked first, got {:?}",
            error.context()
        );
        assert!(
            error.detail().starts_with("invalid JSON"),
            "{:?}",
            error.detail()
        );
    }

    #[test]
    fn status_fails_naming_tasks_md_when_it_is_missing() {
        let tree = SpecTree::new("no-tasks", None);
        tree.write_spec_json(STATUS_SPEC_JSON);

        let error = document(tree.args("status")).expect_err("status needs tasks.md");
        assert_eq!(error.category(), crate::error::ErrorCategory::Read);
        assert!(
            error.context().ends_with("no-tasks/tasks.md"),
            "{:?}",
            error.context()
        );
    }

    #[test]
    fn status_repeats_identically_and_leaves_every_file_byte_identical() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ]* 1. Optional pending\n",
                "- [x] 1.1 Completed child\n",
                "- [!] 2. Blocked work\n",
                "  - _Blocked: Waiting on credentials_\n",
            )),
        );
        tree.write_spec_json(STATUS_SPEC_JSON);
        let before = tree.snapshot();

        for args in [tree.args("status"), tree.json_args("status")] {
            let once = document(args.clone()).expect("status succeeds");
            let twice = document(args).expect("status succeeds again");
            assert_eq!(once, twice, "status output must repeat byte-identically");
            assert!(once.is_some(), "status always produces a result");
        }

        assert_eq!(
            tree.snapshot(),
            before,
            "status must leave every fixture file byte-identical"
        );
    }

    #[test]
    fn complete_writes_the_entry_and_later_reads_report_it() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ] 1. Foundation\n",
                "- [ ]* 1.1 Ready\n",
                "  - _Requirements: 7.4_\n",
                "- [ ] 2. Wrap up\n",
            )),
        );
        tree.write_spec_json(&valid_spec_json("basic"));
        let before = tree.snapshot();
        assert_eq!(
            document(tree.args("next")).unwrap(),
            Some("  1.1 Ready [pending] (optional)\n".to_string()),
            "the fixture starts with 1.1 as the next actionable entry"
        );

        let (code, stdout, stderr) = run_capturing(tree.mutation_args("complete", "1.1"));
        assert_eq!(code, 0, "a successful mutation exits zero");
        assert_eq!(stderr, "", "a successful mutation writes no diagnostic");
        assert_eq!(
            stdout, "1.1 [completed]\n",
            "the result names the identifier and resulting state"
        );

        assert_eq!(
            std::fs::read(tree.tasks_path()).expect("tasks.md is readable"),
            concat!(
                "- [ ] 1. Foundation\n",
                "- [x]* 1.1 Ready\n",
                "  - _Requirements: 7.4_\n",
                "- [ ] 2. Wrap up\n",
            )
            .as_bytes(),
            "only the target checkbox changes and the optional marker survives"
        );

        let changed = changed_paths(&before, &tree.snapshot());
        assert_eq!(
            changed,
            vec![tree.tasks_path()],
            "no file other than tasks.md may change"
        );

        let (code, stdout, _) = run_capturing(tree.args("tasks"));
        assert_eq!(code, 0);
        assert_eq!(
            stdout,
            concat!(
                "1 Foundation [pending]\n",
                "  1.1 Ready [completed] (optional)\n",
                "2 Wrap up [pending]\n",
            ),
            "a later tasks run reports the new state"
        );

        let (code, stdout, _) = run_capturing(tree.args("next"));
        assert_eq!(code, 0);
        assert_eq!(
            stdout, "2 Wrap up [pending]\n",
            "a later next run no longer selects the completed entry"
        );

        let (code, stdout, _) = run_capturing(tree.args("status"));
        assert_eq!(code, 0);
        assert_eq!(
            stdout,
            concat!(
                "spec: basic\n",
                "stage: initialized\n",
                "total: 3\n",
                "completed: 1\n",
                "pending: 2 (optional: 0)\n",
                "blocked: 0\n",
            ),
            "a later status run counts the new state"
        );
    }

    #[test]
    fn completing_a_completed_entry_reports_the_unchanged_state() {
        let tree = SpecTree::new("basic", Some("- [x] 1. Already done\n"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.mutation_args("complete", "1"));
        assert_eq!(code, 0, "a no-op mutation still exits zero");
        assert_eq!(stderr, "");
        assert_eq!(
            stdout, "1 [completed] (no change)\n",
            "a no-op reports the identifier, the resulting state, and that it changed nothing"
        );
        assert_eq!(
            tree.snapshot(),
            before,
            "a no-op keeps tasks.md byte-identical"
        );
    }

    #[test]
    fn block_records_the_reason_and_later_reads_report_it() {
        let tree = SpecTree::new(
            "basic",
            Some(concat!(
                "- [ ] 1. Foundation\n",
                "- [ ]* 1.1 Ready\n",
                "  - _Requirements: 8.1_\n",
            )),
        );
        tree.write_spec_json(&valid_spec_json("basic"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.block_args("1.1", "waiting on review"));
        assert_eq!(code, 0);
        assert_eq!(stderr, "");
        assert_eq!(stdout, "1.1 [blocked]\n");

        assert_eq!(
            std::fs::read(tree.tasks_path()).expect("tasks.md is readable"),
            concat!(
                "- [ ] 1. Foundation\n",
                "- [!]* 1.1 Ready\n",
                "  - _Blocked: waiting on review_\n",
                "  - _Requirements: 8.1_\n",
            )
            .as_bytes(),
            "the blocked marker and exactly one reason bullet are written"
        );
        assert_eq!(
            changed_paths(&before, &tree.snapshot()),
            vec![tree.tasks_path()],
            "blocking changes no file other than tasks.md"
        );

        let (code, stdout, _) = run_capturing(tree.args("tasks"));
        assert_eq!(code, 0);
        assert_eq!(
            stdout,
            concat!(
                "1 Foundation [pending]\n",
                "  1.1 Ready [blocked] (optional) - blocked: waiting on review\n",
            ),
            "a later tasks run reports the blocked state and its reason"
        );

        let (code, stdout, _) = run_capturing(tree.args("status"));
        assert_eq!(code, 0);
        assert_eq!(
            stdout,
            concat!(
                "spec: basic\n",
                "stage: initialized\n",
                "total: 2\n",
                "completed: 0\n",
                "pending: 1 (optional: 0)\n",
                "blocked: 1\n",
            ),
            "a later status run counts the blocked entry"
        );
    }

    #[test]
    fn blocking_with_the_same_reason_reports_the_unchanged_state() {
        let tree = SpecTree::new(
            "basic",
            Some("- [!] 1. Already blocked\n  - _Blocked: waiting_\n"),
        );
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.block_args("1", "waiting"));
        assert_eq!(code, 0);
        assert_eq!(stderr, "");
        assert_eq!(stdout, "1 [blocked] (no change)\n");
        assert_eq!(
            tree.snapshot(),
            before,
            "a same-reason block writes nothing"
        );
    }

    #[test]
    fn blocking_a_completed_entry_exits_one_without_writing() {
        let tree = SpecTree::new("basic", Some("- [x] 1. Done\n  - _Requirements: 8.5_\n"));
        let before = tree.snapshot();

        let (code, stdout, stderr) = run_capturing(tree.block_args("1", "not allowed"));
        assert_eq!(
            code, 1,
            "an unsupported transition is a business-rule conflict"
        );
        assert_eq!(stdout, "", "a refused mutation writes no result document");
        assert!(
            stderr.starts_with("kiro-spec: ") && stderr.contains("completed"),
            "the diagnostic names the unsupported transition, got {stderr:?}"
        );
        assert_eq!(tree.snapshot(), before, "a refused mutation writes nothing");
    }

    #[test]
    fn unknown_duplicate_and_malformed_identifiers_follow_the_exit_contract() {
        let tree = SpecTree::new(
            "basic",
            Some("- [ ] 1. First\n- [x] 1. Duplicate\n- [ ] 2. Unique\n"),
        );
        let before = tree.snapshot();

        for (task, expected) in [("1", "more than one"), ("9", "no task")] {
            let (code, stdout, stderr) = run_capturing(tree.mutation_args("complete", task));
            assert_eq!(code, 1, "{task:?} is a business-rule conflict");
            assert_eq!(stdout, "", "{task:?} writes no result document");
            assert!(
                stderr.starts_with("kiro-spec: ") && stderr.contains(expected),
                "{task:?}: {stderr:?}"
            );
        }
        assert_eq!(
            tree.snapshot(),
            before,
            "unknown and duplicate identifiers write nothing"
        );

        let (code, stdout, stderr) = run_capturing(tree.mutation_args("complete", "1.x"));
        assert_eq!(code, 2, "a malformed identifier is a usage error");
        assert_eq!(stdout, "");
        assert!(
            stderr.contains("task identifier"),
            "the diagnostic names the expected form, got {stderr:?}"
        );
        assert_eq!(tree.snapshot(), before);
    }

    #[test]
    fn usage_errors_are_rejected_before_the_spec_is_read() {
        // No tasks.md exists, so any filesystem check would exit 1 instead.
        let tree = SpecTree::new("empty", None);
        let before = tree.snapshot();

        let mut cases = vec![
            tree.mutation_args("complete", "1.x"),
            tree.block_args("1", "   "),
            tree.block_args("1", "first\nsecond"),
        ];
        let mut json = tree.mutation_args("complete", "1");
        json.push(OsString::from("--json"));
        cases.push(json);

        for args in cases {
            let (code, stdout, stderr) = run_capturing(args.clone());
            assert_eq!(code, 2, "{args:?} is a usage error");
            assert_eq!(stdout, "", "{args:?} writes no result");
            assert!(
                stderr.starts_with("kiro-spec: "),
                "{args:?} writes a usage diagnostic, got {stderr:?}"
            );
        }
        assert_eq!(tree.snapshot(), before, "usage errors touch no file");
    }

    #[test]
    fn a_write_failure_exits_one_and_leaves_tasks_md_intact() {
        let tree = SpecTree::new("stale-temp", Some("- [ ] 1. Pending\n"));
        let original = std::fs::read(tree.tasks_path()).expect("fixture is readable");
        // `create_new` refuses to reuse a temporary path, so the publish fails
        // deterministically even when the tests run as root.
        let stale = tree
            .spec_dir()
            .join(format!(".tasks.md.kiro-spec.{}.tmp", std::process::id()));
        std::fs::write(&stale, b"stale contents").expect("stale temporary file is written");

        let (code, stdout, stderr) = run_capturing(tree.mutation_args("complete", "1"));

        assert_eq!(code, 1, "a failed write exits non-zero");
        assert_eq!(stdout, "", "a failed write publishes no result");
        assert!(
            stderr.starts_with("kiro-spec: ") && stderr.contains("tasks.md"),
            "the write failure names tasks.md, got {stderr:?}"
        );
        assert_eq!(
            std::fs::read(tree.tasks_path()).expect("tasks.md is readable"),
            original,
            "tasks.md stays intact after a write failure"
        );
        assert_eq!(
            std::fs::read(&stale).expect("stale temporary file is readable"),
            b"stale contents",
            "the editor never removes a temporary file it did not create"
        );
    }

    #[test]
    fn read_and_mutation_commands_are_classified() {
        assert!(Command::Next.is_read());
        assert!(Command::Tasks.is_read());
        assert!(Command::Status.is_read());
        assert!(Command::Validate.is_read());
        assert!(!Command::Complete { task: "1".into() }.is_read());
        assert!(!Command::Block {
            task: "1".into(),
            reason: "x".into()
        }
        .is_read());
    }
}
