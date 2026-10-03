//! Inspection d'une archive importée : est-ce un pack, ou une enveloppe qui en
//! contient plusieurs ?
//!
//! La détection de l'enveloppe vit dans `support::imported_pack` ; c'est ici
//! que chaque enfant reçoit son verdict, et il le reçoit du **classifieur
//! existant**, celui qui juge n'importe quel pack. Un second classifieur serait
//! une seconde vérité : l'écran de choix afficherait un verdict que la suite du
//! parcours ne confirmerait pas.

use serde::Serialize;

use super::extraction::classify_pack_editability;
use crate::support::imported_pack::{
    bundle_container_fingerprint, ensure_studio_pack_source, BundleChildEntry, ImportedPackSource,
};

/// Ce que l'inspection rend au frontend. `Direct` ne porte aucun enfant : le
/// parcours d'import se poursuit exactement comme avant.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackArchiveInspection {
    pub kind: PackArchiveKind,
    pub container_fingerprint: String,
    pub children: Vec<InspectedBundleChild>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackArchiveKind {
    Direct,
    Bundle,
}

/// Le verdict d'un enfant, dans les mêmes termes que ceux dont dispose le
/// funnel pour un pack fourni seul.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BundleChildStatus {
    Editable,
    ReadOnly,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedBundleChild {
    pub child_id: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub status: BundleChildStatus,
    pub reason: String,
    /// Faux uniquement quand l'enfant n'a pas pu être lu. Un enfant en lecture
    /// seule ou non supporté reste sélectionnable : le funnel lui propose la
    /// simulation ou l'Éditeur avancé, comme pour un pack fourni seul.
    pub selectable: bool,
}

/// `progress(fait, total)` rend compte de l'avancement de l'examen d'une
/// enveloppe. Il ne transporte aucun nom de pack : l'inventaire d'une
/// bibliothèque privée n'a rien à faire dans un journal.
pub fn inspect_pack_archive<P: Fn(usize, usize)>(
    path: &str,
    progress: P,
) -> Result<PackArchiveInspection, String> {
    let container_fingerprint = bundle_container_fingerprint(path)?;
    let source = ensure_studio_pack_source(path)?;
    let inventory = match source {
        ImportedPackSource::Pack(_) => {
            return Ok(PackArchiveInspection {
                kind: PackArchiveKind::Direct,
                container_fingerprint,
                children: Vec::new(),
            })
        }
        ImportedPackSource::Bundle(inventory) => inventory,
    };

    let total = inventory.children().len();
    let mut children = Vec::with_capacity(total);
    for (index, child) in inventory.children().iter().enumerate() {
        progress(index, total);
        children.push(classify_child(child));
    }
    progress(total, total);

    Ok(PackArchiveInspection {
        kind: PackArchiveKind::Bundle,
        container_fingerprint,
        children,
    })
}

fn classify_child(child: &BundleChildEntry) -> InspectedBundleChild {
    let (status, reason) = match child
        .absolute
        .to_str()
        .ok_or_else(|| "Chemin temporaire non Unicode.".to_string())
        .and_then(classify_pack_editability)
    {
        Ok(report) if report.authoring_editable => (BundleChildStatus::Editable, report.reason),
        Ok(report) if report.read_only_inspectable => (BundleChildStatus::ReadOnly, report.reason),
        Ok(report) => (BundleChildStatus::Unsupported, report.reason),
        Err(error) => (BundleChildStatus::Error, error),
    };
    InspectedBundleChild {
        child_id: child.child_id.clone(),
        display_name: child.display_name.clone(),
        size_bytes: child.size_bytes,
        selectable: status != BundleChildStatus::Error,
        reason,
        status,
    }
}
