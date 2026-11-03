use crate::services::{community_pack_checker, pack_reader};
use crate::support::user_message::{codes, UserMessage};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub async fn load_pack_zip<R: tauri::Runtime>(
    zip_path: String,
    for_simulation: Option<bool>,
    app: AppHandle<R>,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack", "load_pack_zip: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = if for_simulation.unwrap_or(false) {
            pack_reader::load_pack_zip_for_simulation(&zip_path)
        } else {
            pack_reader::load_pack_zip(&zip_path)
        };
        result.and_then(|story| {
            let mut value: serde_json::Value = serde_json::from_str(&story).map_err(|e| e.to_string())?;
            let uuid = crate::native_pack::pack_identity_from_story(&value).unwrap_or_default();
            let provenance = crate::domain::official_provenance::imported_provenance(&uuid, app.try_state::<crate::services::catalogue::CatalogueState>().as_deref()).map_err(UserMessage::into_transport)?;
            if provenance == crate::domain::official_provenance::OfficialProvenance::Official { value["officialOriginUuid"] = serde_json::json!(uuid); }
            value["officialProvenance"] = serde_json::to_value(provenance).unwrap();
            serde_json::to_string(&value).map_err(|e| e.to_string())
        })
            .inspect_err(|err| log::error!(target: "pack", "load_pack_zip failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}.await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn get_pack_asset(
    zip_path: String,
    asset_name: String,
) -> Result<tauri::ipc::Response, UserMessage> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || {
            pack_reader::get_pack_asset(&zip_path, &asset_name).map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn unpack_zip_to_entries<R: tauri::Runtime>(
    app: AppHandle<R>,
    zip_path: String,
    dest_dir: String,
    workspace_dir: String,
    project_destination: Option<crate::services::project_files::ProjectMediaDestination>,
    proposed_pack_name: Option<String>,
) -> Result<serde_json::Value, UserMessage> {
    log::info!(target: "pack", "unpack_zip_to_entries: zip='{}' dest='{}'", zip_path, dest_dir);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(
    &dest_dir,
    &workspace_dir,
    project_destination.as_ref(),
)?;
        let result = match proposed_pack_name.as_deref() {
            Some(name) => pack_reader::unpack_zip_to_entries_named(&zip_path, &safe_dest.to_string_lossy(), Some(name)),
            None => pack_reader::unpack_zip_to_entries(&zip_path, &safe_dest.to_string_lossy()),
        };
        let result = result.and_then(|mut value| {
            let uuid = value.get("uuid").and_then(serde_json::Value::as_str).unwrap_or_default();
            let provenance = crate::domain::official_provenance::imported_provenance(uuid, app.try_state::<crate::services::catalogue::CatalogueState>().as_deref()).map_err(UserMessage::into_transport)?;
            if provenance == crate::domain::official_provenance::OfficialProvenance::Official { value["officialOriginUuid"] = serde_json::json!(uuid); }
            value["officialProvenance"] = serde_json::to_value(provenance).unwrap();
            Ok(value)
        });
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&safe_dest);
        }
        result
            .inspect_err(|err| log::error!(target: "pack", "unpack_zip_to_entries failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(UserMessage::from)
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
pub async fn acquire_advanced_pack_document<R: tauri::Runtime>(
    app: AppHandle<R>,
    zip_path: String,
    dest_dir: String,
    workspace_dir: String,
    project_destination: Option<crate::services::project_files::ProjectMediaDestination>,
) -> Result<crate::native_pack::persistence::AdvancedAcquisition, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack", "acquire_advanced_pack_document: zip='{}' dest='{}'", zip_path, dest_dir);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(
    &dest_dir,
    &workspace_dir,
    project_destination.as_ref(),
)?;
        let result = pack_reader::import_pack_as_advanced_document_with_catalogue(
            &zip_path,
            &safe_dest.to_string_lossy(),
            app.try_state::<crate::services::catalogue::CatalogueState>().as_deref(),
        );
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&safe_dest);
        }
        result
            .inspect_err(|err| log::error!(target: "pack", "acquire_advanced_pack_document failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}.await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn convert_folder_pack_to_zip(
    app: AppHandle,
    folder_path: String,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack", "convert_folder_pack_to_zip: '{}'", folder_path);
    let folder_for_log = folder_path.clone();
    let cache_dir = crate::support::temp::app_cache_subdir(
        &app,
        crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        // Conversion output is declared to the catalogue watcher first.
        let write = crate::services::catalogue::writes::OwnWrite::begin(
            crate::services::catalogue::writes::Declaration::new("conversion").subtree(&cache_dir),
        );
        let result = crate::support::imported_pack::ensure_studio_pack_zip_from_dir(&folder_path, &cache_dir)
            .map(|converted| crate::support::paths::path_for_frontend(&converted.zip_path))
            .inspect_err(|err| log::error!(target: "pack", "convert_folder_pack_to_zip failed for '{}': {}", folder_for_log, err));
        write.finish(&result, |zip| vec![zip.into()]);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}.await;
    result.map_err(UserMessage::from)
}

/// Comme `convert_folder_pack_to_zip`, mais l'archive porte le nom du dossier
/// (`<nom assaini>.zip`, espaces et accents conservés) dans un dossier de travail
/// jetable de la session : le nom du cache est un hash que l'utilisateur ne doit
/// jamais voir. L'appelant copie le fichier dans le projet (qui garantit
/// l'unicité du nom) puis libère le dossier de travail avec
/// `cleanup_session_workspace`.
#[tauri::command]
pub async fn convert_folder_pack_to_named_zip(
    app: AppHandle,
    folder_path: String,
) -> Result<String, UserMessage> {
    let converted = convert_folder_pack_to_zip(app.clone(), folder_path.clone()).await?;
    let root =
        crate::support::temp::app_cache_subdir(&app, crate::support::temp::SESSION_WORKSPACES_DIR)
            .map_err(UserMessage::from)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, UserMessage> {
        let staging =
            crate::support::temp::create_session_workspace(&root).map_err(UserMessage::from)?;
        let name = named_zip_stem(&folder_path);
        let target = Path::new(&staging).join(format!("{name}.zip"));
        std::fs::copy(&converted, &target).map_err(|e| {
            let _ = crate::support::temp::cleanup_session_workspace(&root, &staging);
            UserMessage::new(codes::FILES_ARCHIVE_CREATE_FAILED)
                .param("outputZip", target.display().to_string())
                .param("error", e.to_string())
                .with_detail(format!("Impossible de creer {} : {}", target.display(), e))
        })?;
        Ok(crate::support::paths::path_for_frontend(&target))
    })
    .await
    .map_err(|e| UserMessage::from(e.to_string()))?
}

/// Nom de l'archive d'un dossier : son nom entier assaini (un point reste un
/// point : « Histoire v1.2 » n'est pas « Histoire v1 »).
fn named_zip_stem(folder_path: &str) -> String {
    Path::new(folder_path.trim_end_matches(['/', '\\']))
        .file_name()
        .and_then(|value| value.to_str())
        // Union des contraintes des trois systèmes : Windows interdit ces
        // caractères et les contrôles ASCII, ainsi que les points/espaces finaux.
        .map(|value| {
            let name = value
                .chars()
                .map(|c| {
                    if c <= '\u{1f}' || "<>:\"/\\|?*".contains(c) {
                        '_'
                    } else {
                        c
                    }
                })
                .collect::<String>()
                .trim_end_matches([' ', '.'])
                .to_string();
            // Les noms de périphériques DOS restent réservés avec une extension.
            let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
            if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ["COM", "LPT"].iter().any(|prefix| {
                    stem.strip_prefix(prefix).is_some_and(|suffix| {
                        matches!(
                            suffix,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
                })
            {
                format!("_{name}")
            } else {
                name
            }
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Pack".to_string())
}

#[cfg(test)]
mod named_zip_tests {
    #[test]
    fn folder_name_with_a_dot_is_kept_whole() {
        assert_eq!(super::named_zip_stem("/a/Histoire v1.2"), "Histoire v1.2");
        assert_eq!(
            super::named_zip_stem("/a/5+]Ringo_le_doudou/"),
            "5+]Ringo_le_doudou"
        );
        assert_eq!(super::named_zip_stem("/"), "Pack");
    }
    #[test]
    fn folder_archive_preserves_spaces_accents_and_valid_punctuation() {
        assert_eq!(
            super::named_zip_stem("/a/Les aventures d'Été [2]"),
            "Les aventures d'Été [2]"
        );
        assert_eq!(
            super::named_zip_stem("/a/Été : nuit?*<>|\u{7}"),
            "Été _ nuit______"
        );
        assert_eq!(super::named_zip_stem("/a/Été. "), "Été");
        assert_eq!(super::named_zip_stem("/a/NUL"), "_NUL");
        assert_eq!(super::named_zip_stem("/a/COM1.demo"), "_COM1.demo");
        assert_eq!(super::named_zip_stem("/a/COM10"), "COM10");
        assert_eq!(super::named_zip_stem("/a/___"), "___");
    }
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
) -> Result<pack_reader::PackArchiveInspection, UserMessage> {
    let result: Result<_, String> = async {
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
}.await;
    result.map_err(UserMessage::from)
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
    owner_id: Option<String>,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack", "extract_pack_bundle_child: '{}'", path);
    let path_for_log = path.clone();
    let cache_dir = crate::support::temp::app_cache_subdir(
        &app,
        crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        extract_bundle_child_routed(&path, &container_fingerprint, &child_id, &cache_dir, || {
            crate::services::catalogue::open_store(&app).map_err(|error| error.into_transport())?;
            let registry = crate::services::catalogue::open::editor_extractions(&app).map_err(|error| error.into_transport())?;
            crate::services::catalogue::open::editor_entry::extract_child(&path, &container_fingerprint, &child_id, &registry, owner_id.as_deref().unwrap_or_default(), app.try_state::<crate::services::catalogue::CatalogueState>().as_deref().map(|state| state as &dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>)).map_err(|e| e.into_transport())
        })
        .inspect_err(|err| log::error!(target: "pack", "extract_pack_bundle_child failed for '{}': {}", path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}.await;
    result.map_err(UserMessage::from)
}

pub(crate) fn extract_bundle_child_routed(
    path: &str,
    fingerprint: &str,
    child_id: &str,
    cache: &Path,
    catalogue: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if child_id.starts_with("catalogue:") {
        return catalogue();
    }
    crate::support::imported_pack::extract_bundle_child(path, fingerprint, child_id, cache)
        .map(|child| crate::support::paths::path_for_frontend(&child))
}

/// Le contrôle de la fiche du pack : l'UUID saisi est-il lisible par les
/// passerelles ? La règle est celle de l'export, pour qu'une saisie acceptée ne
/// soit jamais refusée au moment de produire.
#[tauri::command]
pub fn check_pack_identity(
    value: String,
    current_uuid: Option<String>,
    official_provenance: Option<crate::domain::official_provenance::OfficialProvenance>,
    catalogue: tauri::State<'_, crate::services::catalogue::CatalogueState>,
) -> Result<(), UserMessage> {
    crate::domain::official_provenance::check_identity_change(
        official_provenance.unwrap_or_default(),
        current_uuid.as_deref().unwrap_or_default(),
        &value,
        Some(catalogue.inner()),
    )?;
    crate::support::user_message::user_message_result(|| {
        match crate::native_pack::pack_identity_refusal(&value) {
            Some(refusal) => Err(UserMessage::new(codes::PACK_IDENTITY_UNREADABLE)
                .param("identity", value.as_str())
                .with_detail(refusal)
                .into_transport()),
            None => Ok(()),
        }
    })
}

#[tauri::command]
pub async fn check_pack_editability(zip_path: String) -> Result<bool, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack", "check_pack_editability: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::check_pack_editability(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "check_pack_editability failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}.await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn classify_pack_editability(
    zip_path: String,
) -> Result<pack_reader::PackEditabilityReport, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack", "classify_pack_editability: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::classify_pack_editability(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "classify_pack_editability failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}.await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn analyze_community_pack(
    app: AppHandle,
    zip_path: String,
    preparation_id: Option<String>,
    expected_content_token: Option<String>,
) -> Result<community_pack_checker::PackValidationReport, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack_checker", "analyze_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A closing catalogue funnel cannot release an input still being read
        // by analysis, correction or the subsequent analysis of its result.
        let _preparation = checker_transport(preparation_id.map(|id| {
            crate::services::catalogue::open::editor_extractions(&app)?.acquire(&id)
        }).transpose())?;
        let source = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        if let Some(token)=expected_content_token {
            checker_transport(crate::services::catalogue::files::checker::require_content(&source,&token))?;
        }
        let analysis_zip =
            crate::support::imported_pack::ensure_studio_pack_zip(source.to_string_lossy().as_ref())?
                .zip_path;
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", UserMessage::from(msg.to_string()));
        };
        if analysis_zip != source {
            emit(codes::FILES_ANALYSIS_ARCHIVE_PREPARING_TRANSPORT);
        }
        let mut report = community_pack_checker::analyze_pack_with_log(&analysis_zip, &emit);
        report.official_provenance = crate::domain::official_provenance::imported_provenance(&report.pack_uuid, app.try_state::<crate::services::catalogue::CatalogueState>().as_deref()).map_err(UserMessage::into_transport)?;
        report.identity_locked = crate::domain::official_provenance::is_official_origin(report.official_provenance, &report.pack_uuid, app.try_state::<crate::services::catalogue::CatalogueState>().as_deref()).map_err(UserMessage::into_transport)?;
        report.pack_name = pack_name_from_source(&source);
        report.zip_path = crate::support::paths::path_for_frontend(&source);
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|err| {
        log::error!(target: "pack_checker", "analyze_community_pack failed for '{}': {}", zip_path_for_log, err)
    })
}.await;
    result.map_err(UserMessage::from)
}

// Les paramètres à plat sont le contrat IPC de la commande.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_fixed_community_pack<R: tauri::Runtime>(
    app: AppHandle<R>,
    zip_path: String,
    preparation_id: Option<String>,
    expected_content_token: Option<String>,
    output_dir: Option<String>,
    metadata_patch: Option<community_pack_checker::PackMetadataPatch>,
    correction_selection: Option<community_pack_checker::PackCorrectionSelection>,
    // Dossier d'origine quand `zip_path` est l'archive issue de sa conversion :
    // il nomme le ZIP corrigé, comme le fichier le fait pour un .zip.
    source_label: Option<String>,
) -> Result<community_pack_checker::FixedPackResult, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "pack_checker", "create_fixed_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A closing catalogue funnel cannot release an input still being read
        // by analysis, correction or the subsequent analysis of its result.
        let _preparation = checker_transport(preparation_id.map(|id| {
            crate::services::catalogue::open::editor_extractions(&app)?.acquire(&id)
        }).transpose())?;
        let archive = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        if let Some(token)=expected_content_token {
            checker_transport(crate::services::catalogue::files::checker::require_content(&archive,&token))?;
        }
        let analysis_zip =
            crate::support::imported_pack::ensure_studio_pack_zip(archive.to_string_lossy().as_ref())?
                .zip_path;
        // Le dossier d'origine ne sert qu'à nommer le ZIP corrigé ; validé comme
        // dossier existant, car sans `output_dir` il fixe aussi où l'on écrit.
        let named_after_label = source_label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(|label| {
                crate::services::project_files::validate_existing_dir_path(
                    label,
                    codes::FILES_IMPORTED_PACK_FOLDER_TRANSPORT,
                )
            })
            .transpose()?;
        let source = named_after_label.clone().unwrap_or(archive);
        if let Some(requested) = metadata_patch.as_ref().and_then(|patch| patch.uuid.as_deref()).map(str::trim).filter(|value| !value.is_empty()) {
            let story = pack_reader::load_pack_zip(&analysis_zip.to_string_lossy())?;
            let value = serde_json::from_str(&story).map_err(|e| e.to_string())?;
            let current = crate::native_pack::pack_identity_from_story(&value).unwrap_or_default();
            crate::domain::official_provenance::check_identity_change(Default::default(), &current, requested, app.try_state::<crate::services::catalogue::CatalogueState>().as_deref()).map_err(UserMessage::into_transport)?;
        }
        let safe_output_dir = output_dir
            .as_deref()
            .map(|path| {
    crate::services::project_files::validate_existing_dir_path(
        path,
        codes::FILES_OUTPUT_FOLDER_LABEL_TRANSPORT,
    )
})
            .transpose()?;
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", UserMessage::from(msg.to_string()));
        };
        // The corrected archive goes beside the source or into the chosen
        // folder: declared to the catalogue watcher before it is written.
        let destination = safe_output_dir
            .clone()
            .or_else(|| source.parent().map(Path::to_path_buf));
        let write = crate::services::catalogue::writes::OwnWrite::begin(
            destination.into_iter().fold(
                crate::services::catalogue::writes::Declaration::new("checker"),
                |declaration, dir| declaration.subtree(dir),
            ),
        );
        let result = if analysis_zip != source || named_after_label.is_some() {
            emit(codes::FILES_CORRECTION_ARCHIVE_PREPARING_TRANSPORT);
            community_pack_checker::create_fixed_pack_with_source_log(
                &analysis_zip,
                &source,
                safe_output_dir.as_deref(),
                metadata_patch,
                correction_selection,
                &emit,
                app.try_state::<crate::services::catalogue::CatalogueState>().as_deref(),
            )
        } else {
            community_pack_checker::create_fixed_pack_with_source_log(
                &analysis_zip,
                &analysis_zip,
                safe_output_dir.as_deref(),
                metadata_patch,
                correction_selection,
                &emit,
                app.try_state::<crate::services::catalogue::CatalogueState>().as_deref(),
            )
        };
        write.finish(&result, |fixed| vec![fixed.fixed_zip_path.clone().into()]);
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|err| {
        log::error!(target: "pack_checker", "create_fixed_community_pack failed for '{}': {}", zip_path_for_log, err)
    })
}.await;
    result.map_err(UserMessage::from)
}

fn pack_name_from_source(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Pack")
        .to_string()
}

/// Preserve typed catalogue errors through the checker's legacy String services.
pub(crate) fn checker_transport<T>(result: Result<T, UserMessage>) -> Result<T, String> {
    result.map_err(UserMessage::into_transport)
}

/// Derived UI lock, never persisted or used as an authorization from JavaScript.
#[tauri::command]
pub(crate) fn read_pack_identity_lock(
    uuid: String,
    official_provenance: Option<crate::domain::official_provenance::OfficialProvenance>,
    catalogue: tauri::State<'_, crate::services::catalogue::CatalogueState>,
) -> Result<bool, UserMessage> {
    crate::domain::official_provenance::is_official_origin(
        official_provenance.unwrap_or_default(),
        &uuid,
        Some(catalogue.inner()),
    )
}
