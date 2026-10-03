//! Ce que la vue rend d'un document sain, et ce qu'elle refuse d'y ajouter.

use super::fixtures::*;
use crate::native_pack::graph_view::dto::*;

#[test]
fn la_vue_est_versionnee_et_porte_l_origine_du_document() {
    let view = view(&payload(LOOP_DOCUMENT, STUDIO_CONTEXT));
    assert_eq!(view.view_version, GRAPH_VIEW_VERSION);
    assert_eq!(
        view.document_origin,
        crate::native_pack::dialect::DocumentOrigin::ImportedStudio
    );
    assert_eq!(
        view.default_value_origin,
        crate::native_pack::dialect::ValueOrigin::SourceStudio
    );
    assert_eq!(
        view.pack_identity.short_identity.as_deref(),
        Some("11111111")
    );
}

#[test]
fn une_boucle_reste_une_boucle_et_l_action_est_un_noeud() {
    let view = view(&payload(LOOP_DOCUMENT, STUDIO_CONTEXT));
    assert_eq!(view.counts.stages, 1);
    assert_eq!(view.counts.actions, 1);
    // Une arête Écran → Action et une arête Action → Écran : le
    // passage par l'Action reste visible au lieu de le contracter en un seul lien.
    assert_eq!(view.counts.edges, 2);
    let stage_to_action = &view.edges[0];
    assert_eq!(stage_to_action.kind, EdgeKind::StageOk);
    assert_eq!(stage_to_action.from, "/stageNodes/@uuid=s1#0");
    assert_eq!(
        stage_to_action.to.as_deref(),
        Some("/actionNodes/@id=act#0")
    );
    let action_to_stage = &view.edges[1];
    assert_eq!(action_to_stage.kind, EdgeKind::ActionOption);
    assert_eq!(action_to_stage.from, "/actionNodes/@id=act#0");
    assert_eq!(
        action_to_stage.to.as_deref(),
        Some("/stageNodes/@uuid=s1#0")
    );
    assert!(!action_to_stage.dangling);
}

#[test]
fn deux_occurrences_vers_la_meme_cible_ne_sont_jamais_dedupliquees() {
    let view = view(&payload(SHARED_AND_DETACHED_DOCUMENT, STUDIO_CONTEXT));
    let shared = action(&view, "/actionNodes/@id=shared#0");
    assert_eq!(shared.options.len(), 2);
    assert_eq!(
        shared.options[0].option_id,
        "/actionNodes/@id=shared#0/options#0"
    );
    assert_eq!(
        shared.options[1].option_id,
        "/actionNodes/@id=shared#0/options#1"
    );
    assert_eq!(
        shared.options[0].target.stage_path,
        shared.options[1].target.stage_path
    );
    let option_edges: Vec<&EdgeView> = view
        .edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::ActionOption)
        .collect();
    assert_eq!(option_edges.len(), 2);
    assert_ne!(option_edges[0].edge_id, option_edges[1].edge_id);
}

#[test]
fn une_action_partagee_converge_et_un_noeud_detache_reste_trouvable() {
    let view = view(&payload(SHARED_AND_DETACHED_DOCUMENT, STUDIO_CONTEXT));
    let toward_shared: Vec<&EdgeView> = view
        .edges
        .iter()
        .filter(|edge| edge.to.as_deref() == Some("/actionNodes/@id=shared#0"))
        .collect();
    assert_eq!(toward_shared.len(), 2);
    // Le détaché n'est atteignable par aucune arête, et figure pourtant dans
    // la vue : la projection énumère les collections, elle ne parcourt pas
    // depuis l'entrée.
    let detached = stage(&view, "/stageNodes/@uuid=orphelin#0");
    assert_eq!(detached.name.value.as_deref(), Some("Détaché"));
    assert!(!view
        .edges
        .iter()
        .any(|edge| edge.to.as_deref() == Some(detached.path.as_str())));
}

#[test]
fn l_absence_et_le_null_ne_sont_jamais_rendus_par_la_meme_forme() {
    let view = view(&payload(LOOP_DOCUMENT, STUDIO_CONTEXT));
    let entry = stage(&view, "/stageNodes/@uuid=s1#0");
    assert_eq!(entry.audio.presence, PresenceKind::Value);
    assert_eq!(entry.audio.asset_ref.as_deref(), Some("a.mp3"));
    // `image` vaut `null` dans la source ; `groupId` est absent. Les deux
    // portent une valeur nulle, mais pas la même présence.
    assert_eq!(entry.image.presence, PresenceKind::Null);
    assert_eq!(entry.image.asset_ref, None);
    assert_eq!(entry.group_id.presence, PresenceKind::Absent);
    assert_eq!(entry.group_id.value, None);
}

#[test]
fn un_controle_absent_n_est_pas_rendu_comme_false() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"controlSettings":{"ok":true,"home":null}}],
"actionNodes":[]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let controls = &stage(&view, "/stageNodes/@uuid=s1#0").controls;
    assert_eq!(controls.presence, PresenceKind::Value);
    assert_eq!(controls.ok.value, Some(true));
    assert_eq!(controls.home.presence, PresenceKind::Null);
    assert_eq!(controls.home.value, None);
    // `wheel` manque, et ne devient pas `false`.
    assert_eq!(controls.wheel.presence, PresenceKind::Absent);
    assert_eq!(controls.wheel.value, None);
    assert!(!controls.complete);
}

#[test]
fn un_objet_de_controles_absent_rend_ses_cinq_membres_absents() {
    let document = r#"{"format":"v1","stageNodes":[{"uuid":"s1","squareOne":true}],
"actionNodes":[]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let controls = &stage(&view, "/stageNodes/@uuid=s1#0").controls;
    assert_eq!(controls.presence, PresenceKind::Absent);
    for member in [
        &controls.wheel,
        &controls.ok,
        &controls.home,
        &controls.pause,
        &controls.autoplay,
    ] {
        assert_eq!(member.presence, PresenceKind::Absent);
    }
    assert!(!controls.complete);
}

#[test]
fn une_selection_aleatoire_ne_designe_aucune_occurrence() {
    let view = view(&payload(SHARED_AND_DETACHED_DOCUMENT, STUDIO_CONTEXT));
    let entry = stage(&view, "/stageNodes/@uuid=entry#0");
    assert_eq!(entry.ok_transition.selection, Some(SelectionView::Random));
    // Deux options existent : `Random` est dans les bornes…
    assert!(entry.ok_transition.within_bounds);
    // …mais ne sélectionne rien, et surtout pas l'option 0.
    assert_eq!(entry.ok_transition.selected_option_id, None);
    assert_eq!(entry.ok_transition.resolved_stage_path, None);
}

#[test]
fn une_selection_fixe_resout_son_occurrence_et_son_ecran() {
    let view = view(&payload(SHARED_AND_DETACHED_DOCUMENT, STUDIO_CONTEXT));
    let second = stage(&view, "/stageNodes/@uuid=second#0");
    assert_eq!(
        second.ok_transition.selection,
        Some(SelectionView::Fixed { index: 1 })
    );
    assert!(second.ok_transition.within_bounds);
    assert_eq!(
        second.ok_transition.selected_option_id.as_deref(),
        Some("/actionNodes/@id=shared#0/options#1")
    );
    assert_eq!(
        second.ok_transition.resolved_stage_path.as_deref(),
        Some("/stageNodes/@uuid=target#0")
    );
}

#[test]
fn une_transition_absente_ne_porte_ni_cible_ni_selection_de_confort() {
    let view = view(&payload(SHARED_AND_DETACHED_DOCUMENT, STUDIO_CONTEXT));
    let target = stage(&view, "/stageNodes/@uuid=target#0");
    assert_eq!(target.ok_transition.presence, PresenceKind::Absent);
    assert_eq!(target.ok_transition.action_id, None);
    assert_eq!(target.ok_transition.selection, None);
    assert!(!target.ok_transition.within_bounds);
    // Une transition absente ne produit aucune arête.
    assert!(!view
        .edges
        .iter()
        .any(|edge| edge.from == target.path && edge.kind == EdgeKind::StageOk));
}

#[test]
fn les_references_media_portent_leurs_usages_et_jamais_un_chemin() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"audio":"commun.mp3","image":"fond.png"},
{"uuid":"s2","audio":"commun.mp3"}],"actionNodes":[]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    assert_eq!(view.media_refs.len(), 2);
    let commun = &view.media_refs[0];
    assert_eq!(commun.asset_ref, "commun.mp3");
    // Remplacer le fichier d'une référence affecte tous ses écrans, et l'UI
    // doit les montrer **avant** le geste.
    assert_eq!(commun.usages.len(), 2);
    assert_eq!(commun.usages[0].node_path, "/stageNodes/@uuid=s1#0");
    assert_eq!(commun.usages[0].field, MediaField::Audio);
    assert_eq!(commun.usages[1].node_path, "/stageNodes/@uuid=s2#0");
    let serialized = serde_json::to_string(&view).expect("vue sérialisable");
    assert!(!serialized.contains("assetsDir"));
    assert!(!serialized.contains("mediaBindings"));
}

#[test]
fn un_groupe_enrichi_est_transporte_sans_etre_transforme() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"type":"story","groupId":"g1"},
{"uuid":"s2","type":"menu.optionstage","groupId":"g2"}],
"actionNodes":[{"id":"a1","type":"story.storyaction","groupId":"g1","options":["s1"]}]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    assert_eq!(view.groups.len(), 2);
    let story = &view.groups[0];
    assert_eq!(story.group_id, "g1");
    assert_eq!(story.kind, GroupKindView::Story);
    assert_eq!(
        story.stage_paths,
        vec!["/stageNodes/@uuid=s1#0".to_string()]
    );
    assert_eq!(
        story.action_paths,
        vec!["/actionNodes/@id=a1#0".to_string()]
    );
    // Aucun groupe ne devient un Menu ou une Histoire dans la vue ;
    // les Écrans du groupe restent des Écrans distincts.
    assert_eq!(view.counts.stages, 2);
}

#[test]
fn l_entree_est_rendue_avec_son_statut() {
    let unique = view(&payload(LOOP_DOCUMENT, STUDIO_CONTEXT));
    assert_eq!(unique.entry.status, EntryStatus::Unique);
    assert_eq!(
        unique.entry.stage_path.as_deref(),
        Some("/stageNodes/@uuid=s1#0")
    );

    let sans_entree = r#"{"format":"v1","stageNodes":[{"uuid":"s1"}],"actionNodes":[]}"#;
    let missing = view(&payload(sans_entree, STUDIO_CONTEXT));
    assert_eq!(missing.entry.status, EntryStatus::Missing);
    assert_eq!(missing.entry.stage_path, None);

    let deux_entrees = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true},{"uuid":"s2","squareOne":true}],"actionNodes":[]}"#;
    let ambiguous = view(&payload(deux_entrees, STUDIO_CONTEXT));
    assert_eq!(ambiguous.entry.status, EntryStatus::Ambiguous);
    // Aucun des deux n'est choisi à la place de l'auteur ; les deux sont montrés.
    assert_eq!(ambiguous.entry.stage_path, None);
    assert_eq!(ambiguous.entry.candidates.len(), 2);
}

#[test]
fn la_lecture_est_deterministe_sur_le_meme_payload() {
    let source = payload(SHARED_AND_DETACHED_DOCUMENT, STUDIO_CONTEXT);
    let first = serde_json::to_string(&view(&source)).expect("vue sérialisable");
    let second = serde_json::to_string(&view(&source)).expect("vue sérialisable");
    assert_eq!(first, second);
}
