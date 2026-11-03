//! Real pack count of a source archive file, for the trash of a sole member.
//! Same detection rules as the analyzers (STUdio `story.json`, device-pack
//! roots), but every rule applies at once and nested archives are inspected
//! recursively: the analyzers stop at a root `story.json` or skip device packs
//! beside a STUdio one, the catalogue then knows fewer packs than the file
//! holds. Any inventory that cannot be established is an error, so the caller
//! refuses rather than assuming the archive holds no other pack.
use super::*;
use std::{
    collections::BTreeSet,
    io::{Read, Seek},
    sync::atomic::AtomicBool,
};

/// A nested archive the existing readers cannot list without extraction.
pub const NESTED_UNINSPECTABLE: &str = "nestedArchiveUninspectable";

pub fn archive_pack_count(path: &Path, cancel: &AtomicBool) -> Result<usize, String> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("zip") => zip_count(
            std::fs::File::open(path).map_err(|e| e.to_string())?,
            0,
            cancel,
        ),
        Some("7z") => seven_count(path, cancel),
        _ => Err("formatUnsupported".into()),
    }
}

/// Distinct pack roots of one inventory, nested archives excluded.
fn roots(names: &[String]) -> usize {
    let mut roots = BTreeSet::new();
    for name in names.iter().filter(|n| !n.ends_with('/')) {
        // Case-insensitive here only: counting too many packs refuses the
        // trash, counting too few could remove one the catalogue ignores.
        let lower = name.to_ascii_lowercase();
        if lower == "story.json" {
            roots.insert(String::new());
        } else if lower.ends_with("/story.json") {
            roots.insert(name[..name.len() - "/story.json".len()].to_owned());
        }
    }
    for (root, _) in super::fs_archive::device_roots(names) {
        roots.insert(root.to_owned());
    }
    roots.len()
}

enum Nested {
    Zip,
    Uninspectable,
}
fn nested(name: &str) -> Option<Nested> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with('/') {
        None
    } else if lower.ends_with(".zip") {
        Some(Nested::Zip)
    } else if lower.ends_with(".7z") {
        Some(Nested::Uninspectable)
    } else {
        None
    }
}

fn zip_count(reader: impl Read + Seek, depth: usize, cancel: &AtomicBool) -> Result<usize, String> {
    let mut archive = super::studio::validated(reader, depth, cancel)?;
    let names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
    let mut count = roots(&names);
    for name in &names {
        match nested(name) {
            None => {}
            Some(Nested::Uninspectable) => return Err(NESTED_UNINSPECTABLE.into()),
            Some(Nested::Zip) => {
                let mut entry = archive.by_name(name).map_err(super::studio::zip_error)?;
                if entry.size() > crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES {
                    return Err("readLimitExceeded".into());
                }
                let temporary = super::temporary::Temporary::spool(&mut entry, cancel)?;
                drop(entry);
                count += zip_count(temporary.read()?, depth + 1, cancel)?;
            }
        }
    }
    Ok(count)
}

fn seven_count(path: &Path, cancel: &AtomicBool) -> Result<usize, String> {
    let entries = super::seven_zip::listing(path, cancel)?;
    let names = super::seven_zip::inventory_names(&entries);
    let mut count = roots(&names);
    for name in &names {
        match nested(name) {
            None => {}
            Some(Nested::Uninspectable) => return Err(NESTED_UNINSPECTABLE.into()),
            // Same spool and depth as the 7z analyzer for a nested ZIP.
            Some(Nested::Zip) => {
                let temporary = super::seven_zip::spool_nested(path, name, cancel)?;
                count += zip_count(temporary.read()?, 1, cancel)?;
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    /// `7z a` of `entries` with the bundled tool, as an external tool would.
    pub(crate) fn seven_bytes(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
        let scratch = std::env::temp_dir().join(format!("pack-count-{}", uuid::Uuid::new_v4()));
        let folder = scratch.join("content");
        for (name, bytes) in entries {
            let path = folder.join(name);
            if name.ends_with('/') {
                std::fs::create_dir_all(&path).unwrap();
            } else {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, bytes).unwrap();
            }
        }
        let archive = scratch.join("out.7z");
        let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
        let output = std::process::Command::new(tool)
            .arg("a")
            .arg("-t7z")
            .arg(&archive)
            .arg(".")
            .current_dir(&folder)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let bytes = std::fs::read(&archive).unwrap();
        std::fs::remove_dir_all(&scratch).unwrap();
        bytes
    }
    fn zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            if let Some(dir) = name.strip_suffix('/') {
                w.add_directory(dir, zip::write::SimpleFileOptions::default())
                    .unwrap();
            } else {
                w.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                w.write_all(bytes).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }
    fn count(bytes: Vec<u8>) -> Result<usize, String> {
        zip_count(Cursor::new(bytes), 0, &AtomicBool::new(false))
    }
    fn story() -> Vec<u8> {
        b"{\"title\":\"t\",\"stageNodes\":[],\"actionNodes\":[]}".to_vec()
    }
    #[test]
    fn counts_every_detection_rule_at_once() {
        assert_eq!(
            count(zip(&[("story.json", story()), ("notice.pdf", vec![1])])),
            Ok(1)
        );
        assert_eq!(
            count(zip(&[("story.json", story()), ("X/story.json", story())])),
            Ok(2)
        );
        let device = super::super::fs_archive::tests::fixture(&["B"], None, false);
        let mut inner = zip::ZipArchive::new(Cursor::new(device)).unwrap();
        let mut entries = vec![("A/story.json".to_owned(), story())];
        for i in 0..inner.len() {
            let mut e = inner.by_index(i).unwrap();
            let mut bytes = Vec::new();
            e.read_to_end(&mut bytes).unwrap();
            entries.push((e.name().to_owned(), bytes));
        }
        let entries = entries
            .iter()
            .map(|(n, b)| (n.as_str(), b.clone()))
            .collect::<Vec<_>>();
        assert_eq!(count(zip(&entries)), Ok(2));
    }
    #[test]
    fn nested_archives_are_counted_or_refused() {
        let one_root = zip(&[("story.json", story())]);
        let one_folder = zip(&[("pack/story.json", story()), ("pack/notice.pdf", vec![1])]);
        for inner in [one_root.clone(), one_folder] {
            assert_eq!(count(zip(&[("inner.zip", inner)])), Ok(1));
        }
        let deeper = zip(&[("middle.zip", zip(&[("inner.zip", one_root.clone())]))]);
        assert_eq!(count(deeper), Ok(1));
        assert_eq!(
            count(zip(&[
                ("a.zip", one_root.clone()),
                ("b.zip", one_root.clone())
            ])),
            Ok(2)
        );
        assert_eq!(
            count(zip(&[("A/story.json", story()), ("B.7z", vec![0; 8])])),
            Err(NESTED_UNINSPECTABLE.into())
        );
        assert!(count(zip(&[("A/story.json", story()), ("bad.zip", vec![0; 8])])).is_err());
    }
    #[test]
    fn story_json_is_counted_whatever_its_case() {
        assert_eq!(count(zip(&[("Story.json", story())])), Ok(1));
        assert_eq!(
            count(zip(&[("A/STORY.JSON", story()), ("B/story.json", story())])),
            Ok(2)
        );
    }
    #[test]
    fn nesting_beyond_the_read_depth_is_refused() {
        let one_root = zip(&[("story.json", story())]);
        let depth_3 = zip(&[("a.zip", zip(&[("b.zip", zip(&[("c.zip", one_root)]))]))]);
        assert_eq!(count(depth_3), Err("readLimitExceeded".into()));
    }
    #[test]
    fn oversized_nested_zip_is_refused() {
        // Declared size above the read limit, without writing 500 MiB: the
        // stored size fields of the local and central headers are patched.
        let mut bytes = zip(&[("A/story.json", story()), ("inner.zip", vec![0; 8])]);
        let declared = (crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES + 1) as u32;
        let mut patched = 0;
        for (signature, size_at, name_at) in [(b"PK\x03\x04", 22, 30), (b"PK\x01\x02", 24, 46)] {
            let mut at = 0;
            while let Some(found) = bytes[at..].windows(4).position(|w| w == signature) {
                let start = at + found;
                if bytes[start + name_at..].starts_with(b"inner.zip") {
                    bytes[start + size_at..start + size_at + 4]
                        .copy_from_slice(&declared.to_le_bytes());
                    patched += 1;
                }
                at = start + 4;
            }
        }
        assert_eq!(patched, 2);
        assert_eq!(count(bytes), Err("readLimitExceeded".into()));
    }
    #[test]
    fn seven_zip_inventories_follow_the_same_rules() {
        let scratch = std::env::temp_dir().join(format!("pack-count-7z-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let count = |name: &str, entries: Vec<(&str, Vec<u8>)>| {
            let entries = entries
                .into_iter()
                .map(|(n, b)| (n.to_owned(), b))
                .collect::<Vec<_>>();
            let path = scratch.join(name);
            std::fs::write(&path, seven_bytes(&entries)).unwrap();
            archive_pack_count(&path, &AtomicBool::new(false))
        };
        let inner = zip(&[("pack/story.json", story())]);
        assert_eq!(
            count(
                "one.7z",
                vec![("A/story.json", story()), ("notice.pdf", vec![1])]
            ),
            Ok(1)
        );
        assert_eq!(
            count(
                "two.7z",
                vec![("story.json", story()), ("X/story.json", story())]
            ),
            Ok(2)
        );
        assert_eq!(
            count("nested.7z", vec![("inner.zip", inner.clone())]),
            Ok(1)
        );
        assert_eq!(
            count("twice.7z", vec![("a.zip", inner.clone()), ("b.zip", inner)]),
            Ok(2)
        );
        assert_eq!(
            count(
                "seven.7z",
                vec![("A/story.json", story()), ("B.7z", vec![0; 8])]
            ),
            Err(NESTED_UNINSPECTABLE.into())
        );
        std::fs::remove_dir_all(&scratch).unwrap();
    }
}
