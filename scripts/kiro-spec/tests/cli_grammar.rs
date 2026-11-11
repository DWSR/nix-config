use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kiro-spec-cli-grammar-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let spec = root.join(".kiro/specs/demo");
        std::fs::create_dir_all(&spec).expect("create fixture spec");
        std::fs::write(
            spec.join("spec.json"),
            "{\n  \"feature_name\": \"demo\",\n  \"phase\": \"tasks-generated\"\n}\n",
        )
        .expect("write spec.json");
        std::fs::write(
            spec.join("tasks.md"),
            "# Implementation Plan\n\n- [ ] 1. Pending work\n- [x] 1.1 Finished work\n",
        )
        .expect("write tasks.md");
        std::fs::write(
            spec.join("requirements.md"),
            "# Requirements\n\n### Requirement 1: Demo\n\n#### Acceptance Criteria\n\n1. The demo shall exist.\n",
        )
        .expect("write requirements.md");
        std::fs::write(spec.join("design.md"), "# Design\n").expect("write design.md");
        std::fs::write(spec.join("brief.md"), "# Brief\n").expect("write brief.md");
        Self { root }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
            .arg("--root")
            .arg(&self.root)
            .args(args)
            .output()
            .expect("binary runs")
    }

    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        collect(&self.root, &self.root, &mut files);
        files
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn collect(base: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(directory)
        .expect("read fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect(base, &path, files);
        } else {
            let relative = path.strip_prefix(base).expect("path under base").to_path_buf();
            files.insert(relative, std::fs::read(&path).expect("read fixture file"));
        }
    }
}

#[test]
fn help_lists_every_subcommand_and_flag() {
    let fixture = Fixture::new();
    let output = fixture.run(&["--help"]);
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty(), "stderr: {:?}", output.stderr);
    let stdout = String::from_utf8(output.stdout).expect("utf-8 help");
    for command in ["next", "tasks", "status", "validate", "complete", "block"] {
        assert!(stdout.contains(command), "help is missing {command}:\n{stdout}");
    }
    for flag in [
        "--root",
        "--spec",
        "--json",
        "--reason",
        "--help",
        "--version",
    ] {
        assert!(stdout.contains(flag), "help is missing {flag}:\n{stdout}");
    }
    assert!(
        stdout.contains("kiro-spec [--root <path>] --spec <name>"),
        "help is missing the synopsis:\n{stdout}"
    );
}

#[test]
fn short_help_works_without_spec() {
    let output = Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
        .arg("-h")
        .output()
        .expect("binary runs");
    assert_eq!(output.status.code(), Some(0));
    assert!(!output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn version_matches_the_cargo_package_version() {
    let fixture = Fixture::new();
    for flag in ["--version", "-V"] {
        let output = fixture.run(&[flag]);
        assert_eq!(output.status.code(), Some(0), "{flag}");
        assert!(output.stderr.is_empty(), "{flag}");
        assert_eq!(
            String::from_utf8(output.stdout).expect("utf-8 version"),
            format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION")),
            "{flag}"
        );
    }
}

#[test]
fn invalid_argv_leaves_the_fixture_byte_identical() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let cases: &[&[&str]] = &[
        &["--bogus", "next"],
        &["bogus"],
        &["--json", "next"],
        &["--json", "complete", "1"],
        &["block", "1"],
        &["--spec", "demo", "--reason", "waiting", "next"],
        &["--spec"],
        &["--spec", "demo", "next", "tasks"],
    ];
    for args in cases {
        let output = fixture.run(args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
    }
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn usage_diagnostics_name_the_offending_flag_or_command() {
    let fixture = Fixture::new();

    let output = fixture.run(&["--bogus", "next"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--bogus"));

    let output = fixture.run(&["bogus"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("bogus"));

    let output = fixture.run(&["next"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--spec"));
}

#[test]
fn valid_invocations_are_not_yet_wired_and_leave_the_fixture_unchanged() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let cases: &[&[&str]] = &[
        &["--spec", "demo", "validate"],
        &["--spec", "demo", "complete", "1"],
        &["--spec", "demo", "block", "1", "--reason", "waiting"],
    ];
    for args in cases {
        let output = fixture.run(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("not yet wired"), "{args:?}: {stderr}");
    }
    assert_eq!(fixture.snapshot(), before);
}
