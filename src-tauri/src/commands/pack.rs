use crate::services::{community_pack_checker, pack_reader};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn load_pack_zip(
    zip_path: String,
    for_simulation: Option<bool>,
) -> Result<String, String> {
    log::info!(target: "pack", "load_pack_zip: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = if for_simulation.unwrap_or(false) {
            pack_reader::load_pack_zip_for_simulation(&zip_path)
        } else {
            pack_reader::load_pack_zip(&zip_path)
        };
        result
            .inspect_err(|err| log::error!(target: "pack", "load_pack_zip failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_pack_asset(
    zip_path: String,
    asset_name: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::get_pack_asset(&zip_path, &asset_name).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn unpack_zip_to_entries(
    zip_path: String,
    dest_dir: String,
    workspace_dir: String,
) -> Result<serde_json::Value, String> {
    log::info!(target: "pack", "unpack_zip_to_entries: zip='{}' dest='{}'", zip_path, dest_dir);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(&dest_dir, &workspace_dir)?;
        let result = pack_reader::unpack_zip_to_entries(&zip_path, &safe_dest.to_string_lossy());
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&safe_dest);
        }
        result
            .inspect_err(|err| log::error!(target: "pack", "unpack_zip_to_entries failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Acquisition d'un projet avancé depuis un pack.
///
/// Elle rend la chaîne de payload **et** les liaisons médias produites depuis
/// les références réelles du document, après avoir déposé les assets du pack
/// dans `dest_dir`. C'est le seul raccord qui donne au frontend des liaisons
/// qu'il n'a pas fabriquées : sans lui, un projet avancé acquis désignerait des
/// médias sans chemin, et ni la promotion, ni la copie sous, ni le déplacement
/// du dossier ne pourraient les suivre.
///
/// Aucun nouveau parcours d'entrée n'est ouvert par cette commande : elle est la
/// frontière interne que le shell et les tests appellent, avec les mêmes gardes
/// de chemin que l'extraction Libre.
#[tauri::command]
pub async fn acquire_advanced_pack_document(
    zip_path: String,
    dest_dir: String,
    workspace_dir: String,
) -> Result<crate::native_pack::persistence::AdvancedAcquisition, String> {
    log::info!(target: "pack", "acquire_advanced_pack_document: zip='{}' dest='{}'", zip_path, dest_dir);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(&dest_dir, &workspace_dir)?;
        let result = pack_reader::import_pack_as_advanced_document(
            &zip_path,
            &safe_dest.to_string_lossy(),
        );
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&safe_dest);
        }
        result
            .inspect_err(|err| log::error!(target: "pack", "acquire_advanced_pack_document failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn convert_folder_pack_to_zip(
    app: AppHandle,
    folder_path: String,
) -> Result<String, String> {
    log::info!(target: "pack", "convert_folder_pack_to_zip: '{}'", folder_path);
    let folder_for_log = folder_path.clone();
    let cache_dir = crate::support::temp::app_cache_subdir(
        &app,
        crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::support::imported_pack::ensure_studio_pack_zip_from_dir(&folder_path, &cache_dir)
            .map(|converted| crate::support::paths::path_for_frontend(&converted.zip_path))
            .inspect_err(|err| log::error!(target: "pack", "convert_folder_pack_to_zip failed for '{}': {}", folder_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Inspecte une archive avant l'import : pack direct, ou enveloppe contenant
/// plusieurs packs ?
///
/// Sur un pack direct la commande ne change rien au parcours : elle rend
/// `direct`, et le travail de préparation qu'elle a éventuellement fait est
/// celui que la classification aurait fait juste après, mis en cache pour elle.
///
/// L'examen d'une enveloppe classe chacun de ses enfants avec le classifieur
/// commun, ce qui prend du temps sur une grosse archive : l'avancement est émis
/// au fil de l'eau, en comptes seulement — aucun nom de pack ne part dans un
/// évènement ni dans un journal.
#[tauri::command]
pub async fn inspect_pack_archive(
    app: AppHandle,
    path: String,
) -> Result<pack_reader::PackArchiveInspection, String> {
    log::info!(target: "pack", "inspect_pack_archive: '{}'", path);
    let path_for_log = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::inspect_pack_archive(&path, |done, total| {
            let _ = app.emit(
                "pack-bundle-inspection-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        })
        .inspect_err(|err| log::error!(target: "pack", "inspect_pack_archive failed for '{}': {}", path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extrait l'unique enfant choisi dans une enveloppe et rend son chemin.
///
/// `child_id` est l'identifiant opaque rendu par l'inspection : aucun chemin
/// d'archive ne traverse la frontière depuis le frontend. L'empreinte du
/// conteneur est exigée pour que l'inventaire affiché ne puisse pas être
/// appliqué à une archive remplacée entre-temps.
#[tauri::command]
pub async fn extract_pack_bundle_child(
    app: AppHandle,
    path: String,
    container_fingerprint: String,
    child_id: String,
) -> Result<String, String> {
    log::info!(target: "pack", "extract_pack_bundle_child: '{}'", path);
    let path_for_log = path.clone();
    let cache_dir = crate::support::temp::app_cache_subdir(
        &app,
        crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::support::imported_pack::extract_bundle_child(
            &path,
            &container_fingerprint,
            &child_id,
            &cache_dir,
        )
        .map(|child| crate::support::paths::path_for_frontend(&child))
        .inspect_err(|err| log::error!(target: "pack", "extract_pack_bundle_child failed for '{}': {}", path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Le contrôle de la fiche du pack : l'UUID saisi est-il lisible par les
/// passerelles ? La règle est celle de l'export, pour qu'une saisie acceptée ne
/// soit jamais refusée au moment de produire.
#[tauri::command]
pub fn check_pack_identity(value: String) -> Result<(), String> {
    match crate::native_pack::pack_identity_refusal(&value) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn check_pack_editability(zip_path: String) -> Result<bool, String> {
    log::info!(target: "pack", "check_pack_editability: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::check_pack_editability(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "check_pack_editability failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn classify_pack_editability(
    zip_path: String,
) -> Result<pack_reader::PackEditabilityReport, String> {
    log::info!(target: "pack", "classify_pack_editability: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::classify_pack_editability(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "classify_pack_editability failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn analyze_community_pack(
    app: AppHandle,
    zip_path: String,
) -> Result<community_pack_checker::PackValidationReport, String> {
    log::info!(target: "pack_checker", "analyze_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        let analysis_zip =
            crate::support::imported_pack::ensure_studio_pack_zip(source.to_string_lossy().as_ref())?
                .zip_path;
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", msg.to_string());
        };
        if analysis_zip != source {
            emit("Préparation temporaire de l'archive pour analyse...");
        }
        let mut report = community_pack_checker::analyze_pack_with_log(&analysis_zip, &emit);
        report.pack_name = pack_name_from_source(&source);
        report.zip_path = crate::support::paths::path_for_frontend(&source);
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|err| {
        log::error!(target: "pack_checker", "analyze_community_pack failed for '{}': {}", zip_path_for_log, err)
    })
}

#[tauri::command]
pub async fn create_fixed_community_pack(
    app: AppHandle,
    zip_path: String,
    output_dir: Option<String>,
    metadata_patch: Option<community_pack_checker::PackMetadataPatch>,
    correction_selection: Option<community_pack_checker::PackCorrectionSelection>,
) -> Result<community_pack_checker::FixedPackResult, String> {
    log::info!(target: "pack_checker", "create_fixed_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        let analysis_zip =
            crate::support::imported_pack::ensure_studio_pack_zip(source.to_string_lossy().as_ref())?
                .zip_path;
        let safe_output_dir = output_dir
            .as_deref()
            .map(|path| crate::services::project_files::validate_existing_dir_path(path, "Dossier de sortie"))
            .transpose()?;
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", msg.to_string());
        };
        if analysis_zip != source {
            emit("Préparation temporaire de l'archive pour correction...");
            return community_pack_checker::create_fixed_pack_with_source_log(
                &analysis_zip,
                &source,
                safe_output_dir.as_deref(),
                metadata_patch,
                correction_selection,
                &emit,
            );
        }
        community_pack_checker::create_fixed_pack_with_log(
            &analysis_zip,
            safe_output_dir.as_deref(),
            metadata_patch,
            correction_selection,
            &emit,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|err| {
        log::error!(target: "pack_checker", "create_fixed_community_pack failed for '{}': {}", zip_path_for_log, err)
    })
}

fn pack_name_from_source(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Pack")
        .to_string()
}
