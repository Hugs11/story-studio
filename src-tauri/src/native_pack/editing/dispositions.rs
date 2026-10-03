//! Décisions d'export : dispositions de positions, dispositions d'extensions et
//! flatten explicite d'un groupe connu.
//!
//! Ces trois commandes existent déjà comme transformations pures dans
//! `authoring.rs`, livrées avant leur raccord. Ce module est ce raccord, et rien
//! de plus : il ne réécrit aucune règle, il les expose comme gestes atomiques et
//! traduit leurs refus en refus typés.
//!
//! Deux frontières sont tenues ici :
//!
//! - une extension conservée reçoit une disposition **explicite**
//!   (préserver `UNTESTED`, supprimer, promouvoir après preuve). L'absence de
//!   disposition quand une perte est possible reste un `ACTION_REQUIRED`, jamais
//!   une décision prise à la place de l'auteur ;
//! - le flatten est une action explicite, réservée aux groupes
//!   dont Story Studio connaît les marqueurs. Un groupe de forme inconnue est
//!   refusé : aucune sémantique enrichie inconnue n'est prétendue préservée, et
//!   il ne faut jamais la deviner.

use serde::Deserialize;

use super::positions::{node_path, NodeRef};
use super::GestureError;
use crate::native_pack::authoring::{
    flatten_known_group, set_opaque_export_disposition, set_position_export_disposition,
};
use crate::native_pack::{
    DecodedStoryDocument, OpaqueExportDisposition, PositionExportDisposition,
};

/// La disposition d'une position hors borne, attachée à sa valeur exacte.
pub(crate) fn set_position_disposition(
    payload: &mut DecodedStoryDocument,
    node: &NodeRef,
    disposition: PositionExportDisposition,
) -> Result<(), GestureError> {
    let path = format!("{}/position", node_path(&payload.document, node)?);
    set_position_export_disposition(payload, &path, disposition)
        .map_err(|error| GestureError::new("POSITION_DISPOSITION_REFUSED", &path, error))
}

/// La cible d'une disposition d'extension, telle que le DTO de lecture la rend.
///
/// `path`, `key` et `sourceOccurrence` sont recopiés depuis `OpaqueMemberView`
/// sans être recomposés : le chemin reste un jeton opaque côté JavaScript.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpaqueMemberRef {
    pub(crate) path: String,
    pub(crate) key: String,
    pub(crate) source_occurrence: usize,
}

pub(crate) fn set_opaque_disposition(
    payload: &mut DecodedStoryDocument,
    member: &OpaqueMemberRef,
    disposition: OpaqueExportDisposition,
) -> Result<(), GestureError> {
    set_opaque_export_disposition(
        payload,
        &member.path,
        &member.key,
        member.source_occurrence,
        disposition,
    )
    .map_err(|error| {
        GestureError::new(
            "OPAQUE_DISPOSITION_REFUSED",
            &format!("{}/{}", member.path, member.key),
            error,
        )
    })
}

/// Flatten volontaire d'un groupe dont les marqueurs sont connus.
pub(crate) fn flatten_group(
    payload: &mut DecodedStoryDocument,
    group_id: &str,
) -> Result<(), GestureError> {
    let flattened = flatten_known_group(&payload.document, group_id).map_err(|error| {
        GestureError::new(
            "GROUP_FLATTEN_REFUSED",
            &format!("/groups/{group_id}"),
            error,
        )
    })?;
    payload.document = flattened;
    Ok(())
}
