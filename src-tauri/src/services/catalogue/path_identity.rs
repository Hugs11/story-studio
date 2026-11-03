//! Native filesystem comparison adapter. Linux paths retain their bytes.
//! APFS compares Unicode canonical equivalents; Windows Win32 normally ignores
//! case. Probe existing ancestors so case-sensitive volumes/directories retain
//! case, without writing a probe into a user's source.
use std::path::Path;
#[cfg(any(windows, target_os = "macos", test))]
fn folded(value: &str, ignore_case: bool, canonical_unicode: bool) -> String {
    use unicode_normalization::UnicodeNormalization;
    let value = if ignore_case {
        value.to_lowercase()
    } else {
        value.to_owned()
    };
    if canonical_unicode {
        value.nfc().collect()
    } else {
        value
    }
}
#[cfg(any(windows, target_os = "macos"))]
fn insensitive(path: &Path) -> bool {
    for ancestor in path.ancestors() {
        let Some(name) = ancestor.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        let mut flipped = name.to_owned();
        if let Some((index, ch)) = name.char_indices().find(|(_, ch)| ch.is_ascii_alphabetic()) {
            flipped.replace_range(
                index..index + 1,
                &if ch.is_ascii_lowercase() {
                    ch.to_ascii_uppercase()
                } else {
                    ch.to_ascii_lowercase()
                }
                .to_string(),
            );
        }
        if flipped != name && ancestor.exists() {
            return same_file(ancestor, &ancestor.with_file_name(flipped));
        }
    }
    false
}
#[cfg(any(windows, target_os = "macos"))]
fn canonical_unicode(path: &Path) -> bool {
    use unicode_normalization::UnicodeNormalization;
    for ancestor in path.ancestors() {
        let Some(name) = ancestor.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        let composed: String = name.nfc().collect();
        let decomposed: String = name.nfd().collect();
        if composed != decomposed && ancestor.exists() {
            let alternate = if name == composed {
                decomposed
            } else {
                composed
            };
            return same_file(ancestor, &ancestor.with_file_name(alternate));
        }
    }
    false
}
#[cfg(target_os = "macos")]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(a)
        .ok()
        .zip(std::fs::metadata(b).ok())
        .is_some_and(|(a, b)| a.dev() == b.dev() && a.ino() == b.ino())
}
#[cfg(windows)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    fn id(path: &Path) -> Option<(u32, u32, u32)> {
        // FILE_FLAG_BACKUP_SEMANTICS is needed to open a directory handle.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(path)
            .ok()?;
        let mut info = Info::default();
        // The handle lives across the call and Info has the Windows ABI layout.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return None;
        }
        Some((info.volume, info.index_high, info.index_low))
    }
    id(a).zip(id(b)).is_some_and(|(a, b)| a == b)
}
pub fn key(path: &Path) -> Vec<u8> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        folded(
            &crate::support::paths::path_for_frontend(path),
            insensitive(path),
            canonical_unicode(path),
        )
        .into_bytes()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
}

/// Component-based containment with native identity confirmation for aliases. Paths
/// stored as native bytes and frontend anchors can differ by a Windows
/// extended prefix; string/Path::starts_with would reject the same directory.
pub(crate) fn contains(root: &Path, path: &Path) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        contains_with(root, path, super::probe::PROBE_TIMEOUT, same_file)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        path.starts_with(root)
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn contains_with(
    root: &Path,
    path: &Path,
    timeout: std::time::Duration,
    compare: impl FnOnce(&Path, &Path) -> bool + Send + 'static,
) -> bool {
    // Serialized anchors omit Windows' extended prefix. This lexical fast
    // path must not touch any volume, especially an unrelated offline source.
    #[cfg(windows)]
    let (portable_root, portable_path) = (
        std::path::PathBuf::from(crate::support::paths::path_for_frontend(root)),
        std::path::PathBuf::from(crate::support::paths::path_for_frontend(path)),
    );
    #[cfg(windows)]
    let (root, path) = (portable_root.as_path(), portable_path.as_path());
    if path.starts_with(root) {
        return true;
    }
    // A different spelling may be equivalent on an insensitive volume. Only
    // plausible ancestor names merit a probe; never visit an unrelated source.
    // The permissive fold selects candidates, it does not authorize access:
    // native file identity must confirm the match within the timeout. Text
    // keys can collide for distinct directories (e.g. K and Kelvin on NTFS).
    let root_spelling = folded(&root.to_string_lossy(), true, true);
    let Some(ancestor) = crate::support::paths::filesystem_ancestors(path)
        .find(|ancestor| folded(&ancestor.to_string_lossy(), true, true) == root_spelling)
    else {
        return false;
    };
    let owned_root = root.to_path_buf();
    let owned_ancestor = ancestor.to_owned();
    super::probe::bounded(root, timeout, move || compare(&owned_root, &owned_ancestor))
        == Some(true)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_keeps_component_boundaries_and_frontend_spelling() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let child = root.join("child");
        assert!(contains(&root, &child));
        let frontend = std::path::PathBuf::from(crate::support::paths::path_for_frontend(&child));
        assert!(contains(&root, &frontend));
        assert!(!contains(&child, &root.join("child-other")));
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(!contains(
            Path::new("/tmp/Pack"),
            Path::new("/tmp/pack/file")
        ));
    }

    #[test]
    fn containment_skips_probes_for_lexical_matches_and_unrelated_sources() {
        use std::time::Duration;
        let root = std::env::temp_dir().join(format!("containment-{}", uuid::Uuid::new_v4()));
        let child = root.join("pack/story.zip");
        assert!(contains_with(
            &root,
            &child,
            Duration::from_millis(100),
            |_, _| panic!("lexical match must not probe")
        ));
        let frontend = std::path::PathBuf::from(crate::support::paths::path_for_frontend(&child));
        assert!(contains_with(
            &root,
            &frontend,
            Duration::from_millis(100),
            |_, _| panic!("frontend spelling must not probe")
        ));
        // A dead SMB source preceding the matching source must never be opened.
        let unrelated = Path::new(r"\\unavailable-server\share\library");
        assert!(!contains_with(
            unrelated,
            &child,
            Duration::from_millis(100),
            |_, _| panic!("unrelated source must not probe")
        ));
        assert!(!contains_with(
            &root,
            &root.with_extension("other").join("pack"),
            Duration::from_millis(100),
            |_, _| panic!("component mismatch must not probe")
        ));
    }

    #[test]
    fn containment_requires_native_confirmation_for_case_or_unicode_variants() {
        use std::time::Duration;
        let root = std::env::temp_dir().join(format!("containment-{}", uuid::Uuid::new_v4()));
        let source = root.join("Été");
        let candidate = root.join("e\u{301}TÉ").join("pack.zip");
        // The broad lexical fold only selects a candidate. A case-sensitive
        // or Unicode-sensitive volume must still refuse the different path.
        assert!(!contains_with(
            &source,
            &candidate,
            Duration::from_secs(1),
            |_, _| false
        ));
        assert!(contains_with(
            &source,
            &candidate,
            Duration::from_secs(1),
            |root, ancestor| {
                assert_ne!(root, ancestor);
                true
            }
        ));
    }

    #[test]
    fn containment_abandons_a_hung_native_comparison() {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        let root = std::env::temp_dir().join(format!("containment-{}", uuid::Uuid::new_v4()));
        let source = root.join("Mixed");
        let candidate = root.join("mixed").join("pack.zip");
        let (entered, started) = mpsc::channel();
        let (release, hold) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let begin = Instant::now();
        let covered = contains_with(
            &source,
            &candidate,
            Duration::from_millis(150),
            move |_, _| {
                entered.send(()).unwrap();
                hold.recv().unwrap();
                finished.send(()).unwrap();
                true
            },
        );
        let elapsed = begin.elapsed();
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            !covered,
            "an inconclusive comparison must never authorize the path"
        );
        assert!(elapsed >= Duration::from_millis(150), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    }
    #[test]
    fn filesystem_policy() {
        assert_eq!(folded("Été", true, true), folded("E\u{301}TÉ", true, true));
        assert_ne!(folded("Pack", false, false), folded("pack", false, false));
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_ne!(key(Path::new("/tmp/Pack")), key(Path::new("/tmp/pack")));
    }
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn containment_confirms_native_directory_aliases_and_rejects_missing_ones() {
        let root =
            std::env::temp_dir().join(format!("catalogue-containment-{}", uuid::Uuid::new_v4()));
        let source = root.join("Packs-Mixed");
        let alias = root.join("packs-mixed");
        std::fs::create_dir_all(&source).unwrap();
        assert!(contains(&source, &source.join("missing/story.zip")));
        assert_eq!(
            contains(&source, &alias.join("missing/story.zip")),
            alias.is_dir()
        );
        // A matching text fold cannot establish identity for a missing root.
        let missing = root.join("Missing-Source");
        assert!(!contains(&missing, &root.join("missing-source/story.zip")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn containment_refuses_distinct_windows_directories_with_equal_folded_keys() {
        let root =
            std::env::temp_dir().join(format!("catalogue-containment-{}", uuid::Uuid::new_v4()));
        let source = root.join("Packs-K");
        let sibling = root.join("Packs-\u{212a}");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        // NTFS distinguishes K and the Kelvin sign, while Rust lowercasing
        // and Unicode normalization merge them. Neither fold authorizes IO.
        assert_eq!(key(&source), key(&sibling));
        assert!(!same_file(&source, &sibling));
        assert!(contains(&source, &source.join("story.zip")));
        assert!(!contains(&source, &sibling.join("story.zip")));
        assert!(!contains(&sibling, &source.join("story.zip")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn native_volume_case_and_unicode_policy() {
        let root = std::env::temp_dir().join(format!("catalogue-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let original = root.join("Mixed-Été");
        let alias = root.join("mixed-e\u{301}té");
        std::fs::write(&original, "fixture").unwrap();
        assert_eq!(contains(&original, &alias), same_file(&original, &alias));
        if same_file(&original, &alias) {
            assert_eq!(key(&original), key(&alias));
        } else {
            assert_ne!(key(&original), key(&alias));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
