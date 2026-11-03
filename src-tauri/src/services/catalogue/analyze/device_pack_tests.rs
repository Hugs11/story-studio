//! Device packs met outside a plain folder or ZIP: inside a 7z, stored in
//! clear (`.cleartext`), or enciphered with an unknown key. Fixtures are built
//! from the shared reader fixtures and the bundled 7z tool, never from the
//! analyzer under test; expected bytes are the ones written to the fixture.
use crate::services::catalogue::open::{
    materialize,
    target::{Observed, Target},
};
use crate::support::fs_pack_reader::fs_fixtures::{
    encipher_common_key, write_cleartext_pack, write_encrypted_cover_pack, write_unknown_key_pack,
    CLEARTEXT_AUDIO, CLEARTEXT_IMAGE,
};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

const PACK_ID: &str = "94617264-6ffc-4884-96ff-1634b06a2f83";

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("catalogue-device-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `7z a` of `members` (relative to `folder`), as an external tool would.
fn seven_zip(archive: &Path, folder: &Path, members: &[&str]) {
    let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
    let output = std::process::Command::new(tool)
        .arg("a")
        .arg("-t7z")
        .arg(archive)
        .args(members)
        .current_dir(folder)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn zip_folder(archive: &Path, folder: &Path) {
    fn walk(root: &Path, dir: &Path, zip: &mut zip::ZipWriter<std::fs::File>) {
        let mut entries = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            if path.is_dir() {
                zip.add_directory(format!("{name}/"), zip::write::SimpleFileOptions::default())
                    .unwrap();
                walk(root, &path, zip);
            } else {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(&std::fs::read(&path).unwrap()).unwrap();
            }
        }
    }
    let mut zip = zip::ZipWriter::new(std::fs::File::create(archive).unwrap());
    walk(folder.parent().unwrap(), folder, &mut zip);
    zip.finish().unwrap();
}

fn analyze(path: &Path) -> Vec<super::Observation> {
    super::analyze(path, &AtomicBool::new(false)).unwrap()
}

fn cover(path: &Path, observation: &super::Observation) -> Vec<u8> {
    super::read_cover(
        &serde_json::json!({"path": path}),
        &serde_json::to_value(observation).unwrap(),
        1024 * 1024,
    )
    .unwrap()
}

fn converted_assets(zip_path: &Path) -> (serde_json::Value, Vec<Vec<u8>>) {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(zip_path).unwrap()).unwrap();
    let story = serde_json::from_reader(archive.by_name("story.json").unwrap()).unwrap();
    let mut assets = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if entry.name().starts_with("assets/") {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assets.push(bytes);
        }
    }
    (story, assets)
}

#[test]
fn seven_zip_device_pack_is_indexed_its_cover_read_and_materialized() {
    let image = b"BMseven-zip-device-image".to_vec();
    for cleartext in [false, true] {
        let scratch = Scratch::new();
        let tree = scratch.0.join("tree");
        if cleartext {
            write_cleartext_pack(&tree.join(PACK_ID), true);
        } else {
            write_encrypted_cover_pack(&tree.join(PACK_ID), &image);
        }
        let expected_image = if cleartext {
            CLEARTEXT_IMAGE.to_vec()
        } else {
            image.clone()
        };
        let archive = scratch.0.join("3+ Les Histoires.7z");
        seven_zip(&archive, &tree, &[PACK_ID]);
        let before = std::fs::read(&archive).unwrap();

        let values = analyze(&archive);
        assert_eq!(values.len(), 1);
        let out = &values[0];
        assert_eq!(out.state, "available", "{:?}", out.diagnostics);
        assert_eq!(out.format, "7z");
        assert_eq!(out.uuid(), Some(PACK_ID));
        assert_eq!(out.member.as_deref(), Some(PACK_ID));
        assert_eq!(out.chain[0].kind, "pack-root");
        assert_eq!(
            out.raw["variant"],
            if cleartext { "cleartext" } else { "encrypted" }
        );
        let observation = serde_json::to_value(out).unwrap();
        assert!(super::is_device_pack("7z", &observation));
        assert_eq!(cover(&archive, out), expected_image);

        let owned = scratch.0.join("owned");
        std::fs::create_dir_all(&owned).unwrap();
        let zip = materialize::pack_zip(
            &Target {
                path: archive.clone(),
                observation: Some(Observed {
                    format: out.format.clone(),
                    state: out.state.clone(),
                    token: String::new(),
                    raw: observation,
                }),
            },
            &owned,
            &AtomicBool::new(false),
            None,
        )
        .unwrap();
        let (story, assets) = converted_assets(&zip);
        assert_eq!(story["uuid"], PACK_ID);
        assert!(assets.contains(&expected_image));
        if cleartext {
            assert!(assets.iter().any(|a| a == CLEARTEXT_AUDIO));
        }
        assert_eq!(std::fs::read(&archive).unwrap(), before);
    }
}

#[test]
fn rootless_seven_zip_device_pack_has_no_invented_identity() {
    let scratch = Scratch::new();
    let tree = scratch.0.join("tree");
    let image = b"BMrootless-device-image".to_vec();
    write_encrypted_cover_pack(&tree, &image);
    let archive = scratch.0.join("rootless.7z");
    seven_zip(&archive, &tree, &["ni", "ri", "si", "li", "rf", "sf"]);
    let values = analyze(&archive);
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].state, "available");
    assert!(values[0].identity.is_none());
    assert!(values[0].chain.is_empty());
    assert!(super::is_device_pack(
        "7z",
        &serde_json::to_value(&values[0]).unwrap()
    ));
    assert_eq!(cover(&archive, &values[0]), image);
}

#[test]
fn seven_zip_studio_pack_is_never_taken_for_a_device_pack() {
    let scratch = Scratch::new();
    let tree = scratch.0.join("tree");
    std::fs::create_dir_all(&tree).unwrap();
    // A story that happens to carry a `variant` field stays a STUdio pack.
    std::fs::write(
        tree.join("story.json"),
        serde_json::json!({"title":"Studio","variant":"encrypted",
            "stageNodes":[{"uuid":PACK_ID,"squareOne":true}]})
        .to_string(),
    )
    .unwrap();
    let archive = scratch.0.join("studio.7z");
    seven_zip(&archive, &tree, &["story.json"]);
    let values = analyze(&archive);
    assert_eq!(values[0].state, "available");
    assert!(!super::is_device_pack(
        "7z",
        &serde_json::to_value(&values[0]).unwrap()
    ));
}

#[test]
fn cleartext_device_zip_and_folder_are_indexed_without_deciphering() {
    let scratch = Scratch::new();
    let folder = scratch.0.join("Pack15").join(PACK_ID);
    write_cleartext_pack(&folder, true);
    let archive = scratch.0.join("3+ Clear.zip");
    zip_folder(&archive, &folder);
    for (path, format) in [(&archive, "fsZip"), (&folder, "fsDirectory")] {
        let values = analyze(path);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].format, format);
        assert_eq!(values[0].state, "available", "{:?}", values[0].diagnostics);
        assert_eq!(values[0].raw["variant"], "cleartext");
        assert_eq!(cover(path, &values[0]), CLEARTEXT_IMAGE);
        // A wrong deciphering would have changed the image.
        assert_ne!(encipher_common_key(CLEARTEXT_IMAGE), CLEARTEXT_IMAGE);
    }
}

#[test]
fn unknown_key_device_zip_and_seven_zip_have_their_own_refusal_motif() {
    let scratch = Scratch::new();
    let tree = scratch.0.join("tree");
    write_unknown_key_pack(&tree.join(PACK_ID), true);
    let archive = scratch.0.join("Locked.zip");
    zip_folder(&archive, &tree.join(PACK_ID));
    let seven = scratch.0.join("Locked.7z");
    seven_zip(&seven, &tree, &[PACK_ID]);
    for path in [&archive, &seven] {
        let values = analyze(path);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].state, "encryptedUnknownKey");
        assert!(values[0].diagnostics[0].contains("IMPORT_FS_ENCRYPTED_UNKNOWN_KEY"));
        assert_eq!(
            crate::services::catalogue::grouping::failure_outcome(&values[0].state),
            "refused"
        );
    }
}

/// Manual measure on a real collection, read only: every archive and pack
/// folder under `STORY_STUDIO_SCAN_CORPUS` is analysed and the refusals are
/// listed by motif. Nothing is written in the collection.
#[test]
#[ignore = "requires STORY_STUDIO_SCAN_CORPUS"]
fn corpus_refusals_by_motif() {
    let root = PathBuf::from(std::env::var("STORY_STUDIO_SCAN_CORPUS").unwrap());
    let mut stack = vec![root];
    let mut refusals = std::collections::BTreeMap::<String, Vec<String>>::new();
    let (mut items, mut available) = (0, 0);
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let candidate = if path.is_dir() {
                if path.join("story.json").is_file()
                    || crate::support::fs_pack_reader::detect_fs_pack_variant(&path).is_some()
                {
                    true
                } else {
                    stack.push(path.clone());
                    false
                }
            } else {
                path.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("zip") || e.eq_ignore_ascii_case("7z"))
            };
            if !candidate {
                continue;
            }
            let observations = match super::analyze(&path, &AtomicBool::new(false)) {
                Ok(values) => values,
                Err(reason) => vec![super::Observation::failure("?", reason, None)],
            };
            for observation in observations {
                items += 1;
                if observation.state == "available" {
                    available += 1;
                } else {
                    refusals
                        .entry(observation.state.clone())
                        .or_default()
                        .push(format!(
                            "{}{}",
                            path.display(),
                            observation
                                .member
                                .map(|m| format!(" :: {m}"))
                                .unwrap_or_default()
                        ));
                }
            }
        }
    }
    println!("items={items} available={available}");
    for (motif, paths) in refusals {
        println!("{motif}: {}", paths.len());
        for path in paths {
            println!("  {path}");
        }
    }
}

#[test]
fn official_ok_false_stories_skip_ok_prompts_in_all_containers() {
    let scratch = Scratch::new();
    let folder = scratch.0.join(PACK_ID);
    write_cleartext_pack(&folder, false);
    // Official convention: stories are ok=false; the pausable introduction,
    // menu and looping game prompt accept OK. Root -> introduction -> menu ->
    // two stories and the game prompt. All indexes and media are synthetic.
    let mut ni = vec![0u8; 512 + 6 * 44];
    ni[2..4].copy_from_slice(&1i16.to_le_bytes());
    ni[8..12].copy_from_slice(&44u32.to_le_bytes());
    ni[12..16].copy_from_slice(&6u32.to_le_bytes());
    let mut si = Vec::new();
    for (i, (offset, count, flags)) in [
        (0i32, 1i32, [1u16, 1, 0, 0, 0]),
        (1, 1, [0, 1, 1, 1, 1]),
        (2, 3, [0, 1, 1, 1, 1]),
        (-1, -1, [0, 0, 1, 1, 1]),
        (-1, -1, [0, 0, 1, 1, 1]),
        (5, 1, [0, 1, 1, 1, 1]),
    ]
    .into_iter()
    .enumerate()
    {
        let node = &mut ni[512 + i * 44..512 + (i + 1) * 44];
        for (at, value) in [
            (0, -1),
            (4, i as i32),
            (8, offset),
            (12, count),
            (16, 0),
            (20, -1),
            (24, -1),
            (28, -1),
        ] {
            node[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (j, flag) in flags.into_iter().enumerate() {
            node[32 + j * 2..34 + j * 2].copy_from_slice(&flag.to_le_bytes());
        }
        let name = format!("000\\{i:08}");
        si.extend_from_slice(name.as_bytes());
        let seconds = if i == 3 {
            2
        } else if i == 4 {
            3
        } else {
            1
        };
        let mut sound = vec![0; seconds * 16000];
        sound[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        std::fs::write(
            folder.join("sf/000").join(format!("{i:08}")),
            encipher_common_key(&sound),
        )
        .unwrap();
    }
    std::fs::write(folder.join("ni"), ni).unwrap();
    std::fs::write(folder.join("si"), encipher_common_key(&si)).unwrap();
    let li: Vec<_> = [1u32, 2, 3, 4, 5, 5]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
    std::fs::write(folder.join("li"), encipher_common_key(&li)).unwrap();
    let ri = std::fs::read(folder.join("ri")).unwrap();
    std::fs::write(folder.join("ri"), encipher_common_key(&ri)).unwrap();
    let zip = scratch.0.join("pack.zip");
    zip_folder(&zip, &folder);
    let seven = scratch.0.join("pack.7z");
    seven_zip(&seven, &scratch.0, &[PACK_ID]);
    let cancel = AtomicBool::new(false);
    for path in [&folder, &zip, &seven] {
        let mut values = super::analyze_with(path, &cancel, true).unwrap();
        if path == &seven {
            super::enrich_7z(path, &mut values, &cancel).unwrap();
        }
        assert_eq!(values.len(), 1);
        assert_eq!(
            values[0].valid_field(&["/packMetadata/storyCount"]),
            Some(&serde_json::json!(2)),
            "{}",
            path.display()
        );
        assert_eq!(
            values[0].valid_field(&["/packMetadata/durationSeconds"]),
            Some(&serde_json::json!(5.0)),
            "{}",
            path.display()
        );
    }
}

#[test]
fn successive_archive_openings_reuse_one_shared_conversion() {
    for format in ["7z", "fsZip"] {
        let scratch = Scratch::new();
        let tree = scratch.0.join("tree");
        write_cleartext_pack(&tree.join(PACK_ID), true);
        let archive = scratch.0.join(if format == "7z" {
            "pack.7z"
        } else {
            "pack.zip"
        });
        if format == "7z" {
            seven_zip(&archive, &tree, &[PACK_ID]);
        } else {
            zip_folder(&archive, &tree.join(PACK_ID));
        }
        let target = Target {
            path: archive.clone(),
            observation: Some(Observed {
                format: format.into(),
                state: "available".into(),
                token: String::new(),
                raw: serde_json::json!({}),
            }),
        };
        let cancel = AtomicBool::new(false);
        let first_owned = scratch.0.join("first");
        std::fs::create_dir_all(&first_owned).unwrap();
        let first = materialize::pack_zip(&target, &first_owned, &cancel, None).unwrap();
        let cached = crate::support::imported_pack::ensure_studio_pack_zip_cancellable(
            archive.to_str().unwrap(),
            &cancel,
        )
        .unwrap()
        .zip_path;
        // A harmless independent entry marks the shared result. A fresh
        // conversion would omit it, so the second opening must copy the cache.
        {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&cached)
                .unwrap();
            let mut zip = zip::ZipWriter::new_append(file).unwrap();
            zip.start_file(
                "cache-reuse-marker",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(b"shared conversion").unwrap();
            zip.finish().unwrap();
        }
        // A stable timestamp detects a republished conversion without relying on
        // clock resolution or sleeping. Copying a cached result preserves it.
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(123456);
        std::fs::File::options()
            .write(true)
            .open(&cached)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        let second_owned = scratch.0.join("second");
        std::fs::create_dir_all(&second_owned).unwrap();
        let second = materialize::pack_zip(&target, &second_owned, &cancel, None).unwrap();
        assert_eq!(
            std::fs::metadata(&cached).unwrap().modified().unwrap(),
            stamp,
            "{format}"
        );
        assert_ne!(first, second);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(second).unwrap()).unwrap();
        let mut marker = String::new();
        zip.by_name("cache-reuse-marker")
            .unwrap()
            .read_to_string(&mut marker)
            .unwrap();
        assert_eq!(marker, "shared conversion");
        assert!(cached.with_extension("context.json").is_file());
    }
}
