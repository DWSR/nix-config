//! Process-level checks for the argument grammar, help, and version.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// A disposable spec tree used to prove rejected argv touches no file.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("kiro-spec-cli-{}-{id}", std::process::id()));
        let spec = root.join(".kiro/specs/demo");
        fs::create_dir_all(&spec).expect("fixture spec directory is created");
        fs::write(
            spec.join("spec.json"),
            "{\n  \"feature_name\": \"demo\",\n  \"phase\": \"tasks-generated\"\n}\n",
        )
        .expect("fixture spec.json is written");
        fs::write(
            spec.join("tasks.md"),
            "- [ ] 1. Foundation\n- [ ] 1.1 Ready\n  - _Requirements: 1.1_\n",
        )
        .expect("fixture tasks.md is written");
        fs::write(
            spec.join("requirements.md"),
            "# Requirements\n\n### Requirement 1: Demo\n\n1. It works.\n",
        )
        .expect("fixture requirements.md is written");
        Self { root }
    }

    fn root_arg(&self) -> String {
        self.root
            .to_str()
            .expect("fixture root is valid UTF-8")
            .to_string()
    }

    /// Every file beneath the fixture root with its exact bytes.
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = Vec::new();
        collect(&self.root, &mut files);
        files.sort_by(|left, right| left.0.cmp(&right.0));
        files
    }
}

fn collect(directory: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
    let entries = fs::read_dir(directory).expect("fixture directory is readable");
    for entry in entries {
        let entry = entry.expect("fixture entry is readable");
        let path = entry.path();
        if path.is_dir() {
            collect(&path, files);
        } else {
            files.push((
                path.clone(),
                fs::read(&path).expect("fixture file is readable"),
            ));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(args: &[String]) -> Run {
    let output = Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
        .args(args)
        .output()
        .expect("kiro-spec binary runs");
    Run {
        code: output.status.code().expect("kiro-spec exited normally"),
        stdout: String::from_utf8(output.stdout).expect("stdout is valid UTF-8"),
        stderr: String::from_utf8(output.stderr).expect("stderr is valid UTF-8"),
    }
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

#[test]
fn help_lists_the_synopsis_every_subcommand_and_every_flag() {
    for flag in ["--help", "-h"] {
        let output = run(&strings(&[flag]));
        assert_eq!(output.code, 0, "{flag} must exit zero");
        assert_eq!(output.stderr, "", "{flag} must not write stderr");
        assert!(
            output.stdout.contains("Usage:"),
            "{flag} must print the synopsis:\n{}",
            output.stdout
        );
        for command in ["next", "tasks", "status", "validate", "complete", "block"] {
            assert!(
                output.stdout.contains(command),
                "{flag} must list subcommand {command}:\n{}",
                output.stdout
            );
        }
        for option in [
            "--root",
            "--spec",
            "--json",
            "--reason",
            "--help",
            "--version",
        ] {
            assert!(
                output.stdout.contains(option),
                "{flag} must list option {option}:\n{}",
                output.stdout
            );
        }
        for alias in ["-h", "-V"] {
            assert!(
                output.stdout.contains(alias),
                "{flag} must list short alias {alias}:\n{}",
                output.stdout
            );
        }
    }
}

#[test]
fn version_matches_the_cargo_package_version() {
    let expected = format!("kiro-spec {}\n", env!("CARGO_PKG_VERSION"));
    for flag in ["--version", "-V"] {
        let output = run(&strings(&[flag]));
        assert_eq!(output.code, 0, "{flag} must exit zero");
        assert_eq!(output.stderr, "", "{flag} must not write stderr");
        assert_eq!(
            output.stdout, expected,
            "{flag} must print the package version"
        );
    }
}

#[test]
fn rejected_argv_exits_two_with_a_diagnostic_and_touches_no_file() {
    let fixture = Fixture::new();
    let root = fixture.root_arg();
    let accepted = run(&[
        "--root".to_string(),
        root.clone(),
        "--spec".to_string(),
        "demo".to_string(),
        "next".to_string(),
    ]);
    assert_eq!(accepted.code, 0, "a readable invocation is accepted");
    assert_eq!(
        accepted.stderr, "",
        "a readable invocation writes no diagnostic"
    );

    let cases: Vec<Vec<String>> = vec![
        strings(&["--root", &root, "--spec", "demo", "--bogus", "next"]),
        strings(&[
            "--root",
            &root,
            "--spec",
            "does-not-exist",
            "--bogus",
            "next",
        ]),
        strings(&[
            "--root",
            &root,
            "--spec",
            "does-not-exist",
            "--json",
            "complete",
            "1",
        ]),
        strings(&[
            "--root",
            &root,
            "--spec",
            "does-not-exist",
            "next",
            "--json=yes",
        ]),
        strings(&["--root", &root, "--spec", "demo", "frobnicate"]),
        strings(&["--root", &root, "--spec", "demo", "next", "--bogus"]),
        strings(&["--root", &root, "next"]),
        strings(&["--root", &root, "--spec"]),
        strings(&["--root", &root]),
        strings(&["--root", &root, "--spec", "demo"]),
        strings(&["--root", &root, "--spec", "demo", "--json", "complete", "1"]),
        strings(&[
            "--root", &root, "--spec", "demo", "--json", "block", "1", "--reason", "x",
        ]),
        strings(&["--root", &root, "--spec", "demo", "block", "1"]),
        strings(&["--root", &root, "--spec", "demo", "complete"]),
        strings(&["--root", &root, "--spec", "demo", "complete", "not-an-id"]),
        strings(&["--root", &root, "--spec", "demo", "next", "--json=yes"]),
        strings(&["--root", &root, "--spec", "demo", "next", "extra"]),
        strings(&[
            "--root", &root, "--spec", "demo", "complete", "1", "--reason", "x",
        ]),
        strings(&[
            "--root", &root, "--spec", "demo", "block", "1", "--reason", "",
        ]),
    ];

    let before = fixture.snapshot();
    for args in cases {
        let output = run(&args);
        assert_eq!(output.code, 2, "argv {args:?} must exit 2");
        assert_eq!(output.stdout, "", "argv {args:?} must not write stdout");
        assert!(
            output.stderr.starts_with("kiro-spec: "),
            "argv {args:?} must write a diagnostic, got {:?}",
            output.stderr
        );
        assert!(
            !output.stderr.is_empty() && output.stderr.ends_with('\n'),
            "argv {args:?} diagnostic must be one terminated line"
        );
    }
    assert_eq!(
        fixture.snapshot(),
        before,
        "rejected argv must leave the fixture spec byte-identical"
    );
}
