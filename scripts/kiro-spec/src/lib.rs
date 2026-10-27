//! Library core for the `kiro-spec` CLI.
//!
//! The modules below are the whole public surface: the CLI adapter parses
//! argv, the filesystem readers produce raw artifacts, the pure modules derive
//! and validate, the renderers serialise, and `edit` is the only writer.

pub mod cli;
pub mod edit;
pub mod error;
pub mod paths;
pub mod render;
pub mod requirements;
pub mod spec_json;
pub mod tasks;
pub mod validate;

/// Runs the CLI with the given arguments and returns the process exit code.
///
/// Argument interpretation and command dispatch land in later tasks; the
/// scaffold returns success so the binary and its exit-code contract can be
/// exercised end to end.
pub fn run(_args: impl IntoIterator<Item = std::ffi::OsString>) -> i32 {
    0
}
