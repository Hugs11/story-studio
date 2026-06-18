mod audio;
mod image;
mod models;
mod zip_doc;

#[cfg(test)]
mod tests;

pub use models::{FixedPackResult, PackMetadataPatch, PackValidationReport};

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use rayon::prelude::*;

use crate::services::pack_reader;
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};

use models::{
    issue, AudioValidationItem, CategorySummary, FixedPackResult as FixedPackResultModel,
    ImageValidationItem, NightModeSummary, PackMetadataPatch as PackMetadataPatchModel,
    PackValidationIssue, PackValidationReport as ReportModel, PackValidationSeverity,
    PackValidationVerdict, StructureSummary, ValidationSummary,
};
use zip_doc::{read_pack_doc, read_zip_entry_bytes, update_story_asset_refs, LoadedPackDoc};

#[cfg(test)]
#[cfg(test)]
pub fn analyze_pack(zip_path: &Path) -> ReportModel {
    analyze_pack_with_log(zip_path, &|_| {})
}

pub fn analyze_pack_with_log(
    zip_path: &Path,
    emit: &dyn Fn(&str),
) -> ReportModel {
    let pack_name = pack_name_from_path(zip_path);
    let zip_path_string = zip_path.to_string_lossy().to_string();
    let mut report = empty_report(&pack_name, &zip_path_string);
    emit(&format!("Analyse demandée pour {}", pack_name));
    report
        .technical_log
        .push(format!("[OK] Analyse demandée pour {}", pack_name));

    let temp_dir = std::env::temp_dir().join(format!(
        "story_studio_pack_checker_{}_{}",
        std::process::id(),
        now_millis()
    ));
    if let Err(err) = fs::create_dir_all(&temp_dir) {
        report.issues.push(issue(
            PackValidationSeverity::Error,
            "metadata",
            "Dossier temporaire",
            format!("Impossible de préparer l'analyse : {}", err),
        ));
        emit("Impossible de préparer le dossier temporaire.");
        return finalize_report_with_log(report, true, emit);
    }

    let result = analyze_pack_inner(zip_path, &temp_dir, report, emit);
    let _ = fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(test)]
pub fn create_fixed_pack(
    zip_path: &Path,
    metadata_patch: Option<PackMetadataPatchModel>,
) -> Result<FixedPackResultModel, String> {
    create_fixed_pack_with_log(zip_path, metadata_patch, &|_| {})
}

pub fn create_fixed_pack_with_log(
    zip_path: &Path,
    metadata_patch: Option<PackMetadataPatchModel>,
    emit: &dyn Fn(&str),
) -> Result<FixedPackResultModel, String> {
    emit("Analyse préparatoire du pack source...");
    let report = analyze_pack_with_log(zip_path, emit);
    let audio_items: Vec<AudioValidationItem> = report
        .audio_items
        .iter()
        .filter(|item| item.auto_fix_available)
        .cloned()
        .collect();
    let image_items: Vec<ImageValidationItem> = report
        .image_items
        .iter()
        .filter(|item| item.auto_fix_available)
        .cloned()
        .collect();
    let metadata_will_change = metadata_patch
        .as_ref()
        .map(metadata_patch_has_changes)
        .unwrap_or(false);
    if audio_items.is_empty() && image_items.is_empty() && !metadata_will_change {
        emit("Aucune correction automatique disponible.");
        return Err("Aucune correction automatique disponible pour ce pack.".to_string());
    }

    emit(&format!(
        "Corrections à appliquer : {} audio, {} image, métadonnées {}.",
        audio_items.len(),
        image_items.len(),
        if metadata_will_change { "oui" } else { "non" }
    ));
    let mut doc = read_pack_doc(zip_path)?;
    let temp_dir = std::env::temp_dir().join(format!(
        "story_studio_pack_fix_{}_{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Impossible de créer le dossier temporaire : {}", e))?;

    let fixed_result = (|| -> Result<FixedPackResultModel, String> {
        let mut used_asset_names = doc.asset_names.clone();
        let mut fixed_assets: HashMap<String, Vec<u8>> = HashMap::new();
        let mut original_to_new_audio: HashMap<String, String> = HashMap::new();
        let mut original_to_new_image: HashMap<String, String> = HashMap::new();
        let ffmpeg = if audio_items.is_empty() {
            None
        } else {
            emit("Recherche de FFmpeg pour les corrections audio...");
            Some(get_ffmpeg_path()?)
        };

        let prepared_fixes = prepare_fixed_assets_parallel(
            zip_path,
            &temp_dir,
            &audio_items,
            &image_items,
            ffmpeg.as_deref(),
            emit,
        )?;

        for prepared in prepared_fixes {
            match prepared {
                PreparedFixedAsset::Audio {
                    original_short,
                    desired_name,
                    bytes,
                } => {
                    let new_name =
                        unique_asset_name(&original_short, &desired_name, &mut used_asset_names);
                    original_to_new_audio.insert(original_short, new_name.clone());
                    fixed_assets.insert(new_name, bytes);
                }
                PreparedFixedAsset::Image {
                    original_short,
                    desired_name,
                    bytes,
                } => {
                    let new_name =
                        unique_asset_name(&original_short, &desired_name, &mut used_asset_names);
                    original_to_new_image.insert(original_short, new_name.clone());
                    fixed_assets.insert(new_name, bytes);
                }
            }
        }

        update_story_asset_refs(
            &mut doc.story,
            &original_to_new_audio,
            &original_to_new_image,
        );
        if let Some(patch) = metadata_patch.as_ref() {
            emit("Application des métadonnées au story.json...");
            apply_metadata_patch(&mut doc.story, patch);
        }
        let fixed_zip_path = unique_fixed_zip_path(zip_path, metadata_patch.as_ref());
        emit(&format!(
            "Écriture du ZIP corrigé : {}",
            fixed_zip_path.display()
        ));
        write_fixed_zip(
            zip_path,
            &fixed_zip_path,
            &doc.story,
            &fixed_assets,
            &original_to_new_audio,
            &original_to_new_image,
        )?;
        emit("ZIP corrigé finalisé.");

        Ok(FixedPackResultModel {
            source_zip_path: zip_path.to_string_lossy().to_string(),
            fixed_zip_path: fixed_zip_path.to_string_lossy().to_string(),
            fixed_count: audio_items.len() + image_items.len() + usize::from(metadata_will_change),
            audio_fixed: audio_items.len(),
            image_fixed: image_items.len(),
            metadata_fixed: metadata_will_change,
        })
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    fixed_result
}

enum PreparedFixedAsset {
    Audio {
        original_short: String,
        desired_name: String,
        bytes: Vec<u8>,
    },
    Image {
        original_short: String,
        desired_name: String,
        bytes: Vec<u8>,
    },
}

fn prepare_fixed_assets_parallel(
    zip_path: &Path,
    temp_dir: &Path,
    audio_items: &[AudioValidationItem],
    image_items: &[ImageValidationItem],
    ffmpeg: Option<&Path>,
    emit: &dyn Fn(&str),
) -> Result<Vec<PreparedFixedAsset>, String> {
    let audio_workers = audio_items.len();
    let image_workers = image_items.len();
    if audio_workers + image_workers == 0 {
        return Ok(Vec::new());
    }
    emit(&format!(
        "Préparation des corrections en parallèle : {} worker(s) max.",
        correction_worker_count()
    ));

    let (progress_tx, progress_rx) = mpsc::channel::<String>();
    let prepared: Result<Vec<PreparedFixedAsset>, String> = std::thread::scope(|scope| {
        let worker_tx = progress_tx.clone();
        let handle = scope.spawn(move || {
            run_in_correction_pool(|| {
                let audio_results = audio_items.par_iter().enumerate().map(|(index, item)| {
                    let tx = worker_tx.clone();
                    prepare_one_fixed_audio(
                        zip_path,
                        temp_dir,
                        ffmpeg,
                        index,
                        item,
                        &tx,
                    )
                });
                let image_results = image_items.par_iter().map(|item| {
                    let tx = worker_tx.clone();
                    prepare_one_fixed_image(zip_path, item, &tx)
                });
                audio_results.chain(image_results).collect()
            })
        });
        drop(progress_tx);
        for message in progress_rx {
            emit(&message);
        }
        handle
            .join()
            .map_err(|_| "Correction parallèle interrompue.".to_string())?
    });

    prepared
}

fn prepare_one_fixed_audio(
    zip_path: &Path,
    temp_dir: &Path,
    ffmpeg: Option<&Path>,
    index: usize,
    item: &AudioValidationItem,
    progress_tx: &mpsc::Sender<String>,
) -> Result<PreparedFixedAsset, String> {
    let Some(short_name) = item.file_path.strip_prefix("assets/") else {
        return Err(format!("Chemin audio inattendu : {}", item.file_path));
    };
    let _ = progress_tx.send(format!("Correction audio : {}", item.file_path));
    let bytes = read_zip_entry_bytes(zip_path, &item.file_path)?;
    let input_path = temp_dir.join(safe_temp_name(
        short_name,
        &format!("input_audio_{}", index),
    ));
    let output_path = temp_dir.join(safe_temp_name(
        short_name,
        &format!("fixed_audio_{}.mp3", index),
    ));
    fs::write(&input_path, &bytes)
        .map_err(|e| format!("Impossible de préparer {} : {}", item.file_path, e))?;
    audio::fix_audio_file(
        ffmpeg.ok_or_else(|| "FFmpeg requis pour les corrections audio.".to_string())?,
        &input_path,
        &output_path,
        item,
    )?;
    let fixed_bytes =
        fs::read(&output_path).map_err(|e| format!("Lecture audio corrigé impossible : {}", e))?;
    let _ = fs::remove_file(&input_path);
    let _ = fs::remove_file(&output_path);
    let _ = progress_tx.send(format!("Audio corrigé : {}", item.file_path));
    Ok(PreparedFixedAsset::Audio {
        original_short: short_name.to_string(),
        desired_name: asset_name_with_extension(short_name, "mp3"),
        bytes: fixed_bytes,
    })
}

fn prepare_one_fixed_image(
    zip_path: &Path,
    item: &ImageValidationItem,
    progress_tx: &mpsc::Sender<String>,
) -> Result<PreparedFixedAsset, String> {
    let Some(short_name) = item.file_path.strip_prefix("assets/") else {
        return Err(format!("Chemin image inattendu : {}", item.file_path));
    };
    let _ = progress_tx.send(format!("Correction image : {}", item.file_path));
    let bytes = read_zip_entry_bytes(zip_path, &item.file_path)?;
    let fixed_bytes = image::fix_image_bytes(&bytes)?;
    let _ = progress_tx.send(format!("Image corrigée : {}", item.file_path));
    Ok(PreparedFixedAsset::Image {
        original_short: short_name.to_string(),
        desired_name: asset_name_with_extension(short_name, "png"),
        bytes: fixed_bytes,
    })
}

fn analyze_pack_inner(
    zip_path: &Path,
    temp_dir: &Path,
    mut report: ReportModel,
    emit: &dyn Fn(&str),
) -> ReportModel {
    emit("Lecture du ZIP et de story.json...");
    let doc = match read_pack_doc(zip_path) {
        Ok(doc) => {
            emit("ZIP et story.json lus.");
            report
                .technical_log
                .push("[OK] Lecture du ZIP et de story.json".to_string());
            doc
        }
        Err(err) => {
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "structure",
                "Lecture du pack",
                friendly_zip_error(&err),
            ));
            report.technical_log.push(format!("[ERROR] {}", err));
            emit("Lecture du pack impossible.");
            return finalize_report_with_log(report, true, emit);
        }
    };

    report.pack_title = doc
        .story
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    report.pack_description = doc
        .story
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    report.pack_version = doc
        .story
        .get("version")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(1);

    emit("Vérification des métadonnées et du nom du pack...");
    validate_title(&doc, zip_path, &mut report);
    emit("Vérification de la structure et des références...");
    validate_structure(&doc, zip_path, temp_dir, &mut report);
    analyze_audio(&doc, zip_path, temp_dir, &mut report, emit);
    analyze_images(&doc, zip_path, &mut report, emit);
    finalize_report_with_log(report, false, emit)
}

fn validate_title(doc: &LoadedPackDoc, zip_path: &Path, report: &mut ReportModel) {
    report.title_summary.total = 1;
    let title = doc
        .story
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if title.is_empty() {
        report.issues.push(issue(
            PackValidationSeverity::Error,
            "title",
            "Titre du pack",
            "Le titre du pack est vide.",
        ));
        report.title_summary.errors += 1;
        return;
    }
    let mut has_warning = false;
    if title.contains("  ") || title.contains('\n') || has_forbidden_filename_char(title) {
        report.issues.push(issue(
            PackValidationSeverity::Warning,
            "title",
            "Titre du pack",
            "Le titre contient des espaces ou caractères à vérifier.",
        ));
        has_warning = true;
    }
    let file_stem = zip_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let convention_source = if parse_community_convention_name(file_stem) {
        Some("nom du fichier ZIP")
    } else if parse_community_convention_name(title) {
        Some("titre du pack")
    } else {
        None
    };
    if let Some(source) = convention_source {
        report.issues.push(issue(
            PackValidationSeverity::Ok,
            "title",
            "Convention communautaire",
            format!(
                "Le pack respecte la convention communautaire via le {}.",
                source
            ),
        ));
    } else {
        report.issues.push(issue(
            PackValidationSeverity::Warning,
            "title",
            "Convention communautaire",
            "Le nom du pack ne semble pas suivre la convention communautaire Story Studio.",
        ));
        has_warning = true;
    }
    if has_warning {
        report.title_summary.warnings += 1;
    } else {
        report.title_summary.ok += 1;
    }
}

fn validate_structure(
    doc: &LoadedPackDoc,
    zip_path: &Path,
    temp_dir: &Path,
    report: &mut ReportModel,
) {
    report.structure_summary.stage_count = doc.stage_count;
    report.structure_summary.action_count = doc.action_count;
    report.structure_summary.referenced_audio_count = unique_ref_count(&doc.audio_refs);
    report.structure_summary.referenced_image_count = unique_ref_count(&doc.image_refs);
    report.structure_summary.story_count = doc
        .story
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .map(|stages| {
            stages
                .iter()
                .filter(|stage| {
                    stage
                        .get("controlSettings")
                        .and_then(|value| value.get("autoplay"))
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                        && stage
                            .get("audio")
                            .and_then(|value| value.as_str())
                            .is_some()
                })
                .count()
        })
        .unwrap_or(0);
    report.night_mode.detected = doc
        .story
        .get("nightModeAvailable")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if report.night_mode.detected {
        report.issues.push(issue(
            PackValidationSeverity::Info,
            "nightMode",
            "Mode nuit",
            "Mode nuit détecté dans le pack.",
        ));
    } else {
        report.issues.push(issue(
            PackValidationSeverity::Info,
            "nightMode",
            "Mode nuit",
            "Aucun mode nuit détecté. Ce n'est pas bloquant.",
        ));
    }

    let required = ["format", "version", "title", "stageNodes", "actionNodes"];
    for field in required {
        if doc.story.get(field).is_none() {
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "structure",
                "Structure du pack",
                format!("Champ obligatoire manquant dans story.json : {}.", field),
            ));
        }
    }
    if doc
        .story
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .is_none()
    {
        report.issues.push(issue(
            PackValidationSeverity::Error,
            "structure",
            "Structure du pack",
            "La liste des étapes est absente ou invalide.",
        ));
    }
    if doc
        .story
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .is_none()
    {
        report.issues.push(issue(
            PackValidationSeverity::Error,
            "structure",
            "Structure du pack",
            "La liste des actions est absente ou invalide.",
        ));
    }

    validate_asset_presence(doc, report);
    validate_action_targets(doc, report);
    validate_story_studio_editability(zip_path, temp_dir, report);

    report.technical_log.push(format!(
        "[OK] {} stages, {} actions, {} audio(s), {} image(s)",
        report.structure_summary.stage_count,
        report.structure_summary.action_count,
        report.structure_summary.referenced_audio_count,
        report.structure_summary.referenced_image_count
    ));
}

fn validate_asset_presence(doc: &LoadedPackDoc, report: &mut ReportModel) {
    for asset_ref in &doc.audio_refs {
        if !doc.asset_names.contains(&asset_ref.asset_name) {
            let mut entry = issue(
                PackValidationSeverity::Error,
                "structure",
                &asset_ref.stage_name,
                "Un audio référencé est absent du ZIP.",
            );
            entry.file_path = Some(format!("assets/{}", asset_ref.asset_name));
            entry.technical_details = Some(format!(
                "stageNodes[{}] ({}) référence {}.",
                asset_ref.stage_index, asset_ref.stage_id, asset_ref.asset_name
            ));
            report.issues.push(entry);
        }
    }
    for asset_ref in &doc.image_refs {
        if !doc.asset_names.contains(&asset_ref.asset_name) {
            let mut entry = issue(
                PackValidationSeverity::Error,
                "structure",
                &asset_ref.stage_name,
                "Une image référencée est absente du ZIP.",
            );
            entry.file_path = Some(format!("assets/{}", asset_ref.asset_name));
            entry.technical_details = Some(format!(
                "stageNodes[{}] ({}) référence {}.",
                asset_ref.stage_index, asset_ref.stage_id, asset_ref.asset_name
            ));
            report.issues.push(entry);
        }
    }

    let referenced: HashSet<&str> = doc
        .audio_refs
        .iter()
        .chain(doc.image_refs.iter())
        .map(|asset_ref| asset_ref.asset_name.as_str())
        .collect();
    for asset in &doc.asset_names {
        if !referenced.contains(asset.as_str()) {
            let mut entry = issue(
                PackValidationSeverity::Info,
                "structure",
                "Fichier non référencé",
                "Un fichier est présent dans assets/ mais n'est pas référencé par story.json.",
            );
            entry.file_path = Some(format!("assets/{}", asset));
            report.issues.push(entry);
        }
    }
}

fn validate_action_targets(doc: &LoadedPackDoc, report: &mut ReportModel) {
    let Some(stages) = doc
        .story
        .get("stageNodes")
        .and_then(|value| value.as_array())
    else {
        return;
    };
    let stage_ids: HashSet<&str> = stages
        .iter()
        .filter_map(|stage| stage.get("uuid").and_then(|value| value.as_str()))
        .collect();
    if !stages.iter().any(|stage| {
        stage
            .get("squareOne")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }) {
        report.issues.push(issue(
            PackValidationSeverity::Error,
            "structure",
            "Structure du pack",
            "Le point de départ du pack est introuvable.",
        ));
    }

    let Some(actions) = doc
        .story
        .get("actionNodes")
        .and_then(|value| value.as_array())
    else {
        return;
    };
    for (action_index, action) in actions.iter().enumerate() {
        let Some(options) = action.get("options").and_then(|value| value.as_array()) else {
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "structure",
                "Structure du pack",
                format!("Action {} sans liste de destinations.", action_index + 1),
            ));
            continue;
        };
        for target in options.iter().filter_map(|value| value.as_str()) {
            if !stage_ids.contains(target) {
                report.issues.push(issue(
                    PackValidationSeverity::Error,
                    "structure",
                    "Structure du pack",
                    format!(
                        "Une destination de navigation est introuvable : {}.",
                        target
                    ),
                ));
            }
        }
    }

    // Sens inverse : chaque transition d'étape doit pointer vers une action
    // existante, sinon la navigation est cassée (étape sans suite valide).
    let action_ids: HashSet<&str> = actions
        .iter()
        .filter_map(|action| action.get("id").and_then(|value| value.as_str()))
        .collect();
    for (stage_index, stage) in stages.iter().enumerate() {
        for field in ["okTransition", "homeTransition"] {
            let Some(transition) = stage.get(field).filter(|value| !value.is_null()) else {
                continue;
            };
            let Some(action_node) = transition
                .get("actionNode")
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if !action_ids.contains(action_node) {
                let stage_label = stage
                    .get("name")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Élément {}", stage_index + 1));
                report.issues.push(issue(
                    PackValidationSeverity::Error,
                    "structure",
                    stage_label,
                    format!(
                        "Une transition de navigation pointe vers une action introuvable : {}.",
                        action_node
                    ),
                ));
            }
        }
    }
}

fn validate_story_studio_editability(zip_path: &Path, temp_dir: &Path, report: &mut ReportModel) {
    let extraction_dir = temp_dir.join("editable-check");
    let zip_string = zip_path.to_string_lossy().to_string();
    match pack_reader::unpack_zip_to_entries(&zip_string, &extraction_dir.to_string_lossy()) {
        Ok(_) => {
            report.structure_summary.story_studio_editable = true;
            report
                .technical_log
                .push("[OK] Structure éditable dans Story Studio".to_string());
        }
        Err(err) => {
            report.structure_summary.story_studio_editable = false;
            let mut entry = issue(
                PackValidationSeverity::Warning,
                "structure",
                "Édition Story Studio",
                "Cette structure peut être valide pour la Lunii mais non éditable dans Story Studio.",
            );
            entry.technical_details = Some(err.clone());
            report.issues.push(entry);
            report.technical_log.push(format!(
                "[WARN] Projection Story Studio impossible : {}",
                err
            ));
        }
    }
}

fn analyze_audio(
    doc: &LoadedPackDoc,
    zip_path: &Path,
    temp_dir: &Path,
    report: &mut ReportModel,
    emit: &dyn Fn(&str),
) {
    let unique_refs = first_refs_by_asset(&doc.audio_refs);
    report.audio_summary.total = unique_refs.len();
    if unique_refs.is_empty() {
        emit("Aucun audio référencé à analyser.");
        return;
    }
    emit(&format!(
        "Analyse audio FFmpeg : {} fichier(s)...",
        unique_refs.len()
    ));
    let ffmpeg = match get_ffmpeg_path() {
        Ok(path) => path,
        Err(err) => {
            emit("FFmpeg introuvable pour l'analyse audio.");
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "audio",
                "Analyse audio",
                format!("FFmpeg est introuvable : {}", err),
            ));
            return;
        }
    };

    // Chaque fichier est indépendant (lecture ZIP + ffmpeg dans son propre
    // processus), donc on parallélise sur un pool borné. `collect()` préserve
    // l'ordre source, ce qui garde un rapport déterministe.
    let ffmpeg_ref = ffmpeg.as_path();
    let results: Vec<(Option<AudioValidationItem>, Vec<PackValidationIssue>)> =
        run_in_analysis_pool(|| {
            unique_refs
                .par_iter()
                .enumerate()
                .map(|(index, asset_ref)| {
                    analyze_one_audio(
                        doc,
                        zip_path,
                        temp_dir,
                        ffmpeg_ref,
                        index,
                        asset_ref,
                    )
                })
                .collect()
        });

    for (item, mut issues) in results {
        report.issues.append(&mut issues);
        if let Some(item) = item {
            add_item_to_summary(
                &mut report.audio_summary,
                &item.status,
                item.auto_fix_available,
            );
            report.audio_items.push(item);
        }
    }
    emit(&format!(
        "Analyse audio terminée : {} OK, {} à corriger.",
        report.audio_summary.ok, report.audio_summary.auto_fixable
    ));
}

fn analyze_one_audio(
    doc: &LoadedPackDoc,
    zip_path: &Path,
    temp_dir: &Path,
    ffmpeg: &Path,
    index: usize,
    asset_ref: &zip_doc::StageAssetRef,
) -> (Option<AudioValidationItem>, Vec<PackValidationIssue>) {
    if !doc.asset_names.contains(&asset_ref.asset_name) {
        return (None, Vec::new());
    }
    let entry_name = format!("assets/{}", asset_ref.asset_name);
    match read_zip_entry_bytes(zip_path, &entry_name) {
        Ok(bytes) => {
            let input_path = temp_dir.join(safe_temp_name(
                &asset_ref.asset_name,
                &format!("probe{}", index),
            ));
            if let Err(err) = fs::write(&input_path, bytes) {
                return (
                    None,
                    vec![issue(
                        PackValidationSeverity::Error,
                        "audio",
                        &asset_ref.stage_name,
                        format!("Impossible de préparer l'audio pour analyse : {}", err),
                    )],
                );
            }
            let (item, issues) = audio::analyze_audio_file(
                ffmpeg,
                &input_path,
                &asset_ref.asset_name,
                &asset_ref.stage_name,
                &asset_ref.item_type,
            );
            let _ = fs::remove_file(&input_path);
            (Some(item), issues)
        }
        Err(err) => (
            None,
            vec![issue(
                PackValidationSeverity::Error,
                "audio",
                &asset_ref.stage_name,
                format!("Lecture audio impossible : {}", err),
            )],
        ),
    }
}

fn analyze_images(
    doc: &LoadedPackDoc,
    zip_path: &Path,
    report: &mut ReportModel,
    emit: &dyn Fn(&str),
) {
    let unique_refs = first_refs_by_asset(&doc.image_refs);
    report.image_summary.total = unique_refs.len();
    if unique_refs.is_empty() {
        emit("Aucune image référencée à analyser.");
        return;
    }
    emit(&format!(
        "Analyse images : {} fichier(s)...",
        unique_refs.len()
    ));

    let results: Vec<(Option<ImageValidationItem>, Vec<PackValidationIssue>)> =
        run_in_analysis_pool(|| {
            unique_refs
                .par_iter()
                .map(|asset_ref| analyze_one_image(doc, zip_path, asset_ref))
                .collect()
        });

    for (item, mut issues) in results {
        report.issues.append(&mut issues);
        if let Some(item) = item {
            add_item_to_summary(
                &mut report.image_summary,
                &item.status,
                item.auto_fix_available,
            );
            report.image_items.push(item);
        }
    }
    emit(&format!(
        "Analyse images terminée : {} OK, {} à corriger.",
        report.image_summary.ok, report.image_summary.auto_fixable
    ));
}

fn analyze_one_image(
    doc: &LoadedPackDoc,
    zip_path: &Path,
    asset_ref: &zip_doc::StageAssetRef,
) -> (Option<ImageValidationItem>, Vec<PackValidationIssue>) {
    if !doc.asset_names.contains(&asset_ref.asset_name) {
        return (None, Vec::new());
    }
    let entry_name = format!("assets/{}", asset_ref.asset_name);
    match read_zip_entry_bytes(zip_path, &entry_name) {
        Ok(bytes) => {
            let (item, issues) =
                image::analyze_image_bytes(&bytes, &asset_ref.asset_name, &asset_ref.stage_name);
            (Some(item), issues)
        }
        Err(err) => (
            None,
            vec![issue(
                PackValidationSeverity::Error,
                "image",
                &asset_ref.stage_name,
                format!("Lecture image impossible : {}", err),
            )],
        ),
    }
}

/// Exécute `f` sur un pool rayon borné pour ne pas saturer les processeurs
/// moyens : au plus `cœurs - 1` workers (un cœur laissé au système/à l'UI),
/// plafonné à 8 pour éviter une nuée de ffmpeg simultanés sur les machines à
/// nombreux cœurs. En cas d'échec de création du pool, on retombe sur le pool
/// global par défaut.
fn run_in_analysis_pool<R, F>(f: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let workers = cores.saturating_sub(1).clamp(1, 8);
    match rayon::ThreadPoolBuilder::new().num_threads(workers).build() {
        Ok(pool) => pool.install(f),
        Err(_) => f(),
    }
}

/// Pool plus conservateur pour la correction : chaque audio peut lancer des
/// passes FFmpeg coûteuses. On laisse au moins un cœur au système et on plafonne
/// à 4 corrections simultanées pour les petits CPU.
fn run_in_correction_pool<R, F>(f: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    let workers = correction_worker_count();
    match rayon::ThreadPoolBuilder::new().num_threads(workers).build() {
        Ok(pool) => pool.install(f),
        Err(_) => f(),
    }
}

fn correction_worker_count() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    cores.saturating_sub(1).clamp(1, 4)
}

fn finalize_report(mut report: ReportModel, fatal: bool) -> ReportModel {
    report.summary = ValidationSummary::default();
    for issue in &report.issues {
        match issue.severity {
            PackValidationSeverity::Error => report.summary.errors += 1,
            PackValidationSeverity::Warning => report.summary.warnings += 1,
            PackValidationSeverity::Info => report.summary.infos += 1,
            PackValidationSeverity::Ok => report.summary.ok += 1,
        }
    }
    report.summary.ok +=
        report.audio_summary.ok + report.image_summary.ok + report.title_summary.ok;
    report.corrections_available = report
        .issues
        .iter()
        .filter(|issue| issue.auto_fix_available)
        .count();
    let structure_has_errors = report.issues.iter().any(|issue| {
        issue.severity == PackValidationSeverity::Error && issue.category == "structure"
    });
    report.structure_summary.lunii_compatible = !fatal && !structure_has_errors;
    report.verdict = if fatal {
        PackValidationVerdict::Invalid
    } else if report.summary.errors > 0 {
        PackValidationVerdict::NeedsFix
    } else if report.summary.warnings > 0 {
        PackValidationVerdict::ValidWithWarnings
    } else {
        PackValidationVerdict::Valid
    };
    report
        .technical_log
        .push(format!("[OK] Verdict calculé : {:?}", report.verdict));
    report
}

fn finalize_report_with_log(report: ReportModel, fatal: bool, emit: &dyn Fn(&str)) -> ReportModel {
    let report = finalize_report(report, fatal);
    emit(&format!(
        "Rapport prêt : {} erreur(s), {} avertissement(s), {} correction(s).",
        report.summary.errors, report.summary.warnings, report.corrections_available
    ));
    report
}

fn empty_report(pack_name: &str, zip_path: &str) -> ReportModel {
    ReportModel {
        pack_name: pack_name.to_string(),
        pack_title: String::new(),
        pack_description: String::new(),
        pack_version: 1,
        zip_path: zip_path.to_string(),
        verdict: PackValidationVerdict::Invalid,
        summary: ValidationSummary::default(),
        audio_summary: CategorySummary::default(),
        image_summary: CategorySummary::default(),
        title_summary: CategorySummary::default(),
        structure_summary: StructureSummary::default(),
        night_mode: NightModeSummary::default(),
        corrections_available: 0,
        issues: Vec::new(),
        audio_items: Vec::new(),
        image_items: Vec::new(),
        technical_log: Vec::new(),
    }
}

fn metadata_patch_has_changes(patch: &PackMetadataPatchModel) -> bool {
    patch
        .title
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || patch.description.is_some()
        || patch.version.is_some()
        || patch.min_age.is_some()
        || patch.author.is_some()
        || patch.producer.is_some()
        || patch.bonus.is_some()
        || patch.naming_mode.is_some()
}

fn apply_metadata_patch(story: &mut serde_json::Value, patch: &PackMetadataPatchModel) {
    let Some(object) = story.as_object_mut() else {
        return;
    };
    if let Some(title) = patch
        .title
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        object.insert(
            "title".to_string(),
            serde_json::Value::String(title.to_string()),
        );
    }
    if let Some(description) = patch.description.as_ref() {
        object.insert(
            "description".to_string(),
            serde_json::Value::String(description.trim().to_string()),
        );
    }
    if let Some(version) = patch.version {
        object.insert(
            "version".to_string(),
            serde_json::Value::Number(serde_json::Number::from(version.max(1))),
        );
    }

    let has_community_metadata = patch.min_age.is_some()
        || patch.author.is_some()
        || patch.producer.is_some()
        || patch.bonus.is_some()
        || patch.naming_mode.is_some();
    if has_community_metadata {
        let mut metadata = object
            .get("storyStudioMetadata")
            .and_then(|value| value.as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(value) = patch.min_age.as_ref() {
            metadata.insert(
                "minAge".to_string(),
                serde_json::Value::String(value.trim().to_string()),
            );
        }
        if let Some(value) = patch.author.as_ref() {
            metadata.insert(
                "author".to_string(),
                serde_json::Value::String(value.trim().to_string()),
            );
        }
        if let Some(value) = patch.producer.as_ref() {
            metadata.insert(
                "producer".to_string(),
                serde_json::Value::String(value.trim().to_string()),
            );
        }
        if let Some(value) = patch.bonus.as_ref() {
            metadata.insert(
                "bonus".to_string(),
                serde_json::Value::String(value.trim().to_string()),
            );
        }
        if let Some(value) = patch.naming_mode.as_ref() {
            metadata.insert(
                "namingMode".to_string(),
                serde_json::Value::String(value.trim().to_string()),
            );
        }
        object.insert(
            "storyStudioMetadata".to_string(),
            serde_json::Value::Object(metadata),
        );
    }
}

fn write_fixed_zip(
    source_zip: &Path,
    output_zip: &Path,
    story: &serde_json::Value,
    fixed_assets: &HashMap<String, Vec<u8>>,
    audio_replacements: &HashMap<String, String>,
    image_replacements: &HashMap<String, String>,
) -> Result<(), String> {
    let source_file = fs::File::open(source_zip)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP source : {}", e))?;
    let mut source_archive =
        zip::ZipArchive::new(source_file).map_err(|e| format!("ZIP source invalide : {}", e))?;
    if let Some(parent) = output_zip.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Impossible de créer le dossier de sortie : {}", e))?;
    }
    let output_file = fs::File::create(output_zip)
        .map_err(|e| format!("Impossible de créer {} : {}", output_zip.display(), e))?;
    let mut writer = zip::ZipWriter::new(output_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut written = HashSet::new();

    writer
        .start_file("story.json", opts)
        .map_err(|e| format!("ZIP story.json : {}", e))?;
    let story_bytes = serde_json::to_string_pretty(story)
        .map_err(|e| format!("Sérialisation story.json impossible : {}", e))?;
    writer
        .write_all(story_bytes.as_bytes())
        .map_err(|e| format!("Écriture story.json impossible : {}", e))?;
    written.insert("story.json".to_string());

    for index in 0..source_archive.len() {
        let mut entry = source_archive
            .by_index(index)
            .map_err(|e| format!("Lecture ZIP index {} impossible : {}", index, e))?;
        if entry.is_dir() {
            continue;
        }
        let entry_name = entry.name().replace('\\', "/");
        if entry_name == "story.json" {
            continue;
        }
        let replacement_short = entry_name.strip_prefix("assets/").and_then(|short| {
            audio_replacements
                .get(short)
                .or_else(|| image_replacements.get(short))
                .map(|new_name| (short.to_string(), new_name.to_string()))
        });
        if let Some((_, new_short)) = replacement_short {
            if let Some(bytes) = fixed_assets.get(&new_short) {
                let new_entry_name = format!("assets/{}", new_short);
                if written.insert(new_entry_name.clone()) {
                    writer
                        .start_file(&new_entry_name, opts)
                        .map_err(|e| format!("ZIP {} : {}", new_entry_name, e))?;
                    writer
                        .write_all(bytes)
                        .map_err(|e| format!("Écriture {} impossible : {}", new_entry_name, e))?;
                }
            }
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Lecture {} impossible : {}", entry_name, e))?;
        if written.insert(entry_name.clone()) {
            writer
                .start_file(&entry_name, opts)
                .map_err(|e| format!("ZIP {} : {}", entry_name, e))?;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("Écriture {} impossible : {}", entry_name, e))?;
        }
    }

    for (short, bytes) in fixed_assets {
        let entry_name = format!("assets/{}", short);
        if written.insert(entry_name.clone()) {
            writer
                .start_file(&entry_name, opts)
                .map_err(|e| format!("ZIP {} : {}", entry_name, e))?;
            writer
                .write_all(bytes)
                .map_err(|e| format!("Écriture {} impossible : {}", entry_name, e))?;
        }
    }

    writer
        .finish()
        .map_err(|e| format!("Finalisation ZIP impossible : {}", e))?;
    Ok(())
}

fn unique_fixed_zip_path(
    source: &Path,
    metadata_patch: Option<&PackMetadataPatchModel>,
) -> PathBuf {
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    let stem = metadata_patch
        .and_then(convention_zip_stem)
        .or_else(|| {
            source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("{} - corrigé", value))
        })
        .unwrap_or_else(|| "pack - corrigé".to_string());
    let first = parent.join(format!("{}.zip", stem));
    if !first.exists() {
        return first;
    }
    for index in 2..1000 {
        let candidate = parent.join(format!("{} {}.zip", stem, index));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{} {}.zip", stem, now_millis()))
}

fn convention_zip_stem(patch: &PackMetadataPatchModel) -> Option<String> {
    let title = filename_token(patch.title.as_deref()?);
    if title.is_empty() {
        return None;
    }
    let min_age = patch
        .min_age
        .as_deref()
        .map(|value| {
            value
                .chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "3".to_string());
    let author = patch
        .author
        .as_deref()
        .map(filename_token)
        .unwrap_or_default();
    let producer = patch
        .producer
        .as_deref()
        .map(filename_token)
        .unwrap_or_default();
    let bonus = patch
        .bonus
        .as_deref()
        .map(filename_token)
        .unwrap_or_default();
    let version = patch.version.unwrap_or(1).max(1);
    let raw_author = patch.author.as_deref().unwrap_or("").trim();
    let raw_producer = patch.producer.as_deref().unwrap_or("").trim();
    let bonus_part = if bonus.is_empty() {
        String::new()
    } else {
        format!("_({})", bonus)
    };
    let title_part = if !producer.is_empty() && (author.is_empty() || raw_producer != raw_author) {
        format!("{}-{}{}", producer, title, bonus_part)
    } else {
        format!("{}{}", title, bonus_part)
    };
    let version_suffix = if version > 1 {
        format!("_V{}", version)
    } else {
        String::new()
    };
    let stem = if author.is_empty() {
        format!("{}+]{}{}", min_age, title_part, version_suffix)
    } else {
        format!(
            "{}+]{}[by_{}{}",
            min_age, title_part, author, version_suffix
        )
    };
    Some(stem)
}

fn filename_token(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn unique_asset_name(original: &str, desired: &str, used: &mut HashSet<String>) -> String {
    if desired == original || !used.contains(desired) {
        used.insert(desired.to_string());
        return desired.to_string();
    }
    let path = Path::new(desired);
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .map(|value| value.to_string_lossy().replace('\\', "/"));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("asset");
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    for index in 2..1000 {
        let file_name = format!("{}-corrige-{}.{}", stem, index, ext);
        let candidate = parent
            .as_ref()
            .map(|dir| format!("{}/{}", dir, file_name))
            .unwrap_or(file_name);
        if !used.contains(&candidate) {
            used.insert(candidate.clone());
            return candidate;
        }
    }
    desired.to_string()
}

fn asset_name_with_extension(original: &str, ext: &str) -> String {
    let path = Path::new(original);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("asset");
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .map(|value| value.to_string_lossy().replace('\\', "/"));
    let file_name = format!("{}.{}", stem, ext);
    parent
        .map(|dir| format!("{}/{}", dir, file_name))
        .unwrap_or(file_name)
}

/// Déduplique les références par nom d'asset en conservant l'ordre de première
/// apparition (ordre des stages), pour un rapport déterministe.
fn first_refs_by_asset(refs: &[zip_doc::StageAssetRef]) -> Vec<zip_doc::StageAssetRef> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for asset_ref in refs {
        if seen.insert(asset_ref.asset_name.clone()) {
            out.push(asset_ref.clone());
        }
    }
    out
}

fn add_item_to_summary(summary: &mut CategorySummary, status: &str, auto_fix_available: bool) {
    match status {
        "error" => summary.errors += 1,
        "warning" => summary.warnings += 1,
        "info" => summary.infos += 1,
        _ => summary.ok += 1,
    }
    if auto_fix_available {
        summary.auto_fixable += 1;
    }
}

fn unique_ref_count(refs: &[zip_doc::StageAssetRef]) -> usize {
    refs.iter()
        .map(|asset_ref| asset_ref.asset_name.as_str())
        .collect::<HashSet<_>>()
        .len()
}

fn safe_temp_name(asset_name: &str, suffix: &str) -> String {
    let clean: String = asset_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!("{}_{}", suffix, clean)
}

fn pack_name_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Pack")
        .to_string()
}

fn has_forbidden_filename_char(value: &str) -> bool {
    value.chars().any(|ch| {
        ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    })
}

fn parse_community_convention_name(raw: &str) -> bool {
    let value = raw.trim();
    let digits_len = value
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .map(char::len_utf8)
        .sum::<usize>();
    if digits_len == 0 {
        return false;
    };
    let Some(rest) = value.get(digits_len..) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix("+]") else {
        return false;
    };
    let core = rest
        .split("[by_")
        .next()
        .unwrap_or("")
        .trim_matches('_')
        .trim();
    !core.is_empty()
}

fn friendly_zip_error(err: &str) -> String {
    if err.contains("story.json") {
        "Le pack ne contient pas de story.json lisible à la racine.".to_string()
    } else if err.contains("Archive ZIP invalide") {
        "Le fichier n'est pas un ZIP lisible.".to_string()
    } else {
        format!("Le pack est invalide ou illisible : {}", err)
    }
}
