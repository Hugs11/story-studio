//! Device-pack observations from a validated archive inventory. Only the node
//! header and image index are read; covers retain archive locators.
use super::*;
use crate::support::fs_pack_reader::{self as fs, FsPackVariant, FsPreviewError};
use std::collections::BTreeSet;

fn files(names: &[String]) -> BTreeSet<&str> {
    names
        .iter()
        .filter(|n| !n.ends_with('/'))
        .map(String::as_str)
        .collect()
}
fn in_root(root: &str, name: &str) -> String {
    if root.is_empty() {
        name.to_owned()
    } else {
        format!("{root}/{name}")
    }
}
// Preserve actual ZIP names for reads and locators, including case-sensitive
// asset names; only resolution follows a case-insensitive filesystem.
fn resolve<'a>(files: &BTreeSet<&'a str>, name: &str) -> Option<&'a str> {
    files.get(name).copied().or_else(|| {
        files
            .iter()
            .copied()
            .find(|file| file.eq_ignore_ascii_case(name))
    })
}
/// Device-pack roots of an archive inventory and their variant: the single
/// detection rule shared by the analyzers and the trash pack count.
pub(super) fn device_roots(names: &[String]) -> Vec<(&str, FsPackVariant)> {
    let files = files(names);
    let roots: BTreeSet<_> = files
        .iter()
        .filter_map(|n| match n.rsplit_once('/') {
            Some((root, name)) if name.eq_ignore_ascii_case("ni") => Some(root),
            None if n.eq_ignore_ascii_case("ni") => Some(""),
            _ => None,
        })
        .collect();
    roots
        .into_iter()
        .filter_map(|root| {
            fs::detect_fs_pack_variant_with(
                |name| resolve(&files, &in_root(root, name)).is_some(),
                |name| {
                    let prefix = format!("{}/", in_root(root, name));
                    names.iter().any(|n| {
                        n.get(..prefix.len())
                            .is_some_and(|p| p.eq_ignore_ascii_case(&prefix))
                    })
                },
            )
            .map(|variant| (root, variant))
        })
        .collect()
}
pub(super) fn analyze(
    names: &[String],
    format: &str,
    cancel: &std::sync::atomic::AtomicBool,
    mut read: impl FnMut(&str, u64) -> Result<(Vec<u8>, u64), String>,
) -> Result<Vec<Observation>, String> {
    let files = files(names);
    let mut values = Vec::new();
    for (root, variant) in device_roots(names) {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let path = |name: &str| in_root(root, name);
        let resolve = |name: &str| resolve(&files, name);
        let preview = (|| {
            let (ni, size) = read(resolve(&path("ni")).ok_or("invalidPackStructure")?, 516)?;
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            fs::fs_pack_preview_with(
                variant,
                resolve(&path(fs::FS_PACK_CLEARTEXT_MARKER)).is_some(),
                &ni,
                size,
                |name, limit| {
                    read(
                        resolve(&path(name))
                            .ok_or_else(|| FsPreviewError::Read("invalidPackStructure".into()))?,
                        limit + 1,
                    )
                    .map(|(bytes, _)| bytes)
                    .map_err(FsPreviewError::Read)
                },
                |name, variant| {
                    if name.is_empty()
                        || name
                            .split('/')
                            .any(|p| p.is_empty() || p == "." || p == "..")
                        || name.contains(':')
                    {
                        return None;
                    }
                    let mut name = std::path::PathBuf::from(path(&format!("rf/{name}")));
                    if variant == FsPackVariant::Plain && name.extension().is_none() {
                        name.set_extension("bmp");
                    }
                    let name = name.to_str()?;
                    resolve(name).map(str::to_owned)
                },
            )
            .map_err(FsPreviewError::into_reason)
        })();
        let mut out = match preview {
            Ok(raw) => {
                let mut out = Observation::new(format);
                out.cover = raw["cover"]
                    .as_str()
                    .map(|name| serde_json::json!({"kind":"archiveEntry","path":name}));
                out.raw = raw;
                // Rootless archives have no folder identity: do not invent one.
                if !root.is_empty() {
                    let name = fs::fs_pack_directory_identity(Path::new(root));
                    out.identity = Some(identity(&Value::String(name), "directoryName"));
                }
                out
            }
            Err(reason) if reason == "cancelled" => return Err(reason),
            Err(reason) => Observation::failure(format, reason, None),
        };
        if !root.is_empty() {
            out.member = Some(root.to_owned());
            out.prepend_member("pack-root", root);
        }
        values.push(out);
    }
    Ok(values)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::{Cursor, Write};
    use std::sync::atomic::AtomicBool;
    pub(crate) fn fixture(roots: &[&str], hostile: Option<&str>, encrypted: bool) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        for root in roots {
            let prefix = if root.is_empty() {
                String::new()
            } else {
                format!("{root}/")
            };
            let mut ni = vec![0; 556];
            ni[2..4].copy_from_slice(&1i16.to_le_bytes());
            ni[8..12].copy_from_slice(&44u32.to_le_bytes());
            ni[12..16].copy_from_slice(&1u32.to_le_bytes());
            let mut ri = b"000/IMAGE001".to_vec();
            ri.push(0);
            let mut cover = b"BMentry-image".to_vec();
            if encrypted {
                ri = crate::support::fs_pack_reader::fs_fixtures::encipher_common_key(&ri);
                cover = crate::support::fs_pack_reader::fs_fixtures::encipher_common_key(&cover);
            }
            let suffix = if encrypted { "" } else { ".plain" };
            for (name, bytes) in [
                ("ni".into(), ni),
                (format!("ri{suffix}"), ri),
                (format!("si{suffix}"), vec![]),
                (format!("li{suffix}"), vec![]),
                (
                    format!("rf/000/IMAGE001{}", if encrypted { "" } else { ".bmp" }),
                    cover,
                ),
            ] {
                zip.start_file(format!("{prefix}{name}"), opts).unwrap();
                zip.write_all(&bytes).unwrap();
            }
            zip.add_directory(format!("{prefix}sf/"), opts).unwrap();
        }
        if let Some(name) = hostile {
            zip.start_file(name, opts).unwrap();
            zip.write_all(b"hostile").unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    // Patch ZIP headers independently of the analyzer. The payload stays stored,
    // deliberately unreadable once its method is declared as LZMA.
    fn patch_headers(bytes: &mut [u8], name: &str, method: Option<u16>, size: Option<u32>) {
        for offset in 0..bytes.len().saturating_sub(46) {
            let (method_at, size_at, name_at) = if bytes[offset..].starts_with(b"PK\x03\x04") {
                (8, 22, 30)
            } else if bytes[offset..].starts_with(b"PK\x01\x02") {
                (10, 24, 46)
            } else {
                continue;
            };
            if bytes[offset + name_at..].starts_with(name.as_bytes()) {
                if let Some(method) = method {
                    bytes[offset + method_at..offset + method_at + 2]
                        .copy_from_slice(&method.to_le_bytes());
                }
                if let Some(size) = size {
                    bytes[offset + size_at..offset + size_at + 4]
                        .copy_from_slice(&size.to_le_bytes());
                }
            }
        }
    }
    fn patch_flags(bytes: &mut [u8], name: &str, set: u16) {
        for offset in 0..bytes.len().saturating_sub(46) {
            let (flag_at, name_at) = if bytes[offset..].starts_with(b"PK\x03\x04") {
                (6, 30)
            } else if bytes[offset..].starts_with(b"PK\x01\x02") {
                (8, 46)
            } else {
                continue;
            };
            if bytes[offset + name_at..].starts_with(name.as_bytes()) {
                let flags =
                    u16::from_le_bytes([bytes[offset + flag_at], bytes[offset + flag_at + 1]]);
                bytes[offset + flag_at..offset + flag_at + 2]
                    .copy_from_slice(&(flags | set).to_le_bytes());
            }
        }
    }
    fn analyze_device_zip(bytes: Vec<u8>) -> Vec<super::super::Observation> {
        super::super::studio::zip(Cursor::new(bytes), 0, &AtomicBool::new(false)).unwrap()
    }
    #[test]
    fn device_zip_encrypted_entry_is_protected_not_unreadable() {
        let mut bytes = fixture(&["pack"], None, false);
        patch_flags(&mut bytes, "pack/ni", 1);
        let out = analyze_device_zip(bytes);
        assert_eq!(out[0].state, "protectedArchive");
    }
    #[test]
    fn device_zip_corrupt_entry_is_corrupt_not_unreadable() {
        let mut bytes = fixture(&["pack"], None, false);
        // Break the local header signature of `ni` only.
        let at = (0..bytes.len() - 34)
            .find(|&o| {
                bytes[o..].starts_with(b"PK\x03\x04") && bytes[o + 30..].starts_with(b"pack/ni")
            })
            .unwrap();
        bytes[at + 2] = 0;
        // Already refused by the raw pre-validation; guards that the
        // corruption reason is never degraded to an unknown one.
        let reason =
            super::super::studio::zip(Cursor::new(bytes), 0, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(super::super::public_reason(&reason), "corruptArchive");
    }
    #[test]
    fn device_zip_lzma_uses_editor_compression_message() {
        let mut bytes = fixture(&["pack"], None, false);
        patch_headers(&mut bytes, "pack/ni", Some(14), None);
        let path = std::env::temp_dir().join(format!("LZMA-{}.zip", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        let out = super::super::analyze(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(out[0].state, "unsupportedFormat");
        let message = &out[0].diagnostics[0];
        assert!(
            message.contains("IMPORT_UNSUPPORTED_COMPRESSION"),
            "{message}"
        );
        assert!(
            message.contains("FILES_ARCHIVE_COMPRESSION_UNSUPPORTED"),
            "{message}"
        );
        assert!(message.contains(path.file_name().unwrap().to_str().unwrap()));
        assert!(message.contains("pack/ni"));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn device_zip_real_reader_enforces_declared_and_streamed_index_limits() {
        let mut declared = fixture(&["pack"], None, false);
        patch_headers(&mut declared, "pack/ri.plain", None, Some(u32::MAX));
        let mut archive =
            zip::ZipArchive::new(Cursor::new(fixture(&["pack"], None, false))).unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for i in 0..archive.len() {
            let entry = archive.by_index_raw(i).unwrap();
            if entry.name() != "pack/ri.plain" {
                zip.raw_copy_file(entry).unwrap();
            }
        }
        zip.start_file("pack/ri.plain", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&vec![0; 1024 * 1024 + 1]).unwrap();
        let streamed = zip.finish().unwrap().into_inner();
        for bytes in [declared, streamed] {
            let out =
                super::super::studio::zip(Cursor::new(bytes), 0, &AtomicBool::new(false)).unwrap();
            assert_eq!(out[0].state, "readLimitExceeded");
        }
    }
    #[test]
    fn device_zip_cancellation_inside_fs_archive_before_root_and_after_read() {
        let names = ["ni", "ri", "li", "si", "rf/file", "sf/file"].map(str::to_owned);
        let cancel = AtomicBool::new(true);
        assert_eq!(
            super::analyze(&names, "fsZip", &cancel, |_, _| panic!(
                "cancelled root must not read"
            ))
            .unwrap_err(),
            "cancelled"
        );
        cancel.store(false, std::sync::atomic::Ordering::Relaxed);
        let mut reads = 0;
        assert_eq!(
            super::analyze(&names, "fsZip", &cancel, |_, _| {
                reads += 1;
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok((vec![0; 516], 556))
            })
            .unwrap_err(),
            "cancelled"
        );
        assert_eq!(reads, 1);
    }
    #[test]
    fn device_zip_case_insensitive_names_preserve_actual_asset_locator() {
        let original = fixture(&["MiXeD"], None, false);
        let mut archive = zip::ZipArchive::new(Cursor::new(original)).unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for i in 0..archive.len() {
            let entry = archive.by_index_raw(i).unwrap();
            let name = entry.name().to_ascii_uppercase();
            zip.raw_copy_file_rename(entry, name).unwrap();
        }
        let out = super::super::studio::zip(
            Cursor::new(zip.finish().unwrap().into_inner()),
            0,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(out[0].state, "available");
        assert_eq!(
            out[0].cover.as_ref().unwrap()["path"],
            "MIXED/RF/000/IMAGE001.BMP"
        );
    }
    #[test]
    fn direct_studio_zip_symlinks_are_deliberately_rejected() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("story.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.add_symlink("link", "outside", zip::write::SimpleFileOptions::default())
            .unwrap();
        assert_eq!(
            super::super::studio::zip(
                Cursor::new(zip.finish().unwrap().into_inner()),
                0,
                &AtomicBool::new(false)
            )
            .unwrap_err(),
            "invalidArchivePath"
        );
    }
    #[test]
    fn device_zip_roots_identity_members_cover_and_source_immutability() {
        let id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        for roots in [
            vec![""],
            vec![id],
            vec!["wrapper/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
            vec![id, "nested/11111111-2222-4333-8444-555555555555"],
        ] {
            for encrypted in [false, true] {
                let bytes = fixture(&roots, None, encrypted);
                let before = bytes.clone();
                let values =
                    super::super::studio::zip(Cursor::new(&bytes), 0, &AtomicBool::new(false))
                        .unwrap();
                assert_eq!(values.len(), roots.len());
                for (out, root) in values.iter().zip(&roots) {
                    assert_eq!(out.format, "fsZip");
                    assert_eq!(out.state, "available");
                    assert_eq!(out.raw["version"], 1);
                    if root.is_empty() {
                        assert!(out.identity.is_none());
                        assert!(out.member_key().is_none());
                    } else {
                        assert_eq!(out.uuid(), Some(root.rsplit('/').next().unwrap()));
                        assert_eq!(out.member.as_deref(), Some(*root));
                        assert_eq!(out.chain[0].kind, "pack-root");
                        assert!(out.member_key().is_some());
                    }
                    assert_eq!(out.cover.as_ref().unwrap()["kind"], "archiveEntry");
                }
                assert_eq!(before, bytes);
            }
        }
    }
    #[test]
    fn device_zip_cover_is_read_and_deciphered_without_source_changes() {
        for encrypted in [false, true] {
            let bytes = fixture(&["uuid-folder"], None, encrypted);
            let path =
                std::env::temp_dir().join(format!("device-cover-{}.zip", uuid::Uuid::new_v4()));
            std::fs::write(&path, &bytes).unwrap();
            let values = super::super::analyze(&path, &AtomicBool::new(false)).unwrap();
            let out = serde_json::to_value(&values[0]).unwrap();
            let cover =
                super::super::read_cover(&serde_json::json!({"path":path}), &out, 1024).unwrap();
            assert_eq!(cover, b"BMentry-image");
            assert!(super::super::read_cover(&serde_json::json!({"path":path}), &out, 2).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn device_zip_rejects_links_before_reading_any_pack() {
        let bytes = fixture(&["pack"], None, false);
        let mut zip = zip::ZipWriter::new_append(Cursor::new(bytes)).unwrap();
        zip.add_symlink(
            "pack/link",
            "outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert_eq!(
            super::super::studio::zip(Cursor::new(bytes), 0, &AtomicBool::new(false)).unwrap_err(),
            "invalidArchivePath"
        );
    }
    #[test]
    fn device_zip_image_index_limit_and_ambiguous_variants_are_preserved() {
        let bytes = fixture(&["pack"], None, false);
        let mut zip = zip::ZipWriter::new_append(Cursor::new(bytes)).unwrap();
        zip.start_file("pack/extra", zip::write::SimpleFileOptions::default())
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
        let out = super::analyze(&names, "fsZip", &AtomicBool::new(false), |name, limit| {
            if name.ends_with("ri.plain") {
                return Ok((vec![0; 1024 * 1024 + 1], 1024 * 1024 + 1));
            }
            use std::io::Read;
            let entry = archive.by_name(name).unwrap();
            let size = entry.size();
            let mut bytes = Vec::new();
            entry.take(limit).read_to_end(&mut bytes).unwrap();
            Ok((bytes, size))
        })
        .unwrap();
        assert_eq!(out[0].state, "readLimitExceeded");
        let mut names = names;
        names.extend(["pack/ri", "pack/si", "pack/li"].map(str::to_owned));
        assert!(
            super::analyze(&names, "fsZip", &AtomicBool::new(false), |_, _| panic!(
                "ambiguous variant must not read"
            ))
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn device_zip_rejects_hostile_paths_and_cancellation() {
        for name in ["../outside", "/absolute", "a/../../escape", "C:/escape"] {
            assert!(super::super::studio::zip(
                Cursor::new(fixture(&["pack"], Some(name), false)),
                0,
                &AtomicBool::new(false)
            )
            .is_err());
        }
        assert_eq!(
            super::super::studio::zip(
                Cursor::new(fixture(&["pack"], None, false)),
                0,
                &AtomicBool::new(true)
            )
            .unwrap_err(),
            "cancelled"
        );
    }
}
