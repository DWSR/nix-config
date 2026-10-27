//! Crate-foundation checks for task 1.1.

use std::path::Path;

#[test]
fn produced_binary_is_named_kiro_spec() {
    let binary = Path::new(env!("CARGO_BIN_EXE_kiro-spec"));
    assert_eq!(
        binary.file_name().and_then(|name| name.to_str()),
        Some("kiro-spec")
    );
}
