//! Le collage d'un sous-graphe, formulé en JSON comme la frontière IPC le
//! recevra. C'est ici que le mode de panne du collage est verrouillé : le
//! `AdvancedGesture` n'a pas `deny_unknown_fields`, donc un champ ajouté d'un
//! seul côté serait **silencieusement ignoré** et non refusé. Seule la forme
//! exacte, éprouvée ici, dit que les deux moitiés se parlent.
use super::*;
use crate::native_pack::{StageNode, StoryDocument};

/// Le motif type d'un collage : deux Écrans, une Action, et leur câblage
/// interne — Écran 0 → Action 0 (option 0) → Écran 1.
fn pattern() -> Value {
    json!({"gesture":"paste-subgraph","subgraph":{
        "stages":[
            {"name":"Clairière","controls":controls(false,true,false,false,false),
             "position":{"x":100.0,"y":200.0}},
            {"name":"Rivière","controls":controls(false,false,false,true,true),
             "position":{"x":260.0,"y":200.0}}
        ],
        "actions":[
            {"name":"Suite","options":[{"target":"stage","stage":1}],
             "position":{"x":180.0,"y":200.0}}
        ],
        "transitions":[{"stage":0,"slot":"ok","action":0,"optionIndex":0}]
    }})
}

fn stage<'a>(document: &'a StoryDocument, uuid: &str) -> &'a StageNode {
    document
        .stage_nodes
        .iter()
        .find(|node| node.uuid == uuid)
        .expect("Écran collé présent")
}

#[test]
fn a_paste_lands_its_nodes_its_wiring_and_its_positions_in_one_gesture() {
    let before = payload();
    let result = applied(&before, bindings(), pattern());
    let after = saved_and_reopened(&result.payload);
    let original = decode_authoring_payload(&before).expect("payload de départ");

    // Les nœuds d'origine sont intacts : un collage ajoute, il ne réécrit rien.
    assert_eq!(
        &after.document.stage_nodes[..2],
        original.document.stage_nodes.as_slice()
    );
    assert_eq!(
        &after.document.action_nodes[..1],
        original.document.action_nodes.as_slice()
    );
    assert_eq!(after.document.stage_nodes.len(), 4);
    assert_eq!(after.document.action_nodes.len(), 2);

    let report = result.report.construction.expect("rapport de collage");
    assert_eq!(report.stages.len(), 2);
    assert_eq!(report.actions.len(), 1);
    assert_eq!(report.transitions.len(), 1);
    // Un collage est clos sur lui-même : il ne raccorde rien au graphe existant.
    assert!(!report.connected);

    // Le câblage interne désigne les **copies**, jamais les nœuds d'origine.
    let pasted_action = after
        .document
        .action_nodes
        .iter()
        .find(|node| node.id == report.actions[0])
        .expect("Action collée présente");
    assert_eq!(pasted_action.name, Presence::Value("Suite".into()));
    assert_eq!(
        pasted_action.options,
        vec![Some(report.stages[1].clone())],
        "l'option collée mène à l'Écran collé, pas à son modèle"
    );
    let source = stage(&after.document, &report.stages[0]);
    let transition = source.ok_transition.value().expect("transition collée");
    assert_eq!(transition.action_node, report.actions[0]);

    // Les positions collées deviennent les positions d'auteur des copies : un
    // nœud n'a qu'une position, celle du graphe à plat.
    assert!(stage(&after.document, &report.stages[0])
        .position
        .is_value());
    assert!(pasted_action.position.is_value());
    assert!(!after
        .context
        .editor_positions
        .iter()
        .any(|entry| entry.path.contains(&report.stages[0])
            || entry.path.contains(&report.actions[0])));

    assert!(validate_graph_document_integrity(&after.document).is_ok());
    // Le média n'est pas touché : aucun Écran collé n'en porte ici.
    assert_eq!(result.media_bindings, bindings());
}

#[test]
fn a_pasted_stage_never_becomes_the_entry() {
    // L'Écran copié était l'entrée du pack. un pack n'admet qu'une entrée,
    // et un collage ne doit jamais la déplacer par accident.
    let mut request = pattern();
    request["subgraph"]["stages"][0]["name"] = json!("Accueil");
    let result = applied(&payload(), bindings(), request);
    let after = saved_and_reopened(&result.payload);
    let report = result.report.construction.expect("rapport de collage");
    for uuid in &report.stages {
        assert_eq!(
            stage(&after.document, uuid).square_one,
            Presence::Value(false)
        );
    }
    let entries = after
        .document
        .stage_nodes
        .iter()
        .filter(|node| node.square_one.value() == Some(&true))
        .count();
    assert_eq!(entries, 1, "le pack garde exactement une entrée");
}

#[test]
fn a_pasted_stage_shares_the_media_reference_instead_of_duplicating_it() {
    let mut request = pattern();
    request["subgraph"]["stages"][0]["audio"] = json!({"assetRef": AUDIO_REF});
    let result = applied(&payload(), bindings(), request);
    let after = saved_and_reopened(&result.payload);
    let report = result.report.construction.expect("rapport de collage");

    assert_eq!(
        stage(&after.document, &report.stages[0]).audio,
        Presence::Value(AUDIO_REF.to_string())
    );
    // Le modèle référence les médias, il ne les possède pas : aucune liaison
    // n'est ajoutée, aucun fichier n'est recopié.
    assert_eq!(result.media_bindings, bindings());
    assert!(result.report.media.added.is_empty());
    assert!(result.report.media.repointed.is_empty());
    // Trois Écrans partagent désormais le même fichier. Le rapport de médias
    // n'en dit rien, et c'est voulu : il ne relève que les références que le
    // geste a **liées, re-pointées ou relâchées**, et partager une liaison
    // existante n'est aucune des trois.
    let sharing = after
        .document
        .stage_nodes
        .iter()
        .filter(|node| node.audio.value().map(String::as_str) == Some(AUDIO_REF))
        .count();
    assert_eq!(sharing, 3);
}

#[test]
fn a_media_reference_unknown_to_this_project_is_refused_not_invented() {
    // Le cas réel : un collage venu d'un autre document. La référence n'y est
    // liée à aucun fichier ; le geste le dit au lieu d'en inventer un.
    let mut request = pattern();
    request["subgraph"]["stages"][0]["audio"] = json!({"assetRef": "venu-d-ailleurs.mp3"});
    let error = refused(&payload(), bindings(), request);
    assert_eq!(error.code, "UNBOUND_ASSET_REF");
}

#[test]
fn a_paste_from_another_project_binds_its_file_under_a_fresh_reference() {
    // Le collage d'un autre document tel que le presse-papier du graphe
    // l'envoie : la référence est neuve pour ce projet, et le fichier voyage
    // avec elle. Le premier Écran lie ; le second, qui partageait le même
    // fichier dans la source, réutilise sans emplacement la liaison que le
    // même geste vient de créer.
    const FILE: &str = "/projets/autre/medias/ruisseau.mp3";
    let mut request = pattern();
    request["subgraph"]["stages"][0]["audio"] = json!({
        "assetRef": "ruisseau.mp3",
        "location": {"path": FILE, "present": true}
    });
    request["subgraph"]["stages"][1]["audio"] = json!({"assetRef": "ruisseau.mp3"});
    let result = applied(&payload(), bindings(), request);
    let after = saved_and_reopened(&result.payload);
    let report = result.report.construction.expect("rapport de collage");

    for uuid in &report.stages {
        assert_eq!(
            stage(&after.document, uuid).audio,
            Presence::Value("ruisseau.mp3".to_string())
        );
    }
    let mut expected = bindings();
    expected.push(AdvancedMediaBinding {
        asset_ref: "ruisseau.mp3".to_string(),
        path: Some(FILE.to_string()),
        status: MediaBindingStatus::Resolved,
    });
    assert_eq!(result.media_bindings, expected);
    assert_eq!(result.report.media.added, vec!["ruisseau.mp3".to_string()]);
    assert!(result.report.media.repointed.is_empty());
}

#[test]
fn a_pasted_location_never_repoints_a_reference_already_bound() {
    // Le choix d'une référence libre revient à l'appelant : un emplacement
    // fourni pour une référence déjà liée re-pointerait en silence les Écrans
    // qui la partagent, et le collage le refuse.
    let mut request = pattern();
    request["subgraph"]["stages"][0]["audio"] = json!({
        "assetRef": AUDIO_REF,
        "location": {"path": "/projets/autre/medias/intro.mp3", "present": true}
    });
    let error = refused(&payload(), bindings(), request);
    assert_eq!(error.code, "ASSET_REF_ALREADY_BOUND");
}

#[test]
fn an_option_or_a_transition_outside_the_paste_is_refused() {
    let mut option = pattern();
    option["subgraph"]["actions"][0]["options"] = json!([{"target":"stage","stage":7}]);
    assert_eq!(
        refused(&payload(), bindings(), option).code,
        "INVALID_PASTE"
    );

    let mut transition = pattern();
    transition["subgraph"]["transitions"] =
        json!([{"stage":0,"slot":"ok","action":3,"optionIndex":0}]);
    assert_eq!(
        refused(&payload(), bindings(), transition).code,
        "INVALID_PASTE"
    );

    let mut origin = pattern();
    origin["subgraph"]["transitions"] = json!([{"stage":9,"slot":"ok","action":0,"optionIndex":0}]);
    assert_eq!(
        refused(&payload(), bindings(), origin).code,
        "INVALID_PASTE"
    );
}

#[test]
fn an_empty_paste_is_refused_rather_than_applied_as_a_no_op() {
    let request = json!({"gesture":"paste-subgraph","subgraph":{}});
    assert_eq!(
        refused(&payload(), bindings(), request).code,
        "INVALID_PASTE"
    );
}

#[test]
fn a_selection_out_of_the_pasted_options_is_refused_by_the_transition_rule() {
    // La règle des bornes de sélection n'est pas recopiée dans le collage : c'est
    // `set_stage_transition` qui juge, et un collage ne doit pas fabriquer une
    // erreur bloquante que l'auteur n'a pas demandée.
    let mut request = pattern();
    request["subgraph"]["transitions"] =
        json!([{"stage":0,"slot":"ok","action":0,"optionIndex":4}]);
    assert_eq!(
        refused(&payload(), bindings(), request).code,
        "OPTION_SELECTION_OUT_OF_BOUNDS"
    );

    // Et le document n'en garde **aucune** trace : le refus est arrivé après la
    // création des Écrans, mais rien n'est publié tant que le geste n'a pas
    // abouti entier.
    let mut random = pattern();
    random["subgraph"]["actions"][0]["options"] = json!([]);
    random["subgraph"]["transitions"] =
        json!([{"stage":0,"slot":"ok","action":0,"optionIndex":-1}]);
    assert_eq!(
        refused(&payload(), bindings(), random).code,
        "OPTION_SELECTION_OUT_OF_BOUNDS"
    );
}

#[test]
fn a_null_option_keeps_its_rank_reserved() {
    // Ce que devient une option qui sortait de la sélection copiée : le rang
    // reste, sa destination est nulle, et c'est une forme admise.
    let mut request = pattern();
    request["subgraph"]["actions"][0]["options"] =
        json!([{"target":"null"},{"target":"stage","stage":1}]);
    request["subgraph"]["transitions"] =
        json!([{"stage":0,"slot":"ok","action":0,"optionIndex":1}]);
    let result = applied(&payload(), bindings(), request);
    let after = saved_and_reopened(&result.payload);
    let report = result.report.construction.expect("rapport de collage");
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|node| node.id == report.actions[0])
        .expect("Action collée présente");
    assert_eq!(action.options, vec![None, Some(report.stages[1].clone())]);
}

#[test]
fn a_paste_leaves_the_context_of_the_untouched_nodes_intact() {
    let before = payload();
    let original = decode_authoring_payload(&before).expect("payload de départ");
    let result = applied(&before, bindings(), pattern());
    let after = saved_and_reopened(&result.payload);

    assert_eq!(after.context.pack_identity, original.context.pack_identity);
    assert_eq!(after.context.diagnostics, original.context.diagnostics);
    assert_eq!(
        after.context.export_qualifications,
        original.context.export_qualifications
    );
    // Les provenances d'origine survivent ; seules s'ajoutent celles des
    // positions d'auteur des copies.
    for entry in &original.context.value_provenance {
        assert!(after.context.value_provenance.contains(entry));
    }
    // Les positions d'éditeur d'origine survivent aussi.
    for entry in &original.context.editor_positions {
        assert!(after.context.editor_positions.contains(entry));
    }
    assert!(result.report.anchors.preexisting_orphans.is_empty());
}
