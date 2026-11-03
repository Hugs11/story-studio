use super::*;
use crate::native_pack::{
    self,
    persistence::{AdvancedMediaBinding, MediaBindingStatus},
    Presence, StoryDocument,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read};
const ID: &str = "00000000-0000-4000-8000-123456abcdef";

#[test]
fn diagnostic_transport_keeps_only_closed_steps_and_public_message() {
    for code in [
        codes::STORYTELLER_STORY_INCOMPLETE,
        codes::STORYTELLER_STORY_UNREADABLE,
    ] {
        for step in DIAGNOSTICS {
            let safe = safe_repatriation_reason(diagnostic(UserMessage::new(code), step));
            assert_eq!(safe.code, code);
            assert!(safe.params.is_empty());
            assert_eq!(
                safe.detail.as_deref(),
                Some(format!("repatriation: {step}").as_str())
            );
        }
        for detail in [
            "C:\\private\\story.mp3",
            "repatriation: private-title",
            "repatriation: read-image\nsecret",
            "repatriation: read-image\nrepatriation: image-size\nrepatriation: image-padding",
            "repatriation: image-padding; stored=secret; declared=54; expected=64; trailing_nonzero=0",
            "repatriation: image-padding; stored=64; declared=54; expected=64; trailing_nonzero=0; path=private",
        ] {
            let safe = safe_repatriation_reason(UserMessage::new(code).with_detail(detail));
            assert_eq!(safe.code, code);
            assert!(safe.detail.is_none());
        }
    }
    let cancelled = diagnostic(
        UserMessage::new(codes::STORYTELLER_SEND_CANCELLED),
        "read-image",
    );
    assert!(safe_repatriation_reason(cancelled).detail.is_none());
    let private = UserMessage::new(codes::STORYTELLER_STORY_UNREADABLE)
        .param("path", "C:\\private\\story.mp3")
        .with_detail("C:\\private\\story.mp3");
    assert!(!serde_json::to_string(&safe_repatriation_reason(private))
        .unwrap()
        .contains("private"));

    let both = "repatriation: image-padding\nrepatriation: link-target";
    let retained = safe_repatriation_reason(incomplete().with_detail(both));
    assert_eq!(retained.code, codes::STORYTELLER_STORY_INCOMPLETE);
    assert_eq!(retained.detail.as_deref(), Some(both));
}

#[test]
fn reconstruction_diagnostics_distinguish_missing_node_index_and_invalid_layout() {
    let root = scratch();
    let output = scratch();
    let story = Path::new("private-title");
    fs::create_dir(root.0.join(story)).unwrap();
    let reconstruct_error = || {
        reconstruct(
            &root.0,
            story,
            Uuid::parse_str(ID).unwrap(),
            &output.0,
            None,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap_err()
    };
    let missing = safe_repatriation_reason(reconstruct_error());
    assert_eq!(missing.code, codes::STORYTELLER_STORY_INCOMPLETE);
    assert_eq!(
        missing.detail.as_deref(),
        Some("repatriation: read-node-index")
    );
    fs::write(root.0.join(story).join("ni"), [0; 512]).unwrap();
    let invalid = safe_repatriation_reason(reconstruct_error());
    assert_eq!(invalid.code, missing.code);
    assert_eq!(invalid.detail.as_deref(), Some("repatriation: node-layout"));
    assert!(!serde_json::to_string(&invalid)
        .unwrap()
        .contains("private-title"));
}

#[test]
fn index_diagnostics_distinguish_reading_and_decryption_without_source_data() {
    let root = scratch();
    metadata(&root.0, 6);
    let cipher = DeviceCipher::from_metadata(&root.0).unwrap();
    let story = Path::new("private-title");
    fs::create_dir(root.0.join(story)).unwrap();
    let read_error = index(&cipher, &root.0, story, "li", 4, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(read_error.code, codes::STORYTELLER_STORY_INCOMPLETE);
    assert_eq!(
        read_error.detail.as_deref(),
        Some("repatriation: read-index-li")
    );
    fs::write(root.0.join(story).join("li"), b"secret").unwrap();
    let decrypt_error =
        index(&cipher, &root.0, story, "li", 4, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(decrypt_error.code, codes::STORYTELLER_STORY_UNREADABLE);
    assert_eq!(
        decrypt_error.detail.as_deref(),
        Some("repatriation: decrypt-index-li")
    );
    let serialized = serde_json::to_string(&safe_repatriation_reason(decrypt_error)).unwrap();
    assert!(!serialized.contains("secret"));
    assert!(!serialized.contains("private-title"));
}

fn scratch() -> Scratch {
    Scratch::new(&crate::support::paths::canonical_temp_dir()).unwrap()
}
fn metadata(root: &Path, version: u16) {
    let mut md = vec![0; if version == 7 { 128 } else { 112 }];
    md[..2].copy_from_slice(&version.to_le_bytes());
    md[2..7].copy_from_slice(b"3.1.5");
    md[26..40].copy_from_slice(b"01234567890123");
    for (i, b) in md[64..96].iter_mut().enumerate() {
        *b = i as u8;
    }
    fs::write(root.join(".md"), md).unwrap();
}
fn source(parent: &Path) -> (StoryDocument, Vec<AdvancedMediaBinding>) {
    // Source fixture exists at fe1307ac:scripts/fixtures/ui-built-projects/menus.json
    // (verified with git show). No expectation comes from the inverse reader.
    let project = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/ui-built-projects/menus.json"
    ))
    .unwrap();
    let projection = native_pack::simulation::project_story_for_simulation(&project).unwrap();
    let mut doc = projection.story;
    doc.uuid = Presence::Value(ID.into());
    let mut bindings = Vec::new();
    for (rank, media) in projection.media.iter().enumerate() {
        let image = media.path.as_ref().unwrap().ends_with(".png");
        let path = parent.join(format!(
            "media-{rank}.{}",
            if image { "png" } else { "wav" }
        ));
        if image {
            image::RgbImage::from_pixel(320, 240, image::Rgb([rank as u8 * 11, 50, 80]))
                .save(&path)
                .unwrap();
        } else {
            let samples = 44100u32;
            let mut bytes = Vec::new();
            bytes.extend(b"RIFF");
            bytes.extend((36 + samples * 2).to_le_bytes());
            bytes.extend(b"WAVEfmt ");
            bytes.extend(16u32.to_le_bytes());
            bytes.extend(1u16.to_le_bytes());
            bytes.extend(1u16.to_le_bytes());
            bytes.extend(samples.to_le_bytes());
            bytes.extend((samples * 2).to_le_bytes());
            bytes.extend(2u16.to_le_bytes());
            bytes.extend(16u16.to_le_bytes());
            bytes.extend(b"data");
            bytes.extend((samples * 2).to_le_bytes());
            for n in 0..samples {
                bytes.extend(
                    ((((n as f64 * (200 + rank * 37) as f64 / samples as f64
                        * std::f64::consts::TAU)
                        .sin())
                        * 6000.) as i16)
                        .to_le_bytes(),
                );
            }
            fs::write(&path, bytes).unwrap();
        }
        bindings.push(AdvancedMediaBinding {
            asset_ref: media.asset_name.clone(),
            path: Some(path.to_string_lossy().into()),
            status: MediaBindingStatus::Resolved,
        });
    }
    (doc, bindings)
}
/// All controls and ordered transition destinations, including Random and
/// absent transitions. Equality implies identical wheel/OK/Home paths at any
/// depth, rather than checking just a few selected paths.
fn navigation(doc: &StoryDocument) -> Value {
    let rank: BTreeMap<_, _> = doc
        .stage_nodes
        .iter()
        .enumerate()
        .map(|(i, s)| (s.uuid.as_str(), i))
        .collect();
    let transition = |t: &Presence<native_pack::Transition>| {
        t.value().map(|t| {
        let a = doc.action_nodes.iter().find(|a| a.id == t.action_node).unwrap();
        json!({"selection":t.selection.to_dialect_index(),"options":a.options.iter().map(|target| target.as_deref().map(|id| rank[id])).collect::<Vec<_>>()})
    })
    };
    json!(doc.stage_nodes.iter().map(|s| json!({"entry":s.is_square_one(),"controls":s.control_settings,"ok":transition(&s.ok_transition),"home":transition(&s.home_transition),"image":s.image.value().is_some(),"audio":s.audio.value().is_some()})).collect::<Vec<_>>())
}
fn archive(path: &Path) -> (StoryDocument, BTreeMap<String, Vec<u8>>) {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut entries = BTreeMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        entries.insert(entry.name().to_owned(), bytes);
    }
    let doc =
        native_pack::decode_story_document(std::str::from_utf8(&entries["story.json"]).unwrap())
            .unwrap()
            .document;
    (doc, entries)
}
#[test]
fn source_example_roundtrip_v6_v7_and_v6_on_v7_navigation_media_catalogue() {
    let src = scratch();
    let out = scratch();
    let cache = scratch();
    let (doc, bindings) = source(&src.0);
    let authorization = native_pack::output_identity::authorize_storyteller(
        &serde_json::to_string(&doc).unwrap(),
        None,
    )
    .unwrap();
    let plain = super::super::write_plain_story(
        &authorization,
        &bindings,
        &out.0,
        &cache.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    for (version, upgrade) in [(6, false), (7, false), (6, true)] {
        let root = scratch();
        metadata(&root.0, version);
        fs::create_dir(root.0.join(".content")).unwrap();
        let encrypted = DeviceCipher::from_metadata(&root.0)
            .unwrap()
            .encrypt_story(&plain, &root.0.join(".content"), &AtomicBool::new(false))
            .unwrap();
        fs::write(root.0.join(".pi"), authorization.uuid().as_bytes()).unwrap();
        if upgrade {
            metadata(&root.0, 7);
        }
        let store_root = scratch();
        let store = Store::open(&store_root.0.join("data"), &store_root.0.join("cache")).unwrap();
        let device = Device::open(&root.0, &store_root.0).unwrap();
        let acquired = scratch();
        let before = snapshot(&root.0);
        let zip = acquire(
            &store,
            &device,
            authorization.uuid(),
            &acquired.0,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let (recovered, entries) = archive(&zip);
        assert_eq!(navigation(&doc), navigation(&recovered));
        assert!(entries.contains_key("thumbnail.png"));
        assert_eq!(
            recovered.title.value().map(String::as_str),
            Some("Histoire sans titre")
        );
        for (rank, stage) in recovered.stage_nodes.iter().enumerate() {
            for (offset, folder, reference) in [
                (0, "rf", stage.image.value()),
                (4, "sf", stage.audio.value()),
            ] {
                if let Some(reference) = reference {
                    let ni = fs::read(plain.path.join("ni")).unwrap();
                    let index = int(&ni, 512 + rank * 44 + offset).unwrap();
                    let expected = fs::read(
                        plain
                            .path
                            .join(folder)
                            .join("000")
                            .join(format!("{index:08X}")),
                    )
                    .unwrap();
                    assert_eq!(entries[&format!("assets/{reference}")], expected);
                }
            }
        }
        let (fiche, _) = store
            .publish_repatriated_story(&zip, authorization.uuid())
            .unwrap();
        assert_eq!(
            store
                .device_card_link(authorization.uuid())
                .unwrap()
                .unwrap()
                .0,
            fiche
        );
        assert_eq!(
            acquire(
                &store,
                &device,
                authorization.uuid(),
                &acquired.0,
                &AtomicBool::new(false),
                |_| {}
            )
            .unwrap_err()
            .code,
            codes::STORYTELLER_ALREADY_IN_CATALOGUE
        );
        assert_eq!(snapshot(&root.0), before);
        assert!(encrypted.path.is_dir());
    }
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, result);
            } else {
                result.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}

#[test]
fn acquisition_preserves_inconsistent_and_undecodable_media_v6_v7() {
    let src = scratch();
    let out = scratch();
    let cache = scratch();
    let (doc, bindings) = source(&src.0);
    let authorization = native_pack::output_identity::authorize_storyteller(
        &serde_json::to_string(&doc).unwrap(),
        None,
    )
    .unwrap();
    let plain = super::super::write_plain_story(
        &authorization,
        &bindings,
        &out.0,
        &cache.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    // Independent synthetic BMP with the observed stored/declared lengths,
    // then a truncated image and files lacking even a media signature.
    let mut cases = Vec::new();
    for (stored, declared) in [
        (4970, 4971u32),
        (24174, 24181),
        (23648, 23644),
        (5790, 5788),
        (15144, 15143),
    ] {
        let mut image = super::super::tests::bitmap();
        image.resize(stored, 0x7b);
        image[2..6].copy_from_slice(&declared.to_le_bytes());
        cases.push(image);
    }
    let mut truncated = super::super::tests::bitmap();
    truncated.truncate(120);
    cases.push(truncated);
    cases.push(vec![0x7b; 600]);
    let sound = vec![0x7b; 600];
    for image in cases {
        for (folder, bytes) in [("rf/000", &image), ("sf/000", &sound)] {
            for entry in fs::read_dir(plain.path.join(folder)).unwrap() {
                fs::write(entry.unwrap().path(), bytes).unwrap();
            }
        }
        for version in [6, 7] {
            let root = scratch();
            metadata(&root.0, version);
            fs::create_dir(root.0.join(".content")).unwrap();
            DeviceCipher::from_metadata(&root.0)
                .unwrap()
                .encrypt_story(&plain, &root.0.join(".content"), &AtomicBool::new(false))
                .unwrap();
            fs::write(root.0.join(".pi"), authorization.uuid().as_bytes()).unwrap();
            let data = scratch();
            let store = Store::open(&data.0.join("data"), &data.0.join("cache")).unwrap();
            let device = Device::open(&root.0, &data.0).unwrap();
            let acquired = scratch();
            let before = snapshot(&root.0);
            let zip = acquire(
                &store,
                &device,
                authorization.uuid(),
                &acquired.0,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            let (recovered, entries) = archive(&zip);
            assert_eq!(navigation(&doc), navigation(&recovered));
            for stage in &recovered.stage_nodes {
                for (reference, original) in
                    [(stage.image.value(), &image), (stage.audio.value(), &sound)]
                {
                    if let Some(reference) = reference {
                        let bytes = &entries[&format!("assets/{reference}")];
                        assert_eq!(&bytes[..original.len()], original);
                        let expected_len = if original.len() < 512 {
                            original.len().div_ceil(16) * 16
                        } else {
                            original.len()
                        };
                        assert_eq!(bytes.len(), expected_len);
                        assert!(bytes[original.len()..].iter().all(|b| *b == 0));
                    }
                }
            }
            store
                .publish_repatriated_story(&zip, authorization.uuid())
                .unwrap();
            assert!(store
                .device_card_link(authorization.uuid())
                .unwrap()
                .is_some());
            assert_eq!(snapshot(&root.0), before);
        }
    }
}

#[test]
fn index_layout_rejects_truncation_and_supports_undercounted_sounds() {
    let mut ni = vec![0; 556];
    ni[4..8].copy_from_slice(&512i32.to_le_bytes());
    ni[8..12].copy_from_slice(&44i32.to_le_bytes());
    ni[12..16].copy_from_slice(&1i32.to_le_bytes());
    for off in [512, 520, 532] {
        ni[off..off + 4].copy_from_slice(&(-1i32).to_le_bytes());
    }
    ni[516..520].copy_from_slice(&2i32.to_le_bytes());
    assert_eq!(layout(ni.clone()).unwrap().sounds, 3);
    ni.pop();
    assert_eq!(
        layout(ni).err().unwrap().code,
        codes::STORYTELLER_STORY_INCOMPLETE
    );
}
#[test]
#[ignore = "Local v7 creation only; secret material remains outside the repository"]
fn real_v7_complete_repatriation_headers() {
    fn copy_tree(source: &Path, target: &Path) {
        fs::create_dir_all(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            assert!(!entry.file_type().unwrap().is_symlink());
            let next = target.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &next);
            } else {
                fs::copy(entry.path(), next).unwrap();
            }
        }
    }
    let root = scratch();
    let fixture = std::env::var_os("STORY_STUDIO_REPATRIATION_FIXTURE_DIR")
        .map(PathBuf::from)
        .expect("set STORY_STUDIO_REPATRIATION_FIXTURE_DIR to the external v7 fixture directory");
    fs::copy(fixture.join("md-v7"), root.0.join(".md")).unwrap();
    let id = Uuid::parse_str("00000000-0000-4000-8000-00007e157e15").unwrap();
    copy_tree(
        &fixture.join("v7/7E157E15"),
        &root.0.join(".content/7E157E15"),
    );
    fs::write(root.0.join(".pi"), id.as_bytes()).unwrap();
    let data = scratch();
    let cache = scratch();
    let store = Store::open(&data.0.join("data"), &data.0.join("cache")).unwrap();
    let device = Device::open(&root.0, &data.0).unwrap();
    let before = snapshot(&root.0);
    let zip = acquire(
        &store,
        &device,
        id,
        &cache.0,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    let (document, entries) = archive(&zip);
    assert_eq!(document.stage_nodes.len(), 3);
    for (name, bytes) in &entries {
        if name.ends_with(".bmp") {
            assert!(bytes.starts_with(b"BM"));
        }
        if name.ends_with(".mp3") {
            assert!(
                bytes.starts_with(b"ID3")
                    || matches!(bytes.as_slice(), [0xff,b,..] if b & 0xe0 == 0xe0)
            );
        }
    }
    let (fiche, _) = store.publish_repatriated_story(&zip, id).unwrap();
    assert_eq!(store.device_card_link(id).unwrap().unwrap().0, fiche);
    assert!(snapshot(&root.0) == before);
}

#[test]
fn refusals_sidecar_and_cancelled_worker_leave_no_device_write_or_catalogue_residue() {
    let root = scratch();
    let src = scratch();
    let out = scratch();
    let cache = scratch();
    let (doc, bindings) = source(&src.0);
    let authorization = native_pack::output_identity::authorize_storyteller(
        &serde_json::to_string(&doc).unwrap(),
        None,
    )
    .unwrap();
    let plain = super::super::write_plain_story(
        &authorization,
        &bindings,
        &out.0,
        &cache.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    metadata(&root.0, 7);
    fs::create_dir(root.0.join(".content")).unwrap();
    let encrypted = DeviceCipher::from_metadata(&root.0)
        .unwrap()
        .encrypt_story(&plain, &root.0.join(".content"), &AtomicBool::new(false))
        .unwrap();
    let id = authorization.uuid();
    fs::write(root.0.join(".pi"), id.as_bytes()).unwrap();
    let data = scratch();
    let store = Arc::new(Store::open(&data.0.join("data"), &data.0.join("cache")).unwrap());
    let device = Device::open(&root.0, &data.0).unwrap();
    store
        .write(|tx| {
            tx.execute("INSERT INTO lunii_pack VALUES (?1,'{}')", [id.to_string()])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        acquire(
            &store,
            &device,
            id,
            &cache.0,
            &AtomicBool::new(false),
            |_| {}
        )
        .unwrap_err()
        .code,
        codes::STORYTELLER_OFFICIAL_REFUSED
    );
    store
        .write(|tx| {
            tx.execute("DELETE FROM lunii_pack", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    let si = fs::read(encrypted.path.join("si")).unwrap();
    fs::remove_file(encrypted.path.join("si")).unwrap();
    assert_eq!(
        acquire(
            &store,
            &device,
            id,
            &cache.0,
            &AtomicBool::new(false),
            |_| {}
        )
        .unwrap_err()
        .code,
        codes::STORYTELLER_STORY_INCOMPLETE
    );
    fs::write(encrypted.path.join("si"), si).unwrap();
    let md = fs::read(root.0.join(".md")).unwrap();
    let mut wrong_md = md.clone();
    wrong_md[64..96].fill(0x7a);
    wrong_md[26] = b'9';
    fs::write(root.0.join(".md"), wrong_md).unwrap();
    let local = scratch();
    assert_eq!(
        acquire(
            &store,
            &device,
            id,
            &local.0,
            &AtomicBool::new(false),
            |_| {}
        )
        .unwrap_err()
        .code,
        codes::STORYTELLER_STORY_UNREADABLE
    );
    fs::write(root.0.join(".md"), md).unwrap();
    // D23: an existing sidecar supplies both title and cover, without sync.
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0])))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let cover = png.into_inner();
    let card = driver::cards::Card {
        title: "Conte retrouvé".into(),
        description: String::new(),
        age_min: None,
        age_max: None,
        cover_png: Some(cover.clone()),
    };
    fs::create_dir(root.0.join(".storystudio")).unwrap();
    fs::write(
        root.0.join(".storystudio").join(format!("{id}.json")),
        serde_json::to_vec(&json!({"version":1,"uuid":id,"card":card,"pending_name":false}))
            .unwrap(),
    )
    .unwrap();
    let before = snapshot(&root.0);
    let local = scratch();
    let zip = acquire(
        &store,
        &device,
        id,
        &local.0,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    let (doc, entries) = archive(&zip);
    assert_eq!(doc.title.value().unwrap(), "Conte retrouvé");
    assert_eq!(entries["thumbnail.png"], cover);
    let worker_cache = cache.0.join("worker");
    let op = store
        .begin_lunii_transfer(
            "cancel-mid-read".into(),
            1,
            Arc::new(|_, _| {}),
            "luniiRepatriate",
        )
        .unwrap();
    let worker_op = Arc::clone(&op);
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&observed);
    let sink: Sink = Arc::new(move |event, p| {
        seen.lock()
            .unwrap()
            .push((event.to_owned(), p.status.clone()));
        if p.result
            .as_ref()
            .and_then(|v| v["progress"].as_u64())
            .is_some_and(|n| n > 10)
        {
            worker_op.cancel.store(true, Ordering::SeqCst);
        }
    });
    run(
        Arc::clone(&store),
        device,
        id,
        worker_cache.clone(),
        Arc::clone(&op),
        sink,
    );
    let progress = op.progress.lock().unwrap();
    assert_eq!(progress.status, "cancelled");
    assert_eq!(
        progress.error.as_ref().unwrap().code,
        codes::STORYTELLER_SEND_CANCELLED
    );
    assert_eq!(fs::read_dir(&worker_cache).unwrap().count(), 0);
    assert!(store.device_card_link(id).unwrap().is_none());
    assert!(!store.repatriated_root().unwrap().exists());
    assert_eq!(snapshot(&root.0), before);
    assert_eq!(
        observed.lock().unwrap().last().unwrap().0,
        "catalogue-operation-finished"
    );
}
#[test]
fn classifier_refusal_is_translatable_without_source_path() {
    use std::io::Write;
    let dir = scratch();
    let path = dir.0.join("private.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(br#"{"stageNodes":[{"uuid":"root","squareOne":true,"image":null,"audio":null,"controlSettings":{"wheel":false},"okTransition":null,"homeTransition":null}],"actionNodes":[]}"#)
        .unwrap();
    zip.finish().unwrap();
    let error = classify(&path, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, codes::STORYTELLER_REPATRIATE_REFUSED);
    let public = super::super::send::safe_reason(error);
    let text = serde_json::to_string(&public).unwrap();
    assert!(!text.contains("private.zip"));
    assert!(!text.contains(dir.0.to_str().unwrap()));
    assert!(public.params.contains_key("cause"));
}

#[test]
fn refused_preserves_declared_cause_parameters_and_filters_private_data() {
    let error = refused(
        UserMessage::new(codes::VALIDATION_FIELD_MISSING_MASCULINE)
            .param("label", "Audio")
            .param("folderPath", "/private/secret")
            .with_detail("/private/details"),
    );
    assert_eq!(error.params["cause"]["params"], json!({"label":"Audio"}));
    assert!(!serde_json::to_string(&error).unwrap().contains("private"));
}

#[test]
fn short_mp3_roundtrip_retains_ambiguous_zero_padding() {
    let src = scratch();
    let out = scratch();
    let cache = scratch();
    let (doc, bindings) = source(&src.0);
    let authorization = native_pack::output_identity::authorize_storyteller(
        &serde_json::to_string(&doc).unwrap(),
        None,
    )
    .unwrap();
    let plain = super::super::write_plain_story(
        &authorization,
        &bindings,
        &out.0,
        &cache.0,
        &AtomicBool::new(false),
    )
    .unwrap();
    // One MPEG-1 Layer III frame, 128 kbit/s at 44.1 kHz: 417 bytes.
    // Its zero-valued tail belongs to the input and must not be stripped.
    let mut mp3 = vec![0; 417];
    mp3[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
    let sound = plain.path.join("sf/000/00000000");
    fs::write(&sound, &mp3).unwrap();
    for version in [6, 7] {
        let root = scratch();
        metadata(&root.0, version);
        fs::create_dir(root.0.join(".content")).unwrap();
        let encrypted = DeviceCipher::from_metadata(&root.0)
            .unwrap()
            .encrypt_story(&plain, &root.0.join(".content"), &AtomicBool::new(false))
            .unwrap();
        let acquired = scratch();
        let zip = reconstruct(
            &root.0,
            encrypted
                .path
                .strip_prefix(root.0.canonicalize().unwrap())
                .unwrap(),
            authorization.uuid(),
            &acquired.0,
            None,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let (recovered, entries) = archive(&zip);
        let stage = doc
            .stage_nodes
            .iter()
            .position(|stage| stage.audio.value().is_some())
            .unwrap();
        let audio = recovered.stage_nodes[stage].audio.value().unwrap();
        let bytes = &entries[&format!("assets/{audio}")];
        assert_eq!(&bytes[..mp3.len()], mp3.as_slice());
        // Cipher prefixes are padded to 16-byte blocks, not always 512.
        assert_eq!(bytes.len(), 432);
        assert!(bytes[mp3.len()..].iter().all(|b| *b == 0));
    }
}
