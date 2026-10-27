//! Argument grammar, help text, subcommand dispatch, and usage diagnostics.
//!
//! Arguments are interpreted completely before any command runs, so an unknown
//! subcommand, an unknown option, a missing value, or a `--json` flag on a
//! mutation is rejected without touching the filesystem. The parser accepts
//! long options as either `--opt value` or `--opt=value`, and the last
//! occurrence of a value option wins.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::AppError;

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

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
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

/// Execute one invocation and return its complete result document.
///
/// `Some(document)` is written to stdout verbatim; `None` means the command
/// produces no result at all. Help and version are handled here; a parsed
/// subcommand returns `None` until its dispatch is added by the command tasks.
/// The result is fully rendered before this function returns, so `run()` can
/// never publish a partial document.
pub fn execute<I>(args: I) -> Result<Option<String>, AppError>
where
    I: IntoIterator<Item = OsString>,
{
    match parse(args)? {
        Parsed::Help => Ok(Some(HELP_TEXT.to_string())),
        Parsed::Version => Ok(Some(version_text())),
        Parsed::Command(_invocation) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for task in ["", "x", "1.2.3", "1..2", ".1", "1.x", "1 "] {
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
    fn execute_renders_help_and_version_without_a_result_for_commands() {
        let mut argv = vec![OsString::from("kiro-spec"), OsString::from("--help")];
        assert_eq!(execute(argv.clone()).unwrap(), Some(HELP_TEXT.to_string()));

        argv = vec![OsString::from("kiro-spec"), OsString::from("-V")];
        assert_eq!(execute(argv).unwrap(), Some(version_text()));

        let command = vec![
            OsString::from("kiro-spec"),
            OsString::from("--spec"),
            OsString::from("demo"),
            OsString::from("next"),
        ];
        assert_eq!(execute(command).unwrap(), None);
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
