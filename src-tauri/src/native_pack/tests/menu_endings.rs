//! Fins réalisables depuis la fiche d'une histoire de l'éditeur par menus
//! (« Pendant l'histoire », « Après la lecture »), passées par le vrai
//! générateur : seules celles qu'il refuse méritent une ligne « À corriger »
//! (`projectValidation.js`), les autres sont normalisées en fins jouables.

use serde_json::{json, Value};

use super::*;

/// Le projet tel que l'interface l'enregistre, canonisé puis construit.
fn build(project: Value) -> Result<StoryDocument, String> {
    let project: Project = serde_json::from_value(project).expect("projet lisible");
    let canonical = canonicalize_project(&project);
    let assets = collect_asset_requests(&canonical, 1.0, 1.0)
        .into_iter()
        .enumerate()
        .map(|(index, request)| {
            let extension = match request.source_kind {
                AssetSourceKind::Image => "bmp",
                _ => "mp3",
            };
            prepared_asset(&request.role, &format!("f{index}.{extension}"))
        })
        .collect();
    build_story_document(&report_for(canonical, assets, vec![]))
}

fn refused_without_exit(project: Value) {
    let error = build(project).expect_err("une fin sans sortie est refusée");
    assert!(error.contains("sans sortie utilisable"), "{error}");
}

fn pack(root_entries: Value) -> Value {
    json!({
        "name": "Essai", "projectType": "pack", "rootAudio": "r.mp3", "rootImage": "r.png",
        "rootEntries": root_entries,
        "globalOptions": {"autoNext": false, "nightMode": false}
    })
}

fn story(id: &str) -> Value {
    json!({"type": "story", "id": id, "name": id, "audio": "s.mp3",
           "itemAudio": "i.mp3", "itemImage": "i.png"})
}

/// Le bouton Accueil coupé dans « Pendant l'histoire » (`DuringPlaySection`).
fn without_home(mut story: Value) -> Value {
    let controls = story["controlSettings"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    story["controlSettings"] = Value::Object(controls);
    story["controlSettings"]["home"] = json!(false);
    story["returnOnHome"] = Value::Null;
    story["returnOnHomeNone"] = json!(true);
    story
}

/// « Rester sur l'écran » (`false`) ou « Enchaîner » (`true`), comme
/// `updateAutoContinuation` de « Après la lecture ».
fn end_mode(mut story: Value, chain: bool) -> Value {
    let controls = story["controlSettings"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    story["controlSettings"] = Value::Object(controls);
    story["controlSettings"]["autoplay"] = json!(chain);
    story["controlSettings"]["ok"] = json!(!chain);
    story
}

fn folder(id: &str, children: Value) -> Value {
    json!({"type": "menu", "id": id, "name": id, "audio": "m.mp3", "image": "m.png",
           "children": children})
}

#[test]
fn a_root_story_without_home_and_without_end_mode_is_refused() {
    // Réglages de fin par défaut (ni OK ni lecture automatique) : sans Accueil,
    // l'écran de lecture n'a plus aucune sortie.
    refused_without_exit(pack(json!([without_home(story("a"))])));
    refused_without_exit(pack(json!([without_home(story("a")), story("b")])));
    // Contre-épreuves : Accueil actif, ou un mode de fin choisi.
    assert!(build(pack(json!([story("a"), story("b")]))).is_ok());
    for chain in [false, true] {
        let ending = end_mode(without_home(story("a")), chain);
        assert!(build(pack(json!([ending, story("b")]))).is_ok());
    }
}

#[test]
fn a_folder_story_without_home_is_refused_only_when_its_folder_sets_a_return() {
    // Sans destination de dossier, le générateur force la lecture automatique.
    assert!(build(pack(json!([folder(
        "m",
        json!([without_home(story("a")), story("b")])
    )])))
    .is_ok());
    // Un dossier qui porte une destination des histoires (projet importé) ne
    // la force plus : sans Accueil, l'histoire n'a plus de sortie.
    let mut with_return = folder("m", json!([without_home(story("a")), story("b")]));
    with_return["returnAfterPlay"] = json!("root");
    refused_without_exit(pack(json!([with_return.clone(), story("c")])));
    with_return["children"][0] = end_mode(with_return["children"][0].clone(), false);
    assert!(build(pack(json!([with_return, story("c")]))).is_ok());
}

#[test]
fn end_steps_and_selection_screens_with_every_button_off_are_normalized() {
    let off =
        json!({"autoplay": false, "ok": false, "home": false, "pause": false, "wheel": false});
    let mut prompt = story("a");
    prompt["afterPlaybackPromptAudio"] = json!("p.mp3");
    prompt["afterPlaybackPromptControlSettings"] = off.clone();
    let mut sequence = story("a");
    sequence["afterPlaybackSequence"] = json!([
        {"name": "E1", "audio": "e.mp3", "controlSettings": off.clone()},
        {"name": "E2", "audio": "e.mp3", "controlSettings": off.clone()}
    ]);
    sequence["afterPlaybackHomeStep"] =
        json!({"name": "H", "audio": "h.mp3", "controlSettings": off.clone()});
    let mut selection = story("a");
    selection["titleControlSettings"] = off;
    // Une étape de fin active donne une destination OK à l'écran de lecture :
    // le générateur y rallume OK, même sans Accueil.
    for entry in [prompt.clone(), sequence.clone()] {
        assert!(build(pack(json!([without_home(entry), story("b")]))).is_ok());
    }
    for entry in [prompt, sequence, selection] {
        assert!(build(pack(json!([entry.clone(), story("b")]))).is_ok());
        assert!(build(pack(json!([entry.clone()]))).is_ok());
        assert!(build(pack(json!([folder("m", json!([entry, story("b")]))]))).is_ok());
    }
}
