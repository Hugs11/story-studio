use serde::Serialize;

// Writer de production du projet avancé : il conduit le payload
// d'auteur jusqu'à l'archive publiée, et refuse avant d'écrire tout ce qui doit
// l'être. Il consomme la préparation, la readiness et le writer existants ; il
// ne réimplémente aucun d'eux.
pub(crate) mod advanced_export;
// Relecture réelle d'une archive écrite, **partagée** par les deux writers : un
// seul relecteur, deux appelants qui lui décrivent leurs attentes.
pub(crate) mod archive_review;
mod assets;
// API headless exercée par sa suite dédiée, mais qui n'a volontairement pas
// encore de consommateur produit.
pub(crate) mod authoring;
mod builder;
mod canonical;
mod dialect;
mod document;
// Gestes d'auteur du chemin de production. Ils vivent hors de
// `authoring.rs`, qui porte les diagnostics : muter le document et le
// diagnostiquer sont deux responsabilités, et le writer n'en porte aucune.
pub(crate) mod editing;
pub(crate) mod fidelity_judge;
/// Copie graphe d'un projet par menus : la projection d'écoute devenue payload
/// d'auteur, sous garde de fidélité.
pub(crate) mod graph_copy;
// Projection de lecture de l'éditeur avancé. Module frère en lecture seule : il
// ne construit, n'écrit et ne prépare rien, et ne touche ni `builder/`, ni le
// générateur Libre — `generatedNavigation.js` est donc hors d'atteinte de ce
// module.
pub(crate) mod graph_view;
mod integrity;
// Les trois contrôles de l'export avancé, exécutés aussi sur la chaîne Libre.
// Observer et décider y sont séparés : `GatePolicy` dit seule ce qu'un constat
// vaut, et elle les rend tous trois bloquants.
pub(crate) mod observed_gates;
mod option_selection;
// Assemblage du ZIP local, commun au writer Libre et à l'export avancé.
mod pack_zip;
pub(crate) mod persistence;
mod port_rules;
#[allow(dead_code)] // API headless pas encore raccordée au produit.
pub(crate) mod preparation;
mod presence;
/// Projection d'écoute : le graphe à plat d'un projet hiérarchique, sans
/// production d'archive (fusion des deux simulateurs).
pub(crate) mod simulation;
// Point d'agrégation des diagnostics. Son exposition produit (interface) n'est
// pas encore faite.
#[allow(dead_code)]
pub(crate) mod readiness;
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
pub(crate) use dialect::*;
pub(crate) use document::*;
pub(crate) use integrity::*;
pub(crate) use option_selection::*;
pub(crate) use presence::Presence;
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
    /// Ce rapport sert-il une **écoute** plutôt qu'une production ?
    ///
    /// Un seul comportement en dépend : `StoryBuilder::asset_name` tient la
    /// place d'un média absent au lieu de refuser. Le générateur exige que
    /// chaque média annoncé soit préparé, et c'est juste — un pack sans son
    /// n'est pas un pack. Mais un projet **en cours d'écriture** n'a pas
    /// franchi cette porte, c'est son état normal, et il doit rester écoutable.
    ///
    /// La production ne pose jamais ce drapeau : son résultat est inchangé.
    pub(crate) for_simulation: bool,
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
