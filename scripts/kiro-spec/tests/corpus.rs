mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repository_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap_or_else(|error| {
            panic!(
                "cannot canonicalize repository root from {}: {error}",
                manifest_dir.display()
            )
        })
}

fn read_utf8_artifact(path: &Path) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => panic!(
            "corpus artifact is unreadable: {}: {error}",
            path.display()
        ),
    };
    if let Err(error) = std::str::from_utf8(&bytes) {
        panic!(
            "corpus artifact is not valid UTF-8: {}: {error}",
            path.display()
        );
    }
}

struct Invocation {
    spec: String,
    command: &'static str,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Invocation {
    fn run(binary: &Path, root: &Path, spec: &str, command: &'static str) -> Self {
        let output = Command::new(binary)
            .arg("--root")
            .arg(root)
            .arg("--spec")
            .arg(spec)
            .arg(command)
            .output()
            .unwrap_or_else(|error| {
                panic!("cannot run {} for spec {spec} {command}: {error}", binary.display())
            });
        Self {
            spec: spec.to_owned(),
            command,
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        }
    }

    fn describe(&self) -> String {
        format!(
            "spec: {}\ncommand: {}\nexit code: {:?}\nstdout:\n{}\nstderr:\n{}",
            self.spec,
            self.command,
            self.code,
            String::from_utf8_lossy(&self.stdout),
            String::from_utf8_lossy(&self.stderr)
        )
    }
}

fn assert_repeatable(first: &Invocation, second: &Invocation) {
    assert_eq!(
        first.code,
        second.code,
        "repeated runs disagree on exit status for {}\nfirst run:\n{}\nsecond run:\n{}",
        first.command,
        first.describe(),
        second.describe()
    );
    assert_eq!(
        first.stdout,
        second.stdout,
        "repeated runs disagree on stdout for {}\nfirst run:\n{}\nsecond run:\n{}",
        first.command,
        first.describe(),
        second.describe()
    );
    assert_eq!(
        first.stderr,
        second.stderr,
        "repeated runs disagree on stderr for {}\nfirst run:\n{}\nsecond run:\n{}",
        first.command,
        first.describe(),
        second.describe()
    );
}

#[test]
fn corpus_read_commands_are_deterministic_and_read_only() {
    if std::env::var_os("KIRO_SPEC_CORPUS").is_none() {
        println!("skipping corpus determinism test: KIRO_SPEC_CORPUS is not set");
        return;
    }

    let root = repository_root();
    let corpus = root.join(".kiro").join("specs");
    assert!(
        corpus.is_dir(),
        "corpus directory is missing: {}",
        corpus.display()
    );

    let mut specs = Vec::new();
    for entry in fs::read_dir(&corpus)
        .unwrap_or_else(|error| panic!("cannot read corpus {}: {error}", corpus.display()))
    {
        let entry = entry
            .unwrap_or_else(|error| panic!("cannot read an entry in {}: {error}", corpus.display()));
        let file_type = entry.file_type().unwrap_or_else(|error| {
            panic!(
                "cannot stat corpus entry {}: {error}",
                entry.path().display()
            )
        });
        if !file_type.is_dir() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .unwrap_or_else(|name| panic!("spec directory name is not UTF-8: {name:?}"));
        specs.push(name);
    }
    specs.sort();
    assert!(
        !specs.is_empty(),
        "corpus contains no spec directories: {}",
        corpus.display()
    );

    let binary = PathBuf::from(env!("CARGO_BIN_EXE_kiro-spec"));
    let before = support::tree_hash(&corpus);

    for spec in &specs {
        let spec_dir = corpus.join(spec);
        read_utf8_artifact(&spec_dir.join("spec.json"));
        read_utf8_artifact(&spec_dir.join("tasks.md"));
        read_utf8_artifact(&spec_dir.join("requirements.md"));

        for command in ["tasks", "next", "status", "validate"] {
            let first = Invocation::run(&binary, &root, spec, command);
            let second = Invocation::run(&binary, &root, spec, command);
            assert_repeatable(&first, &second);

            let expected = match command {
                "validate" => matches!(first.code, Some(0) | Some(1)),
                _ => first.code == Some(0),
            };
            assert!(
                expected,
                "unexpected exit status for {}\n{}",
                command,
                first.describe()
            );
            assert!(
                !first.stdout.is_empty(),
                "expected a result document on stdout\n{}",
                first.describe()
            );
            assert!(
                first.stderr.is_empty(),
                "expected empty stderr\n{}",
                first.describe()
            );
        }
    }

    let after = support::tree_hash(&corpus);
    assert_eq!(
        before, after,
        "read commands modified the corpus at {}",
        corpus.display()
    );
    println!(
        "corpus determinism verified for {} specs at {}",
        specs.len(),
        corpus.display()
    );
}
