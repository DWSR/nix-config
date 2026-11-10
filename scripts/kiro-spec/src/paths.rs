use std::path::{Path, PathBuf};

use crate::error::SpecError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpecPaths {
    root: PathBuf,
    name: String,
    directory: PathBuf,
}

impl SpecPaths {
    pub fn resolve(root: &Path, name: &str) -> Result<Self, SpecError> {
        validate_name(name)?;
        let directory = root.join(".kiro").join("specs").join(name);
        if !directory.is_dir() {
            return Err(SpecError::resolution(
                directory.display().to_string(),
                "spec directory does not exist or is not a directory",
            ));
        }
        Ok(Self {
            root: root.to_path_buf(),
            name: name.to_owned(),
            directory,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn spec_json(&self) -> PathBuf {
        self.directory.join("spec.json")
    }

    pub fn tasks_md(&self) -> PathBuf {
        self.directory.join("tasks.md")
    }

    pub fn requirements_md(&self) -> PathBuf {
        self.directory.join("requirements.md")
    }
}

fn validate_name(name: &str) -> Result<(), SpecError> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('\0')
        || name.contains('/')
        || name.contains(std::path::MAIN_SEPARATOR)
        || Path::new(name).is_absolute();
    if invalid {
        Err(SpecError::resolution(
            format!("--spec {name:?}"),
            "requires a relative single path component (`--spec <name>`)",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let unique = format!(
                "kiro-spec-paths-{tag}-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("create temp root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn create_spec(&self, name: &str) -> PathBuf {
            let directory = self.0.join(".kiro").join("specs").join(name);
            fs::create_dir_all(&directory).expect("create spec directory");
            directory
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn explicit_root_resolves_an_existing_spec_directory() {
        let temp = TempRoot::new("explicit");
        let expected = temp.create_spec("demo");

        let paths = SpecPaths::resolve(temp.path(), "demo").expect("resolve");

        assert_eq!(paths.root(), temp.path());
        assert_eq!(paths.name(), "demo");
        assert_eq!(paths.directory(), expected.as_path());
        assert!(paths.directory().is_dir());
    }

    #[test]
    fn default_root_joins_beneath_the_current_directory() {
        let name = "kiro-spec-absent-default-root-spec";
        let error = SpecPaths::resolve(Path::new("."), name).expect_err("must not exist");

        assert_eq!(error.category(), ErrorCategory::Resolution);
        assert_eq!(error.context(), format!("./.kiro/specs/{name}"));
    }

    #[test]
    fn rejected_names_are_resolution_errors_naming_the_value_and_form() {
        for name in [
            "",
            ".",
            "..",
            "/absolute",
            "nested/demo",
            "trailing/",
            "de\0mo",
        ] {
            let error = SpecPaths::resolve(Path::new("/nonexistent-root"), name)
                .expect_err("invalid name must be rejected");

            assert_eq!(error.category(), ErrorCategory::Resolution, "{name:?}");
            assert!(
                error.context().starts_with("--spec"),
                "{name:?}: {error}"
            );
            assert!(
                error.context().contains(&format!("{name:?}")),
                "{name:?}: {error}"
            );
            assert!(
                error.detail().contains("requires a relative single path component"),
                "{name:?}: {error}"
            );
            assert!(error.detail().contains("--spec <name>"), "{name:?}: {error}");
        }
    }

    #[test]
    fn missing_directory_is_named_verbatim_without_canonicalisation() {
        let temp = TempRoot::new("missing");

        let error = SpecPaths::resolve(temp.path(), "absent").expect_err("missing spec");

        let expected = temp
            .path()
            .join(".kiro")
            .join("specs")
            .join("absent");
        assert_eq!(error.category(), ErrorCategory::Resolution);
        assert_eq!(error.context(), expected.display().to_string());
        assert!(error.detail().contains("does not exist"), "{error}");
        assert!(error.to_string().contains(&expected.display().to_string()));
    }

    #[test]
    fn relative_missing_directory_keeps_the_joined_text() {
        let error =
            SpecPaths::resolve(Path::new("relative-root"), "absent").expect_err("missing spec");

        assert_eq!(error.context(), "relative-root/.kiro/specs/absent");
    }

    #[test]
    fn resolution_does_not_search_parent_directories() {
        let temp = TempRoot::new("noparent");
        temp.create_spec("demo");
        let nested = temp.path().join("nested");
        fs::create_dir_all(&nested).expect("create nested root");

        let error = SpecPaths::resolve(&nested, "demo").expect_err("must not search parents");

        assert_eq!(error.category(), ErrorCategory::Resolution);
        assert_eq!(
            error.context(),
            nested
                .join(".kiro")
                .join("specs")
                .join("demo")
                .display()
                .to_string()
        );
    }

    #[test]
    fn a_non_directory_at_the_joined_path_is_rejected() {
        let temp = TempRoot::new("file");
        let specs = temp.path().join(".kiro").join("specs");
        fs::create_dir_all(&specs).expect("create specs");
        fs::write(specs.join("demo"), "not a directory").expect("write file");

        let error = SpecPaths::resolve(temp.path(), "demo").expect_err("must be a directory");

        assert_eq!(error.category(), ErrorCategory::Resolution);
        assert_eq!(
            error.context(),
            specs.join("demo").display().to_string()
        );
    }

    #[test]
    fn artifact_paths_are_built_under_the_spec_directory() {
        let temp = TempRoot::new("artifacts");
        let directory = temp.create_spec("demo");
        let paths = SpecPaths::resolve(temp.path(), "demo").expect("resolve");

        assert_eq!(paths.spec_json(), directory.join("spec.json"));
        assert_eq!(paths.tasks_md(), directory.join("tasks.md"));
        assert_eq!(paths.requirements_md(), directory.join("requirements.md"));
    }

    #[test]
    fn directory_text_is_preserved_verbatim() {
        let temp = TempRoot::new("verbatim");
        temp.create_spec("demo");
        let sub = temp.path().join("sub");
        fs::create_dir_all(&sub).expect("create sub");
        let root = sub.join("..");

        let paths = SpecPaths::resolve(&root, "demo").expect("resolve");

        let expected = root.join(".kiro").join("specs").join("demo");
        assert_eq!(paths.directory(), expected.as_path());
        assert!(paths
            .directory()
            .display()
            .to_string()
            .contains("sub/../.kiro/specs/demo"));
    }
}
