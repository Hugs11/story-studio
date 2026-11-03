//! Local-header ZIP reader for entries streamed out of a solid 7z. No spool.
use super::*;
use crate::support::{audio_duration as audio, fs_pack_reader as fs};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};

/// Local headers of entries written with a data descriptor (bit 3: Finder,
/// Java `ZipOutputStream`, …) carry no length, so they cannot be followed in a
/// stream. The caller then reads that one archive through `buffered`.
pub(super) const DATA_DESCRIPTOR: &str = "zipDataDescriptor";
fn is_data_descriptor(error: &zip::result::ZipError) -> bool {
    matches!(error, zip::result::ZipError::UnsupportedArchive(message)
        if message.contains("not available in the local header"))
}
/// Central-directory reading of a nested archive held in memory, bounded by
/// the per-file archive limit. No temporary file is written for this archive.
/// Only one such buffer exists at a time in the whole process.
pub(super) fn buffered(
    reader: &mut dyn Read,
    depth: usize,
    measure: bool,
    cancel: &AtomicBool,
    name: &str,
    expected: u64,
) -> Result<Vec<Observation>, String> {
    static ONE_BUFFER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let limit = crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES;
    if expected > limit {
        return Err("readLimitExceeded".into());
    }
    let _only = ONE_BUFFER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut bytes = Vec::with_capacity(expected as usize);
    audio::CancellableRead { reader, cancel }
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            if cancel.load(Ordering::Relaxed) {
                "cancelled".into()
            } else {
                e.to_string()
            }
        })?;
    if bytes.len() as u64 > limit {
        return Err("readLimitExceeded".into());
    }
    super::studio::zip_at(
        std::io::Cursor::new(bytes),
        depth,
        cancel,
        Path::new(name),
        measure,
    )
}
pub(super) fn read(
    reader: &mut dyn Read,
    depth: usize,
    measure: bool,
    cancel: &AtomicBool,
) -> Result<Vec<Observation>, String> {
    if depth > 2 {
        return Err("readLimitExceeded".into());
    }
    let mut reader = audio::CancellableRead { reader, cancel };
    let mut names = Vec::new();
    let mut indexes = HashMap::new();
    let mut durations = HashMap::new();
    let mut images = HashMap::new();
    let mut values = Vec::new();
    while let Some(mut entry) =
        zip::read::read_zipfile_from_stream(&mut reader).map_err(|error| {
            if cancel.load(Ordering::Relaxed) {
                "cancelled".into()
            } else if is_data_descriptor(&error) {
                DATA_DESCRIPTOR.into()
            } else {
                super::studio::zip_error(error)
            }
        })?
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let name = entry.name().to_owned();
        let size = entry.size();
        if entry.enclosed_name().is_none() {
            return Err("invalidArchivePath".into());
        }
        names.push(name.clone());
        if names.len() > crate::support::archive_limits::ARCHIVE_MAX_ENTRIES
            || size > crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES
        {
            return Err("readLimitExceeded".into());
        }
        let base = name.rsplit('/').next().unwrap_or(&name);
        let lower = name.to_ascii_lowercase();
        let base_lower = base.to_ascii_lowercase();
        if base == "story.json" {
            let mut out = super::studio::story(json(&mut entry)?, "zip");
            let root = name.trim_end_matches("story.json").trim_end_matches('/');
            if !root.is_empty() {
                out.member = Some(root.into());
                out.prepend_member("pack-root", root);
            }
            values.push(out);
        } else if name.to_ascii_lowercase().ends_with(".zip") {
            let children = read(&mut entry, depth + 1, measure, cancel)?;
            for mut child in children {
                child.member = Some(format!(
                    "{name}{}",
                    child
                        .member
                        .as_ref()
                        .map(|m| format!("/{m}"))
                        .unwrap_or_default()
                ));
                child.prepend_member("archive-entry", &name);
                values.push(child);
            }
        } else if matches!(
            base_lower.as_str(),
            "ni" | "ri" | "si" | "li" | "ri.plain" | "si.plain" | "li.plain"
        ) {
            if size > JSON_LIMIT {
                return Err("readLimitExceeded".into());
            }
            let mut b = Vec::new();
            entry.read_to_end(&mut b).map_err(|e| e.to_string())?;
            indexes.insert(name.clone(), b);
        } else if measure
            && (name.contains("assets/") || lower.starts_with("sf/") || lower.contains("/sf/"))
        {
            // Probe both variants from the first encrypted block. Index validation
            // below remains authoritative about the actual FS variant.
            let mut prefix = vec![0; (size as usize).min(512)];
            entry.read_exact(&mut prefix).map_err(|e| e.to_string())?;
            let encrypted = fs::decode_fs_pack_asset(fs::FsPackVariant::Encrypted, &prefix);
            let plain = prefix.starts_with(b"ID3")
                || prefix.starts_with(b"OggS")
                || prefix.starts_with(b"RIFF")
                || prefix.first() == Some(&0xff);
            if name.contains("assets/") && super::images::looks_like_image(&name, &prefix) {
                // A picture: decoded like the send preparation does, never
                // measured as a sound.
                let verdict = super::images::judge(
                    std::io::Cursor::new(prefix).chain(&mut entry),
                    size,
                    cancel,
                );
                if let Some(damaged) = verdict {
                    images.insert(name.clone(), damaged);
                }
            } else {
                let prefix = if plain { prefix } else { encrypted };
                let seconds = audio::duration(
                    std::io::Cursor::new(prefix).chain(&mut entry),
                    size,
                    None,
                    cancel,
                );
                durations.insert(name.clone(), seconds);
            }
        }
        let mut buffer = [0; 65536];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let n = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
        }
    }
    super::member::validate_names(names.iter().map(String::as_str))?;
    for out in &mut values {
        if out.chain.iter().any(|s| s.kind == "archive-entry") {
            continue;
        }
        let root = out
            .member
            .as_ref()
            .map(|m| format!("{m}/"))
            .unwrap_or_default();
        if names.contains(&format!("{root}thumbnail.png")) {
            out.cover = Some(
                serde_json::json!({"kind":"archiveEntry","path":format!("{root}thumbnail.png")}),
            );
        }
        if measure {
            if let Some(stories) = super::listening::stories(&out.raw) {
                let sounds = stories
                    .iter()
                    .map(|(_, a)| a)
                    .collect::<std::collections::BTreeSet<_>>();
                let duration = sounds.into_iter().try_fold(0.0, |total, a| {
                    Some(total + durations.get(&format!("{root}assets/{a}"))?.as_ref()?)
                });
                super::listening::record(out, stories.len(), duration);
            }
            super::images::record(out, |a| images.get(&format!("{root}assets/{a}")).copied());
        }
    }
    if values.is_empty() {
        values = super::fs_archive::analyze(&names, "fsZip", cancel, |name, limit| {
            let b = indexes.get(name).ok_or("invalidPackStructure")?;
            Ok((
                b.iter().copied().take(limit as usize).collect(),
                b.len() as u64,
            ))
        })?;
        if measure {
            for out in &mut values {
                let Some(variant) = out.raw["variant"]
                    .as_str()
                    .and_then(fs::FsPackVariant::from_preview_name)
                else {
                    continue;
                };
                let root = out
                    .member
                    .as_ref()
                    .map(|m| format!("{m}/"))
                    .unwrap_or_default();
                super::listening::fs(
                    out,
                    variant,
                    variant == fs::FsPackVariant::Cleartext,
                    |name, _| {
                        let b =
                            super::listening::get_ignore_case(&indexes, &format!("{root}{name}"))
                                .ok_or("invalidPackStructure")?;
                        Ok((b.clone(), b.len() as u64))
                    },
                    cancel,
                    |name, _| {
                        super::listening::get_ignore_case(&durations, &format!("{root}{name}"))
                            .copied()
                            .flatten()
                    },
                );
            }
        }
    }
    if values.is_empty() {
        return Err("invalidPackStructure".into());
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    fn archive(files: &[(&str, Vec<u8>)], method: zip::CompressionMethod) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files {
            w.start_file(
                *name,
                zip::write::SimpleFileOptions::default().compression_method(method),
            )
            .unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap().into_inner()
    }
    fn pack(method: zip::CompressionMethod) -> Vec<u8> {
        let doc = serde_json::json!({"stageNodes":[
            {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"choice","optionIndex":0}},
            {"uuid":"a","audio":"same.mp3","controlSettings":{"pause":true}},
            {"uuid":"b","audio":"same.mp3","controlSettings":{"pause":true}}
        ],"actionNodes":[{"id":"choice","options":["a","b"]}]});
        let mut sound = vec![0; 16000];
        sound[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        archive(
            &[
                ("assets/same.mp3", sound),
                ("story.json", serde_json::to_vec(&doc).unwrap()),
            ],
            method,
        )
    }
    #[test]
    fn listening_nested_zip_stream_matches_seekable_for_stored_and_deflated() {
        let cancel = AtomicBool::new(false);
        for method in [
            zip::CompressionMethod::Stored,
            zip::CompressionMethod::Deflated,
        ] {
            let bytes = pack(method);
            let stream = read(&mut Cursor::new(&bytes), 1, true, &cancel).unwrap();
            let seek = super::super::studio::zip(Cursor::new(&bytes), 1, &cancel).unwrap();
            assert_eq!(
                stream[0].valid_field(&["/packMetadata/storyCount"]),
                Some(&serde_json::json!(2))
            );
            assert_eq!(
                stream[0].valid_field(&["/packMetadata/durationSeconds"]),
                Some(&serde_json::json!(1.0))
            );
            assert_eq!(
                serde_json::to_value(&stream[0].fields).unwrap(),
                serde_json::to_value(&seek[0].fields).unwrap()
            );
            let bytes = archive(&[("inner.zip", bytes)], method);
            let nested = read(&mut Cursor::new(bytes), 0, true, &cancel).unwrap();
            assert_eq!(nested[0].member.as_deref(), Some("inner.zip"));
            assert_eq!(
                nested[0].valid_field(&["/packMetadata/storyCount"]),
                Some(&serde_json::json!(2))
            );
        }
    }
    /// Marks every entry as written with a data descriptor (bit 3), as the
    /// Finder or Java `ZipOutputStream` do; central sizes stay authoritative.
    fn with_data_descriptors(mut bytes: Vec<u8>) -> Vec<u8> {
        let mut i = 0;
        while i + 4 <= bytes.len() {
            match &bytes[i..i + 4] {
                b"PK\x03\x04" => bytes[i + 6] |= 8,
                b"PK\x01\x02" => bytes[i + 8] |= 8,
                _ => {}
            }
            i += 1;
        }
        bytes
    }
    #[test]
    fn data_descriptor_archive_is_read_buffered_with_the_same_observations() {
        let cancel = AtomicBool::new(false);
        let plain = pack(zip::CompressionMethod::Stored);
        let marked = with_data_descriptors(plain.clone());
        assert_ne!(plain, marked);
        assert_eq!(
            read(&mut Cursor::new(&marked), 1, true, &cancel).unwrap_err(),
            DATA_DESCRIPTOR
        );
        let streamed = read(&mut Cursor::new(&plain), 1, true, &cancel).unwrap();
        let buffered = buffered(
            &mut Cursor::new(&marked),
            1,
            true,
            &cancel,
            "inner.zip",
            marked.len() as u64,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&buffered[0].fields).unwrap(),
            serde_json::to_value(&streamed[0].fields).unwrap()
        );
        assert_eq!(
            buffered[0].valid_field(&["/packMetadata/durationSeconds"]),
            Some(&serde_json::json!(1.0))
        );
        let metadata = buffered_metadata(&marked);
        assert!(metadata[0]
            .valid_field(&["/packMetadata/storyCount"])
            .is_none());
        assert_eq!(metadata[0].uuid(), streamed[0].uuid());
    }
    fn buffered_metadata(bytes: &[u8]) -> Vec<Observation> {
        buffered(
            &mut Cursor::new(bytes),
            1,
            false,
            &AtomicBool::new(false),
            "inner.zip",
            bytes.len() as u64,
        )
        .unwrap()
    }
    #[test]
    fn data_descriptor_zip_inside_a_solid_7z_is_indexed_and_measured() {
        let dir = std::env::temp_dir().join(format!("story-studio-dd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        struct Clean(std::path::PathBuf);
        impl Drop for Clean {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _clean = Clean(dir.clone());
        std::fs::write(
            dir.join("inner.zip"),
            with_data_descriptors(pack(zip::CompressionMethod::Deflated)),
        )
        .unwrap();
        let archive = dir.join("collection.7z");
        let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
        let output = std::process::Command::new(tool)
            .args(["a", "-t7z", "-ms=on"])
            .arg(&archive)
            .arg("inner.zip")
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(output.status.success());
        let cancel = AtomicBool::new(false);
        let mut observed = super::super::analyze_with(&archive, &cancel, true).unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].state, "available");
        assert!(observed[0].listening_pending);
        super::super::enrich_7z(&archive, &mut observed, &cancel).unwrap();
        assert_eq!(
            observed[0].valid_field(&["/packMetadata/storyCount"]),
            Some(&serde_json::json!(2))
        );
        assert_eq!(
            observed[0].valid_field(&["/packMetadata/durationSeconds"]),
            Some(&serde_json::json!(1.0))
        );
    }
    #[test]
    fn listening_nested_zip_metadata_pass_skips_measurement_and_cancels() {
        let bytes = pack(zip::CompressionMethod::Stored);
        let out = read(&mut Cursor::new(&bytes), 0, false, &AtomicBool::new(false)).unwrap();
        assert!(out[0].valid_field(&["/packMetadata/storyCount"]).is_none());
        assert_eq!(
            read(&mut Cursor::new(bytes), 0, true, &AtomicBool::new(true)).unwrap_err(),
            "cancelled"
        );
    }
}
