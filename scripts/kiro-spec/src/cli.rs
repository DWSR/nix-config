use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::AppError;

pub const HELP_TEXT: &str = "\
kiro-spec [--root <path>] --spec <name> <next|tasks|status|validate> [--json]
kiro-spec [--root <path>] --spec <name> <complete <task-id>|block <task-id> --reason <text>>

Report and update the state of one Kiro spec.

Subcommands:
  next        Report the first incomplete non-grouping task entry
  tasks       List every task entry with its identifier and state
  status      Report task counts and the current spec stage
  validate    Report spec well-formedness findings
  complete    Mark a task entry completed
  block       Mark a task entry blocked with a reason

Options:
  --root <path>      Repository or worktree root (default: .)
  --spec <name>      Spec directory name beneath .kiro/specs/
  --json             Emit a JSON document (read subcommands only)
  --reason <text>    Blocked reason (block only)
  -h, --help         Print this help and exit
  -V, --version      Print the version and exit
";

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
    pub fn name(&self) -> &'static str {
        match self {
            Self::Next => "next",
            Self::Tasks => "tasks",
            Self::Status => "status",
            Self::Validate => "validate",
            Self::Complete { .. } => "complete",
            Self::Block { .. } => "block",
        }
    }

    pub fn is_mutating(&self) -> bool {
        matches!(self, Self::Complete { .. } | Self::Block { .. })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invocation {
    root: PathBuf,
    spec: String,
    json: bool,
    command: Command,
}

impl Invocation {
    fn new(root: PathBuf, spec: String, json: bool, command: Command) -> Self {
        Self {
            root,
            spec,
            json,
            command,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn spec(&self) -> &str {
        &self.spec
    }

    pub fn json(&self) -> bool {
        self.json
    }

    pub fn command(&self) -> &Command {
        &self.command
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Parsed {
    Help,
    Version,
    Run(Invocation),
}

pub fn help_text() -> &'static str {
    HELP_TEXT
}

pub fn version_text() -> String {
    format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION"))
}

fn usage(detail: impl Into<String>) -> AppError {
    AppError::usage("usage", detail)
}

fn missing_value(flag: &str) -> AppError {
    usage(format!("option `{flag}` requires a value"))
}

fn unexpected_value(flag: &str) -> AppError {
    usage(format!("flag `{flag}` does not take a value"))
}

fn take_value(
    args: &mut impl Iterator<Item = OsString>,
    flag: &str,
) -> Result<String, AppError> {
    match args.next() {
        Some(raw) => {
            let value = raw
                .into_string()
                .map_err(|_| usage("arguments must be valid UTF-8"))?;
            if value.starts_with('-') && value != "-" {
                Err(missing_value(flag))
            } else {
                Ok(value)
            }
        }
        None => Err(missing_value(flag)),
    }
}

pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Parsed, AppError> {
    let mut args = args.into_iter();
    let mut root: Option<String> = None;
    let mut spec: Option<String> = None;
    let mut reason: Option<String> = None;
    let mut json = false;
    let mut command: Option<String> = None;
    let mut task: Option<String> = None;

    while let Some(raw) = args.next() {
        let arg = raw
            .into_string()
            .map_err(|_| usage("arguments must be valid UTF-8"))?;

        if arg == "-h" || arg == "--help" {
            return Ok(Parsed::Help);
        }
        if arg == "-V" || arg == "--version" {
            return Ok(Parsed::Version);
        }

        if let Some(rest) = arg.strip_prefix("--") {
            let (name, inline) = match rest.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (rest, None),
            };
            let flag = format!("--{name}");
            match name {
                "json" => {
                    if inline.is_some() {
                        return Err(unexpected_value(&flag));
                    }
                    json = true;
                }
                "root" | "spec" | "reason" => {
                    let value = match inline {
                        Some(value) => value,
                        None => take_value(&mut args, &flag)?,
                    };
                    if value.is_empty() {
                        return Err(missing_value(&flag));
                    }
                    match name {
                        "root" => root = Some(value),
                        "spec" => spec = Some(value),
                        _ => reason = Some(value),
                    }
                }
                "help" => {
                    if inline.is_some() {
                        return Err(unexpected_value(&flag));
                    }
                    return Ok(Parsed::Help);
                }
                "version" => {
                    if inline.is_some() {
                        return Err(unexpected_value(&flag));
                    }
                    return Ok(Parsed::Version);
                }
                _ => return Err(usage(format!("unknown option `{arg}`"))),
            }
        } else if arg.starts_with('-') && arg != "-" {
            return Err(usage(format!("unknown option `{arg}`")));
        } else if command.is_none() {
            command = Some(arg);
        } else if task.is_none() {
            task = Some(arg);
        } else {
            return Err(usage(format!("unexpected argument `{arg}`")));
        }
    }

    let command_name = command.ok_or_else(|| {
        usage("missing subcommand; expected next, tasks, status, validate, complete, or block")
    })?;

    if !matches!(
        command_name.as_str(),
        "next" | "tasks" | "status" | "validate" | "complete" | "block"
    ) {
        return Err(usage(format!("unknown subcommand `{command_name}`")));
    }

    let spec = spec.ok_or_else(|| usage("missing required option `--spec <name>`"))?;
    let root = PathBuf::from(root.unwrap_or_else(|| ".".to_owned()));

    let command = match command_name.as_str() {
        "next" | "tasks" | "status" | "validate" => {
            if let Some(task) = task {
                return Err(usage(format!(
                    "unexpected argument `{task}` for `{command_name}`"
                )));
            }
            if reason.is_some() {
                return Err(usage("option `--reason` is only supported by `block`"));
            }
            match command_name.as_str() {
                "next" => Command::Next,
                "tasks" => Command::Tasks,
                "status" => Command::Status,
                _ => Command::Validate,
            }
        }
        "complete" => {
            let task = task.ok_or_else(|| usage("missing `<task-id>` for `complete`"))?;
            if json {
                return Err(usage(
                    "flag `--json` is only supported by next, tasks, status, and validate",
                ));
            }
            if reason.is_some() {
                return Err(usage("option `--reason` is only supported by `block`"));
            }
            Command::Complete { task }
        }
        "block" => {
            let task = task.ok_or_else(|| usage("missing `<task-id>` for `block`"))?;
            let reason = reason
                .ok_or_else(|| usage("missing required option `--reason <text>` for `block`"))?;
            if json {
                return Err(usage(
                    "flag `--json` is only supported by next, tasks, status, and validate",
                ));
            }
            Command::Block { task, reason }
        }
        _ => unreachable!(),
    };

    Ok(Parsed::Run(Invocation::new(root, spec, json, command)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use std::path::Path;

    fn parse_args(args: &[&str]) -> Result<Parsed, AppError> {
        parse(args.iter().map(OsString::from))
    }

    fn run_invocation(args: &[&str]) -> Invocation {
        match parse_args(args) {
            Ok(Parsed::Run(invocation)) => invocation,
            other => panic!("expected an invocation for {args:?}, got {other:?}"),
        }
    }

    fn usage_error(args: &[&str]) -> AppError {
        match parse_args(args) {
            Err(error) => {
                assert_eq!(error.category(), ErrorCategory::Usage, "{args:?}");
                assert_eq!(error.exit_code(), 2, "{args:?}");
                error
            }
            other => panic!("expected a usage error for {args:?}, got {other:?}"),
        }
    }

    #[test]
    fn parses_each_read_command() {
        for (name, expected) in [
            ("next", Command::Next),
            ("tasks", Command::Tasks),
            ("status", Command::Status),
            ("validate", Command::Validate),
        ] {
            let invocation = run_invocation(&["--spec", "demo", name]);
            assert_eq!(invocation.command(), &expected, "{name}");
            assert_eq!(invocation.spec(), "demo", "{name}");
            assert_eq!(invocation.root(), Path::new("."), "{name}");
            assert!(!invocation.json(), "{name}");
        }
    }

    #[test]
    fn parses_complete_with_a_task_id() {
        let invocation = run_invocation(&["--spec", "demo", "complete", "2.3"]);
        assert_eq!(
            invocation.command(),
            &Command::Complete {
                task: "2.3".to_owned()
            }
        );
    }

    #[test]
    fn parses_block_with_a_reason() {
        let invocation = run_invocation(&[
            "--spec", "demo", "block", "2.3", "--reason", "waiting on credentials",
        ]);
        assert_eq!(
            invocation.command(),
            &Command::Block {
                task: "2.3".to_owned(),
                reason: "waiting on credentials".to_owned(),
            }
        );
    }

    #[test]
    fn accepts_both_option_syntaxes() {
        let spaced = run_invocation(&["--root", "repo", "--spec", "demo", "--json", "tasks"]);
        let equals = run_invocation(&["--root=repo", "--spec=demo", "--json", "tasks"]);
        assert_eq!(spaced, equals);
        assert_eq!(spaced.root(), Path::new("repo"));
        assert_eq!(spaced.spec(), "demo");
        assert!(spaced.json());
        assert_eq!(spaced.command(), &Command::Tasks);

        let spaced = run_invocation(&["--spec", "demo", "block", "2.1", "--reason", "waiting"]);
        let equals = run_invocation(&["--spec=demo", "block", "2.1", "--reason=waiting"]);
        assert_eq!(spaced, equals);
        assert_eq!(
            spaced.command(),
            &Command::Block {
                task: "2.1".to_owned(),
                reason: "waiting".to_owned(),
            }
        );
    }

    #[test]
    fn last_value_wins_for_value_options() {
        let invocation = run_invocation(&[
            "--spec", "one", "--root", "a", "--root=b", "--spec=two", "block", "--reason",
            "first", "1.2", "--reason=second",
        ]);
        assert_eq!(invocation.spec(), "two");
        assert_eq!(invocation.root(), Path::new("b"));
        assert_eq!(
            invocation.command(),
            &Command::Block {
                task: "1.2".to_owned(),
                reason: "second".to_owned(),
            }
        );
    }

    #[test]
    fn options_may_follow_positionals() {
        let invocation = run_invocation(&["complete", "1.1", "--spec", "demo", "--root", "repo"]);
        assert_eq!(invocation.spec(), "demo");
        assert_eq!(invocation.root(), Path::new("repo"));
        assert_eq!(
            invocation.command(),
            &Command::Complete {
                task: "1.1".to_owned()
            }
        );
    }

    #[test]
    fn root_defaults_to_the_current_directory() {
        let invocation = run_invocation(&["--spec=demo", "next"]);
        assert_eq!(invocation.root(), Path::new("."));
    }

    #[test]
    fn help_is_returned_without_a_spec() {
        for args in [
            &["--help"][..],
            &["-h"][..],
            &["--spec", "demo", "--help"][..],
        ] {
            assert_eq!(parse_args(args).expect("help parses"), Parsed::Help, "{args:?}");
        }
    }

    #[test]
    fn help_lists_every_subcommand_and_flag() {
        let help = help_text();
        for command in ["next", "tasks", "status", "validate", "complete", "block"] {
            assert!(help.contains(command), "help is missing {command}");
        }
        for flag in [
            "--root",
            "--spec",
            "--json",
            "--reason",
            "--help",
            "--version",
        ] {
            assert!(help.contains(flag), "help is missing {flag}");
        }
        assert!(help.contains("kiro-spec [--root <path>] --spec <name>"));
    }

    #[test]
    fn version_is_returned_and_matches_the_package_version() {
        for args in [&["--version"][..], &["-V"][..]] {
            assert_eq!(
                parse_args(args).expect("version parses"),
                Parsed::Version,
                "{args:?}"
            );
        }
        assert_eq!(
            version_text(),
            format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn rejects_a_missing_subcommand() {
        let error = usage_error(&[]);
        assert!(error.detail().contains("subcommand"), "{error}");
    }

    #[test]
    fn rejects_and_names_an_unknown_subcommand() {
        let error = usage_error(&["--spec", "demo", "bogus"]);
        assert!(error.detail().contains("bogus"), "{error}");
    }

    #[test]
    fn rejects_and_names_an_unknown_option() {
        for arg in ["--bogus", "-x"] {
            let error = usage_error(&["--spec", "demo", arg, "next"]);
            assert!(error.detail().contains(arg), "{error}");
        }
    }

    #[test]
    fn rejects_and_names_a_missing_spec() {
        for args in [&["next"][..], &["--json", "tasks"][..]] {
            let error = usage_error(args);
            assert!(error.detail().contains("--spec"), "{error}");
        }
    }

    #[test]
    fn rejects_missing_option_values() {
        for (args, flag) in [
            (&["--spec"][..], "--spec"),
            (&["--spec", "demo", "--root"][..], "--root"),
            (&["--spec", "demo", "--root", "--json", "next"][..], "--root"),
            (&["--spec=", "next"][..], "--spec"),
            (&["--root=", "--spec", "demo", "next"][..], "--root"),
            (&["--spec", "demo", "block", "1", "--reason"][..], "--reason"),
            (&["--spec", "demo", "block", "1", "--reason="][..], "--reason"),
        ] {
            let error = usage_error(args);
            assert!(error.detail().contains(flag), "{args:?}: {error}");
            assert!(error.detail().contains("value"), "{args:?}: {error}");
        }
    }

    #[test]
    fn rejects_multiple_commands_and_extra_positionals() {
        for (args, offending) in [
            (&["--spec", "demo", "next", "tasks"][..], "tasks"),
            (&["--spec", "demo", "next", "1.2"][..], "1.2"),
            (&["--spec", "demo", "complete", "1.2", "1.3"][..], "1.3"),
        ] {
            let error = usage_error(args);
            assert!(error.detail().contains(offending), "{args:?}: {error}");
        }
    }

    #[test]
    fn rejects_a_missing_task_id_for_mutations() {
        for command in ["complete", "block"] {
            let error = usage_error(&["--spec", "demo", command]);
            assert!(error.detail().contains("task-id"), "{command}: {error}");
        }
    }

    #[test]
    fn rejects_a_missing_reason_for_block() {
        let error = usage_error(&["--spec", "demo", "block", "1.2"]);
        assert!(error.detail().contains("--reason"), "{error}");
    }

    #[test]
    fn rejects_json_on_mutations() {
        for command in ["complete", "block"] {
            let error = usage_error(&[
                "--spec", "demo", "--json", command, "1.2", "--reason", "waiting",
            ]);
            assert!(error.detail().contains("--json"), "{command}: {error}");
        }
    }

    #[test]
    fn rejects_reason_on_commands_other_than_block() {
        for command in ["next", "tasks", "status", "validate", "complete"] {
            let mut args = vec!["--spec", "demo", "--reason", "waiting", command];
            if command == "complete" {
                args.push("1.2");
            }
            let error = usage_error(&args);
            assert!(error.detail().contains("--reason"), "{command}: {error}");
        }
    }

    #[test]
    fn rejects_values_for_flags() {
        for arg in ["--json=yes", "--help=1", "--version=1"] {
            let error = usage_error(&["--spec", "demo", arg, "next"]);
            assert!(error.detail().contains("value"), "{arg}: {error}");
        }
    }
}
