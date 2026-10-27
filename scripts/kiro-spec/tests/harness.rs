//! Self-test for the shared temp-tree test harness.

mod support;

use std::fs;

use support::{hash_tree, ReadOnlyDir, TempTree};

const SPEC_JSON: &str = "{\n  \"feature_name\": \"demo\",\n  \"phase\": \"tasks-generated\"\n}\n";
const TASKS: &str = "- [ ] 1. Foundation\n- [ ] 1.1 Ready\n  - _Requirements: 1.1_\n";
const REQUIREMENTS: &str = "# Requirements\n\n### Requirement 1: Demo\n\n1. It works.\n";

fn demo_tree(label: &str) -> TempTree {
    TempTree::with_spec(
        label,
        "demo",
        &[
            ("spec.json", SPEC_JSON),
            ("tasks.md", TASKS),
            ("requirements.md", REQUIREMENTS),
        ],
    )
}

#[test]
fn the_harness_builds_a_declarative_tree_under_temporary_storage() {
    let tree = demo_tree("harness-build");
    assert!(tree.root().is_absolute(), "the fixture root is absolute");
    assert!(
        tree.root().starts_with(std::env::temp_dir()),
        "the fixture root lives under the process temporary directory: {}",
        tree.root().display()
    );
    assert!(
        !tree.root().starts_with(env!("CARGO_MANIFEST_DIR")),
        "the fixture root must not live under the repository: {}",
        tree.root().display()
    );

    let spec = tree.spec_dir("demo");
    assert_eq!(
        fs::read_to_string(spec.join("spec.json")).unwrap(),
        SPEC_JSON
    );
    assert_eq!(fs::read_to_string(spec.join("tasks.md")).unwrap(), TASKS);
    assert_eq!(
        fs::read_to_string(spec.join("requirements.md")).unwrap(),
        REQUIREMENTS
    );
    assert_eq!(tree.root_arg(), tree.root().to_str().unwrap());

    tree.add_spec("empty", &[("tasks.md", "")]);
    assert_eq!(
        fs::read_to_string(tree.spec_dir("empty").join("tasks.md")).unwrap(),
        ""
    );
    tree.write("notes/README.md", "fixture notes\n");
    assert_eq!(
        fs::read_to_string(tree.root().join("notes/README.md")).unwrap(),
        "fixture notes\n"
    );
}

#[test]
fn a_fixture_tree_round_trips_into_a_temporary_copy() {
    let source = demo_tree("harness-source");
    let copy = TempTree::copy_fixture("harness-copy", source.root());

    assert_eq!(
        hash_tree(source.root()),
        hash_tree(copy.root()),
        "a copied fixture has the same tree hash as its source"
    );
    assert_eq!(
        fs::read(copy.spec_dir("demo").join("tasks.md")).unwrap(),
        TASKS.as_bytes()
    );
}

#[test]
fn invocations_report_captured_streams_and_the_exit_status() {
    let tree = demo_tree("harness-run");
    let before = tree.hash();
    assert_ne!(before.value(), 0, "the tree hash has a value");

    let read = tree.run_spec("demo", &["tasks", "--json"]);
    assert!(read.success(), "a readable invocation succeeds");
    assert_eq!(read.code(), 0, "a readable invocation exits zero");
    assert_eq!(read.status().code(), Some(0));
    assert_eq!(read.stderr(), "", "a successful read writes no stderr");
    assert_eq!(read.stdout_bytes(), read.stdout().as_bytes());
    assert_eq!(read.stderr_bytes(), b"");
    assert!(
        read.stdout().contains("\"schema_version\": 1"),
        "the captured stdout is the JSON result:\n{}",
        read.stdout()
    );

    let help = tree.run(&["--help"]);
    assert_eq!(help.code(), 0, "the harness forwards arbitrary arguments");
    assert!(help.stdout().contains("Usage:"));

    let default_root = tree.run_in(tree.root(), &["--spec", "demo", "tasks", "--json"]);
    assert_eq!(
        default_root.code(),
        0,
        "run_in supplies the process working directory"
    );
    assert!(default_root.stdout().contains("\"schema_version\": 1"));

    let missing = tree.run_spec("missing", &["tasks"]);
    assert_eq!(missing.code(), 1, "a missing spec directory exits one");
    assert_eq!(
        missing.stdout(),
        "",
        "a diagnostic-only failure writes no stdout"
    );
    assert!(
        missing.stderr().contains("missing"),
        "the captured stderr names the missing spec: {:?}",
        missing.stderr()
    );

    assert_eq!(tree.hash(), before, "read commands write nothing");
    tree.write("added.txt", "new bytes\n");
    assert_ne!(tree.hash(), before, "the tree hash observes file additions");
}

#[cfg(unix)]
#[test]
fn a_spec_directory_can_be_forced_read_only_and_is_restored() {
    use std::os::unix::fs::PermissionsExt;

    let tree = demo_tree("harness-read-only");
    let spec = tree.spec_dir("demo");
    let original = fs::metadata(&spec).unwrap().permissions().mode() & 0o777;
    assert_ne!(original & 0o200, 0, "the fixture directory starts writable");

    {
        let guard = ReadOnlyDir::new(&spec).unwrap();
        assert_eq!(guard.path(), spec.as_path());
        assert_eq!(
            fs::metadata(&spec).unwrap().permissions().mode() & 0o222,
            0,
            "the spec directory carries no write bits"
        );
        // The process may bypass permission bits when it runs as root; the
        // helper reports that so callers can skip write-failure assertions.
        let effective = guard.blocks_writes();
        if !effective {
            eprintln!("permission bits do not block writes for this process; skipping write probe");
        }
    }

    assert_eq!(
        fs::metadata(&spec).unwrap().permissions().mode() & 0o777,
        original,
        "dropping the guard restores the original directory permissions"
    );
}
