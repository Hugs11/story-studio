//! Ce que la vue fait d'un document abîmé : elle le **montre**, elle ne le
//! répare pas et elle ne le refuse pas.

use super::fixtures::*;
use crate::native_pack::graph_view::dto::*;

#[test]
fn un_document_invalide_au_sens_gvi_est_lu_et_non_refuse() {
    // Identifiant dupliqué, cible pendante, option nulle, sélection hors
    // bornes, aucun `squareOne` : cinq refus GVI dans un seul document.
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"double","okTransition":{"actionNode":"a1","optionIndex":7}},
{"uuid":"double"}],
"actionNodes":[{"id":"a1","options":["inconnu",null]}]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    assert_eq!(view.counts.stages, 2);
    let codes: Vec<&str> = view
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.family == DiagnosticFamily::GraphIntegrity)
        .map(|diagnostic| diagnostic.code.as_str())
        .collect();
    assert!(codes.contains(&"DUPLICATE_STAGE_ID"));
    assert!(codes.contains(&"SQUARE_ONE_COUNT"));
    assert!(codes.contains(&"OPTION_TARGET_NULL"));
    assert!(codes.contains(&"OPTION_TARGET_MISSING"));
    assert!(codes.contains(&"OPTION_SELECTION_INVALID"));
}

#[test]
fn un_identifiant_duplique_est_lisible_mais_signale_non_editable() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"double","squareOne":true,"name":"Premier"},
{"uuid":"double","name":"Second"}],"actionNodes":[]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let first = stage(&view, "/stageNodes/@uuid=double#0");
    let second = stage(&view, "/stageNodes/@uuid=double#1");
    assert_eq!(first.occurrence, 0);
    assert_eq!(second.occurrence, 1);
    assert_eq!(first.name.value.as_deref(), Some("Premier"));
    assert_eq!(second.name.value.as_deref(), Some("Second"));
    // Les gestes refuseront d'agir sur cet identifiant : l'UI doit pouvoir
    // l'expliquer **avant** de proposer le geste.
    assert!(!first.unique_id);
    assert!(!second.unique_id);
}

#[test]
fn une_cible_pendante_et_une_option_nulle_restent_distinctes() {
    let document = r#"{"format":"v1","stageNodes":[{"uuid":"s1","squareOne":true}],
"actionNodes":[{"id":"a1","options":["fantome",null,"s1"]}]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let options = &action(&view, "/actionNodes/@id=a1#0").options;
    assert_eq!(options[0].target.presence, PresenceKind::Value);
    assert_eq!(options[0].target.stage_uuid.as_deref(), Some("fantome"));
    assert!(options[0].target.dangling);
    // Une cible `null` n'est pas une cible pendante : elle n'a jamais désigné
    // personne, et son ordinal est conservé.
    assert_eq!(options[1].target.presence, PresenceKind::Null);
    assert_eq!(options[1].target.stage_uuid, None);
    assert!(!options[1].target.dangling);
    assert_eq!(options[2].ordinal, 2);
    assert!(!options[2].target.dangling);
}

#[test]
fn une_action_introuvable_et_une_selection_hors_bornes_sont_deux_faits() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"okTransition":{"actionNode":"absente","optionIndex":0},
"homeTransition":{"actionNode":"a1","optionIndex":9}}],
"actionNodes":[{"id":"a1","options":["s1"]}]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let entry = stage(&view, "/stageNodes/@uuid=s1#0");
    // Action absente : le chemin est nul, l'identifiant demandé reste visible.
    assert_eq!(entry.ok_transition.action_id.as_deref(), Some("absente"));
    assert_eq!(entry.ok_transition.action_path, None);
    // Sélection hors bornes sur une Action qui existe : le chemin est là, la
    // sélection aussi, et seul `withinBounds` tombe.
    assert_eq!(
        entry.home_transition.action_path.as_deref(),
        Some("/actionNodes/@id=a1#0")
    );
    assert_eq!(
        entry.home_transition.selection,
        Some(SelectionView::Fixed { index: 9 })
    );
    assert!(!entry.home_transition.within_bounds);
    assert_eq!(entry.home_transition.selected_option_id, None);
    let ok_edge = view
        .edges
        .iter()
        .find(|edge| edge.kind == EdgeKind::StageOk)
        .expect("arête OK");
    assert!(ok_edge.dangling);
    assert_eq!(ok_edge.to, None);
}

#[test]
fn un_chemin_cyclique_ne_fait_pas_boucler_la_lecture() {
    // Trois Écrans en anneau, plus un self-loop : la projection énumère et ne
    // parcourt jamais, donc aucune profondeur n'est atteinte.
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"okTransition":{"actionNode":"a1","optionIndex":0}},
{"uuid":"s2","okTransition":{"actionNode":"a2","optionIndex":0}},
{"uuid":"s3","okTransition":{"actionNode":"a3","optionIndex":0}}],
"actionNodes":[{"id":"a1","options":["s2"]},{"id":"a2","options":["s3"]},
{"id":"a3","options":["s1","s3"]}]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    assert_eq!(view.counts.stages, 3);
    assert_eq!(view.counts.edges, 7);
    let self_loop = view
        .edges
        .iter()
        .find(|edge| edge.edge_id == "/actionNodes/@id=a3#0/options#1")
        .expect("arête de boucle");
    assert_eq!(self_loop.to.as_deref(), Some("/stageNodes/@uuid=s3#0"));
}

#[test]
fn cent_et_cent_une_options_sont_lues_sans_borne_inventee() {
    for count in [100_usize, 101] {
        let targets = (0..count)
            .map(|_| "\"s1\"".to_string())
            .collect::<Vec<_>>()
            .join(",");
        let document = format!(
            r#"{{"format":"v1","stageNodes":[{{"uuid":"s1","squareOne":true}}],
"actionNodes":[{{"id":"roue","options":[{targets}]}}]}}"#
        );
        let view = view(&payload(&document, STUDIO_CONTEXT));
        // 101 options est `UNTESTED`, jamais `INVALID`. La lecture ne tronque
        // pas et ne diagnostique aucun dépassement.
        assert_eq!(view.counts.options, count);
        assert_eq!(view.counts.edges, count);
        assert!(!view
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.contains("MAX_OPTIONS")));
    }
}

#[test]
fn une_coordonnee_projetee_extreme_traverse_sans_arrondi() {
    let document = r#"{"format":"v1","stageNodes":[{"uuid":"s1","squareOne":true}],
"actionNodes":[]}"#;
    let context = r#"{"documentOrigin":"imported-fs","defaultValueOrigin":"source-native-derived",
"editorPositions":[{"path":"/stageNodes/@uuid=s1#0/position","origin":"projection-derived",
"position":{"x":376960,"y":160}}]}"#;
    let view = view(&payload(document, context));
    let entry = stage(&view, "/stageNodes/@uuid=s1#0");
    assert_eq!(entry.layout.source, LayoutSource::EditorPosition);
    assert_eq!(entry.layout.x, 376_960.0);
    assert_eq!(
        entry.layout.origin,
        Some(crate::native_pack::dialect::ValueOrigin::ProjectionDerived)
    );
    // Le quadrillage FS est servi au rang 2 ; il n'est ni remplacé, ni corrigé
    // par le placement de secours.
    assert_eq!(entry.source_position, None);
}

#[test]
fn la_position_d_auteur_prime_et_reste_visible_a_cote_de_la_disposition() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"position":{"x":-40000,"y":12.5}}],"actionNodes":[]}"#;
    let context = r#"{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio",
"editorPositions":[{"path":"/stageNodes/@uuid=s1#0/position","origin":"projection-derived",
"position":{"x":0,"y":0}}]}"#;
    let view = view(&payload(document, context));
    let entry = stage(&view, "/stageNodes/@uuid=s1#0");
    assert_eq!(entry.layout.source, LayoutSource::Authored);
    assert_eq!(entry.layout.x, -40_000.0);
    // La position source est exposée séparément même quand le rang 1
    // s'applique : elle reste une donnée auteur et n'est jamais corrigée par
    // la projection de vue.
    let source = entry.source_position.as_ref().expect("position source");
    assert_eq!(source.y_text, "12.5");
    assert!(source.exact_in_double);
}

/// Déplacer un nœud ne doit pas déplacer les autres.
///
/// Le placement de secours rangeait les nœuds sans disposition par un rang
/// dense sur ce seul sous-ensemble. Dès qu'un nœud recevait une position, il
/// en sortait, et tous les suivants remontaient d'une case : l'auteur voyait un
/// voisin venir occuper la place qu'il venait de libérer. Le rang porte
/// désormais sur la collection entière, et la place libérée reste un trou.
#[test]
fn une_position_posee_ne_deplace_aucun_autre_noeud() {
    let sans_position = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true},{"uuid":"s2"},{"uuid":"s3"},{"uuid":"s4"}],
"actionNodes":[]}"#;
    // Le deuxième Écran vient d'être déplacé par l'auteur.
    let avec_position = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true},{"uuid":"s2","position":{"x":1500,"y":-200}},
{"uuid":"s3"},{"uuid":"s4"}],
"actionNodes":[]}"#;

    let avant = view(&payload(sans_position, STUDIO_CONTEXT));
    let apres = view(&payload(avec_position, STUDIO_CONTEXT));
    let place = |vue: &AdvancedGraphView, uuid: &str| {
        let entry = stage(vue, &format!("/stageNodes/@uuid={uuid}#0"));
        (entry.layout.x, entry.layout.y)
    };

    // Le nœud déplacé porte sa position d'auteur.
    assert_eq!(place(&apres, "s2"), (1500.0, -200.0));
    // Les trois autres n'ont pas bougé d'un pixel, et la case libérée par `s2`
    // reste vide au lieu d'être reprise par `s3`.
    for uuid in ["s1", "s3", "s4"] {
        assert_eq!(place(&avant, uuid), place(&apres, uuid), "{uuid} a bougé");
    }
    assert_ne!(place(&apres, "s3"), place(&avant, "s2"));
}

#[test]
fn le_placement_de_secours_est_deterministe_et_n_ecrit_rien() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true},{"uuid":"s2"},{"uuid":"s3"},{"uuid":"s4"},{"uuid":"s5"}],
"actionNodes":[{"id":"a1","options":["s1"]}]}"#;
    let source = payload(document, STUDIO_CONTEXT);
    let view = view(&source);
    // Cinq Écrans : `ceil(sqrt(5)) = 3` colonnes, et un pas vertical qui loge
    // la carte peinte et son libellé.
    let positions: Vec<(f64, f64)> = view
        .stages
        .iter()
        .map(|stage| (stage.layout.x, stage.layout.y))
        .collect();
    assert_eq!(
        positions,
        vec![
            (0.0, 0.0),
            (240.0, 0.0),
            (480.0, 0.0),
            (0.0, 200.0),
            (240.0, 200.0)
        ]
    );
    // L'Action est dans sa propre bande : elle ne recouvre pas un Écran.
    // Sa collection ne compte qu'un nœud, donc une seule colonne.
    let action = action(&view, "/actionNodes/@id=a1#0");
    assert_eq!((action.layout.x, action.layout.y), (0.0, 96.0));
    assert_eq!(action.layout.source, LayoutSource::Fallback);
    assert_eq!(action.layout.origin, None);
    // Relire le même payload rend la même disposition : elle est recalculable,
    // donc elle n'a aucune raison d'être écrite.
    assert_eq!(
        serde_json::to_string(&view).expect("vue sérialisable"),
        serde_json::to_string(&self::view(&source)).expect("vue sérialisable")
    );
}

#[test]
fn les_refus_du_codec_ressortent_tels_quels() {
    use crate::native_pack::graph_view::read_advanced_graph_view;

    let error = read_advanced_graph_view("{").expect_err("JSON invalide");
    assert_eq!(error.code, "INVALID_PAYLOAD_JSON");
    let error = read_advanced_graph_view("[]").expect_err("forme invalide");
    assert_eq!(error.code, "INVALID_PAYLOAD_SHAPE");
    let error = read_advanced_graph_view(r#"{"document":{}}"#).expect_err("version absente");
    assert_eq!(error.code, "PAYLOAD_MIGRATION_REQUIRED");
    assert_eq!(error.path, "/payloadVersion");
}

#[test]
fn un_membre_opaque_est_rendu_borne_et_sa_decision_perimee_visible() {
    let long = "x".repeat(300);
    let document = r#"{"format":"v1","stageNodes":[{"uuid":"s1","squareOne":true}],
"actionNodes":[]}"#;
    let context = format!(
        r#"{{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio",
"opaqueMembers":[
{{"scope":"stage","path":"/stageNodes/@uuid=s1#0","key":"cadence","sourceOccurrence":0,
"kind":"unknown-extension","origin":"source-studio","value":"{long}",
"exportDisposition":"preserve-untested","exportDispositionValue":"autre chose",
"exportDispositionOrigin":"source-studio"}}]}}"#
    );
    let view = view(&payload(document, &context));
    let member = &view.opaque_members[0];
    assert_eq!(member.node_path.as_deref(), Some("/stageNodes/@uuid=s1#0"));
    assert!(member.truncated);
    assert!(member.value_preview.chars().count() <= 161);
    assert!(member.value_preview.ends_with('…'));
    // La décision portait sur une autre valeur : elle est périmée, et la vue
    // le dit au lieu de la présenter comme courante.
    assert!(member.disposition_stale);
}

#[test]
fn chaque_diagnostic_porte_le_prefixe_de_noeud_calcule_en_rust() {
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"s1","squareOne":true,"type":"inconnu","controlSettings":{"ok":true}}],
"actionNodes":[]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let unknown_type = view
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "ENRICHED_TYPE_UNKNOWN")
        .expect("type inconnu signalé");
    assert_eq!(unknown_type.family, DiagnosticFamily::Authoring);
    assert_eq!(unknown_type.path, "/stageNodes/@uuid=s1#0/type");
    assert_eq!(
        unknown_type.node_path.as_deref(),
        Some("/stageNodes/@uuid=s1#0")
    );
    let incomplete = view
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "CONTROL_SETTINGS_INCOMPLETE")
        .expect("contrôles incomplets signalés");
    assert_eq!(
        incomplete.node_path.as_deref(),
        Some("/stageNodes/@uuid=s1#0")
    );
    assert!(!incomplete.resolutions.is_empty());
}

#[test]
fn un_identifiant_qui_contient_un_diese_garde_son_prefixe_de_noeud() {
    // `stable_node_paths` n'échappe que `~` et `/` : un `#` reste dans la
    // graphie. Le préfixe se coupe au troisième `/`, pas au dernier `#`.
    let document = r#"{"format":"v1","stageNodes":[
{"uuid":"a#0/b","squareOne":true,"type":"inconnu"}],"actionNodes":[]}"#;
    let view = view(&payload(document, STUDIO_CONTEXT));
    let entry = &view.stages[0];
    assert_eq!(entry.path, "/stageNodes/@uuid=a#0~1b#0");
    assert_eq!(entry.uuid, "a#0/b");
    let diagnostic = view
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "ENRICHED_TYPE_UNKNOWN")
        .expect("type inconnu signalé");
    assert_eq!(diagnostic.node_path.as_deref(), Some(entry.path.as_str()));
}

#[test]
fn la_vue_ne_porte_aucune_readiness_ni_aucune_qualification() {
    let context = r#"{"documentOrigin":"imported-fs","defaultValueOrigin":"source-native-derived",
"exportQualifications":[{"dimension":"studio-export-version","path":"/version",
"status":"UNTESTED","reason":"essai"}]}"#;
    let view = view(&payload(LOOP_DOCUMENT, context));
    let serialized = serde_json::to_string(&view).expect("vue sérialisable");
    // La readiness reste recalculée à la demande par
    // `assess_advanced_payload_readiness` et n'est jamais mémorisée.
    assert!(!serialized.contains("UNTESTED"));
    assert!(!serialized.contains("blocked"));
    assert!(!serialized.contains("exportQualifications"));
}
