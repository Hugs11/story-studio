//! Damaged pictures are found while a pack is measured, never at send time only.
//!
//! Each picture a story document references is decoded with the very rule the
//! send preparation applies (`native_pack::assets::advanced::inventory`): an
//! empty file, or one `image::load_from_memory` cannot decode, or one without
//! pixels, is damaged. The first damaged picture, in document order, is the one
//! published: its kind and the name of the screen that carries it, never a path
//! or a file name. Sounds are not decoded here (a header read only).
use super::listening::{confined_asset, dependency_stamps, open_regular};
use super::*;
use std::io::Seek;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const DAMAGED_MEDIA: &str = "/packMetadata/damagedMedia";
/// A picture larger than this is left unexamined (never reported damaged).
const READ_LIMIT: u64 = 32 * 1024 * 1024;

/// The send preparation's decision, on the bytes of one picture.
pub(crate) fn is_damaged(bytes: &[u8]) -> bool {
    bytes.is_empty()
        || ::image::load_from_memory(bytes).map_or(true, |i| i.width() == 0 || i.height() == 0)
}

/// Whether a streamed archive member is a picture, from its name or its first bytes.
pub(super) fn looks_like_image(name: &str, prefix: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    ["bmp", "png", "jpg", "jpeg", "gif", "webp"]
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
        || prefix.starts_with(b"BM")
        || prefix.starts_with(b"\x89PNG")
        || prefix.starts_with(&[0xff, 0xd8, 0xff])
        || prefix.starts_with(b"GIF8")
        || (prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP"))
}

/// Verdict on a picture read from `reader`; `None` when it cannot be judged
/// (unreadable archive member, over the limit, cancelled).
pub(super) fn judge(reader: impl Read, size: u64, cancel: &AtomicBool) -> Option<bool> {
    if size > READ_LIMIT || cancel.load(Ordering::Relaxed) {
        return None;
    }
    let mut bytes = Vec::new();
    reader.take(READ_LIMIT).read_to_end(&mut bytes).ok()?;
    Some(is_damaged(&bytes))
}

/// Pictures a story references, in document order: the asset reference and the
/// name of the first screen that carries it.
pub(super) fn references(raw: &Value) -> Vec<(String, Option<String>)> {
    let Ok(document) = serde_json::from_value::<crate::native_pack::StoryDocument>(raw.clone())
    else {
        return Vec::new();
    };
    let mut found: Vec<(String, Option<String>)> = Vec::new();
    for stage in &document.stage_nodes {
        let Some(asset) = stage.image.value().filter(|a| !a.trim().is_empty()) else {
            continue;
        };
        let name = stage
            .name
            .value()
            .map(|n| n.trim())
            .filter(|n| !n.is_empty())
            .map(str::to_owned);
        match found.iter_mut().find(|(a, _)| a == asset) {
            Some((_, screen)) => {
                if screen.is_none() {
                    *screen = name;
                }
            }
            None => found.push((asset.clone(), name)),
        }
    }
    found
}

/// Publishes the first damaged picture; `verdict` answers per asset reference.
pub(super) fn record(out: &mut Observation, mut verdict: impl FnMut(&str) -> Option<bool>) {
    for (asset, screen) in references(&out.raw) {
        if verdict(&asset) == Some(true) {
            out.fields.insert(
                DAMAGED_MEDIA.into(),
                ObservedField {
                    presence: "present".into(),
                    raw_value: Some(serde_json::json!({"kind": "image", "screen": screen})),
                    validity: "valid".into(),
                    source: "imageDecode:v1".into(),
                },
            );
            return;
        }
    }
}

pub(super) fn directory(out: &mut Observation, root: &Path, cancel: &AtomicBool) {
    let paths: Vec<_> = references(&out.raw)
        .iter()
        .filter_map(|(asset, _)| confined_asset(root, asset))
        .map(|p| crate::support::paths::path_for_frontend(&p))
        .collect();
    if paths.is_empty() {
        return;
    }
    let before = dependency_stamps(&paths);
    out.listening_dependencies.extend(paths.iter().cloned());
    record(out, |asset| {
        let (file, size) = open_regular(&confined_asset(root, asset)?)?;
        judge(file, size, cancel)
    });
    // A picture changed while it was read: measured again next time.
    if before != dependency_stamps(&paths) {
        out.listening_incomplete = true;
    }
}

pub(super) fn zip<R: Read + Seek>(
    out: &mut Observation,
    archive: &mut zip::ZipArchive<R>,
    root: &str,
    cancel: &AtomicBool,
) {
    record(out, |asset| {
        let entry = archive.by_name(&format!("{root}assets/{asset}")).ok()?;
        let size = entry.size();
        judge(entry, size, cancel)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// A valid 320x240 RLE4 bitmap, written byte by byte for this fixture only.
    fn bitmap() -> Vec<u8> {
        let mut bytes = vec![0; 118];
        bytes[..2].copy_from_slice(b"BM");
        bytes[10..14].copy_from_slice(&118u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&320i32.to_le_bytes());
        bytes[22..26].copy_from_slice(&240i32.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&4u16.to_le_bytes());
        bytes[30..34].copy_from_slice(&2u32.to_le_bytes());
        bytes[46..50].copy_from_slice(&16u32.to_le_bytes());
        for _ in 0..240 {
            bytes.extend([255, 0x11, 65, 0x11, 0, 0]);
        }
        bytes.extend([0, 1]);
        let length = bytes.len() as u32;
        bytes[2..6].copy_from_slice(&length.to_le_bytes());
        bytes[34..38].copy_from_slice(&(length - 118).to_le_bytes());
        bytes
    }
    /// The same bitmap with its RLE stream cut short, as in a truncated download.
    fn truncated() -> Vec<u8> {
        let mut bytes = bitmap();
        bytes.truncate(bytes.len() - 57);
        bytes
    }
    fn story(screens: &[(&str, &str)]) -> Value {
        let stages: Vec<_> = screens
            .iter()
            .enumerate()
            .map(|(i, (name, image))| {
                serde_json::json!({"uuid": format!("s{i}"), "name": name, "image": image, "squareOne": i == 0})
            })
            .collect();
        serde_json::json!({"title": "T", "stageNodes": stages, "actionNodes": []})
    }
    fn damage(out: &Observation) -> Option<Value> {
        out.valid_field(&[DAMAGED_MEDIA]).cloned()
    }
    fn archive(story: &Value, files: &[(&str, Vec<u8>)], deflate: bool) -> Vec<u8> {
        let method = if deflate {
            zip::CompressionMethod::Deflated
        } else {
            zip::CompressionMethod::Stored
        };
        let options = zip::write::SimpleFileOptions::default().compression_method(method);
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("story.json", options).unwrap();
        w.write_all(story.to_string().as_bytes()).unwrap();
        for (name, bytes) in files {
            w.start_file(*name, options).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap().into_inner()
    }
    fn files() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("assets/good.bmp", bitmap()),
            ("assets/broken.bmp", truncated()),
        ]
    }
    fn observe(story: Value) -> Observation {
        let mut out = Observation::new("studioDirectory");
        out.raw = story;
        out
    }
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("story-studio-images-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("assets")).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_rule_flags_truncated_empty_and_garbage_files_only() {
        assert!(is_damaged(&truncated()));
        assert!(is_damaged(&[]));
        assert!(is_damaged(b"not a picture at all"));
        assert!(!is_damaged(&bitmap()));
    }
    #[test]
    fn a_directory_pack_publishes_its_first_damaged_picture_with_the_screen_name() {
        let s = Scratch::new();
        for (name, bytes) in files() {
            std::fs::write(s.0.join(name), bytes).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut out = observe(story(&[
            ("Accueil", "good.bmp"),
            ("La girafe", "broken.bmp"),
            ("Le lion", "broken.bmp"),
        ]));
        super::super::listening::directory(&mut out, &s.0, &cancel);
        assert_eq!(
            damage(&out),
            Some(serde_json::json!({"kind": "image", "screen": "La girafe"}))
        );
        assert!(!out.listening_incomplete);
        let published = serde_json::to_string(&out.fields).unwrap();
        assert!(!published.contains("broken") && !published.contains(s.0.to_str().unwrap()));
        // A sound-less, blank-named screen publishes the kind without a name.
        let mut out = observe(story(&[("  ", "broken.bmp")]));
        super::super::listening::directory(&mut out, &s.0, &cancel);
        assert_eq!(
            damage(&out),
            Some(serde_json::json!({"kind": "image", "screen": null}))
        );
        // A sound pack is never flagged; a missing picture is not "damaged".
        let mut out = observe(story(&[("A", "good.bmp"), ("B", "absent.bmp")]));
        super::super::listening::directory(&mut out, &s.0, &cancel);
        assert_eq!(damage(&out), None);
        // A picture outside `assets/` is never opened.
        let mut out = observe(story(&[("A", "../assets/broken.bmp")]));
        super::super::listening::directory(&mut out, &s.0, &cancel);
        assert_eq!(damage(&out), None);
    }
    #[test]
    fn a_zip_pack_is_judged_like_a_directory_pack_stored_or_deflated() {
        let document = story(&[("Accueil", "good.bmp"), ("L'ours", "broken.bmp")]);
        for deflate in [false, true] {
            let bytes = archive(&document, &files(), deflate);
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut out = observe(document.clone());
            super::super::listening::zip(&mut out, &mut zip, "", &AtomicBool::new(false));
            assert_eq!(
                damage(&out),
                Some(serde_json::json!({"kind": "image", "screen": "L'ours"}))
            );
            let healthy = story(&[("Accueil", "good.bmp")]);
            let bytes = archive(&healthy, &files(), deflate);
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut out = observe(healthy);
            super::super::listening::zip(&mut out, &mut zip, "", &AtomicBool::new(false));
            assert_eq!(damage(&out), None);
        }
    }
    #[test]
    fn a_streamed_zip_is_judged_like_a_seekable_one() {
        let document = story(&[("Accueil", "good.bmp"), ("L'ours", "broken.bmp")]);
        for deflate in [false, true] {
            let bytes = archive(&document, &files(), deflate);
            let observed = super::super::stream_zip::read(
                &mut Cursor::new(bytes),
                0,
                true,
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(
                damage(&observed[0]),
                Some(serde_json::json!({"kind": "image", "screen": "L'ours"}))
            );
            let healthy = story(&[("Accueil", "good.bmp")]);
            let bytes = archive(&healthy, &files(), deflate);
            let observed = super::super::stream_zip::read(
                &mut Cursor::new(bytes),
                0,
                true,
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(damage(&observed[0]), None);
        }
    }
    #[test]
    fn a_solid_archive_pass_publishes_the_damage_of_its_packs() {
        let s = Scratch::new();
        let payload = s.0.join("payload");
        std::fs::create_dir_all(payload.join("assets")).unwrap();
        let document = story(&[("Accueil", "good.bmp"), ("Le singe", "broken.bmp")]);
        std::fs::write(payload.join("story.json"), document.to_string()).unwrap();
        for (name, bytes) in files() {
            std::fs::write(payload.join(name), bytes).unwrap();
        }
        let archive = s.0.join("solid.7z");
        let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
        assert!(std::process::Command::new(tool)
            .args(["a", "-t7z", "-ms=on"])
            .arg(&archive)
            .args(["story.json", "assets"])
            .current_dir(&payload)
            .output()
            .unwrap()
            .status
            .success());
        let cancel = AtomicBool::new(false);
        let mut observed = super::super::analyze_with(&archive, &cancel, true).unwrap();
        assert_eq!(damage(&observed[0]), None, "not measured before the pass");
        super::super::enrich_7z(&archive, &mut observed, &cancel).unwrap();
        assert_eq!(
            damage(&observed[0]),
            Some(serde_json::json!({"kind": "image", "screen": "Le singe"}))
        );
    }
}
