use std::path::Path;

use crate::error::SpecError;

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
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "initialized" => Some(Self::Initialized),
            "requirements-generated" => Some(Self::RequirementsGenerated),
            "design-generated" => Some(Self::DesignGenerated),
            "tasks-generated" => Some(Self::TasksGenerated),
            "tasks-approved" => Some(Self::TasksApproved),
            "implemented" => Some(Self::Implemented),
            _ => None,
        }
    }

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
}

pub fn read_value(path: &Path) -> Result<serde_json::Value, SpecError> {
    let context = path.display().to_string();
    let bytes = std::fs::read(path)
        .map_err(|error| SpecError::read(&context, format!("cannot read file: {error}")))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| SpecError::read(&context, "file is not valid UTF-8"))?;
    serde_json::from_str(&text)
        .map_err(|error| SpecError::read(&context, format!("invalid JSON: {error}")))
}

pub fn phase_of(value: &serde_json::Value) -> Result<String, SpecError> {
    let object = value.as_object().ok_or_else(|| {
        SpecError::read(
            "spec.json",
            format!("value is not an object (found {})", json_kind(value)),
        )
    })?;
    match object.get("phase") {
        Some(serde_json::Value::String(phase)) => Ok(phase.clone()),
        Some(other) => Err(SpecError::read(
            "spec.json",
            format!("`phase` is not a string (found {})", json_kind(other)),
        )),
        None => Err(SpecError::read(
            "spec.json",
            "missing required `phase` string",
        )),
    }
}

fn json_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const LADDER: [(&str, Phase); 6] = [
        ("initialized", Phase::Initialized),
        ("requirements-generated", Phase::RequirementsGenerated),
        ("design-generated", Phase::DesignGenerated),
        ("tasks-generated", Phase::TasksGenerated),
        ("tasks-approved", Phase::TasksApproved),
        ("implemented", Phase::Implemented),
    ];

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let unique = format!(
                "kiro-spec-spec-json-{tag}-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parse_accepts_exactly_the_six_phase_strings() {
        for (text, phase) in LADDER {
            assert_eq!(Phase::parse(text), Some(phase), "{text}");
        }
    }

    #[test]
    fn parse_rejects_unknown_empty_and_wrong_case_values() {
        for text in [
            "",
            " ",
            "unknown",
            "Initialized",
            "REQUIREMENTS-GENERATED",
            "requirements_generated",
            "requirements-generated ",
            " tasks-generated",
            "tasks-approved-extra",
            "implemented!",
        ] {
            assert_eq!(Phase::parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn rank_is_strictly_increasing_across_the_ladder() {
        let ranks: Vec<u8> = LADDER.iter().map(|(_, phase)| phase.rank()).collect();

        assert_eq!(ranks, vec![0, 1, 2, 3, 4, 5]);
        assert!(ranks.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn phase_of_returns_the_raw_phase_string() {
        let value = json!({ "phase": "tasks-approved" });

        assert_eq!(phase_of(&value).expect("phase"), "tasks-approved");
    }

    #[test]
    fn phase_of_accepts_unknown_phase_strings_verbatim() {
        let value = json!({ "phase": "future-phase" });

        assert_eq!(phase_of(&value).expect("phase"), "future-phase");
    }

    #[test]
    fn phase_of_rejects_non_object_values() {
        for value in [
            json!([]),
            json!("initialized"),
            json!(3),
            json!(true),
            json!(null),
        ] {
            let error = phase_of(&value).expect_err("non-object must fail");

            assert_eq!(error.category(), ErrorCategory::ArtifactRead, "{value}");
            assert_eq!(error.context(), "spec.json");
            assert!(error.detail().contains("not an object"), "{value}: {error}");
            assert!(error.to_string().contains("spec.json"), "{value}: {error}");
        }
    }

    #[test]
    fn phase_of_rejects_missing_and_non_string_phases() {
        for (value, needle) in [
            (json!({}), "missing"),
            (json!({ "phase": null }), "not a string"),
            (json!({ "phase": 1 }), "not a string"),
            (json!({ "phase": ["initialized"] }), "not a string"),
            (
                json!({ "phase": { "name": "initialized" } }),
                "not a string",
            ),
        ] {
            let error = phase_of(&value).expect_err("invalid phase must fail");

            assert_eq!(error.category(), ErrorCategory::ArtifactRead, "{value}");
            assert_eq!(error.context(), "spec.json");
            assert!(error.detail().contains(needle), "{value}: {error}");
            assert!(error.detail().contains("phase"), "{value}: {error}");
        }
    }

    #[test]
    fn read_value_parses_valid_json_including_non_objects() {
        let temp = TempDir::new("valid");
        let object = temp.path().join("spec.json");
        fs::write(&object, r#"{"phase":"design-generated","count":2}"#).expect("write");
        let array = temp.path().join("array.json");
        fs::write(&array, "[1, 2, 3]").expect("write");

        let value = read_value(&object).expect("valid object");
        assert_eq!(value["phase"], "design-generated");
        assert_eq!(value["count"], 2);

        let value = read_value(&array).expect("valid array");
        assert_eq!(value, json!([1, 2, 3]));
    }

    #[test]
    fn read_value_reports_a_missing_file_with_its_path() {
        let temp = TempDir::new("missing");
        let path = temp.path().join("spec.json");

        let error = read_value(&path).expect_err("missing file must fail");

        assert_eq!(error.category(), ErrorCategory::ArtifactRead);
        assert_eq!(error.context(), path.display().to_string());
        assert!(error.to_string().contains(&path.display().to_string()));
    }

    #[test]
    fn read_value_reports_invalid_json_with_the_path() {
        let temp = TempDir::new("invalid");
        let path = temp.path().join("spec.json");
        fs::write(&path, "{ not json").expect("write");

        let error = read_value(&path).expect_err("invalid JSON must fail");

        assert_eq!(error.category(), ErrorCategory::ArtifactRead);
        assert_eq!(error.context(), path.display().to_string());
        assert!(error.detail().contains("JSON"), "{error}");
        assert!(error.to_string().contains(&path.display().to_string()));
    }

    #[test]
    fn read_value_reports_non_utf8_with_the_path() {
        let temp = TempDir::new("non-utf8");
        let path = temp.path().join("spec.json");
        fs::write(&path, [0xff, 0xfe, 0x00]).expect("write");

        let error = read_value(&path).expect_err("non-UTF-8 must fail");

        assert_eq!(error.category(), ErrorCategory::ArtifactRead);
        assert_eq!(error.context(), path.display().to_string());
        assert!(error.detail().contains("UTF-8"), "{error}");
        assert!(error.to_string().contains(&path.display().to_string()));
    }
}
