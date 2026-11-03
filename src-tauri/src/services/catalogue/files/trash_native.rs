//! Only this adapter interprets native trash results. Ambiguous failures never
//! authorize deletion. No parsing of localized operating-system messages.
#[cfg(any(not(windows), test))]
use std::io;
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
#[path = "trash_native_macos.rs"]
pub(super) mod macos;
#[cfg(any(windows, test))]
#[path = "trash_native_windows.rs"]
pub(super) mod windows;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Removed,
    UnavailableForTarget,
    Failed,
    Uncertain,
}
#[cfg(test)]
pub(super) fn injections(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Outcome>> {
    static VALUES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Outcome>>,
    > = std::sync::OnceLock::new();
    VALUES.get_or_init(Default::default)
}
#[cfg(test)]
pub(super) fn mac_probes(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, macos::Probe>> {
    static VALUES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, macos::Probe>>,
    > = std::sync::OnceLock::new();
    VALUES.get_or_init(Default::default)
}
#[cfg(test)]
pub(super) fn windows_probes(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (u32, i32)>> {
    static VALUES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (u32, i32)>>,
    > = std::sync::OnceLock::new();
    VALUES.get_or_init(Default::default)
}
#[cfg(test)]
fn take_injection<T>(
    values: &std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, T>>,
    path: &Path,
) -> Option<T> {
    // Native paths and serialized plans spell the same Windows path with and
    // without its extended prefix. An injected outcome must match both forms.
    let key = super::super::path_identity::key(path);
    let mut values = values.lock().unwrap();
    let stored = values
        .keys()
        .find(|p| super::super::path_identity::key(p) == key)
        .cloned()?;
    values.remove(&stored)
}
#[cfg(test)]
#[test]
fn injected_outcomes_match_native_and_frontend_paths_only() {
    let root = std::env::temp_dir().canonicalize().unwrap();
    let path = root.join(format!("trash-injection-{}", uuid::Uuid::new_v4()));
    let frontend = crate::support::paths::path_for_frontend(&path);
    let values = std::sync::Mutex::new(std::collections::HashMap::from([(
        path.clone(),
        Outcome::Uncertain,
    )]));
    assert_eq!(take_injection(&values, &path.with_extension("other")), None);
    assert_eq!(
        take_injection(&values, Path::new(&frontend)),
        Some(Outcome::Uncertain)
    );
    assert_eq!(take_injection(&values, &path), None);
}
#[cfg(test)]
pub(super) fn tracked_injections(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::path::PathBuf>> {
    static VALUES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::path::PathBuf>>,
    > = std::sync::OnceLock::new();
    VALUES.get_or_init(Default::default)
}

#[cfg(test)]
pub(super) fn discard(path: &Path) -> Outcome {
    discard_tracked(path).0
}

pub(super) fn discard_tracked(path: &Path) -> (Outcome, Option<super::trash_retention::Receipt>) {
    #[cfg(test)]
    if let Some(payload) = take_injection(tracked_injections(), path) {
        std::fs::rename(path, &payload).unwrap();
        return (
            Outcome::Removed,
            super::trash_retention::Receipt::capture(payload),
        );
    }
    #[cfg(test)]
    if let Some(outcome) = take_injection(injections(), path) {
        assert_eq!(
            crate::services::catalogue::writes::shared().classify(path, std::time::Instant::now()),
            crate::services::catalogue::writes::Verdict::Deferred
        );
        if outcome == Outcome::Removed {
            if path.is_dir() {
                std::fs::remove_dir_all(path).unwrap();
            } else {
                std::fs::remove_file(path).unwrap();
            }
        }
        // This older fake destroys the file: it models a bin already emptied.
        let receipt = (outcome == Outcome::Removed)
            .then(|| {
                super::trash_retention::Receipt::capture(
                    path.with_file_name(format!("empty-trash-{}", uuid::Uuid::new_v4())),
                )
            })
            .flatten();
        return (outcome, receipt);
    }
    #[cfg(test)]
    if let Some(probe) = take_injection(mac_probes(), path) {
        if let Some(outcome) = macos::classify(probe) {
            return (outcome, None);
        }
    }
    #[cfg(test)]
    if let Some((flags, error)) = take_injection(windows_probes(), path) {
        return (windows::qualify_test_callback(flags, error), None);
    }
    // Cocoa's structured qualification must precede junkyard: its Platform
    // error drops NSError domain/code and cannot authorize a permanent fallback.
    #[cfg(target_os = "macos")]
    if let Some(outcome) = macos::classify(macos::probe(path)) {
        return (outcome, None);
    }
    // junkyard's Windows sink accepts permanent deletion. The Shell adapter
    // must veto it before mutation rather than detect it after source loss.
    #[cfg(windows)]
    {
        let (outcome, payload) = windows::discard(path);
        (
            outcome,
            payload.and_then(super::trash_retention::Receipt::capture),
        )
    }
    #[cfg(not(windows))]
    {
        let result = junkyard::discard(path);
        match (result, std::fs::symlink_metadata(path)) {
            (Ok(item), Err(e)) if e.kind() == io::ErrorKind::NotFound => {
                let payload = payload_path(item.id());
                (
                    Outcome::Removed,
                    payload.and_then(super::trash_retention::Receipt::capture),
                )
            }
            (Err(error), observation) => (failure(error, observation.is_ok()), None),
            _ => (Outcome::Uncertain, None),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn payload_path(id: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(id);
    // junkyard's Freedesktop receipt identifies the .trashinfo file; Cocoa
    // and the Windows Shell return the payload itself. Confine this native
    // representation difference to the adapter.
    #[cfg(target_os = "linux")]
    {
        if path.extension()? != "trashinfo" {
            return None;
        }
        Some(
            path.parent()?
                .parent()?
                .join("files")
                .join(path.file_stem()?),
        )
    }
    #[cfg(not(target_os = "linux"))]
    Some(path.to_path_buf())
}

#[cfg(test)]
#[test]
fn trash_receipt_payload_paths_preserve_the_native_representation() {
    #[cfg(target_os = "linux")]
    assert_eq!(
        payload_path(std::ffi::OsStr::new("/tmp/Trash/info/Story.ZIP.trashinfo")),
        Some("/tmp/Trash/files/Story.ZIP".into())
    );
    #[cfg(not(target_os = "linux"))]
    assert_eq!(
        payload_path(std::ffi::OsStr::new("Story.ZIP")),
        Some("Story.ZIP".into())
    );
    let path = std::env::temp_dir().join(format!("trash-fake-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"trash").unwrap();
    injections()
        .lock()
        .unwrap()
        .insert(path.clone(), Outcome::Removed);
    let own = crate::services::catalogue::writes::OwnWrite::begin(
        crate::services::catalogue::writes::Declaration::new("testTrash").exact(&path),
    );
    assert_eq!(discard(&path), Outcome::Removed);
    own.finish(
        &Ok::<_, crate::support::user_message::UserMessage>(()),
        |_| vec![path],
    );
}
#[cfg(any(not(windows), test))]
fn failure(error: junkyard::Error, source_present: bool) -> Outcome {
    // Opaque platform errors may follow a move or a partial operation. Neither
    // an accessible source nor an access error proves native unavailability.
    match error {
        junkyard::Error::Io { source, .. } if source_present => {
            if source.kind() == io::ErrorKind::Unsupported {
                Outcome::UnavailableForTarget
            } else {
                Outcome::Failed
            }
        }
        _ => Outcome::Uncertain,
    }
}
#[cfg(test)]
#[test]
fn trash_native_errors_distinguish_unsupported_access_denied_and_disconnection() {
    let io_error = |kind| junkyard::Error::Io {
        path: "/pack.zip".into(),
        source: io::Error::from(kind),
    };
    assert_eq!(
        failure(io_error(io::ErrorKind::Unsupported), true),
        Outcome::UnavailableForTarget
    );
    assert_eq!(
        failure(io_error(io::ErrorKind::PermissionDenied), true),
        Outcome::Failed
    );
    assert_eq!(
        failure(io_error(io::ErrorKind::NotFound), false),
        Outcome::Uncertain
    );
    assert_eq!(
        failure(io_error(io::ErrorKind::Unsupported), false),
        Outcome::Uncertain
    );
    assert_eq!(
        failure(
            junkyard::Error::Platform {
                message: "unclassified native failure".into()
            },
            true
        ),
        Outcome::Uncertain
    );
}
