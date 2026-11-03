//! Listening statistics are observations of stories, never metadata declarations.
//!
//! `LISTENING_VERSION` versions everything that produces them: the story
//! classification (`pack_reader::story_audio`, `fs_pack_reader::listening_document`),
//! the header readers (`support::audio_duration`) and this module. Bump it when
//! any of them changes its result, so stored values are measured again. The
//! picture decoding of `images` is one of them (5: damaged pictures).
use super::*;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::AtomicBool;

pub(crate) const LISTENING_VERSION: u8 = 5;

pub(super) fn stories(raw: &Value) -> Option<Vec<(String, String)>> {
    let document = serde_json::from_value::<crate::native_pack::StoryDocument>(raw.clone()).ok()?;
    crate::services::pack_reader::story_audio(&document)
}
pub(super) fn record(out: &mut Observation, count: usize, duration: Option<f64>) {
    for (key, value) in [
        ("storyCount", Some(serde_json::json!(count))),
        (
            "durationSeconds",
            duration
                .filter(|s| s.is_finite() && *s > 0.0)
                .map(|s| serde_json::json!(s)),
        ),
    ] {
        if let Some(value) = value {
            out.fields.insert(
                format!("/packMetadata/{key}"),
                ObservedField {
                    presence: "present".into(),
                    raw_value: Some(value),
                    validity: "valid".into(),
                    source: "storyClassification+audioHeaders:v1".into(),
                },
            );
        }
    }
}
/// Exact name first, then the ASCII case-insensitive match used for device
/// packs inside archives (`fs_zip`, `fs_pack_reader::resolve_fs_path`).
pub(super) fn get_ignore_case<'a, V>(map: &'a HashMap<String, V>, key: &str) -> Option<&'a V> {
    map.get(key).or_else(|| {
        map.iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value)
    })
}
/// Only regular files are opened: a FIFO, a device or a directory named by a
/// pack would block or never end.
pub(super) fn open_regular(path: &Path) -> Option<(std::fs::File, u64)> {
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    metadata.is_file().then_some((file, metadata.len()))
}
fn seekable_file(path: &Path, cancel: &AtomicBool) -> Option<f64> {
    let (file, size) = open_regular(path)?;
    crate::support::audio_duration::seekable(file, size, cancel)
}
/// A STUdio asset name stays inside `assets/`: plain components only.
pub(super) fn confined_asset(root: &Path, name: &str) -> Option<std::path::PathBuf> {
    let relative = Path::new(name);
    let plain = !name.is_empty()
        && relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
    plain.then(|| root.join("assets").join(relative))
}
pub(super) fn dependency_stamps(paths: &[String]) -> Vec<Option<(u64, std::time::SystemTime)>> {
    paths
        .iter()
        .map(|p| {
            std::fs::metadata(p)
                .ok()
                .and_then(|m| Some((m.len(), m.modified().ok()?)))
        })
        .collect()
}
pub(super) fn directory(out: &mut Observation, root: &Path, cancel: &AtomicBool) {
    directory_sounds(out, root, cancel);
    super::images::directory(out, root, cancel);
}
fn directory_sounds(out: &mut Observation, root: &Path, cancel: &AtomicBool) {
    let Some(stories) = stories(&out.raw) else {
        return;
    };
    let sounds: BTreeSet<_> = stories.iter().map(|(_, a)| a.as_str()).collect();
    // A sound outside `assets/` is never opened: the pack keeps its count,
    // without a duration.
    let paths: Option<Vec<_>> = sounds.iter().map(|a| confined_asset(root, a)).collect();
    let Some(paths) = paths else {
        record(out, stories.len(), None);
        return;
    };
    out.listening_dependencies = paths
        .iter()
        .map(crate::support::paths::path_for_frontend)
        .collect();
    let before = dependency_stamps(&out.listening_dependencies);
    let duration = paths
        .iter()
        .try_fold(0.0, |total, p| Some(total + seekable_file(p, cancel)?));
    record(out, stories.len(), duration);
    if before != dependency_stamps(&out.listening_dependencies[..before.len()]) {
        out.listening_incomplete = true;
    }
}
pub(super) fn zip<R: Read + std::io::Seek>(
    out: &mut Observation,
    archive: &mut zip::ZipArchive<R>,
    root: &str,
    cancel: &AtomicBool,
) {
    zip_sounds(out, archive, root, cancel);
    super::images::zip(out, archive, root, cancel);
}
fn zip_sounds<R: Read + std::io::Seek>(
    out: &mut Observation,
    archive: &mut zip::ZipArchive<R>,
    root: &str,
    cancel: &AtomicBool,
) {
    let Some(stories) = stories(&out.raw) else {
        return;
    };
    let sounds: BTreeSet<_> = stories.iter().map(|(_, a)| a.as_str()).collect();
    let duration = sounds.into_iter().try_fold(0.0, |total, a| {
        let name = format!("{root}assets/{a}");
        let entry = archive.by_name(&name).ok()?;
        let size = entry.size();
        let stored = entry.compression() == zip::CompressionMethod::Stored;
        drop(entry);
        let seconds = if stored {
            crate::support::audio_duration::seekable(
                archive.by_name_seek(&name).ok()?,
                size,
                cancel,
            )
        } else {
            crate::support::audio_duration::duration(
                archive.by_name(&name).ok()?,
                size,
                None,
                cancel,
            )
        }?;
        Some(total + seconds)
    });
    record(out, stories.len(), duration);
}
/// Stories reached through the menu tree; detached shared entries are excluded,
/// and a duplicate id anywhere leaves the project without a value.
fn menu_stories(raw: &Value) -> Option<Vec<(String, String, bool)>> {
    fn index<'a>(entries: &'a [Value], map: &mut HashMap<&'a str, &'a Value>) -> Option<()> {
        for e in entries {
            let id = e["id"].as_str()?;
            if map.insert(id, e).is_some() {
                return None;
            }
            if let Some(c) = e["children"].as_array() {
                index(c, map)?;
            }
        }
        Some(())
    }
    fn visit(
        e: &Value,
        active: &mut HashSet<String>,
        done: &mut HashSet<String>,
        result: &mut Vec<(String, String, bool)>,
    ) -> Option<()> {
        let id = e["id"].as_str()?;
        if active.contains(id) {
            return None;
        }
        if !done.insert(id.into()) {
            return Some(());
        }
        active.insert(id.into());
        match e["type"].as_str()? {
            "story" => result.push((id.into(), e["audio"].as_str().unwrap_or("").into(), false)),
            // An imported ZIP not yet chosen is not playable: ignored.
            "zip" => {
                if let Some(path) = e["zipPath"].as_str().filter(|p| !p.is_empty()) {
                    result.push((id.into(), path.into(), true));
                }
            }
            "menu" => {
                for c in e["children"].as_array()? {
                    visit(c, active, done, result)?;
                }
            }
            // Any other type (an old link node, an unknown type) leaves the
            // project without a value.
            _ => return None,
        }
        active.remove(id);
        Some(())
    }
    let roots = raw["rootEntries"].as_array()?;
    let shared = raw["sharedEntries"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut map = HashMap::new();
    index(roots, &mut map)?;
    index(shared, &mut map)?;
    let mut result = Vec::new();
    let mut done = HashSet::new();
    for e in roots {
        visit(e, &mut HashSet::new(), &mut done, &mut result)?;
    }
    (!result.is_empty()).then_some(result)
}
pub(super) fn project(
    out: &mut Observation,
    path: &Path,
    payload: Option<&Value>,
    cancel: &AtomicBool,
) {
    let selected = if let Some(payload) = payload {
        stories(&payload["document"]).map(|stories| {
            stories
                .into_iter()
                .map(|(id, a)| (id, a, false))
                .collect::<Vec<_>>()
        })
    } else {
        menu_stories(&out.raw)
    };
    let Some(stories) = selected else {
        return;
    };
    let mut paths = std::collections::BTreeMap::new();
    let mut resolved = true;
    for (_, audio, zip) in &stories {
        if audio.is_empty() {
            resolved = false;
            continue;
        }
        let reference = if payload.is_some() {
            out.raw
                .pointer("/authoring/mediaBindings")
                .and_then(Value::as_array)
                .and_then(|bs| {
                    bs.iter()
                        .find(|b| b["assetRef"] == *audio && b["status"] == "resolved")
                })
                .and_then(|b| b["path"].as_str())
        } else {
            Some(audio.as_str())
        };
        if let Some(reference) = reference {
            let p = Path::new(reference);
            paths.insert(
                if p.is_absolute() {
                    p.to_owned()
                } else {
                    path.parent().unwrap_or(Path::new(".")).join(p)
                },
                *zip,
            );
        } else {
            resolved = false;
        }
    }
    out.listening_dependencies = paths
        .keys()
        .map(crate::support::paths::path_for_frontend)
        .collect();
    let before = dependency_stamps(&out.listening_dependencies);
    let mut count = stories.iter().filter(|(_, _, zip)| !zip).count();
    let mut total = 0.0;
    for (p, zip) in paths {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        if zip {
            let regular_zip = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"))
                && std::fs::metadata(&p).is_ok_and(|m| m.is_file());
            if !p.is_dir() && !regular_zip {
                return;
            }
            let Some(children) = super::analyze_with(&p, cancel, true).ok() else {
                return;
            };
            for child in children {
                // Nested packs contribute their measured stories, never +1.
                let Some(n) = child
                    .valid_field(&["/packMetadata/storyCount"])
                    .and_then(Value::as_u64)
                else {
                    return;
                };
                count += n as usize;
                if let Some(d) = child
                    .valid_field(&["/packMetadata/durationSeconds"])
                    .and_then(Value::as_f64)
                {
                    total += d;
                } else {
                    resolved = false;
                }
                out.listening_incomplete |= child.listening_incomplete;
                out.listening_dependencies
                    .extend(child.listening_dependencies);
            }
        } else {
            // Absolute project paths are legitimate; only regular files open.
            let duration = seekable_file(&p, cancel);
            if let Some(duration) = duration {
                total += duration;
            } else {
                resolved = false;
            }
        }
    }
    record(out, count, resolved.then_some(total));
    if before != dependency_stamps(&out.listening_dependencies[..before.len()]) {
        out.listening_incomplete = true;
    }
}

pub(super) fn fs(
    out: &mut Observation,
    variant: crate::support::fs_pack_reader::FsPackVariant,
    cleartext: bool,
    mut read: impl FnMut(&str, u64) -> Result<(Vec<u8>, u64), String>,
    cancel: &AtomicBool,
    mut audio: impl FnMut(&str, crate::support::fs_pack_reader::FsPackVariant) -> Option<f64>,
) {
    use crate::support::fs_pack_reader as fs;
    let suffix = if variant == fs::FsPackVariant::Plain {
        ".plain"
    } else {
        ""
    };
    let limit = JSON_LIMIT;
    let document = (|| {
        let ni = read("ni", limit)?.0;
        let ri = read(&format!("ri{suffix}"), limit)?.0;
        let si = read(&format!("si{suffix}"), limit)?.0;
        let li = read(&format!("li{suffix}"), limit)?.0;
        fs::listening_document(&ni, &ri, &si, &li, variant, cleartext)
            .ok_or_else(|| "unknownStories".to_owned())
    })();
    let Ok((document, variant)) = document else {
        return;
    };
    let Some(stories) = crate::services::pack_reader::story_audio(&document) else {
        return;
    };
    let sounds: BTreeSet<_> = stories.iter().map(|(_, a)| a.as_str()).collect();
    let mut duration = Some(0.0);
    // Visit every locator even when one sound is missing: directory dependency
    // fingerprints must include all the referenced sounds.
    for name in sounds {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            duration = None;
            break;
        }
        let seconds = audio(name, variant);
        duration = duration.and_then(|total| seconds.map(|seconds| total + seconds));
    }
    record(out, stories.len(), duration);
}

pub(super) fn fs_zip<R: Read + std::io::Seek>(
    out: &mut Observation,
    archive: &mut zip::ZipArchive<R>,
    cancel: &AtomicBool,
) {
    use crate::support::{audio_duration as audio, fs_pack_reader as fs};
    let Some(variant) = out.raw["variant"]
        .as_str()
        .and_then(fs::FsPackVariant::from_preview_name)
    else {
        return;
    };
    let root = out
        .member
        .as_ref()
        .map(|m| format!("{m}/"))
        .unwrap_or_default();
    let names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
    let resolve = |name: &str| {
        names
            .iter()
            .find(|n| n.eq_ignore_ascii_case(&format!("{root}{name}")))
            .cloned()
    };
    let cell = std::cell::RefCell::new(archive);
    fs(
        out,
        variant,
        resolve(".cleartext").is_some(),
        |name, limit| {
            let name = resolve(name).ok_or("invalidPackStructure")?;
            let mut archive = cell.borrow_mut();
            let entry = archive.by_name(&name).map_err(|e| e.to_string())?;
            let size = entry.size();
            let mut bytes = Vec::new();
            entry
                .take(limit)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            Ok((bytes, size))
        },
        cancel,
        |name, variant| {
            let name = resolve(name)?;
            let mut archive = cell.borrow_mut();
            let entry = archive.by_name(&name).ok()?;
            let size = entry.size();
            let stored = entry.compression() == zip::CompressionMethod::Stored;
            drop(entry);
            if stored {
                let reader =
                    audio::FsAudio::new(archive.by_name_seek(&name).ok()?, variant, size).ok()?;
                audio::seekable(reader, size, cancel)
            } else {
                audio::fs_stream(archive.by_name(&name).ok()?, variant, size, cancel)
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("story-studio-listening-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn two_stories(first: &str, second: &str) -> Value {
        serde_json::json!({"stageNodes":[
            {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"choice","optionIndex":0}},
            {"uuid":"a","audio":first,"controlSettings":{"pause":true}},
            {"uuid":"b","audio":second,"controlSettings":{"pause":true}}
        ],"actionNodes":[{"id":"choice","options":["a","b"]}]})
    }
    fn sound(path: &Path) {
        let mut b = vec![0; 16000];
        b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        std::fs::write(path, b).unwrap();
    }
    #[test]
    fn directory_sounds_stay_inside_assets_and_must_be_regular_files() {
        let s = Scratch::new();
        let pack = s.0.join("pack");
        std::fs::create_dir_all(pack.join("assets/folder.mp3")).unwrap();
        sound(&pack.join("assets/a.mp3"));
        sound(&s.0.join("outside.mp3"));
        let cancel = AtomicBool::new(false);
        let measure = |document: Value| {
            let mut out = Observation::new("directory");
            out.raw = document;
            directory(&mut out, &pack, &cancel);
            (
                out.valid_field(&["/packMetadata/storyCount"]).cloned(),
                out.valid_field(&["/packMetadata/durationSeconds"]).cloned(),
                out.listening_dependencies,
            )
        };
        let (count, duration, _) = measure(two_stories("a.mp3", "a.mp3"));
        assert_eq!(count, Some(serde_json::json!(2)));
        assert_eq!(duration, Some(serde_json::json!(1.0)));
        let outside = s.0.join("outside.mp3").to_string_lossy().into_owned();
        for escaping in ["../outside.mp3", outside.as_str()] {
            let (count, duration, dependencies) = measure(two_stories("a.mp3", escaping));
            assert_eq!(count, Some(serde_json::json!(2)), "{escaping}");
            assert_eq!(duration, None, "{escaping} is never opened");
            assert!(dependencies.is_empty());
        }
        let (count, duration, _) = measure(two_stories("a.mp3", "folder.mp3"));
        assert_eq!(count, Some(serde_json::json!(2)));
        assert_eq!(duration, None, "a directory is not a sound");
    }
    #[test]
    fn project_duration_adds_flac_and_mp3_sounds() {
        let s = Scratch::new();
        sound(&s.0.join("b.mp3"));
        // FLAC STREAMINFO: 3 s at 8 kHz, behind an empty ID3v2 tag.
        let mut flac = b"ID3\x04\x00\x00\x00\x00\x00\x00fLaC\x80\x00\x00\x22".to_vec();
        let mut info = [0u8; 34];
        info[10..18].copy_from_slice(&((8000u64 << 44) | (15 << 36) | 24000).to_be_bytes());
        flac.extend(info);
        flac.resize(2048, 0);
        std::fs::write(s.0.join("a.flac"), flac).unwrap();
        let mut out = Observation::new("project");
        out.raw = serde_json::json!({"authoring": {"mediaBindings": [
            {"assetRef": "asset-a", "status": "resolved", "path": "a.flac"},
            {"assetRef": "asset-b", "status": "resolved", "path": "b.mp3"}
        ]}});
        let payload = serde_json::json!({"document": two_stories("asset-a", "asset-b")});
        project(
            &mut out,
            &s.0.join("story.json"),
            Some(&payload),
            &AtomicBool::new(false),
        );
        assert_eq!(
            out.valid_field(&["/packMetadata/storyCount"]),
            Some(&serde_json::json!(2))
        );
        assert_eq!(
            out.valid_field(&["/packMetadata/durationSeconds"]),
            Some(&serde_json::json!(4.0))
        );
    }
    #[test]
    fn failed_solid_archive_child_never_waits_for_a_listening_pass() {
        let s = Scratch::new();
        std::fs::write(s.0.join("bad.zip"), b"not an archive").unwrap();
        let archive = s.0.join("collection.7z");
        let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
        assert!(std::process::Command::new(tool)
            .args(["a", "-t7z"])
            .arg(&archive)
            .arg("bad.zip")
            .current_dir(&s.0)
            .output()
            .unwrap()
            .status
            .success());
        let observed = super::super::analyze_with(&archive, &AtomicBool::new(false), true).unwrap();
        assert_eq!(observed.len(), 1);
        assert_ne!(observed[0].state, "available");
        assert!(
            !observed[0].listening_pending,
            "a failure never schedules a full extraction"
        );
    }
    #[test]
    #[ignore = "read-only local corpus; set STORY_STUDIO_CORPUS and STORY_STUDIO_REPORT"]
    fn corpus() {
        fn walk(p: &Path, files: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(p).unwrap() {
                let p = entry.unwrap().path();
                if p.is_dir() {
                    walk(&p, files)
                } else if p.extension().is_some_and(|x| x == "zip" || x == "7z") {
                    files.push(p)
                }
            }
        }
        let mut files = Vec::new();
        walk(
            Path::new(&std::env::var("STORY_STUDIO_CORPUS").unwrap()),
            &mut files,
        );
        files.sort();
        let cancel = AtomicBool::new(false);
        let mut report = Vec::new();
        for p in files {
            match super::super::analyze_with(&p, &cancel, true) {
                Ok(mut observations) => {
                    if p.extension().is_some_and(|x| x == "7z") {
                        let _ = super::super::enrich_7z(&p, &mut observations, &cancel);
                    }
                    for o in observations {
                        report.push(serde_json::json!({"path":p,"member":o.member,"format":o.format,"state":o.state,"sounds":stories(&o.raw).map(|s|s.into_iter().map(|(_,a)|a).collect::<Vec<_>>()),"storyCount":o.valid_field(&["/packMetadata/storyCount"]),"durationSeconds":o.valid_field(&["/packMetadata/durationSeconds"])}));
                    }
                }
                Err(e) => report.push(serde_json::json!({"path":p,"error":e})),
            }
        }
        std::fs::write(
            std::env::var("STORY_STUDIO_REPORT").unwrap(),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
    }
}
