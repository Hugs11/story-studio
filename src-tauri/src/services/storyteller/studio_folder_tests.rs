//! Direct STUdio folder path versus the converted archive. The oracle is the
//! archive chain as it stood before the direct path (`Route::Converted`, run in
//! the same test): the expected bytes are never derived from the direct code.
use super::*;
use crate::services::catalogue::open::target::{current_token, Observed};
use crate::services::official_packs::OfficialCatalogue;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

const UUID: &str = "00000000-0000-4000-8000-0000005ec0de";
const CHILD: &str = "00000000-0000-4000-8000-000000000002";

struct Fake;
impl OfficialCatalogue for Fake {
    type Error = UserMessage;
    fn contains_official(&self, uuid: &str) -> Result<bool> {
        Ok(crate::native_pack::output_identity::same(uuid, UUID))
    }
}

fn target(path: &Path) -> Target {
    Target {
        path: path.to_owned(),
        observation: Some(Observed {
            format: "studioDirectory".into(),
            state: "available".into(),
            token: current_token(path, Duration::from_secs(5)).unwrap(),
            raw: json!({"chain": []}),
        }),
    }
}

fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let name = path.strip_prefix(root).unwrap().to_string_lossy();
                out.insert(name.replace('\\', "/"), fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// A v6 metadata file with a fixed key: the encrypted copy is deterministic.
fn device(base: &Path) -> PathBuf {
    let root = base.join(format!("device-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut bytes = [0; 112];
    bytes[..2].copy_from_slice(&6u16.to_le_bytes());
    bytes[2..7].copy_from_slice(b"3.1.5");
    bytes[26..40].copy_from_slice(b"01234567890123");
    for (i, b) in bytes[64..96].iter_mut().enumerate() {
        *b = i as u8;
    }
    fs::write(root.join(".md"), bytes).unwrap();
    root
}

#[derive(Debug)]
struct Sent {
    total_bytes: u64,
    uuid: uuid::Uuid,
    plain: BTreeMap<String, Vec<u8>>,
    encrypted: BTreeMap<String, Vec<u8>>,
}

fn send(
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    route: Route,
    base: &Path,
) -> Result<Sent> {
    let cache = base.join(format!("cache-{}", uuid::Uuid::new_v4()));
    let output = Scratch::new(base).unwrap();
    let cancel = AtomicBool::new(false);
    let plain = write_catalogue_pack_with(target, catalogue, &output.0, &cache, &cancel, route)?;
    let encrypted_dir = Scratch::new(base).unwrap();
    let encrypted = cipher::DeviceCipher::from_metadata(&device(base))?.encrypt_story(
        &plain,
        &encrypted_dir.0,
        &cancel,
    )?;
    Ok(Sent {
        total_bytes: plain.total_bytes,
        uuid: plain.uuid,
        plain: tree(&plain.path),
        encrypted: tree(&encrypted.path),
    })
}

fn assert_same(converted: &Sent, direct: &Sent) {
    assert_eq!(converted.uuid, direct.uuid);
    assert_eq!(converted.total_bytes, direct.total_bytes);
    assert_eq!(
        converted.plain.keys().collect::<Vec<_>>(),
        direct.plain.keys().collect::<Vec<_>>()
    );
    for (name, bytes) in &converted.plain {
        assert!(direct.plain[name] == *bytes, "plain {name} differs");
    }
    assert_eq!(
        converted.encrypted.keys().collect::<Vec<_>>(),
        direct.encrypted.keys().collect::<Vec<_>>()
    );
    for (name, bytes) in &converted.encrypted {
        assert!(direct.encrypted[name] == *bytes, "encrypted {name} differs");
    }
}

fn ffmpeg_sine(path: &Path, rate: &str, channels: &str) {
    let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().expect("FFmpeg for media tests");
    let status = std::process::Command::new(ffmpeg)
        .args(["-v", "error", "-f", "lavfi", "-i"])
        .arg("sine=frequency=440:duration=0.3")
        .args(["-ar", rate, "-ac", channels, "-y"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}

fn story(entry_audio: &str, child_audio: &str) -> Value {
    json!({
        "title": "Fixture", "version": 1, "format": "v1",
        "uuid": UUID, "nightModeAvailable": false,
        "stageNodes": [
            {"uuid": UUID, "squareOne": true, "image": "cover.png", "audio": entry_audio,
             "controlSettings": {"wheel": false, "ok": true, "home": false, "pause": false, "autoplay": false},
             "okTransition": {"actionNode": "a", "optionIndex": -1}, "homeTransition": null},
            {"uuid": CHILD, "image": "assets/child.bmp", "audio": child_audio,
             "controlSettings": {"wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false},
             "okTransition": null, "homeTransition": null}],
        "actionNodes": [{"id": "a", "name": "Action node", "options": [CHILD]}]
    })
}

/// A STUdio folder as packs are found: stereo 48 kHz MP3, PNG to convert,
/// conforming BMP, nested asset folder, prefixed and bare references, unused
/// asset, thumbnail and files foreign to the pack at its root.
fn studio_folder(pack: &Path, story: &Value, pretty: bool) {
    fs::create_dir_all(pack.join("assets/sub")).unwrap();
    let text = if pretty {
        serde_json::to_string_pretty(story).unwrap()
    } else {
        serde_json::to_string(story).unwrap()
    };
    fs::write(pack.join("story.json"), text).unwrap();
    ffmpeg_sine(&pack.join("assets/sub/intro.mp3"), "48000", "2");
    ffmpeg_sine(&pack.join("assets/story.mp3"), "44100", "1");
    let cover = image::RgbImage::from_fn(641, 319, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 73])
    });
    cover.save(pack.join("assets/cover.png")).unwrap();
    fs::write(pack.join("assets/child.bmp"), super::tests::bitmap()).unwrap();
    fs::write(pack.join("assets/unused.ogg"), b"never read").unwrap();
    image::RgbImage::new(4, 4)
        .save(pack.join("thumbnail.png"))
        .unwrap();
    fs::write(pack.join("notes.txt"), b"foreign").unwrap();
    fs::write(pack.join("Gigi.zip"), b"not an archive").unwrap();
    fs::write(pack.join(".DS_Store"), b"\0\0").unwrap();
}

#[test]
fn studio_folder_send_is_byte_identical_to_the_converted_archive() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    // `official:false` makes the conversion rewrite story.json; the compact
    // variant is archived verbatim; the nested one is found below its parent.
    let mut rewritten = story("assets/sub/intro.mp3", "story.mp3");
    rewritten["official"] = json!(false);
    let cases = [
        ("rewritten", rewritten, true, false),
        (
            "verbatim",
            story("sub/intro.mp3", "story.mp3"),
            false,
            false,
        ),
        (
            "nested",
            story("assets/sub/intro.mp3", "story.mp3"),
            true,
            true,
        ),
    ];
    for (name, story, pretty, nested) in cases {
        let folder = base.0.join(name);
        let pack = if nested {
            folder.join("Pack")
        } else {
            folder.clone()
        };
        studio_folder(&pack, &story, pretty);
        if nested {
            fs::write(folder.join("readme.txt"), b"beside the pack").unwrap();
        }
        let target = target(&folder);
        // The direct route really reads this folder in place.
        let owned = Scratch::new(&base.0).unwrap();
        assert!(
            crate::services::catalogue::open::materialize::studio_folder_for_storyteller(
                &target,
                &owned.0,
                &AtomicBool::new(false),
                None,
            )
            .unwrap()
            .is_some(),
            "{name}"
        );
        let converted = send(&target, None, Route::Converted, &base.0).unwrap();
        let direct = send(&target, None, Route::DirectRequired, &base.0).unwrap();
        assert_same(&converted, &direct);
        assert_eq!(
            direct.plain.len(),
            2 + 2 + 2 + 2,
            "{name}: ni li ri si + 2 + 2"
        );
    }
}

#[test]
fn studio_folder_refusals_match_the_converted_archive() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let mut provenance = story("story.mp3", "story.mp3");
    provenance["officialProvenance"] = json!("official");
    let cases: [(&str, Value, bool, &str); 6] = [
        (
            "recognized",
            story("story.mp3", "story.mp3"),
            true,
            codes::STORYTELLER_OFFICIAL_REFUSED,
        ),
        (
            "provenance",
            provenance,
            false,
            codes::STORYTELLER_OFFICIAL_REFUSED,
        ),
        (
            "missing",
            story("missing.mp3", "story.mp3"),
            false,
            codes::IMPORT_ASSET_NOT_FOUND,
        ),
        // Archive names are compared exactly, whatever the volume's case rules.
        (
            "case",
            story("Story.MP3", "story.mp3"),
            false,
            codes::IMPORT_ASSET_NOT_FOUND,
        ),
        (
            "invalid-name",
            story("assets/../story.mp3", "story.mp3"),
            false,
            codes::IMPORT_INVALID_ASSET_NAME,
        ),
        (
            "backslash",
            story("sub\\intro.mp3", "story.mp3"),
            false,
            codes::IMPORT_INVALID_ASSET_NAME,
        ),
    ];
    for (name, story, recognized, code) in cases {
        let folder = base.0.join(name);
        studio_folder(&folder, &story, true);
        let target = target(&folder);
        let catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>> =
            if recognized { Some(&Fake) } else { None };
        let converted = send(&target, catalogue, Route::Converted, &base.0).unwrap_err();
        let direct = send(&target, catalogue, Route::DirectRequired, &base.0).unwrap_err();
        assert_eq!(converted.code, code, "{name}");
        assert_eq!(
            (direct.code, direct.params),
            (converted.code, converted.params)
        );
    }
}

/// A symbolic link inside `assets/` is refused by the tree validation, the same
/// way for both routes. `cfg(unix)`: creating symlinks needs no privilege there
/// (Windows requires developer mode or elevation).
#[cfg(unix)]
#[test]
fn a_linked_asset_is_refused_like_the_converted_archive() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let folder = base.0.join("linked");
    studio_folder(&folder, &story("story.mp3", "story.mp3"), true);
    fs::write(base.0.join("outside.mp3"), b"outside").unwrap();
    std::os::unix::fs::symlink(base.0.join("outside.mp3"), folder.join("assets/link.mp3")).unwrap();
    let target = target(&folder);
    let converted = send(&target, None, Route::Converted, &base.0).unwrap_err();
    let direct = send(&target, None, Route::DirectRequired, &base.0).unwrap_err();
    assert_eq!(
        (direct.code, direct.params),
        (converted.code, converted.params)
    );
}

/// The folder changes after its media were copied and before the check: the
/// send is refused, whatever the kind of change (same size, so only the byte
/// comparison with the copy, or the `story.json` text, can notice).
#[test]
fn a_folder_changed_before_the_check_is_refused() {
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    for (name, file) in [("media", "assets/story.mp3"), ("story", "story.json")] {
        let folder = base.0.join(name);
        studio_folder(&folder, &story("story.mp3", "story.mp3"), true);
        let target = target(&folder);
        let path = folder.join(file);
        BEFORE_VERIFY.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                let mut bytes = fs::read(&path).unwrap();
                let last = bytes.len() - 2;
                bytes[last] ^= 1;
                fs::write(&path, bytes).unwrap();
            }));
        });
        let error = send(&target, None, Route::DirectRequired, &base.0).unwrap_err();
        BEFORE_VERIFY.with(|hook| *hook.borrow_mut() = None);
        assert_eq!(
            error.code,
            codes::IMPORT_CONVERSION_FOLDER_CHANGED,
            "{name}"
        );
    }
}

#[test]
fn a_filesystem_folder_declared_studio_keeps_the_converted_archive() {
    // The folder's pack is not a STUdio one: the direct path declines it.
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    let folder = base.0.join("fs");
    fs::create_dir(&folder).unwrap();
    for name in ["ni", "li", "ri", "si"] {
        fs::write(folder.join(name), [0; 4]).unwrap();
    }
    for name in ["rf", "sf"] {
        fs::create_dir(folder.join(name)).unwrap();
    }
    let scratch = Scratch::new(&base.0).unwrap();
    assert!(
        crate::services::catalogue::open::materialize::studio_folder_for_storyteller(
            &target(&folder),
            &scratch.0,
            &AtomicBool::new(false),
            None,
        )
        .unwrap()
        .is_none()
    );
}

/// Measurement and equivalence on real STUdio folders, outside the CI:
/// `STORY_STUDIO_SEND_FOLDERS="<dossier>[:<dossier>…]"` (path list separator
/// of the platform), e.g. « Gigi et Pipo » and « Robin des Bois ». Each folder
/// is sent through both routes, alternately, and must give the same bytes.
/// A release build only finds FFmpeg in the resource folder: name it with
/// `STORY_STUDIO_SEND_RESOURCE_DIR` (e.g. `src-tauri/tools/linux-x86_64`).
#[test]
#[ignore = "real STUdio folders named by STORY_STUDIO_SEND_FOLDERS"]
fn real_studio_folders_send_identically() {
    let folders = std::env::var_os("STORY_STUDIO_SEND_FOLDERS").expect("STORY_STUDIO_SEND_FOLDERS");
    if let Some(resources) = std::env::var_os("STORY_STUDIO_SEND_RESOURCE_DIR") {
        crate::support::tool_resolver::initialize_resource_dir(resources.into());
    }
    let base = Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap();
    for folder in std::env::split_paths(&folders) {
        let target = target(&folder);
        let mut sent = Vec::new();
        for (round, route) in [
            Route::Converted,
            Route::Direct,
            Route::Converted,
            Route::Direct,
        ]
        .into_iter()
        .enumerate()
        {
            let cache = base.0.join(format!("cache-{round}"));
            let output = Scratch::new(&base.0).unwrap();
            let cancel = AtomicBool::new(false);
            let start = Instant::now();
            target.require_unchanged(Duration::from_secs(5)).unwrap();
            fs::create_dir_all(&cache).unwrap();
            let scratch = Scratch::new(&cache).unwrap();
            let (authorized, bindings) = match route {
                Route::Direct | Route::DirectRequired => read_studio_folder(
                    crate::services::catalogue::open::materialize::studio_folder_for_storyteller(
                        &target, &scratch.0, &cancel, None,
                    )
                    .unwrap()
                    .expect("STUdio folder"),
                    None,
                    &scratch.0,
                    &cancel,
                ),
                Route::Converted => read_converted(&target, None, &scratch.0, &cancel),
            }
            .unwrap();
            target.require_unchanged(Duration::from_secs(5)).unwrap();
            let read = start.elapsed();
            let plain =
                write_plain_story(&authorized, &bindings, &output.0, &cache, &cancel).unwrap();
            let total = start.elapsed();
            println!(
                "[T] {} {:?}: lecture source {:.3} s, préparation totale {:.3} s",
                folder.file_name().unwrap().to_string_lossy(),
                if route == Route::Direct {
                    "direct"
                } else {
                    "zip"
                },
                read.as_secs_f64(),
                total.as_secs_f64()
            );
            let encrypted_dir = Scratch::new(&base.0).unwrap();
            let encrypted = cipher::DeviceCipher::from_metadata(&device(&base.0))
                .unwrap()
                .encrypt_story(&plain, &encrypted_dir.0, &cancel)
                .unwrap();
            sent.push(Sent {
                total_bytes: plain.total_bytes,
                uuid: plain.uuid,
                plain: tree(&plain.path),
                encrypted: tree(&encrypted.path),
            });
        }
        for direct in &sent[1..] {
            assert_same(&sent[0], direct);
        }
    }
}
