//! Crate scaffold contract: documented module surface, a `kiro-spec` binary
//! that exits with `run`'s code, a checked-in lockfile, and only the two
//! allowed runtime dependencies.

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

#[test]
fn library_exposes_the_documented_module_surface() {
    // Each module named in design.md's file structure plan must exist in the
    // library, even while it is still a compiling stub.
    #[allow(unused_imports)]
    use kiro_spec::{cli, edit, error, paths, render, requirements, spec_json, tasks, validate};
}

#[test]
fn manifest_pins_edition_and_the_runtime_dependency_set() {
    let manifest = read(MANIFEST_DIR, "Cargo.toml");

    assert!(
        manifest.contains("edition = \"2021\""),
        "Cargo.toml must declare edition 2021"
    );

    let mut section = String::new();
    let mut dependencies = Vec::new();
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            section = line.to_string();
            continue;
        }
        if section != "[dependencies]" || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let name = line
            .split('=')
            .next()
            .expect("dependency line has a name")
            .trim()
            .to_string();
        dependencies.push(name);
    }
    dependencies.sort();

    assert_eq!(
        dependencies,
        vec!["serde".to_string(), "serde_json".to_string()],
        "only serde and serde_json may be runtime dependencies"
    );

    let serde_line = manifest
        .lines()
        .find(|line| line.trim().starts_with("serde ="))
        .expect("serde dependency is declared");
    assert!(
        serde_line.contains("\"derive\""),
        "serde must enable its derive feature"
    );
}

#[test]
fn lockfile_is_checked_in_with_the_crate() {
    assert!(
        Path::new(MANIFEST_DIR).join("Cargo.lock").is_file(),
        "Cargo.lock must be checked in beside Cargo.toml"
    );
}

#[test]
fn binary_is_named_kiro_spec_and_exits_with_run_result() {
    let exe = env!("CARGO_BIN_EXE_kiro-spec");
    assert_eq!(
        Path::new(exe).file_name().and_then(|name| name.to_str()),
        Some("kiro-spec"),
        "the produced binary must be named kiro-spec"
    );

    // main() forwards std::env::args_os(), so the process exit code must equal
    // what the library reports for the same argv. The extra argument makes a
    // dropped-argument main differ from the library as soon as argv parsing
    // exists.
    let argv: Vec<OsString> = vec![OsString::from(exe), OsString::from("--help")];
    let expected = kiro_spec::run(argv.clone());

    let output = Command::new(exe)
        .args(&argv[1..])
        .output()
        .expect("the built binary runs");
    assert_eq!(
        Some(expected),
        output.status.code(),
        "the binary must exit with run()'s code"
    );
}

fn read(dir: &str, name: &str) -> String {
    std::fs::read_to_string(Path::new(dir).join(name))
        .unwrap_or_else(|error| panic!("cannot read {name}: {error}"))
}
