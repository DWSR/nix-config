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

pub fn run(_args: impl IntoIterator<Item = OsString>) -> i32 {
    0
}
