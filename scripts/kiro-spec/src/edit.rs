use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::MutationError;
use crate::tasks::TaskState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Change {
    Complete,
    Block { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditPlan {
    pub id: String,
    pub state: TaskState,
    pub bytes: Option<Vec<u8>>,
    pub reason: Option<String>,
}

pub fn replacement_bytes(original: &[u8], reassembled: &[u8]) -> Option<Vec<u8>> {
    if original == reassembled {
        None
    } else {
        Some(reassembled.to_vec())
    }
}

pub fn plan_edit(
    id: &str,
    state: TaskState,
    reason: Option<String>,
    original: &[u8],
    reassembled: &[u8],
) -> EditPlan {
    EditPlan {
        id: id.to_owned(),
        state,
        bytes: replacement_bytes(original, reassembled),
        reason,
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), MutationError> {
    let context = path.display().to_string();
    let directory = path.parent().ok_or_else(|| {
        MutationError::write(context.clone(), "target path has no parent directory")
    })?;
    let temp = temporary_path(directory);

    publish_temp(&temp, path, bytes, &context)?;

    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        MutationError::write(
            context,
            format!("cannot rename temporary file over target: {error}"),
        )
    })
}

fn temporary_path(directory: &Path) -> PathBuf {
    directory.join(format!(
        ".tasks.md.kiro-spec.{}.tmp",
        std::process::id()
    ))
}

fn publish_temp(
    temp: &Path,
    target: &Path,
    bytes: &[u8],
    context: &str,
) -> Result<(), MutationError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .map_err(|error| {
            MutationError::write(
                context.to_owned(),
                format!("cannot create temporary file {}: {error}", temp.display()),
            )
        })?;

    if let Err(error) = write_and_sync(&mut file, temp, target, bytes, context) {
        drop(file);
        let _ = fs::remove_file(temp);
        return Err(error);
    }
    drop(file);
    Ok(())
}

fn write_and_sync(
    file: &mut File,
    temp: &Path,
    target: &Path,
    bytes: &[u8],
    context: &str,
) -> Result<(), MutationError> {
    if let Ok(metadata) = fs::metadata(target) {
        fs::set_permissions(temp, metadata.permissions()).map_err(|error| {
            MutationError::write(
                context.to_owned(),
                format!(
                    "cannot copy permissions to temporary file {}: {error}",
                    temp.display()
                ),
            )
        })?;
    }

    file.write_all(bytes).map_err(|error| {
        MutationError::write(
            context.to_owned(),
            format!("cannot write temporary file {}: {error}", temp.display()),
        )
    })?;
    file.sync_all().map_err(|error| {
        MutationError::write(
            context.to_owned(),
            format!("cannot flush temporary file {}: {error}", temp.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{plan_edit, replacement_bytes, write_atomic};
    use crate::error::ErrorCategory;
    use crate::tasks::parse_tasks;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let unique = format!(
                "kiro-spec-edit-{tag}-{}-{}-{}",
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

    fn tasks_path(directory: &Path) -> PathBuf {
        directory.join("tasks.md")
    }

    fn temp_path(directory: &Path) -> PathBuf {
        directory.join(format!(
            ".tasks.md.kiro-spec.{}.tmp",
            std::process::id()
        ))
    }

    fn write_tasks(directory: &Path, bytes: &[u8]) -> PathBuf {
        let path = tasks_path(directory);
        fs::write(&path, bytes).expect("write tasks.md");
        path
    }

    #[test]
    fn atomic_replace_publishes_exact_bytes_and_leaves_no_temp() {
        let temp = TempDir::new("replace");
        let path = write_tasks(temp.path(), b"- [ ] 1. Task\n");
        let replacement = b"- [x] 1. Task\n  - _Boundary: kept_\n";

        write_atomic(&path, replacement).expect("atomic write");

        assert_eq!(fs::read(&path).expect("read tasks.md"), replacement);
        assert!(!temp_path(temp.path()).exists());
        let leftovers: Vec<String> = fs::read_dir(temp.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn a_stale_temporary_file_is_left_untouched_and_tasks_md_is_unchanged() {
        let temp = TempDir::new("stale");
        let original = b"- [ ] 1. Task\n";
        let path = write_tasks(temp.path(), original);
        let stale = temp_path(temp.path());
        fs::write(&stale, b"stale contents").expect("write stale temp");

        let error = write_atomic(&path, b"- [x] 1. Task\n").expect_err("create_new must fail");

        assert_eq!(error.category(), ErrorCategory::MutationWrite);
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert_eq!(fs::read(&stale).expect("read stale temp"), b"stale contents");
    }

    #[cfg(unix)]
    #[test]
    fn replacement_keeps_the_original_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("permissions");
        let path = write_tasks(temp.path(), b"- [ ] 1. Task\n");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("chmod tasks.md");

        write_atomic(&path, b"- [x] 1. Task\n").expect("atomic write");

        let mode = fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_spec_directory_leaves_tasks_md_unchanged() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new("readonly");
        let original = b"- [ ] 1. Task\n";
        let path = write_tasks(temp.path(), original);
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o555)).expect("chmod dir");

        let still_writable = {
            let probe = temp.path().join(format!(".kiro-spec-probe.{}", std::process::id()));
            match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    true
                }
                Err(_) => false,
            }
        };
        if still_writable {
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))
                .expect("restore dir mode");
            eprintln!("skipping: process can still write in a read-only directory");
            return;
        }

        let error = write_atomic(&path, b"- [x] 1. Task\n").expect_err("write must fail");

        assert_eq!(error.category(), ErrorCategory::MutationWrite);
        assert_eq!(fs::read(&path).expect("read tasks.md"), original);
        assert!(!temp_path(temp.path()).exists());

        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).expect("restore dir mode");
    }

    #[test]
    fn reassembly_reproduces_original_bytes_and_equal_bytes_are_a_no_op() {
        let lf = "- [ ] 1. Task\n  - _Requirements: 1.1_\n";
        let crlf = "# Plan\r\n\r\n- [ ] 1. Task\r\n  - _Requirements: 1.1_\r\n";
        let no_final_newline = "- [ ] 1. Task\n  - _Requirements: 1.1_";

        for text in [lf, crlf, no_final_newline] {
            let document = parse_tasks(text);
            let reassembled = document.to_bytes();
            assert_eq!(reassembled, text.as_bytes(), "{text:?}");

            let plan = plan_edit(
                document.entries()[0].id(),
                document.entries()[0].state(),
                None,
                text.as_bytes(),
                &reassembled,
            );
            assert_eq!(plan.id, "1");
            assert!(plan.bytes.is_none(), "{text:?}");
            assert_eq!(plan.reason, None);
        }
    }

    #[test]
    fn differing_reassembly_produces_replacement_bytes() {
        let original = b"- [ ] 1. Task\n";
        let reassembled = b"- [x] 1. Task\n";

        assert_eq!(
            replacement_bytes(original, reassembled),
            Some(reassembled.to_vec())
        );
        assert_eq!(replacement_bytes(original, original), None);
    }
}
