//! Origin recorded only at pack import; historical identities are never consulted.
use crate::services::{catalogue::CatalogueState, official_packs::is_official};
use crate::support::user_message::{codes, UserMessage};
use serde::{Deserialize, Serialize};

/// Returns (recognized, degraded). A negative embedded-only lookup is not proof of absence.
pub(crate) fn recognizes_official<
    C: crate::services::official_packs::OfficialCatalogue + ?Sized,
>(
    uuid: &str,
    catalogue: Option<&C>,
) -> (bool, bool) {
    is_official(uuid, catalogue).map(|official| (official, catalogue.is_none())).unwrap_or_else(|_| {
        log::warn!(target: "official_packs", "Official catalogue unavailable; using embedded recognition only");
        (is_official::<C>(uuid, None).unwrap_or(false), true)
    })
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OfficialProvenance {
    Official,
    NotOfficial,
    #[default]
    Unknown,
}

/// The single identity-lock rule. Never inspect originalUuid or identity history.
pub(crate) fn is_official_origin<C: crate::services::official_packs::OfficialCatalogue + ?Sized>(
    provenance: OfficialProvenance,
    current_uuid: &str,
    catalogue: Option<&C>,
) -> Result<bool, UserMessage> {
    Ok(
        provenance == OfficialProvenance::Official
            || recognizes_official(current_uuid, catalogue).0,
    )
}

pub(crate) fn imported_provenance(
    uuid: &str,
    catalogue: Option<&CatalogueState>,
) -> Result<OfficialProvenance, UserMessage> {
    Ok(imported_provenance_with_catalogue(uuid, catalogue))
}

pub(crate) fn imported_provenance_with_catalogue<
    C: crate::services::official_packs::OfficialCatalogue,
>(
    uuid: &str,
    catalogue: Option<&C>,
) -> OfficialProvenance {
    let (official, degraded) = recognizes_official(uuid, catalogue);
    if official {
        OfficialProvenance::Official
    } else if degraded {
        OfficialProvenance::Unknown
    } else {
        OfficialProvenance::NotOfficial
    }
}

pub(crate) fn check_identity_change(
    provenance: OfficialProvenance,
    current: &str,
    requested: &str,
    catalogue: Option<&CatalogueState>,
) -> Result<(), UserMessage> {
    if current != requested && is_official_origin(provenance, current, catalogue)? {
        return Err(UserMessage::new(codes::OFFICIAL_IDENTITY_LOCKED));
    }
    Ok(())
}

/// Libre containment comes from document entries, ignoring the untrusted JS summary.
pub(crate) fn contains_official_content(project: &crate::domain::project::Project) -> bool {
    fn entry_contains(entry: &crate::domain::project::ProjectEntry) -> bool {
        entry.official_provenance == OfficialProvenance::Official
            || entry.contains_official_content
            || entry.children.iter().any(entry_contains)
    }
    project
        .root_entries
        .iter()
        .chain(&project.shared_entries)
        .any(entry_contains)
}
