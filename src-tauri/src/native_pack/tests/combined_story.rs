//! Histoire combinée (titre et récit identiques, molette et lecture
//! automatique, message de fin global) : le constructeur n'émet qu'un Écran.
//! L'Action de lecture qui mènerait à cet Écran n'a de sens que si une
//! transition la référence ; sinon elle est orpheline et la readiness refuse
//! le pack (`ORPHAN_ACTION_AUTHORED_CONTENT`).

use super::*;
use crate::native_pack::graph_copy::{graph_copy_of_project, verify_graph_copy};
use serde_json::{json, Value};

fn options() -> CanonicalOptions {
    CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Off,
        harmonize_loudness: true,
        auto_next: false,
        night_mode: true,
        end_message_autoplay: true,
    }
}

fn combined_story(id: &str, return_after_play: &str) -> CanonicalStory {
    CanonicalStory {
        id: id.to_string(),
        name: format!("Histoire {id}"),
        audio: Some(format!("{id}.mp3")),
        item_audio: Some(format!("{id}.mp3")),
        item_image: Some(format!("{id}.png")),
        wheel: true,
        autoplay: true,
        return_after_play: Some(return_after_play.to_string()),
        ..Default::default()
    }
}

fn plain_story(id: &str) -> CanonicalStory {
    CanonicalStory {
        id: id.to_string(),
        name: format!("Histoire {id}"),
        audio: Some(format!("{id}.mp3")),
        item_audio: Some(format!("{id}-titre.mp3")),
        item_image: Some(format!("{id}-titre.png")),
        ..Default::default()
    }
}

fn project(entries: Vec<CanonicalStory>) -> CanonicalProject {
    CanonicalProject {
        name: "Pack".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: Some("global.mp3".to_string()),
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        options: options(),
        entries: entries.into_iter().map(CanonicalEntry::Story).collect(),
        shared_entries: Vec::new(),
    }
}

/// Collecte réelle puis constructeur réel ; les portes d'observation
/// (readiness comprise) sont appliquées au document produit.
fn built(project: CanonicalProject) -> StoryDocument {
    let assets: Vec<PreparedAsset> = collect_asset_requests(&project, 0.0, 0.0)
        .into_iter()
        .enumerate()
        .map(|(index, request)| {
            let extension = match request.source_kind {
                AssetSourceKind::Image => "png",
                _ => "mp3",
            };
            prepared_asset(&request.role, &format!("asset-{index}.{extension}"))
        })
        .collect();
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("document Libre");
    assert_free_document_passes_gates(&report, &document);
    document
}

fn combined_stage<'a>(document: &'a StoryDocument, label: &str) -> &'a StageNode {
    assert!(
        !document
            .stage_nodes
            .iter()
            .any(|stage| stage.label() == format!("Titre - {label}")),
        "l'histoire doit être combinée"
    );
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == label)
        .expect("Écran combiné")
}

fn referenced_action_ids(document: &StoryDocument) -> Vec<&str> {
    document
        .stage_nodes
        .iter()
        .flat_map(|stage| [stage.home_transition.value(), stage.ok_transition.value()])
        .flatten()
        .map(|transition| transition.action_node.as_str())
        .collect()
}

/// Les Actions dont l'unique option est cet Écran.
fn actions_leading_only_to<'a>(document: &'a StoryDocument, stage_id: &str) -> Vec<&'a str> {
    document
        .action_nodes
        .iter()
        .filter(|action| action.options.len() == 1 && action.option_target(0) == Some(stage_id))
        .map(|action| action.id.as_str())
        .collect()
}

#[test]
fn combined_story_leaves_no_unreferenced_play_action() {
    let document = built(project(vec![
        combined_story("a", "story:b"),
        plain_story("b"),
    ]));
    let stage = combined_stage(&document, "Histoire a");
    let referenced = referenced_action_ids(&document);
    for action_id in actions_leading_only_to(&document, &stage.uuid) {
        assert!(
            referenced.contains(&action_id),
            "Action de lecture {action_id} sans transition entrante"
        );
    }
}

#[test]
fn combined_story_keeps_its_play_action_when_story_play_is_targeted() {
    let mut target = plain_story("b");
    target.return_after_play = Some("story_play:a".to_string());
    let document = built(project(vec![combined_story("a", "story:b"), target]));
    let stage = combined_stage(&document, "Histoire a");
    let referenced = referenced_action_ids(&document);
    assert!(
        actions_leading_only_to(&document, &stage.uuid)
            .iter()
            .any(|action_id| referenced.contains(action_id)),
        "story_play:a doit rester une destination"
    );
}

fn free_project(entries: Value) -> Project {
    serde_json::from_value(json!({
        "name": "Pack",
        "projectType": "pack",
        "rootAudio": "/travail/accueil.mp3",
        "rootImage": "/travail/accueil.png",
        "packUuid": "3f2b9c1e-8a47-4d2e-9b61-0c5d7e8f9a10",
        "packVersion": 1,
        "nightModeAudio": "/travail/fin.mp3",
        "rootEntries": entries,
        "globalOptions": {
            "harmonizeLoudness": true,
            "silenceMode": "off",
            "autoNext": false,
            "nightMode": true,
            "endMessageAutoplay": true,
        },
    }))
    .expect("projet d'essai")
}

#[test]
fn combined_story_passes_the_graph_copy_check() {
    let project = free_project(json!([
        {
            "id": "a", "type": "story", "name": "Histoire a",
            "audio": "/travail/a.mp3", "itemAudio": "/travail/a.mp3",
            "itemImage": "/travail/a.png",
            "controlSettings": { "wheel": true, "autoplay": true, "ok": false,
                                 "home": true, "pause": true },
            "returnAfterPlay": "story:b",
        },
        {
            "id": "b", "type": "story", "name": "Histoire b",
            "audio": "/travail/b.mp3", "itemAudio": "/travail/b-titre.mp3",
            "itemImage": "/travail/b-titre.png",
        },
    ]));
    let copy = graph_copy_of_project(&project).expect("copie graphe");
    // La garde relit la copie et la passe par la préparation d'export du
    // graphe, qui applique la readiness.
    verify_graph_copy(&project, &copy.payload).expect("même structure de pack");
}
