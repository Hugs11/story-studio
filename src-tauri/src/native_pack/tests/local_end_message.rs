//! Message de fin personnel (invite ou séquence) d'une histoire à la racine : il enchaîne
//! sans OK, comme le message global ; une histoire importée garde ses réglages d'origine.

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

fn story_dto(id: &str, fields: Value) -> Value {
    let mut story = json!({
        "id": id, "type": "story", "name": id,
        "audio": format!("C:/message-fin/{id}.mp3"),
        "itemAudio": format!("C:/message-fin/{id}-t.mp3"),
        "itemImage": format!("C:/message-fin/{id}.png"),
        "afterPlaybackPromptControlSettings": {"autoplay": true, "wheel": false, "pause": false, "ok": true, "home": true},
        "afterPlaybackSequence": [],
        "controlSettings": {"autoplay": false, "wheel": false, "pause": true, "ok": false, "home": true},
    });
    for (key, value) in fields.as_object().expect("champs").iter() {
        story[key] = value.clone();
    }
    story
}

fn project_dto(entries: Vec<Value>) -> Value {
    json!({
        "schemaVersion": 3, "authoringMode": "free", "version": 2,
        "projectName": "Message de fin", "name": "Message de fin", "packVersion": 1, "packDescription": "",
        "packUuid": "11111111-2222-4333-8444-555566667777",
        "packMetadata": {"title": "Message de fin", "uuid": "11111111-2222-4333-8444-555566667777"},
        "projectType": "pack",
        "rootAudio": "C:/message-fin/root.mp3", "rootImage": "C:/message-fin/root.png",
        "thumbnailImage": "C:/message-fin/root.png",
        "nightModeAudio": null, "nightModeReturn": null, "nightModeHomeReturn": null,
        "globalOptions": {"silenceMode": "normalize", "harmonizeLoudness": true, "autoNext": false,
            "nightMode": false, "endMessageAutoplay": true, "endNode": false},
        "rootEntries": entries,
    })
}

fn stage<'a>(document: &'a StoryDocument, label: &str) -> &'a StageNode {
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == label)
        .unwrap_or_else(|| panic!("écran {label} absent"))
}

/// Pack par menus, trois histoires à la racine, message de fin personnel sur la première,
/// aucun message global : l'éditeur annonce « Enchaîner ».
#[test]
fn c1_message_de_fin_local_a_la_racine_enchaine_sans_ok() {
    let dto = project_dto(vec![
        story_dto(
            "a",
            json!({"afterPlaybackPromptAudio": "C:/message-fin/a-fin.mp3"}),
        ),
        story_dto("b", json!({})),
        story_dto("c", json!({})),
    ]);
    let document = build(dto).expect("pack généré");
    let play = stage(&document, "Histoire - a");
    assert_eq!(
        target(&document, play.ok_transition.value()).map(StageNode::label),
        Some("Fin - a"),
        "OK de l'histoire mène au message de fin"
    );
    assert!(
        play.control_settings.autoplay(),
        "fin de l'histoire : le message de fin doit enchaîner sans OK (autoplay={}, ok={})",
        play.control_settings.autoplay(),
        play.control_settings.ok()
    );
}

/// Variante séquence : séquence de fin d'une étape.
#[test]
fn c1_sequence_de_fin_a_la_racine_enchaine_sans_ok() {
    let step = json!({
        "id": "a-e1", "name": "a-e1", "audio": "C:/message-fin/a-e1.mp3",
        "controlSettings": {"autoplay": true, "ok": true, "home": true, "pause": false, "wheel": false},
    });
    let dto = project_dto(vec![
        story_dto("a", json!({"afterPlaybackSequence": [step]})),
        story_dto("b", json!({})),
    ]);
    let document = build(dto).expect("pack généré");
    let play = stage(&document, "Histoire - a");
    assert!(
        play.control_settings.autoplay(),
        "fin de l'histoire : la séquence de fin doit enchaîner sans OK"
    );
}

/// Témoin : une histoire importée (`nativeStageId`) avec invite qui attendait OK l'attend toujours.
#[test]
fn c1_histoire_importee_avec_invite_attend_toujours_ok() {
    let dto = project_dto(vec![
        story_dto(
            "a",
            json!({"nativeStageId": "native-a", "afterPlaybackPromptAudio": "C:/message-fin/a-fin.mp3"}),
        ),
        story_dto("b", json!({})),
    ]);
    let document = build(dto).expect("pack généré");
    let play = stage(&document, "Histoire - a");
    assert!(
        !play.control_settings.autoplay(),
        "histoire importée : lecture automatique non forcée"
    );
    assert!(play.control_settings.ok());
}

fn imported_direct_project(global_message: bool) -> Value {
    let imported = |id: &str, next: &str| {
        story_dto(
            id,
            json!({
                "nativeStageId": format!("native-{id}"),
                "itemAudio": null, "itemImage": null, "titleControlSettings": null,
                "controlSettings": {"autoplay": true, "wheel": false, "pause": true, "ok": false, "home": true},
                "returnAfterPlay": next,
            }),
        )
    };
    let mut dto = project_dto(vec![imported("a", "story:b"), imported("b", "story:a")]);
    if global_message {
        dto["nightModeAudio"] = json!("C:/message-fin/fin.mp3");
        dto["globalOptions"]["endNode"] = json!(true);
    }
    dto
}

/// Une histoire importée conserve ses contrôles et ses destinations.
/// L'écran reste direct ; seul le passage par le message global est ajouté.
#[test]
fn histoire_importee_directe_joue_le_message_global() {
    let original = build(imported_direct_project(false)).expect("sans retouche");
    let document = build(imported_direct_project(true)).expect("avec message global");
    for (id, next) in [("a", "b"), ("b", "a")] {
        let play = stage(&document, id);
        let before = stage(&original, id);
        assert_eq!(play.control_settings, before.control_settings);
        assert_eq!(play.image, before.image);
        assert_eq!(
            target(&document, play.home_transition.value()).map(StageNode::label),
            target(&original, before.home_transition.value()).map(StageNode::label),
        );
        assert!(play.control_settings.autoplay());
        let end = target(&document, play.ok_transition.value()).expect("message global");
        assert_eq!(end.label(), "nightStage");
        assert_eq!(
            target(&document, end.ok_transition.value()).map(StageNode::label),
            Some(next),
        );
        assert_eq!(
            target(&original, before.ok_transition.value()).map(StageNode::label),
            Some(next),
        );
    }
    assert_eq!(document.stage_nodes.len(), original.stage_nodes.len() + 2);
    assert!(crate::native_pack::port_rules::port_violations(&document).is_empty());

    let project: Project = serde_json::from_value(imported_direct_project(true)).expect("DTO");
    let copy =
        crate::native_pack::graph_copy::graph_copy_of_project(&project).expect("copie graphe");
    crate::native_pack::graph_copy::verify_graph_copy(&project, &copy.payload)
        .expect("le graphe garde le passage par le message global");
}
