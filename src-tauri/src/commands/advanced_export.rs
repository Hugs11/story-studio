//! Frontière IPC du writer de production avancé.
//!
//! Une commande, un point d'entrée interne testable, et rien d'autre : ni écran,
//! ni funnel, ni entrée de menu. JavaScript fournit la chaîne de
//! payload, les liaisons médias, le dossier choisi et les options ; il reçoit un
//! résultat ou un **refus typé**. Il n'ouvre jamais le payload — les entiers
//! opaques supérieurs à 2⁵³ y perdraient leur valeur.
//!
//! **Progression et annulation ne créent aucun second geste.** La commande
//! réutilise le drapeau partagé de la génération et son canal `generate-log` :
//! `cancel_generate_pack` annule donc un export avancé comme il annule une
//! génération Libre, et l'interface n'aura qu'un seul geste à câbler.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::generation::GenerationCancelState;
use crate::native_pack::advanced_export::{
    export_advanced_pack_with_cancel, AdvancedAudioOptions, AdvancedExportError,
    AdvancedExportResult,
};
use crate::native_pack::persistence::AdvancedMediaBinding;

/// Les options d'harmonisation et de silences, telles qu'elles traversent
/// l'IPC.
///
/// C'est un objet de frontière, distinct du type de domaine : l'appel
/// **sans paramètre** vaut `SilenceMode::Off` et `harmonize_loudness:
/// false`, alors que le `Default` de `SilenceMode` vaut `Normalize` pour le
/// mode Libre. Convertir explicitement évite qu'un `default` de `serde` fasse
/// diverger les deux, et garde le silence de l'appelant sans effet sur le son
/// livré.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvancedExportOptions {
    silence_mode: Option<crate::domain::project::SilenceMode>,
    harmonize_loudness: Option<bool>,
    leading_silence_sec: Option<f64>,
    trailing_silence_sec: Option<f64>,
}

impl AdvancedExportOptions {
    fn into_audio_options(self) -> AdvancedAudioOptions {
        let defaults = AdvancedAudioOptions::default();
        AdvancedAudioOptions {
            silence_mode: self.silence_mode.unwrap_or(defaults.silence_mode),
            harmonize_loudness: self
                .harmonize_loudness
                .unwrap_or(defaults.harmonize_loudness),
            leading_silence_sec: self
                .leading_silence_sec
                .unwrap_or(defaults.leading_silence_sec),
            trailing_silence_sec: self
                .trailing_silence_sec
                .unwrap_or(defaults.trailing_silence_sec),
        }
    }
}

/// Exporte le projet avancé courant vers `output_folder`.
///
/// Le payload est celui que l'appelant tient en mémoire : la commande ne lit
/// aucun `.mbah`, n'en réécrit aucun et ne marque pas le travail modifié. Un
/// refus est total du point de vue de l'auteur — le projet en mémoire et son
/// fichier ne sont jamais touchés, et aucune archive n'est publiée.
// Dix arguments : chacun est une donnée distincte que le moteur ne peut pas
// déduire du document — dossier, options, nom d'archive, titre livré, nom de
// projet, couverture. Les
// regrouper masquerait la frontière plutôt que de la simplifier.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_advanced_pack(
    app: AppHandle,
    cancel_state: State<'_, Arc<GenerationCancelState>>,
    payload: String,
    media_bindings: Vec<AdvancedMediaBinding>,
    output_folder: String,
    options: Option<AdvancedExportOptions>,
    // Le nom de l'archive, composé par l'appelant. Absent, le moteur retombe
    // sur le titre du document. C'est la même frontière que la chaîne Libre,
    // qui transporte son nom de convention dans le nom de projet et laisse le
    // writer l'assainir.
    archive_name: Option<String>,
    // Le titre livré dans `story.json`, composé par l'appelant : le nom de
    // convention avec l'âge, comme la chaîne Libre l'écrit. Absent (nom
    // libre), la copie garde le titre du document.
    story_title: Option<String>,
    // Nom du projet en mémoire : titre de secours du pack si le document
    // exporté ne porte aucun titre saisi ou importé.
    project_name: Option<String>,
    // La vignette catalogue, quand l'enveloppe en porte une. Elle voyage en
    // argument pour la même raison que `archive_name` : c'est une donnée de
    // projet, et le moteur ne reçoit que le document.
    cover_image: Option<String>,
) -> Result<AdvancedExportResult, AdvancedExportError> {
    log::info!(target: "advanced_export",
        "export_advanced_pack start: bindings={} outputFolder='{}'",
        media_bindings.len(), output_folder,
    );
    cancel_state.reset();
    let cancel_state = cancel_state.inner().clone();
    let audio_options = options.unwrap_or_default().into_audio_options();
    let cover_image = cover_image
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |message: &str| {
            let _ = app.emit("generate-log", message.to_string());
        };
        let should_cancel = || cancel_state.is_cancelled();
        export_advanced_pack_with_cancel(
            &payload,
            &media_bindings,
            &PathBuf::from(&output_folder),
            &audio_options,
            archive_name.as_deref(),
            story_title.as_deref(),
            project_name.as_deref(),
            cover_image.as_deref(),
            &emit,
            &should_cancel,
        )
        .inspect_err(
            |error| log::error!(target: "advanced_export", "export_advanced_pack failed: {error}"),
        )
    })
    .await
    .map_err(|error| AdvancedExportError::OutputWrite {
        path: "export".to_string(),
        message: error.to_string(),
    })?
}

#[cfg(test)]
#[path = "advanced_export_ui_project_tests.rs"]
mod ui_project_tests;
