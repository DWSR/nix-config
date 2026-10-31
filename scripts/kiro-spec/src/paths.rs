//! Explicit spec resolution: `<root>/.kiro/specs/<name>/` and artifact paths.
//!
//! Resolution is deliberately literal: a spec exists only where the caller
//! says it does. Nothing searches parent directories, infers a name from the
//! working directory, or canonicalises the joined path, so a diagnostic names
//! exactly the location that was checked.

use std::path::{Path, PathBuf};

use crate::error::SpecError;

/// One resolved spec directory together with the artifact paths inside it.
///
/// Artifact paths are always `<directory>/<artifact>`; no path is ever derived
/// from a task identifier or any other user input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpecPaths {
    name: String,
    directory: PathBuf,
}

impl SpecPaths {
    /// Resolve `<root>/.kiro/specs/<name>` and require it to be a directory.
    ///
    /// `root` is used exactly as supplied; `--root` defaults to `.` in the CLI
    /// adapter, and a `root` of `.` yields a `.kiro/specs/...` path without a
    /// leading `./`. The name must be a single relative path component, so an
    /// empty name, `.`, `..`, an absolute path, an embedded separator, or an
    /// embedded NUL byte is rejected before anything is joined or read.
    pub fn resolve(root: &Path, name: &str) -> Result<Self, SpecError> {
        if !is_plain_component(name) {
            return Err(SpecError::resolution(
                "--spec",
                format!(
                    "invalid name {name:?}; `--spec <name>` requires a relative single path component"
                ),
            ));
        }
        let directory = joined_directory(root, name);
        match std::fs::metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => Ok(Self {
                name: name.to_string(),
                directory,
            }),
            Ok(_) => Err(SpecError::resolution(
                directory.display().to_string(),
                "spec path is not a directory",
            )),
            Err(_) => Err(SpecError::resolution(
                directory.display().to_string(),
                "spec directory not found",
            )),
        }
    }

    /// The resolved spec directory, reported verbatim as it was built.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// The spec name exactly as it was supplied.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// `<directory>/spec.json`.
    pub fn spec_json(&self) -> PathBuf {
        self.directory.join("spec.json")
    }

    /// `<directory>/tasks.md`.
    pub fn tasks_md(&self) -> PathBuf {
        self.directory.join("tasks.md")
    }

    /// `<directory>/requirements.md`.
    pub fn requirements_md(&self) -> PathBuf {
        self.directory.join("requirements.md")
    }
}

/// Whether `name` denotes exactly one relative path component.
fn is_plain_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('\0')
        && !name.contains(std::path::MAIN_SEPARATOR)
        && !Path::new(name).is_absolute()
}

/// Build `<root>/.kiro/specs/<name>` without a redundant `./` prefix.
///
/// Only the root `.` is folded away; the rest of the path is joined verbatim,
/// so the caller sees exactly the location that exists or is missing.
fn joined_directory(root: &Path, name: &str) -> PathBuf {
    let mut directory = if root.as_os_str().is_empty() || root == Path::new(".") {
        PathBuf::from(".kiro")
    } else {
        root.join(".kiro")
    };
    directory.push("specs");
    directory.push(name);
    directory
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    /// A disposable directory tree the tests may create spec directories in.
    struct Tree {
        root: PathBuf,
    }

    impl Tree {
        fn new() -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("kiro-spec-paths-{}-{id}", std::process::id()));
            fs::create_dir_all(&root).expect("temporary root is created");
            Self { root }
        }

        fn join(&self, parts: &[&str]) -> PathBuf {
            let mut path = self.root.clone();
            for part in parts {
                path.push(part);
            }
            path
        }

        fn create_spec(&self, name: &str) -> PathBuf {
            let directory = self.join(&[".kiro", "specs", name]);
            fs::create_dir_all(&directory).expect("spec directory is created");
            directory
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn the_default_root_places_the_spec_beneath_the_current_directory() {
        assert_eq!(
            joined_directory(Path::new("."), "demo"),
            PathBuf::from(".kiro/specs/demo"),
            "the default root must not be echoed as `./`"
        );
    }

    #[test]
    fn an_explicit_root_prefixes_the_documented_spec_path() {
        assert_eq!(
            joined_directory(Path::new("/checkout"), "demo"),
            PathBuf::from("/checkout/.kiro/specs/demo")
        );
        assert_eq!(
            joined_directory(Path::new("worktree"), "demo"),
            PathBuf::from("worktree/.kiro/specs/demo")
        );
    }

    #[test]
    fn resolve_joins_the_named_spec_directory_under_the_root() {
        let tree = Tree::new();
        let expected = tree.create_spec("demo");

        let paths = SpecPaths::resolve(&tree.root, "demo").expect("an existing spec resolves");

        assert_eq!(paths.directory(), expected.as_path());
        assert_eq!(paths.name(), "demo");
        assert_eq!(paths.spec_json(), expected.join("spec.json"));
        assert_eq!(paths.tasks_md(), expected.join("tasks.md"));
        assert_eq!(
            paths.requirements_md(),
            expected.join("requirements.md"),
            "artifact paths are always <directory>/<artifact>"
        );
    }

    #[test]
    fn dotted_and_hyphenated_names_are_accepted_verbatim() {
        let tree = Tree::new();
        let expected = tree.create_spec("spec.v2-beta");
        let paths = SpecPaths::resolve(&tree.root, "spec.v2-beta").expect("a plain component");
        assert_eq!(paths.directory(), expected.as_path());
        assert_eq!(paths.name(), "spec.v2-beta");
    }

    #[test]
    fn every_rejected_name_is_refused_before_joining() {
        let tree = Tree::new();
        for name in [
            "",
            ".",
            "..",
            "/",
            "/absolute",
            "nested/name",
            "trailing/",
            "nul\0byte",
        ] {
            let error = SpecPaths::resolve(&tree.root, name)
                .expect_err(&format!("{name:?} must be rejected"));
            assert_eq!(
                error.category(),
                ErrorCategory::Resolution,
                "{name:?} must be a resolution failure"
            );
            assert_eq!(error.category().exit_code(), 1, "{name:?}");
            assert!(
                error.detail().contains("relative single path component"),
                "{name:?}: diagnostic must state the correct form, got {:?}",
                error.detail()
            );
            assert!(
                !error.context().contains(&tree.root.display().to_string()),
                "{name:?} must be rejected before the root is joined, got {:?}",
                error.context()
            );
        }
    }

    #[test]
    fn a_missing_spec_directory_is_reported_verbatim() {
        let tree = Tree::new();
        let error = SpecPaths::resolve(&tree.root, "absent")
            .expect_err("an absent spec directory is an error");

        assert_eq!(error.category(), ErrorCategory::Resolution);
        assert_eq!(error.category().exit_code(), 1);
        assert_eq!(
            error.context(),
            tree.join(&[".kiro", "specs", "absent"])
                .display()
                .to_string(),
            "the diagnostic names the joined path"
        );
        assert_eq!(error.detail(), "spec directory not found");
    }

    #[test]
    fn the_reported_path_is_not_canonicalised() {
        let tree = Tree::new();
        let root = tree.join(&["nested", ".."]);
        let error =
            SpecPaths::resolve(&root, "absent").expect_err("an absent spec directory is an error");

        assert!(
            error.context().ends_with("nested/../.kiro/specs/absent"),
            "the joined path is reported as built, got {:?}",
            error.context()
        );
    }

    #[test]
    fn a_file_in_place_of_the_spec_directory_is_rejected() {
        let tree = Tree::new();
        fs::create_dir_all(tree.join(&[".kiro", "specs"])).expect("specs directory is created");
        let file = tree.join(&[".kiro", "specs", "not-a-directory"]);
        fs::write(&file, b"- [ ] 1. Not a spec\n").expect("file is written");

        let error = SpecPaths::resolve(&tree.root, "not-a-directory")
            .expect_err("a file is not a spec directory");

        assert_eq!(error.category(), ErrorCategory::Resolution);
        assert_eq!(error.context(), file.display().to_string());
        assert_eq!(error.detail(), "spec path is not a directory");
    }

    #[test]
    fn resolution_never_searches_parent_directories() {
        let tree = Tree::new();
        tree.create_spec("demo");
        let child = tree.join(&["child"]);
        fs::create_dir_all(&child).expect("child directory is created");

        let error =
            SpecPaths::resolve(&child, "demo").expect_err("the parent spec must not be discovered");

        assert_eq!(error.detail(), "spec directory not found");
        assert_eq!(
            error.context(),
            child.join(".kiro/specs/demo").display().to_string()
        );
    }
}
