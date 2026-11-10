use std::ffi::OsString;

#[test]
fn crate_exposes_run() {
    let _run: fn(std::vec::IntoIter<OsString>) -> i32 = kiro_spec::run;
}

#[test]
fn binary_target_is_named_kiro_spec() {
    let binary = env!("CARGO_BIN_EXE_kiro-spec");
    assert!(std::path::Path::new(binary).exists());
}
