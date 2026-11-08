//! Consultations of every compatible format, built from fabricated fixtures:
//! no project, session or recovery is created, the sources keep their bytes,
//! and every owned resource disappears at closing, failure, cancellation and
//! restart.
use super::consultation::{self, consultations_root, Registry, Request, Status};
use crate::services::catalogue::store::Store;
use crate::support::user_message::codes;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("catalogue-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        // A work area beside the sources: session folders and a recovery
        // file that a consultation must never touch.
        std::fs::create_dir_all(root.join("workspace/sessions/session-1")).unwrap();
        std::fs::write(root.join("workspace/sessions/session-1/projet.mbah"), b"{}").unwrap();
        std::fs::write(
            root.join("workspace/.session-recovery.mbah"),
            b"{\"recovery\":1}",
        )
        .unwrap();
        Self(root)
    }
    fn source(&self) -> PathBuf {
        self.0.join("source")
    }
    fn registry(&self) -> Registry {
        Registry::with_timeout(
            consultations_root(&self.0.join("cache")),
            Duration::from_secs(2),
        )
    }
    fn open(&self) -> Arc<Store> {
        let store = Arc::new(Store::open(&self.0.join("data"), &self.0.join("cache")).unwrap());
        store.add_source(&self.source(), 0, false).unwrap();
        store
    }
    fn scan(&self, store: &Arc<Store>) {
        let receipt = store
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                store.list_sources().unwrap().sources_revision,
                self.0.join("cache"),
                self.0.join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        let start = Instant::now();
        loop {
            let progress = store.get_operation(&receipt.operation_id).unwrap();
            if !matches!(
                progress.status.as_str(),
                "queued" | "running" | "cancelling"
            ) {
                assert_eq!(
                    progress.status,
                    "success",
                    "{}",
                    serde_json::to_string(&progress).unwrap()
                );
                return;
            }
            assert!(start.elapsed() < crate::test_support::timeout());
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    /// Every file outside the catalogue's own data and cache.
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = snapshot(&self.source());
        files.extend(snapshot(&self.0.join("workspace")));
        files
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(snapshot(&path));
        } else {
            files.push((path.clone(), std::fs::read(path).unwrap()));
        }
    }
    files.sort();
    files
}

fn story(title: &str) -> Value {
    json!({
        "title": title,
        "version": 1,
        "description": "",
        "format": "v1",
        "nightModeAvailable": false,
        "stageNodes": [
            {
                "uuid": "cover", "name": "Cover", "type": "stage", "squareOne": true,
                "audio": "root.mp3", "image": "cover.png",
                "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "homeTransition": null
            },
            {
                "uuid": "title", "name": "Titre", "type": "stage", "squareOne": false,
                "audio": "item.mp3", "image": "item.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "play-action", "optionIndex": 0 },
                "homeTransition": null
            },
            {
                "uuid": "play", "name": "Lecture", "type": "stage", "squareOne": false,
                "audio": "story.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
            }
        ],
        "actionNodes": [
            { "id": "root-action", "name": "Root", "options": ["title"] },
            { "id": "play-action", "name": "Play", "options": ["play"] }
        ]
    })
}

/// Entries of a STUdio pack under `prefix` (`""` for the archive root).
fn pack_entries(prefix: &str, title: &str) -> Vec<(String, Vec<u8>)> {
    let mut entries = vec![(
        format!("{prefix}story.json"),
        story(title).to_string().into_bytes(),
    )];
    for asset in ["root.mp3", "cover.png", "item.mp3", "item.png", "story.mp3"] {
        entries.push((
            format!("{prefix}assets/{asset}"),
            format!("{title}:{asset}").into_bytes(),
        ));
    }
    entries
}

fn zip_bytes(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in entries {
        writer.start_file(name.as_str(), options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn write_tree(root: &Path, entries: &[(String, Vec<u8>)]) {
    for (name, bytes) in entries {
        let path = root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
}

fn seven_zip(archive: &Path, folder: &Path) {
    let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
    let output = std::process::Command::new(tool)
        .arg("a")
        .arg("-t7z")
        .arg(archive)
        .arg(".")
        .current_dir(folder)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn advanced_project(title: &str, binding_path: &str) -> Value {
    let mut identity = crate::native_pack::persistence::system_pack_identity;
    let payload =
        crate::native_pack::persistence::create_advanced_document_named(title, None, &mut identity)
            .unwrap();
    json!({
        "schemaVersion": 4,
        "authoringMode": "advanced",
        "projectType": "advanced",
        "projectName": title,
        "rootEntries": [],
        "authoring": {
            "payload": payload,
            "mediaBindings": [
                {"assetRef": "voix", "path": binding_path, "status": "resolved"}
            ]
        }
    })
}

/// The interface's normalized form of a menu project (`projectToRustExport`).
fn menu_project_export(audio: &Path, cover: &Path) -> String {
    json!({
        "name": "Libre",
        "projectType": "pack",
        "rootAudio": audio.to_string_lossy(),
        "rootImage": cover.to_string_lossy(),
        "rootEntries": [{
            "id": "s1", "type": "story", "name": "Histoire",
            "audio": audio.to_string_lossy(), "itemAudio": null, "itemImage": null
        }],
        "globalOptions": {
            "harmonizeLoudness": false,
            "addSilence": false,
            "autoNext": false,
            "nightMode": false,
            "endMessageAutoplay": true
        }
    })
    .to_string()
}

/// Builds every compatible format in the source folder.
fn populate(f: &Fixture) {
    let source = f.source();
    std::fs::write(
        source.join("direct.zip"),
        zip_bytes(&pack_entries("", "Direct")),
    )
    .unwrap();
    write_tree(&source.join("Dossier"), &pack_entries("", "Dossier"));
    let staging = f.0.join("staging-7z");
    write_tree(&staging, &pack_entries("", "Sept"));
    seven_zip(&source.join("sept.7z"), &staging);
    // A ZIP multipack: two pack folders and a nested pack archive.
    let mut multi = pack_entries("A/", "Enfant A");
    multi.extend(pack_entries("B/", "Enfant B"));
    multi.push(("C.zip".into(), zip_bytes(&pack_entries("", "Enfant C"))));
    std::fs::write(source.join("multi.zip"), zip_bytes(&multi)).unwrap();
    // A 7z multipack: a nested ZIP and a pack folder.
    let staging = f.0.join("staging-multi-7z");
    write_tree(
        &staging,
        &[("D.zip".into(), zip_bytes(&pack_entries("", "Enfant D")))],
    );
    write_tree(&staging, &pack_entries("E/", "Enfant E"));
    seven_zip(&source.join("multi.7z"), &staging);
    // Projects: media beside them, a graph project and a menu project.
    std::fs::write(source.join("graph-voix.mp3"), b"graph-voice").unwrap();
    std::fs::write(source.join("libre-voix.mp3"), b"libre-voice").unwrap();
    std::fs::write(source.join("libre-image.png"), b"libre-image").unwrap();
    std::fs::write(
        source.join("graphe.mbah"),
        advanced_project("Graphe", "./graph-voix.mp3").to_string(),
    )
    .unwrap();
    std::fs::write(
        source.join("libre.mbah"),
        json!({"projectType": "pack", "packMetadata": {"title": "Libre"}, "rootEntries": []})
            .to_string(),
    )
    .unwrap();
}

/// `(exemplar id, catalogue revision)` of the exemplar at `file` / `member`.
fn exemplar(store: &Store, file: &str, member: Option<&str>) -> (String, i64) {
    let page = store.list_entries(200, None).unwrap();
    for item in &page.items {
        for exemplar in item["exemplars"].as_array().unwrap() {
            let locator = &exemplar["locator"];
            let path = locator["path"].as_str().unwrap_or_default();
            if Path::new(path).file_name().and_then(|n| n.to_str()) == Some(file)
                && locator["member"].as_str() == member
            {
                return (
                    exemplar["id"].as_str().unwrap().to_owned(),
                    page.catalogue_revision,
                );
            }
        }
    }
    panic!("exemplar {file} {member:?} not indexed: {:#?}", page.items);
}

fn launch(
    registry: &Registry,
    store: &Store,
    token: &str,
    (exemplar, revision): &(String, i64),
    project_json: Option<&str>,
) -> crate::services::catalogue::Result<consultation::ConsultationHandle> {
    consultation::open(
        registry,
        store,
        Request {
            consultation_id: token,
            exemplar_id: exemplar,
            expected_revision: *revision,
            project_json,
        },
    )
}

fn stage_media(handle: &consultation::ConsultationHandle) -> Vec<String> {
    handle.graph["stageNodes"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|node| [node["audio"].as_str(), node["image"].as_str()])
        .flatten()
        .map(str::to_owned)
        .collect()
}

#[test]
fn every_compatible_format_is_simulated_without_session_or_source_change() {
    let f = Fixture::new();
    populate(&f);
    let before = f.snapshot();
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    let root = consultations_root(&f.0.join("cache"));
    let packs: [(&str, Option<&str>, &str); 8] = [
        ("direct.zip", None, "Direct"),
        ("Dossier", None, "Dossier"),
        ("sept.7z", None, "Sept"),
        ("multi.zip", Some("A"), "Enfant A"),
        ("multi.zip", Some("B"), "Enfant B"),
        ("multi.zip", Some("C.zip"), "Enfant C"),
        ("multi.7z", Some("D.zip"), "Enfant D"),
        ("multi.7z", Some("E"), "Enfant E"),
    ];
    for (index, (file, member, title)) in packs.iter().enumerate() {
        let token = format!("pack-{index}");
        let target = exemplar(&store, file, *member);
        let handle = launch(&registry, &store, &token, &target, None)
            .unwrap_or_else(|error| panic!("{file} {member:?}: {error:?}"));
        assert_eq!(handle.kind, "pack");
        assert_eq!(handle.graph["title"], *title);
        assert_eq!(registry.status(&token), Some(Status::Ready));
        let media = stage_media(&handle);
        assert_eq!(media.len(), 5, "{file}: {:#?}", handle.graph);
        assert_eq!(handle.media_count, 5);
        // The media are the pack's own: same bytes as the fixture asset.
        let cover = handle.graph["stageNodes"][0]["audio"].as_str().unwrap();
        let (bytes, mime) = registry.read(&token, cover).unwrap();
        assert_eq!(bytes, format!("{title}:root.mp3").into_bytes());
        assert_eq!(mime, "audio/mpeg");
        let closed = registry.close(&token);
        assert!(closed.closed && !closed.cleanup_failed);
        assert!(!root.join(&token).exists(), "{file}: owned folder left");
    }

    let graph = exemplar(&store, "graphe.mbah", None);
    let handle = launch(&registry, &store, "graph", &graph, None).unwrap();
    assert_eq!(handle.kind, "document");
    assert!(
        handle.graph["view"]["stages"].is_array(),
        "{:#?}",
        handle.graph
    );
    let voice = handle.graph["media"]["voix"].as_str().unwrap().to_owned();
    assert_eq!(registry.read("graph", &voice).unwrap().0, b"graph-voice");
    registry.close("graph");

    let menu = exemplar(&store, "libre.mbah", None);
    // Without the interface's normalized project, nothing is improvised.
    let refused = launch(&registry, &store, "menu-raw", &menu, None).unwrap_err();
    assert_eq!(refused.code, codes::CATALOG_SIMULATION_UNSUPPORTED);
    assert!(!root.join("menu-raw").exists());
    let project = menu_project_export(
        &f.source().join("libre-voix.mp3"),
        &f.source().join("libre-image.png"),
    );
    let handle = launch(&registry, &store, "menu", &menu, Some(&project)).unwrap();
    assert_eq!(handle.kind, "pack");
    let read = stage_media(&handle)
        .iter()
        .map(|id| registry.read("menu", id).unwrap().0)
        .collect::<Vec<_>>();
    assert!(read.contains(&b"libre-voice".to_vec()));
    assert!(read.contains(&b"libre-image".to_vec()));
    registry.close("menu");

    // Nothing created or changed beside the catalogue: sources, session
    // folders and the recovery file are byte for byte the same.
    assert_eq!(f.snapshot(), before);
    assert!(std::fs::read_dir(&root)
        .map(|mut dir| dir.next().is_none())
        .unwrap_or(true));
}

#[test]
fn the_consultation_plays_the_graph_of_the_existing_simulator() {
    let f = Fixture::new();
    std::fs::write(
        f.source().join("direct.zip"),
        zip_bytes(&pack_entries("", "Direct")),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    let target = exemplar(&store, "direct.zip", None);
    let handle = launch(&registry, &store, "same", &target, None).unwrap();
    // Reference: the existing reader of `load_pack_zip { forSimulation }`.
    let zip = f.source().join("direct.zip");
    let reference: Value = serde_json::from_str(
        &crate::services::pack_reader::load_pack_zip_for_simulation(&zip.to_string_lossy())
            .unwrap(),
    )
    .unwrap();
    let without_media = |value: &Value| {
        let mut value = value.clone();
        for node in value["stageNodes"].as_array_mut().unwrap() {
            node["audio"] = Value::Null;
            node["image"] = Value::Null;
        }
        value
    };
    assert_eq!(without_media(&handle.graph), without_media(&reference));
    for (node, expected) in handle.graph["stageNodes"]
        .as_array()
        .unwrap()
        .iter()
        .zip(reference["stageNodes"].as_array().unwrap())
    {
        for slot in ["audio", "image"] {
            match expected[slot].as_str() {
                None => assert!(node[slot].is_null()),
                Some(name) => {
                    let id = node[slot].as_str().unwrap();
                    let old = crate::services::pack_reader::get_pack_asset(
                        &zip.to_string_lossy(),
                        &format!("assets/{name}"),
                    )
                    .unwrap();
                    assert_eq!(registry.read("same", id).unwrap().0, old);
                }
            }
        }
    }
}

#[test]
fn revalidation_never_opens_another_file() {
    let f = Fixture::new();
    for name in ["gone.zip", "replaced.zip", "kept.zip"] {
        std::fs::write(f.source().join(name), zip_bytes(&pack_entries("", name))).unwrap();
    }
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    let gone = exemplar(&store, "gone.zip", None);
    let replaced = exemplar(&store, "replaced.zip", None);
    std::fs::remove_file(f.source().join("gone.zip")).unwrap();
    let error = launch(&registry, &store, "gone", &gone, None).unwrap_err();
    assert_eq!(error.code, codes::CATALOG_FILE_DISAPPEARED);
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(
        f.source().join("replaced.zip"),
        zip_bytes(&pack_entries("", "Un autre pack, plus long")),
    )
    .unwrap();
    let error = launch(&registry, &store, "replaced", &replaced, None).unwrap_err();
    assert_eq!(error.code, codes::CATALOG_TARGET_REVISION_CHANGED);
    let kept = exemplar(&store, "kept.zip", None);
    let stale = launch(
        &registry,
        &store,
        "stale",
        &(kept.0.clone(), kept.1 + 1),
        None,
    )
    .unwrap_err();
    assert_eq!(stale.code, codes::CATALOG_TARGET_REVISION_CHANGED);
    let unknown = launch(&registry, &store, "unknown", &("nope".into(), kept.1), None).unwrap_err();
    assert_eq!(unknown.code, codes::CATALOG_TARGET_REVISION_STALE);
    for token in ["gone", "replaced", "stale", "unknown"] {
        assert_eq!(registry.status(token), None);
        assert!(!consultations_root(&f.0.join("cache")).join(token).exists());
    }
}

#[test]
fn media_are_scoped_to_a_ready_consultation_and_expire_with_the_source() {
    let f = Fixture::new();
    for name in ["a.zip", "b.zip"] {
        std::fs::write(f.source().join(name), zip_bytes(&pack_entries("", name))).unwrap();
    }
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    let a = launch(
        &registry,
        &store,
        "a",
        &exemplar(&store, "a.zip", None),
        None,
    )
    .unwrap();
    let a_media = stage_media(&a)[0].clone();
    let b = launch(
        &registry,
        &store,
        "b",
        &exemplar(&store, "b.zip", None),
        None,
    )
    .unwrap();
    // Opening another pack closed the first one.
    assert_eq!(registry.status("a"), None);
    let expired = |result: crate::services::catalogue::Result<(Vec<u8>, &str)>| {
        assert_eq!(
            result.unwrap_err().code,
            codes::CATALOG_CONSULTATION_EXPIRED
        )
    };
    expired(registry.read("a", &a_media));
    expired(registry.read("b", &a_media));
    expired(registry.read("b", "m-unknown"));
    expired(registry.read("../a", &a_media));
    let b_media = stage_media(&b)[0].clone();
    assert!(registry.read("b", &b_media).is_ok());
    // The source changes while listening: no former graph with new media.
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(
        f.source().join("b.zip"),
        zip_bytes(&pack_entries("", "changé, plus long")),
    )
    .unwrap();
    expired(registry.read("b", &b_media));
    assert_eq!(registry.status("b"), Some(Status::Failed));
    assert!(registry.close("b").closed);
}

#[test]
fn closing_cancelling_and_late_results_leave_no_owned_files() {
    let f = Fixture::new();
    let registry = f.registry();
    let root = consultations_root(&f.0.join("cache"));
    let prepared = || super::materialize::Prepared {
        kind: "pack",
        graph: json!({}),
        media: Default::default(),
    };
    // Closed during its preparation: the late result is refused and removed.
    let (folder, cancel) = registry.begin("first").unwrap();
    std::fs::write(folder.join("partial.zip"), b"...").unwrap();
    let closed = registry.close("first");
    assert!(closed.closed && !closed.cleanup_failed);
    assert!(cancel.load(Ordering::Relaxed));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("late.zip"), b"...").unwrap();
    let late = registry.publish("first", (folder.clone(), String::new()), &prepared());
    assert_eq!(late.unwrap_err().code, codes::CATALOG_CONSULTATION_EXPIRED);
    assert!(!folder.exists());
    // Two launches in reverse order: the first, arriving late, is refused.
    let (one, _) = registry.begin("one").unwrap();
    let (two, _) = registry.begin("two").unwrap();
    assert_eq!(registry.status("one"), None);
    assert!(registry
        .publish("one", (one.clone(), String::new()), &prepared())
        .is_err());
    assert!(!one.exists());
    assert_eq!(registry.status("two"), Some(Status::Preparing));
    assert!(registry
        .publish("two", (two.clone(), String::new()), &prepared())
        .is_ok());
    // A failed preparation leaves nothing.
    let (three, _) = registry.begin("three").unwrap();
    std::fs::write(three.join("partial"), b"...").unwrap();
    registry.discard("three");
    assert!(!three.exists() && registry.status("three").is_none());
    // Closing is idempotent, including for an unknown or invalid token.
    for _ in 0..2 {
        let closed = registry.close("two");
        assert!(closed.closed && !closed.cleanup_failed);
    }
    assert!(registry.close("never-opened").closed);
    assert!(registry.close("../escape").closed);
    assert!(registry.begin("../escape").is_err());
    assert!(root.read_dir().unwrap().next().is_none());
}

#[test]
fn a_failed_cleanup_is_reported_and_retried_without_touching_live_ones() {
    let f = Fixture::new();
    let failing = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&failing);
    let registry = f.registry().with_remover(Box::new(move |path| {
        if flag.load(Ordering::Relaxed) {
            Err(std::io::Error::other("locked"))
        } else {
            match std::fs::remove_dir_all(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            }
        }
    }));
    let (stuck, _) = registry.begin("stuck").unwrap();
    let closed = registry.close("stuck");
    assert!(closed.closed && closed.cleanup_failed);
    assert_eq!(closed.cleanup.unwrap().code, codes::CATALOG_CLEANUP_FAILED);
    assert!(stuck.exists());
    assert_eq!(registry.pending_cleanups(), vec![stuck.clone()]);
    failing.store(false, Ordering::Relaxed);
    let (live, _) = registry.begin("live").unwrap();
    // Any later closing retries the pending removal, never a live folder.
    let closed = registry.close("other");
    assert!(!closed.cleanup_failed);
    assert!(!stuck.exists());
    assert!(registry.pending_cleanups().is_empty());
    assert!(live.exists());
    assert_eq!(registry.status("live"), Some(Status::Preparing));
}

#[test]
fn orphans_are_removed_at_startup_and_sessions_are_kept() {
    let f = Fixture::new();
    let root = consultations_root(&f.0.join("cache"));
    std::fs::create_dir_all(root.join("crashed/member-0.zip.dir")).unwrap();
    std::fs::write(root.join("crashed/member-0.zip"), b"...").unwrap();
    // Beside the consultations: other cache content and the work area.
    std::fs::create_dir_all(f.0.join("cache/catalogue/thumbnails")).unwrap();
    std::fs::write(f.0.join("cache/catalogue/thumbnails/a.jpg"), b"jpg").unwrap();
    let before = f.snapshot();
    let registry = f.registry();
    assert!(!root.exists());
    assert!(f.0.join("cache/catalogue/thumbnails/a.jpg").exists());
    assert_eq!(f.snapshot(), before);
    assert!(registry.begin("after-start").is_ok());
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn shape(value: &Value) -> Vec<(String, &'static str)> {
    let mut fields = value
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), kind(value)))
        .collect::<Vec<_>>();
    fields.sort();
    fields
}

#[test]
fn serialized_contract_matches_the_interface_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/consultation.json"
    ))
    .unwrap();
    let f = Fixture::new();
    std::fs::write(
        f.source().join("direct.zip"),
        zip_bytes(&pack_entries("", "Direct")),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    let handle = launch(
        &registry,
        &store,
        "contract",
        &exemplar(&store, "direct.zip", None),
        None,
    )
    .unwrap();
    let handle = serde_json::to_value(&handle).unwrap();
    assert_eq!(shape(&handle), shape(&fixture["handle"]));
    let node = &handle["graph"]["stageNodes"][0];
    let expected = &fixture["handle"]["graph"]["stageNodes"][0];
    for key in ["uuid", "squareOne", "audio", "image", "controlSettings"] {
        assert_eq!(kind(&node[key]), kind(&expected[key]), "{key}");
    }
    let media = handle["graph"]["stageNodes"][0]["audio"].as_str().unwrap();
    assert_eq!(handle["mediaTypes"][media], "audio/mpeg");
    let closed = serde_json::to_value(registry.close("contract")).unwrap();
    assert_eq!(shape(&closed), shape(&fixture["closed"]));
}

/// Files named by the interface are only served from the project's folder or
/// a workspace the catalogue knows, unless the project file names them
/// itself: an absolute path elsewhere, a `..` escape and a link leading
/// outside are refused, at preparation and at each read.
#[test]
fn project_media_are_confined_to_the_project_folder_and_the_workspace() {
    let f = Fixture::new();
    let outside = f.0.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.mp3"), b"secret").unwrap();
    std::fs::write(f.source().join("voix.mp3"), b"voice").unwrap();
    std::fs::write(
        f.source().join("libre.mbah"),
        json!({"projectType": "pack", "packMetadata": {"title": "Libre"}, "rootEntries": []})
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        f.source().join("graphe.mbah"),
        advanced_project("Graphe", "../outside/secret.mp3").to_string(),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    let menu = exemplar(&store, "libre.mbah", None);

    // Paths written by the interface: elsewhere, or escaping by `..`.
    for (token, audio) in [
        ("absolute", outside.join("secret.mp3")),
        ("dotdot", f.source().join("../outside/secret.mp3")),
    ] {
        let project = menu_project_export(&audio, &audio);
        let handle = launch(&registry, &store, token, &menu, Some(&project)).unwrap();
        assert_eq!(handle.media_count, 0, "{token}: {:#?}", handle.graph);
        assert!(stage_media(&handle).is_empty());
        registry.close(token);
    }

    // A graph binding escaping the project's folder is named by the file
    // itself: served, from the file as from the interface's resolved
    // bindings. Another file outside, which the file does not name, is
    // played as missing.
    let graph = exemplar(&store, "graphe.mbah", None);
    let handle = launch(&registry, &store, "graph-raw", &graph, None).unwrap();
    let voice = handle.graph["media"]["voix"].as_str().unwrap().to_owned();
    assert_eq!(registry.read("graph-raw", &voice).unwrap().0, b"secret");
    registry.close("graph-raw");
    let loaded = |path: &Path| {
        json!({"authoring": {"mediaBindings": [
            {"assetRef": "voix", "path": path.to_string_lossy(), "status": "resolved"}
        ]}})
        .to_string()
    };
    let handle = launch(
        &registry,
        &store,
        "graph-out",
        &graph,
        Some(&loaded(&outside.join("secret.mp3"))),
    )
    .unwrap();
    assert!(handle.graph["media"]["voix"].is_string());
    registry.close("graph-out");
    std::fs::write(outside.join("other.mp3"), b"other").unwrap();
    let handle = launch(
        &registry,
        &store,
        "graph-undeclared",
        &graph,
        Some(&loaded(&outside.join("other.mp3"))),
    )
    .unwrap();
    assert!(handle.graph["media"]["voix"].is_null());
    registry.close("graph-undeclared");

    // A file of the project's folder is served; swapped for a link leading
    // outside while listening, it is refused at the next read.
    let project = menu_project_export(&f.source().join("voix.mp3"), &f.source().join("voix.mp3"));
    let handle = launch(&registry, &store, "swap", &menu, Some(&project)).unwrap();
    let media = stage_media(&handle);
    assert!(!media.is_empty());
    assert_eq!(registry.read("swap", &media[0]).unwrap().0, b"voice");
    #[cfg(unix)]
    {
        // Links need no privilege on POSIX systems only.
        std::fs::remove_file(f.source().join("voix.mp3")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.mp3"), f.source().join("voix.mp3"))
            .unwrap();
        let refused = registry.read("swap", &media[0]).unwrap_err();
        assert_eq!(refused.code, codes::CATALOG_SIMULATION_UNSUPPORTED);
        registry.close("swap");
        let project =
            menu_project_export(&f.source().join("voix.mp3"), &f.source().join("voix.mp3"));
        let handle = launch(&registry, &store, "link", &menu, Some(&project)).unwrap();
        assert_eq!(handle.media_count, 0);
    }
    registry.close("swap");
    registry.close("link");
}

/// An older graph project names media relative to the workspace: the
/// interface's loader resolves them (fallback included) and the workspace the
/// catalogue knows is an allowed root, so the consultation plays them.
#[test]
fn a_graph_project_plays_media_resolved_on_the_workspace() {
    let f = Fixture::new();
    let workspace = f.0.join("workspace");
    std::fs::create_dir_all(workspace.join("voix-generees")).unwrap();
    std::fs::write(workspace.join("voix-generees/ancienne.mp3"), b"old-voice").unwrap();
    std::fs::write(
        f.source().join("graphe.mbah"),
        advanced_project("Graphe", "./voix-generees/ancienne.mp3").to_string(),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();
    // As `loadProjectFromPath` resolves it: the project-relative file does
    // not exist, the workspace one does.
    let resolved = json!({"authoring": {"mediaBindings": [{
        "assetRef": "voix",
        "path": workspace.join("voix-generees/ancienne.mp3").to_string_lossy(),
        "status": "resolved"
    }]}})
    .to_string();
    // Without the file's own resolution, nothing is heard.
    let graph = exemplar(&store, "graphe.mbah", None);
    let handle = launch(&registry, &store, "raw", &graph, None).unwrap();
    assert!(handle.graph["media"]["voix"].is_null());
    registry.close("raw");
    // A workspace the catalogue does not know is not a root.
    let handle = launch(&registry, &store, "unknown", &graph, Some(&resolved)).unwrap();
    assert!(handle.graph["media"]["voix"].is_null());
    registry.close("unknown");
    store.remember_workspace(workspace.to_str()).unwrap();
    let graph = exemplar(&store, "graphe.mbah", None);
    let handle = launch(&registry, &store, "known", &graph, Some(&resolved)).unwrap();
    let voice = handle.graph["media"]["voix"].as_str().unwrap().to_owned();
    assert_eq!(registry.read("known", &voice).unwrap().0, b"old-voice");
    registry.close("known");
}

/// A media the project file names itself is served wherever it is, as
/// in the editor, for menu and graph projects; the same path sent by the
/// interface for a project that does not name it is refused, and a link
/// swapped while listening is refused at the next read.
#[test]
fn media_named_by_the_project_file_are_served_wherever_they_are() {
    let f = Fixture::new();
    let music = f.0.join("Musique");
    std::fs::create_dir_all(&music).unwrap();
    std::fs::write(music.join("intro.mp3"), b"intro").unwrap();
    std::fs::write(music.join("other.mp3"), b"other").unwrap();
    let intro = music.join("intro.mp3");
    std::fs::write(
        f.source().join("libre.mbah"),
        json!({
            "projectType": "pack",
            "packMetadata": {"title": "Libre"},
            "rootEntries": [{"id": "s1", "type": "story", "name": "Histoire",
                "audio": intro.to_string_lossy()}]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        f.source().join("muet.mbah"),
        json!({"projectType": "pack", "packMetadata": {"title": "Muet"}, "rootEntries": []})
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        f.source().join("graphe.mbah"),
        advanced_project("Graphe", &intro.to_string_lossy()).to_string(),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let registry = f.registry();

    // Menu project: the file names the media, the interface sends it.
    let menu = exemplar(&store, "libre.mbah", None);
    let project = menu_project_export(&intro, &intro);
    let handle = launch(&registry, &store, "menu", &menu, Some(&project)).unwrap();
    let media = stage_media(&handle);
    assert!(!media.is_empty());
    assert_eq!(registry.read("menu", &media[0]).unwrap().0, b"intro");
    registry.close("menu");
    // Another file of the same folder, not named by the file: refused.
    let other = menu_project_export(&music.join("other.mp3"), &music.join("other.mp3"));
    let handle = launch(&registry, &store, "menu-other", &menu, Some(&other)).unwrap();
    assert_eq!(handle.media_count, 0);
    registry.close("menu-other");
    // The same path, for a project whose file does not name it: refused.
    let silent = exemplar(&store, "muet.mbah", None);
    let handle = launch(&registry, &store, "silent", &silent, Some(&project)).unwrap();
    assert_eq!(handle.media_count, 0);
    assert!(stage_media(&handle).is_empty());
    registry.close("silent");

    // Graph project: from the file, from the interface's bindings (also as
    // the loader writes a `../` reference), never another file.
    let graph = exemplar(&store, "graphe.mbah", None);
    let bindings = |path: &str| {
        json!({"authoring": {"mediaBindings": [
            {"assetRef": "voix", "path": path, "status": "resolved"}
        ]}})
        .to_string()
    };
    let dotted = format!("{}/../Musique/intro.mp3", f.source().to_string_lossy());
    for (token, loaded) in [
        ("graph-raw", None),
        ("graph-loaded", Some(bindings(&intro.to_string_lossy()))),
        ("graph-dotted", Some(bindings(&dotted))),
    ] {
        let handle = launch(&registry, &store, token, &graph, loaded.as_deref()).unwrap();
        let voice = handle.graph["media"]["voix"]
            .as_str()
            .unwrap_or_else(|| panic!("{token}: {:#?}", handle.graph["media"]))
            .to_owned();
        assert_eq!(registry.read(token, &voice).unwrap().0, b"intro");
        registry.close(token);
    }
    let handle = launch(
        &registry,
        &store,
        "graph-other",
        &graph,
        Some(&bindings(&music.join("other.mp3").to_string_lossy())),
    )
    .unwrap();
    assert!(handle.graph["media"]["voix"].is_null());
    registry.close("graph-other");

    #[cfg(unix)]
    {
        // Links need no privilege on POSIX systems only: the named file
        // swapped for a link to another file while listening.
        let handle = launch(&registry, &store, "swap", &menu, Some(&project)).unwrap();
        let media = stage_media(&handle);
        assert_eq!(registry.read("swap", &media[0]).unwrap().0, b"intro");
        std::fs::remove_file(&intro).unwrap();
        std::os::unix::fs::symlink(music.join("other.mp3"), &intro).unwrap();
        let refused = registry.read("swap", &media[0]).unwrap_err();
        assert_eq!(refused.code, codes::CATALOG_SIMULATION_UNSUPPORTED);
        registry.close("swap");
    }
}

/// The references of existing projects of the repository, as the interface's
/// loader resolves them (`scripts/catalogueDeclaredMedia.test.mjs` checks the
/// same fixture against `walkProjectMediaReferences`).
#[test]
fn declared_references_match_the_interface_loader() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/declared-media.json"
    ))
    .unwrap();
    let folder = Path::new(fixture["projectFolder"].as_str().unwrap());
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let project: Value = match case["file"].as_str() {
            Some(file) => serde_json::from_str(
                &std::fs::read_to_string(
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(file),
                )
                .unwrap(),
            )
            .unwrap(),
            None => case["project"].clone(),
        };
        let mut found = super::declared_media::references(&project)
            .into_iter()
            .map(|reference| {
                super::declared_media::lexical(&super::declared_media::project_path(
                    reference, folder,
                ))
                .to_string_lossy()
                .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        found.sort();
        found.dedup();
        let mut expected = ["expected", "rustOnly"]
            .iter()
            .flat_map(|key| case[*key].as_array().unwrap())
            .map(|path| path.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(found, expected, "{name}");
    }
}

#[test]
fn editor_entries_revalidate_formats_children_and_project_types_without_writes() {
    let f = Fixture::new();
    populate(&f);
    for kind in ["simple", "pack"] {
        std::fs::write(
            f.source().join(format!("{kind}.mbah")),
            json!({"projectType":kind,"projectName":kind,"rootEntries":[]}).to_string(),
        )
        .unwrap();
    }
    let store = f.open();
    f.scan(&store);
    let registry = Arc::new(super::editor_extractions::Registry::new(
        super::editor_extractions::root(&f.0.join("cache")),
    ));
    let owner = uuid::Uuid::new_v4().to_string();
    let before = f.snapshot();
    let page = store.list_entries(200, None).unwrap();
    let revision = page.catalogue_revision;
    let entries = &page.items;
    let mut kinds = std::collections::HashSet::new();
    for card in entries {
        for exemplar in card["exemplars"].as_array().unwrap() {
            if exemplar["state"] != "available" {
                continue;
            }
            let id = exemplar["id"].as_str().unwrap();
            let entry =
                serde_json::to_value(store.prepare_editor_entry(id, revision, "edit").unwrap())
                    .unwrap();
            kinds.insert(entry["kind"].as_str().unwrap().to_owned());
            if entry["kind"] == "bundleChild" {
                assert!(entry["childId"].as_str().unwrap().starts_with("catalogue:"));
                let out = super::editor_entry::extract_child(
                    entry["containerPath"].as_str().unwrap(),
                    entry["containerFingerprint"].as_str().unwrap(),
                    entry["childId"].as_str().unwrap(),
                    &registry,
                    &owner,
                    None,
                )
                .unwrap();
                assert!(Path::new(&out).is_file());
            }
            assert!(store
                .prepare_editor_entry(id, revision + 1, "edit")
                .is_err());
        }
    }
    registry.release(&owner).unwrap();
    assert!(!super::editor_extractions::root(&f.0.join("cache"))
        .join(&owner)
        .exists());
    assert_eq!(kinds.len(), 3);
    assert_eq!(f.snapshot(), before);
    let (id, revision) = exemplar(&store, "direct.zip", None);
    std::fs::remove_file(f.source().join("direct.zip")).unwrap();
    assert_eq!(
        store
            .prepare_editor_entry(&id, revision, "edit")
            .unwrap_err()
            .code,
        codes::CATALOG_FILE_DISAPPEARED
    );
}

#[test]
fn editor_entries_choose_the_latest_available_project_and_reject_changed_archives() {
    let f = Fixture::new();
    let uuid = "01000000-0000-4000-8000-000000000001";
    let mut entries = pack_entries("", "Pack");
    let story: Value = serde_json::from_slice(&entries[0].1).unwrap();
    // Write a dedicated fixture; identity is an explicit source fact.
    let mut story = story;
    story["uuid"] = json!(uuid);
    entries[0].1 = story.to_string().into_bytes();
    std::fs::write(f.source().join("direct.zip"), zip_bytes(&entries)).unwrap();
    for name in ["a", "b"] {
        std::fs::write(f.source().join(format!("{name}.mbah")),json!({"projectType":"pack","packMetadata":{"uuid":uuid,"title":"Pack"},"rootEntries":[]}).to_string()).unwrap();
    }
    let store = f.open();
    f.scan(&store);
    let (a, _) = exemplar(&store, "a.mbah", None);
    let (b, _) = exemplar(&store, "b.mbah", None);
    store.write_cache(|c| { c.execute("UPDATE observation SET modified_at=CASE WHEN exemplar_id=?1 THEN 10 ELSE 20 END WHERE exemplar_id IN (?1,?2)",rusqlite::params![a,b]).map_err(crate::services::catalogue::store::error)?; Ok(()) }).unwrap();
    let (id, revision) = exemplar(&store, "direct.zip", None);
    let prepared =
        serde_json::to_value(store.prepare_editor_entry(&id, revision, "edit").unwrap()).unwrap();
    assert_eq!(prepared["existingProject"]["exemplarId"], b);
    std::fs::remove_file(f.source().join("b.mbah")).unwrap();
    let prepared =
        serde_json::to_value(store.prepare_editor_entry(&id, revision, "edit").unwrap()).unwrap();
    assert_eq!(prepared["existingProject"]["exemplarId"], a);
    // A replaced archive never silently opens its replacement, even at the
    // same catalogue revision before the watcher has run.
    std::fs::write(
        f.source().join("direct.zip"),
        zip_bytes(&pack_entries("", "Other pack, different bytes")),
    )
    .unwrap();
    assert_eq!(
        store
            .prepare_editor_entry(&id, revision, "edit")
            .unwrap_err()
            .code,
        codes::CATALOG_TARGET_REVISION_CHANGED
    );
    assert!(store
        .prepare_editor_entry("absent", revision, "edit")
        .is_err());
}

#[test]
fn generation_receipts_are_evidence_not_identity_or_file_dates() {
    let f = Fixture::new();
    let identity = "02000000-0000-4000-8000-000000000002";
    let project = f.source().join("projet.mbah");
    let output = f.source().join("produit.zip");
    let project_json = json!({"projectType":"pack","projectName":"Projet","packMetadata":{"uuid":identity},"rootEntries":[]});
    std::fs::write(&project, project_json.to_string()).unwrap();
    let mut entries = pack_entries("", "Produit");
    let mut story: Value = serde_json::from_slice(&entries[0].1).unwrap();
    story["uuid"] = json!(identity);
    entries[0].1 = story.to_string().into_bytes();
    let store = f.open();
    f.scan(&store);
    // Output is produced after the scan; receipt indexing must be targeted.
    std::fs::write(&output, zip_bytes(&entries)).unwrap();
    let before = f.snapshot();
    let registry = crate::services::catalogue::writes::Registry::new(
        Duration::from_secs(30),
        Duration::from_secs(60),
    );
    let write = registry
        .begin(crate::services::catalogue::writes::Declaration::new("generation").exact(&output));
    registry.finish(&write, true, vec![output.clone()]);
    assert!(matches!(
        registry.classify(&output, Instant::now()),
        crate::services::catalogue::writes::Verdict::Absorbed
    ));
    let (id, _) = exemplar(&store, "projet.mbah", None);
    let state = || {
        let page = store.list_entries(200, None).unwrap();
        page.items
            .iter()
            .flat_map(|c| c["exemplars"].as_array().unwrap())
            .find(|e| e["id"] == id)
            .unwrap()["generation"]
            .clone()
    };
    assert_eq!(state(), json!({"state":"unknown"}));
    let full_scans = store.activity.snapshot().full_scans;
    let output_proof = super::generation::output_fingerprint(&output).unwrap();
    let recorded = store
        .record_generation(
            &project,
            &output,
            &f.0.join("cache"),
            &f.0.join("data"),
            &registry,
            Some(&project_json.to_string()),
            Some(&output_proof),
        )
        .unwrap();
    assert!(recorded.recorded);
    assert_eq!(store.activity.snapshot().full_scans, full_scans);
    assert_eq!(state()["state"], "upToDate");
    let receipt_count: i64 = store
        .read(|c| c.query_row("SELECT count(*) FROM generation_receipt", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(receipt_count, 1);
    assert_eq!(before, f.snapshot());
    // Change the saved envelope, refresh only that path, retain the UUID.
    let mut changed = project_json;
    changed["projectName"] = json!("Projet modifié");
    std::fs::write(&project, changed.to_string()).unwrap();
    let source = store
        .list_sources()
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.status == "active")
        .unwrap();
    store
        .refresh_paths(
            &crate::services::catalogue::refresh::Root {
                source_id: source.id,
                path: f.source(),
            },
            &[crate::services::catalogue::refresh::Change {
                path: project.clone(),
                settled: true,
                structural: false,
            }],
            &store
                .exclusions(&f.0.join("cache"), &f.0.join("data"))
                .unwrap(),
            Duration::ZERO,
            &AtomicBool::new(false),
            &registry,
        )
        .unwrap();
    assert_eq!(state()["state"], "modifiedSince");
    // A second indexed project with the same UUID has no receipt of its own.
    let second = f.source().join("autre.mbah");
    std::fs::copy(&project, &second).unwrap();
    f.scan(&store);
    let (second_id, _) = exemplar(&store, "autre.mbah", None);
    let page = store.list_entries(200, None).unwrap();
    let second = page
        .items
        .iter()
        .flat_map(|c| c["exemplars"].as_array().unwrap())
        .find(|e| e["id"] == second_id)
        .unwrap();
    assert_eq!(second["generation"]["state"], "unknown");
    assert_eq!(
        store
            .record_generation(
                &project,
                &f.0.join("outside.zip"),
                &f.0.join("cache"),
                &f.0.join("data"),
                &registry,
                Some(&changed.to_string()),
                Some(&output_proof),
            )
            .unwrap()
            .reason,
        Some("outputNotCovered")
    );
    assert_eq!(
        store
            .record_generation(
                Path::new(""),
                &output,
                &f.0.join("cache"),
                &f.0.join("data"),
                &registry,
                Some(&changed.to_string()),
                Some(&output_proof),
            )
            .unwrap()
            .reason,
        Some("projectUnsaved")
    );
    let unindexed = f.0.join("not-indexed.mbah");
    std::fs::copy(&project, &unindexed).unwrap();
    assert_eq!(
        store
            .record_generation(
                &unindexed,
                &output,
                &f.0.join("cache"),
                &f.0.join("data"),
                &registry,
                Some(&changed.to_string()),
                Some(&output_proof),
            )
            .unwrap()
            .reason,
        Some("projectNotIndexed")
    );
}

#[test]
fn generation_never_attests_a_revision_saved_during_render_or_scan_wait() {
    for wait_for_scan in [false, true] {
        let f = Fixture::new();
        let project = f.source().join("project.mbah");
        let output = f.source().join("output.zip");
        let generated =
            json!({"projectType":"pack","projectName":"A","rootEntries":[]}).to_string();
        std::fs::write(&project, &generated).unwrap();
        std::fs::write(&output, zip_bytes(&pack_entries("", "Generated A"))).unwrap();
        let store = f.open();
        f.scan(&store);
        let registry =
            crate::services::catalogue::writes::Registry::new(Duration::ZERO, Duration::ZERO);
        assert_eq!(
            store
                .record_generation(
                    &project,
                    &output,
                    &f.0.join("cache"),
                    &f.0.join("data"),
                    &registry,
                    None,
                    None
                )
                .unwrap()
                .reason,
            Some("generationUnproven")
        );
        let output_proof = super::generation::output_fingerprint(&output).unwrap();
        let changed =
            json!({"projectType":"pack","projectName":"Saved B","rootEntries":[]}).to_string();
        let result = if wait_for_scan {
            // The worker cannot pass the heavy lock until B is on disk.
            let heavy = store.scans.heavy.lock().unwrap();
            std::thread::scope(|scope| {
                let (started, waiting) = std::sync::mpsc::channel();
                let (store, project, output, f, registry, generated) =
                    (&store, &project, &output, &f, &registry, &generated);
                let worker = scope.spawn(move || {
                    started.send(()).unwrap();
                    store
                        .record_generation(
                            project,
                            output,
                            &f.0.join("cache"),
                            &f.0.join("data"),
                            registry,
                            Some(generated),
                            Some(&output_proof),
                        )
                        .unwrap()
                });
                waiting.recv().unwrap();
                std::fs::write(project, &changed).unwrap();
                drop(heavy);
                worker.join().unwrap()
            })
        } else {
            // An external save during rendering precedes the post-success call.
            std::fs::write(&project, &changed).unwrap();
            store
                .record_generation(
                    &project,
                    &output,
                    &f.0.join("cache"),
                    &f.0.join("data"),
                    &registry,
                    Some(&generated),
                    Some(&output_proof),
                )
                .unwrap()
        };
        assert!(!result.recorded);
        assert_eq!(result.reason, Some("projectChanged"));
        let count: i64 = store
            .read(|c| c.query_row("SELECT count(*) FROM generation_receipt", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(
            count, 0,
            "B must never receive a receipt for the output of A"
        );
        let page = store.list_entries(200, None).unwrap();
        let state = page
            .items
            .iter()
            .flat_map(|c| c["exemplars"].as_array().unwrap())
            .find(|e| e["format"] == "project")
            .unwrap()["generation"]
            .clone();
        assert_eq!(state, json!({"state":"unknown"}));
    }
}

#[test]
fn generation_folder_can_be_explicitly_declined_then_accepted() {
    let f = Fixture::new();
    let store = f.open();
    let folder = f.0.join("generation");
    std::fs::create_dir(&folder).unwrap();
    let explanation = serde_json::to_value(
        store
            .explain_path(&folder, &f.0.join("cache"), &f.0.join("data"))
            .unwrap(),
    )
    .unwrap();
    assert!(explanation["coveredBySourceId"].is_null());
    let revision = store.list_sources().unwrap().sources_revision;
    store.add_source(&folder, revision, true).unwrap();
    let sources = store.list_sources().unwrap();
    assert!(sources
        .items
        .iter()
        .any(|s| s.native_path == folder && s.status == "declined"));
    let explanation = serde_json::to_value(
        store
            .explain_path(&folder, &f.0.join("cache"), &f.0.join("data"))
            .unwrap(),
    )
    .unwrap();
    assert!(explanation["coveredBySourceId"].is_null());
    store
        .add_source(&folder, sources.sources_revision, false)
        .unwrap();
    let explanation = serde_json::to_value(
        store
            .explain_path(&folder, &f.0.join("cache"), &f.0.join("data"))
            .unwrap(),
    )
    .unwrap();
    assert!(explanation["coveredBySourceId"].is_string());
    assert!(explanation["excluded"].is_null());
    assert!(std::fs::read_dir(&folder).unwrap().next().is_none());
}

#[test]
fn editor_entry_serialization_matches_the_shared_contract() {
    use super::editor_entry::EditorEntry;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/editor-entries.json"
    ))
    .unwrap();
    for (key, value) in [
        (
            "project",
            EditorEntry::Project {
                path: "/packs/A.mbah".into(),
                project_kind: Some("pack".into()),
            },
        ),
        (
            "pack",
            EditorEntry::Pack {
                path: "/packs/A.zip".into(),
                pack_label: "A".into(),
                format: "zip".into(),
                existing_project: Some(
                    json!({"exemplarId":"project-a","path":"/packs/A.mbah","modifiedAt":1700000000000_i64}),
                ),
            },
        ),
        (
            "bundleChild",
            EditorEntry::BundleChild {
                container_path: "/packs/All.zip".into(),
                container_fingerprint: "fresh".into(),
                child_id: "catalogue:opaque".into(),
                pack_label: "A".into(),
                existing_project: None,
            },
        ),
    ] {
        assert_eq!(serde_json::to_value(value).unwrap(), fixture[key]);
    }
}

#[test]
fn editor_entries_include_fs_packs_and_expire_children_before_extraction() {
    let f = Fixture::new();
    populate(&f);
    crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&f.source().join("FS"));
    let store = f.open();
    f.scan(&store);
    let before = f.snapshot();
    let (id, revision) = exemplar(&store, "FS", None);
    let entry =
        serde_json::to_value(store.prepare_editor_entry(&id, revision, "edit").unwrap()).unwrap();
    assert_eq!(entry["kind"], "pack");
    assert_eq!(entry["format"], "fsDirectory");
    let page = store.list_entries(200, None).unwrap();
    let child = page
        .items
        .iter()
        .flat_map(|c| c["exemplars"].as_array().unwrap())
        .find(|e| {
            e["locator"]["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("multi.zip"))
                && e["locator"]["member"].is_string()
        })
        .unwrap();
    let entry = serde_json::to_value(
        store
            .prepare_editor_entry(
                child["id"].as_str().unwrap(),
                page.catalogue_revision,
                "edit",
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(before, f.snapshot());
    std::fs::write(
        f.source().join("multi.zip"),
        zip_bytes(&pack_entries("", "Archive remplacée")),
    )
    .unwrap();
    let error = super::editor_entry::extract_child(
        entry["containerPath"].as_str().unwrap(),
        entry["containerFingerprint"].as_str().unwrap(),
        entry["childId"].as_str().unwrap(),
        &Arc::new(super::editor_extractions::Registry::new(
            super::editor_extractions::root(&f.0.join("cache")),
        )),
        &uuid::Uuid::new_v4().to_string(),
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_TARGET_REVISION_CHANGED);
    assert!(!f.0.join("cache/catalogue-children").exists());
}

#[test]
fn generation_rejects_output_replaced_during_scan_lock() {
    let f = Fixture::new();
    let project = f.source().join("project.mbah");
    let output = f.source().join("output.zip");
    let generated = json!({"projectType":"pack","projectName":"A","rootEntries":[]}).to_string();
    std::fs::write(&project, &generated).unwrap();
    std::fs::write(&output, zip_bytes(&pack_entries("", "Generated A"))).unwrap();
    let store = f.open();
    f.scan(&store);
    let proof = super::generation::output_fingerprint(&output).unwrap();
    let registry =
        crate::services::catalogue::writes::Registry::new(Duration::ZERO, Duration::ZERO);
    let heavy = store.scans.heavy.lock().unwrap();
    let recorded = std::thread::scope(|scope| {
        let (started, waiting) = std::sync::mpsc::channel();
        let (store, project, output, f, registry, generated, proof) =
            (&store, &project, &output, &f, &registry, &generated, &proof);
        let worker = scope.spawn(move || {
            started.send(()).unwrap();
            store
                .record_generation(
                    project,
                    output,
                    &f.0.join("cache"),
                    &f.0.join("data"),
                    registry,
                    Some(generated),
                    Some(proof),
                )
                .unwrap()
        });
        waiting.recv().unwrap();
        // The publication proof is already immutable; the worker cannot refresh
        // or attest this replacement while the scan lock is held.
        std::fs::write(
            output,
            zip_bytes(&pack_entries(
                "",
                "Foreign replacement with different contents",
            )),
        )
        .unwrap();
        drop(heavy);
        worker.join().unwrap()
    });
    assert!(!recorded.recorded);
    assert_eq!(recorded.reason, Some("outputChanged"));
    let receipts: i64 = store
        .read(|c| c.query_row("SELECT count(*) FROM generation_receipt", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(receipts, 0);
    std::fs::write(
        &project,
        json!({"projectType":"pack","projectName":"B","rootEntries":[]}).to_string(),
    )
    .unwrap();
    f.scan(&store);
    let page = store.list_entries(200, None).unwrap();
    let project = page
        .items
        .iter()
        .flat_map(|card| card["exemplars"].as_array().unwrap())
        .find(|e| e["format"] == "project")
        .unwrap();
    assert_eq!(project["generation"]["state"], "unknown");
}

#[test]
fn generation_publication_envelope_preserves_result_and_immutable_fingerprint() {
    let f = Fixture::new();
    let output = f.source().join("published.zip");
    std::fs::write(&output, b"published bytes").unwrap();
    let proof = super::generation::output_fingerprint(&output).unwrap();
    let published =
        super::generation::Published::capture(json!({"zipPath":output,"warnings":[]}), &output);
    std::fs::write(&output, b"replacement bytes").unwrap();
    let ipc = serde_json::to_value(published).unwrap();
    assert_eq!(ipc["zipPath"], json!(output));
    assert_eq!(ipc["warnings"], json!([]));
    assert_eq!(ipc["outputFingerprint"], proof);
    assert_ne!(
        super::generation::output_fingerprint(&output).unwrap(),
        proof
    );
    let missing = super::generation::Published::capture(
        json!({"zipPath":"missing"}),
        &f.source().join("missing.zip"),
    );
    assert_eq!(
        serde_json::to_value(missing).unwrap()["outputFingerprint"],
        Value::Null
    );
}

#[test]
fn assembly_mixed_archives_children_fs_and_projects_preserves_sources() {
    use crate::services::catalogue::assembly::{Request, Selection};
    let f = Fixture::new();
    populate(&f);
    let make_cover = |color: [u8; 3]| {
        let image =
            image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 2, image::Rgb(color)));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    };
    let mut children = pack_entries("A/", "Enfant A");
    children.push(("A/thumbnail.png".into(), make_cover([255, 0, 0])));
    children.extend(pack_entries("B/", "Enfant B"));
    let mut nested = pack_entries("", "Enfant C");
    nested.push(("thumbnail.png".into(), make_cover([0, 0, 255])));
    children.push(("C.zip".into(), zip_bytes(&nested)));
    std::fs::write(f.source().join("multi.zip"), zip_bytes(&children)).unwrap();
    crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&f.source().join("FS"));
    let before = f.snapshot();
    let store = f.open();
    f.scan(&store);
    let cards = serde_json::to_value(store.list_entries(100, None).unwrap()).unwrap();
    let selection = cards["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| Selection {
            fiche_id: card["id"].as_str().unwrap().into(),
            expected_fiche_revision: card["ficheRevision"].as_i64().unwrap(),
        })
        .collect();
    let receipt = store
        .prepare_assembly(
            Request {
                ordered_selection: selection,
                exemplar_choices: Default::default(),
                request_id: uuid::Uuid::new_v4().to_string(),
            },
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let until = std::time::Instant::now() + crate::test_support::timeout();
    let done = loop {
        let progress = store
            .get_operation(receipt["operationId"].as_str().unwrap())
            .unwrap();
        if ["success", "failed", "partial", "cancelled"].contains(&progress.status.as_str()) {
            break progress;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(done.status, "success", "{:?}", done.error);
    let result = done.result.unwrap();
    assert!(result["entries"].as_array().unwrap().len() >= 8);
    assert_eq!(result["excluded"].as_array().unwrap().len(), 2);
    assert!(result["excluded"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["reason"] == "generateFirst"));
    for entry in result["entries"].as_array().unwrap() {
        assert!(Path::new(entry["zipPath"].as_str().unwrap()).is_file());
        if let Some(cover) = entry["coverPath"].as_str() {
            assert!(Path::new(cover).is_file());
        }
    }
    let covers: Vec<_> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["coverPath"].as_str())
        .map(|path| std::fs::read(path).unwrap())
        .collect();
    assert!(covers
        .iter()
        .all(|bytes| image::guess_format(bytes).unwrap() == image::ImageFormat::Jpeg));
    let pixels: Vec<_> = covers
        .iter()
        .map(|bytes| {
            image::load_from_memory(bytes)
                .unwrap()
                .to_rgb8()
                .get_pixel(0, 0)
                .0
        })
        .collect();
    assert!(
        pixels.iter().any(|p| p[0] > 240 && p[2] < 20),
        "direct child retains its red cover"
    );
    assert!(
        pixels.iter().any(|p| p[2] > 240 && p[0] < 20),
        "nested archive retains its blue cover"
    );
    assert_eq!(before, f.snapshot());
    store
        .release_assembly(result["preparationId"].as_str().unwrap())
        .unwrap();
    for entry in result["entries"].as_array().unwrap() {
        assert!(!Path::new(entry["zipPath"].as_str().unwrap()).exists());
    }
}

#[test]
fn assembly_zip_wins_while_cover_comes_from_reference_folder() {
    use crate::services::catalogue::assembly::{Request, Selection};
    let f = Fixture::new();
    let mut entries = pack_entries("", "Shared");
    entries.push(("thumbnail.png".into(), b"zip cover".to_vec()));
    let mut value: Value = serde_json::from_slice(&entries[0].1).unwrap();
    value["uuid"] = json!("bda17862-0d71-41f6-974a-111111111111");
    entries[0].1 = serde_json::to_vec(&value).unwrap();
    std::fs::write(f.source().join("direct.zip"), zip_bytes(&entries)).unwrap();
    write_tree(&f.source().join("Dossier"), &entries);
    let mut cover_bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 2)
        .write_to(&mut cover_bytes, image::ImageFormat::Png)
        .unwrap();
    std::fs::write(
        f.source().join("Dossier/thumbnail.png"),
        cover_bytes.into_inner(),
    )
    .unwrap();
    let before = f.snapshot();
    let store = f.open();
    f.scan(&store);
    let (folder, _) = exemplar(&store, "Dossier", None);
    let (zip, _) = exemplar(&store, "direct.zip", None);
    let cards = serde_json::to_value(store.list_entries(100, None).unwrap()).unwrap();
    assert_eq!(cards["items"].as_array().unwrap().len(), 1);
    let id = cards["items"][0]["id"].as_str().unwrap();
    store
        .write(|tx| crate::services::catalogue::data::mutate::reference::select(tx, id, &folder))
        .unwrap();
    let detail = store.get_card(id).unwrap();
    let receipt = store
        .prepare_assembly(
            Request {
                ordered_selection: vec![Selection {
                    fiche_id: id.into(),
                    expected_fiche_revision: detail["ficheRevision"].as_i64().unwrap(),
                }],
                exemplar_choices: [(id.to_owned(), folder)].into(),
                request_id: uuid::Uuid::new_v4().to_string(),
            },
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let until = Instant::now() + crate::test_support::timeout();
    let done = loop {
        let p = store
            .get_operation(receipt["operationId"].as_str().unwrap())
            .unwrap();
        if ["success", "failed", "cancelled"].contains(&p.status.as_str()) {
            break p;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(done.status, "success", "{:?}", done.error);
    let result = done.result.unwrap();
    assert_eq!(result["entries"][0]["exemplarId"], zip);
    let cover = std::fs::read(result["entries"][0]["coverPath"].as_str().unwrap()).unwrap();
    assert_eq!(
        image::guess_format(&cover).unwrap(),
        image::ImageFormat::Jpeg
    );
    assert_eq!(image::load_from_memory(&cover).unwrap().width(), 1600);
    assert_eq!(before, f.snapshot());
    store
        .release_assembly(result["preparationId"].as_str().unwrap())
        .unwrap();
}

#[test]
fn catalogue_import_metadata_uses_opened_path_member_and_effective_corrections() {
    use super::import_metadata::Source;
    let f = Fixture::new();
    // Distinct pack identities prevent an accidental UUID-only match.
    let mut a = pack_entries("", "A");
    let mut b = pack_entries("", "B");
    for (entries, uuid) in [
        (&mut a, "11111111-1111-4111-8111-111111111111"),
        (&mut b, "22222222-2222-4222-8222-222222222222"),
    ] {
        let story = entries
            .iter_mut()
            .find(|(name, _)| name == "story.json")
            .unwrap();
        let mut raw: Value = serde_json::from_slice(&story.1).unwrap();
        raw["stageNodes"][0]["uuid"] = json!(uuid);
        story.1 = serde_json::to_vec(&raw).unwrap();
    }
    std::fs::write(f.source().join("a.zip"), zip_bytes(&a)).unwrap();
    std::fs::write(
        f.source().join("bundle.zip"),
        zip_bytes(&[
            ("A.zip".into(), zip_bytes(&a)),
            ("B.zip".into(), zip_bytes(&b)),
        ]),
    )
    .unwrap();
    write_tree(&f.source().join("folder"), &a);
    let staging = f.0.join("staging");
    write_tree(&staging, &a);
    seven_zip(&f.source().join("a.7z"), &staging);
    std::fs::write(
        f.source().join("known.mbah"),
        json!({"projectType":"pack","packMetadata":{"title":"Projet"},"rootEntries":[]})
            .to_string(),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    assert!(store
        .imported_metadata(
            &Source::direct(&f.source().join("a.7z").to_string_lossy()),
            false
        )
        .unwrap()
        .is_some());
    assert!(store
        .imported_metadata(
            &Source::direct(&f.source().join("known.mbah").to_string_lossy()),
            true
        )
        .unwrap()
        .is_none());
    let source = Source::direct(&f.source().join("a.zip").to_string_lossy());
    let metadata = store.imported_metadata(&source, false).unwrap().unwrap();
    assert_eq!(metadata.values["title"], "A");
    let (id, _) = exemplar(&store, "a.zip", None);
    let fiche: String = store
        .read(|c| {
            c.query_row("SELECT fiche_id FROM exemplar WHERE id=?1", [&id], |r| {
                r.get(0)
            })
        })
        .unwrap();
    // Exercise the mutation and resolver used by the fiche.
    use crate::services::catalogue::data::mutate::metadata::{self, Change};
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 4)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let staged = store.stage_cover_bytes(png.get_ref()).unwrap();
    let mut changes: Vec<_> = [
        ("title", json!("Corrigé")),
        ("ageMin", json!(6)),
        ("author", json!("Auteur")),
        ("description", json!("Description")),
    ]
    .into_iter()
    .map(|(field, value)| Change {
        field: field.into(),
        language: None,
        state: "defined".into(),
        value: Some(value),
        cover_staging_id: None,
    })
    .collect();
    changes.push(Change {
        field: "ageMax".into(),
        language: None,
        state: "cleared".into(),
        value: None,
        cover_staging_id: None,
    });
    changes.push(Change {
        field: "cover".into(),
        language: None,
        state: "defined".into(),
        value: None,
        cover_staging_id: staged["coverStagingId"].as_str().map(str::to_owned),
    });
    store
        .write(|tx| metadata::apply(&store, tx, &fiche, &changes))
        .unwrap();
    let metadata = store.imported_metadata(&source, false).unwrap().unwrap();
    assert_eq!(
        metadata.values,
        json!({"title":"Corrigé","minAge":6,"author":"Auteur","description":"Description"})
    );
    let metadata = store.imported_metadata(&source, true).unwrap().unwrap();
    let cover = metadata.cover.clone().expect("fiche cover");
    let dest = f.0.join("project-assets");
    let mut result = json!({"rootImage":"entry.png"});
    metadata.apply(&dest, &mut result);
    let copied = result["thumbnailImage"].as_str().unwrap();
    assert_eq!(std::fs::read(copied).unwrap(), cover);
    assert!(Path::new(copied).starts_with(&dest));
    let mut existing = json!({"thumbnailImage":"pack-thumbnail.png"});
    store
        .imported_metadata(&source, true)
        .unwrap()
        .unwrap()
        .apply(&f.0.join("must-not-exist"), &mut existing);
    assert_eq!(existing["thumbnailImage"], "pack-thumbnail.png");
    assert!(!f.0.join("must-not-exist").exists());
    let project = f.source().join("reopened.mbah");
    std::fs::write(&project, b"{}").unwrap();
    assert!(store
        .imported_metadata(&Source::direct(&project.to_string_lossy()), true)
        .unwrap()
        .is_none());
    // A byte-identical copy outside scanned sources has no fiche.
    let unknown = f.0.join("unknown.zip");
    std::fs::copy(&source.path, &unknown).unwrap();
    assert!(store
        .imported_metadata(&Source::direct(&unknown.to_string_lossy()), false)
        .unwrap()
        .is_none());
    assert!(store
        .imported_metadata(
            &Source::direct(&f.source().join("folder").to_string_lossy()),
            false
        )
        .unwrap()
        .is_some());
    let page = store.list_entries(200, None).unwrap();
    let mut children = 0;
    for item in page.items {
        for e in item["exemplars"].as_array().unwrap() {
            if e["locator"]["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("bundle.zip"))
            {
                let child = Source {
                    path: f.source().join("bundle.zip"),
                    child_id: Some(format!(
                        "catalogue:{}",
                        e["locator"]["memberKey"].as_str().unwrap()
                    )),
                    fingerprint: Some(
                        crate::support::imported_pack::bundle_container_fingerprint(
                            &f.source().join("bundle.zip").to_string_lossy(),
                        )
                        .unwrap(),
                    ),
                };
                children += 1;
                let selected = store.imported_metadata(&child, false).unwrap().unwrap();
                let expected_title = if e["locator"]["member"] == "A.zip" {
                    "Corrigé"
                } else {
                    "B"
                };
                assert_eq!(selected.values["title"], expected_title);
                let ordinary = Source {
                    child_id: Some(crate::support::imported_pack::bundle_child_identity(
                        e["locator"]["member"].as_str().unwrap(),
                    )),
                    ..child.clone()
                };
                assert_eq!(
                    store
                        .imported_metadata(&ordinary, false)
                        .unwrap()
                        .unwrap()
                        .values,
                    store
                        .imported_metadata(&child, false)
                        .unwrap()
                        .unwrap()
                        .values
                );
                let mut stale = child.clone();
                stale.fingerprint = Some("stale".into());
                assert!(store.imported_metadata(&stale, false).unwrap().is_none());
            }
        }
    }
    assert_eq!(children, 2);
    std::fs::write(&source.path, b"changed").unwrap();
    assert!(store.imported_metadata(&source, false).unwrap().is_none());
}

#[test]
fn catalogue_import_ignores_filename_titles_and_missing_cover_without_writes() {
    use super::import_metadata::Source;
    let f = Fixture::new();
    let mut entries = pack_entries("", "");
    let mut raw: Value = serde_json::from_slice(&entries[0].1).unwrap();
    raw.as_object_mut().unwrap().remove("title");
    entries[0].1 = serde_json::to_vec(&raw).unwrap();
    std::fs::write(f.source().join("visible.zip"), zip_bytes(&entries)).unwrap();
    let store = f.open();
    f.scan(&store);
    let source = Source::direct(&f.source().join("visible.zip").to_string_lossy());
    let (id, _) = exemplar(&store, "visible.zip", None);
    let fiche: String = store
        .read(|c| {
            c.query_row("SELECT fiche_id FROM exemplar WHERE id=?1", [&id], |r| {
                r.get(0)
            })
        })
        .unwrap();
    store
        .read_snapshot(|c| {
            let resolved = crate::services::catalogue::data::card::resolution(
                c,
                &fiche,
                &["Autre exemplaire.zip".into()],
            )?;
            assert!(resolved
                .fields
                .iter()
                .any(|f| f.field == "title" && f.effective["origin"] == "filename"));
            Ok(())
        })
        .unwrap();
    let before = store.list_sources().unwrap().catalogue_revision;
    let cache = snapshot(&f.0.join("cache"));
    let result = store.imported_metadata(&source, true).unwrap().unwrap();
    assert!(result.values.get("title").is_none());
    assert!(result.cover.is_none());
    assert_eq!(store.list_sources().unwrap().catalogue_revision, before);
    assert_eq!(snapshot(&f.0.join("cache")), cache);
}

#[test]
fn catalogue_import_nested_envelope_with_two_candidates_has_no_card() {
    use super::import_metadata::Source;
    let f = Fixture::new();
    let nested = zip_bytes(&[
        ("A.zip".into(), zip_bytes(&pack_entries("", "A"))),
        ("B.zip".into(), zip_bytes(&pack_entries("", "B"))),
    ]);
    let path = f.source().join("outer.zip");
    std::fs::write(&path, zip_bytes(&[("nested.zip".into(), nested)])).unwrap();
    let store = f.open();
    f.scan(&store);
    let count: i64 = store
        .read(|c| {
            c.query_row("SELECT count(*) FROM exemplar WHERE retired=0", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(count, 2, "the nested envelope must expose both candidates");
    let source = Source {
        path,
        child_id: Some(crate::support::imported_pack::bundle_child_identity(
            "nested.zip",
        )),
        fingerprint: None,
    };
    assert!(store.imported_metadata(&source, true).unwrap().is_none());
}

#[test]
fn catalogue_import_reads_only_already_cached_project_cover() {
    use super::import_metadata::Source;
    let f = Fixture::new();
    let uuid = "11111111-1111-4111-8111-111111111111";
    let mut entries = pack_entries("", "Pack");
    let mut raw: Value = serde_json::from_slice(&entries[0].1).unwrap();
    raw["stageNodes"][0]["uuid"] = json!(uuid);
    entries[0].1 = serde_json::to_vec(&raw).unwrap();
    std::fs::write(f.source().join("pack.zip"), zip_bytes(&entries)).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 4)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let cover = f.source().join("chosen.png");
    std::fs::write(&cover, png.get_ref()).unwrap();
    std::fs::write(f.source().join("project.mbah"), json!({"projectType":"pack","packMetadata":{"uuid":uuid,"title":"Pack"},"rootEntries":[],"thumbnailImage":cover,"sameImage":false}).to_string()).unwrap();
    let store = f.open();
    f.scan(&store);
    let source = Source::direct(&f.source().join("pack.zip").to_string_lossy());
    assert!(store
        .imported_metadata(&source, true)
        .unwrap()
        .unwrap()
        .cover
        .is_none());
    let (project, _) = exemplar(&store, "project.mbah", None);
    let expected = store
        .get_thumbnail(Some(&project), None, None)
        .unwrap()
        .bytes
        .unwrap();
    let cached = snapshot(&f.0.join("cache/catalogue/thumbnails"));
    let mtimes: Vec<_> = cached
        .iter()
        .map(|(p, _)| std::fs::metadata(p).unwrap().modified().unwrap())
        .collect();
    let revision = store.list_sources().unwrap().catalogue_revision;
    assert_eq!(
        store
            .imported_metadata(&source, true)
            .unwrap()
            .unwrap()
            .cover,
        Some(expected)
    );
    assert_eq!(store.list_sources().unwrap().catalogue_revision, revision);
    assert_eq!(snapshot(&f.0.join("cache/catalogue/thumbnails")), cached);
    assert_eq!(
        cached
            .iter()
            .map(|(p, _)| std::fs::metadata(p).unwrap().modified().unwrap())
            .collect::<Vec<_>>(),
        mtimes
    );
}
