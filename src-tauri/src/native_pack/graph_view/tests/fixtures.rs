//! Payloads d'essai, écrits à la main comme des chaînes.
//!
//! Aucun n'est construit par `serde_json::to_string` : la graphie exacte fait
//! partie de ce qui est éprouvé — un entier hors domaine sûr, un `null`
//! explicite et une clé absente ne survivraient pas à un aller-retour par une
//! valeur Rust déjà typée.

use crate::native_pack::graph_view::{dto::AdvancedGraphView, read_advanced_graph_view};

pub(super) fn view(payload: &str) -> AdvancedGraphView {
    read_advanced_graph_view(payload).expect("payload lisible")
}

/// Enveloppe un document et un contexte dans un payload de version 1.
pub(super) fn payload(document: &str, context: &str) -> String {
    format!(r#"{{"payloadVersion":1,"document":{document},"context":{context}}}"#)
}

/// Le contexte minimal d'un import STUdio : aucune provenance surchargée,
/// aucune disposition d'éditeur, aucun membre opaque.
pub(super) const STUDIO_CONTEXT: &str = r#"{"documentOrigin":"imported-studio",
"defaultValueOrigin":"source-studio",
"packIdentity":{"origin":"square-one-stage","value":"11111111-1111-4111-8111-111111111111",
"shortIdentity":"11111111","sourcePath":"/stageNodes/@uuid=11111111-1111-4111-8111-111111111111#0",
"unresolvedReason":null}}"#;

/// Un document sain minimal : un Écran d'entrée, une Action, une option qui
/// revient sur l'Écran — donc une boucle, qui doit rester une boucle.
pub(super) const LOOP_DOCUMENT: &str = r#"{"title":"Boucle","format":"v1",
"stageNodes":[{"uuid":"s1","squareOne":true,"name":"Entrée","type":"story",
"audio":"a.mp3","image":null,
"controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":true},
"okTransition":{"actionNode":"act","optionIndex":0},
"position":{"x":10,"y":20}}],
"actionNodes":[{"id":"act","name":"Suite","options":["s1"]}]}"#;

/// Deux occurrences d'option vers le **même** Écran, plus un Écran détaché que
/// nul ne référence : les deux cas que le banc d'essai doit voir.
pub(super) const SHARED_AND_DETACHED_DOCUMENT: &str = r#"{"format":"v1",
"stageNodes":[
{"uuid":"entry","squareOne":true,"okTransition":{"actionNode":"shared","optionIndex":-1}},
{"uuid":"second","okTransition":{"actionNode":"shared","optionIndex":1}},
{"uuid":"target"},
{"uuid":"orphelin","name":"Détaché"}],
"actionNodes":[{"id":"shared","options":["target","target"]}]}"#;

pub(super) fn stage<'a>(
    view: &'a AdvancedGraphView,
    path: &str,
) -> &'a crate::native_pack::graph_view::dto::StageView {
    view.stages
        .iter()
        .find(|stage| stage.path == path)
        .unwrap_or_else(|| panic!("Écran attendu : {path}"))
}

pub(super) fn action<'a>(
    view: &'a AdvancedGraphView,
    path: &str,
) -> &'a crate::native_pack::graph_view::dto::ActionView {
    view.actions
        .iter()
        .find(|action| action.path == path)
        .unwrap_or_else(|| panic!("Action attendue : {path}"))
}
