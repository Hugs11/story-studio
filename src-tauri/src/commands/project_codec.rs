//! Frontière IPC du projet avancé ; aucun accès disque ni import.
//!
//! Les quatre commandes partagent une règle : elles rendent une **vue dérivée**
//! ou une **chaîne de payload**, jamais un document ouvert à JavaScript. Aucune
//! ne réémet le payload qu'on lui confie, et aucune ne persiste son résultat.
use crate::native_pack::editing::{
    apply_advanced_gesture as apply_gesture, AdvancedGesture, AdvancedGestureOutcome, GestureError,
};
use crate::native_pack::graph_view::dto::AdvancedGraphView;
use crate::native_pack::persistence::{
    validate_authoring_payload, AdvancedMediaBinding, AuthoringPayloadSummary, PersistenceError,
};
use crate::native_pack::readiness::{assess_graph_document_export_readiness, ExportReadiness};

#[tauri::command]
pub(crate) fn validate_advanced_payload(
    payload: String,
) -> Result<AuthoringPayloadSummary, PersistenceError> {
    validate_authoring_payload(&payload)
}

/// Projection de lecture du graphe d'auteur.
///
/// Comme ses quatre sœurs, elle rend une **vue dérivée** : elle ne réémet pas
/// le payload qu'on lui confie, ne persiste rien et ne touche pas au disque.
/// Elle ne définit aucun code d'erreur propre — les refus du codec ressortent
/// tels quels. Un document décodable mais qui viole les invariants du graphe
/// est **lu**, avec ses défauts dans `diagnostics` : c'est la seule façon de le
/// montrer à l'auteur pour qu'il le répare.
#[tauri::command]
pub(crate) fn read_advanced_graph_view(
    payload: String,
) -> Result<AdvancedGraphView, PersistenceError> {
    crate::native_pack::graph_view::read_advanced_graph_view(&payload)
}

/// Acquisition d'un document créé : l'unique tirage d'identité du cycle de vie
/// d'un projet avancé né dans Story Studio.
///
/// Elle n'est appelée qu'à l'initialisation. Ni la sauvegarde, ni la relecture,
/// ni l'annulation ne repassent par là : le payload acquis devient la valeur du
/// projet, et `decode_authoring_payload` recharge ensuite l'identité telle
/// quelle ; elle ne change donc jamais au fil du cycle de vie.
#[tauri::command]
pub(crate) fn create_advanced_document(title: String) -> Result<String, PersistenceError> {
    crate::native_pack::persistence::create_advanced_document(
        &title,
        &mut crate::native_pack::persistence::system_pack_identity,
    )
}

/// Qualification d'export recalculée depuis le payload **courant**.
///
/// `ExportReadiness` n'est persistée nulle part : elle est dérivée à la demande
/// du payload que l'appelant tient en mémoire, donc une édition la change sans
/// qu'aucun `SUPPORTED` ancien puisse être réutilisé. Blocage et qualification
/// restent deux couches : un document peut être `blocked` avec toutes ses
/// dimensions `SUPPORTED`.
#[tauri::command]
pub(crate) fn assess_advanced_payload_readiness(
    payload: String,
) -> Result<ExportReadiness, PersistenceError> {
    let decoded = crate::native_pack::persistence::decode_authoring_payload(&payload)?;
    Ok(assess_graph_document_export_readiness(Ok(&decoded)))
}

/// Geste d'auteur appliqué au payload **courant**.
///
/// Une seule commande porte **tous** les gestes : le tag `gesture` de la demande
/// choisit l'opération, et la réponse rend ensemble le nouveau payload, les
/// liaisons médias mises à jour et le rapport du geste. Ajouter une famille de
/// gestes n'ajoute pas de commande, parce que la frontière IPC est la même :
/// un payload entre, un payload et son rapport sortent.
///
/// Comme les trois autres commandes, elle ne touche pas au disque, ne persiste
/// rien et ne réémet aucun payload qu'on ne lui a pas demandé de muter. La
/// readiness reste à demander séparément, sur le payload rendu.
#[tauri::command]
pub(crate) fn apply_advanced_gesture(
    payload: String,
    media_bindings: Vec<AdvancedMediaBinding>,
    gesture: AdvancedGesture,
) -> Result<AdvancedGestureOutcome, GestureError> {
    apply_gesture(&payload, media_bindings, &gesture)
}
