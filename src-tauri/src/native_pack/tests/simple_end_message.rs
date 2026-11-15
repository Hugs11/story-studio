use serde_json::{json, Value};

use super::*;

fn build(project: Value) -> Result<StoryDocument, String> {
    let project: Project = serde_json::from_value(project).map_err(|e| format!("DTO: {e}"))?;
    let canonical = canonicalize_project(&project);
    let assets = collect_asset_requests(&canonical, 0.0, 0.0)
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

fn story_dto(id: &str, fields: Value) -> Value {
    let mut story = json!({
        "id": id, "type": "story", "name": id,
        "audio": format!("C:/h10b/{id}.mp3"),
        "itemAudio": format!("C:/h10b/{id}-t.mp3"),
        "itemImage": format!("C:/h10b/{id}.png"),
        "afterPlaybackPromptControlSettings": {"autoplay": true, "wheel": false, "pause": false, "ok": true, "home": true},
        "afterPlaybackSequence": [],
        "controlSettings": {"autoplay": false, "wheel": false, "pause": true, "ok": false, "home": true},
    });
    for (key, value) in fields.as_object().expect("champs").iter() {
        story[key] = value.clone();
    }
    story
}

fn project_dto(project_type: &str, global: Value, entries: Vec<Value>) -> Value {
    let mut project = json!({
        "schemaVersion": 3, "authoringMode": "free", "version": 2,
        "projectName": "H10b", "name": "H10b", "packVersion": 1, "packDescription": "",
        "packUuid": "11111111-2222-4333-8444-555566667777",
        "packMetadata": {"title": "H10b", "uuid": "11111111-2222-4333-8444-555566667777"},
        "projectType": project_type,
        "rootAudio": "C:/h10b/root.mp3", "rootImage": "C:/h10b/root.png",
        "thumbnailImage": "C:/h10b/root.png",
        "nightModeAudio": null, "nightModeReturn": null, "nightModeHomeReturn": null,
        "globalOptions": {"silenceMode": "normalize", "harmonizeLoudness": true, "autoNext": false,
            "nightMode": false, "endMessageAutoplay": true, "endNode": false},
        "rootEntries": entries,
    });
    for (key, value) in global.as_object().expect("réglages").iter() {
        if key == "globalOptions" {
            for (option, flag) in value.as_object().expect("options").iter() {
                project["globalOptions"][option] = flag.clone();
            }
        } else {
            project[key] = value.clone();
        }
    }
    project
}

fn target<'a>(
    document: &'a StoryDocument,
    transition: Option<&Transition>,
) -> Option<&'a StageNode> {
    let transition = transition?;
    let action = document
        .action_nodes
        .iter()
        .find(|action| action.id == transition.action_node)?;
    let stage_id = action.option_target(transition.selection.fixed_index()?)?;
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == stage_id)
}

fn stage<'a>(document: &'a StoryDocument, label: &str) -> &'a StageNode {
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == label)
        .unwrap_or_else(|| panic!("écran {label} absent"))
}

#[test]
fn c2_histoire_seule_message_de_fin_enchaine_sans_mode_nuit() {
    let dto = project_dto(
        "simple",
        json!({"nightModeAudio": "C:/h10b/fin.mp3", "globalOptions": {"endNode": true}}),
        vec![story_dto("a", json!({}))],
    );
    let document = build(dto).expect("pack généré");
    let play = stage(&document, "histoire");
    assert_eq!(
        target(&document, play.ok_transition.value()).map(StageNode::label),
        Some("nightStage")
    );
    assert!(
        play.control_settings.autoplay(),
        "Histoire seule : le message de fin doit enchaîner sans OK (autoplay={}, ok={})",
        play.control_settings.autoplay(),
        play.control_settings.ok()
    );
}

#[test]
fn histoire_seule_message_de_fin_avec_mode_nuit_garde_ses_controles() {
    let dto = project_dto(
        "simple",
        json!({
            "nightModeAudio": "C:/h10b/fin.mp3",
            "globalOptions": {"nightMode": true, "endNode": true},
        }),
        vec![story_dto("a", json!({}))],
    );
    let document = build(dto).expect("pack généré");
    let play = stage(&document, "histoire");
    assert_eq!(document.stage_nodes.len(), 3);
    assert_eq!(document.action_nodes.len(), 2);
    assert!(document.night_mode_available.is_true());
    assert!(play.control_settings.autoplay());
    assert!(!play.control_settings.ok());
    assert!(play.control_settings.home());
    assert!(play.control_settings.pause());
    assert!(!play.control_settings.wheel());
    assert!(play.home_transition.has_no_value());
    assert!(play.image.has_no_value());
    assert_eq!(
        target(&document, play.ok_transition.value()).map(StageNode::label),
        Some("nightStage")
    );
}

#[test]
fn c4_histoire_seule_message_de_fin_vers_histoire_suivante_ne_plante_pas() {
    let dto = project_dto(
        "simple",
        json!({
            "nightModeAudio": "C:/h10b/fin.mp3",
            "nightModeReturn": "next_story",
            "globalOptions": {"endNode": true},
        }),
        vec![story_dto("a", json!({}))],
    );
    let result = build(dto);
    assert!(result.is_ok(), "génération refusée : {:?}", result.err());
}

#[test]
fn c4_histoire_seule_accueil_du_message_vers_histoire_suivante_ne_plante_pas() {
    let dto = project_dto(
        "simple",
        json!({
            "nightModeAudio": "C:/h10b/fin.mp3",
            "nightModeHomeReturn": "next_story",
            "globalOptions": {"endNode": true},
        }),
        vec![story_dto("a", json!({}))],
    );
    let result = build(dto);
    assert!(result.is_ok(), "génération refusée : {:?}", result.err());
}
