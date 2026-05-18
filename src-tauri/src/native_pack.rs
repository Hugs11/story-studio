use serde::{Deserialize, Serialize};
use serde_json::Number;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use uuid::Uuid;

use crate::domain::project::{
    AfterPlaybackSequenceStep, AudioFieldProcessing, EntryControlSettings, GlobalOptions, Project,
    ProjectEntry,
};
use crate::domain::validation::project_root_entries;
use crate::services::project_files::validate_existing_file_path;
use crate::support::ffmpeg::{apply_no_window, file_ext, get_ffmpeg_path, now_millis};
use crate::support::imported_pack::ensure_studio_pack_zip;

const MP3_HEADER_SCAN_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CanonicalProject {
    pub(crate) name: String,
    pub(crate) project_type: String,
    pub(crate) pack_version: i32,
    pub(crate) pack_description: String,
    pub(crate) root_audio: Option<String>,
    pub(crate) root_image: Option<String>,
    pub(crate) thumbnail_image: Option<String>,
    pub(crate) night_mode_audio: Option<String>,
    pub(crate) night_mode_return: Option<String>,
    pub(crate) night_mode_home_return: Option<String>,
    pub(crate) native_graph: Option<serde_json::Value>,
    pub(crate) options: CanonicalOptions,
    pub(crate) entries: Vec<CanonicalEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CanonicalOptions {
    pub(crate) convert_format: bool,
    pub(crate) add_silence: bool,
    pub(crate) auto_next: bool,
    pub(crate) select_next: bool,
    pub(crate) night_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "kind")]
pub(crate) enum CanonicalEntry {
    Menu(CanonicalMenu),
    Story(CanonicalStory),
    Zip(CanonicalZip),
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CanonicalMenu {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    pub(crate) auto_black_image: bool,
    pub(crate) wheel: bool,
    pub(crate) ok: bool,
    pub(crate) home: bool,
    pub(crate) autoplay: bool,
    pub(crate) pause: bool,
    pub(crate) return_after_play: Option<String>,
    pub(crate) return_on_home: Option<String>,
    pub(crate) audio_processing: HashMap<String, AudioFieldProcessing>,
    pub(crate) children: Vec<CanonicalEntry>,
}

impl Default for CanonicalMenu {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            audio: None,
            image: None,
            auto_black_image: false,
            wheel: true,
            ok: true,
            home: true,
            autoplay: false,
            pause: false,
            return_after_play: None,
            return_on_home: None,
            audio_processing: HashMap::new(),
            children: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CanonicalStory {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    pub(crate) item_audio: Option<String>,
    pub(crate) item_image: Option<String>,
    pub(crate) after_playback_prompt_audio: Option<String>,
    pub(crate) after_playback_prompt_control_settings: Option<EntryControlSettings>,
    pub(crate) after_playback_prompt_ok_target: Option<String>,
    pub(crate) after_playback_prompt_home_target: Option<String>,
    pub(crate) after_playback_prompt_home_none: bool,
    pub(crate) after_playback_sequence: Vec<CanonicalAfterPlaybackStep>,
    pub(crate) after_playback_home_step: Option<CanonicalAfterPlaybackStep>,
    pub(crate) autoplay: bool,
    pub(crate) pause: bool,
    pub(crate) wheel: bool,
    pub(crate) ok: bool,
    pub(crate) home: bool,
    pub(crate) return_after_play: Option<String>,
    pub(crate) return_on_home: Option<String>,
    pub(crate) return_on_home_none: bool,
    pub(crate) title_return_on_home: Option<String>,
    pub(crate) title_return_on_home_none: bool,
    pub(crate) title_control_settings: Option<EntryControlSettings>,
    pub(crate) audio_processing: HashMap<String, AudioFieldProcessing>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CanonicalAfterPlaybackStep {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    pub(crate) control_settings: Option<EntryControlSettings>,
    pub(crate) ok_target: Option<String>,
    pub(crate) ok_choice_targets: Vec<String>,
    pub(crate) home_target: Option<String>,
    pub(crate) home_follows_ok: bool,
    pub(crate) home_none: bool,
}

impl Default for CanonicalStory {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            audio: None,
            item_audio: None,
            item_image: None,
            after_playback_prompt_audio: None,
            after_playback_prompt_control_settings: None,
            after_playback_prompt_ok_target: None,
            after_playback_prompt_home_target: None,
            after_playback_prompt_home_none: false,
            after_playback_sequence: Vec::new(),
            after_playback_home_step: None,
            autoplay: false,
            pause: true,
            wheel: false,
            ok: false,
            home: true,
            return_after_play: None,
            return_on_home: None,
            return_on_home_none: false,
            title_return_on_home: None,
            title_return_on_home_none: false,
            title_control_settings: None,
            audio_processing: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub(crate) struct CanonicalZip {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) zip_path: Option<String>,
}

enum NavigationTarget<'a> {
    Root,
    CurrentMenu,
    NextStory,
    Menu(&'a str),
    Story(&'a str),
    StoryPlay(&'a str),
    StoryHomeStep(&'a str),
}

fn decode_navigation_target(target: Option<&str>) -> Option<NavigationTarget<'_>> {
    let trimmed = target.map(str::trim).filter(|value| !value.is_empty())?;
    if trimmed == "root" {
        return Some(NavigationTarget::Root);
    }
    if trimmed == "current_menu" {
        return Some(NavigationTarget::CurrentMenu);
    }
    if trimmed == "next_story" {
        return Some(NavigationTarget::NextStory);
    }
    if let Some(story_id) = trimmed.strip_prefix("story:") {
        return Some(NavigationTarget::Story(story_id));
    }
    if let Some(story_id) = trimmed.strip_prefix("story_play:") {
        return Some(NavigationTarget::StoryPlay(story_id));
    }
    if let Some(story_id) = trimmed.strip_prefix("story_home_step:") {
        return Some(NavigationTarget::StoryHomeStep(story_id));
    }
    Some(NavigationTarget::Menu(
        trimmed.strip_prefix("menu:").unwrap_or(trimmed),
    ))
}

/// Trouve l'id de la prochaine histoire dans la liste d'enfants après `current_index`.
fn find_next_story_id(children: &[CanonicalEntry], current_index: usize) -> Option<&str> {
    children[(current_index + 1)..].iter().find_map(|e| {
        if let CanonicalEntry::Story(s) = e {
            Some(s.id.as_str())
        } else {
            None
        }
    })
}

/// Résout `next_story` en `story:<id>` si un sibling suivant existe, sinon laisse la valeur inchangée.
fn resolve_next_story_target(
    raw_target: Option<&str>,
    siblings: &[CanonicalEntry],
    current_index: usize,
) -> Option<String> {
    if raw_target == Some("next_story") {
        find_next_story_id(siblings, current_index).map(|id| format!("story:{}", id))
    } else {
        raw_target.map(str::to_string)
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct NativePackDryRun {
    pub(crate) project: CanonicalProject,
    pub(crate) stats: NativePackStats,
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct NativePackStats {
    pub(crate) root_entry_count: usize,
    pub(crate) menu_count: usize,
    pub(crate) story_count: usize,
    pub(crate) zip_count: usize,
    pub(crate) max_depth: usize,
}

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
pub(crate) struct NativeAssetStats {
    pub(crate) requested_asset_count: usize,
    pub(crate) unique_asset_count: usize,
    pub(crate) transformed_audio_count: usize,
    pub(crate) imported_zip_count: usize,
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

#[derive(Debug, Clone)]
enum AssetSourceKind {
    Audio,
    Image,
    Zip,
}

#[derive(Debug, Clone)]
struct AssetRequest {
    role: String,
    source_path: String,
    source_kind: AssetSourceKind,
    skip_silence: bool,
}

pub(crate) fn canonicalize_project(project: &Project) -> CanonicalProject {
    let project_type = project
        .project_type
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let mut entries = Vec::new();

    let root_entries = project_root_entries(project);
    if project_type == "simple" {
        if let Some(story) = root_entries
            .iter()
            .find(|entry| entry.entry_type == "story")
        {
            entries.push(canonicalize_project_entry(story));
        }
    } else {
        entries.extend(root_entries.iter().map(canonicalize_project_entry));
    }

    CanonicalProject {
        name: project.name.clone(),
        project_type,
        pack_version: project.pack_version,
        pack_description: project.pack_description.clone(),
        root_audio: project.root_audio.clone(),
        root_image: project.root_image.clone(),
        thumbnail_image: project.thumbnail_image.clone(),
        night_mode_audio: project.night_mode_audio.clone(),
        night_mode_return: project.night_mode_return.clone(),
        night_mode_home_return: project.night_mode_home_return.clone(),
        native_graph: project.native_graph.clone(),
        options: canonicalize_options(&project.global_options),
        entries,
    }
}

pub(crate) fn dry_run_native_generation(
    project: &Project,
    emit: &dyn Fn(&str),
) -> Result<String, String> {
    let canonical = canonicalize_project(project);
    let stats = collect_stats(&canonical.entries);
    let notes = build_notes(project, &stats);

    emit("🧪 Dry run moteur natif");
    emit(&format!(
        "  Projet : {}",
        if canonical.name.trim().is_empty() {
            "(sans nom)"
        } else {
            canonical.name.as_str()
        }
    ));
    emit(&format!("  Type : {}", canonical.project_type));
    emit(&format!(
        "  Entrees racine : {} | menus : {} | histoires : {} | zips : {}",
        stats.root_entry_count, stats.menu_count, stats.story_count, stats.zip_count
    ));
    emit(&format!(
        "  Profondeur maximale actuelle : {}",
        stats.max_depth
    ));
    emit("  Aucun ZIP n'est genere dans ce dry run.");
    for note in &notes {
        emit(&format!("  • {}", note));
    }

    let report = NativePackDryRun {
        project: canonical,
        stats,
        notes,
    };

    serde_json::to_string_pretty(&report)
        .map_err(|e| format!("Impossible de serialiser le dry run natif : {}", e))
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

pub(crate) fn prepare_native_pack_assets_report(
    project: &Project,
    emit: &dyn Fn(&str),
) -> Result<NativeAssetPreparationReport, String> {
    let canonical = canonicalize_project(project);
    let requests = collect_asset_requests(&canonical, &project.audio_processing);
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

    emit("🧪 Preparation assets moteur natif");
    emit(&format!("  Stage dir : {}", stage_dir.to_string_lossy()));

    for request in requests {
        match request.source_kind {
            AssetSourceKind::Zip => {
                let zip_path = ensure_studio_pack_zip(&request.source_path)?
                    .to_string_lossy()
                    .to_string();
                emit(&format!("  📦 ZIP fusion natif : {}", request.role));
                let (bundle, mut zip_assets) = stage_imported_zip_bundle(
                    &request.role,
                    &zip_path,
                    &assets_dir,
                    &mut seen_assets,
                )?;
                for asset in &zip_assets {
                    emit_asset_result(asset, emit);
                }
                prepared_assets.append(&mut zip_assets);
                imported_zips.push(bundle);
            }
            AssetSourceKind::Image => {
                let raw = fs::read(&request.source_path)
                    .map_err(|e| format!("Lecture image '{}' : {}", request.role, e))?;
                let prepared = match ensure_image_320x240(&raw, &request.role)? {
                    None => stage_binary_asset(
                        &request.role,
                        &request.source_path,
                        "image",
                        &assets_dir,
                        &mut seen_assets,
                        false,
                    )?,
                    Some(png_bytes) => {
                        emit(&format!("  [resize] {} -> 320x240", request.role));
                        stage_binary_asset_bytes(
                            &request.role,
                            "resized.png",
                            &png_bytes,
                            &assets_dir,
                            &mut seen_assets,
                        )?
                    }
                };
                emit_asset_result(&prepared, emit);
                prepared_assets.push(prepared);
            }
            AssetSourceKind::Audio => {
                let needs_processing = audio_needs_processing(
                    &request.source_path,
                    &canonical.options,
                    request.skip_silence,
                );
                let prepared_source = if needs_processing {
                    transformed_audio_count += 1;
                    let ffmpeg = ffmpeg.as_ref().ok_or_else(|| {
                        "ffmpeg requis pour la preparation audio native mais introuvable."
                            .to_string()
                    })?;
                    process_audio_asset(
                        &request.source_path,
                        ffmpeg,
                        &processed_audio_dir,
                        &canonical.options,
                        request.skip_silence,
                        &request.role,
                    )?
                } else {
                    validate_existing_file_path(&request.source_path, &request.role)?
                };
                let prepared = stage_binary_asset(
                    &request.role,
                    &prepared_source.to_string_lossy(),
                    "audio",
                    &assets_dir,
                    &mut seen_assets,
                    needs_processing,
                )?;
                emit_asset_result(&prepared, emit);
                prepared_assets.push(prepared);
            }
        }
    }

    let stats = NativeAssetStats {
        requested_asset_count: prepared_assets.len(),
        unique_asset_count: seen_assets.len(),
        transformed_audio_count,
        imported_zip_count: imported_zips.len(),
    };

    let notes = build_asset_notes(&canonical.options, &stats);

    emit(&format!(
        "  Assets uniques : {} | audios transformes : {} | zips importes : {}",
        stats.unique_asset_count,
        stats.transformed_audio_count,
        stats.imported_zip_count,
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

fn canonicalize_options(options: &GlobalOptions) -> CanonicalOptions {
    CanonicalOptions {
        convert_format: options.convert_format,
        add_silence: options.add_silence,
        auto_next: options.auto_next,
        select_next: options.select_next,
        night_mode: options.night_mode,
    }
}

fn canonicalize_after_playback_step(
    step: &AfterPlaybackSequenceStep,
) -> CanonicalAfterPlaybackStep {
    CanonicalAfterPlaybackStep {
        id: step.id.clone(),
        name: step.name.clone(),
        audio: step.audio.clone(),
        image: step.image.clone(),
        control_settings: step.control_settings.clone(),
        ok_target: step.ok_target.clone(),
        ok_choice_targets: step.ok_choice_targets.clone(),
        home_target: step.home_target.clone(),
        home_follows_ok: step.home_follows_ok,
        home_none: step.home_none,
    }
}

fn canonicalize_project_entry(entry: &ProjectEntry) -> CanonicalEntry {
    match entry.entry_type.as_str() {
        "menu" => CanonicalEntry::Menu(CanonicalMenu {
            id: entry.id.clone(),
            name: entry.name.clone(),
            audio: entry.audio.clone(),
            image: entry.image.clone(),
            auto_black_image: entry.auto_black_image,
            wheel: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.wheel)
                .unwrap_or(true),
            ok: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.ok)
                .unwrap_or(true),
            home: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.home)
                .unwrap_or(true),
            autoplay: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.autoplay)
                .unwrap_or(false),
            pause: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.pause)
                .unwrap_or(false),
            return_after_play: entry.return_after_play.clone(),
            return_on_home: entry.return_on_home.clone(),
            audio_processing: entry.audio_processing.clone(),
            children: entry
                .children
                .iter()
                .map(canonicalize_project_entry)
                .collect(),
        }),
        "zip" => CanonicalEntry::Zip(CanonicalZip {
            id: entry.id.clone(),
            name: entry.name.clone(),
            zip_path: entry.zip_path.clone(),
        }),
        _ => CanonicalEntry::Story(CanonicalStory {
            id: entry.id.clone(),
            name: entry.name.clone(),
            audio: entry.audio.clone(),
            item_audio: entry.item_audio.clone(),
            item_image: entry.item_image.clone(),
            after_playback_prompt_audio: entry.after_playback_prompt_audio.clone(),
            after_playback_prompt_control_settings: entry
                .after_playback_prompt_control_settings
                .clone(),
            after_playback_prompt_ok_target: entry.after_playback_prompt_ok_target.clone(),
            after_playback_prompt_home_target: entry.after_playback_prompt_home_target.clone(),
            after_playback_prompt_home_none: entry.after_playback_prompt_home_none,
            after_playback_sequence: entry
                .after_playback_sequence
                .iter()
                .map(canonicalize_after_playback_step)
                .collect(),
            after_playback_home_step: entry
                .after_playback_home_step
                .as_ref()
                .map(canonicalize_after_playback_step),
            autoplay: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.autoplay)
                .unwrap_or(false),
            pause: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.pause)
                .unwrap_or(true),
            wheel: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.wheel)
                .unwrap_or(false),
            ok: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.ok)
                .unwrap_or(false),
            home: entry
                .control_settings
                .as_ref()
                .and_then(|c| c.home)
                .unwrap_or(true),
            return_after_play: entry.return_after_play.clone(),
            return_on_home: entry.return_on_home.clone(),
            return_on_home_none: entry.return_on_home_none,
            title_return_on_home: entry.title_return_on_home.clone(),
            title_return_on_home_none: entry.title_return_on_home_none,
            title_control_settings: entry.title_control_settings.clone(),
            audio_processing: entry.audio_processing.clone(),
        }),
    }
}

fn collect_asset_requests(
    project: &CanonicalProject,
    root_audio_processing: &HashMap<String, AudioFieldProcessing>,
) -> Vec<AssetRequest> {
    let mut requests = Vec::new();

    if let Some(path) = project.root_audio.as_ref() {
        requests.push(audio_request_with_processing(
            "rootAudio",
            path,
            skip_silence_for(root_audio_processing, "rootAudio"),
        ));
    }
    if let Some(path) = project.root_image.as_ref() {
        requests.push(image_request("rootImage", path));
    }
    if let Some(path) = project.thumbnail_image.as_ref() {
        requests.push(image_request("thumbnailImage", path));
    }
    if let Some(path) = project.night_mode_audio.as_ref() {
        requests.push(audio_request_with_processing(
            "nightModeAudio",
            path,
            skip_silence_for(root_audio_processing, "nightModeAudio"),
        ));
    }

    for entry in &project.entries {
        collect_entry_requests(entry, "root", &mut requests);
    }
    collect_native_graph_requests(project.native_graph.as_ref(), &mut requests);

    requests
}

fn native_graph_asset_role(stage_id: &str, field: &str) -> String {
    format!("nativeGraph/{}/{}", sanitize_stage_label(stage_id), field)
}

fn native_graph_stage_uuid(stage: &serde_json::Value) -> Option<&str> {
    stage
        .get("uuid")
        .or_else(|| stage.get("id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

fn active_native_graph(native_graph: Option<&serde_json::Value>) -> Option<&serde_json::Value> {
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

fn collect_entry_requests(entry: &CanonicalEntry, prefix: &str, requests: &mut Vec<AssetRequest>) {
    match entry {
        CanonicalEntry::Menu(menu) => {
            let label = scoped_label_id(prefix, &menu.id, &menu.name);
            if let Some(path) = menu.audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/menuAudio", label),
                    path,
                    skip_silence_for(&menu.audio_processing, "audio"),
                ));
            }
            if let Some(path) = menu.image.as_ref() {
                requests.push(image_request(&format!("{}/menuImage", label), path));
            }
            for child in &menu.children {
                collect_entry_requests(child, &label, requests);
            }
        }
        CanonicalEntry::Story(story) => {
            let label = scoped_label_id(prefix, &story.id, &story.name);
            if let Some(path) = story.audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/storyAudio", label),
                    path,
                    skip_silence_for(&story.audio_processing, "audio"),
                ));
            }
            if let Some(path) = story.item_audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/itemAudio", label),
                    path,
                    skip_silence_for(&story.audio_processing, "itemAudio"),
                ));
            }
            if let Some(path) = story.after_playback_prompt_audio.as_ref() {
                requests.push(audio_request_with_processing(
                    &format!("{}/afterPlaybackPromptAudio", label),
                    path,
                    skip_silence_for(&story.audio_processing, "afterPlaybackPromptAudio"),
                ));
            }
            for (index, step) in story.after_playback_sequence.iter().enumerate() {
                if let Some(path) = step.audio.as_ref() {
                    requests.push(audio_request_with_processing(
                        &format!("{}/afterPlaybackSequence/{}/audio", label, index),
                        path,
                        false,
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
                        false,
                    ));
                }
                if let Some(path) = step.image.as_ref() {
                    requests.push(image_request(
                        &format!("{}/afterPlaybackHomeStep/image", label),
                        path,
                    ));
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

fn collect_stats(entries: &[CanonicalEntry]) -> NativePackStats {
    let mut stats = NativePackStats {
        root_entry_count: entries.len(),
        menu_count: 0,
        story_count: 0,
        zip_count: 0,
        max_depth: if entries.is_empty() { 0 } else { 1 },
    };

    for entry in entries {
        walk_entry(entry, 1, &mut stats);
    }

    stats
}

fn walk_entry(entry: &CanonicalEntry, depth: usize, stats: &mut NativePackStats) {
    stats.max_depth = stats.max_depth.max(depth);
    match entry {
        CanonicalEntry::Menu(menu) => {
            stats.menu_count += 1;
            for child in &menu.children {
                walk_entry(child, depth + 1, stats);
            }
        }
        CanonicalEntry::Story(_) => stats.story_count += 1,
        CanonicalEntry::Zip(_) => stats.zip_count += 1,
    }
}

fn build_notes(project: &Project, stats: &NativePackStats) -> Vec<String> {
    let mut notes = Vec::new();
    notes.push(
        "Le moteur natif pilote maintenant la voie principale d'export, mode nuit compris."
            .to_string(),
    );
    notes.push(
        "Ce dry run sert a visualiser le modele canonique et les cas encore a affiner.".to_string(),
    );

    if project.project_type.as_deref() == Some("simple") {
        notes.push(
            "Le mode simple est projete comme une histoire unique au niveau racine.".to_string(),
        );
    }
    if stats.zip_count > 0 {
        notes.push("La fusion native des ZIPs importes restera un lot distinct.".to_string());
    }
    if project.global_options.night_mode {
        notes.push(
            "Le mode nuit ajoute un palier audio entre la fin d'histoire et le choix suivant."
                .to_string(),
        );
    }
    if stats.max_depth < 2 {
        notes.push("Le modele canonique est deja pret a accueillir une recursion plus profonde que l'UI actuelle.".to_string());
    } else {
        notes.push("La recursion UI reste a faire, mais le modele backend n'est plus limite a la structure SPG temporaire.".to_string());
    }

    notes
}

fn build_asset_notes(options: &CanonicalOptions, stats: &NativeAssetStats) -> Vec<String> {
    let mut notes = Vec::new();
    notes.push("Le pipeline assets natif prepare deja les medias hors SPG.".to_string());
    if options.convert_format {
        notes.push("Les audios sont reencodes en mp3 44.1 kHz mono quand necessaire.".to_string());
    } else {
        notes.push("La conversion audio globale est desactivee : les fichiers compatibles sont conserves tels quels.".to_string());
    }
    if options.add_silence {
        notes.push("Le silence debut/fin est ajoute pendant la preparation native.".to_string());
    }
    if stats.imported_zip_count > 0 {
        notes.push("Les ZIPs importes sont prepares pour fusion native sans SPG.".to_string());
    }
    if stats.unique_asset_count < stats.requested_asset_count {
        notes.push(
            "La deduplication de contenu fonctionne deja au niveau des assets prepares."
                .to_string(),
        );
    }
    notes
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoryDocument {
    title: String,
    version: i32,
    description: String,
    format: String,
    #[serde(rename = "nightModeAvailable")]
    night_mode_available: bool,
    #[serde(rename = "actionNodes")]
    action_nodes: Vec<ActionNode>,
    #[serde(rename = "stageNodes")]
    stage_nodes: Vec<StageNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActionNode {
    id: String,
    name: String,
    options: Vec<String>,
    #[serde(default = "zero_position")]
    position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StageNode {
    uuid: String,
    name: String,
    #[serde(rename = "type")]
    stage_type: String,
    #[serde(rename = "squareOne", default)]
    square_one: bool,
    audio: Option<String>,
    image: Option<String>,
    #[serde(rename = "controlSettings")]
    control_settings: ControlSettings,
    #[serde(rename = "homeTransition")]
    home_transition: Option<Transition>,
    #[serde(rename = "okTransition")]
    ok_transition: Option<Transition>,
    #[serde(default = "zero_position")]
    position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ControlSettings {
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Transition {
    #[serde(rename = "actionNode")]
    action_node: String,
    #[serde(rename = "optionIndex")]
    option_index: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Position {
    x: Number,
    y: Number,
}

pub(crate) fn generate_native_pack_v1(
    project: &Project,
    output_folder: &str,
    emit: &dyn Fn(&str),
) -> Result<String, String> {
    let asset_report = prepare_native_pack_assets_report(project, emit)?;

    let result = (|| {
        let story = build_story_document(&asset_report)?;
        let zip_path =
            write_native_pack_zip(&asset_report, &story, &PathBuf::from(output_folder))?;
        emit(&format!(
            "✅ ZIP natif v1 genere : {}",
            zip_path.to_string_lossy()
        ));
        Ok(zip_path.to_string_lossy().to_string())
    })();

    let _ = fs::remove_dir_all(&asset_report.stage_dir);
    result
}

fn write_native_pack_zip(
    asset_report: &NativeAssetPreparationReport,
    story: &StoryDocument,
    output_dir: &Path,
) -> Result<PathBuf, String> {
    let story_json = serde_json::to_string_pretty(story)
        .map_err(|e| format!("Impossible de serialiser story.json natif : {}", e))?;

    fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
    let zip_path = export_zip_path(output_dir, &asset_report.project.name);

    let out_file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut out_zip = zip::ZipWriter::new(out_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    out_zip
        .start_file("story.json", opts)
        .map_err(|e| e.to_string())?;
    out_zip
        .write_all(story_json.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut written_assets = HashSet::new();
    for asset in &asset_report.assets {
        if !written_assets.insert(asset.staged_asset_name.clone()) {
            continue;
        }
        let asset_bytes = fs::read(&asset.staged_asset_path).map_err(|e| {
            format!(
                "Lecture asset stage impossible {} : {}",
                asset.staged_asset_name, e
            )
        })?;
        let zip_asset_name = format!("assets/{}", asset.staged_asset_name);
        out_zip
            .start_file(&zip_asset_name, opts)
            .map_err(|e| e.to_string())?;
        out_zip.write_all(&asset_bytes).map_err(|e| e.to_string())?;
    }

    if let Some(thumbnail_source) = thumbnail_source_path(&asset_report.project) {
        let thumbnail = validate_existing_file_path(&thumbnail_source, "Thumbnail source")?;
        let ext = file_ext(thumbnail.to_string_lossy().as_ref()).to_ascii_lowercase();
        let thumbnail_name = format!("thumbnail.{}", ext);
        let bytes =
            fs::read(&thumbnail).map_err(|e| format!("Lecture thumbnail impossible : {}", e))?;
        out_zip
            .start_file(&thumbnail_name, opts)
            .map_err(|e| e.to_string())?;
        out_zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    out_zip.finish().map_err(|e| e.to_string())?;
    Ok(zip_path)
}

fn build_story_document(report: &NativeAssetPreparationReport) -> Result<StoryDocument, String> {
    if active_native_graph(report.project.native_graph.as_ref()).is_some() {
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
    document.night_mode_available = report.project.options.night_mode;

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

fn stage_imported_zip_bundle(
    role: &str,
    zip_path: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
) -> Result<(ImportedZipBundle, Vec<PreparedAsset>), String> {
    let zip_path_buf = ensure_studio_pack_zip(zip_path)?;
    let zip_file =
        fs::File::open(&zip_path_buf).map_err(|e| format!("Ouverture ZIP impossible : {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let mut story_json = String::new();
    archive
        .by_name("story.json")
        .map_err(|_| format!("story.json introuvable dans {}", zip_path_buf.display()))?
        .read_to_string(&mut story_json)
        .map_err(|e| format!("Lecture story.json impossible : {}", e))?;

    let mut document: StoryDocument = serde_json::from_str(&story_json)
        .map_err(|e| format!("story.json import invalide : {}", e))?;

    let square_one_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .ok_or_else(|| format!("ZIP importe sans squareOne : {}", zip_path_buf.display()))?;
    let square_one_stage_id = square_one_stage.uuid.clone();
    let root_action_id = square_one_stage
        .ok_transition
        .as_ref()
        .map(|transition| transition.action_node.clone())
        .ok_or_else(|| {
            format!(
                "ZIP importe sans action racine : {}",
                zip_path_buf.display()
            )
        })?;
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.id == root_action_id)
        .ok_or_else(|| format!("Action racine introuvable dans {}", zip_path_buf.display()))?;
    let post_root_stage_id = root_action
        .options
        .first()
        .cloned()
        .ok_or_else(|| format!("Action racine vide dans {}", zip_path_buf.display()))?;
    let entry_stage_id = square_one_stage_id.clone();

    let mut prepared_assets = Vec::new();
    let mut asset_map = HashMap::new();
    let referenced_assets = referenced_asset_names(&document);
    for asset_name in referenced_assets {
        let mut zip_entry = archive
            .by_name(&format!("assets/{}", asset_name))
            .map_err(|_| format!("Asset importe introuvable : {}", asset_name))?;
        let mut bytes = Vec::new();
        zip_entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Lecture asset importe impossible {} : {}", asset_name, e))?;

        let prepared = stage_binary_asset_bytes(
            &format!("{} / imported {}", role, asset_name),
            &asset_name,
            &bytes,
            assets_dir,
            seen_assets,
        )?;
        asset_map.insert(asset_name, prepared.staged_asset_name.clone());
        prepared_assets.push(prepared);
    }

    for stage in &mut document.stage_nodes {
        if let Some(audio) = stage.audio.as_mut() {
            if let Some(mapped_audio) = asset_map.get(audio) {
                *audio = mapped_audio.clone();
            }
        }
        if let Some(image) = stage.image.as_mut() {
            if let Some(mapped_image) = asset_map.get(image) {
                *image = mapped_image.clone();
            }
        }
    }

    Ok((
        ImportedZipBundle {
            role: role.to_string(),
            zip_path: zip_path_buf.to_string_lossy().to_string(),
            square_one_stage_id,
            root_action_id,
            post_root_stage_id,
            entry_stage_id,
            document,
        },
        prepared_assets,
    ))
}

fn referenced_asset_names(document: &StoryDocument) -> Vec<String> {
    let mut assets = Vec::new();
    for stage in &document.stage_nodes {
        if let Some(audio) = &stage.audio {
            assets.push(audio.clone());
        }
        if let Some(image) = &stage.image {
            assets.push(image.clone());
        }
    }
    assets.sort();
    assets.dedup();
    assets
}

fn ensure_image_320x240(bytes: &[u8], role: &str) -> Result<Option<Vec<u8>>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Image illisible pour '{}' : {}", role, e))?;
    if img.width() == 320 && img.height() == 240 {
        return Ok(None);
    }
    let resized = img.resize_exact(320, 240, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Encodage 320x240 pour '{}' : {}", role, e))?;
    Ok(Some(out))
}

fn stage_binary_asset(
    role: &str,
    source_path: &str,
    source_kind: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
    transformed: bool,
) -> Result<PreparedAsset, String> {
    let source = validate_existing_file_path(source_path, role)?;
    let bytes =
        fs::read(&source).map_err(|e| format!("Lecture impossible pour {} : {}", role, e))?;
    let extension = file_ext(source.to_string_lossy().as_ref()).to_ascii_lowercase();
    let asset_name = hashed_asset_name(&bytes, &extension);
    let staged_path = assets_dir.join(&asset_name);
    let deduplicated = seen_assets.contains_key(&asset_name);
    if !deduplicated {
        fs::write(&staged_path, &bytes).map_err(|e| {
            format!(
                "Impossible d'ecrire l'asset prepare {} : {}",
                staged_path.display(),
                e
            )
        })?;
        seen_assets.insert(asset_name.clone(), staged_path.clone());
    }

    Ok(PreparedAsset {
        role: role.to_string(),
        source_path: source.to_string_lossy().to_string(),
        source_kind: source_kind.to_string(),
        staged_asset_name: asset_name,
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed,
        deduplicated,
    })
}

fn stage_binary_asset_bytes(
    role: &str,
    original_name: &str,
    bytes: &[u8],
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
) -> Result<PreparedAsset, String> {
    let extension = file_ext(original_name).to_ascii_lowercase();
    if extension.is_empty() {
        return Err(format!(
            "Extension introuvable pour l'asset importe {}",
            original_name
        ));
    }
    let asset_name = hashed_asset_name(bytes, &extension);
    let staged_path = assets_dir.join(&asset_name);
    let deduplicated = seen_assets.contains_key(&asset_name);
    if !deduplicated {
        fs::write(&staged_path, bytes).map_err(|e| {
            format!(
                "Impossible d'ecrire l'asset importe {} : {}",
                staged_path.display(),
                e
            )
        })?;
        seen_assets.insert(asset_name.clone(), staged_path.clone());
    }

    let source_kind = if matches!(
        extension.as_str(),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "webm" | "flac"
    ) {
        "audio"
    } else {
        "image"
    };

    Ok(PreparedAsset {
        role: role.to_string(),
        source_path: format!("zip://{}", original_name),
        source_kind: source_kind.to_string(),
        staged_asset_name: asset_name,
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed: false,
        deduplicated,
    })
}

fn audio_needs_processing(
    source_path: &str,
    options: &CanonicalOptions,
    skip_silence: bool,
) -> bool {
    let ext = file_ext(source_path).to_ascii_lowercase();
    if options.add_silence && !skip_silence {
        return true;
    }
    if ext == "webm" {
        return true;
    }
    if !options.convert_format {
        return false;
    }
    if ext != "mp3" {
        return true;
    }

    !mp3_file_is_native_compatible(source_path).unwrap_or(false)
}

fn mp3_file_is_native_compatible(source_path: &str) -> Result<bool, String> {
    let mut file = fs::File::open(source_path)
        .map_err(|e| format!("Lecture header MP3 impossible pour {} : {}", source_path, e))?;
    let mut bytes = Vec::with_capacity(MP3_HEADER_SCAN_BYTES);
    std::io::Read::by_ref(&mut file)
        .take(MP3_HEADER_SCAN_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Lecture header MP3 impossible pour {} : {}", source_path, e))?;
    Ok(mp3_header_is_native_compatible(&bytes))
}

fn mp3_header_is_native_compatible(bytes: &[u8]) -> bool {
    let Some(offset) = find_mpeg_sync(bytes) else {
        return false;
    };
    if offset + 4 > bytes.len() {
        return false;
    }

    let h = &bytes[offset..offset + 4];
    let mpeg_version = (h[1] >> 3) & 0x03;
    let sample_rate_index = (h[2] >> 2) & 0x03;
    let channel_mode = (h[3] >> 6) & 0x03;

    mpeg_version == 3 && sample_rate_index == 0 && channel_mode == 3
}

fn find_mpeg_sync(bytes: &[u8]) -> Option<usize> {
    let start = if bytes.starts_with(b"ID3") && bytes.len() >= 10 {
        let size = ((bytes[6] as usize) << 21)
            | ((bytes[7] as usize) << 14)
            | ((bytes[8] as usize) << 7)
            | (bytes[9] as usize);
        10 + size
    } else {
        0
    };

    let search = bytes.get(start..)?;
    for i in 0..search.len().saturating_sub(1) {
        if search[i] == 0xFF && (search[i + 1] & 0xE0) == 0xE0 {
            return Some(start + i);
        }
    }
    None
}

fn process_audio_asset(
    source_path: &str,
    ffmpeg: &Path,
    processed_audio_dir: &Path,
    options: &CanonicalOptions,
    skip_silence: bool,
    role: &str,
) -> Result<PathBuf, String> {
    let source = validate_existing_file_path(source_path, role)?;
    let output_name = processed_audio_output_name(role);
    let output = processed_audio_dir.join(output_name);
    let filters = audio_filters(options, skip_silence);

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-i",
        source.to_string_lossy().as_ref(),
        "-ac",
        "1",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "5",
        "-map_metadata",
        "-1",
        "-id3v2_version",
        "0",
        "-map",
        "0:a",
        "-af",
        &filters,
        output.to_string_lossy().as_ref(),
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let output_result = cmd
        .output()
        .map_err(|e| format!("ffmpeg introuvable pour {} : {}", role, e))?;
    if !output_result.status.success() {
        let stderr = String::from_utf8_lossy(&output_result.stderr);
        let summary = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Erreur ffmpeg inconnue");
        return Err(format!(
            "Preparation audio native echouee pour {} : {}",
            role, summary
        ));
    }
    Ok(output)
}

fn audio_filters(options: &CanonicalOptions, skip_silence: bool) -> String {
    let mut filters = vec![
        "aformat=channel_layouts=mono".to_string(),
        "loudnorm=I=-12:TP=-1.5:LRA=11".to_string(),
    ];
    if options.add_silence && !skip_silence {
        // ffmpeg 4.2 (fourni avec SPG) ne supporte pas `adelay=...:all=1`.
        // On force donc d'abord un vrai mono, on normalise le contenu utile,
        // puis on applique le silence en dernier pour qu'il reste numeriquement
        // silencieux et ne perturbe pas la mesure loudnorm.
        filters.push("adelay=1000".to_string());
        filters.push("apad=pad_dur=1".to_string());
    }
    filters.join(",")
}

fn hashed_asset_name(bytes: &[u8], extension: &str) -> String {
    format!("{:x}.{}", Sha1::digest(bytes), extension)
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
) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Audio,
        skip_silence,
    }
}

fn skip_silence_for(processing: &HashMap<String, AudioFieldProcessing>, field: &str) -> bool {
    processing
        .get(field)
        .map(|value| value.skip_silence)
        .unwrap_or(false)
}

fn image_request(role: &str, source_path: &str) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Image,
        skip_silence: false,
    }
}

fn zip_request(role: &str, source_path: &str) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Zip,
        skip_silence: false,
    }
}

// Appends a short id suffix to prevent role collisions
// when sibling entries share the same display name (e.g. all named "Stage title"
// after importing a Lunii official pack). Falls back to name-only when id is empty
// (unit tests construct entries without ids).
fn scoped_label_id(prefix: &str, id: &str, name: &str) -> String {
    let trimmed = name.trim();
    let label = if trimmed.is_empty() {
        "(sans nom)"
    } else {
        trimmed
    };
    if id.is_empty() {
        format!("{}/{}", prefix, label)
    } else {
        format!("{}/{}#{}", prefix, label, &id[..8.min(id.len())])
    }
}

fn sanitize_stage_label(label: &str) -> String {
    let sanitized: String = label
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            _ => c,
        })
        .collect();
    sanitized.trim_matches('_').to_string()
}

fn processed_audio_output_name(role: &str) -> String {
    let sanitized = sanitize_stage_label(role);
    let prefix: String = sanitized.chars().take(48).collect();
    let prefix = if prefix.is_empty() {
        "audio".to_string()
    } else {
        prefix
    };
    format!(
        "{}_{:x}_{}.mp3",
        prefix,
        Sha1::digest(role.as_bytes()),
        now_millis()
    )
}

struct MenuPrealloc {
    action_id: String,
    replay_transition: Transition,
}

fn preallocate_menus(
    entries: &[CanonicalEntry],
    parent_action_id: &str,
    result: &mut std::collections::HashMap<String, MenuPrealloc>,
) {
    for (index, entry) in entries.iter().enumerate() {
        if let CanonicalEntry::Menu(menu) = entry {
            let action_id = Uuid::new_v4().to_string();
            if !menu.id.is_empty() {
                result.insert(
                    menu.id.clone(),
                    MenuPrealloc {
                        action_id: action_id.clone(),
                        replay_transition: Transition {
                            action_node: parent_action_id.to_string(),
                            option_index: index as i32,
                        },
                    },
                );
            }
            preallocate_menus(&menu.children, &action_id, result);
        }
    }
}

struct StoryPrealloc {
    play_stage_id: String,
    play_action_id: String,
    home_step_stage_id: Option<String>,
    home_step_action_id: Option<String>,
    // Set during build_menu_branch pre-pass; used by returnAfterPlay "story:id"
    // to land on the title screen (not directly on the play stage).
    approach_transition: Option<Transition>,
}

fn preallocate_story_play_stages(
    entries: &[CanonicalEntry],
    result: &mut std::collections::HashMap<String, StoryPrealloc>,
) {
    for entry in entries {
        match entry {
            CanonicalEntry::Story(story) if !story.id.is_empty() => {
                result.insert(
                    story.id.clone(),
                    StoryPrealloc {
                        play_stage_id: Uuid::new_v4().to_string(),
                        play_action_id: Uuid::new_v4().to_string(),
                        home_step_stage_id: (story.after_playback_home_step.is_some()
                            && story.after_playback_sequence.len() > 1)
                            .then(|| Uuid::new_v4().to_string()),
                        home_step_action_id: (story.after_playback_home_step.is_some()
                            && story.after_playback_sequence.len() > 1)
                            .then(|| Uuid::new_v4().to_string()),
                        approach_transition: None,
                    },
                );
            }
            CanonicalEntry::Menu(menu) => {
                preallocate_story_play_stages(&menu.children, result);
            }
            _ => {}
        }
    }
}

fn preallocate_story_approach_transitions(
    entries: &[CanonicalEntry],
    parent_action_id: &str,
    menu_preallocs: &std::collections::HashMap<String, MenuPrealloc>,
    story_preallocs: &mut std::collections::HashMap<String, StoryPrealloc>,
) {
    for (index, entry) in entries.iter().enumerate() {
        match entry {
            CanonicalEntry::Story(story) if !story.id.is_empty() => {
                if let Some(prealloc) = story_preallocs.get_mut(&story.id) {
                    prealloc.approach_transition = Some(transition(parent_action_id, index as i32));
                }
            }
            CanonicalEntry::Menu(menu) => {
                if let Some(prealloc) = menu_preallocs.get(&menu.id) {
                    preallocate_story_approach_transitions(
                        &menu.children,
                        &prealloc.action_id,
                        menu_preallocs,
                        story_preallocs,
                    );
                }
            }
            _ => {}
        }
    }
}

struct AfterPlaybackSequenceTransitions {
    ok: Transition,
    home: Option<Transition>,
}

struct StoryBuilder<'a> {
    report: &'a NativeAssetPreparationReport,
    action_nodes: Vec<ActionNode>,
    stage_nodes: Vec<StageNode>,
    root_action_id: Option<String>,
    night_bridge_cache: std::collections::HashMap<String, Transition>,
    menu_prealloc: std::collections::HashMap<String, MenuPrealloc>,
    story_prealloc: std::collections::HashMap<String, StoryPrealloc>,
}

impl<'a> StoryBuilder<'a> {
    fn new(report: &'a NativeAssetPreparationReport) -> Self {
        Self {
            report,
            action_nodes: Vec::new(),
            stage_nodes: Vec::new(),
            root_action_id: None,
            night_bridge_cache: std::collections::HashMap::new(),
            menu_prealloc: std::collections::HashMap::new(),
            story_prealloc: std::collections::HashMap::new(),
        }
    }

    fn build(&mut self) -> Result<StoryDocument, String> {
        let project = &self.report.project;
        let project_name = display_label(&project.name, "Story Studio");
        let cover_audio = self.asset_name("rootAudio")?;
        let cover_image = self.asset_name("rootImage")?;
        let cover_stage_id = self.next_id();
        let root_action_id = self.next_id();
        self.root_action_id = Some(root_action_id.clone());
        self.night_bridge_cache.clear();

        // Pré-alloue les action node IDs de tous les menus pour que returnAfterPlay
        // puisse référencer n'importe quel menu indépendamment de l'ordre de build.
        preallocate_menus(&project.entries, &root_action_id, &mut self.menu_prealloc);
        // Pré-alloue les play stage IDs de toutes les histoires pour les transitions story→story.
        preallocate_story_play_stages(&project.entries, &mut self.story_prealloc);
        preallocate_story_approach_transitions(
            &project.entries,
            &root_action_id,
            &self.menu_prealloc,
            &mut self.story_prealloc,
        );

        let root_targets = if project.project_type == "simple" {
            vec![self.build_simple_story(project, &root_action_id)?]
        } else {
            self.build_root_entries(&project.entries, &root_action_id)?
        };

        if root_targets.is_empty() {
            return Err("Aucune entree native construite pour le projet.".to_string());
        }

        self.action_nodes.push(ActionNode {
            id: root_action_id.clone(),
            name: action_node_name(),
            options: root_targets,
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: cover_stage_id,
            name: "Cover node".to_string(),
            stage_type: "stage".to_string(),
            square_one: true,
            audio: Some(cover_audio),
            image: Some(cover_image),
            control_settings: ControlSettings {
                wheel: true,
                ok: true,
                home: false,
                pause: false,
                autoplay: false,
            },
            home_transition: None,
            ok_transition: Some(Transition {
                action_node: root_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });

        let mut document = StoryDocument {
            title: project_name,
            version: project.pack_version,
            description: project.pack_description.clone(),
            format: "v1".to_string(),
            night_mode_available: project.options.night_mode,
            action_nodes: std::mem::take(&mut self.action_nodes),
            stage_nodes: std::mem::take(&mut self.stage_nodes),
        };
        normalize_document_for_studio_compat(&mut document);
        reorder_document_for_display(&mut document);
        validate_document_for_studio_compat(&document)?;
        Ok(document)
    }

    fn build_simple_story(
        &mut self,
        project: &CanonicalProject,
        _root_action_id: &str,
    ) -> Result<String, String> {
        let CanonicalEntry::Story(story) = project
            .entries
            .first()
            .ok_or_else(|| "Histoire simple introuvable dans le modele canonique.".to_string())?
        else {
            return Err("Le mode simple natif v1 n'accepte qu'une histoire audio.".to_string());
        };

        let role_prefix = scoped_label_id("root", &story.id, &story.name);
        let stage_id = self.next_id();
        let story_controls = if project.options.night_mode {
            playback_controls()
        } else {
            ControlSettings {
                wheel: story.wheel,
                ok: story.ok,
                home: story.home,
                pause: story.pause,
                autoplay: story.autoplay,
            }
        };
        let story_ok_transition = if project.night_mode_audio.is_some() {
            Some(self.build_night_bridge()?)
        } else {
            None
        };
        self.stage_nodes.push(StageNode {
            uuid: stage_id.clone(),
            name: "histoire".to_string(),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: Some(self.asset_name(&format!("{}/storyAudio", role_prefix))?),
            image: None,
            control_settings: story_controls,
            home_transition: None,
            ok_transition: story_ok_transition,
            position: zero_position(),
        });
        Ok(stage_id)
    }

    fn build_root_entries(
        &mut self,
        entries: &[CanonicalEntry],
        root_action_id: &str,
    ) -> Result<Vec<String>, String> {
        let root_has_multiple_entries = entries.len() > 1;
        (0..entries.len())
            .map(|index| {
                self.build_root_entry(
                    &entries[index],
                    index,
                    entries,
                    root_action_id,
                    root_has_multiple_entries,
                )
            })
            .collect()
    }

    fn build_root_entry(
        &mut self,
        entry: &CanonicalEntry,
        root_index: usize,
        siblings: &[CanonicalEntry],
        root_action_id: &str,
        root_has_multiple_entries: bool,
    ) -> Result<String, String> {
        match entry {
            CanonicalEntry::Story(story) => {
                let root_transition = transition(root_action_id, root_index as i32);
                let story_return = resolve_next_story_target(
                    story.return_after_play.as_deref(),
                    siblings,
                    root_index,
                );
                let play_return_transition = self.resolve_story_return_transition(
                    story_return.as_deref(),
                    root_transition.clone(),
                );
                let story_home = resolve_next_story_target(
                    story.return_on_home.as_deref(),
                    siblings,
                    root_index,
                );
                let play_home_transition = if story.return_on_home_none {
                    None
                } else {
                    Some(self.resolve_story_home_transition(
                        story_home.as_deref(),
                        play_return_transition.clone(),
                    ))
                };
                let (night_bridge_return, night_bridge_home) = self.compute_night_bridge_targets(
                    siblings,
                    root_index,
                    play_return_transition.clone(),
                );
                self.build_story_branch(
                    story,
                    &scoped_label_id("root", &story.id, &story.name),
                    None,
                    play_home_transition,
                    play_return_transition,
                    night_bridge_return,
                    night_bridge_home,
                    false,
                )
            }
            CanonicalEntry::Menu(menu) => self.build_menu_branch(
                menu,
                &scoped_label_id("root", &menu.id, &menu.name),
                transition(root_action_id, root_index as i32),
                None,
                root_has_multiple_entries,
            ),
            CanonicalEntry::Zip(zip) => self.build_imported_zip_branch(
                zip,
                &scoped_label_id("root", &zip.id, &zip.name),
                transition(root_action_id, root_index as i32),
                root_has_multiple_entries,
            ),
        }
    }

    fn resolve_story_return_transition(
        &self,
        target_menu_id: Option<&str>,
        fallback_transition: Transition,
    ) -> Transition {
        if let Some(target) = decode_navigation_target(target_menu_id) {
            return match target {
                NavigationTarget::Root => self
                    .root_action_id
                    .as_ref()
                    .map(|action_id| transition(action_id, 0))
                    .unwrap_or(fallback_transition),
                NavigationTarget::CurrentMenu | NavigationTarget::NextStory => fallback_transition,
                NavigationTarget::Menu(target_id) => self
                    .menu_prealloc
                    .get(target_id)
                    .map(|prealloc| prealloc.replay_transition.clone())
                    .unwrap_or(fallback_transition),
                NavigationTarget::Story(story_id) => self
                    .story_prealloc
                    .get(story_id)
                    .and_then(|prealloc| prealloc.approach_transition.clone())
                    .unwrap_or(fallback_transition),
                NavigationTarget::StoryPlay(story_id) => self
                    .story_prealloc
                    .get(story_id)
                    .map(|prealloc| transition(&prealloc.play_action_id, 0))
                    .unwrap_or(fallback_transition),
                NavigationTarget::StoryHomeStep(story_id) => self
                    .story_prealloc
                    .get(story_id)
                    .and_then(|prealloc| prealloc.home_step_action_id.as_deref())
                    .map(|action_id| transition(action_id, 0))
                    .unwrap_or(fallback_transition),
            };
        }

        fallback_transition
    }

    fn resolve_story_home_transition(
        &self,
        target_menu_id: Option<&str>,
        fallback_transition: Transition,
    ) -> Transition {
        // "story_play:X" on a home target means the reader navigated via the play stage.
        // Home should go back to the title/selection stage (approach), not directly to play.
        if let Some(t) = target_menu_id {
            if let Some(story_id) = t.strip_prefix("story_play:") {
                return self
                    .story_prealloc
                    .get(story_id)
                    .and_then(|p| p.approach_transition.clone())
                    .unwrap_or_else(|| {
                        self.resolve_story_return_transition(Some(t), fallback_transition.clone())
                    });
            }
        }
        self.resolve_story_return_transition(target_menu_id, fallback_transition)
    }

    fn transition_target_stage_id(&self, transition: &Transition) -> Option<String> {
        if transition.option_index < 0 {
            return None;
        }
        self.action_nodes
            .iter()
            .find(|action| action.id == transition.action_node)
            .and_then(|action| action.options.get(transition.option_index as usize))
            .cloned()
    }

    fn resolve_title_home_transition(
        &self,
        story: &CanonicalStory,
        siblings: &[CanonicalEntry],
        story_index: usize,
        fallback_transition: Transition,
    ) -> Option<Transition> {
        if story.title_return_on_home_none {
            return None;
        }

        if let Some(target) = story.title_return_on_home.as_deref() {
            let resolved = resolve_next_story_target(Some(target), siblings, story_index);
            return Some(
                self.resolve_story_home_transition(resolved.as_deref(), fallback_transition),
            );
        }

        Some(fallback_transition)
    }

    fn build_menu_branch(
        &mut self,
        menu: &CanonicalMenu,
        role_prefix: &str,
        menu_replay_transition: Transition,
        menu_home_transition: Option<Transition>,
        force_choice_node: bool,
    ) -> Result<String, String> {
        let menu_label = role_prefix.to_string();
        let menu_stage_id = self.next_id();
        // Utilise l'action ID pré-alloué si disponible (nécessaire pour returnAfterPlay cross-menu)
        let menu_action_id = self
            .menu_prealloc
            .get(&menu.id)
            .map(|p| p.action_id.clone())
            .unwrap_or_else(|| self.next_id());
        let mut option_stage_ids = Vec::new();
        let explicit_menu_home_transition = menu.return_on_home.as_deref().map(|target| {
            self.resolve_story_home_transition(Some(target), menu_replay_transition.clone())
        });
        let is_choice_node = explicit_menu_home_transition.is_some()
            || menu_home_transition.is_some()
            || force_choice_node;

        // Pre-pass: record approach_transition for each story so returnAfterPlay "story:id"
        // can navigate to the title screen (not directly to the play stage).
        for (idx, child) in menu.children.iter().enumerate() {
            if let CanonicalEntry::Story(s) = child {
                if let Some(prealloc) = self.story_prealloc.get_mut(&s.id) {
                    prealloc.approach_transition = Some(transition(&menu_action_id, idx as i32));
                }
            }
        }

        for (child_index, child) in menu.children.iter().enumerate() {
            match child {
                CanonicalEntry::Story(story) => {
                    let menu_return = resolve_next_story_target(
                        menu.return_after_play.as_deref(),
                        &menu.children,
                        child_index,
                    );
                    // Default return when neither menu nor story sets returnAfterPlay:
                    // go back to the menu stage (matching the UI's resolveReturnTarget fallback).
                    let fallback_transition = self.resolve_story_return_transition(
                        menu_return.as_deref(),
                        menu_replay_transition.clone(),
                    );
                    // auto_next: when globally active and no explicit per-story/per-menu override,
                    // the story goes directly to the next sibling's play stage instead of the menu.
                    let auto_next_active = self.report.project.options.auto_next
                        && story.return_after_play.is_none()
                        && menu.return_after_play.is_none();
                    let play_return_transition = if auto_next_active {
                        match find_next_story_id(&menu.children, child_index) {
                            Some(next_id) => self
                                .story_prealloc
                                .get(next_id)
                                .map(|p| transition(&p.play_action_id, 0))
                                .unwrap_or(fallback_transition),
                            None => fallback_transition,
                        }
                    } else {
                        let story_return = resolve_next_story_target(
                            story.return_after_play.as_deref(),
                            &menu.children,
                            child_index,
                        );
                        self.resolve_story_return_transition(
                            story_return.as_deref(),
                            fallback_transition,
                        )
                    };
                    let story_home = resolve_next_story_target(
                        story.return_on_home.as_deref(),
                        &menu.children,
                        child_index,
                    );
                    // When returnOnHome is not set but returnAfterPlay IS set,
                    // home goes to the parent menu so it differs from ok (which advances to next story).
                    // When auto_next is active and play_return_transition points to the next story,
                    // home must also stay on the menu — not inherit the next-story target.
                    let play_home_transition = if story.return_on_home_none {
                        None
                    } else {
                        Some(
                            if story.return_on_home.is_none() && story.return_after_play.is_some() {
                                self.resolve_story_home_transition(
                                    None,
                                    menu_replay_transition.clone(),
                                )
                            } else if auto_next_active && story.return_on_home.is_none() {
                                menu_replay_transition.clone()
                            } else {
                                self.resolve_story_home_transition(
                                    story_home.as_deref(),
                                    play_return_transition.clone(),
                                )
                            },
                        )
                    };
                    // Force autoplay for stories with no explicit controls in any menu context
                    // (not just nested menus) so they never hang after playback.
                    let effective_simple_leaf =
                        menu.return_after_play.is_none() && story.return_after_play.is_none();
                    let (night_bridge_return, night_bridge_home) = self
                        .compute_night_bridge_targets(
                            &menu.children,
                            child_index,
                            play_return_transition.clone(),
                        );
                    option_stage_ids.push(self.build_story_branch(
                        story,
                        &scoped_label_id(&menu_label, &story.id, &story.name),
                        self.resolve_title_home_transition(
                            story,
                            &menu.children,
                            child_index,
                            menu_replay_transition.clone(),
                        ),
                        play_home_transition,
                        play_return_transition,
                        night_bridge_return,
                        night_bridge_home,
                        effective_simple_leaf,
                    )?);
                }
                CanonicalEntry::Zip(_) => {
                    let zip = match child {
                        CanonicalEntry::Zip(zip) => zip,
                        _ => unreachable!(),
                    };
                    option_stage_ids.push(self.build_imported_zip_branch(
                        zip,
                        &scoped_label_id(&menu_label, &zip.id, &zip.name),
                        transition(&menu_action_id, child_index as i32),
                        true,
                    )?);
                }
                CanonicalEntry::Menu(submenu) => {
                    option_stage_ids.push(self.build_menu_branch(
                        submenu,
                        &scoped_label_id(&menu_label, &submenu.id, &submenu.name),
                        transition(&menu_action_id, child_index as i32),
                        Some(menu_replay_transition.clone()),
                        false,
                    )?);
                }
            }
        }

        if option_stage_ids.is_empty() {
            return Err(format!(
                "Le menu {} ne contient aucune histoire exploitable pour le generateur natif v1.",
                display_label(&menu.name, "Collection")
            ));
        }

        self.action_nodes.push(ActionNode {
            id: menu_action_id.clone(),
            name: action_node_name(),
            options: option_stage_ids,
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: menu_stage_id.clone(),
            name: display_label(&menu.name, "Menu"),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: menu
                .audio
                .as_ref()
                .map(|_| self.asset_name(&format!("{}/menuAudio", menu_label)))
                .transpose()?,
            image: if menu.auto_black_image {
                None
            } else {
                Some(self.asset_name(&format!("{}/menuImage", menu_label))?)
            },
            control_settings: ControlSettings {
                wheel: if is_choice_node { menu.wheel } else { false },
                ok: menu.ok,
                home: menu.home,
                pause: menu.pause,
                autoplay: if is_choice_node { menu.autoplay } else { true },
            },
            home_transition: explicit_menu_home_transition,
            ok_transition: Some(Transition {
                action_node: menu_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });
        Ok(menu_stage_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_story_branch(
        &mut self,
        story: &CanonicalStory,
        role_prefix: &str,
        title_home_transition: Option<Transition>,
        play_home_transition: Option<Transition>,
        play_return_transition: Transition,
        night_bridge_return: Transition,
        night_bridge_home: Option<Transition>,
        simple_leaf_playback: bool,
    ) -> Result<String, String> {
        let mut effective_play_home_transition = play_home_transition.clone();
        let title_stage_id = self.next_id();
        let prealloc = self.story_prealloc.get(&story.id);
        let play_stage_id = prealloc
            .map(|p| p.play_stage_id.clone())
            .unwrap_or_else(|| self.next_id());
        let play_action_id = prealloc
            .map(|p| p.play_action_id.clone())
            .unwrap_or_else(|| self.next_id());
        let base_story_name = display_label(&story.name, "Story");
        // force_autoplay ensures the firmware fires okTransition automatically.
        // Required when returnAfterPlay is set, and also when the story is inside a
        // nested menu with no explicit navigation controls — otherwise the audio loops.
        let force_autoplay = story
            .return_after_play
            .as_deref()
            .map(|r| !r.trim().is_empty())
            .unwrap_or(false)
            || self.report.project.night_mode_audio.is_some()
            || (simple_leaf_playback && !story.ok && !story.autoplay);
        let play_controls = ControlSettings {
            wheel: story.wheel,
            ok: story.ok,
            home: story.home,
            pause: story.pause,
            autoplay: force_autoplay || story.autoplay,
        };
        let play_ok_transition = if !story.after_playback_sequence.is_empty() {
            let sequence_transitions = self.build_after_playback_sequence(
                story,
                role_prefix,
                play_return_transition.clone(),
                play_home_transition
                    .clone()
                    .unwrap_or_else(|| play_return_transition.clone()),
            )?;
            if let Some(home_transition) = sequence_transitions.home {
                effective_play_home_transition = Some(home_transition);
            }
            Some(sequence_transitions.ok)
        } else if story.after_playback_prompt_audio.is_some() {
            let prompt_stage_id = self.next_id();
            let prompt_action_id = self.next_id();
            let prompt_ok_transition = self.resolve_story_return_transition(
                story.after_playback_prompt_ok_target.as_deref(),
                play_return_transition.clone(),
            );
            let prompt_home_transition = if story.after_playback_prompt_home_none {
                None
            } else {
                Some(self.resolve_story_home_transition(
                    story.after_playback_prompt_home_target.as_deref(),
                    prompt_ok_transition.clone(),
                ))
            };

            self.action_nodes.push(ActionNode {
                id: prompt_action_id.clone(),
                name: action_node_name(),
                options: vec![prompt_stage_id.clone()],
                position: zero_position(),
            });

            self.stage_nodes.push(StageNode {
                uuid: prompt_stage_id,
                name: format!("Fin - {}", base_story_name),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some(self.asset_name(&format!("{}/afterPlaybackPromptAudio", role_prefix))?),
                image: None,
                control_settings: prompt_controls_from_settings(
                    story.after_playback_prompt_control_settings.as_ref(),
                ),
                home_transition: prompt_home_transition,
                ok_transition: Some(prompt_ok_transition),
                position: zero_position(),
            });

            Some(transition(&prompt_action_id, 0))
        } else if self.report.project.night_mode_audio.is_some()
            && (!should_emit_combined_story_stage(story, true) || story.return_after_play.is_none())
        {
            Some(self.build_night_bridge_to(night_bridge_return.clone(), night_bridge_home.clone())?)
        } else if play_controls.ok || play_controls.autoplay {
            Some(play_return_transition.clone())
        } else {
            None
        };

        if should_emit_combined_story_stage(story, self.report.project.night_mode_audio.is_some()) {
            self.action_nodes.push(ActionNode {
                id: play_action_id,
                name: action_node_name(),
                options: vec![play_stage_id.clone()],
                position: zero_position(),
            });

            self.stage_nodes.push(StageNode {
                uuid: play_stage_id.clone(),
                name: base_story_name,
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some(self.asset_name(&format!("{}/storyAudio", role_prefix))?),
                image: story
                    .item_image
                    .as_ref()
                    .map(|_| self.asset_name(&format!("{}/itemImage", role_prefix)))
                    .transpose()?,
                control_settings: play_controls,
                home_transition: effective_play_home_transition,
                ok_transition: play_ok_transition,
                position: zero_position(),
            });

            return Ok(play_stage_id);
        }

        self.action_nodes.push(ActionNode {
            id: play_action_id.clone(),
            name: action_node_name(),
            options: vec![play_stage_id.clone()],
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: title_stage_id.clone(),
            name: format!("Titre - {}", base_story_name),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: story
                .item_audio
                .as_ref()
                .map(|_| self.asset_name(&format!("{}/itemAudio", role_prefix)))
                .transpose()?,
            image: story
                .item_image
                .as_ref()
                .map(|_| self.asset_name(&format!("{}/itemImage", role_prefix)))
                .transpose()?,
            control_settings: title_controls_from_settings(story.title_control_settings.as_ref()),
            home_transition: title_home_transition,
            ok_transition: Some(Transition {
                action_node: play_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: play_stage_id,
            name: format!("Histoire - {}", base_story_name),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: Some(self.asset_name(&format!("{}/storyAudio", role_prefix))?),
            image: None,
            control_settings: play_controls,
            home_transition: effective_play_home_transition,
            ok_transition: play_ok_transition,
            position: zero_position(),
        });

        Ok(title_stage_id)
    }

    fn build_after_playback_sequence(
        &mut self,
        story: &CanonicalStory,
        role_prefix: &str,
        play_return_transition: Transition,
        play_home_transition: Transition,
    ) -> Result<AfterPlaybackSequenceTransitions, String> {
        let mut stage_ids: Vec<String> = story
            .after_playback_sequence
            .iter()
            .map(|_| self.next_id())
            .collect();
        let mut action_ids: Vec<String> = story
            .after_playback_sequence
            .iter()
            .map(|_| self.next_id())
            .collect();
        let home_sequence_transition = if let (Some(home_step), Some(first_next_action_id)) =
            (story.after_playback_home_step.as_ref(), action_ids.get(1))
        {
            let (home_stage_id, home_action_id) = self
                .story_prealloc
                .get(&story.id)
                .and_then(|prealloc| {
                    Some((
                        prealloc.home_step_stage_id.as_ref()?.clone(),
                        prealloc.home_step_action_id.as_ref()?.clone(),
                    ))
                })
                .unwrap_or_else(|| (self.next_id(), self.next_id()));
            let next_transition = transition(first_next_action_id, 0);
            let home_transition = if home_step.home_follows_ok {
                Some(next_transition.clone())
            } else if home_step.home_none {
                None
            } else {
                Some(self.resolve_story_home_transition(
                    home_step.home_target.as_deref(),
                    play_home_transition.clone(),
                ))
            };
            self.action_nodes.push(ActionNode {
                id: home_action_id.clone(),
                name: action_node_name(),
                options: vec![home_stage_id.clone()],
                position: zero_position(),
            });
            self.stage_nodes.push(StageNode {
                uuid: home_stage_id,
                name: home_step.name.clone(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: home_step
                    .audio
                    .as_ref()
                    .map(|_| {
                        self.asset_name(&format!("{}/afterPlaybackHomeStep/audio", role_prefix))
                    })
                    .transpose()?,
                image: home_step
                    .image
                    .as_ref()
                    .map(|_| {
                        self.asset_name(&format!("{}/afterPlaybackHomeStep/image", role_prefix))
                    })
                    .transpose()?,
                control_settings: prompt_controls_from_settings(
                    home_step.control_settings.as_ref(),
                ),
                home_transition,
                ok_transition: Some(next_transition),
                position: zero_position(),
            });
            Some(transition(&home_action_id, 0))
        } else {
            None
        };

        for (index, step) in story.after_playback_sequence.iter().enumerate() {
            let stage_id = stage_ids[index].clone();
            let action_id = action_ids[index].clone();
            let is_last = index + 1 == story.after_playback_sequence.len();
            let mut next_transition = if is_last {
                self.resolve_story_return_transition(
                    step.ok_target.as_deref(),
                    play_return_transition.clone(),
                )
            } else {
                Transition {
                    action_node: action_ids[index + 1].clone(),
                    option_index: 0,
                }
            };
            if is_last && step.ok_choice_targets.len() > 1 {
                let mut options = Vec::new();
                for target in &step.ok_choice_targets {
                    let resolved = self.resolve_story_return_transition(
                        Some(target.as_str()),
                        play_return_transition.clone(),
                    );
                    if let Some(stage_id) = self.transition_target_stage_id(&resolved) {
                        options.push(stage_id);
                    }
                }
                if options.len() > 1 {
                    let choice_action_id = self.next_id();
                    self.action_nodes.push(ActionNode {
                        id: choice_action_id.clone(),
                        name: action_node_name(),
                        options,
                        position: zero_position(),
                    });
                    next_transition = transition(&choice_action_id, 0);
                }
            }
            let home_transition = if step.home_follows_ok {
                Some(next_transition.clone())
            } else if step.home_none {
                None
            } else {
                Some(self.resolve_story_home_transition(
                    step.home_target.as_deref(),
                    play_home_transition.clone(),
                ))
            };
            let step_name = step.name.trim();
            let stage_name = if step_name.is_empty() {
                format!("Fin - {}", display_label(&story.name, "Story"))
            } else {
                step_name.to_string()
            };

            self.action_nodes.push(ActionNode {
                id: action_id,
                name: action_node_name(),
                options: vec![stage_id.clone()],
                position: zero_position(),
            });

            self.stage_nodes.push(StageNode {
                uuid: stage_id,
                name: stage_name,
                stage_type: "stage".to_string(),
                square_one: false,
                audio: step
                    .audio
                    .as_ref()
                    .map(|_| {
                        self.asset_name(&format!(
                            "{}/afterPlaybackSequence/{}/audio",
                            role_prefix, index
                        ))
                    })
                    .transpose()?,
                image: step
                    .image
                    .as_ref()
                    .map(|_| {
                        self.asset_name(&format!(
                            "{}/afterPlaybackSequence/{}/image",
                            role_prefix, index
                        ))
                    })
                    .transpose()?,
                control_settings: prompt_controls_from_settings(step.control_settings.as_ref()),
                home_transition,
                ok_transition: Some(next_transition),
                position: zero_position(),
            });
        }

        let first_action_id = action_ids
            .drain(..1)
            .next()
            .ok_or_else(|| "Sequence de fin vide.".to_string())?;
        stage_ids.clear();
        Ok(AfterPlaybackSequenceTransitions {
            ok: transition(&first_action_id, 0),
            home: home_sequence_transition,
        })
    }

    fn build_night_bridge(&mut self) -> Result<Transition, String> {
        let root_action_id = self
            .root_action_id
            .clone()
            .ok_or_else(|| "Action racine introuvable pour le bridge night.".to_string())?;
        let fallback_return = transition(&root_action_id, 0);
        let (return_transition, home_transition) =
            self.compute_night_bridge_targets(&[], 0, fallback_return);
        self.build_night_bridge_to(return_transition, home_transition)
    }

    /// Calcule les transitions de retour/accueil pour le night bridge d'une histoire donnée.
    ///
    /// Gère deux formes :
    /// - destination globale (`root`, `menu:<id>`, `story:<id>`, ...) : la transition résolue
    ///   est la même pour toutes les histoires, ce qui permet à `night_bridge_cache` de
    ///   partager un night stage unique.
    /// - destination dépendante de l'histoire courante (`next_story`) : `resolve_next_story_target`
    ///   produit une transition différente par histoire source, donc un night stage par histoire.
    fn compute_night_bridge_targets(
        &self,
        siblings: &[CanonicalEntry],
        story_index: usize,
        fallback_return: Transition,
    ) -> (Transition, Option<Transition>) {
        let raw_return = self.report.project.night_mode_return.as_deref();
        let night_return = if raw_return.is_some() {
            let resolved = resolve_next_story_target(raw_return, siblings, story_index);
            self.resolve_story_return_transition(resolved.as_deref(), fallback_return.clone())
        } else {
            fallback_return.clone()
        };

        let raw_home = self.report.project.night_mode_home_return.as_deref();
        let night_home = raw_home.map(|target| {
            let resolved = resolve_next_story_target(Some(target), siblings, story_index);
            self.resolve_story_home_transition(resolved.as_deref(), night_return.clone())
        });

        (night_return, night_home)
    }

    fn build_night_bridge_to(
        &mut self,
        return_transition: Transition,
        home_transition: Option<Transition>,
    ) -> Result<Transition, String> {
        let cache_key = format!(
            "{}#{}#{}",
            return_transition.action_node,
            return_transition.option_index,
            home_transition
                .as_ref()
                .map(|transition| format!("{}#{}", transition.action_node, transition.option_index))
                .unwrap_or_default()
        );
        if let Some(existing) = self.night_bridge_cache.get(&cache_key).cloned() {
            return Ok(existing);
        }

        let night_stage_id = self.next_id();
        let night_entry_action_id = self.next_id();

        self.action_nodes.push(ActionNode {
            id: night_entry_action_id.clone(),
            name: action_node_name(),
            options: vec![night_stage_id.clone()],
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: night_stage_id,
            name: "nightStage".to_string(),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: Some(self.asset_name("nightModeAudio")?),
            image: None,
            control_settings: night_story_controls(),
            home_transition,
            ok_transition: Some(return_transition),
            position: zero_position(),
        });

        let bridge = transition(&night_entry_action_id, 0);
        self.night_bridge_cache.insert(cache_key, bridge.clone());
        Ok(bridge)
    }

    fn build_imported_zip_branch(
        &mut self,
        zip: &CanonicalZip,
        role_prefix: &str,
        parent_return_transition: Transition,
        wrap_for_selection: bool,
    ) -> Result<String, String> {
        let bundle = self
            .imported_zip_bundle(&format!("{}/zip", role_prefix))?
            .clone();
        let mut stage_id_map = HashMap::new();
        let mut action_id_map = HashMap::new();
        let wrapper_ids = if wrap_for_selection {
            Some((self.next_id(), self.next_id()))
        } else {
            None
        };
        let skip_wrapped_root_action = wrap_for_selection
            && !bundle.document.stage_nodes.iter().any(|stage| {
                stage.uuid != bundle.square_one_stage_id
                    && (stage_transition_uses_action(
                        stage.home_transition.as_ref(),
                        &bundle.root_action_id,
                    ) || stage_transition_uses_action(
                        stage.ok_transition.as_ref(),
                        &bundle.root_action_id,
                    ))
            });

        for stage in &bundle.document.stage_nodes {
            let mapped_stage_id = if wrap_for_selection && stage.uuid == bundle.square_one_stage_id
            {
                wrapper_ids
                    .as_ref()
                    .map(|(stage_id, _)| stage_id.clone())
                    .ok_or_else(|| format!("Wrapper introuvable pour {}", zip.name))?
            } else {
                self.next_id()
            };
            stage_id_map.insert(stage.uuid.clone(), mapped_stage_id);
        }

        for action in &bundle.document.action_nodes {
            if skip_wrapped_root_action && action.id == bundle.root_action_id {
                continue;
            }
            action_id_map.insert(action.id.clone(), self.next_id());
        }

        for action in &bundle.document.action_nodes {
            if skip_wrapped_root_action && action.id == bundle.root_action_id {
                continue;
            }

            let mut cloned = action.clone();
            cloned.id = action_id_map
                .get(&action.id)
                .cloned()
                .ok_or_else(|| format!("Action importee introuvable : {}", action.id))?;
            cloned.options = action
                .options
                .iter()
                .filter_map(|option| stage_id_map.get(option).cloned())
                .collect();
            self.action_nodes.push(cloned);
        }

        for stage in &bundle.document.stage_nodes {
            if wrap_for_selection && stage.uuid == bundle.square_one_stage_id {
                continue;
            }

            let mut cloned = stage.clone();
            cloned.uuid = stage_id_map
                .get(&stage.uuid)
                .cloned()
                .ok_or_else(|| format!("Stage importe introuvable : {}", stage.uuid))?;
            cloned.square_one = false;
            cloned.home_transition =
                self.remap_imported_transition(stage.home_transition.as_ref(), &action_id_map);
            cloned.ok_transition =
                self.remap_imported_transition(stage.ok_transition.as_ref(), &action_id_map);

            if stage.uuid == bundle.post_root_stage_id {
                cloned.home_transition = Some(parent_return_transition.clone());
            }

            self.stage_nodes.push(cloned);
        }

        let imported_entry_stage_id = stage_id_map
            .get(&bundle.entry_stage_id)
            .cloned()
            .ok_or_else(|| format!("Entree importee introuvable pour {}", zip.name))?;

        if !wrap_for_selection {
            return Ok(imported_entry_stage_id);
        }

        // When wrapping for selection, the wrapper stage already shows the imported cover
        // audio/image. The ok_transition must skip the imported squareOne and go directly
        // to the first real content stage, otherwise the cover plays twice.
        let imported_post_root_stage_id = stage_id_map
            .get(&bundle.post_root_stage_id)
            .cloned()
            .ok_or_else(|| format!("Post-root introuvable pour {}", zip.name))?;

        let (wrapper_stage_id, wrapper_action_id) =
            wrapper_ids.ok_or_else(|| format!("Wrapper introuvable pour {}", zip.name))?;
        let cover_stage = bundle
            .document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == bundle.square_one_stage_id)
            .ok_or_else(|| format!("Cover importe introuvable pour {}", zip.name))?;

        self.action_nodes.push(ActionNode {
            id: wrapper_action_id.clone(),
            name: action_node_name(),
            options: vec![imported_post_root_stage_id],
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: wrapper_stage_id.clone(),
            name: display_label(&zip.name, "ZIP importe"),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: cover_stage.audio.clone(),
            image: cover_stage.image.clone(),
            control_settings: ControlSettings {
                wheel: true,
                ok: true,
                home: true,
                pause: false,
                autoplay: false,
            },
            // At root level, parent_return_transition would loop back to this wrapper stage
            // (root_action[n] == wrapper_stage_id). Use None to avoid the self-loop.
            home_transition: if self.root_action_id.as_deref()
                == Some(parent_return_transition.action_node.as_str())
            {
                None
            } else {
                Some(parent_return_transition)
            },
            ok_transition: Some(Transition {
                action_node: wrapper_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });

        Ok(wrapper_stage_id)
    }

    fn asset_name(&self, role: &str) -> Result<String, String> {
        self.report
            .assets
            .iter()
            .find(|asset| asset.role == role)
            .map(|asset| asset.staged_asset_name.clone())
            .ok_or_else(|| format!("Asset prepare introuvable pour le role {}", role))
    }

    fn imported_zip_bundle(&self, role: &str) -> Result<&ImportedZipBundle, String> {
        self.report
            .imported_zips
            .iter()
            .find(|bundle| bundle.role == role)
            .ok_or_else(|| format!("ZIP importe prepare introuvable pour le role {}", role))
    }

    fn remap_imported_transition(
        &self,
        transition: Option<&Transition>,
        action_id_map: &HashMap<String, String>,
    ) -> Option<Transition> {
        let transition = transition?;
        action_id_map
            .get(&transition.action_node)
            .map(|action_id| Transition {
                action_node: action_id.clone(),
                option_index: transition.option_index,
            })
    }

    fn next_id(&self) -> String {
        Uuid::new_v4().to_string()
    }
}

fn playback_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: false,
        home: true,
        pause: true,
        autoplay: true,
    }
}

fn night_story_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: true,
        home: true,
        pause: false,
        autoplay: true,
    }
}

fn post_playback_prompt_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: true,
        home: true,
        pause: false,
        autoplay: true,
    }
}

fn title_controls_from_settings(settings: Option<&EntryControlSettings>) -> ControlSettings {
    let fallback = ControlSettings {
        wheel: true,
        ok: true,
        home: true,
        pause: false,
        autoplay: false,
    };
    ControlSettings {
        wheel: settings.and_then(|c| c.wheel).unwrap_or(fallback.wheel),
        ok: settings.and_then(|c| c.ok).unwrap_or(fallback.ok),
        home: settings.and_then(|c| c.home).unwrap_or(fallback.home),
        pause: settings.and_then(|c| c.pause).unwrap_or(fallback.pause),
        autoplay: settings
            .and_then(|c| c.autoplay)
            .unwrap_or(fallback.autoplay),
    }
}

fn should_emit_combined_story_stage(story: &CanonicalStory, has_night_mode: bool) -> bool {
    has_night_mode
        && story.title_control_settings.is_none()
        && story.item_audio == story.audio
        && story.wheel
        && story.autoplay
}

fn prompt_controls_from_settings(settings: Option<&EntryControlSettings>) -> ControlSettings {
    let fallback = post_playback_prompt_controls();
    ControlSettings {
        wheel: settings.and_then(|c| c.wheel).unwrap_or(fallback.wheel),
        ok: settings.and_then(|c| c.ok).unwrap_or(fallback.ok),
        home: settings.and_then(|c| c.home).unwrap_or(fallback.home),
        pause: settings.and_then(|c| c.pause).unwrap_or(fallback.pause),
        autoplay: settings
            .and_then(|c| c.autoplay)
            .unwrap_or(fallback.autoplay),
    }
}

fn transition(action_id: &str, option_index: i32) -> Transition {
    Transition {
        action_node: action_id.to_string(),
        option_index,
    }
}

fn stage_transition_uses_action(transition: Option<&Transition>, action_id: &str) -> bool {
    transition
        .map(|transition| transition.action_node == action_id)
        .unwrap_or(false)
}

fn action_node_name() -> String {
    "Action node".to_string()
}

fn zero_position() -> Position {
    Position {
        x: Number::from(0),
        y: Number::from(0),
    }
}

fn normalize_document_for_studio_compat(document: &mut StoryDocument) {
    for stage in &mut document.stage_nodes {
        // STUdio recreates ports from controlSettings before replaying transitions.
        // A declared transition must therefore expose the matching port.
        if stage.ok_transition.is_some()
            && !stage.control_settings.ok
            && !stage.control_settings.autoplay
        {
            stage.control_settings.ok = true;
        }
        if stage.home_transition.is_some() && !stage.control_settings.home {
            stage.control_settings.home = true;
        }
    }
}

fn validate_document_for_studio_compat(document: &StoryDocument) -> Result<(), String> {
    let stage_ids: HashSet<&str> = document
        .stage_nodes
        .iter()
        .map(|stage| stage.uuid.as_str())
        .collect();
    let action_map: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let mut issues = Vec::new();

    for action in &document.action_nodes {
        for (option_index, stage_id) in action.options.iter().enumerate() {
            if !stage_ids.contains(stage_id.as_str()) {
                issues.push(format!(
                    "Action '{}' option {} pointe vers un stage introuvable '{}'",
                    action.name, option_index, stage_id
                ));
            }
        }
    }

    for stage in &document.stage_nodes {
        validate_stage_transition(
            &action_map,
            stage,
            "okTransition",
            stage.ok_transition.as_ref(),
            stage.control_settings.ok || stage.control_settings.autoplay,
            &mut issues,
        );
        validate_stage_transition(
            &action_map,
            stage,
            "homeTransition",
            stage.home_transition.as_ref(),
            stage.control_settings.home,
            &mut issues,
        );

        // Après Studio rule: homeTransition must not loop back to the same stage
        if let Some(ht) = stage.home_transition.as_ref() {
            if let Some(action) = action_map.get(ht.action_node.as_str()) {
                let idx = ht.option_index as usize;
                if ht.option_index >= 0
                    && idx < action.options.len()
                    && action.options[idx] == stage.uuid
                {
                    issues.push(format!(
                        "Stage '{}' : homeTransition boucle sur lui-même (interdit par STUdio)",
                        stage.name
                    ));
                }
            }
        }

        // Après Studio rule: homeTransition and okTransition must not resolve to the same target stage.
        // Only applies to navigation/title stages (wheel=true). Pure play stages (wheel=false,
        // autoplay=true) legitimately route both transitions to the same return target.
        if stage.control_settings.wheel {
            if let (Some(ht), Some(ot)) =
                (stage.home_transition.as_ref(), stage.ok_transition.as_ref())
            {
                let h_target = action_map.get(ht.action_node.as_str()).and_then(|a| {
                    if ht.option_index >= 0 {
                        a.options.get(ht.option_index as usize)
                    } else {
                        None
                    }
                });
                let o_target = action_map.get(ot.action_node.as_str()).and_then(|a| {
                    if ot.option_index >= 0 {
                        a.options.get(ot.option_index as usize)
                    } else {
                        None
                    }
                });
                if let (Some(h), Some(o)) = (h_target, o_target) {
                    if h == o {
                        issues.push(format!(
                            "Stage '{}' : homeTransition et okTransition arrivent sur le même nœud (interdit par STUdio)",
                            stage.name
                        ));
                    }
                }
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "story.json natif incompatible STUdio : {}",
            issues.join(" | ")
        ))
    }
}

fn validate_stage_transition(
    action_map: &HashMap<&str, &ActionNode>,
    stage: &StageNode,
    transition_label: &str,
    transition: Option<&Transition>,
    port_available: bool,
    issues: &mut Vec<String>,
) {
    let Some(transition) = transition else {
        return;
    };

    if !port_available {
        issues.push(format!(
            "Stage '{}' declare {} sans port compatible",
            stage.name, transition_label
        ));
    }

    let Some(action) = action_map.get(transition.action_node.as_str()) else {
        issues.push(format!(
            "Stage '{}' pointe via {} vers une action introuvable '{}'",
            stage.name, transition_label, transition.action_node
        ));
        return;
    };

    if transition.option_index < -1 {
        issues.push(format!(
            "Stage '{}' utilise un optionIndex invalide {} sur {}",
            stage.name, transition.option_index, transition_label
        ));
        return;
    }

    if transition.option_index >= 0 && transition.option_index as usize >= action.options.len() {
        issues.push(format!(
            "Stage '{}' utilise un optionIndex hors limites {} sur {}",
            stage.name, transition.option_index, transition_label
        ));
    }
}

fn reorder_document_for_display(document: &mut StoryDocument) {
    let stage_map: HashMap<String, StageNode> = document
        .stage_nodes
        .iter()
        .cloned()
        .map(|stage| (stage.uuid.clone(), stage))
        .collect();
    let action_map: HashMap<String, ActionNode> = document
        .action_nodes
        .iter()
        .cloned()
        .map(|action| (action.id.clone(), action))
        .collect();

    let square_one_id = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .map(|stage| stage.uuid.clone());

    let mut ordered_stage_ids = Vec::new();
    let mut ordered_action_ids = Vec::new();
    let mut seen_stages = HashSet::new();
    let mut seen_actions = HashSet::new();
    let mut queue = VecDeque::new();

    if let Some(stage_id) = square_one_id {
        queue.push_back(GraphNodeRef::Stage(stage_id));
    }

    while let Some(node_ref) = queue.pop_front() {
        match node_ref {
            GraphNodeRef::Stage(stage_id) => {
                if !seen_stages.insert(stage_id.clone()) {
                    continue;
                }
                ordered_stage_ids.push(stage_id.clone());
                if let Some(action_id) = stage_map
                    .get(&stage_id)
                    .and_then(|stage| stage.ok_transition.as_ref())
                    .map(|transition| transition.action_node.clone())
                {
                    queue.push_back(GraphNodeRef::Action(action_id));
                }
            }
            GraphNodeRef::Action(action_id) => {
                if !seen_actions.insert(action_id.clone()) {
                    continue;
                }
                ordered_action_ids.push(action_id.clone());
                if let Some(action) = action_map.get(&action_id) {
                    for stage_id in &action.options {
                        queue.push_back(GraphNodeRef::Stage(stage_id.clone()));
                    }
                }
            }
        }
    }

    for stage in &document.stage_nodes {
        if seen_stages.insert(stage.uuid.clone()) {
            ordered_stage_ids.push(stage.uuid.clone());
        }
    }
    for action in &document.action_nodes {
        if seen_actions.insert(action.id.clone()) {
            ordered_action_ids.push(action.id.clone());
        }
    }

    document.stage_nodes = ordered_stage_ids
        .into_iter()
        .filter_map(|stage_id| stage_map.get(&stage_id).cloned())
        .collect();
    document.action_nodes = ordered_action_ids
        .into_iter()
        .filter_map(|action_id| action_map.get(&action_id).cloned())
        .collect();
}

enum GraphNodeRef {
    Stage(String),
    Action(String),
}

fn thumbnail_source_path(project: &CanonicalProject) -> Option<String> {
    project
        .thumbnail_image
        .clone()
        .or_else(|| project.root_image.clone())
}

fn sanitized_project_name(name: &str) -> String {
    let mut sanitized = String::new();
    let mut previous_char: Option<char> = None;

    for ch in name.trim().chars() {
        let mapped = if ch.is_alphanumeric()
            || matches!(ch, '_' | '-' | '.' | '(' | ')' | '[' | ']' | '+')
        {
            Some(ch)
        } else if ch.is_whitespace() || matches!(ch, '\'' | '`' | '’') {
            Some('_')
        } else {
            Some('-')
        };

        if let Some(next_char) = mapped {
            let duplicate_separator =
                matches!(next_char, '_' | '-') && previous_char == Some(next_char);
            if duplicate_separator {
                continue;
            }
            sanitized.push(next_char);
            previous_char = Some(next_char);
        }
    }

    let trimmed = sanitized.trim_matches(|c| matches!(c, '_' | '-' | '.' | ' '));
    if trimmed.is_empty() {
        "story-studio".to_string()
    } else {
        let candidate = trimmed.to_string();
        let upper = candidate.to_ascii_uppercase();
        match upper.as_str() {
            "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
            | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
            | "LPT7" | "LPT8" | "LPT9" => {
                format!("{}_pack", candidate)
            }
            _ => candidate,
        }
    }
}

fn export_zip_path(output_dir: &Path, project_name: &str) -> PathBuf {
    let base_name = sanitized_project_name(project_name);
    let mut candidate = output_dir.join(format!("{}.zip", base_name));
    let mut suffix = 2usize;

    while candidate.exists() {
        candidate = output_dir.join(format!("{}-{}.zip", base_name, suffix));
        suffix += 1;
    }

    candidate
}

fn display_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::project::{
        EntryControlSettings, GlobalOptions, Menu, Project, ProjectEntry, StoryItem,
    };
    use std::io::Write;

    fn simple_story_controls() -> ControlSettings {
        ControlSettings {
            wheel: false,
            ok: false,
            home: true,
            pause: true,
            autoplay: false,
        }
    }

    fn sample_options() -> GlobalOptions {
        GlobalOptions {
            convert_format: true,
            add_silence: false,
            auto_next: false,
            select_next: false,
            night_mode: false,
        }
    }

    fn story(name: &str) -> StoryItem {
        StoryItem {
            item_type: "story".to_string(),
            name: name.to_string(),
            audio: Some("story.mp3".to_string()),
            item_audio: Some("item.mp3".to_string()),
            item_image: Some("item.png".to_string()),
            zip_path: None,
        }
    }

    fn prepared_asset(role: &str, staged_asset_name: &str) -> PreparedAsset {
        PreparedAsset {
            role: role.to_string(),
            source_path: format!("source/{}", staged_asset_name),
            source_kind: "test".to_string(),
            staged_asset_name: staged_asset_name.to_string(),
            staged_asset_path: format!("stage/{}", staged_asset_name),
            transformed: false,
            deduplicated: false,
        }
    }

    #[test]
    fn sanitizes_project_name_for_export_zip() {
        assert_eq!(
            sanitized_project_name("Nom de l'histoire !"),
            "Nom_de_l_histoire"
        );
        assert_eq!(
            sanitized_project_name("3+]RTL-mon_histoire(8_chapitres)[by_hugs_V1"),
            "3+]RTL-mon_histoire(8_chapitres)[by_hugs_V1"
        );
        assert_eq!(sanitized_project_name("///"), "story-studio");
    }

    #[test]
    fn export_zip_path_adds_numeric_suffix_on_collision() {
        let base =
            std::env::temp_dir().join(format!("story_studio_export_name_test_{}", now_millis()));
        fs::create_dir_all(&base).expect("create test dir");

        let first = export_zip_path(&base, "Nom de l'histoire");
        assert_eq!(
            first.file_name().and_then(|value| value.to_str()),
            Some("Nom_de_l_histoire.zip")
        );

        fs::write(&first, b"test").expect("seed first zip");

        let second = export_zip_path(&base, "Nom de l'histoire");
        assert_eq!(
            second.file_name().and_then(|value| value.to_str()),
            Some("Nom_de_l_histoire-2.zip")
        );

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn processed_audio_output_name_stays_short_for_deep_roles() {
        let role = "root/Quelle Grande Famille de Bestiole#b08778c2/6.0 Insectes et autres petites betes#7f1419a8/Quel groupe de Bestioles#ac51eafb/6.2 Insectes et Arthropodes terrestres#03725ed0/Choisi la Bestiole#7c499ca6/araignee.mp3 item#b3fa8616/storyAudio";
        let output_name = processed_audio_output_name(role);

        assert!(output_name.ends_with(".mp3"));
        assert!(output_name.len() < 120);
        assert!(!output_name.contains('/'));
        assert!(!output_name.contains('\\'));
    }

    #[test]
    fn builds_story_title_without_item_audio() {
        let project = CanonicalProject {
            name: "Missing item audio".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                convert_format: true,
                add_silence: false,
                auto_next: false,
                select_next: false,
                night_mode: false,
            },
            entries: vec![CanonicalEntry::Story(CanonicalStory {
                id: "story-id".to_string(),
                name: "Loutre".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: None,
                item_image: Some("item.png".to_string()),
                after_playback_prompt_audio: None,
                after_playback_prompt_control_settings: None,
                after_playback_prompt_ok_target: None,
                after_playback_prompt_home_target: None,
                after_playback_prompt_home_none: false,
                after_playback_sequence: Vec::new(),
                after_playback_home_step: None,
                wheel: false,
                ok: false,
                home: true,
                pause: true,
                autoplay: true,
                return_after_play: None,
                return_on_home: None,
                return_on_home_none: false,
                title_return_on_home: None,
                title_return_on_home_none: false,
                title_control_settings: None,
                audio_processing: HashMap::new(),
            })],
        };
        let report = report_for(
            project,
            vec![
                prepared_asset("rootAudio", "root.mp3"),
                prepared_asset("rootImage", "root.png"),
                prepared_asset("root/Loutre#story-id/storyAudio", "story.mp3"),
                prepared_asset("root/Loutre#story-id/itemImage", "item.png"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("story document");
        let title_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Titre - Loutre")
            .expect("title stage");

        assert_eq!(title_stage.audio, None);
        assert_eq!(title_stage.image.as_deref(), Some("item.png"));
    }

    #[test]
    fn generates_imported_prompt_controls_and_home_null() {
        let project = CanonicalProject {
            name: "Prompt fidelity".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                convert_format: true,
                add_silence: false,
                auto_next: false,
                select_next: false,
                night_mode: false,
            },
            entries: vec![CanonicalEntry::Story(CanonicalStory {
                id: "story-id".to_string(),
                name: "Bestiole".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: Some("item.mp3".to_string()),
                item_image: Some("item.png".to_string()),
                after_playback_prompt_audio: Some("prompt.mp3".to_string()),
                after_playback_prompt_control_settings: Some(EntryControlSettings {
                    autoplay: Some(false),
                    wheel: Some(false),
                    pause: Some(false),
                    ok: Some(true),
                    home: Some(true),
                }),
                after_playback_prompt_ok_target: Some("root".to_string()),
                after_playback_prompt_home_target: None,
                after_playback_prompt_home_none: true,
                after_playback_sequence: Vec::new(),
                after_playback_home_step: None,
                wheel: false,
                ok: false,
                home: true,
                pause: true,
                autoplay: true,
                return_after_play: None,
                return_on_home: None,
                return_on_home_none: false,
                title_return_on_home: None,
                title_return_on_home_none: false,
                title_control_settings: None,
                audio_processing: HashMap::new(),
            })],
        };
        let report = report_for(
            project,
            vec![
                prepared_asset("rootAudio", "root.mp3"),
                prepared_asset("rootImage", "root.png"),
                prepared_asset("root/Bestiole#story-id/itemAudio", "item.mp3"),
                prepared_asset("root/Bestiole#story-id/itemImage", "item.png"),
                prepared_asset("root/Bestiole#story-id/storyAudio", "story.mp3"),
                prepared_asset(
                    "root/Bestiole#story-id/afterPlaybackPromptAudio",
                    "prompt.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("story document");
        let prompt_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Fin - Bestiole")
            .expect("prompt stage");

        assert_eq!(prompt_stage.audio.as_deref(), Some("prompt.mp3"));
        assert!(!prompt_stage.control_settings.autoplay);
        assert!(prompt_stage.control_settings.ok);
        assert!(prompt_stage.control_settings.home);
        assert!(prompt_stage.ok_transition.is_some());
        assert!(prompt_stage.home_transition.is_none());
    }

    #[test]
    fn exports_after_playback_sequence_before_story_return() {
        let project = CanonicalProject {
            name: "Sequence fidelity".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                convert_format: true,
                add_silence: false,
                auto_next: false,
                select_next: false,
                night_mode: true,
            },
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "menu".to_string(),
                name: "Menu".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        id: "first".to_string(),
                        name: "Premier".to_string(),
                        audio: Some("first-story.mp3".to_string()),
                        item_audio: Some("first-item.mp3".to_string()),
                        item_image: Some("first.png".to_string()),
                        return_after_play: Some("story:second".to_string()),
                        after_playback_sequence: vec![
                            CanonicalAfterPlaybackStep {
                                id: "bell".to_string(),
                                name: "Cloche".to_string(),
                                audio: Some("bell.mp3".to_string()),
                                image: None,
                                control_settings: Some(EntryControlSettings {
                                    autoplay: Some(true),
                                    wheel: Some(false),
                                    pause: Some(false),
                                    ok: Some(false),
                                    home: Some(false),
                                }),
                                ok_target: None,
                                ok_choice_targets: Vec::new(),
                                home_target: None,
                                home_follows_ok: false,
                                home_none: true,
                            },
                            CanonicalAfterPlaybackStep {
                                id: "ok".to_string(),
                                name: "Ok ?".to_string(),
                                audio: Some("ok.mp3".to_string()),
                                image: None,
                                control_settings: Some(EntryControlSettings {
                                    autoplay: Some(false),
                                    wheel: Some(false),
                                    pause: Some(false),
                                    ok: Some(true),
                                    home: Some(true),
                                }),
                                ok_target: Some("story_play:second".to_string()),
                                ok_choice_targets: Vec::new(),
                                home_target: None,
                                home_follows_ok: false,
                                home_none: true,
                            },
                        ],
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        id: "second".to_string(),
                        name: "Second".to_string(),
                        audio: Some("second-story.mp3".to_string()),
                        item_audio: Some("second-item.mp3".to_string()),
                        item_image: Some("second.png".to_string()),
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            })],
        };
        let report = report_for(
            project,
            vec![
                prepared_asset("rootAudio", "root.mp3"),
                prepared_asset("rootImage", "root.png"),
                prepared_asset("nightModeAudio", "night.mp3"),
                prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
                prepared_asset("root/Menu#menu/menuImage", "menu.png"),
                prepared_asset("root/Menu#menu/Premier#first/itemAudio", "first-item.mp3"),
                prepared_asset("root/Menu#menu/Premier#first/itemImage", "first.png"),
                prepared_asset("root/Menu#menu/Premier#first/storyAudio", "first-story.mp3"),
                prepared_asset(
                    "root/Menu#menu/Premier#first/afterPlaybackSequence/0/audio",
                    "bell.mp3",
                ),
                prepared_asset(
                    "root/Menu#menu/Premier#first/afterPlaybackSequence/1/audio",
                    "ok.mp3",
                ),
                prepared_asset("root/Menu#menu/Second#second/itemAudio", "second-item.mp3"),
                prepared_asset("root/Menu#menu/Second#second/itemImage", "second.png"),
                prepared_asset(
                    "root/Menu#menu/Second#second/storyAudio",
                    "second-story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("story document");
        let action_by_id: HashMap<&str, &ActionNode> = document
            .action_nodes
            .iter()
            .map(|action| (action.id.as_str(), action))
            .collect();
        let target_stage_name = |transition: &Transition| -> &str {
            let action = action_by_id
                .get(transition.action_node.as_str())
                .expect("action");
            let stage_id = action.options[transition.option_index as usize].as_str();
            document
                .stage_nodes
                .iter()
                .find(|stage| stage.uuid == stage_id)
                .map(|stage| stage.name.as_str())
                .expect("stage")
        };

        let play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Premier")
            .expect("play stage");
        assert_eq!(
            target_stage_name(play_stage.ok_transition.as_ref().expect("play ok")),
            "Cloche"
        );

        let bell_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Cloche")
            .expect("bell stage");
        assert_eq!(bell_stage.audio.as_deref(), Some("bell.mp3"));
        assert!(bell_stage.control_settings.autoplay);
        assert_eq!(
            target_stage_name(bell_stage.ok_transition.as_ref().expect("bell ok")),
            "Ok ?"
        );

        let ok_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Ok ?")
            .expect("ok stage");
        assert_eq!(ok_stage.audio.as_deref(), Some("ok.mp3"));
        assert!(!ok_stage.control_settings.autoplay);
        assert!(ok_stage.control_settings.ok);
        assert_eq!(
            target_stage_name(ok_stage.ok_transition.as_ref().expect("prompt ok")),
            "Histoire - Second"
        );
        assert!(
            document
                .stage_nodes
                .iter()
                .filter(|stage| stage.name == "nightStage")
                .count()
                <= 1
        );
    }

    #[test]
    fn detects_native_compatible_mp3_header() {
        let compatible = [0xff, 0xfb, 0x90, 0xc0];
        let stereo = [0xff, 0xfb, 0x90, 0x00];
        let forty_eight_khz = [0xff, 0xfb, 0x94, 0xc0];

        assert!(mp3_header_is_native_compatible(&compatible));
        assert!(!mp3_header_is_native_compatible(&stereo));
        assert!(!mp3_header_is_native_compatible(&forty_eight_khz));
    }

    #[test]
    fn detects_mp3_frame_after_id3_header() {
        let mut bytes = b"ID3\x04\0\0\0\0\0\x05abcde".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfb, 0x90, 0xc0]);

        assert!(mp3_header_is_native_compatible(&bytes));
    }

    #[test]
    fn builds_legacy_ffmpeg_compatible_audio_filters() {
        let no_silence = CanonicalOptions {
            convert_format: true,
            add_silence: false,
            auto_next: false,
            select_next: false,
            night_mode: false,
        };
        let with_silence = CanonicalOptions {
            convert_format: true,
            add_silence: true,
            auto_next: false,
            select_next: false,
            night_mode: false,
        };

        assert_eq!(
            audio_filters(&no_silence, false),
            "aformat=channel_layouts=mono,loudnorm=I=-12:TP=-1.5:LRA=11"
        );
        assert_eq!(
            audio_filters(&with_silence, false),
            "aformat=channel_layouts=mono,loudnorm=I=-12:TP=-1.5:LRA=11,adelay=1000,apad=pad_dur=1"
        );
        assert_eq!(
            audio_filters(&with_silence, true),
            "aformat=channel_layouts=mono,loudnorm=I=-12:TP=-1.5:LRA=11"
        );
    }

    fn imported_zip_bundle(
        role: &str,
        square_one_stage_id: &str,
        root_action_id: &str,
        post_root_stage_id: &str,
        entry_stage_id: &str,
        document: StoryDocument,
    ) -> ImportedZipBundle {
        ImportedZipBundle {
            role: role.to_string(),
            zip_path: format!("fixtures/{}.zip", role.replace('/', "_")),
            square_one_stage_id: square_one_stage_id.to_string(),
            root_action_id: root_action_id.to_string(),
            post_root_stage_id: post_root_stage_id.to_string(),
            entry_stage_id: entry_stage_id.to_string(),
            document,
        }
    }

    fn report_for(
        project: CanonicalProject,
        assets: Vec<PreparedAsset>,
        imported_zips: Vec<ImportedZipBundle>,
    ) -> NativeAssetPreparationReport {
        NativeAssetPreparationReport {
            project,
            stage_dir: "stage".to_string(),
            assets_dir: "stage/assets".to_string(),
            assets,
            imported_zips,
            stats: NativeAssetStats {
                requested_asset_count: 0,
                unique_asset_count: 0,
                transformed_audio_count: 0,
                imported_zip_count: 0,
            },
            notes: Vec::new(),
        }
    }

    #[test]
    fn canonicalizes_pack_structure() {
        let project = Project {
            name: "Pack".to_string(),
            project_type: Some("pack".to_string()),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            audio_processing: HashMap::new(),
            root_entries: vec![],
            root_items: vec![story("Racine")],
            global_options: sample_options(),
            pack_version: 1,
            pack_description: String::new(),
            menus: vec![Menu {
                name: "Menu".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                items: vec![story("Menu story")],
            }],
        };

        let canonical = canonicalize_project(&project);
        let stats = collect_stats(&canonical.entries);

        assert_eq!(canonical.entries.len(), 2);
        assert_eq!(stats.root_entry_count, 2);
        assert_eq!(stats.menu_count, 1);
        assert_eq!(stats.story_count, 2);
        assert_eq!(stats.zip_count, 0);
        assert_eq!(stats.max_depth, 2);
    }

    #[test]
    fn canonicalizes_recursive_root_entries_structure() {
        let project = Project {
            name: "Recursive pack".to_string(),
            project_type: Some("pack".to_string()),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            audio_processing: HashMap::new(),
            root_entries: vec![ProjectEntry {
                entry_type: "menu".to_string(),
                name: "Choose a character".to_string(),
                audio: Some("menu-1.mp3".to_string()),
                image: Some("menu-1.png".to_string()),
                item_audio: None,
                item_image: None,
                zip_path: None,
                auto_black_image: false,
                children: vec![ProjectEntry {
                    entry_type: "menu".to_string(),
                    name: "Choose a place".to_string(),
                    audio: Some("menu-2.mp3".to_string()),
                    image: Some("menu-2.png".to_string()),
                    item_audio: None,
                    item_image: None,
                    zip_path: None,
                    auto_black_image: false,
                    children: vec![ProjectEntry {
                        entry_type: "story".to_string(),
                        name: "The jungle".to_string(),
                        audio: Some("story.mp3".to_string()),
                        image: None,
                        item_audio: Some("story-item.mp3".to_string()),
                        item_image: Some("story-item.png".to_string()),
                        zip_path: None,
                        auto_black_image: false,
                        children: vec![],
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            root_items: vec![],
            global_options: sample_options(),
            pack_version: 1,
            pack_description: String::new(),
            menus: vec![],
        };

        let canonical = canonicalize_project(&project);
        let stats = collect_stats(&canonical.entries);

        assert_eq!(canonical.entries.len(), 1);
        assert_eq!(stats.root_entry_count, 1);
        assert_eq!(stats.menu_count, 2);
        assert_eq!(stats.story_count, 1);
        assert_eq!(stats.zip_count, 0);
        assert_eq!(stats.max_depth, 3);
    }

    #[test]
    fn collects_asset_requests_for_pack() {
        let project = CanonicalProject {
            name: "Pack".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: Some("thumb.png".to_string()),
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                convert_format: true,
                add_silence: false,
                auto_next: false,
                select_next: false,
                night_mode: true,
            },
            entries: vec![
                CanonicalEntry::Menu(CanonicalMenu {
                    name: "Menu".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Zip(CanonicalZip {
                        name: "Zip".to_string(),
                        zip_path: Some("pack.zip".to_string()),
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    name: "Story".to_string(),
                    audio: Some("story.mp3".to_string()),
                    item_audio: Some("item.mp3".to_string()),
                    item_image: Some("item.png".to_string()),
                    ..Default::default()
                }),
            ],
        };

        let requests = collect_asset_requests(&project, &HashMap::new());
        assert_eq!(requests.len(), 10);
        assert!(requests
            .iter()
            .any(|request| matches!(request.source_kind, AssetSourceKind::Zip)));
        assert!(requests
            .iter()
            .any(|request| request.role == "root/Menu/menuAudio"));
        assert!(requests
            .iter()
            .any(|request| request.role == "root/Story/itemAudio"));
    }

    #[test]
    fn stages_duplicate_binary_asset_once() {
        let base =
            std::env::temp_dir().join(format!("story_studio_native_pack_test_{}", now_millis()));
        let assets_dir = base.join("assets");
        fs::create_dir_all(&assets_dir).expect("create assets dir");
        let source = base.join("sample.png");
        let mut file = fs::File::create(&source).expect("create source");
        file.write_all(b"same-content").expect("write source");

        let mut seen = HashMap::new();
        let first = stage_binary_asset(
            "role1",
            source.to_string_lossy().as_ref(),
            "image",
            &assets_dir,
            &mut seen,
            false,
        )
        .expect("first asset");
        let second = stage_binary_asset(
            "role2",
            source.to_string_lossy().as_ref(),
            "image",
            &assets_dir,
            &mut seen,
            false,
        )
        .expect("second asset");

        assert_eq!(first.staged_asset_name, second.staged_asset_name);
        assert!(!first.deduplicated);
        assert!(second.deduplicated);

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn writes_each_deduplicated_asset_only_once_in_final_zip() {
        let base =
            std::env::temp_dir().join(format!("story_studio_native_zip_test_{}", now_millis()));
        let stage_dir = base.join("stage");
        let assets_dir = stage_dir.join("assets");
        let output_dir = base.join("out");
        fs::create_dir_all(&assets_dir).expect("create assets dir");
        fs::create_dir_all(&output_dir).expect("create output dir");

        let asset_path = assets_dir.join("shared.mp3");
        fs::write(&asset_path, b"shared-audio").expect("write staged asset");
        let cover_path = base.join("cover.png");
        fs::write(&cover_path, b"cover").expect("write cover image");
        let cover_asset_path = assets_dir.join("cover.png");
        fs::write(&cover_asset_path, b"cover-asset").expect("write staged cover asset");

        let project = Project {
            name: "Dedup pack".to_string(),
            project_type: Some("pack".to_string()),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some(cover_path.to_string_lossy().to_string()),
            thumbnail_image: Some(cover_path.to_string_lossy().to_string()),
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            audio_processing: HashMap::new(),
            root_entries: vec![],
            root_items: vec![StoryItem {
                item_type: "story".to_string(),
                name: "Story".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: Some("item.mp3".to_string()),
                item_image: Some("item.png".to_string()),
                zip_path: None,
            }],
            global_options: GlobalOptions {
                convert_format: false,
                add_silence: false,
                auto_next: false,
                select_next: false,
                night_mode: false,
            },
            pack_version: 1,
            pack_description: String::new(),
            menus: vec![],
        };

        let report = NativeAssetPreparationReport {
            project: canonicalize_project(&project),
            stage_dir: stage_dir.to_string_lossy().to_string(),
            assets_dir: assets_dir.to_string_lossy().to_string(),
            assets: vec![
                PreparedAsset {
                    role: "rootAudio".to_string(),
                    source_path: "source/shared.mp3".to_string(),
                    source_kind: "audio".to_string(),
                    staged_asset_name: "shared.mp3".to_string(),
                    staged_asset_path: asset_path.to_string_lossy().to_string(),
                    transformed: false,
                    deduplicated: false,
                },
                PreparedAsset {
                    role: "root/Story/itemAudio".to_string(),
                    source_path: "source/shared.mp3".to_string(),
                    source_kind: "audio".to_string(),
                    staged_asset_name: "shared.mp3".to_string(),
                    staged_asset_path: asset_path.to_string_lossy().to_string(),
                    transformed: false,
                    deduplicated: true,
                },
                PreparedAsset {
                    role: "root/Story/storyAudio".to_string(),
                    source_path: "source/shared.mp3".to_string(),
                    source_kind: "audio".to_string(),
                    staged_asset_name: "shared.mp3".to_string(),
                    staged_asset_path: asset_path.to_string_lossy().to_string(),
                    transformed: false,
                    deduplicated: true,
                },
                PreparedAsset {
                    role: "rootImage".to_string(),
                    source_path: "source/cover.png".to_string(),
                    source_kind: "image".to_string(),
                    staged_asset_name: "cover.png".to_string(),
                    staged_asset_path: cover_asset_path.to_string_lossy().to_string(),
                    transformed: false,
                    deduplicated: false,
                },
                PreparedAsset {
                    role: "root/Story/itemImage".to_string(),
                    source_path: "source/cover.png".to_string(),
                    source_kind: "image".to_string(),
                    staged_asset_name: "cover.png".to_string(),
                    staged_asset_path: cover_asset_path.to_string_lossy().to_string(),
                    transformed: false,
                    deduplicated: true,
                },
            ],
            imported_zips: Vec::new(),
            stats: NativeAssetStats {
                requested_asset_count: 5,
                unique_asset_count: 2,
                transformed_audio_count: 0,
                imported_zip_count: 0,
            },
            notes: Vec::new(),
        };

        let zip_path = write_native_pack_zip(
            &report,
            &build_story_document(&report).expect("story doc"),
            &output_dir,
        )
        .expect("write zip");

        let zip_file = fs::File::open(&zip_path).expect("open zip");
        let mut archive = zip::ZipArchive::new(zip_file).expect("read zip");
        let mut shared_count = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).expect("zip entry");
            if entry.name() == "assets/shared.mp3" {
                shared_count += 1;
            }
        }

        assert_eq!(shared_count, 1);

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn builds_simple_story_like_les_bons_amis() {
        let report = report_for(
            CanonicalProject {
                name: "Les bons amis".to_string(),
                project_type: "simple".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Story(CanonicalStory {
                    name: "Les bons amis".to_string(),
                    audio: Some("story.mp3".to_string()),
                    item_audio: Some("item.mp3".to_string()),
                    item_image: Some("item.png".to_string()),
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Les bons amis/storyAudio", "story.mp3"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("simple story document");

        assert_eq!(document.action_nodes.len(), 1);
        assert_eq!(document.stage_nodes.len(), 2);

        let cover = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Cover node")
            .expect("cover stage");
        let story_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "histoire")
            .expect("simple story stage");
        let root_action = &document.action_nodes[0];

        assert_eq!(root_action.name, "Action node");
        assert_eq!(root_action.options, vec![story_stage.uuid.clone()]);
        assert_eq!(
            cover.ok_transition.as_ref().map(|t| t.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(story_stage.audio.as_deref(), Some("story.mp3"));
        assert!(story_stage.image.is_none());
        assert!(story_stage.ok_transition.is_none());
        assert!(story_stage.home_transition.is_none());
        assert!(!story_stage.control_settings.autoplay);
        assert!(story_stage.control_settings.pause);
        assert!(!story_stage.control_settings.ok);
        assert!(story_stage.control_settings.home);
        assert!(!story_stage.control_settings.wheel);
    }

    #[test]
    fn builds_menu_story_with_title_returning_to_root_and_play_to_menu() {
        let report = report_for(
            CanonicalProject {
                name: "Pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    name: "Choisis ton histoire".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Story(CanonicalStory {
                        name: "Petite Licorne".to_string(),
                        audio: Some("story.mp3".to_string()),
                        item_audio: Some("item.mp3".to_string()),
                        item_image: Some("item.png".to_string()),
                        autoplay: true,
                        ..Default::default()
                    })],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Choisis ton histoire/menuAudio", "menu.mp3"),
                prepared_asset("root/Choisis ton histoire/menuImage", "menu.png"),
                prepared_asset(
                    "root/Choisis ton histoire/Petite Licorne/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Petite Licorne/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Petite Licorne/storyAudio",
                    "story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("menu story document");

        assert_eq!(document.action_nodes.len(), 3);
        assert_eq!(document.stage_nodes.len(), 4);

        let cover = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Cover node")
            .expect("cover stage");
        let menu_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Choisis ton histoire")
            .expect("menu stage");
        let title_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Titre - Petite Licorne" && stage.image.is_some())
            .expect("title stage");
        let play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Petite Licorne" && stage.image.is_none())
            .expect("play stage");
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![menu_stage.uuid.clone()])
            .expect("root action");
        let menu_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![title_stage.uuid.clone()])
            .expect("menu action");

        assert_eq!(root_action.name, "Action node");
        assert_eq!(menu_action.name, "Action node");
        assert_eq!(
            cover.ok_transition.as_ref().map(|t| t.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            menu_stage
                .ok_transition
                .as_ref()
                .map(|t| t.action_node.as_str()),
            Some(menu_action.id.as_str())
        );
        assert_eq!(
            title_stage
                .home_transition
                .as_ref()
                .map(|t| t.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        // After playback: return directly to menu stage (not story title),
        // matching the UI's resolveReturnTarget fallback → parentMenu.id.
        assert_eq!(
            play_stage
                .home_transition
                .as_ref()
                .map(|t| t.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            play_stage
                .ok_transition
                .as_ref()
                .map(|t| t.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            play_stage.home_transition.as_ref().map(|t| t.option_index),
            Some(0)
        );
        assert_eq!(
            play_stage.ok_transition.as_ref().map(|t| t.option_index),
            Some(0)
        );
        assert!(menu_stage.control_settings.autoplay);
        assert!(title_stage.control_settings.wheel);
        assert!(play_stage.control_settings.autoplay);
    }

    #[test]
    fn builds_recursive_menu_story_tree() {
        let report = report_for(
            CanonicalProject {
                name: "Recursive pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    name: "Choose a character".to_string(),
                    audio: Some("menu-1.mp3".to_string()),
                    image: Some("menu-1.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Menu(CanonicalMenu {
                        name: "Paul".to_string(),
                        audio: Some("menu-2.mp3".to_string()),
                        image: Some("menu-2.png".to_string()),
                        auto_black_image: false,
                        children: vec![CanonicalEntry::Story(CanonicalStory {
                            name: "The jungle".to_string(),
                            audio: Some("story.mp3".to_string()),
                            item_audio: Some("item.mp3".to_string()),
                            item_image: Some("item.png".to_string()),
                            ..Default::default()
                        })],
                        ..Default::default()
                    })],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Choose a character/menuAudio", "menu-1.mp3"),
                prepared_asset("root/Choose a character/menuImage", "menu-1.png"),
                prepared_asset("root/Choose a character/Paul/menuAudio", "menu-2.mp3"),
                prepared_asset("root/Choose a character/Paul/menuImage", "menu-2.png"),
                prepared_asset(
                    "root/Choose a character/Paul/The jungle/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choose a character/Paul/The jungle/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choose a character/Paul/The jungle/storyAudio",
                    "story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("recursive menu document");

        let top_menu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Choose a character")
            .expect("top menu stage");
        let submenu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Paul")
            .expect("submenu stage");
        let title_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Titre - The jungle" && stage.image.is_some())
            .expect("title stage");
        let play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - The jungle" && stage.image.is_none())
            .expect("play stage");
        let top_menu_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![submenu.uuid.clone()])
            .expect("top menu action");
        let _submenu_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![title_stage.uuid.clone()])
            .expect("submenu action");

        assert!(top_menu.home_transition.is_none());
        assert!(submenu.home_transition.is_none());
        assert!(!submenu.control_settings.autoplay);
        assert!(submenu.control_settings.wheel);
        assert_eq!(document.stage_nodes[0].name, "Cover node");
        assert_eq!(document.stage_nodes[1].name, "Choose a character");
        assert_eq!(document.stage_nodes[2].name, "Paul");
        assert_eq!(
            title_stage
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(top_menu_action.id.as_str())
        );
        assert_eq!(
            title_stage
                .home_transition
                .as_ref()
                .map(|transition| transition.option_index),
            Some(0)
        );
        // After playback: return to Paul submenu stage (matching resolveReturnTarget → parentMenu.id).
        assert_eq!(
            play_stage
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(top_menu_action.id.as_str())
        );
        assert_eq!(
            play_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(top_menu_action.id.as_str())
        );
        assert!(play_stage.control_settings.autoplay);
    }

    #[test]
    fn preserves_explicit_menu_home_transition() {
        let report = report_for(
            CanonicalProject {
                name: "Menu home fidelity".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    id: "characters".to_string(),
                    name: "Choose a character".to_string(),
                    audio: Some("menu-1.mp3".to_string()),
                    image: Some("menu-1.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Menu(CanonicalMenu {
                        id: "paul".to_string(),
                        name: "Paul".to_string(),
                        audio: Some("menu-2.mp3".to_string()),
                        image: Some("menu-2.png".to_string()),
                        auto_black_image: false,
                        return_on_home: Some("characters".to_string()),
                        children: vec![CanonicalEntry::Story(CanonicalStory {
                            id: "jungle".to_string(),
                            name: "The jungle".to_string(),
                            audio: Some("story.mp3".to_string()),
                            item_audio: Some("item.mp3".to_string()),
                            item_image: Some("item.png".to_string()),
                            ..Default::default()
                        })],
                        ..Default::default()
                    })],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Choose a character#characte/menuAudio", "menu-1.mp3"),
                prepared_asset("root/Choose a character#characte/menuImage", "menu-1.png"),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/menuAudio",
                    "menu-2.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/menuImage",
                    "menu-2.png",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/The jungle#jungle/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/The jungle#jungle/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/The jungle#jungle/storyAudio",
                    "story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("menu home document");
        let top_menu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Choose a character")
            .expect("top menu stage");
        let submenu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Paul")
            .expect("submenu stage");
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![top_menu.uuid.clone()])
            .expect("root action");

        assert!(top_menu.home_transition.is_none());
        assert_eq!(
            submenu
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            submenu
                .home_transition
                .as_ref()
                .map(|transition| transition.option_index),
            Some(0)
        );
    }

    #[test]
    fn preserves_imported_story_title_home_transition() {
        let report = report_for(
            CanonicalProject {
                name: "Title home fidelity".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    id: "characters".to_string(),
                    name: "Choose a character".to_string(),
                    audio: Some("menu-1.mp3".to_string()),
                    image: Some("menu-1.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Menu(CanonicalMenu {
                        id: "paul".to_string(),
                        name: "Paul".to_string(),
                        audio: Some("menu-2.mp3".to_string()),
                        image: Some("menu-2.png".to_string()),
                        auto_black_image: false,
                        children: vec![
                            CanonicalEntry::Story(CanonicalStory {
                                id: "jungle".to_string(),
                                name: "The jungle".to_string(),
                                audio: Some("story.mp3".to_string()),
                                item_audio: Some("item.mp3".to_string()),
                                item_image: Some("item.png".to_string()),
                                title_return_on_home: Some("characters".to_string()),
                                ..Default::default()
                            }),
                            CanonicalEntry::Story(CanonicalStory {
                                id: "silent".to_string(),
                                name: "Silent title home".to_string(),
                                audio: Some("story-2.mp3".to_string()),
                                item_audio: Some("item-2.mp3".to_string()),
                                item_image: Some("item-2.png".to_string()),
                                title_return_on_home_none: true,
                                ..Default::default()
                            }),
                        ],
                        ..Default::default()
                    })],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Choose a character#characte/menuAudio", "menu-1.mp3"),
                prepared_asset("root/Choose a character#characte/menuImage", "menu-1.png"),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/menuAudio",
                    "menu-2.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/menuImage",
                    "menu-2.png",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/The jungle#jungle/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/The jungle#jungle/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/The jungle#jungle/storyAudio",
                    "story.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/Silent title home#silent/itemAudio",
                    "item-2.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/Silent title home#silent/itemImage",
                    "item-2.png",
                ),
                prepared_asset(
                    "root/Choose a character#characte/Paul#paul/Silent title home#silent/storyAudio",
                    "story-2.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("title home document");
        let top_menu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Choose a character")
            .expect("top menu stage");
        let jungle_title = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Titre - The jungle")
            .expect("jungle title stage");
        let silent_title = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Titre - Silent title home")
            .expect("silent title stage");
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![top_menu.uuid.clone()])
            .expect("root action");

        assert_eq!(
            jungle_title
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert!(silent_title.home_transition.is_none());
    }

    #[test]
    fn inserts_night_stage_between_story_end_and_next_choice() {
        let report = report_for(
            CanonicalProject {
                name: "Night pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: Some("night.mp3".to_string()),
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: true,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    name: "Choisis ton histoire".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![
                        CanonicalEntry::Story(CanonicalStory {
                            name: "Petite Licorne".to_string(),
                            audio: Some("story.mp3".to_string()),
                            item_audio: Some("item.mp3".to_string()),
                            item_image: Some("item.png".to_string()),
                            ..Default::default()
                        }),
                        CanonicalEntry::Story(CanonicalStory {
                            name: "Mickey".to_string(),
                            audio: Some("mickey-story.mp3".to_string()),
                            item_audio: Some("mickey-item.mp3".to_string()),
                            item_image: Some("mickey-item.png".to_string()),
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("nightModeAudio", "night.mp3"),
                prepared_asset("root/Choisis ton histoire/menuAudio", "menu.mp3"),
                prepared_asset("root/Choisis ton histoire/menuImage", "menu.png"),
                prepared_asset(
                    "root/Choisis ton histoire/Petite Licorne/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Petite Licorne/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Petite Licorne/storyAudio",
                    "story.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Mickey/itemAudio",
                    "mickey-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Mickey/itemImage",
                    "mickey-item.png",
                ),
                prepared_asset(
                    "root/Choisis ton histoire/Mickey/storyAudio",
                    "mickey-story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("night mode document");
        let menu_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Choisis ton histoire")
            .expect("menu stage");
        let play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Petite Licorne" && stage.image.is_none())
            .expect("play stage");
        let second_play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Mickey" && stage.image.is_none())
            .expect("second play stage");
        let night_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "nightStage")
            .expect("night stage");
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![menu_stage.uuid.clone()])
            .expect("root action");
        let night_entry_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![night_stage.uuid.clone()])
            .expect("night entry action");

        assert!(document.night_mode_available);
        assert_eq!(
            document
                .stage_nodes
                .iter()
                .filter(|stage| stage.name == "nightStage")
                .count(),
            1
        );
        assert_eq!(
            document
                .action_nodes
                .iter()
                .filter(|action| action.options == vec![night_stage.uuid.clone()])
                .count(),
            1
        );
        assert_eq!(night_stage.audio.as_deref(), Some("night.mp3"));
        assert!(night_stage.image.is_none());
        assert!(night_stage.control_settings.autoplay);
        assert!(night_stage.control_settings.ok);
        assert!(night_stage.control_settings.home);
        assert_eq!(
            play_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(night_entry_action.id.as_str())
        );
        assert_eq!(
            second_play_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(night_entry_action.id.as_str())
        );
        assert_eq!(
            night_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            night_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.option_index),
            Some(0)
        );
        assert!(night_stage.home_transition.is_none());
    }

    #[test]
    fn night_stage_preserves_story_specific_return_after_play() {
        let report = report_for(
            CanonicalProject {
                name: "Night story returns".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: Some("night.mp3".to_string()),
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: true,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    id: "menu".to_string(),
                    name: "Choisis ton histoire".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![
                        CanonicalEntry::Story(CanonicalStory {
                            id: "licorne".to_string(),
                            name: "Petite Licorne".to_string(),
                            audio: Some("story.mp3".to_string()),
                            item_audio: Some("item.mp3".to_string()),
                            item_image: Some("item.png".to_string()),
                            return_after_play: Some("story:mickey".to_string()),
                            ..Default::default()
                        }),
                        CanonicalEntry::Story(CanonicalStory {
                            id: "mickey".to_string(),
                            name: "Mickey".to_string(),
                            audio: Some("mickey-story.mp3".to_string()),
                            item_audio: Some("mickey-item.mp3".to_string()),
                            item_image: Some("mickey-item.png".to_string()),
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("nightModeAudio", "night.mp3"),
                prepared_asset("root/Choisis ton histoire#menu/menuAudio", "menu.mp3"),
                prepared_asset("root/Choisis ton histoire#menu/menuImage", "menu.png"),
                prepared_asset(
                    "root/Choisis ton histoire#menu/Petite Licorne#licorne/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire#menu/Petite Licorne#licorne/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choisis ton histoire#menu/Petite Licorne#licorne/storyAudio",
                    "story.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire#menu/Mickey#mickey/itemAudio",
                    "mickey-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis ton histoire#menu/Mickey#mickey/itemImage",
                    "mickey-item.png",
                ),
                prepared_asset(
                    "root/Choisis ton histoire#menu/Mickey#mickey/storyAudio",
                    "mickey-story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("night story return document");
        let play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Petite Licorne" && stage.image.is_none())
            .expect("play stage");
        let night_entry_action_id = play_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str())
            .expect("play night transition");
        let night_stage_id = document
            .action_nodes
            .iter()
            .find(|action| action.id == night_entry_action_id)
            .and_then(|action| action.options.first())
            .expect("night stage id");
        let night_stage = document
            .stage_nodes
            .iter()
            .find(|stage| &stage.uuid == night_stage_id)
            .expect("night stage");
        let return_transition = night_stage
            .ok_transition
            .as_ref()
            .expect("night return transition");
        let return_action = document
            .action_nodes
            .iter()
            .find(|action| action.id == return_transition.action_node)
            .expect("night return action");
        let return_stage_id = return_action
            .options
            .get(return_transition.option_index as usize)
            .expect("night return target");
        let return_stage = document
            .stage_nodes
            .iter()
            .find(|stage| &stage.uuid == return_stage_id)
            .expect("night return stage");

        assert_eq!(return_stage.name, "Titre - Mickey");
        assert!(
            document
                .stage_nodes
                .iter()
                .filter(|stage| stage.name == "nightStage")
                .count()
                >= 2
        );
    }

    fn resolve_night_return_stage<'a>(
        document: &'a StoryDocument,
        play_stage: &StageNode,
    ) -> &'a StageNode {
        let night_entry_action_id = play_stage
            .ok_transition
            .as_ref()
            .map(|t| t.action_node.clone())
            .expect("play ok transition");
        let night_stage_id = document
            .action_nodes
            .iter()
            .find(|action| action.id == night_entry_action_id)
            .and_then(|action| action.options.first())
            .expect("night stage id")
            .clone();
        let night_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == night_stage_id)
            .expect("night stage");
        let return_transition = night_stage
            .ok_transition
            .as_ref()
            .expect("night return transition");
        let return_action = document
            .action_nodes
            .iter()
            .find(|action| action.id == return_transition.action_node)
            .expect("night return action");
        let return_stage_id = return_action
            .options
            .get(return_transition.option_index as usize)
            .expect("night return target")
            .clone();
        document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == return_stage_id)
            .expect("night return stage")
    }

    #[test]
    fn night_mode_return_next_story_creates_story_specific_night_stages() {
        let report = report_for(
            CanonicalProject {
                name: "Night next-story".to_string(),
                project_type: "pack".to_string(),
                pack_version: 1,
                pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: Some("night.mp3".to_string()),
                night_mode_return: Some("next_story".to_string()),
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: true,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    id: "menu".to_string(),
                    name: "Choisis".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-a".to_string(),
                            name: "Histoire A".to_string(),
                            audio: Some("a.mp3".to_string()),
                            item_audio: Some("a-item.mp3".to_string()),
                            item_image: Some("a-item.png".to_string()),
                            ..Default::default()
                        }),
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-b".to_string(),
                            name: "Histoire B".to_string(),
                            audio: Some("b.mp3".to_string()),
                            item_audio: Some("b-item.mp3".to_string()),
                            item_image: Some("b-item.png".to_string()),
                            ..Default::default()
                        }),
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-c".to_string(),
                            name: "Histoire C".to_string(),
                            audio: Some("c.mp3".to_string()),
                            item_audio: Some("c-item.mp3".to_string()),
                            item_image: Some("c-item.png".to_string()),
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("nightModeAudio", "night.mp3"),
                prepared_asset("root/Choisis#menu/menuAudio", "menu.mp3"),
                prepared_asset("root/Choisis#menu/menuImage", "menu.png"),
                prepared_asset(
                    "root/Choisis#menu/Histoire A#story-a/itemAudio",
                    "a-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis#menu/Histoire A#story-a/itemImage",
                    "a-item.png",
                ),
                prepared_asset("root/Choisis#menu/Histoire A#story-a/storyAudio", "a.mp3"),
                prepared_asset(
                    "root/Choisis#menu/Histoire B#story-b/itemAudio",
                    "b-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis#menu/Histoire B#story-b/itemImage",
                    "b-item.png",
                ),
                prepared_asset("root/Choisis#menu/Histoire B#story-b/storyAudio", "b.mp3"),
                prepared_asset(
                    "root/Choisis#menu/Histoire C#story-c/itemAudio",
                    "c-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis#menu/Histoire C#story-c/itemImage",
                    "c-item.png",
                ),
                prepared_asset("root/Choisis#menu/Histoire C#story-c/storyAudio", "c.mp3"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("night next-story document");

        let story_a_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Histoire A" && stage.image.is_none())
            .expect("story A play stage");
        let story_b_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Histoire B" && stage.image.is_none())
            .expect("story B play stage");
        let story_c_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Histoire C" && stage.image.is_none())
            .expect("story C play stage");

        let a_target = resolve_night_return_stage(&document, story_a_play);
        let b_target = resolve_night_return_stage(&document, story_b_play);
        let c_target = resolve_night_return_stage(&document, story_c_play);

        assert_eq!(a_target.name, "Titre - Histoire B");
        assert_eq!(b_target.name, "Titre - Histoire C");
        // Last story has no next sibling → fallback to the menu replay (parent stage).
        assert_eq!(c_target.name, "Choisis");

        // next_story produces a different resolved target per story, so multiple distinct night
        // stages are emitted (one per source story).
        let night_stage_count = document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "nightStage")
            .count();
        assert!(
            night_stage_count >= 2,
            "expected ≥2 night stages for next_story routing, got {night_stage_count}"
        );
    }

    #[test]
    fn night_mode_return_global_menu_reuses_single_night_stage() {
        let report = report_for(
            CanonicalProject {
                name: "Night global menu".to_string(),
                project_type: "pack".to_string(),
                pack_version: 1,
                pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: Some("night.mp3".to_string()),
                night_mode_return: Some("menu:menu-end".to_string()),
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: true,
                },
                entries: vec![
                    CanonicalEntry::Menu(CanonicalMenu {
                        id: "menu-main".to_string(),
                        name: "Histoires".to_string(),
                        audio: Some("main.mp3".to_string()),
                        image: Some("main.png".to_string()),
                        auto_black_image: false,
                        children: vec![
                            CanonicalEntry::Story(CanonicalStory {
                                id: "story-a".to_string(),
                                name: "Histoire A".to_string(),
                                audio: Some("a.mp3".to_string()),
                                item_audio: Some("a-item.mp3".to_string()),
                                item_image: Some("a-item.png".to_string()),
                                ..Default::default()
                            }),
                            CanonicalEntry::Story(CanonicalStory {
                                id: "story-b".to_string(),
                                name: "Histoire B".to_string(),
                                audio: Some("b.mp3".to_string()),
                                item_audio: Some("b-item.mp3".to_string()),
                                item_image: Some("b-item.png".to_string()),
                                ..Default::default()
                            }),
                        ],
                        ..Default::default()
                    }),
                    CanonicalEntry::Menu(CanonicalMenu {
                        id: "menu-end".to_string(),
                        name: "Final".to_string(),
                        audio: Some("final.mp3".to_string()),
                        image: Some("final.png".to_string()),
                        auto_black_image: false,
                        children: vec![CanonicalEntry::Story(CanonicalStory {
                            id: "story-z".to_string(),
                            name: "Histoire Z".to_string(),
                            audio: Some("z.mp3".to_string()),
                            item_audio: Some("z-item.mp3".to_string()),
                            item_image: Some("z-item.png".to_string()),
                            ..Default::default()
                        })],
                        ..Default::default()
                    }),
                ],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("nightModeAudio", "night.mp3"),
                prepared_asset("root/Histoires#menu-mai/menuAudio", "main.mp3"),
                prepared_asset("root/Histoires#menu-mai/menuImage", "main.png"),
                prepared_asset(
                    "root/Histoires#menu-mai/Histoire A#story-a/itemAudio",
                    "a-item.mp3",
                ),
                prepared_asset(
                    "root/Histoires#menu-mai/Histoire A#story-a/itemImage",
                    "a-item.png",
                ),
                prepared_asset(
                    "root/Histoires#menu-mai/Histoire A#story-a/storyAudio",
                    "a.mp3",
                ),
                prepared_asset(
                    "root/Histoires#menu-mai/Histoire B#story-b/itemAudio",
                    "b-item.mp3",
                ),
                prepared_asset(
                    "root/Histoires#menu-mai/Histoire B#story-b/itemImage",
                    "b-item.png",
                ),
                prepared_asset(
                    "root/Histoires#menu-mai/Histoire B#story-b/storyAudio",
                    "b.mp3",
                ),
                prepared_asset("root/Final#menu-end/menuAudio", "final.mp3"),
                prepared_asset("root/Final#menu-end/menuImage", "final.png"),
                prepared_asset(
                    "root/Final#menu-end/Histoire Z#story-z/itemAudio",
                    "z-item.mp3",
                ),
                prepared_asset(
                    "root/Final#menu-end/Histoire Z#story-z/itemImage",
                    "z-item.png",
                ),
                prepared_asset("root/Final#menu-end/Histoire Z#story-z/storyAudio", "z.mp3"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("night global menu document");

        let story_a_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Histoire A" && stage.image.is_none())
            .expect("story A play stage");
        let story_b_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Histoire B" && stage.image.is_none())
            .expect("story B play stage");
        let story_z_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Histoire Z" && stage.image.is_none())
            .expect("story Z play stage");

        let a_target = resolve_night_return_stage(&document, story_a_play);
        let b_target = resolve_night_return_stage(&document, story_b_play);
        let z_target = resolve_night_return_stage(&document, story_z_play);

        assert_eq!(a_target.name, "Final");
        assert_eq!(b_target.name, "Final");
        assert_eq!(z_target.name, "Final");

        // Global destination → single shared night stage thanks to night_bridge_cache.
        let night_stage_count = document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "nightStage")
            .count();
        assert_eq!(
            night_stage_count, 1,
            "expected 1 shared night stage for a global menu destination, got {night_stage_count}"
        );
    }

    #[test]
    fn night_mode_return_story_target_routes_to_story_title() {
        let report = report_for(
            CanonicalProject {
                name: "Night to story title".to_string(),
                project_type: "pack".to_string(),
                pack_version: 1,
                pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: Some("night.mp3".to_string()),
                night_mode_return: Some("story:story-target".to_string()),
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: true,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    id: "menu".to_string(),
                    name: "Choisis".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-source".to_string(),
                            name: "Source".to_string(),
                            audio: Some("s.mp3".to_string()),
                            item_audio: Some("s-item.mp3".to_string()),
                            item_image: Some("s-item.png".to_string()),
                            ..Default::default()
                        }),
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-target".to_string(),
                            name: "Cible".to_string(),
                            audio: Some("t.mp3".to_string()),
                            item_audio: Some("t-item.mp3".to_string()),
                            item_image: Some("t-item.png".to_string()),
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("nightModeAudio", "night.mp3"),
                prepared_asset("root/Choisis#menu/menuAudio", "menu.mp3"),
                prepared_asset("root/Choisis#menu/menuImage", "menu.png"),
                prepared_asset(
                    "root/Choisis#menu/Source#story-so/itemAudio",
                    "s-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis#menu/Source#story-so/itemImage",
                    "s-item.png",
                ),
                prepared_asset("root/Choisis#menu/Source#story-so/storyAudio", "s.mp3"),
                prepared_asset(
                    "root/Choisis#menu/Cible#story-ta/itemAudio",
                    "t-item.mp3",
                ),
                prepared_asset(
                    "root/Choisis#menu/Cible#story-ta/itemImage",
                    "t-item.png",
                ),
                prepared_asset("root/Choisis#menu/Cible#story-ta/storyAudio", "t.mp3"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("night story target document");

        let source_play = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Source" && stage.image.is_none())
            .expect("source play stage");

        let target = resolve_night_return_stage(&document, source_play);
        assert_eq!(target.name, "Titre - Cible");
    }

    #[test]
    fn makes_root_menu_selectable_when_pack_has_multiple_root_entries() {
        let report = report_for(
            CanonicalProject {
                name: "Mixed root pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        name: "Standalone story".to_string(),
                        audio: Some("story.mp3".to_string()),
                        item_audio: Some("story-item.mp3".to_string()),
                        item_image: Some("story-item.png".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Menu(CanonicalMenu {
                        name: "Cache cache".to_string(),
                        audio: Some("menu.mp3".to_string()),
                        image: Some("menu.png".to_string()),
                        auto_black_image: false,
                        children: vec![CanonicalEntry::Story(CanonicalStory {
                            name: "Inside menu".to_string(),
                            audio: Some("inside-story.mp3".to_string()),
                            item_audio: Some("inside-item.mp3".to_string()),
                            item_image: Some("inside-item.png".to_string()),
                            autoplay: true,
                            ..Default::default()
                        })],
                        ..Default::default()
                    }),
                ],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Standalone story/itemAudio", "story-item.mp3"),
                prepared_asset("root/Standalone story/itemImage", "story-item.png"),
                prepared_asset("root/Standalone story/storyAudio", "story.mp3"),
                prepared_asset("root/Cache cache/menuAudio", "menu.mp3"),
                prepared_asset("root/Cache cache/menuImage", "menu.png"),
                prepared_asset("root/Cache cache/Inside menu/itemAudio", "inside-item.mp3"),
                prepared_asset("root/Cache cache/Inside menu/itemImage", "inside-item.png"),
                prepared_asset(
                    "root/Cache cache/Inside menu/storyAudio",
                    "inside-story.mp3",
                ),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("mixed root document");
        let menu_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Cache cache")
            .expect("root menu stage");
        let play_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Histoire - Inside menu" && stage.image.is_none())
            .expect("inside menu play stage");
        // Root action has two options: standalone story title (index 0) and Cache cache menu (index 1).
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options.contains(&menu_stage.uuid))
            .expect("root action");

        assert!(menu_stage.control_settings.wheel);
        assert!(!menu_stage.control_settings.autoplay);
        // After playback: return directly to Cache cache menu stage (index 1 in root action),
        // matching the UI's resolveReturnTarget fallback → parentMenu.id.
        assert_eq!(
            play_stage
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            play_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            play_stage
                .ok_transition
                .as_ref()
                .map(|transition| transition.option_index),
            Some(1)
        );
        assert!(play_stage.control_settings.autoplay);
    }

    #[test]
    fn keeps_single_cover_stage_when_pack_has_multiple_root_entries() {
        let report = report_for(
            CanonicalProject {
                name: "Root zip pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        name: "Story one".to_string(),
                        audio: Some("story-1.mp3".to_string()),
                        item_audio: Some("story-1-item.mp3".to_string()),
                        item_image: Some("story-1-item.png".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        name: "Story two".to_string(),
                        audio: Some("story-2.mp3".to_string()),
                        item_audio: Some("story-2-item.mp3".to_string()),
                        item_image: Some("story-2-item.png".to_string()),
                        ..Default::default()
                    }),
                ],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Story one/itemAudio", "story-1-item.mp3"),
                prepared_asset("root/Story one/itemImage", "story-1-item.png"),
                prepared_asset("root/Story one/storyAudio", "story-1.mp3"),
                prepared_asset("root/Story two/itemAudio", "story-2-item.mp3"),
                prepared_asset("root/Story two/itemImage", "story-2-item.png"),
                prepared_asset("root/Story two/storyAudio", "story-2.mp3"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("root selection document");
        let cover = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .expect("cover stage");
        let root_choice_action = document
            .action_nodes
            .iter()
            .find(|action| action.options.len() == 2)
            .expect("root choice action");

        assert_eq!(
            cover
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_choice_action.id.as_str())
        );
        assert_eq!(
            document
                .stage_nodes
                .iter()
                .filter(|stage| stage.name == "Root zip pack" && !stage.square_one)
                .count(),
            0
        );
    }

    #[test]
    fn wraps_imported_zips_when_multiple_root_entries_are_selectable() {
        let imported = StoryDocument {
            title: "Imported".to_string(),
            version: 1,
            description: String::new(),
            format: "v1".to_string(),
            night_mode_available: false,
            action_nodes: vec![
                ActionNode {
                    id: "import-root-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["import-menu".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "import-menu-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["import-title".to_string()],
                    position: zero_position(),
                },
            ],
            stage_nodes: vec![
                StageNode {
                    uuid: "import-cover".to_string(),
                    name: "Debut".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: true,
                    audio: Some("import-cover.mp3".to_string()),
                    image: Some("import-cover.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: false,
                        ok: true,
                        home: false,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: None,
                    ok_transition: Some(transition("import-root-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "import-menu".to_string(),
                    name: "Quel épisode veux-tu écouter".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("import-menu.mp3".to_string()),
                    image: Some("import-menu.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: false,
                        ok: true,
                        home: true,
                        pause: false,
                        autoplay: true,
                    },
                    home_transition: None,
                    ok_transition: Some(transition("import-menu-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "import-title".to_string(),
                    name: "1".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("import-title.mp3".to_string()),
                    image: Some("import-title.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: true,
                        ok: true,
                        home: true,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: Some(transition("import-root-action", 0)),
                    ok_transition: None,
                    position: zero_position(),
                },
            ],
        };

        let report = report_for(
            CanonicalProject {
                name: "Multi imported root".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![
                    CanonicalEntry::Zip(CanonicalZip {
                        name: "Pack A".to_string(),
                        zip_path: Some("pack-a.zip".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Zip(CanonicalZip {
                        name: "Pack B".to_string(),
                        zip_path: Some("pack-b.zip".to_string()),
                        ..Default::default()
                    }),
                ],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset(
                    "root/Pack A / imported import-cover.mp3",
                    "import-cover.mp3",
                ),
                prepared_asset(
                    "root/Pack A / imported import-cover.png",
                    "import-cover.png",
                ),
                prepared_asset("root/Pack A / imported import-menu.mp3", "import-menu.mp3"),
                prepared_asset("root/Pack A / imported import-menu.png", "import-menu.png"),
                prepared_asset(
                    "root/Pack A / imported import-title.mp3",
                    "import-title.mp3",
                ),
                prepared_asset(
                    "root/Pack A / imported import-title.png",
                    "import-title.png",
                ),
                prepared_asset(
                    "root/Pack B / imported import-cover.mp3",
                    "import-cover.mp3",
                ),
                prepared_asset(
                    "root/Pack B / imported import-cover.png",
                    "import-cover.png",
                ),
                prepared_asset("root/Pack B / imported import-menu.mp3", "import-menu.mp3"),
                prepared_asset("root/Pack B / imported import-menu.png", "import-menu.png"),
                prepared_asset(
                    "root/Pack B / imported import-title.mp3",
                    "import-title.mp3",
                ),
                prepared_asset(
                    "root/Pack B / imported import-title.png",
                    "import-title.png",
                ),
            ],
            vec![
                imported_zip_bundle(
                    "root/Pack A/zip",
                    "import-cover",
                    "import-root-action",
                    "import-menu",
                    "import-cover",
                    imported.clone(),
                ),
                imported_zip_bundle(
                    "root/Pack B/zip",
                    "import-cover",
                    "import-root-action",
                    "import-menu",
                    "import-cover",
                    imported,
                ),
            ],
        );

        let document = build_story_document(&report).expect("multiple imported zips");
        let pack_a_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Pack A")
            .expect("wrapper Pack A");
        let pack_b_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Pack B")
            .expect("wrapper Pack B");

        assert!(pack_a_stage.control_settings.wheel);
        assert!(!pack_a_stage.control_settings.autoplay);
        assert!(pack_b_stage.control_settings.wheel);
        assert!(!pack_b_stage.control_settings.autoplay);
        assert_eq!(
            document
                .stage_nodes
                .iter()
                .filter(|stage| stage.name == "Debut")
                .count(),
            0
        );

        let mut incoming_counts: HashMap<&str, usize> = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.as_str(), 0))
            .collect();
        for action in &document.action_nodes {
            for option in &action.options {
                if let Some(count) = incoming_counts.get_mut(option.as_str()) {
                    *count += 1;
                }
            }
        }
        let orphaned_stages: Vec<&str> = document
            .stage_nodes
            .iter()
            .filter(|stage| {
                !stage.square_one
                    && incoming_counts
                        .get(stage.uuid.as_str())
                        .copied()
                        .unwrap_or_default()
                        == 0
            })
            .map(|stage| stage.name.as_str())
            .collect();
        assert!(
            orphaned_stages.is_empty(),
            "unexpected orphaned stages: {:?}",
            orphaned_stages
        );

        let mut action_incoming_counts: HashMap<&str, usize> = document
            .action_nodes
            .iter()
            .map(|action| (action.id.as_str(), 0))
            .collect();
        for stage in &document.stage_nodes {
            for transition in [stage.ok_transition.as_ref(), stage.home_transition.as_ref()]
                .into_iter()
                .flatten()
            {
                if let Some(count) = action_incoming_counts.get_mut(transition.action_node.as_str())
                {
                    *count += 1;
                }
            }
        }
        let orphaned_actions: Vec<&str> = document
            .action_nodes
            .iter()
            .filter(|action| {
                action_incoming_counts
                    .get(action.id.as_str())
                    .copied()
                    .unwrap_or_default()
                    == 0
            })
            .map(|action| action.name.as_str())
            .collect();
        assert!(
            orphaned_actions.is_empty(),
            "unexpected orphaned actions: {:?}",
            orphaned_actions
        );
    }

    #[test]
    fn omits_menu_image_when_auto_black_image_is_enabled() {
        let report = report_for(
            CanonicalProject {
                name: "No image menu".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                    name: "Menu sans image".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: true,
                    children: vec![CanonicalEntry::Story(CanonicalStory {
                        name: "Story".to_string(),
                        audio: Some("story.mp3".to_string()),
                        item_audio: Some("item.mp3".to_string()),
                        item_image: Some("item.png".to_string()),
                        ..Default::default()
                    })],
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Menu sans image/menuAudio", "menu.mp3"),
                prepared_asset("root/Menu sans image/Story/itemAudio", "item.mp3"),
                prepared_asset("root/Menu sans image/Story/itemImage", "item.png"),
                prepared_asset("root/Menu sans image/Story/storyAudio", "story.mp3"),
            ],
            Vec::new(),
        );

        let document = build_story_document(&report).expect("auto black menu document");
        let menu_stage = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Menu sans image")
            .expect("menu stage");

        assert!(menu_stage.image.is_none());
        assert!(menu_stage.control_settings.autoplay);
    }

    #[test]
    fn builds_regular_imported_zip_under_root() {
        let imported = StoryDocument {
            title: "Imported".to_string(),
            version: 1,
            description: String::new(),
            format: "v1".to_string(),
            night_mode_available: false,
            action_nodes: vec![
                ActionNode {
                    id: "import-root-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["import-menu".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "import-menu-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["import-title".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "import-play-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["import-play".to_string()],
                    position: zero_position(),
                },
            ],
            stage_nodes: vec![
                StageNode {
                    uuid: "import-cover".to_string(),
                    name: "Cover node".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: true,
                    audio: Some("import-cover.mp3".to_string()),
                    image: Some("import-cover.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: true,
                        ok: true,
                        home: false,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: None,
                    ok_transition: Some(transition("import-root-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "import-menu".to_string(),
                    name: "Imported menu".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("import-menu.mp3".to_string()),
                    image: Some("import-menu.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: false,
                        ok: true,
                        home: true,
                        pause: false,
                        autoplay: true,
                    },
                    home_transition: None,
                    ok_transition: Some(transition("import-menu-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "import-title".to_string(),
                    name: "Imported title".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("import-item.mp3".to_string()),
                    image: Some("import-item.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: true,
                        ok: true,
                        home: true,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: Some(transition("import-root-action", 0)),
                    ok_transition: Some(transition("import-play-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "import-play".to_string(),
                    name: "Imported play".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("import-story.mp3".to_string()),
                    image: None,
                    control_settings: playback_controls(),
                    home_transition: Some(transition("import-menu-action", 0)),
                    ok_transition: Some(transition("import-menu-action", 0)),
                    position: zero_position(),
                },
            ],
        };

        let report = report_for(
            CanonicalProject {
                name: "Pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Zip(CanonicalZip {
                    name: "Imported pack".to_string(),
                    zip_path: Some("imported.zip".to_string()),
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset(
                    "root/Imported pack / imported import-cover.mp3",
                    "import-cover.mp3",
                ),
                prepared_asset(
                    "root/Imported pack / imported import-cover.png",
                    "import-cover.png",
                ),
                prepared_asset(
                    "root/Imported pack / imported import-menu.mp3",
                    "import-menu.mp3",
                ),
                prepared_asset(
                    "root/Imported pack / imported import-menu.png",
                    "import-menu.png",
                ),
                prepared_asset(
                    "root/Imported pack / imported import-item.mp3",
                    "import-item.mp3",
                ),
                prepared_asset(
                    "root/Imported pack / imported import-item.png",
                    "import-item.png",
                ),
                prepared_asset(
                    "root/Imported pack / imported import-story.mp3",
                    "import-story.mp3",
                ),
            ],
            vec![imported_zip_bundle(
                "root/Imported pack/zip",
                "import-cover",
                "import-root-action",
                "import-menu",
                "import-cover",
                imported,
            )],
        );

        let document = build_story_document(&report).expect("regular imported zip");
        let imported_cover = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Cover node" && !stage.square_one)
            .expect("imported cover");
        let imported_menu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Imported menu")
            .expect("imported menu");
        let imported_title = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Imported title")
            .expect("imported title");
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![imported_cover.uuid.clone()])
            .expect("root action");
        let imported_root_action = document
            .action_nodes
            .iter()
            .find(|action| {
                action.id != root_action.id && action.options == vec![imported_menu.uuid.clone()]
            })
            .expect("imported root action");

        assert_eq!(
            imported_cover
                .ok_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(imported_root_action.id.as_str())
        );
        assert!(imported_cover.home_transition.is_none());
        assert!(!imported_menu.square_one);
        assert_eq!(
            imported_menu
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            imported_menu
                .home_transition
                .as_ref()
                .map(|transition| transition.option_index),
            Some(0)
        );
        assert_eq!(
            imported_title
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(imported_root_action.id.as_str())
        );
    }

    #[test]
    fn builds_collection_import_without_extra_square_one() {
        let imported = StoryDocument {
            title: "Collection".to_string(),
            version: 1,
            description: String::new(),
            format: "v1".to_string(),
            night_mode_available: false,
            action_nodes: vec![
                ActionNode {
                    id: "collection-root-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["collection-menu".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "collection-menu-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["child-cover".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "child-root-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["child-story".to_string()],
                    position: zero_position(),
                },
            ],
            stage_nodes: vec![
                StageNode {
                    uuid: "collection-cover".to_string(),
                    name: "Cover node".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: true,
                    audio: Some("collection-cover.mp3".to_string()),
                    image: Some("collection-cover.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: true,
                        ok: true,
                        home: false,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: None,
                    ok_transition: Some(transition("collection-root-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "collection-menu".to_string(),
                    name: "Collection menu".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("collection-menu.mp3".to_string()),
                    image: Some("collection-menu.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: false,
                        ok: true,
                        home: true,
                        pause: false,
                        autoplay: true,
                    },
                    home_transition: None,
                    ok_transition: Some(transition("collection-menu-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "child-cover".to_string(),
                    name: "Cover node".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("child-cover.mp3".to_string()),
                    image: Some("child-cover.png".to_string()),
                    control_settings: ControlSettings {
                        wheel: true,
                        ok: true,
                        home: true,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: Some(transition("collection-root-action", 0)),
                    ok_transition: Some(transition("child-root-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "child-story".to_string(),
                    name: "Child story".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("child-story.mp3".to_string()),
                    image: None,
                    control_settings: simple_story_controls(),
                    home_transition: Some(transition("collection-menu-action", 0)),
                    ok_transition: None,
                    position: zero_position(),
                },
            ],
        };

        let report = report_for(
            CanonicalProject {
                name: "Pack".to_string(),
                project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
                root_audio: Some("root.mp3".to_string()),
                root_image: Some("root.png".to_string()),
                thumbnail_image: None,
                night_mode_audio: None,
                night_mode_return: None,
                night_mode_home_return: None,
                native_graph: None,
                options: CanonicalOptions {
                    convert_format: false,
                    add_silence: false,
                    auto_next: false,
                    select_next: false,
                    night_mode: false,
                },
                entries: vec![CanonicalEntry::Zip(CanonicalZip {
                    name: "Collection import".to_string(),
                    zip_path: Some("collection.zip".to_string()),
                    ..Default::default()
                })],
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset(
                    "root/Collection import / imported collection-cover.mp3",
                    "collection-cover.mp3",
                ),
                prepared_asset(
                    "root/Collection import / imported collection-cover.png",
                    "collection-cover.png",
                ),
                prepared_asset(
                    "root/Collection import / imported collection-menu.mp3",
                    "collection-menu.mp3",
                ),
                prepared_asset(
                    "root/Collection import / imported collection-menu.png",
                    "collection-menu.png",
                ),
                prepared_asset(
                    "root/Collection import / imported child-cover.mp3",
                    "child-cover.mp3",
                ),
                prepared_asset(
                    "root/Collection import / imported child-cover.png",
                    "child-cover.png",
                ),
                prepared_asset(
                    "root/Collection import / imported child-story.mp3",
                    "child-story.mp3",
                ),
            ],
            vec![imported_zip_bundle(
                "root/Collection import/zip",
                "collection-cover",
                "collection-root-action",
                "collection-menu",
                "collection-cover",
                imported,
            )],
        );

        let document = build_story_document(&report).expect("collection imported zip");
        let collection_menu = document
            .stage_nodes
            .iter()
            .find(|stage| stage.name == "Collection menu")
            .expect("collection menu");
        let child_cover = document
            .stage_nodes
            .iter()
            .find(|stage| stage.audio.as_deref() == Some("child-cover.mp3"))
            .expect("child cover");
        let root_action = document
            .action_nodes
            .iter()
            .find(|action| action.options == vec![collection_menu.uuid.clone()])
            .expect("root action");

        assert_eq!(
            document
                .stage_nodes
                .iter()
                .filter(|stage| stage.square_one)
                .count(),
            1
        );
        assert!(document
            .stage_nodes
            .iter()
            .all(|stage| stage.uuid != "collection-cover"));
        assert_eq!(
            child_cover
                .home_transition
                .as_ref()
                .map(|transition| transition.action_node.as_str()),
            Some(root_action.id.as_str())
        );
        assert_eq!(
            child_cover
                .home_transition
                .as_ref()
                .map(|transition| transition.option_index),
            Some(0)
        );
    }

    #[test]
    fn deserializes_story_document_with_float_positions() {
        let json = r#"{
          "title": "Float positions",
          "version": 1,
          "description": "",
          "format": "v1",
          "nightModeAvailable": false,
          "actionNodes": [
            {
              "id": "root-action",
              "name": "Action node",
              "options": ["stage-1"],
              "position": { "x": 905.5, "y": 40 }
            }
          ],
          "stageNodes": [
            {
              "uuid": "stage-1",
              "name": "Cover node",
              "type": "stage",
              "squareOne": true,
              "audio": "cover.mp3",
              "image": "cover.png",
              "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": false,
                "pause": false,
                "autoplay": false
              },
              "homeTransition": null,
              "okTransition": {
                "actionNode": "root-action",
                "optionIndex": 0
              },
              "position": { "x": 100, "y": 120.25 }
            }
          ]
        }"#;

        let document: StoryDocument =
            serde_json::from_str(json).expect("story document with float positions");

        assert_eq!(document.action_nodes.len(), 1);
        assert_eq!(document.stage_nodes.len(), 1);
        assert_eq!(document.action_nodes[0].position.x.as_f64(), Some(905.5));
        assert_eq!(document.stage_nodes[0].position.y.as_f64(), Some(120.25));
    }

    #[test]
    fn deserializes_stage_without_square_one_flag() {
        let json = r#"{
          "title": "Missing square one",
          "version": 1,
          "description": "",
          "format": "v1",
          "nightModeAvailable": false,
          "actionNodes": [
            {
              "id": "root-action",
              "name": "Action node",
              "options": ["stage-1"],
              "position": { "x": 0, "y": 0 }
            }
          ],
          "stageNodes": [
            {
              "uuid": "stage-1",
              "name": "Stage sans flag",
              "type": "stage",
              "audio": "cover.mp3",
              "image": "cover.png",
              "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": false,
                "pause": false,
                "autoplay": false
              },
              "homeTransition": null,
              "okTransition": {
                "actionNode": "root-action",
                "optionIndex": 0
              },
              "position": { "x": 0, "y": 0 }
            }
          ]
        }"#;

        let document: StoryDocument =
            serde_json::from_str(json).expect("story document without squareOne");

        assert_eq!(document.stage_nodes.len(), 1);
        assert!(!document.stage_nodes[0].square_one);
    }

    #[test]
    fn normalizes_stage_ports_for_studio_compatibility() {
        // Verifies that normalize_document_for_studio_compat enables the ok/home port flags
        // when transitions exist but the corresponding flags are off.
        // Uses distinct non-circular transition targets to satisfy the structural validator.
        let mut document = StoryDocument {
            title: "Compat".to_string(),
            version: 1,
            description: String::new(),
            format: "v1".to_string(),
            night_mode_available: false,
            action_nodes: vec![
                ActionNode {
                    id: "root-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["source-stage".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "home-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["home-dest".to_string()],
                    position: zero_position(),
                },
                ActionNode {
                    id: "ok-action".to_string(),
                    name: "Action node".to_string(),
                    options: vec!["ok-dest".to_string()],
                    position: zero_position(),
                },
            ],
            stage_nodes: vec![
                StageNode {
                    uuid: "source-stage".to_string(),
                    name: "Source".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: true,
                    audio: Some("cover.mp3".to_string()),
                    image: None,
                    control_settings: ControlSettings {
                        wheel: true,
                        ok: false,
                        home: false,
                        pause: true,
                        autoplay: false,
                    },
                    home_transition: Some(transition("home-action", 0)),
                    ok_transition: Some(transition("ok-action", 0)),
                    position: zero_position(),
                },
                StageNode {
                    uuid: "home-dest".to_string(),
                    name: "Home dest".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("a.mp3".to_string()),
                    image: None,
                    control_settings: ControlSettings {
                        wheel: false,
                        ok: false,
                        home: false,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: None,
                    ok_transition: None,
                    position: zero_position(),
                },
                StageNode {
                    uuid: "ok-dest".to_string(),
                    name: "Ok dest".to_string(),
                    stage_type: "stage".to_string(),
                    square_one: false,
                    audio: Some("b.mp3".to_string()),
                    image: None,
                    control_settings: ControlSettings {
                        wheel: false,
                        ok: false,
                        home: false,
                        pause: false,
                        autoplay: false,
                    },
                    home_transition: None,
                    ok_transition: None,
                    position: zero_position(),
                },
            ],
        };

        normalize_document_for_studio_compat(&mut document);

        let stage = &document.stage_nodes[0];
        assert!(stage.control_settings.ok);
        assert!(stage.control_settings.home);
        validate_document_for_studio_compat(&document).expect("validated document");
    }

    #[test]
    fn rejects_missing_transition_targets_for_studio_compatibility() {
        let document = StoryDocument {
            title: "Compat".to_string(),
            version: 1,
            description: String::new(),
            format: "v1".to_string(),
            night_mode_available: false,
            action_nodes: vec![ActionNode {
                id: "root-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["known-stage".to_string()],
                position: zero_position(),
            }],
            stage_nodes: vec![StageNode {
                uuid: "known-stage".to_string(),
                name: "Broken stage".to_string(),
                stage_type: "stage".to_string(),
                square_one: true,
                audio: Some("cover.mp3".to_string()),
                image: None,
                control_settings: ControlSettings {
                    wheel: false,
                    ok: true,
                    home: false,
                    pause: true,
                    autoplay: false,
                },
                home_transition: None,
                ok_transition: Some(transition("missing-action", 0)),
                position: zero_position(),
            }],
        };

        let error = validate_document_for_studio_compat(&document).expect_err("invalid document");
        assert!(error.contains("missing-action"));
    }

    // ── Fidelity tests (structure navigation) ─────────────────────────────────

    fn apply_skip_silence_entry(entry: &mut ProjectEntry) {
        for key in &["audio", "itemAudio", "afterPlaybackPromptAudio"] {
            entry.audio_processing.insert(
                (*key).to_string(),
                AudioFieldProcessing { skip_silence: true },
            );
        }
        for child in &mut entry.children {
            apply_skip_silence_entry(child);
        }
    }

    fn rewrite_fidelity_nav(target: Option<String>, promoted_id: &str) -> Option<String> {
        let t = target?;
        if t.is_empty() {
            return None;
        }
        if t == format!("menu:{}", promoted_id) {
            Some("root".to_string())
        } else {
            Some(t)
        }
    }

    fn rewrite_fidelity_entry(entry: &mut ProjectEntry, promoted_id: &str) {
        entry.return_after_play = rewrite_fidelity_nav(entry.return_after_play.take(), promoted_id);
        entry.return_on_home = rewrite_fidelity_nav(entry.return_on_home.take(), promoted_id);
        entry.title_return_on_home =
            rewrite_fidelity_nav(entry.title_return_on_home.take(), promoted_id);
        entry.after_playback_prompt_ok_target =
            rewrite_fidelity_nav(entry.after_playback_prompt_ok_target.take(), promoted_id);
        entry.after_playback_prompt_home_target =
            rewrite_fidelity_nav(entry.after_playback_prompt_home_target.take(), promoted_id);
        for step in &mut entry.after_playback_sequence {
            step.ok_target = rewrite_fidelity_nav(step.ok_target.take(), promoted_id);
            step.home_target = rewrite_fidelity_nav(step.home_target.take(), promoted_id);
        }
        for child in &mut entry.children {
            rewrite_fidelity_entry(child, promoted_id);
        }
    }

    fn fidelity_project(extracted: &serde_json::Value, title: &str) -> Project {
        let root_audio = extracted["rootAudio"].as_str().map(str::to_string);
        let root_image = extracted["rootImage"].as_str().map(str::to_string);
        let night_mode = extracted["nightMode"].as_bool().unwrap_or(false);
        let night_mode_audio = extracted["nightModeAudio"].as_str().map(str::to_string);
        let night_mode_return = extracted["nightModeReturn"].as_str().map(str::to_string);
        let night_mode_home_return = extracted["nightModeHomeReturn"]
            .as_str()
            .map(str::to_string);
        let wrapper_id = extracted["rootId"].as_str().unwrap_or("").to_string();

        let mut entries: Vec<ProjectEntry> =
            serde_json::from_value(extracted["entries"].clone()).expect("parse extracted entries");
        for entry in &mut entries {
            apply_skip_silence_entry(entry);
            rewrite_fidelity_entry(entry, &wrapper_id);
        }

        let mut ap: HashMap<String, AudioFieldProcessing> = HashMap::new();
        if root_audio.is_some() {
            ap.insert(
                "rootAudio".to_string(),
                AudioFieldProcessing { skip_silence: true },
            );
        }
        if night_mode_audio.is_some() {
            ap.insert(
                "nightModeAudio".to_string(),
                AudioFieldProcessing { skip_silence: true },
            );
        }

        Project {
            name: title.to_string(),
            project_type: Some("pack".to_string()),
            root_audio: root_audio.clone(),
            root_image: root_image.clone(),
            thumbnail_image: root_image,
            night_mode_audio: if night_mode { night_mode_audio } else { None },
            night_mode_return: if night_mode { night_mode_return } else { None },
            night_mode_home_return: if night_mode {
                night_mode_home_return
            } else {
                None
            },
            native_graph: extracted
                .get("nativeGraph")
                .filter(|value| !value.is_null())
                .cloned(),
            audio_processing: ap,
            root_entries: entries,
            root_items: vec![],
            global_options: GlobalOptions {
                convert_format: false,
                add_silence: false,
                auto_next: false,
                select_next: false,
                night_mode,
            },
            pack_version: 1,
            pack_description: String::new(),
            menus: vec![],
        }
    }

    fn fidelity_fake_assets(
        canonical: &CanonicalProject,
        ap: &HashMap<String, AudioFieldProcessing>,
    ) -> Vec<PreparedAsset> {
        collect_asset_requests(canonical, ap)
            .into_iter()
            .enumerate()
            .map(|(i, req)| {
                let ext = match req.source_kind {
                    AssetSourceKind::Image => "bmp",
                    _ => "mp3",
                };
                prepared_asset(&req.role, &format!("f{}.{}", i, ext))
            })
            .collect()
    }

    #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
    struct FidelityStageTargetShape {
        square_one: bool,
        has_audio: bool,
        has_image: bool,
        wheel: bool,
        ok: bool,
        home: bool,
        pause: bool,
        autoplay: bool,
    }

    #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
    struct FidelityStageShape {
        square_one: bool,
        has_audio: bool,
        has_image: bool,
        wheel: bool,
        ok: bool,
        home: bool,
        pause: bool,
        autoplay: bool,
        has_ok_transition: bool,
        has_home_transition: bool,
        ok_target: Option<FidelityStageTargetShape>,
        home_target: Option<FidelityStageTargetShape>,
    }

    fn fidelity_target_shape(stage: &StageNode) -> FidelityStageTargetShape {
        FidelityStageTargetShape {
            square_one: stage.square_one,
            has_audio: stage.audio.is_some(),
            has_image: stage.image.is_some(),
            wheel: stage.control_settings.wheel,
            ok: stage.control_settings.ok,
            home: stage.control_settings.home,
            pause: stage.control_settings.pause,
            autoplay: stage.control_settings.autoplay,
        }
    }

    fn fidelity_transition_target<'a>(
        transition: Option<&Transition>,
        actions: &HashMap<&'a str, &'a ActionNode>,
        stages: &HashMap<&'a str, &'a StageNode>,
    ) -> Option<&'a StageNode> {
        let transition = transition?;
        if transition.option_index < 0 {
            return None;
        }
        let action = actions.get(transition.action_node.as_str())?;
        let stage_id = action.options.get(transition.option_index as usize)?;
        stages.get(stage_id.as_str()).copied()
    }

    fn fidelity_stage_shapes(
        document: &StoryDocument,
    ) -> std::collections::BTreeMap<FidelityStageShape, usize> {
        fidelity_stage_shape_names(document)
            .into_iter()
            .map(|(shape, names)| (shape, names.len()))
            .collect()
    }

    fn fidelity_stage_shape_names(
        document: &StoryDocument,
    ) -> std::collections::BTreeMap<FidelityStageShape, Vec<String>> {
        let actions: HashMap<&str, &ActionNode> = document
            .action_nodes
            .iter()
            .map(|action| (action.id.as_str(), action))
            .collect();
        let stages: HashMap<&str, &StageNode> = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.as_str(), stage))
            .collect();
        let mut shapes = std::collections::BTreeMap::new();
        for stage in &document.stage_nodes {
            let ok_target =
                fidelity_transition_target(stage.ok_transition.as_ref(), &actions, &stages)
                    .map(fidelity_target_shape);
            let home_target =
                fidelity_transition_target(stage.home_transition.as_ref(), &actions, &stages)
                    .map(fidelity_target_shape);
            let shape = FidelityStageShape {
                square_one: stage.square_one,
                has_audio: stage.audio.is_some(),
                has_image: stage.image.is_some(),
                wheel: stage.control_settings.wheel,
                ok: stage.control_settings.ok,
                home: stage.control_settings.home,
                pause: stage.control_settings.pause,
                autoplay: stage.control_settings.autoplay,
                has_ok_transition: stage.ok_transition.is_some(),
                has_home_transition: stage.home_transition.is_some(),
                ok_target,
                home_target,
            };
            shapes.entry(shape).or_insert_with(Vec::new).push(format!(
                "{} | ok={} | home={}",
                stage.name,
                fidelity_transition_target(stage.ok_transition.as_ref(), &actions, &stages)
                    .map(|target| target.name.as_str())
                    .unwrap_or("-"),
                fidelity_transition_target(stage.home_transition.as_ref(), &actions, &stages)
                    .map(|target| target.name.as_str())
                    .unwrap_or("-")
            ));
        }
        shapes
    }

    fn assert_fidelity_stage_shapes(
        original: &StoryDocument,
        generated: &StoryDocument,
        pack_id: &str,
    ) {
        let orig_shapes = fidelity_stage_shapes(original);
        let gen_shapes = fidelity_stage_shapes(generated);
        if gen_shapes != orig_shapes {
            eprintln!(
                "[{pack_id}] strict diff:\n{}",
                fidelity_stage_shape_diff(original, generated)
            );
        }
        assert_eq!(
            gen_shapes, orig_shapes,
            "[{pack_id}] formes de stages/navigation differentes",
        );
    }

    fn fidelity_stage_shape_diff(original: &StoryDocument, generated: &StoryDocument) -> String {
        let orig_names = fidelity_stage_shape_names(original);
        let gen_names = fidelity_stage_shape_names(generated);
        let mut keys: std::collections::BTreeSet<FidelityStageShape> =
            orig_names.keys().cloned().collect();
        keys.extend(gen_names.keys().cloned());
        let mut lines = Vec::new();
        for key in keys {
            let orig = orig_names.get(&key).map(Vec::as_slice).unwrap_or(&[]);
            let gen = gen_names.get(&key).map(Vec::as_slice).unwrap_or(&[]);
            if orig.len() == gen.len() {
                continue;
            }
            lines.push(format!(
                "generated={} original={} shape={:?}",
                gen.len(),
                orig.len(),
                key
            ));
            lines.push(format!(
                "  generated examples: {}",
                gen.iter().take(5).cloned().collect::<Vec<_>>().join(" | ")
            ));
            lines.push(format!(
                "  original examples: {}",
                orig.iter().take(5).cloned().collect::<Vec<_>>().join(" | ")
            ));
        }
        lines.join("\n")
    }

    #[derive(Default)]
    struct FidelityProjectCounts {
        menus: usize,
        imported_continuation_menus: usize,
        stories: usize,
        story_wheel: usize,
        story_autoplay: usize,
        story_wheel_autoplay: usize,
        stories_with_sequence: usize,
        sequence_steps: usize,
        stories_with_prompt: usize,
    }

    fn collect_fidelity_project_counts(
        entries: &[ProjectEntry],
        counts: &mut FidelityProjectCounts,
    ) {
        for entry in entries {
            match entry.entry_type.as_str() {
                "menu" => {
                    counts.menus += 1;
                    if entry.id.contains("-sequence-choice-") {
                        counts.imported_continuation_menus += 1;
                    }
                    collect_fidelity_project_counts(&entry.children, counts);
                }
                "story" => {
                    counts.stories += 1;
                    let controls = entry.control_settings.as_ref();
                    let wheel = controls.and_then(|c| c.wheel).unwrap_or(false);
                    let autoplay = controls.and_then(|c| c.autoplay).unwrap_or(false);
                    if wheel {
                        counts.story_wheel += 1;
                    }
                    if autoplay {
                        counts.story_autoplay += 1;
                    }
                    if wheel && autoplay {
                        counts.story_wheel_autoplay += 1;
                    }
                    if !entry.after_playback_sequence.is_empty() {
                        counts.stories_with_sequence += 1;
                        counts.sequence_steps += entry.after_playback_sequence.len();
                    }
                    if entry.after_playback_prompt_audio.is_some() {
                        counts.stories_with_prompt += 1;
                    }
                }
                _ => collect_fidelity_project_counts(&entry.children, counts),
            }
        }
    }

    fn fidelity_stage_count_summary(document: &StoryDocument) -> (usize, usize, usize, usize) {
        let total = document.stage_nodes.len();
        let wheel = document
            .stage_nodes
            .iter()
            .filter(|stage| stage.control_settings.wheel)
            .count();
        let autoplay = document
            .stage_nodes
            .iter()
            .filter(|stage| stage.control_settings.autoplay)
            .count();
        let wheel_autoplay = document
            .stage_nodes
            .iter()
            .filter(|stage| stage.control_settings.wheel && stage.control_settings.autoplay)
            .count();
        (total, wheel, autoplay, wheel_autoplay)
    }

    fn report_fidelity_diagnostics(
        pack_id: &str,
        orig: &StoryDocument,
        gen: &StoryDocument,
        project: &Project,
    ) {
        let mut project_counts = FidelityProjectCounts::default();
        collect_fidelity_project_counts(&project.root_entries, &mut project_counts);
        let (orig_total, orig_wheel, orig_auto, orig_wheel_auto) =
            fidelity_stage_count_summary(orig);
        let (gen_total, gen_wheel, gen_auto, gen_wheel_auto) = fidelity_stage_count_summary(gen);
        eprintln!(
            "[{pack_id}] stages original={orig_total} generated={gen_total} delta={}",
            gen_total as isize - orig_total as isize
        );
        eprintln!(
            "[{pack_id}] wheel original={orig_wheel} generated={gen_wheel}; autoplay original={orig_auto} generated={gen_auto}; wheel+autoplay original={orig_wheel_auto} generated={gen_wheel_auto}"
        );
        eprintln!(
            "[{pack_id}] project menus={} continuation_menus={} stories={} story_wheel={} story_autoplay={} story_wheel+autoplay={} stories_with_sequence={} sequence_steps={} stories_with_prompt={}",
            project_counts.menus,
            project_counts.imported_continuation_menus,
            project_counts.stories,
            project_counts.story_wheel,
            project_counts.story_autoplay,
            project_counts.story_wheel_autoplay,
            project_counts.stories_with_sequence,
            project_counts.sequence_steps,
            project_counts.stories_with_prompt
        );
        let shape_diff = fidelity_stage_shape_diff(orig, gen);
        if !shape_diff.is_empty() {
            eprintln!("[{pack_id}] strict diff:\n{shape_diff}");
        }
    }

    fn assert_fidelity(zip_path: Option<String>, pack_id: &str) {
        let Some(zip_path) = zip_path else {
            return;
        };

        let tmp = std::env::temp_dir().join(format!("fidelity_{}_{}", pack_id, now_millis()));
        std::fs::create_dir_all(&tmp).expect("create tmp dir");

        let orig_str = crate::services::pack_reader::load_pack_zip(&zip_path)
            .unwrap_or_else(|e| panic!("[{pack_id}] load_pack_zip: {e}"));
        let orig: StoryDocument = serde_json::from_str(&orig_str)
            .unwrap_or_else(|e| panic!("[{pack_id}] parse orig story.json: {e}"));

        let extracted =
            crate::services::pack_reader::unpack_zip_to_entries(&zip_path, tmp.to_str().unwrap())
                .unwrap_or_else(|e| panic!("[{pack_id}] unpack_zip_to_entries: {e}"));

        let pack_title = if orig.title.trim().is_empty() {
            "Pack importé".to_string()
        } else {
            orig.title.clone()
        };
        let project = fidelity_project(&extracted, &pack_title);
        if std::env::var_os("LUNII_FIDELITY_DUMP_PROJECT").is_some() {
            eprintln!(
                "[{pack_id}] extracted project:\n{}",
                serde_json::to_string_pretty(&extracted).unwrap_or_default()
            );
        }
        let canonical = canonicalize_project(&project);
        let assets = fidelity_fake_assets(&canonical, &project.audio_processing);
        let report = report_for(canonical, assets, vec![]);

        let gen = build_story_document(&report)
            .unwrap_or_else(|e| panic!("[{pack_id}] build_story_document: {e}"));
        if let Some(dump_dir) = std::env::var_os("LUNII_FIDELITY_DUMP_DOCS") {
            let dump_dir = std::path::PathBuf::from(dump_dir);
            std::fs::create_dir_all(&dump_dir).expect("create fidelity dump dir");
            std::fs::write(
                dump_dir.join(format!("{pack_id}.original.story.json")),
                serde_json::to_string_pretty(&orig).unwrap_or_default(),
            )
            .expect("write original story dump");
            std::fs::write(
                dump_dir.join(format!("{pack_id}.generated.story.json")),
                serde_json::to_string_pretty(&gen).unwrap_or_default(),
            )
            .expect("write generated story dump");
            std::fs::write(
                dump_dir.join(format!("{pack_id}.project.json")),
                serde_json::to_string_pretty(&extracted).unwrap_or_default(),
            )
            .expect("write project dump");
        }

        let orig_stages = orig.stage_nodes.len();
        let gen_stages = gen.stage_nodes.len();
        let orig_wheel = orig
            .stage_nodes
            .iter()
            .filter(|s| s.control_settings.wheel)
            .count();
        let gen_wheel = gen
            .stage_nodes
            .iter()
            .filter(|s| s.control_settings.wheel)
            .count();
        let orig_auto = orig
            .stage_nodes
            .iter()
            .filter(|s| s.control_settings.autoplay)
            .count();
        let gen_auto = gen
            .stage_nodes
            .iter()
            .filter(|s| s.control_settings.autoplay)
            .count();

        if std::env::var_os("LUNII_FIDELITY_REPORT").is_some() {
            report_fidelity_diagnostics(pack_id, &orig, &gen, &project);
        }

        assert!(
            gen.stage_nodes.iter().any(|s| s.square_one),
            "[{pack_id}] squareOne stage manquant",
        );
        assert_eq!(
            gen_stages, orig_stages,
            "[{pack_id}] stages : généré={gen_stages} original={orig_stages}",
        );
        assert_eq!(
            gen_wheel, orig_wheel,
            "[{pack_id}] wheel stages : généré={gen_wheel} original={orig_wheel}",
        );
        assert_eq!(
            gen_auto, orig_auto,
            "[{pack_id}] autoplay stages : généré={gen_auto} original={orig_auto}",
        );
        assert_eq!(
            gen.night_mode_available, orig.night_mode_available,
            "[{pack_id}] nightModeAvailable : généré={} original={}",
            gen.night_mode_available, orig.night_mode_available,
        );
        validate_document_for_studio_compat(&gen)
            .unwrap_or_else(|e| panic!("[{pack_id}] validation STUdio : {e}"));
        if std::env::var_os("LUNII_FIDELITY_STRICT").is_some() {
            assert_fidelity_stage_shapes(&orig, &gen, pack_id);
        } else if fidelity_stage_shapes(&orig) != fidelity_stage_shapes(&gen) {
            eprintln!(
                "[{pack_id}] strict navigation probe differs; set LUNII_FIDELITY_STRICT=1 to fail on it"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Structural-only fidelity: verifies generation succeeds and produces a
    /// STUdio-compatible document. Does NOT compare stage counts against the
    /// original because some packs use a model that differs structurally from
    /// our editable projection (wheel+auto merged stages, shared nodes).
    fn assert_fidelity_structural(zip_path: Option<String>, pack_id: &str) {
        let Some(zip_path) = zip_path else {
            return;
        };

        let tmp = std::env::temp_dir().join(format!("fidelity_{}_{}", pack_id, now_millis()));
        std::fs::create_dir_all(&tmp).expect("create tmp dir");

        let orig_str = crate::services::pack_reader::load_pack_zip(&zip_path)
            .unwrap_or_else(|e| panic!("[{pack_id}] load_pack_zip: {e}"));
        let orig: StoryDocument = serde_json::from_str(&orig_str)
            .unwrap_or_else(|e| panic!("[{pack_id}] parse orig story.json: {e}"));

        let extracted =
            crate::services::pack_reader::unpack_zip_to_entries(&zip_path, tmp.to_str().unwrap())
                .unwrap_or_else(|e| panic!("[{pack_id}] unpack_zip_to_entries: {e}"));

        let pack_title = if orig.title.trim().is_empty() {
            "Pack importé".to_string()
        } else {
            orig.title.clone()
        };
        let project = fidelity_project(&extracted, &pack_title);
        let canonical = canonicalize_project(&project);
        let assets = fidelity_fake_assets(&canonical, &project.audio_processing);
        let report = report_for(canonical, assets, vec![]);

        let gen = build_story_document(&report)
            .unwrap_or_else(|e| panic!("[{pack_id}] build_story_document: {e}"));

        if std::env::var_os("LUNII_FIDELITY_REPORT").is_some() {
            report_fidelity_diagnostics(pack_id, &orig, &gen, &project);
        }

        assert!(
            gen.stage_nodes.iter().any(|s| s.square_one),
            "[{pack_id}] squareOne stage manquant",
        );
        assert_eq!(
            gen.night_mode_available, orig.night_mode_available,
            "[{pack_id}] nightModeAvailable : généré={} original={}",
            gen.night_mode_available, orig.night_mode_available,
        );
        validate_document_for_studio_compat(&gen)
            .unwrap_or_else(|e| panic!("[{pack_id}] validation STUdio : {e}"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn fidelity_pack_id(path: &std::path::Path) -> String {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.trim().is_empty())
            .unwrap_or("PACK")
            .to_string()
    }

    fn fidelity_pack_paths_from_env() -> Vec<(String, String)> {
        let mut packs = Vec::new();

        if let Some(path) = std::env::var_os("LUNII_FIDELITY_PACK") {
            let path = std::path::PathBuf::from(path);
            let pack_id =
                std::env::var("LUNII_FIDELITY_PACK_ID").unwrap_or_else(|_| fidelity_pack_id(&path));
            packs.push((pack_id, path.to_string_lossy().to_string()));
        }

        if let Some(dir) = std::env::var_os("LUNII_FIDELITY_PACK_DIR") {
            let dir = std::path::PathBuf::from(dir);
            if !dir.exists() {
                eprintln!("[FIDELITY] SKIP - dossier absent : {}", dir.display());
            } else {
                let mut paths: Vec<_> = std::fs::read_dir(&dir)
                    .unwrap_or_else(|e| {
                        panic!("[FIDELITY] lecture dossier packs {} : {e}", dir.display())
                    })
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "zip" | "7z"))
                            .unwrap_or(false)
                    })
                    .collect();
                paths.sort();
                packs.extend(paths.into_iter().map(|path| {
                    let pack_id = fidelity_pack_id(&path);
                    (pack_id, path.to_string_lossy().to_string())
                }));
            }
        }

        packs
    }

    #[test]
    fn fidelity_external_packs_from_env() {
        let packs = fidelity_pack_paths_from_env();
        if packs.is_empty() {
            eprintln!(
                "[FIDELITY] SKIP - definir LUNII_FIDELITY_PACK ou LUNII_FIDELITY_PACK_DIR pour tester des packs externes"
            );
            return;
        }

        let structural_only = std::env::var_os("LUNII_FIDELITY_STRUCTURAL").is_some();
        for (pack_id, path) in packs {
            if structural_only {
                assert_fidelity_structural(Some(path), &pack_id);
            } else {
                assert_fidelity(Some(path), &pack_id);
            }
        }
    }
}
