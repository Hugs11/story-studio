use serde::Serialize;

mod assets;
mod builder;
mod canonical;
mod document;
pub(crate) mod fidelity_judge;
mod stats;
mod writer;

use assets::pipeline::*;
#[cfg(test)]
use assets::{
    audio::{
        audio_filters, audio_filters_with_action, audio_filters_with_duration,
        mp3_header_is_native_compatible, processed_audio_output_name,
    },
    image::stage_binary_asset,
};
#[cfg(test)]
use builder::transitions::*;
use builder::StoryBuilder;
pub(crate) use canonical::*;
pub(crate) use document::*;
pub(crate) use stats::*;
pub(crate) use writer::*;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct NativeAssetPreparationReport {
    pub(crate) project: CanonicalProject,
    pub(crate) stage_dir: String,
    pub(crate) assets_dir: String,
    pub(crate) assets: Vec<PreparedAsset>,
    pub(crate) imported_zips: Vec<ImportedZipBundle>,
    pub(crate) stats: NativeAssetStats,
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PreparedAsset {
    pub(crate) role: String,
    pub(crate) source_path: String,
    pub(crate) source_kind: String,
    pub(crate) staged_asset_name: String,
    pub(crate) staged_asset_path: String,
    pub(crate) transformed: bool,
    pub(crate) deduplicated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ImportedZipBundle {
    pub(crate) role: String,
    pub(crate) zip_path: String,
    pub(crate) square_one_stage_id: String,
    pub(crate) root_action_id: String,
    pub(crate) post_root_stage_id: String,
    pub(crate) entry_stage_id: String,
    pub(crate) document: StoryDocument,
}

fn build_story_document(report: &NativeAssetPreparationReport) -> Result<StoryDocument, String> {
    if active_native_graph(report.project.native_graph.as_ref()).is_some() {
        let fidelity = fidelity_judge::canonical_roundtrip_is_faithful(&report.project)?;
        if !fidelity.faithful {
            let detail = fidelity
                .gaps
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(" | ");
            return Err(if detail.is_empty() {
                "Génération bloquée : le modèle canonique n'est pas fidèle au graphe natif d'origine.".to_string()
            } else {
                format!(
                    "Génération bloquée : le modèle canonique n'est pas fidèle au graphe natif d'origine ({detail})."
                )
            });
        }
    }
    build_canonical_story_document(report)
}

/// Génère le document par le chemin canonique (`StoryBuilder`). `nativeGraph`
/// peut rester oracle du juge, mais n'est jamais rejoué comme génération.
fn build_canonical_story_document(
    report: &NativeAssetPreparationReport,
) -> Result<StoryDocument, String> {
    let mut builder = StoryBuilder::new(report);
    builder.build()
}

#[cfg(test)]
mod tests;
