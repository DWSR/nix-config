//! Determinism and read-only behavior over the checked-in spec corpus.
//!
//! The test is gated by `KIRO_SPEC_CORPUS`: the crate's `cargo test` also runs
//! inside a Nix build whose cleaned source does not contain the repository's
//! `.kiro/specs/` tree, so the variable keeps that build hermetic. The
//! variable's value is not interpreted; only its presence enables the run.
//!
//! Every spec directory is exercised twice per command and format. Repeated
//! output must be byte-identical, and a hash of the corpus taken before and
//! after the runs proves the read commands never write.

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use support::{hash_tree, run_binary, Run};

/// Every subcommand that only reads a spec.
const COMMANDS: [&str; 4] = ["tasks", "next", "status", "validate"];

/// The two output formats, with the argument that selects each one.
const FORMATS: [(&str, Option<&str>); 2] = [("human", None), ("json", Some("--json"))];

/// The artifacts whose encoding the corpus must report loudly.
const ARTIFACTS: [&str; 3] = ["spec.json", "tasks.md", "requirements.md"];

#[test]
fn every_corpus_spec_renders_identically_twice_without_writing() {
    let Some(root) = corpus_root() else {
        return;
    };
    let specs_directory = root.join(".kiro/specs");
    let specs = spec_names(&specs_directory);
    assert!(
        !specs.is_empty(),
        "the checked-in corpus at {} has no spec directories",
        specs_directory.display()
    );
    for spec in &specs {
        assert_artifacts_are_readable_text(&specs_directory, spec);
    }

    let before = hash_tree(&specs_directory);
    for spec in &specs {
        for command in COMMANDS {
            for (format, flag) in FORMATS {
                verify_deterministic(&root, spec, command, format, flag);
            }
        }
    }
    let after = hash_tree(&specs_directory);
    assert_eq!(
        before,
        after,
        "read commands modified the corpus at {} ({before} -> {after})",
        specs_directory.display()
    );
}

/// Run one command in one format twice and compare the observable results.
fn verify_deterministic(root: &Path, spec: &str, command: &str, format: &str, flag: Option<&str>) {
    let root = root.to_str().expect("the corpus root is valid UTF-8");
    let mut arguments = vec!["--root", root, "--spec", spec];
    if let Some(flag) = flag {
        arguments.push(flag);
    }
    arguments.push(command);

    let first = run_binary(&arguments);
    let second = run_binary(&arguments);

    assert_success(&first, spec, command, format);
    assert_success(&second, spec, command, format);
    assert_eq!(
        first.code(),
        second.code(),
        "corpus spec {spec:?} {command} ({format}) changed its exit status between runs",
    );
    assert_same_stdout(
        first.stdout_bytes(),
        second.stdout_bytes(),
        spec,
        command,
        format,
    );

    let stdout = text(spec, command, format, "stdout", first.stdout_bytes());
    if flag == Some("--json") {
        serde_json::from_str::<serde_json::Value>(stdout).unwrap_or_else(|error| {
            panic!(
                "corpus spec {spec:?} {command} ({format}) did not emit one JSON document: {error}"
            )
        });
    }
}

/// Assert a command result: read commands succeed, and `validate` may report
/// error-severity findings (exit 1) as result data rather than failing.
fn assert_success(run: &Run, spec: &str, command: &str, format: &str) {
    let code = run.code();
    let accepted = if command == "validate" {
        matches!(code, 0 | 1)
    } else {
        code == 0
    };
    assert!(
        accepted,
        "corpus spec {spec:?} {command} ({format}) exited {code}; stderr: {}",
        String::from_utf8_lossy(run.stderr_bytes())
    );
    assert!(
        run.stderr_bytes().is_empty(),
        "corpus spec {spec:?} {command} ({format}) wrote to stderr: {}",
        String::from_utf8_lossy(run.stderr_bytes())
    );
}

/// Compare repeated stdout bytes without dumping a large document on failure.
fn assert_same_stdout(first: &[u8], second: &[u8], spec: &str, command: &str, format: &str) {
    if first == second {
        return;
    }
    let first_difference = first
        .iter()
        .zip(second)
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| first.len().min(second.len()));
    panic!(
        "corpus spec {spec:?} {command} ({format}) output changed at byte {first_difference} \
         ({} vs {} bytes)",
        first.len(),
        second.len()
    );
}

/// Decode one captured stream, naming the spec and command when it is not UTF-8.
fn text<'a>(spec: &str, command: &str, format: &str, stream: &str, bytes: &'a [u8]) -> &'a str {
    std::str::from_utf8(bytes).unwrap_or_else(|error| {
        panic!("corpus spec {spec:?} {command} ({format}) produced non-UTF-8 {stream}: {error}")
    })
}

/// The repository root holding the corpus, or `None` when the gate is absent.
fn corpus_root() -> Option<PathBuf> {
    if std::env::var_os("KIRO_SPEC_CORPUS").is_none() {
        eprintln!("skipping corpus determinism test: KIRO_SPEC_CORPUS is not set");
        return None;
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.join("../..");
    let root = fs::canonicalize(&root).unwrap_or_else(|error| {
        panic!(
            "KIRO_SPEC_CORPUS is set but the repository root {} is unreadable: {error}",
            root.display()
        )
    });
    let specs = root.join(".kiro/specs");
    assert!(
        specs.is_dir(),
        "KIRO_SPEC_CORPUS is set but {} is not a directory",
        specs.display()
    );
    Some(root)
}

/// Every spec directory name beneath `.kiro/specs/`, sorted for stable output.
fn spec_names(specs_directory: &Path) -> Vec<String> {
    let entries = fs::read_dir(specs_directory).unwrap_or_else(|error| {
        panic!(
            "cannot read the corpus directory {}: {error}",
            specs_directory.display()
        )
    });
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| {
            panic!(
                "cannot read an entry of the corpus directory {}: {error}",
                specs_directory.display()
            )
        });
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().into_string().unwrap_or_else(|name| {
            panic!("corpus spec directory name is not UTF-8: {name:?}");
        });
        names.push(name);
    }
    names.sort();
    names
}

/// Fail loudly when a corpus artifact exists but cannot be read or decoded.
///
/// A missing artifact is not an unreadability defect: `validate` reports it as
/// a finding, and the commands' exit status still proves they ran.
fn assert_artifacts_are_readable_text(specs_directory: &Path, spec: &str) {
    for artifact in ARTIFACTS {
        let path = specs_directory.join(spec).join(artifact);
        match fs::read(&path) {
            Ok(bytes) => {
                if let Err(error) = std::str::from_utf8(&bytes) {
                    panic!(
                        "corpus spec {spec:?} has a non-UTF-8 {artifact} at {}: {error}",
                        path.display()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!(
                "corpus spec {spec:?} has an unreadable {artifact} at {}: {error}",
                path.display()
            ),
        }
    }
}
