use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;

static COUNTER: AtomicU32 = AtomicU32::new(0);

const MIXED_TASKS: &str = "# Implementation Plan\n\n- [ ] 1. Foundation\n- [x] 1.1 Pin inputs\n- [ ]* 1.2 Optional polish\n- [!] 2. Blocked work\n  - _Blocked: waiting on credentials_\n- [ ] 3. Last task\n";

struct Fixture {
    root: PathBuf,
    spec: PathBuf,
}

impl Fixture {
    fn new(tag: &str, tasks: Option<&str>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "kiro-spec-read-commands-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let spec = root.join(".kiro/specs/demo");
        fs::create_dir_all(&spec).expect("create fixture spec directory");
        if let Some(tasks) = tasks {
            fs::write(spec.join("tasks.md"), tasks).expect("write fixture tasks.md");
        }
        Self { root, spec }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_kiro-spec"))
            .arg("--root")
            .arg(&self.root)
            .arg("--spec")
            .arg("demo")
            .args(args)
            .output()
            .expect("binary runs")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn success_stdout(output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(0), "stderr: {stderr}");
    assert!(output.stderr.is_empty(), "stderr: {stderr}");
    String::from_utf8(output.stdout).expect("utf-8 stdout")
}

fn parse_document(text: &str) -> Value {
    serde_json::from_str(text).expect("exactly one JSON document")
}

fn tree_hash(root: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    hash_directory(root, root, &mut hasher);
    hasher.finish()
}

fn hash_directory(base: &Path, directory: &Path, hasher: &mut DefaultHasher) {
    let mut entries: Vec<PathBuf> = fs::read_dir(directory)
        .expect("read fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .collect();
    entries.sort();
    for path in entries {
        path.strip_prefix(base)
            .expect("path under base")
            .hash(hasher);
        if path.is_dir() {
            hash_directory(base, &path, hasher);
        } else {
            fs::read(&path).expect("read fixture file").hash(hasher);
        }
    }
}

#[test]
fn tasks_human_lists_every_entry_in_document_order_with_subtask_indentation() {
    let fixture = Fixture::new("tasks-human", Some(MIXED_TASKS));
    let stdout = success_stdout(fixture.run(&["tasks"]));
    assert_eq!(
        stdout,
        concat!(
            "1 Foundation [pending]\n",
            "  1.1 Pin inputs [completed]\n",
            "  1.2 Optional polish [pending] (optional)\n",
            "2 Blocked work [blocked] - blocked: waiting on credentials\n",
            "3 Last task [pending]\n",
        )
    );
}

#[test]
fn tasks_json_is_one_flat_document_with_schema_and_spec() {
    let fixture = Fixture::new("tasks-json", Some(MIXED_TASKS));
    let stdout = success_stdout(fixture.run(&["--json", "tasks"]));
    let document = parse_document(&stdout);
    assert_eq!(document["schema_version"].as_u64(), Some(1));
    assert_eq!(document["spec"].as_str(), Some("demo"));
    let tasks = document["tasks"].as_array().expect("flat task array");
    let ids: Vec<&str> = tasks
        .iter()
        .map(|task| task["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["1", "1.1", "1.2", "2", "3"]);
    assert_eq!(tasks[0]["state"].as_str(), Some("pending"));
    assert_eq!(tasks[1]["state"].as_str(), Some("completed"));
    assert_eq!(tasks[2]["optional"].as_bool(), Some(true));
    assert_eq!(tasks[2]["state"].as_str(), Some("pending"));
    assert_eq!(tasks[3]["state"].as_str(), Some("blocked"));
    assert_eq!(
        tasks[3]["blocked_reason"].as_str(),
        Some("waiting on credentials")
    );
    assert!(tasks[0]["blocked_reason"].is_null());
}

#[test]
fn next_human_selects_the_first_actionable_non_grouping_entry() {
    let fixture = Fixture::new(
        "next-human",
        Some("- [ ] 1. Group\n- [x] 1.1 Done child\n- [ ] 2. Next work\n"),
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "2 Next work [pending]\n"
    );
}

#[test]
fn next_selects_a_pending_subtask_in_document_order() {
    let fixture = Fixture::new(
        "next-subtask",
        Some("- [ ] 1. Group\n- [ ] 1.1 Child work\n- [ ] 2. Later\n"),
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "  1.1 Child work [pending]\n"
    );
}

#[test]
fn next_reports_a_blocked_entry_with_its_state_and_reason() {
    let fixture = Fixture::new(
        "next-blocked",
        Some("- [x] 1. Done\n- [!] 2. Waiting on review\n  - _Blocked: waiting on review_\n"),
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "2 Waiting on review [blocked] - blocked: waiting on review\n"
    );
    let document = parse_document(&success_stdout(fixture.run(&["--json", "next"])));
    assert_eq!(document["schema_version"].as_u64(), Some(1));
    assert_eq!(document["spec"].as_str(), Some("demo"));
    assert_eq!(document["task"]["id"].as_str(), Some("2"));
    assert_eq!(document["task"]["state"].as_str(), Some("blocked"));
    assert_eq!(
        document["task"]["blocked_reason"].as_str(),
        Some("waiting on review")
    );
}

#[test]
fn next_reports_no_incomplete_task_and_leaves_unchecked_groupings_unselected() {
    let fixture = Fixture::new(
        "next-none",
        Some("- [x] 1. Done\n- [ ] 2. Group\n- [x] 2.1 Complete child\n"),
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "No incomplete task.\n"
    );
    let document = parse_document(&success_stdout(fixture.run(&["--json", "next"])));
    assert!(document["task"].is_null());
}

#[test]
fn empty_tasks_md_reports_an_empty_list_and_no_incomplete_task() {
    let fixture = Fixture::new("empty", Some(""));
    assert_eq!(success_stdout(fixture.run(&["tasks"])), "No tasks.\n");
    let document = parse_document(&success_stdout(fixture.run(&["--json", "tasks"])));
    assert_eq!(
        document["tasks"].as_array().map(|tasks| tasks.len()),
        Some(0)
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "No incomplete task.\n"
    );
}

#[test]
fn tasks_and_next_do_not_require_spec_json() {
    let fixture = Fixture::new("no-spec-json", Some("- [ ] 1. Only entry\n"));
    assert!(!fixture.spec.join("spec.json").exists());
    assert_eq!(
        success_stdout(fixture.run(&["tasks"])),
        "1 Only entry [pending]\n"
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "1 Only entry [pending]\n"
    );
}

#[test]
fn missing_tasks_md_fails_without_stdout_and_names_the_path() {
    let fixture = Fixture::new("missing", None);
    let path = fixture.spec.join("tasks.md").display().to_string();
    for command in ["tasks", "next"] {
        let output = fixture.run(&[command]);
        assert_eq!(output.status.code(), Some(1), "{command}");
        assert!(output.stdout.is_empty(), "{command}");
        let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
        assert!(stderr.starts_with("kiro-spec: "), "{command}: {stderr}");
        assert!(stderr.contains(&path), "{command}: {stderr}");
    }
}

#[test]
fn non_utf8_tasks_md_fails_without_stdout_and_names_the_path() {
    let fixture = Fixture::new("non-utf8", None);
    let path = fixture.spec.join("tasks.md");
    fs::write(&path, [0xff, 0xfe]).expect("write invalid utf-8");
    let output = fixture.run(&["tasks"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
    assert!(stderr.starts_with("kiro-spec: "), "{stderr}");
    assert!(stderr.contains(&path.display().to_string()), "{stderr}");
}

#[test]
fn repeated_runs_produce_byte_identical_output_in_both_formats() {
    let fixture = Fixture::new("repeated", Some(MIXED_TASKS));
    let cases: &[&[&str]] = &[
        &["tasks"],
        &["--json", "tasks"],
        &["next"],
        &["--json", "next"],
    ];
    for args in cases {
        let first = fixture.run(args);
        let second = fixture.run(args);
        let label = args.join(" ");
        let stderr = String::from_utf8_lossy(&first.stderr);
        assert_eq!(first.status.code(), Some(0), "{label}: {stderr}");
        assert_eq!(second.status.code(), Some(0), "{label}");
        assert_eq!(first.stdout, second.stdout, "{label}");
        assert!(!first.stdout.is_empty(), "{label}");
        assert!(first.stderr.is_empty(), "{label}");
    }
}

#[test]
fn tasks_and_next_leave_the_fixture_tree_unchanged() {
    let fixture = Fixture::new("read-only", Some(MIXED_TASKS));
    let before = tree_hash(&fixture.root);
    for args in &[
        &["tasks"][..],
        &["--json", "tasks"][..],
        &["next"][..],
        &["--json", "next"][..],
    ] {
        let output = fixture.run(args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
    }
    assert_eq!(tree_hash(&fixture.root), before);
}
