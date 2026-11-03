//! Frontière IPC du projet avancé ; aucun accès aux fichiers projet ni import.
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
use crate::support::user_message::{codes, UserMessage};

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
pub(crate) fn create_advanced_document(
    title: String,
    initial_stage_name: Option<String>,
) -> Result<String, PersistenceError> {
    crate::native_pack::persistence::create_advanced_document_named(
        &title,
        initial_stage_name.as_deref(),
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
    let mut assessment = assess_graph_document_export_readiness(Ok(&decoded));
    // Only the transient UI message is adapted; readiness and its evidence stay intact.
    for diagnostic in &mut assessment.diagnostics {
        if let crate::native_pack::readiness::ReadinessDiagnostic::Readiness(observation) =
            diagnostic
        {
            if observation.code == "ROOT_UUID_DIVERGENT" {
                let identity = decoded
                    .context
                    .pack_identity
                    .value
                    .as_deref()
                    .or_else(|| {
                        decoded
                            .document
                            .stage_nodes
                            .iter()
                            .find(|stage| stage.square_one.value() == Some(&true))
                            .map(|stage| stage.uuid.as_str())
                    })
                    .unwrap_or_default();
                observation.message = UserMessage::new(codes::ROOT_UUID_DIVERGENT)
                    .param(
                        "rootUuid",
                        decoded.document.uuid.as_deref().unwrap_or_default(),
                    )
                    .param("identity", identity)
                    .into_transport();
            }
        }
    }
    Ok(assessment)
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
pub(crate) fn apply_advanced_gesture(
    payload: String,
    media_bindings: Vec<AdvancedMediaBinding>,
    gesture: AdvancedGesture,
) -> Result<AdvancedGestureOutcome, GestureError> {
    apply_gesture(&payload, media_bindings, &gesture)
}

/// Runtime authorization augments the pure engine with the already-open catalogue.
pub(crate) mod ipc {
    use super::*;
    #[tauri::command]
    pub(crate) fn read_advanced_graph_view(
        payload: String,
        catalogue: tauri::State<'_, crate::services::catalogue::CatalogueState>,
    ) -> Result<AdvancedGraphView, PersistenceError> {
        let mut view = super::read_advanced_graph_view(payload)?;
        view.identity_locked = crate::domain::official_provenance::is_official_origin(
            view.official_provenance,
            view.pack_identity.value.as_deref().unwrap_or_default(),
            Some(catalogue.inner()),
        )
        .expect("recognition falls back to the embedded list");
        Ok(view)
    }

    #[tauri::command]
    pub(crate) fn apply_advanced_gesture(
        payload: String,
        media_bindings: Vec<AdvancedMediaBinding>,
        gesture: AdvancedGesture,
        catalogue: tauri::State<'_, crate::services::catalogue::CatalogueState>,
    ) -> Result<AdvancedGestureOutcome, GestureError> {
        if let AdvancedGesture::SetDocumentMetadata { update } = &gesture {
            let decoded = crate::native_pack::persistence::decode_authoring_payload(&payload)?;
            crate::native_pack::editing::metadata::check_identity_update(
                &decoded,
                update,
                Some(catalogue.inner()),
            )?;
        }
        super::apply_advanced_gesture(payload, media_bindings, gesture)
    }
}
