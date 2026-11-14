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

    fn write_spec_json(&self, contents: &[u8]) {
        fs::write(self.spec.join("spec.json"), contents).expect("write fixture spec.json");
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

const STATUS_SPEC_JSON: &[u8] =
    br#"{"phase":"tasks-generated","feature_name":"other","generated":{"requirements":false}}"#;

#[test]
fn status_human_reports_counts_and_stage_in_exactly_six_lines() {
    let fixture = Fixture::new("status-human", Some(MIXED_TASKS));
    fixture.write_spec_json(STATUS_SPEC_JSON);

    assert_eq!(
        success_stdout(fixture.run(&["status"])),
        concat!(
            "spec: demo\n",
            "stage: tasks-generated\n",
            "total: 5\n",
            "completed: 1\n",
            "pending: 3 (optional: 1)\n",
            "blocked: 1\n",
        )
    );
}

#[test]
fn status_json_reports_schema_counts_and_raw_stage() {
    let fixture = Fixture::new("status-json", Some(MIXED_TASKS));
    fixture.write_spec_json(STATUS_SPEC_JSON);

    let stdout = success_stdout(fixture.run(&["--json", "status"]));
    let document = parse_document(&stdout);
    let keys: Vec<&str> = document
        .as_object()
        .expect("status object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "counts",
            "optional_pending",
            "schema_version",
            "spec",
            "stage",
            "total"
        ]
    );
    for pair in [
        ("\"schema_version\"", "\"spec\""),
        ("\"spec\"", "\"stage\""),
        ("\"stage\"", "\"total\""),
        ("\"total\"", "\"counts\""),
        ("\"counts\"", "\"optional_pending\""),
    ] {
        assert!(
            stdout.find(pair.0) < stdout.find(pair.1),
            "{} must precede {}:\n{stdout}",
            pair.0,
            pair.1
        );
    }
    assert_eq!(document["schema_version"].as_u64(), Some(1));
    assert_eq!(document["spec"].as_str(), Some("demo"));
    assert_eq!(document["stage"].as_str(), Some("tasks-generated"));
    assert_eq!(document["total"].as_u64(), Some(5));
    let count_keys: Vec<&str> = document["counts"]
        .as_object()
        .expect("counts object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(count_keys, ["blocked", "completed", "pending"]);
    for pair in [
        ("\"completed\"", "\"pending\""),
        ("\"pending\"", "\"blocked\""),
    ] {
        assert!(
            stdout.find(pair.0) < stdout.find(pair.1),
            "{} must precede {}:\n{stdout}",
            pair.0,
            pair.1
        );
    }
    assert_eq!(document["counts"]["completed"].as_u64(), Some(1));
    assert_eq!(document["counts"]["pending"].as_u64(), Some(3));
    assert_eq!(document["counts"]["blocked"].as_u64(), Some(1));
    assert_eq!(document["optional_pending"].as_u64(), Some(1));
}

#[test]
fn status_reports_an_unknown_phase_string_verbatim_without_inferring_from_tasks() {
    let fixture = Fixture::new(
        "status-unknown-phase",
        Some("- [x] 1. Done\n- [x] 2. Also done\n"),
    );
    fixture.write_spec_json(br#"{"phase":"future-phase"}"#);

    assert_eq!(
        success_stdout(fixture.run(&["status"])),
        concat!(
            "spec: demo\n",
            "stage: future-phase\n",
            "total: 2\n",
            "completed: 2\n",
            "pending: 0 (optional: 0)\n",
            "blocked: 0\n",
        )
    );
    let document = parse_document(&success_stdout(fixture.run(&["--json", "status"])));
    assert_eq!(document["stage"].as_str(), Some("future-phase"));
}

#[test]
fn status_without_spec_json_fails_without_stdout_and_names_the_path() {
    let fixture = Fixture::new("status-missing-spec-json", Some(MIXED_TASKS));
    let path = fixture.spec.join("spec.json").display().to_string();

    for args in [&["status"][..], &["--json", "status"][..]] {
        let output = fixture.run(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
        assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
        assert!(stderr.contains(&path), "{args:?}: {stderr}");
    }
}

#[test]
fn status_rejects_unparseable_or_invalid_spec_json_naming_the_path() {
    let cases: &[(&str, &[u8])] = &[
        ("invalid-json", &b"{ not json"[..]),
        ("non-object", &b"[]"[..]),
        ("non-object-string", &b"\"initialized\""[..]),
        ("missing-phase", &b"{\"feature_name\":\"demo\"}"[..]),
        ("null-phase", &b"{\"phase\":null}"[..]),
        ("non-string-phase", &b"{\"phase\":1}"[..]),
        ("non-utf8", &[0xff, 0xfe, 0x00][..]),
    ];
    for (tag, contents) in cases {
        let fixture = Fixture::new(tag, Some(MIXED_TASKS));
        fixture.write_spec_json(contents);
        let path = fixture.spec.join("spec.json").display().to_string();
        for args in [&["status"][..], &["--json", "status"][..]] {
            let output = fixture.run(args);
            assert_eq!(output.status.code(), Some(1), "{tag} {args:?}");
            assert!(output.stdout.is_empty(), "{tag} {args:?}");
            let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
            assert!(
                stderr.starts_with("kiro-spec: "),
                "{tag} {args:?}: {stderr}"
            );
            assert!(stderr.contains(&path), "{tag} {args:?}: {stderr}");
        }
    }
}

#[test]
fn status_without_tasks_md_fails_without_stdout_and_names_the_path() {
    let fixture = Fixture::new("status-missing-tasks", None);
    fixture.write_spec_json(STATUS_SPEC_JSON);
    let path = fixture.spec.join("tasks.md").display().to_string();

    let output = fixture.run(&["status"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
    assert!(stderr.starts_with("kiro-spec: "), "{stderr}");
    assert!(stderr.contains(&path), "{stderr}");
}

#[test]
fn status_rejects_non_utf8_tasks_md_naming_the_path() {
    let fixture = Fixture::new("status-non-utf8-tasks", None);
    fixture.write_spec_json(STATUS_SPEC_JSON);
    let path = fixture.spec.join("tasks.md");
    fs::write(&path, [0xff, 0xfe]).expect("write invalid utf-8");

    let output = fixture.run(&["status"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
    assert!(stderr.contains(&path.display().to_string()), "{stderr}");
}

#[test]
fn status_is_deterministic_and_leaves_the_fixture_tree_byte_identical() {
    let fixture = Fixture::new("status-read-only", Some(MIXED_TASKS));
    fixture.write_spec_json(STATUS_SPEC_JSON);
    let before = tree_hash(&fixture.root);

    for args in [&["status"][..], &["--json", "status"][..]] {
        let first = fixture.run(args);
        let second = fixture.run(args);
        let label = args.join(" ");
        let stderr = String::from_utf8_lossy(&first.stderr);
        assert_eq!(first.status.code(), Some(0), "{label}: {stderr}");
        assert_eq!(second.status.code(), Some(0), "{label}");
        assert_eq!(first.stdout, second.stdout, "{label}");
        assert!(!first.stdout.is_empty(), "{label}");
        assert!(first.stderr.is_empty(), "{label}");
        assert!(second.stderr.is_empty(), "{label}");
    }
    assert_eq!(tree_hash(&fixture.root), before);
}

#[test]
fn status_does_not_disturb_tasks_or_next() {
    let fixture = Fixture::new("status-coexist", Some(MIXED_TASKS));
    fixture.write_spec_json(STATUS_SPEC_JSON);

    assert_eq!(
        success_stdout(fixture.run(&["tasks"])),
        concat!(
            "1 Foundation [pending]\n",
            "  1.1 Pin inputs [completed]\n",
            "  1.2 Optional polish [pending] (optional)\n",
            "2 Blocked work [blocked] - blocked: waiting on credentials\n",
            "3 Last task [pending]\n",
        )
    );
    assert_eq!(
        success_stdout(fixture.run(&["next"])),
        "  1.2 Optional polish [pending] (optional)\n"
    );
    assert_eq!(success_stdout(fixture.run(&["status"])).lines().count(), 6);
}

const VALID_SPEC_JSON: &[u8] = br#"{
  "feature_name": "demo",
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-02T00:00:00Z",
  "language": "en",
  "phase": "initialized",
  "approvals": {
    "requirements": {"generated": false, "approved": false},
    "design": {"generated": false, "approved": false},
    "tasks": {"generated": false, "approved": false}
  },
  "ready_for_implementation": false
}"#;

const VALID_TASKS: &str = "# Implementation Plan\n\n- [ ] 1. Foundation\n- [x] 1.1 Pin inputs\n";
const DUPLICATE_TASKS: &str = "- [ ] 1. Foundation\n- [ ] 1. Duplicate\n";
const WARNING_TASKS: &str = "- [ ] 1. Numbered\n- [ ] Has no identifier\n";

fn valid_fixture(tag: &str) -> Fixture {
    let fixture = Fixture::new(tag, Some(VALID_TASKS));
    fixture.write_spec_json(VALID_SPEC_JSON);
    fixture
}

fn assert_no_ansi_or_root(text: &str, root: &Path) {
    assert!(!text.contains('\u{1b}'), "ANSI escape in output: {text:?}");
    assert!(
        !text.contains(&root.display().to_string()),
        "root path in output: {text}"
    );
}

#[test]
fn validate_human_reports_a_clean_spec_as_zero_errors() {
    let fixture = valid_fixture("validate-human-clean");
    let output = fixture.run(&["validate"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(0), "stderr: {stderr}");
    assert!(output.stderr.is_empty(), "stderr: {stderr}");
    let stdout = String::from_utf8(output.stdout).expect("utf-8 stdout");
    assert_eq!(stdout, "0 errors, 0 warnings\n");
    assert_no_ansi_or_root(&stdout, &fixture.root);
}

#[test]
fn validate_json_emits_one_complete_valid_document() {
    let fixture = valid_fixture("validate-json-clean");
    let stdout = success_stdout(fixture.run(&["--json", "validate"]));
    let document = parse_document(&stdout);

    assert_eq!(document["schema_version"].as_u64(), Some(1));
    assert_eq!(document["spec"].as_str(), Some("demo"));
    assert_eq!(document["valid"].as_bool(), Some(true));
    assert_eq!(
        document["findings"].as_array().map(|findings| findings.len()),
        Some(0)
    );
    for pair in [
        ("\"schema_version\"", "\"spec\""),
        ("\"spec\"", "\"valid\""),
        ("\"valid\"", "\"findings\""),
    ] {
        assert!(
            stdout.find(pair.0) < stdout.find(pair.1),
            "{} must precede {}:\n{stdout}",
            pair.0,
            pair.1
        );
    }
    assert!(stdout.ends_with("}\n"), "{stdout}");
    assert!(!stdout.ends_with("}\n\n"), "{stdout}");
    assert_no_ansi_or_root(&stdout, &fixture.root);
}

#[test]
fn validate_reports_error_findings_on_stdout_and_exits_one() {
    let fixture = Fixture::new("validate-human-error", Some(DUPLICATE_TASKS));
    fixture.write_spec_json(VALID_SPEC_JSON);

    let output = fixture.run(&["validate"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(output.stderr.is_empty(), "stderr: {stderr}");
    let stdout = String::from_utf8(output.stdout).expect("utf-8 stdout");
    assert!(
        stdout.contains("tasks.md:2: error [tasks.id.duplicate]"),
        "{stdout}"
    );
    assert!(stdout.ends_with("1 error, 0 warnings\n"), "{stdout}");
    assert_no_ansi_or_root(&stdout, &fixture.root);
}

#[test]
fn validate_json_reports_invalid_findings_and_still_exits_one() {
    let fixture = Fixture::new("validate-json-error", Some(DUPLICATE_TASKS));
    fixture.write_spec_json(VALID_SPEC_JSON);

    let output = fixture.run(&["--json", "validate"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(output.stderr.is_empty(), "stderr: {stderr}");
    let stdout = String::from_utf8(output.stdout).expect("utf-8 stdout");
    let document = parse_document(&stdout);
    assert_eq!(document["schema_version"].as_u64(), Some(1));
    assert_eq!(document["spec"].as_str(), Some("demo"));
    assert_eq!(document["valid"].as_bool(), Some(false));
    let findings = document["findings"].as_array().expect("findings array");
    assert_eq!(findings.len(), 1, "{stdout}");
    assert_eq!(findings[0]["severity"].as_str(), Some("error"));
    assert_eq!(findings[0]["code"].as_str(), Some("tasks.id.duplicate"));
    assert_eq!(findings[0]["file"].as_str(), Some("tasks.md"));
    assert_eq!(findings[0]["line"].as_u64(), Some(2));
    assert_no_ansi_or_root(&stdout, &fixture.root);
}

#[test]
fn validate_warnings_only_exit_zero_and_keep_findings_as_result_data() {
    let fixture = Fixture::new("validate-warnings", Some(WARNING_TASKS));
    fixture.write_spec_json(VALID_SPEC_JSON);

    let human = fixture.run(&["validate"]);
    let stderr = String::from_utf8_lossy(&human.stderr);
    assert_eq!(human.status.code(), Some(0), "stderr: {stderr}");
    assert!(human.stderr.is_empty(), "stderr: {stderr}");
    assert_eq!(
        String::from_utf8(human.stdout).expect("utf-8 stdout"),
        "tasks.md:2: warning [tasks.line.unnumbered] checkbox line has no numeric task identifier\n0 errors, 1 warning\n"
    );

    let json = fixture.run(&["--json", "validate"]);
    let stderr = String::from_utf8_lossy(&json.stderr);
    assert_eq!(json.status.code(), Some(0), "stderr: {stderr}");
    assert!(json.stderr.is_empty(), "stderr: {stderr}");
    let document = parse_document(&String::from_utf8(json.stdout).expect("utf-8 stdout"));
    assert_eq!(document["valid"].as_bool(), Some(true));
    let findings = document["findings"].as_array().expect("findings array");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0]["severity"].as_str(), Some("warning"));
    assert_eq!(findings[0]["code"].as_str(), Some("tasks.line.unnumbered"));
    assert_eq!(findings[0]["line"].as_u64(), Some(2));
}

#[test]
fn validate_exit_status_matches_with_and_without_json() {
    let clean = valid_fixture("validate-status-clean");
    assert_eq!(clean.run(&["validate"]).status.code(), Some(0));
    assert_eq!(clean.run(&["--json", "validate"]).status.code(), Some(0));

    let broken = Fixture::new("validate-status-broken", Some(DUPLICATE_TASKS));
    broken.write_spec_json(VALID_SPEC_JSON);
    assert_eq!(broken.run(&["validate"]).status.code(), Some(1));
    assert_eq!(broken.run(&["--json", "validate"]).status.code(), Some(1));
}

#[test]
fn validate_without_a_spec_directory_uses_the_failure_path() {
    let fixture = valid_fixture("validate-missing-spec-dir");
    fs::remove_dir_all(&fixture.spec).expect("remove fixture spec directory");
    let path = fixture.spec.display().to_string();

    for args in [&["validate"][..], &["--json", "validate"][..]] {
        let output = fixture.run(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        let stderr = String::from_utf8(output.stderr).expect("utf-8 stderr");
        assert!(stderr.starts_with("kiro-spec: "), "{args:?}: {stderr}");
        assert!(stderr.contains(&path), "{args:?}: {stderr}");
    }
}

#[test]
fn validate_reports_missing_artifacts_as_findings_without_stderr() {
    let fixture = Fixture::new("validate-missing-artifacts", None);

    for args in [&["validate"][..], &["--json", "validate"][..]] {
        let output = fixture.run(args);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "{args:?}: {stderr}");
        assert!(output.stderr.is_empty(), "{args:?}: {stderr}");
        let stdout = String::from_utf8(output.stdout).expect("utf-8 stdout");
        assert!(
            stdout.contains("spec.json.missing"),
            "{args:?}: {stdout}"
        );
    }
}

#[test]
fn validate_reports_non_utf8_tasks_as_a_finding_not_a_diagnostic() {
    let fixture = valid_fixture("validate-non-utf8-tasks");
    fs::write(fixture.spec.join("tasks.md"), [0xff, 0xfe]).expect("write invalid utf-8");

    let output = fixture.run(&["validate"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(output.stderr.is_empty(), "stderr: {stderr}");
    let stdout = String::from_utf8(output.stdout).expect("utf-8 stdout");
    assert!(stdout.contains("error [tasks.unreadable]"), "{stdout}");
}

#[test]
fn validate_leaves_the_fixture_tree_unchanged_in_both_formats() {
    for (tag, tasks) in [
        ("validate-read-only-clean", VALID_TASKS),
        ("validate-read-only-broken", DUPLICATE_TASKS),
    ] {
        let fixture = Fixture::new(tag, Some(tasks));
        fixture.write_spec_json(VALID_SPEC_JSON);
        let before = tree_hash(&fixture.root);

        for args in [&["validate"][..], &["--json", "validate"][..]] {
            fixture.run(args);
        }

        assert_eq!(tree_hash(&fixture.root), before, "{tag}");
    }
}
