//! Raw `spec.json` access and the phase ladder.

use std::path::Path;

use serde_json::Value;

use crate::error::SpecError;

/// The spec-relative name of the file this module reads.
const SPEC_JSON: &str = "spec.json";

/// The six documented phases, in ladder order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Initialized,
    RequirementsGenerated,
    DesignGenerated,
    TasksGenerated,
    TasksApproved,
    Implemented,
}

impl Phase {
    /// Every rung of the ladder in ascending order.
    pub const ALL: [Self; 6] = [
        Self::Initialized,
        Self::RequirementsGenerated,
        Self::DesignGenerated,
        Self::TasksGenerated,
        Self::TasksApproved,
        Self::Implemented,
    ];

    /// Parse one of the six documented phase strings.
    ///
    /// Unknown strings return `None`, not an error: `status` reports the raw
    /// value and `validate` turns an unknown value into a finding.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|phase| phase.as_str() == value)
    }

    /// Position on the phase ladder; strictly increasing from `initialized`.
    pub fn rank(self) -> u8 {
        match self {
            Self::Initialized => 0,
            Self::RequirementsGenerated => 1,
            Self::DesignGenerated => 2,
            Self::TasksGenerated => 3,
            Self::TasksApproved => 4,
            Self::Implemented => 5,
        }
    }

    /// The published phase string for this rung.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initialized => "initialized",
            Self::RequirementsGenerated => "requirements-generated",
            Self::DesignGenerated => "design-generated",
            Self::TasksGenerated => "tasks-generated",
            Self::TasksApproved => "tasks-approved",
            Self::Implemented => "implemented",
        }
    }
}

/// Read and parse one `spec.json` document without interpreting its fields.
///
/// The value stays raw so `validate` can report each missing or wrongly typed
/// field as its own finding. Every failure names the file path that was read.
pub fn read_value(path: &Path) -> Result<Value, SpecError> {
    let context = path.display().to_string();
    let parsed = std::fs::read(path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "file not found".to_string(),
            _ => format!("file could not be read: {error}"),
        })
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
        })
        .and_then(|text| {
            serde_json::from_str(&text).map_err(|error| format!("invalid JSON: {error}"))
        });
    parsed.map_err(|detail| SpecError::read(context, detail))
}

/// The raw `phase` string of a parsed `spec.json` document.
///
/// `status` needs a string stage and nothing else, so a document that is not an
/// object or a `phase` that is absent or not a string is a read failure naming
/// the file. The string itself is not validated against the ladder here.
pub fn phase_of(value: &Value) -> Result<String, SpecError> {
    let object = value.as_object().ok_or_else(|| {
        SpecError::read(
            SPEC_JSON,
            "expected a JSON object with a string `phase` field",
        )
    })?;
    match object.get("phase") {
        None => Err(SpecError::read(
            SPEC_JSON,
            "required field `phase` is missing",
        )),
        Some(Value::String(phase)) => Ok(phase.clone()),
        Some(_) => Err(SpecError::read(SPEC_JSON, "field `phase` must be a string")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    /// A disposable directory holding the files a test needs.
    struct Fixture {
        directory: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir()
                .join(format!("kiro-spec-spec-json-{}-{id}", std::process::id()));
            fs::create_dir_all(&directory).expect("temporary directory is created");
            Self { directory }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.directory.join(name)
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.path(name);
            fs::write(&path, bytes).expect("fixture file is written");
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn parse_accepts_each_documented_phase_string() {
        let cases = [
            ("initialized", Phase::Initialized),
            ("requirements-generated", Phase::RequirementsGenerated),
            ("design-generated", Phase::DesignGenerated),
            ("tasks-generated", Phase::TasksGenerated),
            ("tasks-approved", Phase::TasksApproved),
            ("implemented", Phase::Implemented),
        ];
        for (text, expected) in cases {
            assert_eq!(
                Phase::parse(text),
                Some(expected),
                "{text:?} is a documented phase"
            );
        }
    }

    #[test]
    fn parse_rejects_unknown_and_near_miss_strings() {
        for text in [
            "",
            " ",
            "Initialized",
            "INITIALIZED",
            "requirements_generated",
            "tasks approved",
            "requirements",
            "tasks-generated\n",
            " tasks-generated",
            "tasks-generated.",
            "generated",
            "implemented ",
        ] {
            assert_eq!(
                Phase::parse(text),
                None,
                "{text:?} is not one of the six documented phases"
            );
        }
    }

    #[test]
    fn rank_orders_the_six_phases_along_the_ladder() {
        assert_eq!(Phase::Initialized.rank(), 0);
        assert_eq!(Phase::RequirementsGenerated.rank(), 1);
        assert_eq!(Phase::DesignGenerated.rank(), 2);
        assert_eq!(Phase::TasksGenerated.rank(), 3);
        assert_eq!(Phase::TasksApproved.rank(), 4);
        assert_eq!(Phase::Implemented.rank(), 5);

        for pair in Phase::ALL.windows(2) {
            assert!(
                pair[0].rank() < pair[1].rank(),
                "{:?} must rank below {:?}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn as_str_and_parse_round_trip_every_rung() {
        for phase in Phase::ALL {
            let text = phase.as_str();
            assert_eq!(
                Phase::parse(text),
                Some(phase),
                "{text:?} must parse back to {phase:?}"
            );
        }
        assert_eq!(Phase::Implemented.as_str(), "implemented");
    }

    #[test]
    fn phase_of_returns_the_raw_string_without_validating_it() {
        let known = serde_json::json!({ "phase": "tasks-generated" });
        assert_eq!(
            phase_of(&known).expect("a string phase is accepted"),
            "tasks-generated"
        );

        let unknown = serde_json::json!({ "phase": "future-phase" });
        assert_eq!(
            phase_of(&unknown).expect("unknown phases are reported by validation"),
            "future-phase"
        );
    }

    #[test]
    fn phase_of_rejects_a_non_object_document() {
        for value in [
            serde_json::json!(["phase"]),
            serde_json::json!("tasks-generated"),
            serde_json::json!(7),
            serde_json::json!(null),
        ] {
            let error =
                phase_of(&value).expect_err(&format!("{value} is not an object with a phase"));
            assert_eq!(error.category(), ErrorCategory::Read);
            assert_eq!(error.category().exit_code(), 1);
            assert_eq!(error.context(), "spec.json");
            assert!(
                error.detail().contains("object"),
                "the diagnostic must state the expected shape, got {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn phase_of_rejects_a_missing_or_wrongly_typed_phase() {
        let missing = serde_json::json!({ "feature_name": "demo" });
        let error = phase_of(&missing).expect_err("a missing phase is an error");
        assert_eq!(error.category(), ErrorCategory::Read);
        assert_eq!(error.context(), "spec.json");
        assert!(
            error.detail().contains("phase") && error.detail().contains("missing"),
            "the diagnostic must name the missing field, got {:?}",
            error.detail()
        );

        for value in [
            serde_json::json!({ "phase": 3 }),
            serde_json::json!({ "phase": null }),
            serde_json::json!({ "phase": true }),
            serde_json::json!({ "phase": ["tasks-generated"] }),
            serde_json::json!({ "phase": { "stage": "implemented" } }),
        ] {
            let error =
                phase_of(&value).expect_err(&format!("{value} does not carry a string phase"));
            assert_eq!(error.category(), ErrorCategory::Read);
            assert_eq!(error.category().exit_code(), 1);
            assert_eq!(error.context(), "spec.json");
            assert!(
                error.detail().contains("phase") && error.detail().contains("string"),
                "the diagnostic must name the wrongly typed field, got {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn read_value_returns_the_raw_document() {
        let fixture = Fixture::new();
        let path = fixture.write(
            "spec.json",
            br#"{
  "feature_name": "demo",
  "phase": "tasks-generated",
  "ready_for_implementation": true
}"#,
        );

        let value = read_value(&path).expect("a valid document is read");
        assert_eq!(
            value.get("feature_name").and_then(Value::as_str),
            Some("demo")
        );
        assert_eq!(
            value.get("phase").and_then(Value::as_str),
            Some("tasks-generated")
        );
        assert_eq!(
            value
                .get("ready_for_implementation")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn read_value_keeps_missing_and_wrongly_typed_fields_raw() {
        let fixture = Fixture::new();
        let path = fixture.write(
            "spec.json",
            br#"{
  "feature_name": "demo",
  "language": 7,
  "approvals": "none"
}"#,
        );

        let value = read_value(&path).expect("a parseable document is read");
        assert!(
            value.get("created_at").is_none(),
            "a missing field must stay absent instead of gaining a default"
        );
        assert_eq!(
            value.get("language").and_then(Value::as_str),
            None,
            "a wrongly typed field must not be coerced"
        );
        assert!(
            value.get("language").is_some(),
            "raw access still exposes the wrongly typed value"
        );
        assert_eq!(value.get("approvals").and_then(Value::as_object), None);
        assert_eq!(
            value.get("approvals").and_then(Value::as_str),
            Some("none"),
            "raw access exposes the document exactly as written"
        );
    }

    #[test]
    fn read_value_reports_a_missing_file_naming_the_path() {
        let fixture = Fixture::new();
        let path = fixture.path("absent/spec.json");

        let error = read_value(&path).expect_err("a missing file is a read failure");

        assert_eq!(error.category(), ErrorCategory::Read);
        assert_eq!(error.category().exit_code(), 1);
        assert_eq!(error.context(), path.display().to_string());
        assert_eq!(error.detail(), "file not found");
    }

    #[test]
    fn read_value_reports_invalid_json_naming_the_path() {
        let fixture = Fixture::new();
        let path = fixture.write("broken.json", b"{ \"phase\": }");

        let error = read_value(&path).expect_err("invalid JSON is a read failure");

        assert_eq!(error.category(), ErrorCategory::Read);
        assert_eq!(error.context(), path.display().to_string());
        assert!(
            error.detail().starts_with("invalid JSON"),
            "the diagnostic must name the JSON problem, got {:?}",
            error.detail()
        );
    }

    #[test]
    fn read_value_reports_non_utf8_naming_the_path() {
        let fixture = Fixture::new();
        let path = fixture.write("latin1.json", b"{\"\xff\": 1}");

        let error = read_value(&path).expect_err("non-UTF-8 bytes are a read failure");

        assert_eq!(error.category(), ErrorCategory::Read);
        assert_eq!(error.context(), path.display().to_string());
        assert_eq!(error.detail(), "file is not valid UTF-8");
    }

    #[test]
    fn read_value_and_phase_of_compose_for_the_status_command() {
        let fixture = Fixture::new();
        let path = fixture.write("spec.json", br#"{"phase": "design-generated"}"#);

        let value = read_value(&path).expect("a valid document is read");
        assert_eq!(
            phase_of(&value).expect("the phase is present"),
            "design-generated"
        );

        let array = fixture.write("array.json", b"[]");
        let value = read_value(&array).expect("an array is still valid JSON");
        let error = phase_of(&value).expect_err("an array is not a spec object");
        assert_eq!(error.context(), "spec.json");
    }
}
