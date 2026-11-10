use std::ffi::OsString;

use crate::error::AppError;

pub fn parse(_args: impl IntoIterator<Item = OsString>) -> Result<(), AppError> {
    Err(AppError::usage("usage", "missing subcommand"))
}
