//! Argument grammar, help text, subcommand dispatch, and usage diagnostics.

use std::ffi::OsString;

use crate::error::AppError;

/// Execute one invocation and return its complete result document.
///
/// `Some(document)` is written to stdout verbatim; `None` means the command
/// produces no result at all. The result is fully rendered before this
/// function returns, so `run()` can never publish a partial document. The
/// argv grammar and command dispatch are added by the CLI shell task; this
/// seam keeps process-level exit codes and stream handling independent of it.
pub fn execute<I>(_args: I) -> Result<Option<String>, AppError>
where
    I: IntoIterator<Item = OsString>,
{
    Ok(None)
}
