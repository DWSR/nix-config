mod support;

use std::fs;
use std::path::Path;

use support::{copy_tree, read_only, tree_hash, SpecTree, TempDir};

const SPEC_JSON: &str = "{\n  \"feature_name\": \"demo\",\n  \"phase\": \"tasks-generated\"\n}\n";
const TASKS: &str = "# Implementation Plan\n\n- [ ] 1. First task\n- [ ] 2. Second task\n";
const REQUIREMENTS: &str = "# Requirements\n\n### Requirement 1: Demo\n\n#### Acceptance Criteria\n\n1. The demo shall exist.\n";
const DESIGN: &str = "# Design\n";

fn repository_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn declarative_spec_tree_round_trips_and_reports_streams() {
    let tree = SpecTree::new("demo", "roundtrip");
    tree.write("spec.json", SPEC_JSON)
        .write("tasks.md", TASKS)
        .write("requirements.md", REQUIREMENTS)
        .write("design.md", DESIGN);
    assert!(tree.root().starts_with(std::env::temp_dir()));
    let before = tree.tree_hash();

    let help = tree.run(&["--help"]).assert_success();
    assert!(help.stdout_text().contains("Subcommands:"));
    assert!(help.stderr().is_empty());

    let tasks = tree.run(&["tasks"]).assert_success();
    assert_eq!(
        tasks.stdout_text(),
        "1 First task [pending]\n2 Second task [pending]\n"
    );
    assert_eq!(tasks.code(), Some(0));
    assert!(tasks.stderr().is_empty());
    assert_eq!(tree.tree_hash(), before);
}

#[test]
fn harness_uses_compiled_binary_and_explicit_root_not_cwd() {
    let binary = Path::new(env!("CARGO_BIN_EXE_kiro-spec"));
    assert!(binary.is_file(), "missing binary: {}", binary.display());

    let tree = SpecTree::new("demo", "explicit-root");
    tree.write("tasks.md", TASKS);
    let elsewhere = TempDir::new("cwd-elsewhere");

    let tasks = tree.run_in(elsewhere.path(), &["tasks"]).assert_success();
    assert_eq!(
        tasks.stdout_text(),
        "1 First task [pending]\n2 Second task [pending]\n"
    );
    assert!(!tree.root().starts_with(repository_root()));
    assert!(!elsewhere.path().starts_with(repository_root()));
    assert!(elsewhere.path().starts_with(std::env::temp_dir()));
    assert!(!elsewhere.path().join(".kiro").exists());
}

#[test]
fn copy_tree_preserves_nested_bytes_and_leaves_the_source_unchanged() {
    let source = SpecTree::new("demo", "copy-source");
    source
        .write("spec.json", SPEC_JSON)
        .write("tasks.md", TASKS);
    source.write_at("extras/nested/blob.bin", [0u8, 1, 2, 0xFF]);
    let source_hash = source.tree_hash();

    let destination = TempDir::new("copy-destination");
    let target = destination.path().join("copied");
    copy_tree(source.root(), &target).expect("copy fixture tree");

    assert_eq!(
        fs::read(target.join(".kiro/specs/demo/tasks.md")).expect("copied tasks.md"),
        TASKS.as_bytes()
    );
    assert_eq!(
        fs::read(target.join("extras/nested/blob.bin")).expect("copied blob"),
        [0u8, 1, 2, 0xFF]
    );
    assert_eq!(tree_hash(&target), source_hash);
    assert_eq!(source.tree_hash(), source_hash);
}

#[test]
fn tree_hash_is_stable_detects_changes_and_honours_exclusions() {
    let tree = SpecTree::new("demo", "hash");
    tree.write("spec.json", SPEC_JSON).write("tasks.md", TASKS);

    let first = tree.tree_hash();
    assert_eq!(first, tree.tree_hash());

    let without_tasks = tree.tree_hash_excluding(&["tasks.md"]);
    tree.write("tasks.md", "# Changed\n");
    assert_ne!(tree.tree_hash(), first);
    assert_eq!(tree.tree_hash_excluding(&["tasks.md"]), without_tasks);

    tree.write("spec.json", "{}\n");
    assert_ne!(tree.tree_hash_excluding(&["tasks.md"]), without_tasks);
}

#[test]
fn read_only_guard_blocks_writes_and_restores_permissions() {
    let tree = SpecTree::new("demo", "read-only");
    tree.write("tasks.md", TASKS);

    let guard = read_only(tree.spec_dir());
    if !guard.is_supported() {
        eprintln!("skipping read-only assertion: platform does not expose unix modes");
        return;
    }
    if guard.can_still_write() {
        eprintln!("skipping read-only assertion: process can still write this directory");
        return;
    }

    let probe = tree.spec_dir().join("probe.txt");
    let error = fs::write(&probe, b"blocked").expect_err("write to read-only directory");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

    drop(guard);
    fs::write(&probe, b"allowed").expect("write succeeds after permissions are restored");
    assert_eq!(fs::read(&probe).expect("read probe"), b"allowed");
}

#[test]
fn only_declared_artifacts_exist_in_the_temp_tree() {
    let tree = SpecTree::new("demo", "declared");
    assert!(!tree.spec_dir().join("tasks.md").exists());
    assert!(!tree.spec_dir().join("spec.json").exists());

    tree.write("spec.json", SPEC_JSON);
    assert!(tree.spec_dir().join("spec.json").exists());
    assert!(!tree.spec_dir().join("tasks.md").exists());

    let missing = tree.run(&["tasks"]).assert_exit(1);
    assert!(missing.stdout().is_empty());
    assert!(!missing.stderr().is_empty());
}

#[test]
fn harness_paths_live_outside_the_repository() {
    let tree = SpecTree::new("demo", "outside-repo");
    let scratch = TempDir::new("outside-repo");

    assert!(tree.root().starts_with(std::env::temp_dir()));
    assert!(scratch.path().starts_with(std::env::temp_dir()));
    assert!(!tree.root().starts_with(repository_root()));
    assert!(!scratch.path().starts_with(repository_root()));
    assert!(!tree.spec_dir().starts_with(repository_root()));
}
