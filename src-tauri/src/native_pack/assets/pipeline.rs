use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Instant;

use rayon::prelude::*;

use uuid::Uuid;

use super::super::{
    build_asset_notes, canonicalize_project, sanitize_stage_label, scoped_label_id, CanonicalEntry,
    CanonicalProject, NativeAssetPreparationReport, NativeAssetStats, PreparedAsset,
};
use super::audio::{audio_needs_processing, process_audio_asset};
use super::image::{
    ensure_image_320x240, image_request, stage_binary_asset, stage_binary_asset_bytes,
};
use super::zip_bundle::stage_imported_zip_bundle;
use crate::domain::project::{AudioFieldProcessing, Project};
use crate::services::project_files::validate_existing_file_path;
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};
use crate::support::imported_pack::ensure_studio_pack_zip;

#[derive(Debug, Clone)]
pub(crate) enum AssetSourceKind {
    Audio,
    Image,
    Zip,
}

#[derive(Debug, Clone)]
pub(crate) struct AssetRequest {
    pub(crate) role: String,
    pub(crate) source_path: String,
    pub(crate) source_kind: AssetSourceKind,
    pub(crate) skip_silence: bool,
    pub(crate) silence_duration_sec: f64,
}

// Resultat du preprocess parallele d'une AssetRequest. Contient tout ce dont
// la phase de staging sequentiel a besoin pour appeler stage_* (qui touche
// seen_assets et n'est pas thread-safe).
struct PreprocessedRequest {
    role: String,
    asset: PreprocessedAsset,
    /// Temps wall-clock passe dans la phase preprocess pour cette request
    /// (utile pour le cumul CPU par categorie). Peut etre 0 pour les
    /// passes triviales (image as-is, audio passthrough).
    preprocess_ms: u128,
}

enum PreprocessedAsset {
    /// 7z eventuellement converti en zip. Le staging final (extraction
    /// + dedup) reste sequentiel via stage_imported_zip_bundle.
    Zip { canonical_zip_path: String },
    /// Image deja conforme 320x240, on staged le fichier source tel quel.
    ImageAsIs { source_path: String },
    /// Image re-encodee via image crate (resize 320x240). On a deja les
    /// bytes PNG ; la phase suivante les staged via stage_binary_asset_bytes.
    ImageResized { png_bytes: Vec<u8> },
    /// Audio passe par ffmpeg, fichier resultant dans processed_audio_dir.
    AudioProcessed { prepared_source: PathBuf },
    /// Audio inchange, on prend le source apres validation du chemin.
    AudioPassthrough { prepared_source: PathBuf },
}

fn preprocess_request(
    request: &AssetRequest,
    canonical_options: &crate::native_pack::CanonicalOptions,
    ffmpeg: Option<&PathBuf>,
    processed_audio_dir: &Path,
) -> Result<PreprocessedRequest, String> {
    let start = Instant::now();
    let asset = match request.source_kind {
        AssetSourceKind::Zip => {
            let canonical = ensure_studio_pack_zip(&request.source_path)?
                .to_string_lossy()
                .to_string();
            PreprocessedAsset::Zip {
                canonical_zip_path: canonical,
            }
        }
        AssetSourceKind::Image => {
            let raw = fs::read(&request.source_path)
                .map_err(|e| format!("Lecture image '{}' : {}", request.role, e))?;
            match ensure_image_320x240(&raw, &request.role)? {
                None => PreprocessedAsset::ImageAsIs {
                    source_path: request.source_path.clone(),
                },
                Some(png_bytes) => PreprocessedAsset::ImageResized { png_bytes },
            }
        }
        AssetSourceKind::Audio => {
            let needs_processing = audio_needs_processing(
                &request.source_path,
                canonical_options,
                request.skip_silence,
            );
            if needs_processing {
                let ffmpeg = ffmpeg.ok_or_else(|| {
                    "ffmpeg requis pour la preparation audio native mais introuvable.".to_string()
                })?;
                let prepared_source = process_audio_asset(
                    &request.source_path,
                    ffmpeg,
                    processed_audio_dir,
                    canonical_options,
                    request.silence_duration_sec,
                    request.skip_silence,
                    &request.role,
                )?;
                PreprocessedAsset::AudioProcessed { prepared_source }
            } else {
                let prepared_source =
                    validate_existing_file_path(&request.source_path, &request.role)?;
                PreprocessedAsset::AudioPassthrough { prepared_source }
            }
        }
    };
    Ok(PreprocessedRequest {
        role: request.role.clone(),
        asset,
        preprocess_ms: start.elapsed().as_millis(),
    })
}

struct TempDirGuard {
    path: PathBuf,
    active: bool,
}

impl TempDirGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, active: true }
    }
    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub(crate) fn prepare_native_pack_assets_report_with_cancel(
    project: &Project,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<NativeAssetPreparationReport, String> {
    let canonical = canonicalize_project(project);
    let requests = collect_asset_requests(
        &canonical,
        &project.audio_processing,
        project.global_options.add_silence_duration_sec,
    );
    let has_audio_processing = requests.iter().any(|request| {
        matches!(request.source_kind, AssetSourceKind::Audio)
            && audio_needs_processing(
                &request.source_path,
                &canonical.options,
                request.skip_silence,
            )
    });
    let ffmpeg = if has_audio_processing {
        Some(get_ffmpeg_path()?)
    } else {
        None
    };

    let stage_dir = std::env::temp_dir().join(format!(
        "story_studio_native_assets_{}_{}",
        now_millis(),
        Uuid::new_v4()
    ));
    let assets_dir = stage_dir.join("assets");
    let processed_audio_dir = stage_dir.join("_processed_audio");
    let mut stage_guard = TempDirGuard::new(stage_dir.clone());
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&processed_audio_dir).map_err(|e| e.to_string())?;

    let mut prepared_assets = Vec::new();
    let mut imported_zips = Vec::new();
    let mut seen_assets: HashMap<String, PathBuf> = HashMap::new();
    let mut transformed_audio_count = 0usize;

    // Lot 11 P4 : pipeline d'assets parallelise via rayon, avec instrumentation
    // timing pour comparer parallele vs serie.
    //
    // Phase 1 (PARALLELE) : preprocess de chaque request. Ce sont les
    // operations CPU/IO sans etat partage :
    //   - ffmpeg re-encode audio
    //   - resize image 320x240
    //   - ensure_studio_pack_zip (conversion 7z -> zip si besoin)
    //
    // Phase 2 (SEQUENTIELLE) : staging. Ces operations touchent seen_assets
    // (deduplication via Map) et emit (callback synchrone) :
    //   - stage_binary_asset / stage_binary_asset_bytes
    //   - stage_imported_zip_bundle
    //   - emit callback (non thread-safe par contrat dyn Fn)
    //
    // Le thread pool rayon par defaut utilise tous les cores. Pour un projet
    // 50 stories, ffmpeg etant CPU-bound, on attend un gain ~Nx (N=cores).
    let pipeline_start = Instant::now();
    let preprocess_start = Instant::now();

    emit("🧪 Preparation assets moteur natif");
    emit(&format!("  Stage dir : {}", stage_dir.to_string_lossy()));
    emit(&format!(
        "  Prétraitement assets : {} élément(s)",
        requests.len()
    ));

    let canonical_options = &canonical.options;
    let ffmpeg_ref = ffmpeg.as_ref();
    let processed_audio_dir_ref = &processed_audio_dir;
    let (progress_tx, progress_rx) = mpsc::channel::<String>();

    let preprocessed: Result<Vec<PreprocessedRequest>, String> = std::thread::scope(|scope| {
        let worker_tx = progress_tx.clone();
        let handle = scope.spawn(move || {
            requests
                .par_iter()
                .map(|request| {
                    if should_cancel() {
                        return Err("Génération annulée.".to_string());
                    }
                    let tx = worker_tx.clone();
                    let _ = tx.send(format!("  ▶ {}", request.role));
                    let result = preprocess_request(
                        request,
                        canonical_options,
                        ffmpeg_ref,
                        processed_audio_dir_ref,
                    );
                    match &result {
                        Ok(pre) => {
                            let _ = tx.send(format!("  ✓ {} ({} ms)", pre.role, pre.preprocess_ms));
                        }
                        Err(err) => {
                            let _ = tx.send(format!("  ✕ {} : {}", request.role, err));
                        }
                    }
                    if should_cancel() {
                        return Err("Génération annulée.".to_string());
                    }
                    result
                })
                .collect()
        });
        drop(progress_tx);
        for message in progress_rx {
            emit(&message);
        }
        handle
            .join()
            .map_err(|_| "Prétraitement assets interrompu.".to_string())?
    });
    let preprocessed = preprocessed?;
    let preprocess_ms = preprocess_start.elapsed().as_millis();

    let stage_start = Instant::now();
    let mut zip_ms: u128 = 0;
    let mut image_ms: u128 = 0;
    let mut audio_processing_ms: u128 = 0;
    let mut audio_passthrough_ms: u128 = 0;
    let mut image_resize_count: usize = 0;

    if should_cancel() {
        return Err("Génération annulée.".to_string());
    }
    emit("  Staging assets...");

    for pre in preprocessed {
        if should_cancel() {
            return Err("Génération annulée.".to_string());
        }
        match pre.asset {
            PreprocessedAsset::Zip { canonical_zip_path } => {
                emit(&format!("  📦 ZIP fusion natif : {}", pre.role));
                let (bundle, mut zip_assets) = stage_imported_zip_bundle(
                    &pre.role,
                    &canonical_zip_path,
                    &assets_dir,
                    &mut seen_assets,
                )?;
                for asset in &zip_assets {
                    emit_asset_result(asset, emit);
                }
                prepared_assets.append(&mut zip_assets);
                imported_zips.push(bundle);
                zip_ms += pre.preprocess_ms;
            }
            PreprocessedAsset::ImageAsIs { source_path } => {
                let prepared = stage_binary_asset(
                    &pre.role,
                    &source_path,
                    "image",
                    &assets_dir,
                    &mut seen_assets,
                    false,
                )?;
                emit_asset_result(&prepared, emit);
                prepared_assets.push(prepared);
                image_ms += pre.preprocess_ms;
            }
            PreprocessedAsset::ImageResized { png_bytes } => {
                image_resize_count += 1;
                emit(&format!("  [resize] {} -> 320x240", pre.role));
                let prepared = stage_binary_asset_bytes(
                    &pre.role,
                    "resized.png",
                    &png_bytes,
                    &assets_dir,
                    &mut seen_assets,
                )?;
                emit_asset_result(&prepared, emit);
                prepared_assets.push(prepared);
                image_ms += pre.preprocess_ms;
            }
            PreprocessedAsset::AudioProcessed { prepared_source } => {
                transformed_audio_count += 1;
                let prepared = stage_binary_asset(
                    &pre.role,
                    &prepared_source.to_string_lossy(),
                    "audio",
                    &assets_dir,
                    &mut seen_assets,
                    true,
                )?;
                emit_asset_result(&prepared, emit);
                prepared_assets.push(prepared);
                audio_processing_ms += pre.preprocess_ms;
            }
            PreprocessedAsset::AudioPassthrough { prepared_source } => {
                let prepared = stage_binary_asset(
                    &pre.role,
                    &prepared_source.to_string_lossy(),
                    "audio",
                    &assets_dir,
                    &mut seen_assets,
                    false,
                )?;
                emit_asset_result(&prepared, emit);
                prepared_assets.push(prepared);
                audio_passthrough_ms += pre.preprocess_ms;
            }
        }
    }
    let stage_ms = stage_start.elapsed().as_millis();

    let stats = NativeAssetStats {
        requested_asset_count: prepared_assets.len(),
        unique_asset_count: seen_assets.len(),
        transformed_audio_count,
        imported_zip_count: imported_zips.len(),
    };

    let notes = build_asset_notes(&canonical.options, &stats);

    emit(&format!(
        "  Assets uniques : {} | audios transformes : {} | zips importes : {}",
        stats.unique_asset_count, stats.transformed_audio_count, stats.imported_zip_count,
    ));
    // Note: les `*_ms` ci-dessous somment le temps WALL-CLOCK passe DANS
    // chaque etape avant la parallelisation. La somme peut depasser le
    // wall-clock total si execute en parallele (c'est attendu : on a 4
    // ffmpeg qui tournent en parallele, chacun comptant 1s, total cpu 4s,
    // wall 1s).
    let total_ms = pipeline_start.elapsed().as_millis();
    emit(&format!(
        "  ⏱  Timing assets : total wall {} ms | preprocess parallele {} ms | stage sequentiel {} ms",
        total_ms, preprocess_ms, stage_ms,
    ));
    emit(&format!(
        "      cumul CPU par categorie : audio ffmpeg {} ms ({}x) | audio passthrough {} ms | image {} ms ({}x resize) | zip {} ms",
        audio_processing_ms,
        transformed_audio_count,
        audio_passthrough_ms,
        image_ms,
        image_resize_count,
        zip_ms,
    ));
    emit("  Aucun ZIP final n'est encore genere a ce stade.");

    stage_guard.disarm();
    Ok(NativeAssetPreparationReport {
        project: canonical,
        stage_dir: stage_dir.to_string_lossy().to_string(),
        assets_dir: assets_dir.to_string_lossy().to_string(),
        assets: prepared_assets,
        imported_zips,
        stats,
        notes,
    })
}

pub(crate) fn collect_asset_requests(
    project: &CanonicalProject,
    root_audio_processing: &HashMap<String, AudioFieldProcessing>,
    silence_duration_sec: f64,
) -> Vec<AssetRequest> {
    let mut requests = Vec::new();

    if let Some(path) = project.root_audio.as_ref() {
        requests.push(audio_request_with_processing(
            "rootAudio",
            path,
            skip_silence_for(root_audio_processing, "rootAudio"),
            silence_duration_sec,
        ));
    }
    if let Some(path) = project.root_image.as_ref() {
        requests.push(image_request("rootImage", path));
    }
    if let Some(path) = project.thumbnail_image.as_ref() {
        requests.push(image_request("thumbnailImage", path));
    }
    if !project.options.auto_next {
        if let Some(path) = project.night_mode_audio.as_ref() {
            requests.push(audio_request_with_processing(
                "nightModeAudio",
                path,
                skip_silence_for(root_audio_processing, "nightModeAudio"),
                silence_duration_sec,
            ));
        }
    }

    for entry in &project.entries {
        collect_entry_requests(
            entry,
            "root",
            &mut requests,
            project.options.auto_next,
            silence_duration_sec,
        );
    }
    if !project.options.auto_next {
        collect_native_graph_requests(project.native_graph.as_ref(), &mut requests);
    }

    requests
}

pub(crate) fn native_graph_asset_role(stage_id: &str, field: &str) -> String {
    format!("nativeGraph/{}/{}", sanitize_stage_label(stage_id), field)
}

fn native_graph_stage_uuid(stage: &serde_json::Value) -> Option<&str> {
    stage
        .get("uuid")
        .or_else(|| stage.get("id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn active_native_graph(
    native_graph: Option<&serde_json::Value>,
) -> Option<&serde_json::Value> {
    let graph = native_graph?;
    let preserve_for_roundtrip = graph
        .get("preserveForRoundTrip")
        .and_then(|value| value.as_bool())
        .or_else(|| graph.get("roundTripMode").and_then(|value| value.as_bool()))
        == Some(true);
    if !preserve_for_roundtrip {
        return None;
    }
    graph
        .get("document")
        .and_then(|value| value.as_object())
        .map(|_| graph)
}

fn collect_native_graph_requests(
    native_graph: Option<&serde_json::Value>,
    requests: &mut Vec<AssetRequest>,
) {
    let Some(stages) = active_native_graph(native_graph)
        .and_then(|graph| graph.get("document"))
        .and_then(|document| document.get("stageNodes"))
        .and_then(|value| value.as_array())
    else {
        return;
    };

    for stage in stages {
        let stage_id = native_graph_stage_uuid(stage).unwrap_or("stage");
        if let Some(path) = stage.get("audio").and_then(|value| value.as_str()) {
            requests.push(audio_request_with_processing(
                &native_graph_asset_role(stage_id, "audio"),
                path,
                true,
                1.0,
            ));
        }
        if let Some(path) = stage.get("image").and_then(|value| value.as_str()) {
            requests.push(image_request(
                &native_graph_asset_role(stage_id, "image"),
                path,
            ));
        }
    }
}

fn collect_entry_requests(
    entry: &CanonicalEntry,
    prefix: &str,
    requests: &mut Vec<AssetRequest>,
    auto_next: bool,
    silence_duration_sec: f64,
) {
    match entry {
        CanonicalEntry::Menu(menu) => {
            let label = scoped_label_id(prefix, &menu.id, &menu.name);
            if let Some(path) = menu.audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/menuAudio", label),
                    path,
                    skip_silence_for(&menu.audio_processing, "audio"),
                    silence_duration_sec,
                ));
            }
            if let Some(path) = menu.image.as_ref() {
                requests.push(image_request(&format!("{}/menuImage", label), path));
            }
            for child in &menu.children {
                collect_entry_requests(child, &label, requests, auto_next, silence_duration_sec);
            }
        }
        CanonicalEntry::Story(story) => {
            let label = scoped_label_id(prefix, &story.id, &story.name);
            if let Some(path) = story.audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/storyAudio", label),
                    path,
                    skip_silence_for(&story.audio_processing, "audio"),
                    silence_duration_sec,
                ));
            }
            if let Some(path) = story.item_audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/itemAudio", label),
                    path,
                    skip_silence_for(&story.audio_processing, "itemAudio"),
                    silence_duration_sec,
                ));
            }
            if !auto_next {
                if let Some(path) = story.after_playback_prompt_audio.as_ref() {
                    requests.push(audio_request_with_processing(
                        &format!("{}/afterPlaybackPromptAudio", label),
                        path,
                        skip_silence_for(&story.audio_processing, "afterPlaybackPromptAudio"),
                        silence_duration_sec,
                    ));
                }
                for (index, step) in story.after_playback_sequence.iter().enumerate() {
                    if let Some(path) = step.audio.as_ref() {
                        requests.push(audio_request_with_processing(
                            &format!("{}/afterPlaybackSequence/{}/audio", label, index),
                            path,
                            skip_silence_for(&story.audio_processing, "afterPlaybackSequence"),
                            silence_duration_sec,
                        ));
                    }
                    if let Some(path) = step.image.as_ref() {
                        requests.push(image_request(
                            &format!("{}/afterPlaybackSequence/{}/image", label, index),
                            path,
                        ));
                    }
                }
                if let Some(step) = story.after_playback_home_step.as_ref() {
                    if let Some(path) = step.audio.as_ref() {
                        requests.push(audio_request_with_processing(
                            &format!("{}/afterPlaybackHomeStep/audio", label),
                            path,
                            skip_silence_for(&story.audio_processing, "afterPlaybackHomeStep"),
                            silence_duration_sec,
                        ));
                    }
                    if let Some(path) = step.image.as_ref() {
                        requests.push(image_request(
                            &format!("{}/afterPlaybackHomeStep/image", label),
                            path,
                        ));
                    }
                }
            }
            if let Some(path) = story.item_image.as_ref() {
                requests.push(image_request(&format!("{}/itemImage", label), path));
            }
        }
        CanonicalEntry::Zip(zip) => {
            if let Some(path) = zip.zip_path.as_ref() {
                requests.push(zip_request(
                    &format!("{}/zip", scoped_label_id(prefix, &zip.id, &zip.name)),
                    path,
                ));
            }
        }
    }
}

fn emit_asset_result(asset: &PreparedAsset, emit: &dyn Fn(&str)) {
    let suffix = if asset.deduplicated { " (dedup)" } else { "" };
    let transform = if asset.transformed {
        "transforme"
    } else {
        "copie"
    };
    emit(&format!(
        "  {} → {} [{}]{}",
        asset.role, asset.staged_asset_name, transform, suffix
    ));
}

fn audio_request_with_processing(
    role: &str,
    source_path: &str,
    skip_silence: bool,
    silence_duration_sec: f64,
) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Audio,
        skip_silence,
        silence_duration_sec,
    }
}

fn skip_silence_for(processing: &HashMap<String, AudioFieldProcessing>, field: &str) -> bool {
    processing
        .get("__allAudio")
        .or_else(|| processing.get(field))
        .map(|value| value.skip_silence)
        .unwrap_or(false)
}

fn zip_request(role: &str, source_path: &str) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Zip,
        skip_silence: false,
        silence_duration_sec: 1.0,
    }
}
