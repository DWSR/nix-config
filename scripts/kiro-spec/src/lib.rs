//! Library core for the `kiro-spec` command-line tool.
//!
//! The binary is a thin argument adapter over this crate: parsing, state
//! derivation, validation, rendering, and editing live in separate modules so
//! every consumer observes the same rules.

use std::ffi::OsString;
use std::io::{self, Write};

pub mod cli;
pub mod edit;
pub mod error;
pub mod paths;
pub mod render;
pub mod requirements;
pub mod spec_json;
pub mod tasks;
pub mod validate;

/// Run the CLI over an argument iterator and return the process exit code.
///
/// This is the only place the process streams are touched. Command execution
/// returns a completely rendered result, which is published in one write only
/// after it exists; a failure writes a single diagnostic line to stderr and
/// never emits stdout bytes.
pub fn run<I>(args: I) -> i32
where
    I: IntoIterator<Item = OsString>,
{
    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut stdout = stdout.lock();
    let mut stderr = stderr.lock();
    run_with(args, &mut stdout, &mut stderr, cli::execute)
}

/// Execute `args` with `execute` and publish the outcome to the given streams.
///
/// `execute` returns the complete result document, or `None` when the command
/// produces no result. The exit code is `2` for usage failures and `1` for
/// every other failure; success always exits `0`. Tests provide their own
/// executor to prove the mapping and stream separation without spawning a
/// process.
pub fn run_with<I, W, E, F>(args: I, stdout: &mut W, stderr: &mut E, execute: F) -> i32
where
    I: IntoIterator<Item = OsString>,
    W: Write,
    E: Write,
    F: FnOnce(I) -> Result<Option<String>, error::AppError>,
{
    match execute(args) {
        Ok(Some(document)) => match stdout
            .write_all(document.as_bytes())
            .and_then(|()| stdout.flush())
        {
            Ok(()) => 0,
            Err(io_error) => {
                let error = error::AppError::write("stdout", io_error.to_string());
                let _ = writeln!(stderr, "{}", error.diagnostic());
                error.exit_code()
            }
        },
        Ok(None) => 0,
        Err(error) => {
            let _ = writeln!(stderr, "{}", error.diagnostic());
            error.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    fn run_failing(error: AppError) -> (i32, String, String) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_with(Vec::<OsString>::new(), &mut stdout, &mut stderr, |_args| {
            Err(error)
        });
        (
            code,
            String::from_utf8(stdout).expect("stdout is valid UTF-8"),
            String::from_utf8(stderr).expect("stderr is valid UTF-8"),
        )
    }

    #[test]
    fn a_failed_command_writes_nothing_to_stdout() {
        let cases = [
            (
                AppError::usage("usage", "unknown option `--bogus`"),
                2,
                "kiro-spec: usage: unknown option `--bogus`\n".to_string(),
            ),
            (
                AppError::resolution(".kiro/specs/missing", "spec directory not found"),
                1,
                "kiro-spec: .kiro/specs/missing: spec directory not found\n".to_string(),
            ),
            (
                AppError::read(".kiro/specs/demo/spec.json", "invalid JSON"),
                1,
                "kiro-spec: .kiro/specs/demo/spec.json: invalid JSON\n".to_string(),
            ),
            (
                AppError::conflict("7.2", "no task matches this identifier"),
                1,
                "kiro-spec: 7.2: no task matches this identifier\n".to_string(),
            ),
            (
                AppError::write(".kiro/specs/demo/tasks.md", "permission denied"),
                1,
                "kiro-spec: .kiro/specs/demo/tasks.md: permission denied\n".to_string(),
            ),
        ];

        for (error, expected_code, expected_stderr) in cases {
            let (code, stdout, stderr) = run_failing(error);
            assert_eq!(code, expected_code);
            assert_eq!(stdout, "", "a failed command must not emit stdout bytes");
            assert_eq!(stderr, expected_stderr);
        }
    }

    #[test]
    fn a_successful_result_is_published_only_after_it_is_complete() {
        let document = "spec: demo\nstage: tasks-generated\ntotal: 3\n";
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_with(Vec::<OsString>::new(), &mut stdout, &mut stderr, |_args| {
            Ok(Some(document.to_string()))
        });
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8(stdout).unwrap(), document);
        assert_eq!(String::from_utf8(stderr).unwrap(), "");
    }

    #[test]
    fn a_command_without_a_result_writes_no_stdout_byte() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_with(Vec::<OsString>::new(), &mut stdout, &mut stderr, |_args| {
            Ok(None)
        });
        assert_eq!(code, 0);
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }

    #[test]
    fn a_stdout_failure_is_reported_on_stderr_with_exit_one() {
        struct FullStdout;

        impl Write for FullStdout {
            fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let mut stdout = FullStdout;
        let mut stderr = Vec::new();
        let code = run_with(Vec::<OsString>::new(), &mut stdout, &mut stderr, |_args| {
            Ok(Some("spec: demo\n".to_string()))
        });
        assert_eq!(code, 1);
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "kiro-spec: stdout: closed\n"
        );
    }
}
