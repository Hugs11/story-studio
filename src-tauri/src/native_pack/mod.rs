use serde::Serialize;

mod assets;
mod builder;
mod canonical;
mod document;
mod stats;
mod writer;

use assets::pipeline::*;
#[cfg(test)]
use assets::{
    audio::{audio_filters, mp3_header_is_native_compatible, processed_audio_output_name},
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
    if !report.project.options.auto_next
        && active_native_graph(report.project.native_graph.as_ref()).is_some()
    {
        return build_native_graph_story_document(report);
    }
    let mut builder = StoryBuilder::new(report);
    builder.build()
}

fn prepared_asset_name_for_role(
    report: &NativeAssetPreparationReport,
    role: &str,
) -> Result<String, String> {
    report
        .assets
        .iter()
        .find(|asset| asset.role == role)
        .map(|asset| asset.staged_asset_name.clone())
        .ok_or_else(|| format!("Asset natif introuvable pour {}", role))
}

fn build_native_graph_story_document(
    report: &NativeAssetPreparationReport,
) -> Result<StoryDocument, String> {
    let graph = report
        .project
        .native_graph
        .as_ref()
        .and_then(|graph| active_native_graph(Some(graph)))
        .ok_or_else(|| "Graphe natif absent.".to_string())?;
    let document_value = graph
        .get("document")
        .cloned()
        .ok_or_else(|| "Graphe natif sans document story.json.".to_string())?;
    let mut document: StoryDocument = serde_json::from_value(document_value)
        .map_err(|e| format!("Graphe natif invalide : {}", e))?;

    if !report.project.name.trim().is_empty() {
        document.title = report.project.name.clone();
    }
    document.night_mode_available =
        report.project.options.night_mode && !report.project.options.auto_next;

    for stage in &mut document.stage_nodes {
        if stage.audio.is_some() {
            let role = if stage.square_one && report.project.root_audio.is_some() {
                "rootAudio".to_string()
            } else {
                native_graph_asset_role(&stage.uuid, "audio")
            };
            stage.audio = Some(prepared_asset_name_for_role(report, &role)?);
        }
        if stage.image.is_some() {
            let role = if stage.square_one && report.project.root_image.is_some() {
                "rootImage".to_string()
            } else {
                native_graph_asset_role(&stage.uuid, "image")
            };
            stage.image = Some(prepared_asset_name_for_role(report, &role)?);
        }
    }

    normalize_document_for_studio_compat(&mut document);
    validate_document_for_studio_compat(&document)?;
    Ok(document)
}

#[cfg(test)]
mod tests;
