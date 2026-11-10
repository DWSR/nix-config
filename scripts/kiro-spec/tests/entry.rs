use std::process::Command;

#[test]
fn usage_failure_writes_nothing_to_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
        .output()
        .expect("binary runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        output.stdout.is_empty(),
        "stdout: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
    assert!(stderr.starts_with("kiro-spec: "), "stderr: {stderr}");
}

#[test]
fn unknown_argument_is_a_usage_failure_with_no_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
        .arg("bogus")
        .output()
        .expect("binary runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}
