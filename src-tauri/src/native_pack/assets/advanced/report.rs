//! Ce que la préparation rend au writer, et à l'auteur.
//!
//! Deux objets distincts et volontairement séparés : le **rapport de
//! conversion**, qui dit fichier par fichier ce qui a été fait, et la
//! **carte des destinations**, qui dit quel contenu arrive à quelle place du
//! graphe. Le premier s'affiche, le second se vérifie.

use serde::Serialize;

use super::naming::ArchiveNameTable;
use super::plan::ConversionPlan;
use super::{MediaKind, PreparedArchiveEntry};
use crate::native_pack::NativeGenerationWarning;

/// Ce qu'une préparation a fait d'un média.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Transformation {
    /// Octets conservés, nom déjà cohérent avec leur format réel.
    Verbatim,
    /// Octets conservés, nom d'archive recalculé sur le format réel.
    Renamed,
    /// Ré-encodé sans changer les dimensions.
    Reencoded,
    /// Redimensionné, donc ré-encodé.
    Resized,
}

/// Une ligne du rapport de conversion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetConversionRecord {
    pub(crate) asset_ref: String,
    pub(crate) archive_name: String,
    pub(crate) kind: MediaKind,
    pub(crate) transformation: Transformation,
    pub(crate) reason: String,
    pub(crate) detected_source_format: String,
    pub(crate) output_format: String,
    pub(crate) snapshot_sha256: String,
    pub(crate) task_key: String,
    pub(crate) output_sha256: String,
    pub(crate) source_bytes: u64,
    pub(crate) output_bytes: u64,
    /// Celles de T1 à T6 réellement appliquées.
    pub(crate) applied_plan: Vec<&'static str>,
    /// Première référence à porter le même contenu, quand ce média n'ajoute
    /// aucun fichier à l'archive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) deduplicated_with: Option<String>,
}

/// Une place du graphe, et le fichier qui y arrive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedDestination {
    pub(crate) stage_uuid: String,
    #[serde(rename = "field")]
    pub(crate) kind: MediaKind,
    pub(crate) asset_ref: String,
    pub(crate) archive_name: String,
    pub(crate) output_sha256: String,
}

/// Le livrable du lot : des fichiers prêts, et de quoi prouver leur place.
///
/// Rien n'y désigne le projet d'auteur : la préparation lit un document et des
/// liaisons, elle n'écrit ni dans l'un ni dans les autres.
#[derive(Debug, Clone)]
pub(crate) struct AdvancedAssetPreparation {
    /// Rapport de conversion, ordonné par référence.
    pub(crate) assets: Vec<AssetConversionRecord>,
    /// Carte des destinations, dans l'ordre du document.
    pub(crate) destinations: Vec<PreparedDestination>,
    /// Table `assetRef → nom d'archive`.
    pub(crate) name_table: ArchiveNameTable,
    /// Les fichiers à écrire, un par nom d'archive distinct.
    pub(crate) archive_entries: Vec<PreparedArchiveEntry>,
    /// Ce que l'harmonisation a coûté, dit comme dans l'éditeur par menus.
    pub(crate) audio_warnings: Vec<NativeGenerationWarning>,
}

/// Nomme la transformation d'un plan, du point de vue de l'auteur.
pub(crate) fn transformation_of(
    plan: &ConversionPlan,
    source_extension_matches_output: bool,
    resized: bool,
) -> Transformation {
    match plan {
        ConversionPlan::AudioVerbatim | ConversionPlan::ImageVerbatim { .. } => {
            if source_extension_matches_output {
                Transformation::Verbatim
            } else {
                Transformation::Renamed
            }
        }
        ConversionPlan::AudioEncode { .. } => Transformation::Reencoded,
        ConversionPlan::ImageResizePng => {
            if resized {
                Transformation::Resized
            } else {
                Transformation::Reencoded
            }
        }
    }
}
