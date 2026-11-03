use crate::support::user_message;
use crate::support::user_message::codes;
mod audio;
mod image;
mod models;
mod zip_doc;

#[cfg(test)]
mod tests;

pub use models::{
    FixedPackResult, PackCorrectionSelection, PackMetadataPatch, PackValidationReport,
};

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use rayon::prelude::*;

use crate::native_pack::{pack_identity_from_story, pack_identity_refusal};
use crate::services::pack_reader;
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};
use crate::support::paths::path_for_frontend;

use models::{
    issue, AudioSilenceEdge, AudioValidationItem, CategorySummary, FixDisposition,
    FixedPackResult as FixedPackResultModel, ImageValidationItem, NightModeSummary,
    PackCorrectionSelection as PackCorrectionSelectionModel,
    PackMetadataPatch as PackMetadataPatchModel, PackValidationIssue,
    PackValidationReport as ReportModel, PackValidationSeverity, PackValidationVerdict,
    StructureSummary, ValidationSummary,
};
use zip_doc::{read_pack_doc, read_zip_entry_bytes, update_story_asset_refs, LoadedPackDoc};

#[cfg(test)]
#[cfg(test)]
pub fn analyze_pack(zip_path: &Path) -> ReportModel {
    analyze_pack_with_log(zip_path, &|_| {})
}

pub fn analyze_pack_with_log(zip_path: &Path, emit: &dyn Fn(&str)) -> ReportModel {
    let pack_name = pack_name_from_path(zip_path);
    let zip_path_string = path_for_frontend(zip_path);
    let mut report = empty_report(&pack_name, &zip_path_string);
    emit(&{
        let _msg_pack_name = (pack_name).to_string();
        user_message::UserMessage::new(codes::CHECKER_ANALYSIS_REQUESTED_LABEL)
            .param(
                "packName",
                user_message::transport_param(_msg_pack_name.clone()),
            )
            .with_detail(format!(
                "Analyse demandée pour {_msg_pack_name}",
                _msg_pack_name = user_message::transport_detail(&_msg_pack_name)
            ))
            .into_transport()
    });
    report.technical_log.push({
        let _msg_pack_name = (pack_name).to_string();
        user_message::UserMessage::new(codes::CHECKER_ANALYSIS_REQUESTED_LOG)
            .param(
                "packName",
                user_message::transport_param(_msg_pack_name.clone()),
            )
            .with_detail(format!(
                "[OK] Analyse demandée pour {_msg_pack_name}",
                _msg_pack_name = user_message::transport_detail(&_msg_pack_name)
            ))
            .into_transport()
    });

    let temp_dir = unique_pack_workspace("checker");
    if let Err(err) = fs::create_dir_all(&temp_dir) {
        report.issues.push(issue(
            PackValidationSeverity::Error,
            "metadata",
            codes::CHECKER_TEMP_FOLDER_LABEL_TRANSPORT,
            {
                let _msg_error = (err).to_string();
                user_message::UserMessage::new(codes::CHECKER_ANALYSIS_PREPARATION_FAILED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Impossible de préparer l'analyse : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                    ))
                    .into_transport()
            },
        ));
        emit(codes::CHECKER_TEMP_FOLDER_PREPARE_FAILED_TRANSPORT);
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
    create_fixed_pack_with_log(zip_path, None, metadata_patch, None, &|_| {})
}

#[cfg(test)]
pub fn create_fixed_pack_with_log(
    zip_path: &Path,
    output_dir: Option<&Path>,
    metadata_patch: Option<PackMetadataPatchModel>,
    correction_selection: Option<PackCorrectionSelectionModel>,
    emit: &dyn Fn(&str),
) -> Result<FixedPackResultModel, String> {
    create_fixed_pack_with_source_log(
        zip_path,
        zip_path,
        output_dir,
        metadata_patch,
        correction_selection,
        emit,
        None,
    )
}

// A requested official UUID also establishes origin (L2); only an already
// official source constrains the requested UUID to its previous value.
fn correction_identity<
    C: crate::services::official_packs::OfficialCatalogue<Error = user_message::UserMessage>,
>(
    current: &str,
    requested: &str,
    catalogue: Option<&C>,
) -> Result<crate::native_pack::output_identity::OutputIdentity, user_message::UserMessage> {
    let provenance =
        crate::domain::official_provenance::imported_provenance_with_catalogue(current, catalogue);
    crate::native_pack::output_identity::decide(
        crate::native_pack::output_identity::ContentIdentity {
            provenance,
            uuid: requested,
            origin_uuid: (provenance
                == crate::domain::official_provenance::OfficialProvenance::Official)
                .then_some(current),
        },
        crate::native_pack::output_identity::OutputForm::Rewritten,
        &[],
        false,
        catalogue,
    )
}

pub(crate) fn create_fixed_pack_with_source_log(
    zip_path: &Path,
    source_path: &Path,
    output_dir: Option<&Path>,
    metadata_patch: Option<PackMetadataPatchModel>,
    correction_selection: Option<PackCorrectionSelectionModel>,
    emit: &dyn Fn(&str),
    catalogue: Option<&crate::services::catalogue::CatalogueState>,
) -> Result<FixedPackResultModel, String> {
    emit(codes::CHECKER_SOURCE_ANALYSIS_START_TRANSPORT);
    let report = analyze_pack_with_log(zip_path, emit);
    let correction_selection = correction_selection.unwrap_or_default();
    let optional_audio_silences_fixed = correction_selection
        .optional_audio_silences
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .len();
    let automatic_corrections_applied = report.corrections_available;
    let audio_items = build_audio_fix_plans(&report, correction_selection)?;
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
        emit(codes::CHECKER_CORRECTION_UNAVAILABLE_LABEL_TRANSPORT);
        return Err(
            user_message::UserMessage::new(codes::CHECKER_CORRECTION_UNAVAILABLE_PACK)
                .with_detail("Aucune correction automatique disponible pour ce pack.".to_string())
                .into_transport(),
        );
    }

    emit(&{
        let automatic_correction_count = (automatic_corrections_applied).to_string();
        let optional_silence_fix_count = (optional_audio_silences_fixed).to_string();
        let _msg_audio_items = (audio_items.len()).to_string();
        let _msg_image_items = (image_items.len()).to_string();
        let metadata_changed_label = (if metadata_will_change {
            codes::LABEL_BOOLEAN_YES_TRANSPORT
        } else {
            codes::LABEL_BOOLEAN_NO_TRANSPORT
        })
        .to_string();
        user_message::UserMessage::new(
            codes::CHECKER_CORRECTIONS_SELECTION_SUMMARY,
        )
            .param(
                "automaticCorrectionsApplied",
                user_message::transport_param(automatic_correction_count.clone()),
            )
            .param(
                "optionalAudioSilencesFixed",
                user_message::transport_param(optional_silence_fix_count.clone()),
            )
            .param("audioItems", user_message::transport_param(_msg_audio_items.clone()))
            .param("imageItems", user_message::transport_param(_msg_image_items.clone()))
            .param("metadataChanged", user_message::transport_param(metadata_changed_label.clone()))
            .with_detail(format!(
                "Corrections à appliquer : {automatic_correction_count} automatique(s), {optional_silence_fix_count} suggestion(s) facultative(s) sélectionnée(s) ; {_msg_audio_items} audio, {_msg_image_items} image, métadonnées {metadata_changed_label}.",
                _msg_audio_items = user_message::transport_detail(&_msg_audio_items),
                automatic_correction_count = user_message::transport_detail(&automatic_correction_count),
                _msg_image_items = user_message::transport_detail(&_msg_image_items),
                optional_silence_fix_count = user_message::transport_detail(&optional_silence_fix_count),
                metadata_changed_label = user_message::transport_detail(&metadata_changed_label),
            ))
            .into_transport()
    });
    let mut doc = read_pack_doc(zip_path).map_err(user_message::UserMessage::into_transport)?;
    let current = pack_identity_from_story(&doc.story).unwrap_or_default();
    let requested = metadata_patch
        .as_ref()
        .and_then(|p| p.uuid.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&current);
    let identity = correction_identity(&current, requested, catalogue)
        .map_err(user_message::UserMessage::into_transport)?;
    let temp_dir = unique_pack_workspace("fix");
    fs::create_dir_all(&temp_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_TEMP_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de créer le dossier temporaire : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
            ))
            .into_transport()
    })?;

    let fixed_result = (|| -> Result<FixedPackResultModel, String> {
        let mut used_asset_names = doc.asset_names.clone();
        let mut fixed_assets: HashMap<String, Vec<u8>> = HashMap::new();
        let mut original_to_new_audio: HashMap<String, String> = HashMap::new();
        let mut original_to_new_image: HashMap<String, String> = HashMap::new();
        let ffmpeg = if audio_items.is_empty() {
            None
        } else {
            emit(codes::CHECKER_FFMPEG_CORRECTION_SEARCH_TRANSPORT);
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
            emit(codes::CHECKER_METADATA_APPLY_START_TRANSPORT);
            apply_metadata_patch(&mut doc.story, patch)?;
        }
        identity.apply(&mut doc.story);
        let fixed_zip_path =
            unique_fixed_zip_path(source_path, output_dir, metadata_patch.as_ref());
        emit(&{
            let _msg_fixed_zip_path = (fixed_zip_path.display()).to_string();
            user_message::UserMessage::new(codes::CHECKER_CORRECTED_ZIP_WRITE)
                .param(
                    "fixedZipPath",
                    user_message::transport_param(_msg_fixed_zip_path.clone()),
                )
                .with_detail(format!(
                    "Écriture du ZIP corrigé : {_msg_fixed_zip_path}",
                    _msg_fixed_zip_path = user_message::transport_detail(&_msg_fixed_zip_path)
                ))
                .into_transport()
        });
        write_fixed_zip(
            &identity,
            zip_path,
            &fixed_zip_path,
            &doc.story,
            &fixed_assets,
            &original_to_new_audio,
            &original_to_new_image,
        )?;
        emit(codes::CHECKER_CORRECTED_ZIP_FINALIZED_TRANSPORT);

        Ok(FixedPackResultModel {
            source_zip_path: path_for_frontend(source_path),
            fixed_zip_path: path_for_frontend(&fixed_zip_path),
            fixed_count: audio_items.len() + image_items.len() + usize::from(metadata_will_change),
            audio_fixed: audio_items.len(),
            image_fixed: image_items.len(),
            metadata_fixed: metadata_will_change,
            automatic_corrections_applied,
            optional_audio_silences_fixed,
        })
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    fixed_result
}

fn unique_pack_workspace(kind: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "story_studio_pack_{}_{}_{}_{}",
        kind,
        std::process::id(),
        now_millis(),
        uuid::Uuid::new_v4()
    ))
}

#[derive(Debug, Clone)]
struct PlannedAudioFix {
    item: AudioValidationItem,
    plan: audio::AudioFixPlan,
}

fn build_audio_fix_plans(
    report: &ReportModel,
    selection: PackCorrectionSelectionModel,
) -> Result<Vec<PlannedAudioFix>, String> {
    let maximum_selections = report.audio_items.len().saturating_mul(2);
    if selection.optional_audio_silences.len() > maximum_selections {
        return Err({
            let selected_silence_fix_count = (selection.optional_audio_silences.len()).to_string();
            let _msg_maximum_selections = (maximum_selections).to_string();
            user_message::UserMessage::new(
                codes::CHECKER_AUDIO_SELECTION_LIMIT,
            )
                .param(
                    "selectionCount",
                    user_message::transport_param(selected_silence_fix_count.clone()),
                )
                .param(
                    "maximumSelections",
                    user_message::transport_param(_msg_maximum_selections.clone()),
                )
                .with_detail(format!(
                    "Trop de suggestions audio sélectionnées : {selected_silence_fix_count} reçue(s), {_msg_maximum_selections} maximum pour ce pack.",
                    _msg_maximum_selections = user_message::transport_detail(&_msg_maximum_selections),
                    selected_silence_fix_count = user_message::transport_detail(&selected_silence_fix_count),
                ))
                .into_transport()
        });
    }
    let selected: HashSet<_> = selection.optional_audio_silences.into_iter().collect();
    for requested in &selected {
        let expected_code = match requested.edge {
            AudioSilenceEdge::Leading => "audioLeadingSilenceLong",
            AudioSilenceEdge::Trailing => "audioTrailingSilenceLong",
        };
        let is_current_suggestion = report.issues.iter().any(|issue| {
            issue.file_path.as_deref() == Some(requested.file_path.as_str())
                && issue.code.as_deref() == Some(expected_code)
                && issue.fix_disposition == FixDisposition::Optional
                && issue.auto_fix_available
        });
        if !is_current_suggestion {
            return Err({
                let _msg_requested_file_path = (requested.file_path).to_string();
                let _msg_requested_edge = format!("{:?}", requested.edge);
                user_message::UserMessage::new(
                    codes::CHECKER_AUDIO_SUGGESTION_STALE,
                )
                    .param(
                        "requestedFilePath",
                        user_message::transport_param(_msg_requested_file_path.clone()),
                    )
                    .param(
                        "requestedEdge",
                        user_message::transport_param(_msg_requested_edge.clone()),
                    )
                    .with_detail(format!(
                        "Suggestion audio inconnue ou obsolète : {_msg_requested_file_path} ({_msg_requested_edge}).",
                        _msg_requested_edge = user_message::transport_detail(&_msg_requested_edge),
                        _msg_requested_file_path = user_message::transport_detail(&_msg_requested_file_path),
                    ))
                    .into_transport()
            });
        }
    }

    let mut planned = Vec::new();
    for item in &report.audio_items {
        let mut plan = audio::automatic_fix_plan(item, &report.issues);
        plan.rebuild_leading_silence |= selected.iter().any(|requested| {
            requested.file_path == item.file_path && requested.edge == AudioSilenceEdge::Leading
        });
        plan.rebuild_trailing_silence |= selected.iter().any(|requested| {
            requested.file_path == item.file_path && requested.edge == AudioSilenceEdge::Trailing
        });
        if plan.has_operations() {
            planned.push(PlannedAudioFix {
                item: item.clone(),
                plan,
            });
        }
    }
    Ok(planned)
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
    audio_items: &[PlannedAudioFix],
    image_items: &[ImageValidationItem],
    ffmpeg: Option<&Path>,
    emit: &dyn Fn(&str),
) -> Result<Vec<PreparedFixedAsset>, String> {
    let audio_workers = audio_items.len();
    let image_workers = image_items.len();
    if audio_workers + image_workers == 0 {
        return Ok(Vec::new());
    }
    emit(&{
        let _msg_correction_worker_count = (correction_worker_count()).to_string();
        user_message::UserMessage::new(
            codes::CHECKER_CORRECTIONS_PARALLEL_START,
        )
            .param(
                "correctionWorkerCount",
                user_message::transport_param(_msg_correction_worker_count.clone()),
            )
            .with_detail(format!(
                "Préparation des corrections en parallèle : {_msg_correction_worker_count} worker(s) max.",
                _msg_correction_worker_count = user_message::transport_detail(&_msg_correction_worker_count),
            ))
            .into_transport()
    });

    let (progress_tx, progress_rx) = mpsc::channel::<String>();
    let prepared: Result<Vec<PreparedFixedAsset>, String> = std::thread::scope(|scope| {
        let worker_tx = progress_tx.clone();
        let handle = scope.spawn(move || {
            run_in_correction_pool(|| {
                let audio_results = audio_items.par_iter().enumerate().map(|(index, planned)| {
                    let tx = worker_tx.clone();
                    prepare_one_fixed_audio(zip_path, temp_dir, ffmpeg, index, planned, &tx)
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
        handle.join().map_err(|_| {
            user_message::UserMessage::new(codes::CHECKER_CORRECTIONS_PARALLEL_INTERRUPTED)
                .with_detail("Correction parallèle interrompue.".to_string())
                .into_transport()
        })?
    });

    prepared
}

fn prepare_one_fixed_audio(
    zip_path: &Path,
    temp_dir: &Path,
    ffmpeg: Option<&Path>,
    index: usize,
    planned: &PlannedAudioFix,
    progress_tx: &mpsc::Sender<String>,
) -> Result<PreparedFixedAsset, String> {
    let item = &planned.item;
    let Some(short_name) = item.file_path.strip_prefix("assets/") else {
        return Err({
            let _msg_item_file_path = (item.file_path).to_string();
            user_message::UserMessage::new(codes::CHECKER_AUDIO_PATH_UNEXPECTED)
                .param(
                    "itemFilePath",
                    user_message::transport_param(_msg_item_file_path.clone()),
                )
                .with_detail(format!(
                    "Chemin audio inattendu : {_msg_item_file_path}",
                    _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
                ))
                .into_transport()
        });
    };
    let _ = progress_tx.send({
        let _msg_item_file_path = (item.file_path).to_string();
        user_message::UserMessage::new(codes::CHECKER_AUDIO_CORRECTION_LABEL)
            .param(
                "itemFilePath",
                user_message::transport_param(_msg_item_file_path.clone()),
            )
            .with_detail(format!(
                "Correction audio : {_msg_item_file_path}",
                _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
            ))
            .into_transport()
    });
    let bytes = read_zip_entry_bytes(zip_path, &item.file_path)?;
    let input_path = temp_dir.join(safe_temp_name(
        short_name,
        &format!("input_audio_{}", index),
    ));
    let output_path = temp_dir.join(safe_temp_name(
        short_name,
        &format!("fixed_audio_{}.mp3", index),
    ));
    fs::write(&input_path, &bytes).map_err(|e| {
        let _msg_item_file_path = (item.file_path).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_CORRECTION_PREPARE_FAILED)
            .param(
                "itemFilePath",
                user_message::transport_param(_msg_item_file_path.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de préparer {_msg_item_file_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
            ))
            .into_transport()
    })?;
    audio::fix_audio_file(
        ffmpeg.ok_or_else(|| {
            user_message::UserMessage::new(codes::CHECKER_AUDIO_FFMPEG_REQUIRED)
                .with_detail("FFmpeg requis pour les corrections audio.".to_string())
                .into_transport()
        })?,
        &input_path,
        &output_path,
        item,
        planned.plan,
    )?;
    let fixed_bytes = fs::read(&output_path).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_CORRECTED_AUDIO_READ_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Lecture audio corrigé impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
            ))
            .into_transport()
    })?;
    let _ = fs::remove_file(&input_path);
    let _ = fs::remove_file(&output_path);
    let _ = progress_tx.send({
        let _msg_item_file_path = (item.file_path).to_string();
        user_message::UserMessage::new(codes::CHECKER_CORRECTED_AUDIO_LABEL)
            .param(
                "itemFilePath",
                user_message::transport_param(_msg_item_file_path.clone()),
            )
            .with_detail(format!(
                "Audio corrigé : {_msg_item_file_path}",
                _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
            ))
            .into_transport()
    });
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
        return Err({
            let _msg_item_file_path = (item.file_path).to_string();
            user_message::UserMessage::new(codes::CHECKER_IMAGE_PATH_UNEXPECTED)
                .param(
                    "itemFilePath",
                    user_message::transport_param(_msg_item_file_path.clone()),
                )
                .with_detail(format!(
                    "Chemin image inattendu : {_msg_item_file_path}",
                    _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
                ))
                .into_transport()
        });
    };
    let _ = progress_tx.send({
        let _msg_item_file_path = (item.file_path).to_string();
        user_message::UserMessage::new(codes::CHECKER_IMAGE_CORRECTION_LABEL)
            .param(
                "itemFilePath",
                user_message::transport_param(_msg_item_file_path.clone()),
            )
            .with_detail(format!(
                "Correction image : {_msg_item_file_path}",
                _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
            ))
            .into_transport()
    });
    let bytes = read_zip_entry_bytes(zip_path, &item.file_path)?;
    let fixed_bytes = image::fix_image_bytes(&bytes)?;
    let _ = progress_tx.send({
        let _msg_item_file_path = (item.file_path).to_string();
        user_message::UserMessage::new(codes::CHECKER_CORRECTED_IMAGE_LABEL)
            .param(
                "itemFilePath",
                user_message::transport_param(_msg_item_file_path.clone()),
            )
            .with_detail(format!(
                "Image corrigée : {_msg_item_file_path}",
                _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path)
            ))
            .into_transport()
    });
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
    emit(codes::CHECKER_ZIP_STORY_READ_START_TRANSPORT);
    let doc = match read_pack_doc(zip_path) {
        Ok(doc) => {
            emit(codes::CHECKER_ZIP_STORY_READ_LABEL_TRANSPORT);
            report.technical_log.push(
                user_message::UserMessage::new(codes::CHECKER_ZIP_STORY_READ_DONE)
                    .with_detail("[OK] Lecture du ZIP et de story.json".to_string())
                    .into_transport(),
            );
            doc
        }
        Err(err) => {
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "structure",
                codes::CHECKER_PACK_READING_LABEL_TRANSPORT,
                friendly_zip_error(&err),
            ));
            report.technical_log.push(
                user_message::UserMessage::new(codes::CHECKER_LOG_ERROR)
                    .param("error", user_message::transport_param(err.into_transport()))
                    .into_transport(),
            );
            emit(codes::CHECKER_PACK_READ_FAILED_TRANSPORT);
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
    // L'identité que l'appareil connaît : celle de l'Écran d'entrée, que la
    // plupart des packs STUdio portent sans `uuid` de tête.
    report.pack_uuid = pack_identity_from_story(&doc.story).unwrap_or_default();
    report.official_provenance =
        crate::domain::official_provenance::imported_provenance(&report.pack_uuid, None)
            .expect("no catalogue lookup");
    report.identity_locked = crate::domain::official_provenance::is_official_origin::<
        crate::services::catalogue::CatalogueState,
    >(report.official_provenance, &report.pack_uuid, None)
    .expect("no catalogue lookup");
    report.pack_version = doc
        .story
        .get("version")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(1);

    emit(codes::CHECKER_METADATA_CHECK_START_TRANSPORT);
    validate_title(&doc, zip_path, &mut report);
    emit(codes::CHECKER_STRUCTURE_CHECK_START_TRANSPORT);
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
            codes::CHECKER_PACK_TITLE_LABEL_TRANSPORT,
            codes::CHECKER_PACK_TITLE_EMPTY_TRANSPORT,
        ));
        report.title_summary.errors += 1;
        return;
    }
    let mut has_warning = false;
    if title.contains("  ") || title.contains('\n') || has_forbidden_filename_char(title) {
        report.issues.push(issue(
            PackValidationSeverity::Warning,
            "title",
            codes::CHECKER_PACK_TITLE_LABEL_TRANSPORT,
            codes::CHECKER_PACK_TITLE_CHARS_WARNING_TRANSPORT,
        ));
        has_warning = true;
    }
    let file_stem = zip_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let convention_source = if parse_community_convention_name(file_stem) {
        Some(codes::CHECKER_ZIP_FILENAME_LABEL_TRANSPORT)
    } else if parse_community_convention_name(title) {
        Some(codes::CHECKER_PACK_TITLE_CONTEXT_TRANSPORT)
    } else {
        None
    };
    if let Some(source) = convention_source {
        report.issues.push(issue(
            PackValidationSeverity::Ok,
            "title",
            codes::CHECKER_NAMING_CONVENTION_LABEL_TRANSPORT,
            {
                let _msg_source = (source).to_string();
                user_message::UserMessage::new(codes::CHECKER_NAMING_CONVENTION_MATCHED)
                    .param("source", user_message::transport_param(_msg_source.clone()))
                    .with_detail(format!(
                        "Le pack respecte la convention communautaire via le {_msg_source}.",
                        _msg_source = user_message::transport_detail(&_msg_source),
                    ))
                    .into_transport()
            },
        ));
    } else {
        report.issues.push(issue(
            PackValidationSeverity::Warning,
            "title",
            codes::CHECKER_NAMING_CONVENTION_LABEL_TRANSPORT,
            codes::CHECKER_NAMING_CONVENTION_UNMATCHED_TRANSPORT,
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
            codes::CHECKER_NIGHT_MODE_LABEL_TRANSPORT,
            codes::CHECKER_NIGHT_MODE_DETECTED_TRANSPORT,
        ));
    } else {
        report.issues.push(issue(
            PackValidationSeverity::Info,
            "nightMode",
            codes::CHECKER_NIGHT_MODE_LABEL_TRANSPORT,
            codes::CHECKER_NIGHT_MODE_ABSENT_TRANSPORT,
        ));
    }

    let required = ["format", "version", "title", "stageNodes", "actionNodes"];
    for field in required {
        if doc.story.get(field).is_none() {
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "structure",
                codes::CHECKER_PACK_STRUCTURE_LABEL_TRANSPORT,
                {
                    let _msg_field = (field).to_string();
                    user_message::UserMessage::new(codes::CHECKER_STORY_FIELD_MISSING)
                        .param("field", user_message::transport_param(_msg_field.clone()))
                        .with_detail(format!(
                            "Champ obligatoire manquant dans story.json : {_msg_field}.",
                            _msg_field = user_message::transport_detail(&_msg_field),
                        ))
                        .into_transport()
                },
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
            codes::CHECKER_PACK_STRUCTURE_LABEL_TRANSPORT,
            codes::CHECKER_STAGE_LIST_INVALID_TRANSPORT,
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
            codes::CHECKER_PACK_STRUCTURE_LABEL_TRANSPORT,
            codes::CHECKER_ACTION_LIST_INVALID_TRANSPORT,
        ));
    }

    validate_asset_presence(doc, report);
    validate_action_targets(doc, report);
    validate_story_studio_editability(zip_path, temp_dir, report);

    report.technical_log.push(
        user_message::UserMessage::new(codes::CHECKER_STRUCTURE_COUNTS)
            .param("stages", report.structure_summary.stage_count)
            .param("actions", report.structure_summary.action_count)
            .param("audio", report.structure_summary.referenced_audio_count)
            .param("images", report.structure_summary.referenced_image_count)
            .into_transport(),
    );
}

fn validate_asset_presence(doc: &LoadedPackDoc, report: &mut ReportModel) {
    for asset_ref in &doc.audio_refs {
        if !doc.asset_names.contains(&asset_ref.asset_name) {
            let mut entry = issue(
                PackValidationSeverity::Error,
                "structure",
                &asset_ref.stage_name,
                codes::CHECKER_REFERENCED_AUDIO_MISSING_TRANSPORT,
            );
            entry.file_path = Some(format!("assets/{}", asset_ref.asset_name));
            entry.technical_details = Some({
                let _msg_asset_ref_stage_index = (asset_ref.stage_index).to_string();
                let _msg_asset_ref_stage_id = (asset_ref.stage_id).to_string();
                let _msg_asset_ref_asset_name = (asset_ref.asset_name).to_string();
                user_message::UserMessage::new(
                    codes::CHECKER_STAGE_REFERENCES_LABEL,
                )
                    .param(
                        "stageIndex",
                        user_message::transport_param(_msg_asset_ref_stage_index.clone()),
                    )
                    .param(
                        "stageId",
                        user_message::transport_param(_msg_asset_ref_stage_id.clone()),
                    )
                    .param(
                        "assetName",
                        user_message::transport_param(_msg_asset_ref_asset_name.clone()),
                    )
                    .with_detail(format!(
                        "stageNodes[{_msg_asset_ref_stage_index}] ({_msg_asset_ref_stage_id}) référence {_msg_asset_ref_asset_name}.",
                        _msg_asset_ref_asset_name = user_message::transport_detail(&_msg_asset_ref_asset_name),
                        _msg_asset_ref_stage_id = user_message::transport_detail(&_msg_asset_ref_stage_id),
                        _msg_asset_ref_stage_index = user_message::transport_detail(&_msg_asset_ref_stage_index),
                    ))
                    .into_transport()
            });
            report.issues.push(entry);
        }
    }
    for asset_ref in &doc.image_refs {
        if !doc.asset_names.contains(&asset_ref.asset_name) {
            let mut entry = issue(
                PackValidationSeverity::Error,
                "structure",
                &asset_ref.stage_name,
                codes::CHECKER_REFERENCED_IMAGE_MISSING_TRANSPORT,
            );
            entry.file_path = Some(format!("assets/{}", asset_ref.asset_name));
            entry.technical_details = Some({
                let _msg_asset_ref_stage_index = (asset_ref.stage_index).to_string();
                let _msg_asset_ref_stage_id = (asset_ref.stage_id).to_string();
                let _msg_asset_ref_asset_name = (asset_ref.asset_name).to_string();
                user_message::UserMessage::new(
                    codes::CHECKER_STAGE_REFERENCES_LABEL,
                )
                    .param(
                        "stageIndex",
                        user_message::transport_param(_msg_asset_ref_stage_index.clone()),
                    )
                    .param(
                        "stageId",
                        user_message::transport_param(_msg_asset_ref_stage_id.clone()),
                    )
                    .param(
                        "assetName",
                        user_message::transport_param(_msg_asset_ref_asset_name.clone()),
                    )
                    .with_detail(format!(
                        "stageNodes[{_msg_asset_ref_stage_index}] ({_msg_asset_ref_stage_id}) référence {_msg_asset_ref_asset_name}.",
                        _msg_asset_ref_asset_name = user_message::transport_detail(&_msg_asset_ref_asset_name),
                        _msg_asset_ref_stage_id = user_message::transport_detail(&_msg_asset_ref_stage_id),
                        _msg_asset_ref_stage_index = user_message::transport_detail(&_msg_asset_ref_stage_index),
                    ))
                    .into_transport()
            });
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
                codes::CHECKER_UNREFERENCED_FILE_TITLE_TRANSPORT,
                codes::CHECKER_UNREFERENCED_FILE_DESCRIPTION_TRANSPORT,
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
            codes::CHECKER_PACK_STRUCTURE_LABEL_TRANSPORT,
            codes::CHECKER_ENTRY_STAGE_MISSING_TRANSPORT,
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
                codes::CHECKER_PACK_STRUCTURE_LABEL_TRANSPORT,
                {
                    let _msg_action_index_1 = (action_index + 1).to_string();
                    user_message::UserMessage::new(codes::CHECKER_ACTION_DESTINATIONS_MISSING)
                        .param(
                            "actionNumber",
                            user_message::transport_param(_msg_action_index_1.clone()),
                        )
                        .with_detail(format!(
                            "Action {_msg_action_index_1} sans liste de destinations.",
                            _msg_action_index_1 =
                                user_message::transport_detail(&_msg_action_index_1),
                        ))
                        .into_transport()
                },
            ));
            continue;
        };
        for target in options.iter().filter_map(|value| value.as_str()) {
            if !stage_ids.contains(target) {
                report.issues.push(issue(
                    PackValidationSeverity::Error,
                    "structure",
                    codes::CHECKER_PACK_STRUCTURE_LABEL_TRANSPORT,
                    {
                        let _msg_target = (target).to_string();
                        user_message::UserMessage::new(
                            codes::CHECKER_NAVIGATION_DESTINATION_MISSING,
                        )
                        .param("target", user_message::transport_param(_msg_target.clone()))
                        .with_detail(format!(
                            "Une destination de navigation est introuvable : {_msg_target}.",
                            _msg_target = user_message::transport_detail(&_msg_target),
                        ))
                        .into_transport()
                    },
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
                    .unwrap_or_else(|| {
                        let _msg_stage_index_1 = (stage_index + 1).to_string();
                        user_message::UserMessage::new(codes::CHECKER_STRUCTURE_ELEMENT_LABEL)
                            .param(
                                "stageNumber",
                                user_message::transport_param(_msg_stage_index_1.clone()),
                            )
                            .with_detail(format!(
                                "Élément {_msg_stage_index_1}",
                                _msg_stage_index_1 =
                                    user_message::transport_detail(&_msg_stage_index_1)
                            ))
                            .into_transport()
                    });
                report.issues.push(issue(
                    PackValidationSeverity::Error,
                    "structure",
                    stage_label,
                    {
                    let _msg_action_node = (action_node).to_string();
                    user_message::UserMessage::new(
                        codes::CHECKER_TRANSITION_ACTION_MISSING,
                    )
                        .param(
                            "actionNodeId",
                            user_message::transport_param(_msg_action_node.clone()),
                        )
                        .with_detail(format!(
                            "Une transition de navigation pointe vers une action introuvable : {_msg_action_node}.",
                            _msg_action_node = user_message::transport_detail(&_msg_action_node),
                        ))
                        .into_transport()
                    },
                ));
            }
        }
    }
}

fn validate_story_studio_editability(zip_path: &Path, _temp_dir: &Path, report: &mut ReportModel) {
    let zip_string = zip_path.to_string_lossy().to_string();
    match pack_reader::classify_pack_editability(&zip_string) {
        Ok(editability) if editability.authoring_editable => {
            report.structure_summary.story_studio_editable = true;
            report.technical_log.push({
                let projected_entry_count = (editability.projected_entry_count).to_string();
                let has_native_graph = (editability.has_native_graph).to_string();
                user_message::UserMessage::new(
                    codes::CHECKER_AUTHORING_EDITABLE_LOG,
                )
                    .param(
                        "projectedEntryCount",
                        user_message::transport_param(projected_entry_count.clone()),
                    )
                    .param(
                        "hasNativeGraph",
                        user_message::transport_param(has_native_graph.clone()),
                    )
                    .with_detail(format!(
                        "[OK] Structure éditable dans Story Studio : {projected_entry_count} entrée(s), nativeGraph={has_native_graph}",
                        has_native_graph = user_message::transport_detail(&has_native_graph),
                        projected_entry_count = user_message::transport_detail(&projected_entry_count),
                    ))
                    .into_transport()
                });
        }
        Ok(editability) => {
            report.structure_summary.story_studio_editable = false;
            let mut entry = issue(
                PackValidationSeverity::Warning,
                "structure",
                codes::CHECKER_AUTHORING_EDITING_LABEL_TRANSPORT,
                codes::CHECKER_AUTHORING_CLASSIFICATION_REFUSED_TRANSPORT,
            );
            entry.technical_details = Some(editability.reason.clone());
            report.issues.push(entry);
            report.technical_log.push({
                let _msg_editability_reason = (editability.reason).to_string();
                let projected_entry_count = (editability.projected_entry_count).to_string();
                let _msg_editability_round_trip_faithful = (editability.round_trip_faithful).to_string();
                let uses_graph_projection = (editability.uses_graph_projection).to_string();
                let has_native_graph = (editability.has_native_graph).to_string();
                let fidelity_gap_count = (editability
                    .fidelity
                    .as_ref()
                    .map(|fidelity| fidelity.gaps.len())
                    .unwrap_or(0)).to_string(); user_message::UserMessage::new(
                        codes::CHECKER_AUTHORING_REFUSAL_LOG,
                    )
    .param("reason", user_message::transport_param(_msg_editability_reason.clone()))
    .param(
        "projectedEntryCount",
        user_message::transport_param(projected_entry_count.clone()),
    )
    .param(
        "roundTripFaithful",
        user_message::transport_param(_msg_editability_round_trip_faithful.clone()),
    )
    .param(
        "usesGraphProjection",
        user_message::transport_param(uses_graph_projection.clone()),
    )
    .param(
        "hasNativeGraph",
        user_message::transport_param(has_native_graph.clone()),
    )
    .param("differenceCount", user_message::transport_param(fidelity_gap_count.clone()))
    .with_detail(format!(
        "[WARN] Édition Story Studio refusée : {_msg_editability_reason} ({projected_entry_count} entrée(s), roundTripFaithful={_msg_editability_round_trip_faithful}, usesGraphProjection={uses_graph_projection}, nativeGraph={has_native_graph}, écarts={fidelity_gap_count})",
        has_native_graph = user_message::transport_detail(&has_native_graph),
        projected_entry_count = user_message::transport_detail(&projected_entry_count),
        _msg_editability_reason = user_message::transport_detail(&_msg_editability_reason),
        _msg_editability_round_trip_faithful = user_message::transport_detail(&_msg_editability_round_trip_faithful),
        uses_graph_projection = user_message::transport_detail(&uses_graph_projection),
        fidelity_gap_count = user_message::transport_detail(&fidelity_gap_count),
    ))
    .into_transport()
});
        }
        Err(err) => {
            report.structure_summary.story_studio_editable = false;
            let mut entry = issue(
                PackValidationSeverity::Warning,
                "structure",
                codes::CHECKER_AUTHORING_EDITING_LABEL_TRANSPORT,
                codes::CHECKER_AUTHORING_EDITING_REFUSED_TRANSPORT,
            );
            entry.technical_details = Some(err.clone());
            report.issues.push(entry);
            report.technical_log.push({
                let _msg_error = (err).to_string();
                user_message::UserMessage::new(codes::CHECKER_EDITABILITY_REPORT_FAILED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "[WARN] Rapport d'éditabilité impossible : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                    ))
                    .into_transport()
            });
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
        emit(codes::CHECKER_REFERENCED_AUDIO_ABSENT_TRANSPORT);
        return;
    }
    emit(&{
        let _msg_unique_refs = (unique_refs.len()).to_string();
        user_message::UserMessage::new(codes::CHECKER_AUDIO_ANALYSIS_START)
            .param(
                "uniqueRefs",
                user_message::transport_param(_msg_unique_refs.clone()),
            )
            .with_detail(format!(
                "Analyse audio FFmpeg : {_msg_unique_refs} fichier(s)...",
                _msg_unique_refs = user_message::transport_detail(&_msg_unique_refs),
            ))
            .into_transport()
    });
    let ffmpeg = match get_ffmpeg_path() {
        Ok(path) => path,
        Err(err) => {
            emit(codes::CHECKER_ANALYSIS_FFMPEG_MISSING_TRANSPORT);
            report.issues.push(issue(
                PackValidationSeverity::Error,
                "audio",
                codes::CHECKER_AUDIO_ANALYSIS_LABEL_TRANSPORT,
                {
                    let _msg_error = (err).to_string();
                    user_message::UserMessage::new(codes::CHECKER_FFMPEG_TOOL_MISSING)
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "FFmpeg est introuvable : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error),
                        ))
                        .into_transport()
                },
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
                    analyze_one_audio(doc, zip_path, temp_dir, ffmpeg_ref, index, asset_ref)
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
    emit(&{
        let _msg_report_audio_summary_ok = (report.audio_summary.ok).to_string();
        let audio_auto_fixable_count = (report.audio_summary.auto_fixable).to_string();
        user_message::UserMessage::new(
            codes::CHECKER_AUDIO_ANALYSIS_DONE,
        )
            .param(
                "conformingAudioCount",
                user_message::transport_param(_msg_report_audio_summary_ok.clone()),
            )
            .param(
                "fixableAudioCount",
                user_message::transport_param(audio_auto_fixable_count.clone()),
            )
            .with_detail(format!(
                "Analyse audio terminée : {_msg_report_audio_summary_ok} OK, {audio_auto_fixable_count} à corriger.",
                audio_auto_fixable_count = user_message::transport_detail(&audio_auto_fixable_count),
                _msg_report_audio_summary_ok = user_message::transport_detail(&_msg_report_audio_summary_ok),
            ))
            .into_transport()
    });
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
                        {
                            let _msg_error = (err).to_string();
                            user_message::UserMessage::new(
                                codes::CHECKER_AUDIO_ANALYSIS_PREPARE_FAILED,
                            )
                            .param("error", user_message::transport_param(_msg_error.clone()))
                            .with_detail(format!(
                                "Impossible de préparer l'audio pour analyse : {_msg_error}",
                                _msg_error = user_message::transport_detail(&_msg_error),
                            ))
                            .into_transport()
                        },
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
                {
                    let _msg_error = (err).to_string();
                    user_message::UserMessage::new(codes::CHECKER_AUDIO_READ_FAILED)
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Lecture audio impossible : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error),
                        ))
                        .into_transport()
                },
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
        emit(codes::CHECKER_REFERENCED_IMAGE_ABSENT_TRANSPORT);
        return;
    }
    emit(&{
        let _msg_unique_refs = (unique_refs.len()).to_string();
        user_message::UserMessage::new(codes::CHECKER_IMAGE_ANALYSIS_START)
            .param(
                "uniqueRefs",
                user_message::transport_param(_msg_unique_refs.clone()),
            )
            .with_detail(format!(
                "Analyse images : {_msg_unique_refs} fichier(s)...",
                _msg_unique_refs = user_message::transport_detail(&_msg_unique_refs)
            ))
            .into_transport()
    });

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
    emit(&{
        let _msg_report_image_summary_ok = (report.image_summary.ok).to_string();
        let image_auto_fixable_count = (report.image_summary.auto_fixable).to_string();
        user_message::UserMessage::new(
            codes::CHECKER_IMAGE_ANALYSIS_DONE,
        )
            .param(
                "conformingImageCount",
                user_message::transport_param(_msg_report_image_summary_ok.clone()),
            )
            .param(
                "fixableImageCount",
                user_message::transport_param(image_auto_fixable_count.clone()),
            )
            .with_detail(format!(
                "Analyse images terminée : {_msg_report_image_summary_ok} OK, {image_auto_fixable_count} à corriger.",
                image_auto_fixable_count = user_message::transport_detail(&image_auto_fixable_count),
                _msg_report_image_summary_ok = user_message::transport_detail(&_msg_report_image_summary_ok),
            ))
            .into_transport()
    });
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
                {
                    let _msg_error = (err).to_string();
                    user_message::UserMessage::new(codes::CHECKER_IMAGE_READ_FAILED)
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Lecture image impossible : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error),
                        ))
                        .into_transport()
                },
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
        .filter(|issue| issue.fix_disposition == FixDisposition::Automatic)
        .count();
    report.optional_corrections_available = report
        .issues
        .iter()
        .filter(|issue| issue.fix_disposition == FixDisposition::Optional)
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
    report.technical_log.push({
        let _msg_report_verdict = format!("{:?}", report.verdict);
        user_message::UserMessage::new(codes::CHECKER_VERDICT_CALCULATED_LOG)
            .param(
                "verdict",
                user_message::transport_param(_msg_report_verdict.clone()),
            )
            .with_detail(format!(
                "[OK] Verdict calculé : {_msg_report_verdict}",
                _msg_report_verdict = user_message::transport_detail(&_msg_report_verdict)
            ))
            .into_transport()
    });
    report
}

fn finalize_report_with_log(report: ReportModel, fatal: bool, emit: &dyn Fn(&str)) -> ReportModel {
    let report = finalize_report(report, fatal);
    emit(&{
        let _msg_report_summary_errors = (report.summary.errors).to_string();
        let _msg_report_summary_warnings = (report.summary.warnings).to_string();
        let _msg_report_corrections_available = (report.corrections_available).to_string();
        user_message::UserMessage::new(
            codes::CHECKER_REPORT_READY_SUMMARY,
        )
            .param(
                "errorCount",
                user_message::transport_param(_msg_report_summary_errors.clone()),
            )
            .param(
                "warningCount",
                user_message::transport_param(_msg_report_summary_warnings.clone()),
            )
            .param(
                "correctionCount",
                user_message::transport_param(_msg_report_corrections_available.clone()),
            )
            .with_detail(format!(
                "Rapport prêt : {_msg_report_summary_errors} erreur(s), {_msg_report_summary_warnings} avertissement(s), {_msg_report_corrections_available} correction(s).",
                _msg_report_corrections_available = user_message::transport_detail(&_msg_report_corrections_available),
                _msg_report_summary_errors = user_message::transport_detail(&_msg_report_summary_errors),
                _msg_report_summary_warnings = user_message::transport_detail(&_msg_report_summary_warnings),
            ))
            .into_transport()
    });
    report
}

fn empty_report(pack_name: &str, zip_path: &str) -> ReportModel {
    ReportModel {
        pack_name: pack_name.to_string(),
        pack_title: String::new(),
        pack_description: String::new(),
        official_provenance: Default::default(),
        identity_locked: false,
        pack_uuid: String::new(),
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
        optional_corrections_available: 0,
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
        || patch.uuid.is_some()
        || patch.naming_mode.is_some()
}

pub(crate) fn apply_metadata_patch(
    story: &mut serde_json::Value,
    patch: &PackMetadataPatchModel,
) -> Result<(), String> {
    apply_metadata_patch_with_catalogue(story, patch, None)
}

pub(crate) fn apply_metadata_patch_with_catalogue(
    story: &mut serde_json::Value,
    patch: &PackMetadataPatchModel,
    catalogue: Option<&crate::services::catalogue::CatalogueState>,
) -> Result<(), String> {
    if let Some(uuid) = patch
        .uuid
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let current = pack_identity_from_story(story).unwrap_or_default();
        crate::domain::official_provenance::check_identity_change(
            Default::default(),
            &current,
            uuid,
            catalogue,
        )
        .map_err(user_message::UserMessage::into_transport)?;
        apply_pack_identity(story, uuid)?;
    }
    let Some(object) = story.as_object_mut() else {
        return Ok(());
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

    // L'âge, l'auteur, le producteur, le bonus et le mode de nommage ne composent
    // que le nom du fichier corrigé (`convention_zip_stem`). Ils n'entrent pas
    // dans le pack : aucun lecteur ne les relirait, et l'Éditeur graphe y verrait
    // une extension inconnue à trancher.
    Ok(())
}

/// Donne au pack corrigé l'identité choisie dans la fenêtre des métadonnées.
///
/// STUdio et Lunii.QT lisent l'identité sur l'Écran d'entrée ; écrire le seul
/// `uuid` de tête laissait « Générer un nouvel UUID » sans effet sur l'appareil.
/// L'Écran d'entrée est donc renommé, avec toutes les options d'Action qui le
/// visent, et la tête est alignée. Garder l'identité ne touche à rien.
///
/// Un autre Écran qui porterait déjà la chaîne choisie serait fusionné par
/// STUdio : il reçoit d'abord un UUID neuf, et ses références le suivent.
fn apply_pack_identity(story: &mut serde_json::Value, identity: &str) -> Result<(), String> {
    if let Some(refusal) = pack_identity_refusal(identity) {
        return Err(
            user_message::UserMessage::new(codes::PACK_IDENTITY_UNREADABLE)
                .param("identity", identity)
                .with_detail(refusal)
                .into_transport(),
        );
    }
    if pack_identity_from_story(story).as_deref() == Some(identity) {
        return Ok(());
    }
    let stages = story
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            user_message::UserMessage::new(codes::CHECKER_IDENTITY_STAGES_MISSING)
                .with_detail(
                    "story.json sans stageNodes : l'identité ne peut pas être posée.".to_string(),
                )
                .into_transport()
        })?;
    let entries: Vec<usize> = stages
        .iter()
        .enumerate()
        .filter(|(_, stage)| stage.get("squareOne").and_then(|value| value.as_bool()) == Some(true))
        .map(|(index, _)| index)
        .collect();
    let [entry_index] = entries[..] else {
        return Err(
            user_message::UserMessage::new(codes::CHECKER_IDENTITY_ENTRY_AMBIGUOUS)
                .with_detail(
                    "Le pack n'a pas un seul Écran d'entrée : son identité ne peut pas être posée."
                        .to_string(),
                )
                .into_transport(),
        );
    };
    let entry_id = stages[entry_index]
        .get("uuid")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let colliding: Vec<usize> = stages
        .iter()
        .enumerate()
        .filter(|(index, stage)| {
            *index != entry_index
                && stage.get("uuid").and_then(|value| value.as_str()) == Some(identity)
        })
        .map(|(index, _)| index)
        .collect();

    for index in colliding {
        rename_stage(story, index, identity, &uuid::Uuid::new_v4().to_string());
    }
    rename_stage(story, entry_index, &entry_id, identity);
    if let Some(object) = story.as_object_mut() {
        object.insert(
            "uuid".to_string(),
            serde_json::Value::String(identity.to_string()),
        );
    }
    Ok(())
}

/// Renomme un Écran et les options d'Action qui le visent. Une option est une
/// chaîne d'identifiant d'Écran ; seules les options égales à l'ancien nom
/// bougent.
fn rename_stage(story: &mut serde_json::Value, index: usize, from: &str, to: &str) {
    if let Some(stage) = story
        .get_mut("stageNodes")
        .and_then(|value| value.as_array_mut())
        .and_then(|stages| stages.get_mut(index))
        .and_then(|stage| stage.as_object_mut())
    {
        stage.insert(
            "uuid".to_string(),
            serde_json::Value::String(to.to_string()),
        );
    }
    if from.is_empty() {
        return;
    }
    let actions = story
        .get_mut("actionNodes")
        .and_then(|value| value.as_array_mut())
        .into_iter()
        .flatten();
    for action in actions {
        let options = action
            .get_mut("options")
            .and_then(|value| value.as_array_mut())
            .into_iter()
            .flatten();
        for option in options {
            if option.as_str() == Some(from) {
                *option = serde_json::Value::String(to.to_string());
            }
        }
    }
}

fn write_fixed_zip(
    identity: &crate::native_pack::output_identity::OutputIdentity,
    source_zip: &Path,
    output_zip: &Path,
    story: &serde_json::Value,
    fixed_assets: &HashMap<String, Vec<u8>>,
    audio_replacements: &HashMap<String, String>,
    image_replacements: &HashMap<String, String>,
) -> Result<(), String> {
    let source_file = fs::File::open(source_zip).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_SOURCE_ZIP_OPEN_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible d'ouvrir le ZIP source : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let source_archive = zip::ZipArchive::new(source_file).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_SOURCE_ZIP_INVALID)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "ZIP source invalide : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if let Some(parent) = output_zip.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::CHECKER_OUTPUT_FOLDER_CREATE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de créer le dossier de sortie : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                ))
                .into_transport()
        })?;
    }
    let output_file = fs::File::create(output_zip).map_err(|e| {
        let _msg_output_zip = (output_zip.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_OUTPUT_FILE_CREATE_FAILED)
            .param(
                "outputZip",
                user_message::transport_param(_msg_output_zip.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de créer {_msg_output_zip} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_output_zip = user_message::transport_detail(&_msg_output_zip)
            ))
            .into_transport()
    })?;
    write_fixed_zip_to_cancellable(
        identity,
        source_archive,
        output_file,
        Some(serialize_metadata_story(story)?),
        fixed_assets,
        audio_replacements,
        image_replacements,
        None,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

/// Shared story serialization for archive and directory metadata changes.
pub(crate) fn serialize_metadata_story(story: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string_pretty(story).map_err(|e| {
        user_message::UserMessage::new(codes::CHECKER_STORY_ENCODE_FAILED)
            .param("error", e.to_string())
            .with_detail(e.to_string())
            .into_transport()
    })
}

#[cfg(test)]
pub(crate) fn write_metadata_zip(
    source: &Path,
    output: fs::File,
    story: Option<&str>,
    cover: Option<&[u8]>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let identity = crate::native_pack::output_identity::for_path(
        source,
        crate::native_pack::output_identity::OutputForm::Rewritten,
        None,
    )
    .map_err(user_message::UserMessage::into_transport)?;
    write_metadata_zip_authorized(&identity, source, output, story, cover, cancel)
}

/// Metadata-only boundary: never invokes analysis or media correction.
pub(crate) fn write_metadata_zip_authorized(
    identity: &crate::native_pack::output_identity::OutputIdentity,
    source: &Path,
    output: fs::File,
    story: Option<&str>,
    cover: Option<&[u8]>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let archive = zip::ZipArchive::new(fs::File::open(source).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    write_fixed_zip_to_cancellable(
        identity,
        archive,
        output,
        story.map(str::to_owned),
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
        cover,
        cancel,
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn write_fixed_zip_to(
    source_archive: zip::ZipArchive<fs::File>,
    output_file: fs::File,
    story: Option<String>,
    fixed_assets: &HashMap<String, Vec<u8>>,
    audio_replacements: &HashMap<String, String>,
    image_replacements: &HashMap<String, String>,
    cover: Option<&[u8]>,
) -> Result<(), String> {
    let value = story
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| serde_json::json!({}));
    let identity = crate::native_pack::output_identity::for_story(
        &value,
        crate::native_pack::output_identity::OutputForm::Rewritten,
        None,
    )
    .map_err(user_message::UserMessage::into_transport)?;
    write_fixed_zip_to_cancellable(
        &identity,
        source_archive,
        output_file,
        story,
        fixed_assets,
        audio_replacements,
        image_replacements,
        cover,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

#[allow(clippy::too_many_arguments)]
fn write_fixed_zip_to_cancellable(
    identity: &crate::native_pack::output_identity::OutputIdentity,
    mut source_archive: zip::ZipArchive<fs::File>,
    output_file: fs::File,
    story: Option<String>,
    fixed_assets: &HashMap<String, Vec<u8>>,
    audio_replacements: &HashMap<String, String>,
    image_replacements: &HashMap<String, String>,
    cover: Option<&[u8]>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let story = story.map(|text| identity.serialize(&text)).transpose()?;
    let mut writer = zip::ZipWriter::new(crate::support::imported_pack::cancellation::Writer {
        inner: output_file,
        cancel,
        stage: "metadataZipWrite",
    });
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut written = HashSet::new();

    if let Some(story_bytes) = story {
        writer.start_file("story.json", opts).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::CHECKER_STORY_ZIP_WRITE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "ZIP story.json : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        writer.write_all(story_bytes.as_bytes()).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::CHECKER_STORY_WRITE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Écriture story.json impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        written.insert("story.json".to_string());
    }
    if let Some(bytes) = cover {
        writer
            .start_file("thumbnail.png", opts)
            .map_err(|e| e.to_string())?;
        writer.write_all(bytes).map_err(|e| e.to_string())?;
        written.insert("thumbnail.png".into());
    }
    for index in 0..source_archive.len() {
        let entry = source_archive.by_index(index).map_err(|e| {
            let _msg_index = (index).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::CHECKER_REWRITE_ZIP_INDEX_FAILED)
                .param("index", user_message::transport_param(_msg_index.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Lecture ZIP index {_msg_index} impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_index = user_message::transport_detail(&_msg_index),
                ))
                .into_transport()
        })?;
        if entry.is_dir() {
            continue;
        }
        let entry_name = entry.name().replace('\\', "/");
        if entry_name == "story.json" && written.contains("story.json") {
            continue;
        }
        if entry_name == "thumbnail.png" && cover.is_some() {
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
                    writer.start_file(&new_entry_name, opts).map_err(|e| {
                        let _msg_new_entry_name = (new_entry_name).to_string();
                        let _msg_error = (e).to_string();
                        user_message::UserMessage::new(codes::CHECKER_REWRITE_ZIP_READ_FAILED)
                            .param(
                                "newEntryName",
                                user_message::transport_param(_msg_new_entry_name.clone()),
                            )
                            .param("error", user_message::transport_param(_msg_error.clone()))
                            .with_detail(format!(
                                "ZIP {_msg_new_entry_name} : {_msg_error}",
                                _msg_error = user_message::transport_detail(&_msg_error),
                                _msg_new_entry_name =
                                    user_message::transport_detail(&_msg_new_entry_name)
                            ))
                            .into_transport()
                    })?;
                    writer.write_all(bytes).map_err(|e| {
                        let _msg_new_entry_name = (new_entry_name).to_string();
                        let _msg_error = (e).to_string();
                        user_message::UserMessage::new(codes::CHECKER_REWRITE_ASSET_WRITE_FAILED)
                            .param(
                                "newEntryName",
                                user_message::transport_param(_msg_new_entry_name.clone()),
                            )
                            .param("error", user_message::transport_param(_msg_error.clone()))
                            .with_detail(format!(
                                "Écriture {_msg_new_entry_name} impossible : {_msg_error}",
                                _msg_error = user_message::transport_detail(&_msg_error),
                                _msg_new_entry_name =
                                    user_message::transport_detail(&_msg_new_entry_name),
                            ))
                            .into_transport()
                    })?;
                }
            }
            continue;
        }
        if written.insert(entry_name.clone()) {
            writer
                .raw_copy_file_rename(entry, entry_name)
                .map_err(|e| {
                    user_message::UserMessage::new(codes::CHECKER_ZIP_FINALIZE_FAILED)
                        .param("error", e.to_string())
                        .with_detail(e.to_string())
                        .into_transport()
                })?;
        }
    }

    for (short, bytes) in fixed_assets {
        let entry_name = format!("assets/{}", short);
        if written.insert(entry_name.clone()) {
            writer.start_file(&entry_name, opts).map_err(|e| {
                let _msg_entry_name = (entry_name).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::CHECKER_REWRITE_ASSET_ZIP_FAILED)
                    .param(
                        "entryName",
                        user_message::transport_param(_msg_entry_name.clone()),
                    )
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "ZIP {_msg_entry_name} : {_msg_error}",
                        _msg_entry_name = user_message::transport_detail(&_msg_entry_name),
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            })?;
            writer.write_all(bytes).map_err(|e| {
                let _msg_entry_name = (entry_name).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::CHECKER_REWRITE_BYTES_WRITE_FAILED)
                    .param(
                        "entryName",
                        user_message::transport_param(_msg_entry_name.clone()),
                    )
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Écriture {_msg_entry_name} impossible : {_msg_error}",
                        _msg_entry_name = user_message::transport_detail(&_msg_entry_name),
                        _msg_error = user_message::transport_detail(&_msg_error),
                    ))
                    .into_transport()
            })?;
        }
    }

    writer
        .finish()
        .map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::CHECKER_ZIP_FINALIZE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Finalisation ZIP impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
        .inner
        .sync_all()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn unique_fixed_zip_path(
    source: &Path,
    output_dir: Option<&Path>,
    metadata_patch: Option<&PackMetadataPatchModel>,
) -> PathBuf {
    let parent = output_dir
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| source.parent().unwrap_or_else(|| Path::new(".")));
    let stem = metadata_patch
        .and_then(convention_zip_stem)
        .or_else(|| {
            // Un dossier garde son nom entier : « Histoire v1.2 » n'a pas d'extension.
            (if source.is_dir() {
                source.file_name()
            } else {
                source.file_stem()
            })
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
    let Some((prefix, rest)) = value.split_once("+]") else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let valid = if let Some((min, max)) = prefix.split_once('-') {
        (min.is_empty() || digits(min))
            && digits(max)
            && min
                .parse::<u64>()
                .ok()
                .zip(max.parse::<u64>().ok())
                .is_none_or(|(a, b)| a <= b)
    } else {
        digits(prefix)
    };
    if !valid {
        return false;
    }
    let core = rest
        .split("[by_")
        .next()
        .unwrap_or("")
        .trim_matches('_')
        .trim();
    !core.is_empty()
}

fn friendly_zip_error(err: &user_message::UserMessage) -> String {
    use crate::support::user_message::codes;
    match err.code.as_str() {
        codes::CHECKER_STORY_UNREADABLE => {
            user_message::UserMessage::new(codes::CHECKER_STORY_UNREADABLE)
                .with_detail(
                    "Le pack ne contient pas de story.json lisible à la racine.".to_string(),
                )
                .into_transport()
        }
        codes::CHECKER_ZIP_INVALID => user_message::UserMessage::new(codes::CHECKER_ZIP_INVALID)
            .with_detail("Le fichier n'est pas un ZIP lisible.".to_string())
            .into_transport(),
        _ => {
            let _msg_error = (err).to_string();
            user_message::UserMessage::new(codes::CHECKER_PACK_INVALID_UNREADABLE)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Le pack est invalide ou illisible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                ))
                .into_transport()
        }
    }
}

#[cfg(test)]
mod message_classification_tests {
    use super::*;
    use crate::support::user_message::{codes, UserMessage};
    #[test]
    fn missing_zip_preserves_the_coded_open_failure() {
        let path = std::env::temp_dir().join(format!(
            "story-studio-missing-zip-{}.zip",
            uuid::Uuid::new_v4()
        ));
        let error = match zip_doc::read_pack_doc(&path) {
            Err(error) => error,
            Ok(_) => panic!("missing ZIP was accepted"),
        };
        assert_eq!(error.code, codes::CHECKER_PACK_UNREADABLE);
        let shown: UserMessage = serde_json::from_str(&friendly_zip_error(&error)).unwrap();
        assert_eq!(shown.code, codes::CHECKER_PACK_INVALID_UNREADABLE);
        assert_eq!(
            shown.params["error"]["code"],
            codes::CHECKER_ZIP_OPEN_FAILED
        );
        assert!(shown.params["error"]["params"]["error"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
    }

    #[test]
    fn friendly_zip_errors_are_independent_of_french_text() {
        for (code, expected) in [
            (
                codes::CHECKER_STORY_UNREADABLE,
                codes::CHECKER_STORY_UNREADABLE,
            ),
            (codes::CHECKER_ZIP_INVALID, codes::CHECKER_ZIP_INVALID),
        ] {
            assert_eq!(
                serde_json::from_str::<UserMessage>(&friendly_zip_error(
                    &UserMessage::new(code).with_detail("texte changé sans mots-clés")
                ))
                .unwrap()
                .code,
                expected
            );
            assert_eq!(
                serde_json::from_str::<UserMessage>(&friendly_zip_error(
                    &UserMessage::new(code).with_detail("story.json Archive ZIP invalide")
                ))
                .unwrap()
                .code,
                expected
            );
        }
        let message: UserMessage = serde_json::from_str(&friendly_zip_error(
            &UserMessage::new(codes::CHECKER_PACK_UNREADABLE)
                .with_detail("story.json Archive ZIP invalide"),
        ))
        .unwrap();
        assert_eq!(message.code, codes::CHECKER_PACK_INVALID_UNREADABLE);
        assert_eq!(message.params["error"], "story.json Archive ZIP invalide");
    }
}
