use super::*;
use crate::services::pack_reader::unpack_zip_to_entries_unchecked as unpack_zip_to_entries;
use std::path::{Path, PathBuf};

fn canonical_options() -> CanonicalOptions {
    CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Off,
        harmonize_loudness: true,
        auto_next: false,
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

/// Garde directe sur le VRAI projecteur (`GraphProjector`, pas le classifieur de design) :
/// un stage atteignable UNIQUEMENT par une arête Home/global ne doit jamais entrer dans
/// l'arbre couvrant (qui ne suit que les arêtes OK). Type d'architecture.
#[test]
fn graph_projection_excludes_home_only_global_stage_from_tree() {
    let base = temp_roundtrip_dir("home_only_global");
    let zip_path = base.join("home-only-global.zip");
    let story_json = serde_json::json!({
        "title": "Home Only Global",
        "version": 1,
        "description": "",
        "format": "v1",
        "nightModeAvailable": true,
        "stageNodes": [
            {
                "uuid": "root-stage", "name": "Depart", "type": "stage", "squareOne": true,
                "audio": "root.mp3", "image": "cover.png",
                "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "homeTransition": null, "position": { "x": 0, "y": 0 }
            },
            {
                "uuid": "play-stage", "name": "Lecture", "type": "stage", "squareOne": false,
                "audio": "play.mp3", "image": "play.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "choice-action", "optionIndex": 0 },
                "homeTransition": { "actionNode": "global-action", "optionIndex": 0 },
                "position": { "x": 120, "y": 0 }
            },
            {
                "uuid": "choice-a", "name": "Choix A", "type": "stage", "squareOne": false,
                "audio": "a.mp3", "image": "a.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "global-action", "optionIndex": 0 },
                "position": { "x": 240, "y": -80 }
            },
            {
                "uuid": "choice-b", "name": "Choix B", "type": "stage", "squareOne": false,
                "audio": "b.mp3", "image": "b.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "ghost-action", "optionIndex": 0 },
                "position": { "x": 240, "y": 80 }
            },
            {
                "uuid": "global-night", "name": "Nuit globale", "type": "stage", "squareOne": false,
                "audio": "night.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": false, "autoplay": true },
                "okTransition": null, "homeTransition": null,
                "position": { "x": 360, "y": 0 }
            }
        ],
        "actionNodes": [
            { "id": "root-action", "name": "Root", "options": ["play-stage"], "position": { "x": 80, "y": 0 } },
            { "id": "choice-action", "name": "Choices", "options": ["choice-a", "choice-b"], "position": { "x": 180, "y": 0 } },
            // Cible Home/global : atteinte UNIQUEMENT par homeTransition, jamais par OK.
            { "id": "global-action", "name": "Global", "options": ["global-night"], "position": { "x": 300, "y": 0 } },
            // Transition non résolue → déclenche la projection GraphProjector.
            { "id": "ghost-action", "name": "Unresolved", "options": ["ghost-stage"], "position": { "x": 320, "y": 80 } }
        ]
    });

    let file = fs::File::create(&zip_path).expect("create zip");
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("story.json", opts).expect("start story");
    zip.write_all(story_json.to_string().as_bytes()).expect("write story");
    for asset in ["root.mp3", "cover.png", "play.mp3", "play.png", "a.mp3", "a.png", "b.mp3", "b.png", "night.mp3"] {
        zip.start_file(format!("assets/{asset}"), opts).expect("start asset");
        zip.write_all(asset.as_bytes()).expect("write asset");
    }
    zip.finish().expect("finish zip");

    let imported = unpack_zip_to_entries(
        zip_path.to_str().expect("zip path utf8"),
        base.join("imported").to_str().expect("import dir utf8"),
    )
    .expect("unpack zip");

    // Aplatit l'arbre projeté et vérifie qu'aucun nœud ne correspond au stage Home/global.
    fn collect_ids(entries: &serde_json::Value, out: &mut Vec<String>) {
        if let Some(array) = entries.as_array() {
            for entry in array {
                if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                    out.push(id.to_string());
                }
                if let Some(native) = entry.get("nativeStageId").and_then(|v| v.as_str()) {
                    out.push(native.to_string());
                }
                if let Some(children) = entry.get("children") {
                    collect_ids(children, out);
                }
            }
        }
    }
    let mut ids = Vec::new();
    collect_ids(&imported["entries"], &mut ids);
    assert!(
        !ids.iter().any(|id| id == "global-night"),
        "un stage atteignable seulement par Home/global ne doit pas entrer dans l'arbre : {ids:?}",
    );
    // L'arbre couvrant (arêtes OK) contient bien les deux choix.
    assert!(
        ids.iter().any(|id| id == "choice-a") && ids.iter().any(|id| id == "choice-b"),
        "les choix atteints par OK doivent être présents : {ids:?}",
    );

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

/// Type d'architecture (aucun nom de pack réel) : un menu-choix dont une option
/// « revisite » une histoire déjà présente — une convergence orpheline modélisée par
/// un nœud `ref`. Attendu Étape 6 : la ref génère une VRAIE transition native vers le
/// stage existant de la cible, sans créer de stage fantôme et sans casser la validité STUdio.
#[test]
fn menu_reference_option_resolves_to_existing_target_stage_without_ghost() {
    let base = temp_roundtrip_dir("ref_option");
    let root_image_source = base.join("source-cover.png");
    write_test_png(&root_image_source);

    // Rôles d'assets calculés via le MÊME helper que le générateur (gère le suffixe #id).
    let menu_label = scoped_label_id("root", "carrefour", "Carrefour");
    let story_a_label = scoped_label_id(&menu_label, "story-a", "Chemin A");
    let story_b_label = scoped_label_id(&menu_label, "story-b", "Chemin B");

    let make_project = |with_ref: bool| {
        let mut children = vec![
            CanonicalEntry::Story(CanonicalStory {
                id: "story-a".to_string(),
                name: "Chemin A".to_string(),
                audio: Some("a.mp3".to_string()),
                ..Default::default()
            }),
            CanonicalEntry::Story(CanonicalStory {
                id: "story-b".to_string(),
                name: "Chemin B".to_string(),
                audio: Some("b.mp3".to_string()),
                ..Default::default()
            }),
        ];
        if with_ref {
            // La 3e option converge (orpheline) vers l'histoire A déjà présente.
            children.push(CanonicalEntry::Ref(CanonicalRef {
                id: "revisite-a".to_string(),
                target: "story:story-a".to_string(),
                ref_kind: Some("continue".to_string()),
            }));
        }
        CanonicalProject {
            name: "Ref Option".to_string(),
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
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children,
                ..Default::default()
            })],
        }
    };

    let assets = || {
        vec![
            temp_prepared_asset(&base, "rootAudio", "root.mp3"),
            temp_prepared_asset(&base, "rootImage", "cover.png"),
            temp_prepared_asset(&base, &format!("{menu_label}/menuAudio"), "menu.mp3"),
            temp_prepared_asset(&base, &format!("{menu_label}/menuImage"), "menu.png"),
            temp_prepared_asset(&base, &format!("{story_a_label}/storyAudio"), "a.mp3"),
            temp_prepared_asset(&base, &format!("{story_b_label}/storyAudio"), "b.mp3"),
        ]
    };

    // build_story_document valide déjà le document pour STUdio (sinon il échoue ici).
    let document = build_story_document(&report_for(make_project(true), assets(), Vec::new()))
        .expect("build with ref");

    // Le menu-choix a 3 options ; la 3e (ref) pointe EXACTEMENT le stage de A (1re option).
    let menu_action = document
        .action_nodes
        .iter()
        .find(|action| action.options.len() == 3)
        .expect("action node du menu avec 3 options");
    assert_eq!(
        menu_action.options[2], menu_action.options[0],
        "la ref doit pointer le stage existant de la cible, jamais un nouveau stage",
    );

    // Une ref hébergée n'ajoute AUCUN stage : même total avec et sans la ref.
    let document_without =
        build_story_document(&report_for(make_project(false), assets(), Vec::new()))
            .expect("build without ref");
    assert_eq!(
        document.stage_nodes.len(),
        document_without.stage_nodes.len(),
        "une ref hébergée n'ajoute aucune ligne ni aucun stage à l'arbre",
    );

    // Round-trip complet : génération → zip → ré-import sans erreur (writer + reader).
    let imported = generated_zip_import(&base, make_project(true), assets());
    assert_eq!(imported["title"], "Ref Option");

    let _ = fs::remove_dir_all(base);
}

/// Type d'architecture (aucun nom de pack réel) : le motif « séquence de fin + choix de
/// convergence » (l'histoire se termine par une séquence dont la dernière étape propose un
/// CHOIX entre plusieurs destinations existantes — le cas qui avait coûté cher sur un pack à
/// queues de fin). Garde : la séquence et le choix de convergence se génèrent, restent STUdio-
/// valides, et le pack round-trip génération→zip→ré-import.
#[test]
fn end_sequence_with_convergence_choice_builds_and_roundtrips() {
    let base = temp_roundtrip_dir("end_sequence_choice");
    let root_image_source = base.join("source-cover.png");
    write_test_png(&root_image_source);

    let menu_label = scoped_label_id("root", "carrefour", "Carrefour");
    let a_label = scoped_label_id(&menu_label, "story-a", "Histoire A");
    let b_label = scoped_label_id(&menu_label, "story-b", "Histoire B");
    let c_label = scoped_label_id(&menu_label, "story-c", "Histoire C");

    let prompt_step = |id: &str, name: &str, autoplay: bool, ok: bool, wheel: bool| {
        CanonicalAfterPlaybackStep {
            id: id.to_string(),
            name: name.to_string(),
            audio: Some(format!("{id}.mp3")),
            image: None,
            control_settings: Some(crate::domain::project::EntryControlSettings {
                autoplay: Some(autoplay),
                wheel: Some(wheel),
                pause: Some(false),
                ok: Some(ok),
                home: Some(false),
            }),
            ok_target: None,
            ok_choice_targets: Vec::new(),
            home_target: None,
            home_follows_ok: false,
            home_none: true,
        }
    };

    let make_project = |with_choice: bool| {
        // Dernière étape : un CHOIX entre deux destinations existantes (convergence), ou
        // une cible unique (variante de contrôle pour isoler l'action node de choix).
        // Les cibles visent des histoires construites AVANT (B, C) : l'action de choix est
        // résolue en ligne contre des stages déjà bâtis (refs arrière).
        let mut last = prompt_step("ensuite", "Et ensuite ?", false, true, true);
        if with_choice {
            last.ok_choice_targets =
                vec!["story_play:story-b".to_string(), "story_play:story-c".to_string()];
        } else {
            last.ok_target = Some("story_play:story-b".to_string());
        }
        let story = |id: &str, name: &str, audio: &str| {
            CanonicalEntry::Story(CanonicalStory {
                id: id.to_string(),
                name: name.to_string(),
                audio: Some(audio.to_string()),
                ..Default::default()
            })
        };
        CanonicalProject {
            name: "Carrefour Sequence".to_string(),
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
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![
                    story("story-b", "Histoire B", "b.mp3"),
                    story("story-c", "Histoire C", "c.mp3"),
                    // L'histoire à séquence de fin vient EN DERNIER : son choix converge
                    // vers B et C, déjà construits.
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-a".to_string(),
                        name: "Histoire A".to_string(),
                        audio: Some("a.mp3".to_string()),
                        after_playback_sequence: vec![
                            prompt_step("cloche", "Cloche", true, false, false),
                            last.clone(),
                        ],
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            })],
        }
    };

    let assets = || {
        vec![
            temp_prepared_asset(&base, "rootAudio", "root.mp3"),
            temp_prepared_asset(&base, "rootImage", "cover.png"),
            temp_prepared_asset(&base, &format!("{menu_label}/menuAudio"), "menu.mp3"),
            temp_prepared_asset(&base, &format!("{menu_label}/menuImage"), "menu.png"),
            temp_prepared_asset(&base, &format!("{b_label}/storyAudio"), "b.mp3"),
            temp_prepared_asset(&base, &format!("{c_label}/storyAudio"), "c.mp3"),
            temp_prepared_asset(&base, &format!("{a_label}/storyAudio"), "a.mp3"),
            temp_prepared_asset(
                &base,
                &format!("{a_label}/afterPlaybackSequence/0/audio"),
                "cloche.mp3",
            ),
            temp_prepared_asset(
                &base,
                &format!("{a_label}/afterPlaybackSequence/1/audio"),
                "ensuite.mp3",
            ),
        ]
    };

    // build_story_document valide déjà le document pour STUdio (sinon il échoue ici).
    let document = build_story_document(&report_for(make_project(true), assets(), Vec::new()))
        .expect("build with convergence choice");

    // Les deux étapes de séquence ont bien généré leurs stages.
    for step_name in ["Cloche", "Et ensuite ?"] {
        assert!(
            document.stage_nodes.iter().any(|stage| stage.name == step_name),
            "étape de séquence « {step_name} » absente du document généré",
        );
    }

    // Le choix de convergence ajoute exactement un action node (vs la variante cible unique).
    let multi_option_actions =
        |doc: &StoryDocument| doc.action_nodes.iter().filter(|a| a.options.len() >= 2).count();
    let document_single =
        build_story_document(&report_for(make_project(false), assets(), Vec::new()))
            .expect("build with single target");
    assert_eq!(
        multi_option_actions(&document),
        multi_option_actions(&document_single) + 1,
        "la dernière étape à choix doit générer un action node de convergence supplémentaire",
    );

    // Round-trip complet : génération → zip → ré-import sans erreur.
    let imported = generated_zip_import(&base, make_project(true), assets());
    assert_eq!(imported["title"], "Carrefour Sequence");
    assert!(
        imported["entries"].as_array().is_some_and(|entries| !entries.is_empty()),
        "le pack ré-importé doit exposer des entrées",
    );

    let _ = fs::remove_dir_all(base);
}

/// Étape 7 : un choix de convergence en fin de séquence qui vise des histoires construites
/// APRÈS (références « en avant »). La résolution inline ne voyait que les cibles arrière ;
/// la résolution préallouée (`preallocated_target_stage`) lève la limite. Type d'architecture.
#[test]
fn end_sequence_convergence_choice_resolves_forward_references() {
    let base = temp_roundtrip_dir("forward_choice");
    let root_image_source = base.join("source-cover.png");
    write_test_png(&root_image_source);

    let menu_label = scoped_label_id("root", "carrefour", "Carrefour");
    let a_label = scoped_label_id(&menu_label, "story-a", "Histoire A");
    let b_label = scoped_label_id(&menu_label, "story-b", "Histoire B");
    let c_label = scoped_label_id(&menu_label, "story-c", "Histoire C");

    let make_project = |with_choice: bool| {
        let last = CanonicalAfterPlaybackStep {
            id: "ensuite".to_string(),
            name: "Et ensuite ?".to_string(),
            audio: Some("ensuite.mp3".to_string()),
            image: None,
            control_settings: Some(crate::domain::project::EntryControlSettings {
                autoplay: Some(false),
                wheel: Some(true),
                pause: Some(false),
                ok: Some(true),
                home: Some(false),
            }),
            ok_target: if with_choice {
                None
            } else {
                Some("story_play:story-b".to_string())
            },
            ok_choice_targets: if with_choice {
                vec!["story_play:story-b".to_string(), "story_play:story-c".to_string()]
            } else {
                Vec::new()
            },
            home_target: None,
            home_follows_ok: false,
            home_none: true,
        };
        let story = |id: &str, name: &str, audio: &str| {
            CanonicalEntry::Story(CanonicalStory {
                id: id.to_string(),
                name: name.to_string(),
                audio: Some(audio.to_string()),
                ..Default::default()
            })
        };
        CanonicalProject {
            name: "Carrefour Forward".to_string(),
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
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![
                    // L'histoire à séquence vient EN PREMIER : ses cibles (B, C) sont bâties APRÈS.
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-a".to_string(),
                        name: "Histoire A".to_string(),
                        audio: Some("a.mp3".to_string()),
                        after_playback_sequence: vec![last.clone()],
                        ..Default::default()
                    }),
                    story("story-b", "Histoire B", "b.mp3"),
                    story("story-c", "Histoire C", "c.mp3"),
                ],
                ..Default::default()
            })],
        }
    };

    let assets = || {
        vec![
            temp_prepared_asset(&base, "rootAudio", "root.mp3"),
            temp_prepared_asset(&base, "rootImage", "cover.png"),
            temp_prepared_asset(&base, &format!("{menu_label}/menuAudio"), "menu.mp3"),
            temp_prepared_asset(&base, &format!("{menu_label}/menuImage"), "menu.png"),
            temp_prepared_asset(&base, &format!("{a_label}/storyAudio"), "a.mp3"),
            temp_prepared_asset(
                &base,
                &format!("{a_label}/afterPlaybackSequence/0/audio"),
                "ensuite.mp3",
            ),
            temp_prepared_asset(&base, &format!("{b_label}/storyAudio"), "b.mp3"),
            temp_prepared_asset(&base, &format!("{c_label}/storyAudio"), "c.mp3"),
        ]
    };

    let multi = |doc: &StoryDocument| {
        doc.action_nodes.iter().filter(|action| action.options.len() >= 2).count()
    };
    let with_choice = build_story_document(&report_for(make_project(true), assets(), Vec::new()))
        .expect("forward choice builds");
    let single = build_story_document(&report_for(make_project(false), assets(), Vec::new()))
        .expect("single target builds");
    assert_eq!(
        multi(&with_choice),
        multi(&single) + 1,
        "le choix de convergence en avant doit générer son action node (résolution préallouée)",
    );

    let _ = fs::remove_dir_all(base);
}

/// Type d'architecture « Lapin » : un arbre de choix dont la convergence est HÉBERGÉE
/// (returnAfterPlay = badge, pas de feuille `ref`). Regénéré par le chemin CANONIQUE
/// (`native_graph: None`) → la convergence A→B survit sans parachute, et round-trip.
#[test]
fn hosted_convergence_choice_tree_roundtrips_via_canonical() {
    let base = temp_roundtrip_dir("hosted_convergence");
    let root_image_source = base.join("source-cover.png");
    write_test_png(&root_image_source);

    let menu_label = scoped_label_id("root", "carrefour", "Carrefour");
    let a_label = scoped_label_id(&menu_label, "story-a", "Histoire A");
    let b_label = scoped_label_id(&menu_label, "story-b", "Histoire B");

    let project = CanonicalProject {
        name: "Carrefour Hosted".to_string(),
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
        entries: vec![CanonicalEntry::Menu(CanonicalMenu {
            id: "carrefour".to_string(),
            name: "Carrefour".to_string(),
            audio: Some("menu.mp3".to_string()),
            image: Some("menu.png".to_string()),
            children: vec![
                // A converge (badge) vers B après lecture : convergence hébergée, pas de feuille ref.
                CanonicalEntry::Story(CanonicalStory {
                    id: "story-a".to_string(),
                    name: "Histoire A".to_string(),
                    audio: Some("a.mp3".to_string()),
                    return_after_play: Some("story_play:story-b".to_string()),
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    id: "story-b".to_string(),
                    name: "Histoire B".to_string(),
                    audio: Some("b.mp3".to_string()),
                    ..Default::default()
                }),
            ],
            ..Default::default()
        })],
    };

    let assets = vec![
        temp_prepared_asset(&base, "rootAudio", "root.mp3"),
        temp_prepared_asset(&base, "rootImage", "cover.png"),
        temp_prepared_asset(&base, &format!("{menu_label}/menuAudio"), "menu.mp3"),
        temp_prepared_asset(&base, &format!("{menu_label}/menuImage"), "menu.png"),
        temp_prepared_asset(&base, &format!("{a_label}/storyAudio"), "a.mp3"),
        temp_prepared_asset(&base, &format!("{b_label}/storyAudio"), "b.mp3"),
    ];

    // Génération via le chemin canonique (pas de nativeGraph) : la convergence A→B doit
    // être un vrai stage natif partagé (le play-stage de B), atteint depuis la fin de A.
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("canonical build");

    let stage_by_uuid: HashMap<&str, &StageNode> = document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.as_str(), stage))
        .collect();
    let action_by_id: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let a_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name.contains("Histoire A") && !stage.name.contains("Titre"))
        .expect("stage de lecture de A");
    let a_ok = a_play.ok_transition.as_ref().expect("A a une transition de fin");
    let target_uuid = action_by_id
        .get(a_ok.action_node.as_str())
        .and_then(|action| action.options.get(a_ok.option_index as usize))
        .expect("cible de la convergence");
    assert!(
        stage_by_uuid
            .get(target_uuid.as_str())
            .is_some_and(|stage| stage.name.contains("Histoire B")),
        "la fin de A doit converger vers le stage existant de B (sans parachute)",
    );

    let _ = fs::remove_dir_all(base);
}
