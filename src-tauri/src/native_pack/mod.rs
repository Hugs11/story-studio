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
    pub(crate) pack_uuid: String,
    pub(crate) stage_dir: String,
    pub(crate) assets_dir: String,
    pub(crate) assets: Vec<PreparedAsset>,
    pub(crate) imported_zips: Vec<ImportedZipBundle>,
    pub(crate) stats: NativeAssetStats,
    pub(crate) notes: Vec<String>,
    pub(crate) warnings: Vec<NativeGenerationWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGenerationWarning {
    pub(crate) code: String,
    pub(crate) role: String,
    pub(crate) label: String,
    pub(crate) message: String,
    pub(crate) initial_integrated_lufs: f64,
    pub(crate) final_integrated_lufs: Option<f64>,
    pub(crate) gain_db: f64,
    pub(crate) expected_limiting_db: f64,
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

// La profondeur authoring maximale doit rester générable avec des branches
// sœurs réalistes, y compris depuis les workers à petite pile utilisés par
// Tauri et les tests. Le builder conserve sa logique commune et s'exécute sur
// une pile bornée explicitement, indépendante de la plateforme appelante.
const NATIVE_DOCUMENT_BUILDER_STACK_BYTES: usize = 16 * 1024 * 1024;

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
    std::thread::scope(|scope| {
        let worker = std::thread::Builder::new()
            .name("story-studio-native-document".to_string())
            .stack_size(NATIVE_DOCUMENT_BUILDER_STACK_BYTES)
            .spawn_scoped(scope, || {
                let mut builder = StoryBuilder::new(report);
                builder.build()
            })
            .map_err(|error| format!("Impossible de démarrer la génération native : {error}"))?;
        worker.join().map_err(|_| {
            "La construction du document natif s'est interrompue de façon inattendue.".to_string()
        })?
    })
}

#[cfg(test)]
mod tests;
