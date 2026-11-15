//! Réouverture sans recette : le producteur natif reste inchangé par ce lot.
use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::domain::project::Project;
use crate::native_pack::simulation::project_story_for_simulation;
use crate::services::pack_reader::projection::walk_story_doc_to_entries;
use crate::services::pack_reader::tests::structural_compare::{
    compare_structure_with, StructuralVerdict, ToleratedTransformations,
};

fn root_three() -> Value {
    json!({
        "name": "Sans recette", "projectType": "pack",
        "rootAudio": "root.mp3", "rootImage": "root.png",
        "globalOptions": {"harmonizeLoudness": false, "autoNext": false, "nightMode": false},
        "rootEntries": (["a", "b", "c"].map(|id| json!({
            "id": id, "type": "story", "name": id,
            "audio": format!("{id}.mp3"), "itemAudio": format!("{id}-title.mp3"),
            "itemImage": format!("{id}.png")
        })))
    })
}

fn reopen(dto: Value) -> (Value, Project) {
    let project: Project = serde_json::from_value(dto).unwrap();
    let source = project_story_for_simulation(&project).unwrap();
    let assets: HashMap<String, PathBuf> = source
        .media
        .iter()
        .map(|m| {
            (
                m.asset_name.clone(),
                PathBuf::from(m.path.as_ref().unwrap()),
            )
        })
        .collect();
    let doc = serde_json::to_value(&source.story).unwrap();
    let imported = walk_story_doc_to_entries(&doc, &assets).unwrap();
    assert_eq!(imported["usesGraphProjection"], false);
    assert_eq!(imported["outOfTreeEdgeCount"], 0);
    assert!(imported["sharedEntries"].as_array().unwrap().is_empty());
    let restored = super::project_from_imported_entries(&imported, "Sans recette").unwrap();
    let regenerated = project_story_for_simulation(&restored).unwrap();
    let comparison = compare_structure_with(
        &source.story,
        &regenerated.story,
        &ToleratedTransformations::none(),
        &[],
    );
    assert_eq!(
        comparison.verdict,
        StructuralVerdict::Equivalent,
        "{comparison:#?}"
    );
    let fidelity = crate::native_pack::fidelity_judge::compare_documents_structural(
        &regenerated.story,
        &source.story,
    );
    assert!(fidelity.faithful, "{:?}", fidelity.gaps);
    (imported, restored)
}

#[test]
fn lb_root3_g0_l_prompt_c0_returns_to_the_menu() {
    let mut dto = root_three();
    for (index, entry) in dto["rootEntries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        entry["afterPlaybackPromptAudio"] = json!(format!("prompt-{index}.mp3"));
    }
    let (imported, _) = reopen(dto);
    assert_eq!(imported["entries"].as_array().unwrap().len(), 3);
    assert!(imported["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["afterPlaybackPromptAudio"].is_string()));
}

#[test]
fn lb_root3_g_end_l0_c0_keeps_the_global_end_and_default_return() {
    let mut dto = root_three();
    dto["nightModeAudio"] = json!("end.mp3");
    dto["globalOptions"]["endMessageAutoplay"] = json!(false);
    let (imported, _) = reopen(dto);
    assert_eq!(imported["nightModeAudio"], "end.mp3");
    assert!(imported["nightModeReturn"].is_null());
    assert_eq!(imported["endMessageAutoplay"], false);
}

#[test]
fn lb_night_flag_survives_when_personal_ends_replace_the_global_audio() {
    let mut dto = root_three();
    dto["nightModeAudio"] = json!("unused-end.mp3");
    dto["globalOptions"]["nightMode"] = json!(true);
    for (index, entry) in dto["rootEntries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        entry["afterPlaybackPromptAudio"] = json!(format!("prompt-{index}.mp3"));
    }
    let (imported, restored) = reopen(dto);
    assert!(imported["nightModeAudio"].is_null());
    assert_eq!(imported["nightMode"], true);
    assert!(restored.global_options.night_mode);
    assert!(restored.night_mode_audio.is_none());
}

#[test]
fn lb_mini_loup_shape_keeps_twenty_stories_and_the_next_story_end() {
    let mut dto = root_three();
    let template = dto["rootEntries"][0].clone();
    let stories: Vec<Value> = (0..20)
        .map(|index| {
            let mut story = template.clone();
            story["id"] = json!(format!("story-{index}"));
            story["name"] = json!(format!("Histoire {index}"));
            story["audio"] = json!(format!("story-{index}.mp3"));
            story["itemAudio"] = json!(format!("title-{index}.mp3"));
            story["itemImage"] = json!(format!("title-{index}.png"));
            story
        })
        .collect();
    dto["rootEntries"] = json!([{
        "id": "folder", "name": "Mini-loup", "type": "menu",
        "audio": "folder.mp3", "image": "folder.png", "children": stories
    }]);
    dto["nightModeAudio"] = json!("end.mp3");
    dto["nightModeReturn"] = json!("next_story");
    let (imported, _) = reopen(dto);
    assert_eq!(
        imported["entries"][0]["children"].as_array().unwrap().len(),
        20
    );
    assert_eq!(imported["nightModeReturn"], "next_story");
}

#[test]
fn lb_personal_end_ok_does_not_replace_the_story_home_return() {
    let mut dto = root_three();
    let mut stories = dto["rootEntries"].as_array().unwrap().clone();
    for story in &mut stories {
        story["afterPlaybackPromptAudio"] = json!("end.mp3");
        story["afterPlaybackPromptOkTarget"] = json!("root");
        story["afterPlaybackPromptHomeNone"] = json!(true);
    }
    dto["rootEntries"] = json!([
        {"id": "m", "name": "m", "type": "menu", "audio": "m.mp3", "image": "m.png", "returnAfterPlay": "root", "children": &stories[..2]},
        {"id": "n", "name": "n", "type": "menu", "audio": "n.mp3", "image": "n.png", "children": &stories[2..]}
    ]);
    dto["nightModeAudio"] = json!("end.mp3");
    dto["nightModeReturn"] = json!("root");
    let (imported, _) = reopen(dto);
    let parent = imported["entries"][1]["id"].as_str().unwrap();
    assert_eq!(
        imported["entries"][1]["children"][0]["returnOnHome"],
        parent
    );
}

/// Témoin C3 avec images : une fin commune reliée à une partie seulement des
/// histoires reste au Graphe, même quand la projection par arbre serait valide.
#[test]
fn lb_partial_shared_end_with_images_stays_graph() {
    use crate::services::pack_reader::{
        classify_pack_editability, unpack_zip_to_entries_unchecked,
    };
    use crate::support::user_message::{codes, MessageTransportAssertions};
    use std::io::Write;

    let base = std::env::temp_dir().join(format!(
        "lb_c3_images_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let with_image = ["cover", "ta", "tb", "mq", "d1", "d2"];
    let transition = |action, index| json!({"actionNode": action, "optionIndex": index});
    let stage = |id: &str, wheel, autoplay, ok_action, home_action, home_index| {
        let image = with_image.contains(&id).then(|| format!("{id}.png"));
        json!({
            "uuid": id, "name": id, "type": "stage", "squareOne": id == "cover",
            "audio": format!("{id}.mp3"), "image": image,
            "controlSettings": {
                "wheel": wheel, "ok": true, "home": id != "cover",
                "pause": false, "autoplay": autoplay,
            },
            "okTransition": transition(ok_action, 0),
            "homeTransition": if matches!(id, "cover" | "ta" | "tb" | "mq") { Value::Null }
                else { transition(home_action, home_index) },
        })
    };
    let source = json!({
        "title": "C3 message partiel images", "version": 1, "description": "", "format": "v1",
        "nightModeAvailable": false,
        "stageNodes": [
            stage("cover", true, false, "choices", "choices", 0),
            stage("ta", true, false, "play-a", "choices", 0),
            stage("tb", true, false, "play-b", "choices", 1),
            stage("reading-a", false, true, "end", "choices", 0),
            stage("reading-b", false, true, "end", "choices", 1),
            stage("nightStage", false, true, "choices", "choices", 0),
            stage("mq", true, false, "sub-choices", "choices", 2),
            stage("d1", true, true, "back-sub", "choices", 2),
            stage("d2", true, true, "back-sub", "choices", 2),
        ],
        "actionNodes": [
            {"id": "choices", "options": ["ta", "tb", "mq"]},
            {"id": "play-a", "options": ["reading-a"]},
            {"id": "play-b", "options": ["reading-b"]},
            {"id": "end", "options": ["nightStage"]},
            {"id": "sub-choices", "options": ["d1", "d2"]},
            {"id": "back-sub", "options": ["mq"]},
        ],
    });
    std::fs::create_dir_all(&base).unwrap();
    let zip_path = base.join("pack.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("story.json", opts).unwrap();
    zip.write_all(source.to_string().as_bytes()).unwrap();
    for stage in source["stageNodes"].as_array().unwrap() {
        for key in ["audio", "image"] {
            if let Some(asset) = stage[key].as_str() {
                zip.start_file(format!("assets/{asset}"), opts).unwrap();
                zip.write_all(asset.as_bytes()).unwrap();
            }
        }
    }
    zip.finish().unwrap();
    let zip = zip_path.to_string_lossy().to_string();

    let imported =
        unpack_zip_to_entries_unchecked(&zip, base.join("imported").to_str().unwrap()).unwrap();
    assert_eq!(imported["usesGraphProjection"], true);
    let verdict = classify_pack_editability(&zip).unwrap();
    assert!(!verdict.authoring_editable, "{verdict:?}");
    assert!(verdict.uses_graph_projection, "{verdict:?}");
    assert!(
        verdict
            .reason
            .contains_any_code(&[codes::VALIDATION_AUTHORING_SHARED_UNSUPPORTED]),
        "{verdict:?}"
    );
    std::fs::remove_dir_all(base).unwrap();
}
