//! Library core for the `kiro-spec` command-line tool.
//!
//! The binary is a thin argument adapter over this crate: parsing, state
//! derivation, validation, rendering, and editing live in separate modules so
//! every consumer observes the same rules.

use std::ffi::OsString;

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
pub fn run<I>(_args: I) -> i32
where
    I: IntoIterator<Item = OsString>,
{
    0
}
