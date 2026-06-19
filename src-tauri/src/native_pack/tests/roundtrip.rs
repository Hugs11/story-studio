use super::*;
use crate::services::pack_reader::unpack_zip_to_entries;
use std::path::{Path, PathBuf};

fn canonical_options() -> CanonicalOptions {
    CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Off,
        harmonize_loudness: true,
        auto_next: false,
        select_next: false,
        night_mode: false,
    }
}

fn temp_roundtrip_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "story_studio_roundtrip_{}_{}_{}",
        name,
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&dir).expect("create roundtrip dir");
    dir
}

fn write_asset(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create asset parent");
    }
    fs::write(path, contents).expect("write asset");
}

fn temp_prepared_asset(base: &Path, role: &str, staged_asset_name: &str) -> PreparedAsset {
    let staged_path = base.join("stage").join(staged_asset_name);
    write_asset(&staged_path, staged_asset_name.as_bytes());
    PreparedAsset {
        role: role.to_string(),
        source_path: staged_path.to_string_lossy().to_string(),
        source_kind: "test".to_string(),
        staged_asset_name: staged_asset_name.to_string(),
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed: false,
        deduplicated: false,
    }
}

fn generated_zip_import(
    base: &Path,
    project: CanonicalProject,
    assets: Vec<PreparedAsset>,
) -> serde_json::Value {
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");
    let zip_path = write_native_pack_zip(&report, &document, &base.join("out")).expect("write zip");
    unpack_zip_to_entries(
        zip_path.to_str().expect("zip path utf8"),
        base.join("imported").to_str().expect("import dir utf8"),
    )
    .expect("unpack generated zip")
}

#[test]
fn generated_basic_pack_roundtrips_to_project_entries() {
    let base = temp_roundtrip_dir("basic");
    let root_image_source = base.join("source-cover.png");
    write_test_png(&root_image_source);

    let imported = generated_zip_import(
        &base,
        CanonicalProject {
            name: "Roundtrip Basic".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some(root_image_source.to_string_lossy().to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: canonical_options(),
            entries: vec![CanonicalEntry::Story(CanonicalStory {
                name: "Story Alpha".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: Some("item.mp3".to_string()),
                item_image: Some("item.png".to_string()),
                ..Default::default()
            })],
        },
        vec![
            temp_prepared_asset(&base, "rootAudio", "root.mp3"),
            temp_prepared_asset(&base, "rootImage", "cover.png"),
            temp_prepared_asset(&base, "root/Story Alpha/itemAudio", "item.mp3"),
            temp_prepared_asset(&base, "root/Story Alpha/itemImage", "item.png"),
            temp_prepared_asset(&base, "root/Story Alpha/storyAudio", "story.mp3"),
        ],
    );

    assert_eq!(imported["title"], "Roundtrip Basic");
    assert!(imported["rootAudio"].as_str().is_some());
    assert!(imported["rootImage"].as_str().is_some());
    let entries = imported["entries"].as_array().expect("entries array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["type"], "story");
    assert_eq!(entries[0]["name"], "Roundtrip Basic");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn generated_night_mode_pack_roundtrips_end_node_metadata() {
    let base = temp_roundtrip_dir("nightmode");
    let root_image_source = base.join("source-cover.png");
    write_test_png(&root_image_source);

    let mut options = canonical_options();
    options.night_mode = true;

    let imported = generated_zip_import(
        &base,
        CanonicalProject {
            name: "Roundtrip Night".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some(root_image_source.to_string_lossy().to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options,
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                name: "Choose a story".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![CanonicalEntry::Story(CanonicalStory {
                    name: "Story Beta".to_string(),
                    audio: Some("story.mp3".to_string()),
                    item_audio: Some("item.mp3".to_string()),
                    item_image: Some("item.png".to_string()),
                    ..Default::default()
                })],
                ..Default::default()
            })],
        },
        vec![
            temp_prepared_asset(&base, "rootAudio", "root.mp3"),
            temp_prepared_asset(&base, "rootImage", "cover.png"),
            temp_prepared_asset(&base, "nightModeAudio", "night.mp3"),
            temp_prepared_asset(&base, "root/Choose a story/menuAudio", "menu.mp3"),
            temp_prepared_asset(&base, "root/Choose a story/menuImage", "menu.png"),
            temp_prepared_asset(
                &base,
                "root/Choose a story/Story Beta/itemAudio",
                "item.mp3",
            ),
            temp_prepared_asset(
                &base,
                "root/Choose a story/Story Beta/itemImage",
                "item.png",
            ),
            temp_prepared_asset(
                &base,
                "root/Choose a story/Story Beta/storyAudio",
                "story.mp3",
            ),
        ],
    );

    assert_eq!(imported["title"], "Roundtrip Night");
    assert_eq!(imported["nightMode"], true);
    assert!(imported["nightModeAudio"].as_str().is_some());
    assert!(imported.to_string().contains("Story Beta"));

    let _ = fs::remove_dir_all(base);
}

#[test]
fn imported_branching_graph_preserves_native_graph_for_roundtrip() {
    let base = temp_roundtrip_dir("native_graph");
    let zip_path = base.join("native-graph-roundtrip.zip");
    let story_json = serde_json::json!({
        "title": "Roundtrip Graph",
        "version": 1,
        "description": "",
        "format": "v1",
        "nightModeAvailable": false,
        "stageNodes": [
            {
                "uuid": "root-stage",
                "name": "Depart",
                "type": "stage",
                "squareOne": true,
                "audio": "root.mp3",
                "image": "cover.png",
                "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "homeTransition": null,
                "position": { "x": 0, "y": 0 }
            },
            {
                "uuid": "play-stage",
                "name": "Menu avec retour non modelise",
                "type": "stage",
                "squareOne": false,
                "audio": "play.mp3",
                "image": "play.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "choice-action", "optionIndex": 0 },
                "homeTransition": { "actionNode": "ghost-action", "optionIndex": 0 },
                "position": { "x": 120, "y": 0 }
            },
            {
                "uuid": "branch-stage",
                "name": "Branchement natif",
                "type": "stage",
                "squareOne": false,
                "audio": null,
                "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": false, "autoplay": true },
                "okTransition": { "actionNode": "choice-action", "optionIndex": 0 },
                "homeTransition": null,
                "position": { "x": 120, "y": 160 }
            },
            {
                "uuid": "choice-a",
                "name": "Choix A",
                "type": "stage",
                "squareOne": false,
                "audio": "a.mp3",
                "image": "a.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "ghost-action", "optionIndex": 0 },
                "position": { "x": 240, "y": -80 }
            },
            {
                "uuid": "choice-b",
                "name": "Choix B",
                "type": "stage",
                "squareOne": false,
                "audio": "b.mp3",
                "image": "b.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": null,
                "homeTransition": null,
                "position": { "x": 240, "y": 80 }
            }
        ],
        "actionNodes": [
            { "id": "root-action", "name": "Root", "options": ["play-stage"], "position": { "x": 80, "y": 0 } },
            { "id": "choice-action", "name": "Choices", "options": ["choice-a", "choice-b"], "position": { "x": 180, "y": 0 } },
            { "id": "ghost-action", "name": "Unresolved", "options": ["ghost-stage"], "position": { "x": 320, "y": -80 } }
        ]
    });

    let file = fs::File::create(&zip_path).expect("create graph zip");
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("story.json", opts).expect("start story");
    zip.write_all(story_json.to_string().as_bytes())
        .expect("write story");
    for asset in [
        "root.mp3",
        "cover.png",
        "play.mp3",
        "play.png",
        "a.mp3",
        "a.png",
        "b.mp3",
        "b.png",
    ] {
        zip.start_file(format!("assets/{asset}"), opts)
            .expect("start asset");
        zip.write_all(asset.as_bytes()).expect("write asset");
    }
    zip.finish().expect("finish graph zip");

    let imported = unpack_zip_to_entries(
        zip_path.to_str().expect("zip path utf8"),
        base.join("imported").to_str().expect("import dir utf8"),
    )
    .expect("unpack graph zip");

    assert_eq!(imported["title"], "Roundtrip Graph");
    assert_eq!(imported["nativeGraph"]["preserveForRoundTrip"], true);
    assert_eq!(imported["nativeGraph"]["projectionStatus"], "lossy");
    assert_eq!(imported["entries"][0]["type"], "menu");
    assert_eq!(imported["entries"][0]["children"][0]["type"], "story");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn modeled_branching_graph_does_not_trigger_native_graph() {
    let base = temp_roundtrip_dir("modeled_branching_graph");
    let zip_path = base.join("modeled-branching-graph.zip");
    let story_json = serde_json::json!({
        "title": "Modeled Graph",
        "version": 1,
        "description": "",
        "format": "v1",
        "nightModeAvailable": false,
        "stageNodes": [
            {
                "uuid": "root-stage",
                "name": "Depart",
                "type": "stage",
                "squareOne": true,
                "audio": "root.mp3",
                "image": "cover.png",
                "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "homeTransition": null,
                "position": { "x": 0, "y": 0 }
            },
            {
                "uuid": "play-stage",
                "name": "Lecture",
                "type": "stage",
                "squareOne": false,
                "audio": "play.mp3",
                "image": "play.png",
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": false, "autoplay": true },
                "okTransition": { "actionNode": "choice-action", "optionIndex": 0 },
                "homeTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "position": { "x": 120, "y": 0 }
            },
            {
                "uuid": "choice-a",
                "name": "Choix A",
                "type": "stage",
                "squareOne": false,
                "audio": "a.mp3",
                "image": "a.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "position": { "x": 240, "y": -80 }
            },
            {
                "uuid": "choice-b",
                "name": "Choix B",
                "type": "stage",
                "squareOne": false,
                "audio": "b.mp3",
                "image": "b.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "position": { "x": 240, "y": 80 }
            }
        ],
        "actionNodes": [
            { "id": "root-action", "name": "Root", "options": ["play-stage"], "position": { "x": 80, "y": 0 } },
            { "id": "choice-action", "name": "Choices", "options": ["choice-a", "choice-b"], "position": { "x": 180, "y": 0 } }
        ]
    });

    let file = fs::File::create(&zip_path).expect("create graph zip");
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("story.json", opts).expect("start story");
    zip.write_all(story_json.to_string().as_bytes())
        .expect("write story");
    for asset in [
        "root.mp3",
        "cover.png",
        "play.mp3",
        "play.png",
        "a.mp3",
        "a.png",
        "b.mp3",
        "b.png",
    ] {
        zip.start_file(format!("assets/{asset}"), opts)
            .expect("start asset");
        zip.write_all(asset.as_bytes()).expect("write asset");
    }
    zip.finish().expect("finish graph zip");

    let imported = unpack_zip_to_entries(
        zip_path.to_str().expect("zip path utf8"),
        base.join("imported").to_str().expect("import dir utf8"),
    )
    .expect("unpack graph zip");

    assert_eq!(imported["title"], "Modeled Graph");
    assert!(imported["nativeGraph"].is_null());
    assert_eq!(imported["advancedTransitionsDetected"], false);
    assert_eq!(
        imported["unresolvedTransitions"].as_array().unwrap().len(),
        0
    );
    assert_eq!(imported["entries"][0]["type"], "menu");

    let _ = fs::remove_dir_all(base);
}
