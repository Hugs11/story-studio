use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};
use crate::support::imported_pack::ensure_studio_pack_zip;

const MAX_STORY_JSON_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES: u64 = 5 * 1024 * 1024 * 1024;

fn ensure_zip_entry_count(len: usize, zip_path: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err(format!(
            "Archive trop volumineuse : {} entrees dans {} (maximum {}).",
            len,
            zip_path.display(),
            ARCHIVE_MAX_ENTRIES
        ));
    }
    Ok(())
}

fn ensure_zip_entry_size(kind: &str, name: &str, size: u64, max: u64) -> Result<(), String> {
    if size > max {
        return Err(format!(
            "{} trop volumineux : {} fait {} Mo (maximum {} Mo).",
            kind,
            name,
            size / 1024 / 1024,
            max / 1024 / 1024
        ));
    }
    Ok(())
}

pub(crate) fn validate_pack_asset_name(asset_name: &str) -> Result<String, String> {
    let trimmed = asset_name.trim();
    if trimmed.is_empty() {
        return Err("Nom d'asset vide.".to_string());
    }
    if trimmed.starts_with('/') || trimmed.contains('\\') {
        return Err(format!("Nom d'asset invalide : {}", asset_name));
    }
    if !trimmed.starts_with("assets/") {
        return Err(format!("Nom d'asset hors dossier assets/ : {}", asset_name));
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("Nom d'asset invalide : {}", asset_name));
    }
    Ok(trimmed.to_string())
}

pub fn load_pack_zip(zip_path: &str) -> Result<String, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    read_story_json_from_zip(&zip_path)
}

pub fn get_pack_asset(zip_path: &str, asset_name: &str) -> Result<Vec<u8>, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let asset_name = validate_pack_asset_name(asset_name)?;
    let file =
        fs::File::open(&zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), &zip_path)?;
    let mut entry = archive
        .by_name(&asset_name)
        .map_err(|_| format!("Asset introuvable : {}", asset_name))?;
    ensure_zip_entry_size("Asset", &asset_name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Dézipe un ZIP/7z Lunii et retourne `{ rootAudio, rootImage, entries }`.
/// Les fichiers audio et image sont copiés dans `dest_dir`.
pub fn unpack_zip_to_entries(zip_path: &str, dest_dir: &str) -> Result<serde_json::Value, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let dest = Path::new(dest_dir);
    fs::create_dir_all(dest)
        .map_err(|e| format!("Impossible de créer le dossier de destination : {}", e))?;

    let story_json = read_story_json_from_zip(&zip_path)?;
    let doc: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;

    let asset_map = extract_all_zip_assets(&zip_path, dest)?;
    let thumbnail_path = extract_zip_thumbnail(&zip_path, dest)?;

    let mut result = walk_story_doc_to_entries(&doc, &asset_map)?;
    if let Some(thumb) = thumbnail_path {
        result["thumbnailImage"] = serde_json::Value::String(thumb.to_string_lossy().to_string());
    }
    Ok(result)
}

fn read_story_json_from_zip(zip_path: &Path) -> Result<String, String> {
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut entry = archive
        .by_name("story.json")
        .map_err(|_| "story.json introuvable dans le ZIP".to_string())?;
    ensure_zip_entry_size(
        "story.json",
        "story.json",
        entry.size(),
        MAX_STORY_JSON_BYTES,
    )?;
    let mut content = String::new();
    entry
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    Ok(content)
}

/// Extrait tous les fichiers `assets/*` du ZIP dans `dest_dir`.
/// Retourne une map nom_court → chemin absolu sur disque.
fn extract_all_zip_assets(
    zip_path: &Path,
    dest: &Path,
) -> Result<HashMap<String, PathBuf>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP assets : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut map = HashMap::new();
    let mut total_asset_bytes = 0_u64;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur lecture ZIP index {} : {}", i, e))?;
        let name = entry.name().to_string();
        if !name.starts_with("assets/") || name.ends_with('/') {
            continue;
        }
        let short = &name["assets/".len()..];
        if short.is_empty() || short.contains('/') || short.contains("..") {
            continue;
        }
        ensure_zip_entry_size("Asset", &name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
        total_asset_bytes = total_asset_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Taille totale des assets ZIP trop volumineuse.".to_string())?;
        ensure_total_asset_size(total_asset_bytes)?;
        let out_path = dest.join(short);
        if !out_path.exists() {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Lecture asset {} impossible : {}", name, e))?;
            fs::write(&out_path, &buf)
                .map_err(|e| format!("Écriture asset {} impossible : {}", short, e))?;
        }
        map.insert(short.to_string(), out_path);
    }
    Ok(map)
}

fn extract_zip_thumbnail(zip_path: &Path, dest: &Path) -> Result<Option<PathBuf>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP thumbnail : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for name in &["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"] {
        if let Ok(mut entry) = archive.by_name(name) {
            ensure_zip_entry_size("Thumbnail", name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
            let file_name = Path::new(name).file_name().unwrap_or_default();
            let out_path = dest.join(file_name);
            if !out_path.exists() {
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Lecture thumbnail impossible : {}", e))?;
                fs::write(&out_path, &buf)
                    .map_err(|e| format!("Écriture thumbnail impossible : {}", e))?;
            }
            return Ok(Some(out_path));
        }
    }
    Ok(None)
}

fn ensure_total_asset_size(total_asset_bytes: u64) -> Result<(), String> {
    if total_asset_bytes > MAX_TOTAL_ASSET_BYTES {
        return Err(format!(
            "Assets ZIP trop volumineux : {} Mo extraits (maximum {} Mo).",
            total_asset_bytes / 1024 / 1024,
            MAX_TOTAL_ASSET_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

/// Extrait { autoplay, wheel, pause, ok, home } du controlSettings d'un stage.
fn stage_controls(stage: &serde_json::Value) -> serde_json::Value {
    let cs = stage
        .get("controlSettings")
        .unwrap_or(&serde_json::Value::Null);
    let get = |k: &str, def: bool| cs.get(k).and_then(|v| v.as_bool()).unwrap_or(def);
    serde_json::json!({
        "autoplay": get("autoplay", false),
        "wheel":    get("wheel",    false),
        "pause":    get("pause",    false),
        "ok":       get("ok",       false),
        "home":     get("home",     false),
    })
}

/// Retourne le chemin sur disque d'un asset (ou None si absent/vide).
fn resolve_asset(name: Option<&str>, map: &HashMap<String, PathBuf>) -> Option<String> {
    let name = name?.trim();
    if name.is_empty() {
        return None;
    }
    // Accepte aussi "assets/xxx.mp3" en plus de "xxx.mp3"
    let short = if let Some(s) = name.strip_prefix("assets/") {
        s
    } else {
        name
    };
    map.get(short).map(|p| p.to_string_lossy().into_owned())
}

fn native_graph_with_resolved_assets(
    doc: &serde_json::Value,
    assets: &HashMap<String, PathBuf>,
) -> serde_json::Value {
    let mut document = doc.clone();
    if let Some(stages) = document
        .get_mut("stageNodes")
        .and_then(|value| value.as_array_mut())
    {
        for stage in stages {
            if let Some(audio) = stage
                .get("audio")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets))
            {
                stage["audio"] = serde_json::Value::String(audio);
            }
            if let Some(image) = stage
                .get("image")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets))
            {
                stage["image"] = serde_json::Value::String(image);
            }
        }
    }

    let stage_count = document
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    let action_count = document
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);

    serde_json::json!({
        "formatVersion": 1,
        "kind": "imported-story-graph",
        "preserveForRoundTrip": true,
        "projectionStatus": "lossy",
        "projectionReason": "branching-graph",
        "stageCount": stage_count,
        "actionCount": action_count,
        "document": document,
    })
}

fn has_interactive_branching_graph(
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    stages.values().any(|stage| {
        if !is_stage_autoplay(stage) {
            return false;
        }
        let options = stage_action_options(stage, actions);
        options.len() >= 2
            && options.iter().all(|stage_id| {
                stages.get(stage_id).is_some_and(|candidate| {
                    stage_control_bool(candidate, "wheel", false) && !is_stage_autoplay(candidate)
                })
            })
    })
}

fn is_stage_autoplay(stage: &serde_json::Value) -> bool {
    stage
        .get("controlSettings")
        .and_then(|cs| cs.get("autoplay"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn stage_uuid(stage: &serde_json::Value) -> Option<&str> {
    stage
        .get("uuid")
        .or_else(|| stage.get("id"))
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
}

fn transition_target_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let action_id = transition
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())?;
    let option_index = transition
        .and_then(|t| t.get("optionIndex"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let action = actions.get(action_id)?;
    let options = action_options(action);
    let index = if option_index < 0 {
        0_usize
    } else {
        option_index as usize
    };
    options.get(index).copied()
}

fn transition_action_options<'a>(
    transition: Option<&'a serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Vec<&'a str> {
    let Some(action_id) = transition
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())
    else {
        return Vec::new();
    };
    actions
        .get(action_id)
        .map(|action| action_options(action))
        .unwrap_or_default()
}

fn has_transition_target(
    transition: Option<&serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    transition_target_stage_id(transition, actions).is_some()
}

fn stage_next_single_option<'a>(
    stage_id: &'a str,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let stage = stages.get(stage_id)?;
    let action_id = stage
        .get("okTransition")
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())?;
    let action = actions.get(action_id)?;
    let options = action_options(action);
    if options.len() == 1 {
        options.first().copied()
    } else {
        None
    }
}

fn resolve_transition_return_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let mut current = transition_target_stage_id(transition, actions)?;
    let mut visited = HashSet::new();

    loop {
        if !visited.insert(current) {
            return Some(current);
        }

        let Some(next) = stage_next_single_option(current, stages, actions) else {
            return Some(current);
        };
        current = next;
    }
}

struct PromptStageDetection<'a> {
    stage_id: &'a str,
    ok_target_stage_id: Option<&'a str>,
    home_target_stage_id: Option<&'a str>,
    home_transition_none: bool,
    control_settings: serde_json::Value,
}

fn stage_control_bool(stage: &serde_json::Value, key: &str, default: bool) -> bool {
    stage
        .get("controlSettings")
        .and_then(|cs| cs.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

fn is_named_night_bridge_stage(stage: &serde_json::Value) -> bool {
    let name = stage
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    name.eq_ignore_ascii_case("nightStage")
        && !stage_control_bool(stage, "wheel", false)
        && stage
            .get("audio")
            .and_then(|value| value.as_str())
            .is_some()
}

fn is_imported_night_mode_stage_candidate(
    stage: &serde_json::Value,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    !stage_control_bool(stage, "wheel", false)
        && stage
            .get("audio")
            .and_then(|value| value.as_str())
            .is_some()
        && has_transition_target(stage.get("okTransition"), actions)
}

fn resolve_playback_completion_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let mut current = transition_target_stage_id(transition, actions)?;
    let mut visited = HashSet::new();

    loop {
        if !visited.insert(current) {
            return Some(current);
        }
        let Some(stage) = stages.get(current) else {
            return Some(current);
        };

        let is_non_selectable_autoplay =
            is_stage_autoplay(stage) && !stage_control_bool(stage, "wheel", false);
        let should_follow = is_non_selectable_autoplay
            || (stage_control_bool(stage, "ok", false)
                && !stage_control_bool(stage, "wheel", false));
        if !should_follow {
            return Some(current);
        }

        let Some(next) = transition_target_stage_id(stage.get("okTransition"), actions) else {
            return Some(current);
        };
        if next == current {
            return Some(current);
        }
        current = next;
    }
}

fn candidate_prompt_stage<'a>(
    play_stage: &'a serde_json::Value,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<PromptStageDetection<'a>> {
    let direct_home_target = transition_target_stage_id(play_stage.get("homeTransition"), actions)?;
    let direct_ok_target = transition_target_stage_id(play_stage.get("okTransition"), actions)?;

    if direct_ok_target == direct_home_target {
        return None;
    }

    let prompt_stage = stages.get(direct_ok_target)?;
    let prompt_home = transition_target_stage_id(prompt_stage.get("homeTransition"), actions);
    let prompt_ok = transition_target_stage_id(prompt_stage.get("okTransition"), actions);
    let prompt_has_audio = prompt_stage.get("audio").and_then(|v| v.as_str()).is_some();
    let prompt_ok_enabled = stage_control_bool(prompt_stage, "ok", false);

    if !is_named_night_bridge_stage(prompt_stage)
        && prompt_has_audio
        && prompt_ok_enabled
        && prompt_ok.is_some()
        && prompt_ok != Some(direct_ok_target)
        && (prompt_home.is_none()
            || prompt_home == Some(direct_home_target)
            || prompt_home == prompt_ok)
    {
        Some(PromptStageDetection {
            stage_id: direct_ok_target,
            ok_target_stage_id: prompt_ok,
            home_target_stage_id: prompt_home,
            home_transition_none: prompt_home.is_none(),
            control_settings: stage_controls(prompt_stage),
        })
    } else {
        None
    }
}

fn candidate_prompt_stage_id<'a>(
    play_stage: &'a serde_json::Value,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    candidate_prompt_stage(play_stage, stages, actions).map(|candidate| candidate.stage_id)
}

struct StoryReturnDetection {
    target_stage_id: Option<String>,
    home_stage_id: Option<String>,
    prompt_stage_id: Option<String>,
    prompt_ok_stage_id: Option<String>,
    prompt_home_stage_id: Option<String>,
    prompt_home_transition_none: bool,
    prompt_control_settings: Option<serde_json::Value>,
    after_playback_sequence: Vec<serde_json::Value>,
    home_step: Option<serde_json::Value>,
    advanced: bool,
    next_story_stage_id: Option<String>,
    home_story_stage_id: Option<String>,
}

struct AfterPlaybackSequenceDetection {
    steps: Vec<serde_json::Value>,
    home_step: Option<serde_json::Value>,
    final_target_stage_id: Option<String>,
}

/// Retourne true si `stage_id` est un play stage d'histoire (autoplay+audio) ou un stage de titre
/// qui mène directement (single option) à un tel play stage.
/// Ceci couvre les packs où okTransition pointe sur le stage titre de l'épisode suivant plutôt que
/// directement sur son stage de lecture.
fn is_story_stage_entry<'a>(
    stage_id: &'a str,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
    story_play_stage_ids: &HashSet<&str>,
) -> bool {
    if story_play_stage_ids.contains(stage_id) {
        return true;
    }
    // Un stage titre (non autoplay) avec une seule option menant à un play stage
    if let Some(stage) = stages.get(stage_id) {
        if is_after_playback_sequence_stage(stage) {
            return false;
        }
        if !is_stage_autoplay(stage) {
            let opts = stage_action_options(stage, actions);
            if opts.len() == 1 && story_play_stage_ids.contains(opts[0]) {
                return true;
            }
        }
    }
    false
}

fn is_after_playback_sequence_stage(stage: &serde_json::Value) -> bool {
    let wheel = stage_control_bool(stage, "wheel", false);
    !wheel && (is_stage_autoplay(stage) || stage_control_bool(stage, "ok", false))
}

fn detect_after_playback_sequence(
    play_stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    story_play_stage_ids: &HashSet<&str>,
) -> Option<AfterPlaybackSequenceDetection> {
    let mut current = transition_target_stage_id(play_stage.get("okTransition"), actions)?;
    let mut visited = HashSet::new();
    let mut steps = Vec::new();
    let mut final_target_stage_id = None;

    loop {
        if !visited.insert(current.to_string()) {
            break;
        }
        if is_story_stage_entry(current, stages, actions, story_play_stage_ids) {
            final_target_stage_id = Some(current.to_string());
            break;
        }

        let Some(stage) = stages.get(current) else {
            final_target_stage_id = Some(current.to_string());
            break;
        };
        if !is_after_playback_sequence_stage(stage) {
            final_target_stage_id = Some(current.to_string());
            break;
        }

        let next_target = transition_target_stage_id(stage.get("okTransition"), actions);
        let next_is_terminal = next_target
            .map(|target| {
                is_story_stage_entry(target, stages, actions, story_play_stage_ids)
                    || stages
                        .get(target)
                        .map(|next_stage| !is_after_playback_sequence_stage(next_stage))
                        .unwrap_or(true)
            })
            .unwrap_or(true);

        let mut step = serde_json::json!({
            "id": stage_uuid(stage).unwrap_or(""),
            "name": stage.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "audio": serde_json::Value::Null,
            "image": serde_json::Value::Null,
            "controlSettings": stage_controls(stage),
            "homeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
            "homeFollowsOk": has_transition_target(stage.get("homeTransition"), actions)
                && transition_target_stage_id(stage.get("homeTransition"), actions) == next_target,
            "homeNone": !has_transition_target(stage.get("homeTransition"), actions),
        });
        if let Some(audio) = stage.get("audio").and_then(|v| v.as_str()) {
            step["audio"] = serde_json::Value::String(audio.to_string());
        }
        if let Some(image) = stage.get("image").and_then(|v| v.as_str()) {
            step["image"] = serde_json::Value::String(image.to_string());
        }
        if next_is_terminal {
            if let Some(target) = next_target {
                step["okStageId"] = serde_json::Value::String(target.to_string());
                final_target_stage_id = Some(target.to_string());
            }
            let choice_options = transition_action_options(stage.get("okTransition"), actions);
            if choice_options.len() > 1 {
                step["okChoiceStageIds"] = serde_json::Value::Array(
                    choice_options
                        .into_iter()
                        .map(|target| serde_json::Value::String(target.to_string()))
                        .collect(),
                );
            }
        }
        steps.push(step);

        let Some(next) = next_target else {
            break;
        };
        if next_is_terminal {
            break;
        }
        current = next;
    }

    let home_step = transition_target_stage_id(play_stage.get("homeTransition"), actions)
        .and_then(|home_stage_id| {
            let first_step_id = steps
                .first()
                .and_then(|step| step.get("id"))
                .and_then(|value| value.as_str());
            if Some(home_stage_id) == first_step_id {
                return None;
            }
            let stage = stages.get(home_stage_id)?;
            if !is_after_playback_sequence_stage(stage) {
                return None;
            }
            let next_target = transition_target_stage_id(stage.get("okTransition"), actions);
            let mut step = serde_json::json!({
                "id": stage_uuid(stage).unwrap_or(""),
                "name": stage.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "audio": serde_json::Value::Null,
                "image": serde_json::Value::Null,
                "controlSettings": stage_controls(stage),
                "homeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                "homeFollowsOk": has_transition_target(stage.get("homeTransition"), actions)
                    && transition_target_stage_id(stage.get("homeTransition"), actions) == next_target,
                "homeNone": !has_transition_target(stage.get("homeTransition"), actions),
            });
            if let Some(audio) = stage.get("audio").and_then(|v| v.as_str()) {
                step["audio"] = serde_json::Value::String(audio.to_string());
            }
            if let Some(image) = stage.get("image").and_then(|v| v.as_str()) {
                step["image"] = serde_json::Value::String(image.to_string());
            }
            Some(step)
        });

    if steps.len() > 1 {
        Some(AfterPlaybackSequenceDetection {
            steps,
            home_step,
            final_target_stage_id,
        })
    } else {
        None
    }
}

fn detect_story_return_stage_id<'a>(
    play_stage: &'a serde_json::Value,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
    prompt_stage_usage: &HashMap<String, usize>,
    _night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> StoryReturnDetection {
    let direct_home_target = transition_target_stage_id(play_stage.get("homeTransition"), actions);
    let direct_ok_target = transition_target_stage_id(play_stage.get("okTransition"), actions);
    let direct_ok_is_night_bridge = direct_ok_target
        .and_then(|stage_id| stages.get(stage_id))
        .is_some_and(|stage| is_named_night_bridge_stage(stage));
    let candidate_prompt = if direct_ok_is_night_bridge {
        None
    } else {
        candidate_prompt_stage(play_stage, stages, actions)
    };
    let sequence = if !direct_ok_is_night_bridge && candidate_prompt.is_none() {
        detect_after_playback_sequence(play_stage, stages, actions, story_play_stage_ids)
    } else {
        None
    };

    // Story→story uniquement si le stage courant est autoplay (stage de lecture réel).
    // On accepte aussi que la cible soit un stage titre qui mène à un play stage (packs Toudou-like).
    let is_autoplay = is_stage_autoplay(play_stage);
    let ok_is_story = is_autoplay
        && direct_ok_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let home_is_story = is_autoplay
        && direct_home_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let prompt_ok_is_story = is_autoplay
        && candidate_prompt
            .as_ref()
            .and_then(|candidate| candidate.ok_target_stage_id)
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let sequence_ok_target = sequence
        .as_ref()
        .and_then(|sequence| sequence.final_target_stage_id.as_deref());
    let sequence_ok_is_story = is_autoplay
        && sequence_ok_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let completion_ok_target = if !direct_ok_is_night_bridge
        && !ok_is_story
        && candidate_prompt.is_none()
        && sequence.is_none()
    {
        resolve_playback_completion_stage_id(play_stage.get("okTransition"), stages, actions)
    } else {
        None
    };
    let completion_ok_is_story = is_autoplay
        && completion_ok_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));

    let next_story_stage_id = if ok_is_story {
        direct_ok_target.map(str::to_string)
    } else if prompt_ok_is_story {
        candidate_prompt
            .as_ref()
            .and_then(|candidate| candidate.ok_target_stage_id)
            .map(str::to_string)
    } else if sequence_ok_is_story {
        sequence_ok_target.map(str::to_string)
    } else if completion_ok_is_story {
        completion_ok_target.map(str::to_string)
    } else {
        None
    };
    let home_story_stage_id = if home_is_story {
        direct_home_target.map(str::to_string)
    } else {
        None
    };

    let home_target =
        resolve_transition_return_stage_id(play_stage.get("homeTransition"), stages, actions);
    let ok_target =
        resolve_transition_return_stage_id(play_stage.get("okTransition"), stages, actions);
    let target_stage_id = if let Some(candidate) = candidate_prompt.as_ref() {
        candidate.ok_target_stage_id.map(str::to_string)
    } else if sequence.is_some() {
        sequence_ok_target
            .filter(|target| !is_story_stage_entry(target, stages, actions, story_play_stage_ids))
            .map(str::to_string)
    } else {
        match (home_target, ok_target, completion_ok_target) {
            (_, _, Some(completion))
                if Some(completion) != direct_ok_target
                    && !is_story_stage_entry(completion, stages, actions, story_play_stage_ids) =>
            {
                Some(completion.to_string())
            }
            (Some(home), Some(ok), _) if home == ok => Some(home.to_string()),
            _ => None,
        }
    };

    let prompt_stage_id = if sequence.is_some() {
        None
    } else {
        candidate_prompt.as_ref().and_then(|stage_id| {
            let usage = prompt_stage_usage
                .get(stage_id.stage_id)
                .copied()
                .unwrap_or(0);
            if usage <= 1 {
                Some(stage_id.stage_id.to_string())
            } else {
                None
            }
        })
    };
    let prompt_ok_stage_id = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .and_then(|candidate| candidate.ok_target_stage_id.map(str::to_string));
    let prompt_home_stage_id = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .and_then(|candidate| candidate.home_target_stage_id.map(str::to_string));
    let prompt_home_transition_none = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .map(|candidate| candidate.home_transition_none)
        .unwrap_or(false);
    let prompt_control_settings = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .map(|candidate| candidate.control_settings.clone());

    let after_playback_sequence = sequence
        .as_ref()
        .map(|sequence| sequence.steps.clone())
        .unwrap_or_default();
    let home_step = sequence
        .as_ref()
        .and_then(|sequence| sequence.home_step.clone());

    let advanced = if !after_playback_sequence.is_empty()
        || prompt_stage_id.is_some()
        || candidate_prompt.is_some()
        || ok_is_story
        || home_is_story
    {
        false
    } else {
        match (direct_home_target, direct_ok_target, home_target, ok_target) {
            (Some(direct_home), Some(direct_ok), Some(home), Some(ok)) => {
                direct_home != direct_ok || direct_home != home || direct_ok != ok
            }
            (Some(_), None, Some(_), None) => false,
            (None, None, None, None) => false,
            _ => true,
        }
    };

    StoryReturnDetection {
        target_stage_id,
        home_stage_id: home_target.map(|value| value.to_string()),
        prompt_stage_id,
        prompt_ok_stage_id,
        prompt_home_stage_id,
        prompt_home_transition_none,
        prompt_control_settings,
        after_playback_sequence,
        home_step,
        advanced,
        next_story_stage_id,
        home_story_stage_id,
    }
}

fn assign_return_targets(
    entries: &mut [serde_json::Value],
    stage_names: &HashMap<String, String>,
) -> Vec<serde_json::Value> {
    let menu_ids: HashSet<String> = entries
        .iter()
        .flat_map(collect_menu_ids_from_entry)
        .collect();

    let story_stage_map: HashMap<String, String> = build_story_stage_map(entries);
    let mut unresolved_transitions = Vec::new();

    for entry in entries.iter_mut() {
        resolve_entry_return_targets(
            entry,
            &menu_ids,
            &story_stage_map,
            stage_names,
            &mut unresolved_transitions,
        );
    }
    unresolved_transitions
}

/// Construit une table { stage_uuid → story_item_uuid } couvrant :
/// - l'UUID du titre (= item id)
/// - l'UUID du play stage (champ temporaire _playStageId)
fn build_story_stage_map(entries: &[serde_json::Value]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for entry in entries {
        collect_story_stage_uuids(entry, &mut map);
    }
    map
}

fn collect_story_stage_uuids(entry: &serde_json::Value, map: &mut HashMap<String, String>) {
    let entry_type = entry.get("type").and_then(|v| v.as_str());
    if entry_type == Some("story") {
        if let Some(item_id) = entry.get("id").and_then(|v| v.as_str()) {
            map.insert(item_id.to_string(), item_id.to_string());
            if let Some(play_id) = entry.get("_playStageId").and_then(|v| v.as_str()) {
                map.insert(play_id.to_string(), item_id.to_string());
            }
            if let Some(home_step_id) = entry
                .get("afterPlaybackHomeStep")
                .and_then(|value| value.as_object())
                .and_then(|step| step.get("id"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                map.insert(
                    home_step_id.to_string(),
                    format!("story_home_step:{}", item_id),
                );
            }
        }
    } else if entry_type == Some("menu") {
        if let Some(children) = entry.get("children").and_then(|v| v.as_array()) {
            for child in children {
                collect_story_stage_uuids(child, map);
            }
        }
    }
}

fn collect_menu_ids_from_entry(entry: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    if entry.get("type").and_then(|v| v.as_str()) == Some("menu") {
        if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
            ids.push(id.to_string());
        }
        if let Some(children) = entry.get("children").and_then(|v| v.as_array()) {
            for child in children {
                ids.extend(collect_menu_ids_from_entry(child));
            }
        }
    }
    ids
}

struct StoryNavigationContext {
    play_stage_id: String,
    next_story_id: Option<String>,
    fallback_stage_id: String,
}

fn collect_story_navigation_contexts(
    entries: &[serde_json::Value],
    parent_menu_id: Option<&str>,
    contexts: &mut Vec<StoryNavigationContext>,
) {
    for (index, entry) in entries.iter().enumerate() {
        match entry.get("type").and_then(|value| value.as_str()) {
            Some("story") => {
                let Some(story_id) = entry.get("id").and_then(|value| value.as_str()) else {
                    continue;
                };
                let play_stage_id = entry
                    .get("_playStageId")
                    .and_then(|value| value.as_str())
                    .unwrap_or(story_id);
                let next_story_id = entries[(index + 1)..].iter().find_map(|candidate| {
                    if candidate.get("type").and_then(|value| value.as_str()) == Some("story") {
                        candidate
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    } else {
                        None
                    }
                });
                contexts.push(StoryNavigationContext {
                    play_stage_id: play_stage_id.to_string(),
                    next_story_id,
                    fallback_stage_id: parent_menu_id.unwrap_or(story_id).to_string(),
                });
            }
            Some("menu") => {
                let menu_id = entry.get("id").and_then(|value| value.as_str());
                if let Some(children) = entry.get("children").and_then(|value| value.as_array()) {
                    collect_story_navigation_contexts(children, menu_id, contexts);
                }
            }
            _ => {}
        }
    }
}

struct NightBridgeDetection {
    audio: String,
    return_target: Option<String>,
    home_target: Option<String>,
}

struct NightBridgeInstance {
    night_stage_id: String,
    return_stage_id: Option<String>,
    home_stage_id: Option<String>,
    expected_next_or_fallback_stage_id: String,
}

fn normalize_stage_navigation_target(
    stage_id: &str,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<String> {
    resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
        .and_then(|value| value.as_str().map(str::to_string))
}

fn infer_night_target(
    instances: &[NightBridgeInstance],
    target_for: impl Fn(&NightBridgeInstance) -> Option<&String>,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<String> {
    let targets: Vec<&String> = instances.iter().filter_map(&target_for).collect();
    if targets.is_empty() {
        return None;
    }
    if targets.len() == instances.len()
        && instances.iter().all(|instance| {
            target_for(instance) == Some(&instance.expected_next_or_fallback_stage_id)
        })
    {
        return Some("next_story".to_string());
    }
    let first = targets[0];
    if targets.iter().all(|target| *target == first) {
        return normalize_stage_navigation_target(first, menu_ids, story_stage_map);
    }
    None
}

fn detect_imported_night_mode(
    night_mode_available: bool,
    entries: &[serde_json::Value],
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Option<NightBridgeDetection> {
    if !night_mode_available {
        return None;
    }

    let menu_ids: HashSet<String> = entries
        .iter()
        .flat_map(collect_menu_ids_from_entry)
        .collect();
    let story_stage_map = build_story_stage_map(entries);
    let mut contexts = Vec::new();
    collect_story_navigation_contexts(entries, None, &mut contexts);

    let mut instances = Vec::new();
    let mut audio: Option<String> = None;
    for context in contexts {
        let Some(play_stage) = stages.get(context.play_stage_id.as_str()) else {
            continue;
        };
        if !is_stage_autoplay(play_stage) {
            continue;
        }
        let opts = stage_action_options(play_stage, actions);
        if opts.len() != 1 {
            continue;
        }
        let night_stage_id = opts[0];
        let Some(night_stage) = stages.get(night_stage_id) else {
            continue;
        };
        if !is_imported_night_mode_stage_candidate(night_stage, actions) {
            continue;
        }
        let resolved_audio = resolve_asset(
            night_stage.get("audio").and_then(|value| value.as_str()),
            assets,
        )?;
        if audio
            .as_deref()
            .is_some_and(|existing| existing != resolved_audio)
        {
            return None;
        }
        audio = Some(resolved_audio);
        instances.push(NightBridgeInstance {
            night_stage_id: night_stage_id.to_string(),
            return_stage_id: transition_target_stage_id(night_stage.get("okTransition"), actions)
                .map(str::to_string),
            home_stage_id: transition_target_stage_id(night_stage.get("homeTransition"), actions)
                .map(str::to_string),
            expected_next_or_fallback_stage_id: context
                .next_story_id
                .unwrap_or(context.fallback_stage_id),
        });
    }

    if instances.is_empty() {
        return None;
    }

    let distinct_night_stages: HashSet<&str> = instances
        .iter()
        .map(|instance| instance.night_stage_id.as_str())
        .collect();
    let return_target = infer_night_target(
        &instances,
        |instance| instance.return_stage_id.as_ref(),
        &menu_ids,
        &story_stage_map,
    )?;
    if distinct_night_stages.len() > 1 && return_target != "next_story" {
        return None;
    }
    let home_target = infer_night_target(
        &instances,
        |instance| instance.home_stage_id.as_ref(),
        &menu_ids,
        &story_stage_map,
    );

    Some(NightBridgeDetection {
        audio: audio?,
        return_target: Some(return_target),
        home_target,
    })
}

fn push_unresolved_transition(
    unresolved_transitions: &mut Vec<serde_json::Value>,
    entry_id: Option<&str>,
    entry_name: Option<&str>,
    field: &str,
    target_stage_id: Option<&str>,
    target_stage_name: Option<&str>,
    detail: &str,
) {
    if field == "returnOnHome" && target_stage_name == Some("Cloche retour") {
        return;
    }

    let label = entry_name.unwrap_or("Entree importee");
    let target_label = target_stage_name
        .filter(|name| !name.trim().is_empty())
        .or(target_stage_id);
    let message = match target_label {
        Some(target) => format!("{label} — {detail} vers « {target} » non modelisee."),
        None => format!("{label} — {detail} non modelisee."),
    };
    unresolved_transitions.push(serde_json::json!({
        "entryId": entry_id,
        "entryName": entry_name,
        "field": field,
        "targetStageId": target_stage_id,
        "targetStageName": target_stage_name,
        "message": message,
    }));
}

fn resolve_entry_return_targets(
    entry: &mut serde_json::Value,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
    stage_names: &HashMap<String, String>,
    unresolved_transitions: &mut Vec<serde_json::Value>,
) {
    let entry_id = entry.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let entry_name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    if entry.get("type").and_then(|v| v.as_str()) == Some("story") {
        let return_stage_id = entry
            .get("returnStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let return_on_home_stage_id = entry
            .get("returnOnHomeStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let return_on_home_none = entry
            .get("returnOnHomeNone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let title_return_on_home_stage_id = entry
            .get("titleReturnOnHomeStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let title_return_on_home_none = entry
            .get("titleReturnOnHomeNone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let return_story_stage_id = entry
            .get("returnStoryStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let home_story_stage_id = entry
            .get("homeStoryStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let prompt_ok_stage_id = entry
            .get("afterPlaybackPromptOkStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let prompt_home_stage_id = entry
            .get("afterPlaybackPromptHomeStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        if let Some(obj) = entry.as_object_mut() {
            obj.remove("returnStageId");
            obj.remove("returnOnHomeStageId");
            obj.remove("returnOnHomeNone");
            obj.remove("titleReturnOnHomeStageId");
            obj.remove("titleReturnOnHomeNone");
            obj.remove("returnStoryStageId");
            obj.remove("homeStoryStageId");
            obj.remove("afterPlaybackPromptOkStageId");
            obj.remove("afterPlaybackPromptHomeStageId");
            obj.remove("_playStageId");
            if let Some(steps) = obj
                .get_mut("afterPlaybackSequence")
                .and_then(|value| value.as_array_mut())
            {
                for step in steps.iter_mut() {
                    let Some(step_obj) = step.as_object_mut() else {
                        continue;
                    };
                    let ok_stage_id = step_obj
                        .remove("okStageId")
                        .and_then(|value| value.as_str().map(|value| value.to_string()));
                    let ok_choice_stage_ids: Vec<String> = step_obj
                        .remove("okChoiceStageIds")
                        .and_then(|value| value.as_array().cloned())
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect();
                    let home_stage_id = step_obj
                        .remove("homeStageId")
                        .and_then(|value| value.as_str().map(|value| value.to_string()));
                    let ok_choice_targets: Vec<serde_json::Value> = ok_choice_stage_ids
                        .iter()
                        .filter_map(|stage_id| {
                            resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                        })
                        .collect();
                    if ok_choice_targets.len() > 1 {
                        step_obj.insert(
                            "okChoiceTargets".to_string(),
                            serde_json::Value::Array(ok_choice_targets),
                        );
                    }
                    if let Some(target) = ok_stage_id.as_deref().and_then(|stage_id| {
                        resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                    }) {
                        step_obj.insert("okTarget".to_string(), target);
                    } else if let Some(stage_id) = ok_stage_id.as_deref() {
                        let step_name = step_obj
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("?");
                        let detail = format!("destination OK de l'etape « {step_name} »");
                        push_unresolved_transition(
                            unresolved_transitions,
                            entry_id.as_deref(),
                            entry_name.as_deref(),
                            "afterPlaybackSequence.okTarget",
                            Some(stage_id),
                            stage_names.get(stage_id).map(String::as_str),
                            &detail,
                        );
                    }
                    if let Some(target) = home_stage_id.as_deref().and_then(|stage_id| {
                        resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                    }) {
                        step_obj.insert("homeTarget".to_string(), target);
                    } else if let Some(stage_id) = home_stage_id.as_deref() {
                        let step_name = step_obj
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("?");
                        let detail = format!("destination Home de l'etape « {step_name} »");
                        push_unresolved_transition(
                            unresolved_transitions,
                            entry_id.as_deref(),
                            entry_name.as_deref(),
                            "afterPlaybackSequence.homeTarget",
                            Some(stage_id),
                            stage_names.get(stage_id).map(String::as_str),
                            &detail,
                        );
                    }
                }
            }
            // Cible OK : story→story prioritaire sur menu→story
            if let Some(home_step_obj) = obj
                .get_mut("afterPlaybackHomeStep")
                .and_then(|value| value.as_object_mut())
            {
                let home_stage_id = home_step_obj
                    .remove("homeStageId")
                    .and_then(|value| value.as_str().map(|value| value.to_string()));
                if let Some(target) = home_stage_id.as_deref().and_then(|stage_id| {
                    resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                }) {
                    home_step_obj.insert("homeTarget".to_string(), target);
                } else if let Some(stage_id) = home_stage_id.as_deref() {
                    let step_name = home_step_obj
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("?");
                    let detail = format!("destination Home de l'etape Â« {step_name} Â»");
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "afterPlaybackHomeStep.homeTarget",
                        Some(stage_id),
                        stage_names.get(stage_id).map(String::as_str),
                        &detail,
                    );
                }
            }
            if let Some(stage_id) = return_story_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&stage_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnAfterPlay".to_string(), target);
                } else if let Some(target_id) = return_stage_id {
                    // The "next story" stage didn't map to a story item (e.g. night-mode outro
                    // stage that leads back to menu) — fall back to the menu return target.
                    if let Some(target) =
                        resolve_navigation_target_for_stage(&target_id, menu_ids, story_stage_map)
                    {
                        obj.insert("returnAfterPlay".to_string(), target);
                    } else {
                        push_unresolved_transition(
                            unresolved_transitions,
                            entry_id.as_deref(),
                            entry_name.as_deref(),
                            "returnAfterPlay",
                            Some(&target_id),
                            stage_names.get(&target_id).map(String::as_str),
                            "destination de retour apres lecture",
                        );
                    }
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnAfterPlay",
                        Some(&stage_id),
                        stage_names.get(&stage_id).map(String::as_str),
                        "destination de retour apres lecture",
                    );
                }
            } else if let Some(target_id) = return_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&target_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnAfterPlay".to_string(), target);
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnAfterPlay",
                        Some(&target_id),
                        stage_names.get(&target_id).map(String::as_str),
                        "destination de retour apres lecture",
                    );
                }
            }
            // Cible Home : story→story prioritaire
            if let Some(stage_id) = home_story_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&stage_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnOnHome".to_string(), target);
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnOnHome",
                        Some(&stage_id),
                        stage_names.get(&stage_id).map(String::as_str),
                        "destination du bouton Accueil",
                    );
                }
            } else if return_on_home_none {
                obj.insert(
                    "returnOnHomeNone".to_string(),
                    serde_json::Value::Bool(true),
                );
            } else if let Some(target_id) = return_on_home_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&target_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnOnHome".to_string(), target);
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnOnHome",
                        Some(&target_id),
                        stage_names.get(&target_id).map(String::as_str),
                        "destination du bouton Accueil",
                    );
                }
            }
            if let Some(target) = title_return_on_home_stage_id
                .as_deref()
                .and_then(|stage_id| {
                    resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                })
            {
                obj.insert("titleReturnOnHome".to_string(), target);
            } else if title_return_on_home_none {
                obj.insert(
                    "titleReturnOnHomeNone".to_string(),
                    serde_json::Value::Bool(true),
                );
            } else if let Some(stage_id) = title_return_on_home_stage_id.as_deref() {
                push_unresolved_transition(
                    unresolved_transitions,
                    entry_id.as_deref(),
                    entry_name.as_deref(),
                    "titleReturnOnHome",
                    Some(stage_id),
                    stage_names.get(stage_id).map(String::as_str),
                    "destination Accueil du titre",
                );
            }
            if let Some(target) = prompt_ok_stage_id.as_deref().and_then(|stage_id| {
                resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
            }) {
                obj.insert("afterPlaybackPromptOkTarget".to_string(), target);
            } else if let Some(stage_id) = prompt_ok_stage_id.as_deref() {
                push_unresolved_transition(
                    unresolved_transitions,
                    entry_id.as_deref(),
                    entry_name.as_deref(),
                    "afterPlaybackPromptOkTarget",
                    Some(stage_id),
                    stage_names.get(stage_id).map(String::as_str),
                    "destination OK du prompt final",
                );
            }
            if let Some(target) = prompt_home_stage_id.as_deref().and_then(|stage_id| {
                resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
            }) {
                obj.insert("afterPlaybackPromptHomeTarget".to_string(), target);
            } else if let Some(stage_id) = prompt_home_stage_id.as_deref() {
                push_unresolved_transition(
                    unresolved_transitions,
                    entry_id.as_deref(),
                    entry_name.as_deref(),
                    "afterPlaybackPromptHomeTarget",
                    Some(stage_id),
                    stage_names.get(stage_id).map(String::as_str),
                    "destination Home du prompt final",
                );
            }
        }
        return;
    }

    if entry.get("type").and_then(|v| v.as_str()) != Some("menu") {
        return;
    }

    let return_on_home_stage_id = entry
        .get("returnOnHomeStageId")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    if let Some(obj) = entry.as_object_mut() {
        obj.remove("returnOnHomeStageId");
        if let Some(target) = return_on_home_stage_id.as_deref().and_then(|stage_id| {
            resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
        }) {
            obj.insert("returnOnHome".to_string(), target);
        } else if let Some(stage_id) = return_on_home_stage_id.as_deref() {
            push_unresolved_transition(
                unresolved_transitions,
                entry_id.as_deref(),
                entry_name.as_deref(),
                "returnOnHome",
                Some(stage_id),
                stage_names.get(stage_id).map(String::as_str),
                "destination Accueil du menu",
            );
        }
    }

    if let Some(children) = entry.get_mut("children").and_then(|v| v.as_array_mut()) {
        for child in children.iter_mut() {
            resolve_entry_return_targets(
                child,
                menu_ids,
                story_stage_map,
                stage_names,
                unresolved_transitions,
            );
        }
        compress_menu_return_defaults(entry);
    }
}

fn resolve_navigation_target_for_stage(
    stage_id: &str,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<serde_json::Value> {
    if let Some(item_id) = story_stage_map.get(stage_id) {
        if item_id.starts_with("story_home_step:") {
            return Some(serde_json::Value::String(item_id.clone()));
        }
        let prefix = if stage_id == item_id {
            "story"
        } else {
            "story_play"
        };
        return Some(serde_json::Value::String(format!("{}:{}", prefix, item_id)));
    }
    if menu_ids.contains(stage_id) {
        return Some(serde_json::Value::String(stage_id.to_string()));
    }
    None
}

fn remove_night_mode_return_overrides(
    entries: &mut [serde_json::Value],
    night_target: &str,
    parent_menu_id: Option<&str>,
) {
    for index in 0..entries.len() {
        if entries[index].get("type").and_then(|value| value.as_str()) == Some("menu") {
            let menu_id = entries[index]
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            if let Some(children) = entries[index]
                .get_mut("children")
                .and_then(|value| value.as_array_mut())
            {
                remove_night_mode_return_overrides(children, night_target, menu_id.as_deref());
            }
            continue;
        }

        if entries[index].get("type").and_then(|value| value.as_str()) != Some("story") {
            continue;
        }

        let expected_target = if night_target == "next_story" {
            entries[(index + 1)..]
                .iter()
                .find_map(|candidate| {
                    if candidate.get("type").and_then(|value| value.as_str()) == Some("story") {
                        candidate
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(|id| format!("story:{id}"))
                    } else {
                        None
                    }
                })
                .or_else(|| parent_menu_id.map(|id| format!("menu:{id}")))
        } else {
            Some(night_target.to_string())
        };

        if entries[index]
            .get("returnAfterPlay")
            .and_then(|value| value.as_str())
            == expected_target.as_deref()
        {
            if let Some(obj) = entries[index].as_object_mut() {
                obj.remove("returnAfterPlay");
            }
        }
    }
}

fn resolve_after_playback_sequence_assets(
    steps: &[serde_json::Value],
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    steps
        .iter()
        .map(|step| {
            let mut step = step.clone();
            let resolved_audio = step
                .get("audio")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets));
            step["audio"] = resolved_audio
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            let resolved_image = step
                .get("image")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets));
            step["image"] = resolved_image
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            step
        })
        .collect()
}

fn resolve_after_playback_step_assets(
    step: &serde_json::Value,
    assets: &HashMap<String, PathBuf>,
) -> serde_json::Value {
    resolve_after_playback_sequence_assets(std::slice::from_ref(step), assets)
        .into_iter()
        .next()
        .unwrap_or(serde_json::Value::Null)
}

#[allow(clippy::too_many_arguments)]
fn autoplay_stage_to_story_entry(
    stage: &serde_json::Value,
    name: String,
    item_audio: Option<String>,
    item_image: Option<String>,
    assets: &HashMap<String, PathBuf>,
    actions: &HashMap<&str, &serde_json::Value>,
    stages: &HashMap<&str, &serde_json::Value>,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
    advanced_transitions_detected: &mut bool,
) -> serde_json::Value {
    let detection = detect_story_return_stage_id(
        stage,
        stages,
        actions,
        prompt_stage_usage,
        night_mode_available,
        story_play_stage_ids,
    );
    if detection.advanced {
        *advanced_transitions_detected = true;
    }
    let after_playback_prompt_audio = detection.prompt_stage_id.as_ref().and_then(|stage_id| {
        stages.get(stage_id.as_str()).and_then(|prompt_stage| {
            resolve_asset(prompt_stage.get("audio").and_then(|v| v.as_str()), assets)
        })
    });
    let after_playback_home_step = detection
        .home_step
        .as_ref()
        .map(|step| resolve_after_playback_step_assets(step, assets));

    serde_json::json!({
        "id": stage_uuid(stage).unwrap_or(""),
        "type": "story",
        "name": name,
        "audio": item_audio.clone(),
        "itemAudio": item_audio,
        "itemImage": item_image,
        "_playStageId": stage_uuid(stage),
        "returnStageId": detection.target_stage_id,
        "returnStoryStageId": detection.next_story_stage_id,
        "returnOnHomeStageId": detection
            .home_stage_id
            .clone()
            .filter(|target| Some(target.as_str()) != detection.target_stage_id.as_deref()),
        "returnOnHomeNone": detection.home_stage_id.is_none(),
        "homeStoryStageId": detection.home_story_stage_id,
        "afterPlaybackPromptAudio": after_playback_prompt_audio,
        "afterPlaybackPromptControlSettings": detection.prompt_control_settings,
        "afterPlaybackPromptOkStageId": detection.prompt_ok_stage_id,
        "afterPlaybackPromptHomeStageId": detection.prompt_home_stage_id,
        "afterPlaybackPromptHomeNone": detection.prompt_home_transition_none,
        "afterPlaybackSequence": resolve_after_playback_sequence_assets(&detection.after_playback_sequence, assets),
        "afterPlaybackHomeStep": after_playback_home_step,
        "controlSettings": stage_controls(stage),
    })
}

fn chain_intro_entries_before_content(
    intro_entries: Vec<serde_json::Value>,
    mut content_entries: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    if intro_entries.is_empty() {
        return content_entries;
    }

    if content_entries.len() != 1
        || content_entries[0].get("type").and_then(|v| v.as_str()) != Some("menu")
    {
        let mut all = intro_entries;
        all.extend(content_entries);
        return all;
    }

    let mut next = content_entries.pop().unwrap_or(serde_json::Value::Null);

    for intro in intro_entries.into_iter().rev() {
        let audio = intro
            .get("audio")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let control_settings = intro
            .get("controlSettings")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        next = serde_json::json!({
            "id": intro.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "type": "menu",
            "name": intro.get("name").cloned().unwrap_or_else(|| serde_json::json!("Intro")),
            "audio": audio,
            "image": serde_json::Value::Null,
            "autoBlackImage": true,
            "controlSettings": control_settings,
            "children": [next],
        });
    }

    vec![next]
}

fn compress_menu_return_defaults(entry: &mut serde_json::Value) {
    if entry.get("type").and_then(|v| v.as_str()) != Some("menu") {
        return;
    }

    let Some(menu_id) = entry
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
    else {
        return;
    };

    let Some(children) = entry.get_mut("children").and_then(|v| v.as_array_mut()) else {
        return;
    };

    let story_targets: Vec<String> = children
        .iter()
        .filter(|child| child.get("type").and_then(|v| v.as_str()) == Some("story"))
        .filter_map(|child| {
            child
                .get("returnAfterPlay")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
        })
        .collect();

    if story_targets.is_empty() {
        return;
    }

    let first_target = story_targets[0].clone();
    if !story_targets.iter().all(|target| target == &first_target) {
        return;
    }

    for child in children.iter_mut() {
        if child.get("type").and_then(|v| v.as_str()) != Some("story") {
            continue;
        }
        if child.get("returnAfterPlay").and_then(|v| v.as_str()) == Some(first_target.as_str()) {
            if let Some(obj) = child.as_object_mut() {
                obj.remove("returnAfterPlay");
            }
        }
    }

    if let Some(obj) = entry.as_object_mut() {
        if first_target == menu_id {
            obj.remove("returnAfterPlay");
        } else {
            obj.insert(
                "returnAfterPlay".to_string(),
                serde_json::Value::String(first_target),
            );
        }
    }
}

/// Suit la chaîne single-option jusqu'au premier stage ayant 0 ou N≥2 options,
/// ou jusqu'au premier stage autoplay (qui est lui-même le stage de lecture).
fn chase_single_chain(
    start_id: &str,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    visited: &mut HashSet<String>,
) -> String {
    let mut current = start_id.to_string();
    loop {
        let stage = match stages.get(current.as_str()) {
            Some(s) => s,
            None => return current,
        };
        // Un stage autoplay est un stage de lecture — ne pas traverser
        if is_stage_autoplay(stage) {
            return current;
        }
        let opts = stage_action_options(stage, actions);
        if opts.len() != 1 {
            return current;
        }
        let next_id = opts[0];
        if visited.contains(next_id) {
            return current;
        }
        visited.insert(next_id.to_string());
        current = next_id.to_string();
    }
}

/// Convertit le document story.json en `{ rootAudio, rootImage, entries }`.
/// rootAudio/rootImage = assets du squareOne (cover du pack).
/// entries = entrées éditables (story/menu) issues de la navigation.
fn walk_story_doc_to_entries(
    doc: &serde_json::Value,
    assets: &HashMap<String, PathBuf>,
) -> Result<serde_json::Value, String> {
    let pack_title = doc
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Pack importé")
        .to_string();

    let stages: HashMap<&str, &serde_json::Value> = doc
        .get("stageNodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("uuid").and_then(|u| u.as_str()).map(|id| (id, s)))
                .collect()
        })
        .unwrap_or_default();

    let actions: HashMap<&str, &serde_json::Value> = doc
        .get("actionNodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("id").and_then(|u| u.as_str()).map(|id| (id, a)))
                .collect()
        })
        .unwrap_or_default();

    let sq = doc
        .get("stageNodes")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|s| {
                s.get("squareOne")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
        })
        .ok_or_else(|| "Aucun stage squareOne dans le ZIP".to_string())?;

    let sq_id = sq.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
    let root_audio = resolve_asset(sq.get("audio").and_then(|v| v.as_str()), assets);
    let root_image = resolve_asset(sq.get("image").and_then(|v| v.as_str()), assets);

    let root_action_id = sq
        .get("okTransition")
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "squareOne sans okTransition".to_string())?;

    let root_action = actions
        .get(root_action_id)
        .ok_or_else(|| format!("Action racine introuvable : {}", root_action_id))?;

    let root_opts = action_options(root_action);
    let night_mode_available = doc
        .get("nightModeAvailable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let prompt_stage_usage: HashMap<String, usize> = stages
        .values()
        .filter(|stage| is_stage_autoplay(stage))
        .filter_map(|stage| candidate_prompt_stage_id(stage, &stages, &actions).map(str::to_string))
        .fold(HashMap::new(), |mut acc, stage_id| {
            *acc.entry(stage_id).or_insert(0) += 1;
            acc
        });

    // Stages autoplay avec audio = candidats play stages d'histoires (pour détection story→story)
    let mut story_play_stage_ids: HashSet<&str> = stages
        .values()
        .filter(|stage| {
            is_stage_autoplay(stage)
                && stage_control_bool(stage, "wheel", false)
                && stage.get("audio").and_then(|v| v.as_str()).is_some()
        })
        .filter_map(|stage| stage_uuid(stage))
        .collect();
    for stage in stages.values() {
        if is_stage_autoplay(stage) || !stage_control_bool(stage, "wheel", false) {
            continue;
        }
        let opts = stage_action_options(stage, &actions);
        if opts.len() != 1 {
            continue;
        }
        let Some(play_stage) = stages.get(opts[0]) else {
            continue;
        };
        if is_stage_autoplay(play_stage)
            && play_stage
                .get("audio")
                .and_then(|value| value.as_str())
                .is_some()
        {
            story_play_stage_ids.insert(opts[0]);
        }
    }

    let mut visited: HashSet<String> = HashSet::new();
    let mut advanced_transitions_detected = false;
    visited.insert(sq_id.to_string());

    let mut effective_root_audio = root_audio.clone();
    let mut effective_root_image = root_image.clone();

    let mut entries: Vec<serde_json::Value> = match root_opts.len() {
        0 => return Err("Le pack ne contient aucune entrée".to_string()),
        1 => {
            let first_id = root_opts[0];
            visited.insert(first_id.to_string());

            // Collecter les stages autoplay à option unique en tête de pack (intros/covers
            // qui jouent automatiquement avant d'arriver au vrai contenu sélectionnable).
            let mut intro_entries: Vec<serde_json::Value> = Vec::new();
            let mut eff_first_id = first_id;
            while let Some(s) = stages.get(eff_first_id) {
                if !is_stage_autoplay(s) {
                    break;
                }
                let opts = stage_action_options(s, &actions);
                if opts.len() != 1 {
                    break;
                }
                let next = opts[0];
                if visited.contains(next) {
                    break;
                }
                let intro_audio = resolve_asset(s.get("audio").and_then(|v| v.as_str()), assets);
                let intro_name = s
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or("Intro")
                    .to_string();
                intro_entries.push(serde_json::json!({
                    "id": stage_uuid(s).unwrap_or(""),
                    "type": "story",
                    "name": intro_name,
                    "audio": intro_audio,
                    "itemAudio": serde_json::Value::Null,
                    "itemImage": serde_json::Value::Null,
                    "controlSettings": stage_controls(s),
                }));
                visited.insert(next.to_string());
                eff_first_id = next;
            }

            let chain_audio = stages
                .get(eff_first_id)
                .and_then(|s| resolve_asset(s.get("audio").and_then(|v| v.as_str()), assets))
                .or_else(|| root_audio.clone());
            let chain_image = stages
                .get(eff_first_id)
                .and_then(|s| resolve_asset(s.get("image").and_then(|v| v.as_str()), assets));

            let terminal_id = chase_single_chain(eff_first_id, &stages, &actions, &mut visited);

            let terminal = stages
                .get(terminal_id.as_str())
                .ok_or_else(|| "Stage terminal introuvable depuis squareOne".to_string())?;
            let term_opts = stage_action_options(terminal, &actions);

            let content_entries: Vec<serde_json::Value> = match term_opts.len() {
                0 => vec![serde_json::json!({
                    "id": stage_uuid(terminal).unwrap_or(""),
                    "type": "story",
                    "name": pack_title,
                    "audio": resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets)
                              .or_else(|| chain_audio.clone()),
                    "itemAudio": chain_audio.clone(),
                    "itemImage": chain_image.clone(),
                    "controlSettings": stage_controls(terminal),
                })],
                1 => {
                    // Si terminal est autoplay, c'est lui-même le stage de lecture
                    let (story_audio, story_controls) = if is_stage_autoplay(terminal) {
                        (
                            resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(terminal),
                        )
                    } else {
                        let play_id = term_opts[0];
                        let play_stage = stages.get(play_id).copied().unwrap_or(terminal);
                        (
                            resolve_asset(play_stage.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(play_stage),
                        )
                    };
                    let story_name = terminal
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(&pack_title)
                        .to_string();
                    let detection_opt = if is_stage_autoplay(terminal) {
                        let d = detect_story_return_stage_id(
                            terminal,
                            &stages,
                            &actions,
                            &prompt_stage_usage,
                            night_mode_available,
                            &story_play_stage_ids,
                        );
                        if d.advanced {
                            advanced_transitions_detected = true;
                        }
                        Some(d)
                    } else {
                        None
                    };
                    vec![serde_json::json!({
                        "id": stage_uuid(terminal).unwrap_or(""),
                        "type": "story",
                        "name": story_name,
                        "audio": story_audio,
                        "itemAudio": resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets),
                        "itemImage": resolve_asset(terminal.get("image").and_then(|v| v.as_str()), assets),
                        "titleControlSettings": stage_controls(terminal),
                        "titleReturnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), &actions),
                        "titleReturnOnHomeNone": !has_transition_target(terminal.get("homeTransition"), &actions),
                        "returnStageId": detection_opt.as_ref().and_then(|d| d.target_stage_id.clone()),
                        "returnStoryStageId": detection_opt.as_ref().and_then(|d| d.next_story_stage_id.clone()),
                        "returnOnHomeStageId": detection_opt.as_ref().and_then(|d| d.home_stage_id.clone()),
                        "returnOnHomeNone": detection_opt.as_ref().map(|d| d.home_stage_id.is_none()).unwrap_or(false),
                        "homeStoryStageId": detection_opt.as_ref().and_then(|d| d.home_story_stage_id.clone()),
                        "afterPlaybackPromptAudio": detection_opt.as_ref().and_then(|d| {
                            d.prompt_stage_id.as_ref().and_then(|stage_id| {
                                stages
                                    .get(stage_id.as_str())
                                    .and_then(|stage| resolve_asset(stage.get("audio").and_then(|v| v.as_str()), assets))
                            })
                        }),
                        "afterPlaybackPromptControlSettings": detection_opt.as_ref().and_then(|d| d.prompt_control_settings.clone()),
                        "afterPlaybackPromptOkStageId": detection_opt.as_ref().and_then(|d| d.prompt_ok_stage_id.clone()),
                        "afterPlaybackPromptHomeStageId": detection_opt.as_ref().and_then(|d| d.prompt_home_stage_id.clone()),
                        "afterPlaybackPromptHomeNone": detection_opt.as_ref().map(|d| d.prompt_home_transition_none).unwrap_or(false),
                        "afterPlaybackSequence": detection_opt
                            .as_ref()
                            .map(|d| resolve_after_playback_sequence_assets(&d.after_playback_sequence, assets))
                            .unwrap_or_default(),
                        "afterPlaybackHomeStep": detection_opt
                            .as_ref()
                            .and_then(|d| d.home_step.as_ref())
                            .map(|step| resolve_after_playback_step_assets(step, assets)),
                        "controlSettings": story_controls,
                    })]
                }
                _ => {
                    let term_audio =
                        resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets);
                    let term_image =
                        resolve_asset(terminal.get("image").and_then(|v| v.as_str()), assets);
                    let children = collect_children_entries(
                        terminal,
                        &stages,
                        &actions,
                        assets,
                        &mut visited,
                        &mut advanced_transitions_detected,
                        &prompt_stage_usage,
                        night_mode_available,
                        &story_play_stage_ids,
                    );
                    if term_audio.is_some() || term_image.is_some() {
                        // Nœud intermédiaire avec audio/image → le préserver comme entrée menu
                        // (ex: "qui sera le héros ?" dans Suzanne et Gaston)
                        vec![serde_json::json!({
                            "id": stage_uuid(terminal).unwrap_or(""),
                            "type": "menu",
                            "name": terminal.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "audio": term_audio,
                            "image": term_image,
                            "autoBlackImage": term_image.is_none(),
                            "controlSettings": stage_controls(terminal),
                            "returnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), &actions),
                            "children": children
                        })]
                    } else {
                        // Nœud de navigation transparent → absorber l'audio et aplatir
                        if effective_root_audio.is_none() {
                            effective_root_audio = chain_audio;
                        }
                        if effective_root_image.is_none() {
                            effective_root_image = chain_image;
                        }
                        children
                    }
                }
            };

            chain_intro_entries_before_content(intro_entries, content_entries)
        }
        _ => {
            // Plusieurs options directement depuis squareOne → entrées plates
            root_opts
                .iter()
                .filter_map(|id| {
                    if visited.contains(*id) {
                        return None;
                    }
                    visited.insert((*id).to_string());
                    stages.get(id).and_then(|s| {
                        walk_entry(
                            s,
                            &stages,
                            &actions,
                            assets,
                            &mut visited,
                            &mut advanced_transitions_detected,
                            &prompt_stage_usage,
                            night_mode_available,
                            &story_play_stage_ids,
                        )
                        .ok()
                    })
                })
                .collect()
        }
    };

    let stage_names: HashMap<String, String> = stages
        .values()
        .filter_map(|stage| {
            let id = stage_uuid(stage)?;
            let name = stage
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            Some((id.to_string(), name.to_string()))
        })
        .collect();
    let existing_story_stage_ids: HashSet<String> =
        build_story_stage_map(&entries).keys().cloned().collect();
    entries = expand_sequence_choice_menus(
        entries,
        &stages,
        &actions,
        assets,
        &mut advanced_transitions_detected,
        &prompt_stage_usage,
        night_mode_available,
        &story_play_stage_ids,
        &existing_story_stage_ids,
    );
    let _legacy_advanced_transitions_detected = advanced_transitions_detected;
    let night_mode_detection =
        detect_imported_night_mode(night_mode_available, &entries, &stages, &actions, assets);
    let (night_mode_audio, night_mode_return, night_mode_home_return) = night_mode_detection
        .map(|detection| {
            (
                Some(detection.audio),
                detection.return_target,
                detection.home_target,
            )
        })
        .unwrap_or((None, None, None));
    let unresolved_transitions = assign_return_targets(&mut entries, &stage_names);
    if let Some(target) = night_mode_return.as_deref() {
        remove_night_mode_return_overrides(&mut entries, target, None);
    }
    let unresolved_transitions_detected = !unresolved_transitions.is_empty();
    let needs_native_graph_roundtrip =
        unresolved_transitions_detected && has_interactive_branching_graph(&stages, &actions);
    let native_graph = if needs_native_graph_roundtrip {
        Some(native_graph_with_resolved_assets(doc, assets))
    } else {
        None
    };
    if needs_native_graph_roundtrip {
        let mut projected_entries =
            build_native_graph_projection_entries(sq, &stages, &actions, assets);
        if projected_entries.len() <= 1 {
            projected_entries = build_native_graph_flat_stage_map_entry(&stages, assets);
        }
        if !projected_entries.is_empty() {
            entries = projected_entries;
        }
    }
    let reported_unresolved_transitions = if needs_native_graph_roundtrip {
        Vec::new()
    } else {
        unresolved_transitions
    };
    let reported_unresolved_transitions_detected = !reported_unresolved_transitions.is_empty();

    let pack_version = doc.get("version").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
    let pack_description = doc
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let night_mode_detected = night_mode_audio.is_some();

    Ok(serde_json::json!({
        "rootId": format!("import-root:{}", sq_id),
        "title": pack_title,
        "packVersion": pack_version,
        "packDescription": pack_description,
        "rootAudio": effective_root_audio,
        "rootImage": effective_root_image,
        "nightMode": night_mode_detected,
        "nightModeAudio": night_mode_audio,
        "nightModeReturn": night_mode_return,
        "nightModeHomeReturn": night_mode_home_return,
        "nativeGraph": native_graph,
        "advancedTransitionsDetected": reported_unresolved_transitions_detected,
        "unresolvedTransitions": reported_unresolved_transitions,
        "entries": entries
    }))
}

/// Retourne les stage_id options d'une action.
fn action_options(action: &serde_json::Value) -> Vec<&str> {
    action
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default()
}

/// Options de l'action liée au okTransition d'un stage.
fn stage_action_options<'a>(
    stage: &serde_json::Value,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Vec<&'a str> {
    let action_id = stage
        .get("okTransition")
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str());
    match action_id.and_then(|id| actions.get(id)) {
        Some(a) => action_options(a),
        None => vec![],
    }
}

fn native_projection_label(
    stage_id: &str,
    stage: &serde_json::Value,
    stage_ordinals: &HashMap<String, usize>,
) -> String {
    let explicit_name = stage
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "Stage title");
    if let Some(name) = explicit_name {
        return name.to_string();
    }
    let ordinal = stage_ordinals.get(stage_id).copied().unwrap_or(0) + 1;
    let kind = if stage
        .get("squareOne")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "Depart"
    } else if stage_control_bool(stage, "wheel", false) && !is_stage_autoplay(stage) {
        "Choix"
    } else if is_stage_autoplay(stage) {
        "Lecture"
    } else {
        "Stage"
    };
    format!("{} {:02}", kind, ordinal)
}

fn stage_position_key(stage: &serde_json::Value) -> (i64, i64) {
    let x = stage
        .get("position")
        .and_then(|position| position.get("x"))
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let y = stage
        .get("position")
        .and_then(|position| position.get("y"))
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    ((y * 100.0) as i64, (x * 100.0) as i64)
}

fn native_projection_ordinals(
    stages: &HashMap<&str, &serde_json::Value>,
) -> HashMap<String, usize> {
    let mut ordered: Vec<(&str, &serde_json::Value)> = stages
        .iter()
        .map(|(stage_id, stage)| (*stage_id, *stage))
        .collect();
    ordered.sort_by_key(|(_, stage)| stage_position_key(stage));
    ordered
        .into_iter()
        .enumerate()
        .map(|(index, (stage_id, _))| (stage_id.to_string(), index))
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn native_projection_story_entry(
    stage_id: &str,
    stage: &serde_json::Value,
    label: String,
    assets: &HashMap<String, PathBuf>,
    is_reference: bool,
    reference_counter: &mut usize,
) -> serde_json::Value {
    let audio = resolve_asset(stage.get("audio").and_then(|value| value.as_str()), assets);
    let image = resolve_asset(stage.get("image").and_then(|value| value.as_str()), assets);
    let id = if is_reference {
        *reference_counter += 1;
        format!("native-ref-{}-{}", *reference_counter, stage_id)
    } else {
        stage_id.to_string()
    };
    serde_json::json!({
        "id": id,
        "type": "story",
        "name": if is_reference { format!("Retour vers {}", label) } else { label },
        "audio": audio,
        "itemAudio": audio,
        "itemImage": image,
        "nativeStageId": stage_id,
        "nativeReference": is_reference,
        "controlSettings": if is_reference {
            serde_json::json!({
                "autoplay": true,
                "wheel": false,
                "pause": false,
                "ok": false,
                "home": true,
            })
        } else {
            stage_controls(stage)
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn native_projection_entry_for_stage(
    stage_id: &str,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    stage_ordinals: &HashMap<String, usize>,
    active_path: &mut HashSet<String>,
    expanded: &mut HashSet<String>,
    reference_counter: &mut usize,
) -> Option<serde_json::Value> {
    let stage = *stages.get(stage_id)?;
    let label = native_projection_label(stage_id, stage, stage_ordinals);
    if active_path.contains(stage_id) || expanded.contains(stage_id) {
        return Some(native_projection_story_entry(
            stage_id,
            stage,
            label,
            assets,
            true,
            reference_counter,
        ));
    }

    active_path.insert(stage_id.to_string());
    let options = stage_action_options(stage, actions);
    let is_choice = stage_control_bool(stage, "wheel", false) && !is_stage_autoplay(stage);
    let entry = if is_choice && !options.is_empty() {
        expanded.insert(stage_id.to_string());
        let children: Vec<serde_json::Value> = options
            .iter()
            .filter_map(|target_id| {
                native_projection_entry_for_stage(
                    target_id,
                    stages,
                    actions,
                    assets,
                    stage_ordinals,
                    active_path,
                    expanded,
                    reference_counter,
                )
            })
            .collect();
        let audio = resolve_asset(stage.get("audio").and_then(|value| value.as_str()), assets);
        let image = resolve_asset(stage.get("image").and_then(|value| value.as_str()), assets);
        serde_json::json!({
            "id": stage_id,
            "type": "menu",
            "name": label,
            "audio": audio,
            "image": image,
            "autoBlackImage": image.is_none(),
            "nativeStageId": stage_id,
            "controlSettings": stage_controls(stage),
            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
            "children": children,
        })
    } else {
        expanded.insert(stage_id.to_string());
        native_projection_story_entry(stage_id, stage, label, assets, false, reference_counter)
    };
    active_path.remove(stage_id);
    Some(entry)
}

fn build_native_graph_projection_entries(
    square_one: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    let stage_ordinals = native_projection_ordinals(stages);
    let mut active_path = HashSet::new();
    let mut expanded = HashSet::new();
    let mut reference_counter = 0usize;
    stage_action_options(square_one, actions)
        .iter()
        .filter_map(|stage_id| {
            native_projection_entry_for_stage(
                stage_id,
                stages,
                actions,
                assets,
                &stage_ordinals,
                &mut active_path,
                &mut expanded,
                &mut reference_counter,
            )
        })
        .collect()
}

fn build_native_graph_flat_stage_map_entry(
    stages: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    let stage_ordinals = native_projection_ordinals(stages);
    let mut ordered: Vec<(&str, &serde_json::Value)> = stages
        .iter()
        .filter(|(_, stage)| {
            !stage
                .get("squareOne")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
        .map(|(stage_id, stage)| (*stage_id, *stage))
        .collect();
    ordered.sort_by_key(|(_, stage)| stage_position_key(stage));

    let mut reference_counter = 0usize;
    let children: Vec<serde_json::Value> = ordered
        .into_iter()
        .map(|(stage_id, stage)| {
            native_projection_story_entry(
                stage_id,
                stage,
                native_projection_label(stage_id, stage, &stage_ordinals),
                assets,
                false,
                &mut reference_counter,
            )
        })
        .collect();

    if children.is_empty() {
        Vec::new()
    } else {
        vec![serde_json::json!({
            "id": "native-graph-stage-map",
            "type": "menu",
            "name": "Carte du graphe interactif",
            "audio": serde_json::Value::Null,
            "image": serde_json::Value::Null,
            "autoBlackImage": true,
            "controlSettings": {
                "autoplay": false,
                "wheel": true,
                "pause": false,
                "ok": true,
                "home": true,
            },
            "children": children,
        })]
    }
}

/// Construit les entrées enfants d'un stage de sélection (ses options).
#[allow(clippy::too_many_arguments)]
fn collect_children_entries(
    stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    visited: &mut HashSet<String>,
    advanced_transitions_detected: &mut bool,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> Vec<serde_json::Value> {
    stage_action_options(stage, actions)
        .iter()
        .filter_map(|id| {
            if visited.contains(*id) {
                return None;
            }
            visited.insert((*id).to_string());
            stages.get(id).and_then(|s| {
                walk_entry(
                    s,
                    stages,
                    actions,
                    assets,
                    visited,
                    advanced_transitions_detected,
                    prompt_stage_usage,
                    night_mode_available,
                    story_play_stage_ids,
                )
                .ok()
            })
        })
        .collect()
}

/// Classifie un stage comme entrée projet (story ou menu).
/// Utilise chase_single_chain pour traverser les chaînes de navigation imbriquées.
#[allow(clippy::too_many_arguments)]
fn walk_entry(
    stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    visited: &mut HashSet<String>,
    advanced_transitions_detected: &mut bool,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> Result<serde_json::Value, String> {
    let name = stage
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Histoire")
        .to_string();

    let item_audio = resolve_asset(stage.get("audio").and_then(|v| v.as_str()), assets);
    let item_image = resolve_asset(stage.get("image").and_then(|v| v.as_str()), assets);
    let opts = stage_action_options(stage, actions);

    if is_stage_autoplay(stage) {
        return Ok(autoplay_stage_to_story_entry(
            stage,
            name,
            item_audio,
            item_image,
            assets,
            actions,
            stages,
            prompt_stage_usage,
            night_mode_available,
            story_play_stage_ids,
            advanced_transitions_detected,
        ));
    }

    match opts.len() {
        0 => {
            // Feuille pure : stage de lecture sans navigation
            Ok(serde_json::json!({
                "id": stage_uuid(stage).unwrap_or(""),
                "type": "story",
                "name": name,
                "audio": item_audio,
                "itemAudio": item_audio,
                "itemImage": item_image,
                "controlSettings": stage_controls(stage),
            }))
        }
        1 => {
            let next_id = opts[0];
            if visited.contains(next_id) {
                // Cycle (transition retour) → traiter comme fin d'histoire
                return Ok(serde_json::json!({
                    "id": stage_uuid(stage).unwrap_or(""),
                    "type": "story",
                    "name": name,
                    "audio": item_audio,
                    "itemAudio": item_audio,
                    "itemImage": item_image,
                    "controlSettings": stage_controls(stage),
                }));
            }
            visited.insert(next_id.to_string());
            // Suivre la chaîne single-option jusqu'à la décision (feuille ou sélection N≥2)
            let terminal_id = chase_single_chain(next_id, stages, actions, visited);
            let terminal = stages
                .get(terminal_id.as_str())
                .ok_or_else(|| format!("Stage terminal introuvable : {}", terminal_id))?;
            let term_opts = stage_action_options(terminal, actions);

            match term_opts.len() {
                0 => {
                    // Terminal est une feuille : stage courant = titre, terminal = lecture
                    let story_audio =
                        resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets);
                    Ok(serde_json::json!({
                        "id": stage_uuid(stage).unwrap_or(""),
                        "type": "story",
                        "name": name,
                        "audio": story_audio,
                        "itemAudio": item_audio,
                        "itemImage": item_image,
                        "titleControlSettings": stage_controls(stage),
                        "titleReturnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                        "titleReturnOnHomeNone": !has_transition_target(stage.get("homeTransition"), actions),
                        "controlSettings": stage_controls(terminal),
                    }))
                }
                1 => {
                    // Cas spécial : terminal autoplay avec 1 seule cible étant un nœud de navigation
                    // (wheel=true, N≥2 options) — ex: Contemporaine-sélecteur → JohnWilliams (5 films).
                    // Créer un menu au lieu d'une histoire pour conserver la structure complète.
                    if is_stage_autoplay(terminal) {
                        let single_next_id = term_opts[0];
                        let single_next_is_wheel_nav =
                            stages.get(single_next_id).is_some_and(|s| {
                                s.get("controlSettings")
                                    .and_then(|c| c.get("wheel"))
                                    .and_then(|w| w.as_bool())
                                    .unwrap_or(false)
                                    && !s
                                        .get("controlSettings")
                                        .and_then(|c| c.get("autoplay"))
                                        .and_then(|a| a.as_bool())
                                        .unwrap_or(false)
                            });
                        if !story_play_stage_ids.contains(single_next_id)
                            && single_next_is_wheel_nav
                        {
                            if let Some(single_next_stage) = stages.get(single_next_id) {
                                let single_next_opts =
                                    stage_action_options(single_next_stage, actions);
                                if single_next_opts.len() >= 2 {
                                    if !visited.contains(single_next_id) {
                                        visited.insert(single_next_id.to_string());
                                    }
                                    let children = collect_children_entries(
                                        single_next_stage,
                                        stages,
                                        actions,
                                        assets,
                                        visited,
                                        advanced_transitions_detected,
                                        prompt_stage_usage,
                                        night_mode_available,
                                        story_play_stage_ids,
                                    );
                                    let term_audio = resolve_asset(
                                        terminal.get("audio").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let term_image = resolve_asset(
                                        terminal.get("image").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let single_audio = resolve_asset(
                                        single_next_stage.get("audio").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let single_image = resolve_asset(
                                        single_next_stage.get("image").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let single_name = single_next_stage
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let inner_menu = serde_json::json!({
                                        "id": stage_uuid(single_next_stage).unwrap_or(""),
                                        "type": "menu",
                                        "name": single_name,
                                        "audio": single_audio,
                                        "image": single_image,
                                        "autoBlackImage": single_image.is_none(),
                                        "controlSettings": stage_controls(single_next_stage),
                                        "returnOnHomeStageId": transition_target_stage_id(single_next_stage.get("homeTransition"), actions),
                                        "children": children,
                                    });
                                    return if term_audio.is_some() {
                                        let mid_menu = serde_json::json!({
                                            "id": stage_uuid(terminal).unwrap_or(""),
                                            "type": "menu",
                                            "name": terminal.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                            "audio": term_audio,
                                            "image": term_image,
                                            "autoBlackImage": term_image.is_none(),
                                            "controlSettings": stage_controls(terminal),
                                            "returnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), actions),
                                            "children": [inner_menu],
                                        });
                                        Ok(serde_json::json!({
                                            "id": stage_uuid(stage).unwrap_or(""),
                                            "type": "menu",
                                            "name": name,
                                            "audio": item_audio,
                                            "image": item_image,
                                            "autoBlackImage": item_image.is_none(),
                                            "controlSettings": stage_controls(stage),
                                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                                            "children": [mid_menu],
                                        }))
                                    } else {
                                        Ok(serde_json::json!({
                                            "id": stage_uuid(stage).unwrap_or(""),
                                            "type": "menu",
                                            "name": name,
                                            "audio": item_audio,
                                            "image": item_image,
                                            "autoBlackImage": item_image.is_none(),
                                            "controlSettings": stage_controls(stage),
                                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                                            "children": [inner_menu],
                                        }))
                                    };
                                }
                            }
                        }
                    }
                    // Si terminal est autoplay, c'est lui-même le stage de lecture
                    // (ex: pack natif Lunii où Histoire → loop nuit, la cible est un stage nuit)
                    let (play_audio, play_controls) = if is_stage_autoplay(terminal) {
                        (
                            resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(terminal),
                        )
                    } else {
                        let play_id = term_opts[0];
                        if !visited.contains(play_id) {
                            visited.insert(play_id.to_string());
                        }
                        let play_stage = stages.get(play_id).copied().unwrap_or(terminal);
                        (
                            resolve_asset(play_stage.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(play_stage),
                        )
                    };
                    let detection = detect_story_return_stage_id(
                        terminal,
                        stages,
                        actions,
                        prompt_stage_usage,
                        night_mode_available,
                        story_play_stage_ids,
                    );
                    if detection.advanced {
                        *advanced_transitions_detected = true;
                    }
                    let after_playback_prompt_audio =
                        detection.prompt_stage_id.as_ref().and_then(|stage_id| {
                            stages.get(stage_id.as_str()).and_then(|stage| {
                                resolve_asset(stage.get("audio").and_then(|v| v.as_str()), assets)
                            })
                        });
                    Ok(serde_json::json!({
                        "id": stage_uuid(stage).unwrap_or(""),
                        "type": "story",
                        "name": name,
                        "audio": play_audio,
                        "itemAudio": item_audio,
                        "itemImage": item_image,
                        "_playStageId": stage_uuid(terminal),
                        "titleControlSettings": stage_controls(stage),
                        "titleReturnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                        "titleReturnOnHomeNone": !has_transition_target(stage.get("homeTransition"), actions),
                        "returnStageId": detection.target_stage_id,
                        "returnStoryStageId": detection.next_story_stage_id,
                        "returnOnHomeStageId": detection
                            .home_stage_id
                            .clone()
                            .filter(|target| Some(target.as_str()) != detection.target_stage_id.as_deref()),
                        "returnOnHomeNone": detection.home_stage_id.is_none(),
                        "homeStoryStageId": detection.home_story_stage_id,
                        "afterPlaybackPromptAudio": after_playback_prompt_audio,
                        "afterPlaybackPromptControlSettings": detection.prompt_control_settings,
                        "afterPlaybackPromptOkStageId": detection.prompt_ok_stage_id,
                        "afterPlaybackPromptHomeStageId": detection.prompt_home_stage_id,
                        "afterPlaybackPromptHomeNone": detection.prompt_home_transition_none,
                        "afterPlaybackSequence": resolve_after_playback_sequence_assets(&detection.after_playback_sequence, assets),
                        "afterPlaybackHomeStep": detection.home_step.as_ref().map(|step| resolve_after_playback_step_assets(step, assets)),
                        "controlSettings": play_controls,
                    }))
                }
                _ => {
                    // Si le terminal est autoplay ET que le stage courant est dans ses options,
                    // c'est un cycle de retour (returnAfterPlay) — traiter comme fin d'histoire.
                    if is_stage_autoplay(terminal) {
                        let current_stage_id = stage_uuid(stage).unwrap_or("");
                        if !current_stage_id.is_empty() && term_opts.contains(&current_stage_id) {
                            let play_audio = resolve_asset(
                                terminal.get("audio").and_then(|v| v.as_str()),
                                assets,
                            );
                            let detection = detect_story_return_stage_id(
                                terminal,
                                stages,
                                actions,
                                prompt_stage_usage,
                                night_mode_available,
                                story_play_stage_ids,
                            );
                            if detection.advanced {
                                *advanced_transitions_detected = true;
                            }
                            let after_playback_prompt_audio =
                                detection.prompt_stage_id.as_ref().and_then(|stage_id| {
                                    stages.get(stage_id.as_str()).and_then(|stage| {
                                        resolve_asset(
                                            stage.get("audio").and_then(|v| v.as_str()),
                                            assets,
                                        )
                                    })
                                });
                            return Ok(serde_json::json!({
                                "id": stage_uuid(stage).unwrap_or(""),
                                "type": "story",
                                "name": name,
                                "audio": play_audio,
                                "itemAudio": item_audio,
                                "itemImage": item_image,
                                "_playStageId": stage_uuid(terminal),
                                "titleControlSettings": stage_controls(stage),
                                "titleReturnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                                "titleReturnOnHomeNone": !has_transition_target(stage.get("homeTransition"), actions),
                                "returnStageId": detection.target_stage_id,
                                "returnStoryStageId": detection.next_story_stage_id,
                                "returnOnHomeStageId": detection
                                    .home_stage_id
                                    .clone()
                                    .filter(|target| Some(target.as_str()) != detection.target_stage_id.as_deref()),
                                "returnOnHomeNone": detection.home_stage_id.is_none(),
                                "homeStoryStageId": detection.home_story_stage_id,
                                "afterPlaybackPromptAudio": after_playback_prompt_audio,
                                "afterPlaybackPromptControlSettings": detection.prompt_control_settings,
                                "afterPlaybackPromptOkStageId": detection.prompt_ok_stage_id,
                                "afterPlaybackPromptHomeStageId": detection.prompt_home_stage_id,
                                "afterPlaybackPromptHomeNone": detection.prompt_home_transition_none,
                                "afterPlaybackSequence": resolve_after_playback_sequence_assets(&detection.after_playback_sequence, assets),
                                "afterPlaybackHomeStep": detection.home_step.as_ref().map(|step| resolve_after_playback_step_assets(step, assets)),
                                "controlSettings": stage_controls(terminal),
                            }));
                        }
                    }
                    let children = collect_children_entries(
                        terminal,
                        stages,
                        actions,
                        assets,
                        visited,
                        advanced_transitions_detected,
                        prompt_stage_usage,
                        night_mode_available,
                        story_play_stage_ids,
                    );
                    let term_audio =
                        resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets);
                    let term_image =
                        resolve_asset(terminal.get("image").and_then(|v| v.as_str()), assets);
                    // Si le terminal a un audio propre, c'est un vrai nœud de sélection
                    // (ex: "qui Suzanne va-t-elle rencontrer ?") → sous-menu imbriqué.
                    if term_audio.is_some() {
                        let sub = serde_json::json!({
                            "id": stage_uuid(terminal).unwrap_or(""),
                            "type": "menu",
                            "name": terminal.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "audio": term_audio,
                            "image": term_image,
                            "autoBlackImage": term_image.is_none(),
                            "controlSettings": stage_controls(terminal),
                            "returnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), actions),
                            "children": children
                        });
                        Ok(serde_json::json!({
                            "id": stage_uuid(stage).unwrap_or(""),
                            "type": "menu",
                            "name": name,
                            "audio": item_audio,
                            "image": item_image,
                            "autoBlackImage": item_image.is_none(),
                            "controlSettings": stage_controls(stage),
                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                            "children": [sub]
                        }))
                    } else {
                        // Terminal transparent (pur nœud de navigation) → aplatir
                        Ok(serde_json::json!({
                            "id": stage_uuid(stage).unwrap_or(""),
                            "type": "menu",
                            "name": name,
                            "audio": item_audio,
                            "image": item_image,
                            "autoBlackImage": item_image.is_none(),
                            "controlSettings": stage_controls(stage),
                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                            "children": children
                        }))
                    }
                }
            }
        }
        _ => {
            // Stage avec N≥2 options directes → menu
            let children = collect_children_entries(
                stage,
                stages,
                actions,
                assets,
                visited,
                advanced_transitions_detected,
                prompt_stage_usage,
                night_mode_available,
                story_play_stage_ids,
            );
            Ok(serde_json::json!({
                "id": stage_uuid(stage).unwrap_or(""),
                "type": "menu",
                "name": name,
                "audio": item_audio,
                "image": item_image,
                "autoBlackImage": item_image.is_none(),
                "controlSettings": stage_controls(stage),
                "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                "children": children
            }))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn expand_sequence_choice_menus(
    entries: Vec<serde_json::Value>,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    advanced_transitions_detected: &mut bool,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
    existing_story_stage_ids: &HashSet<String>,
) -> Vec<serde_json::Value> {
    let mut expanded = Vec::new();
    for mut entry in entries {
        if entry.get("type").and_then(|value| value.as_str()) == Some("menu") {
            if let Some(children) = entry
                .get_mut("children")
                .and_then(|value| value.as_array_mut())
            {
                let current_children = std::mem::take(children);
                *children = expand_sequence_choice_menus(
                    current_children,
                    stages,
                    actions,
                    assets,
                    advanced_transitions_detected,
                    prompt_stage_usage,
                    night_mode_available,
                    story_play_stage_ids,
                    existing_story_stage_ids,
                );
            }
            expanded.push(entry);
            continue;
        }

        let continuation_menus = extract_sequence_choice_menus(
            &mut entry,
            stages,
            actions,
            assets,
            advanced_transitions_detected,
            prompt_stage_usage,
            night_mode_available,
            story_play_stage_ids,
            existing_story_stage_ids,
        );
        expanded.push(entry);
        expanded.extend(continuation_menus);
    }
    expanded
}

#[allow(clippy::too_many_arguments)]
fn extract_sequence_choice_menus(
    entry: &mut serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    advanced_transitions_detected: &mut bool,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
    existing_story_stage_ids: &HashSet<String>,
) -> Vec<serde_json::Value> {
    if entry.get("type").and_then(|value| value.as_str()) != Some("story") {
        return Vec::new();
    }
    let entry_id = entry
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("story")
        .to_string();
    let entry_name = entry
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("Histoire")
        .to_string();

    let Some(steps) = entry
        .get_mut("afterPlaybackSequence")
        .and_then(|value| value.as_array_mut())
    else {
        return Vec::new();
    };

    let mut menus = Vec::new();
    for step in steps.iter_mut() {
        let Some(step_obj) = step.as_object_mut() else {
            continue;
        };
        let choice_ids: Vec<String> = step_obj
            .get("okChoiceStageIds")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        if choice_ids.len() <= 1
            || choice_ids
                .iter()
                .all(|stage_id| existing_story_stage_ids.contains(stage_id))
        {
            continue;
        }

        let step_id = step_obj
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("step");
        let step_name = step_obj
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("Ok ?")
            .to_string();
        let menu_id = format!("{entry_id}-sequence-choice-{step_id}");
        let mut local_visited = HashSet::new();
        let mut children: Vec<serde_json::Value> = choice_ids
            .iter()
            .filter_map(|stage_id| {
                let stage = stages.get(stage_id.as_str())?;
                walk_entry(
                    stage,
                    stages,
                    actions,
                    assets,
                    &mut local_visited,
                    advanced_transitions_detected,
                    prompt_stage_usage,
                    night_mode_available,
                    story_play_stage_ids,
                )
                .ok()
            })
            .collect();
        if children.is_empty() {
            continue;
        }
        for child in children.iter_mut() {
            prefix_imported_continuation_ids(child, &menu_id);
        }

        step_obj.remove("okChoiceStageIds");
        step_obj.remove("okStageId");
        step_obj.insert(
            "okTarget".to_string(),
            serde_json::Value::String(menu_id.clone()),
        );
        menus.push(serde_json::json!({
            "id": menu_id,
            "type": "menu",
            "name": format!("Suite apres {entry_name}"),
            "audio": serde_json::Value::Null,
            "image": serde_json::Value::Null,
            "autoBlackImage": true,
            "controlSettings": {
                "autoplay": false,
                "wheel": true,
                "ok": true,
                "home": true,
                "pause": false
            },
            "children": children,
            "_importedContinuation": {
                "sourceStoryId": entry_id,
                "sourceStoryName": entry_name,
                "sourceStepName": step_name
            }
        }));
    }
    menus
}

fn prefix_imported_continuation_ids(entry: &mut serde_json::Value, prefix: &str) {
    if let Some(obj) = entry.as_object_mut() {
        if let Some(id) = obj
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
        {
            obj.insert(
                "id".to_string(),
                serde_json::Value::String(format!("{prefix}-{id}")),
            );
        }
        if let Some(children) = obj
            .get_mut("children")
            .and_then(|value| value.as_array_mut())
        {
            for child in children.iter_mut() {
                prefix_imported_continuation_ids(child, prefix);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_entry_count_limit_rejects_large_zip() {
        let err = ensure_zip_entry_count(ARCHIVE_MAX_ENTRIES + 1, Path::new("too-large.zip"))
            .unwrap_err();
        assert!(err.contains("Archive trop volumineuse"));
        assert!(err.contains(&ARCHIVE_MAX_ENTRIES.to_string()));
    }

    #[test]
    fn story_json_size_limit_rejects_large_entry() {
        let err = ensure_zip_entry_size(
            "story.json",
            "story.json",
            MAX_STORY_JSON_BYTES + 1,
            MAX_STORY_JSON_BYTES,
        )
        .unwrap_err();
        assert!(err.contains("story.json trop volumineux"));
    }

    #[test]
    fn asset_size_limit_rejects_large_entry() {
        let err = ensure_zip_entry_size(
            "Asset",
            "assets/audio.mp3",
            ARCHIVE_MAX_FILE_BYTES + 1,
            ARCHIVE_MAX_FILE_BYTES,
        )
        .unwrap_err();
        assert!(err.contains("Asset trop volumineux"));
    }

    #[test]
    fn assigns_imported_title_home_targets() {
        let mut entries = vec![serde_json::json!({
            "id": "root-menu",
            "type": "menu",
            "name": "Root",
            "children": [
                {
                    "id": "target-menu",
                    "type": "menu",
                    "name": "Target",
                    "children": [
                        {
                            "id": "plain-story",
                            "type": "story",
                            "name": "Plain",
                            "_playStageId": "plain-play"
                        }
                    ]
                },
                {
                    "id": "story-with-title-home",
                    "type": "story",
                    "name": "With title home",
                    "_playStageId": "story-play",
                    "titleReturnOnHomeStageId": "target-menu"
                },
                {
                    "id": "story-without-title-home",
                    "type": "story",
                    "name": "Without title home",
                    "_playStageId": "story-no-home-play",
                    "titleReturnOnHomeStageId": null,
                    "titleReturnOnHomeNone": true
                },
                {
                    "id": "story-title-home-to-story",
                    "type": "story",
                    "name": "Home to story",
                    "_playStageId": "story-home-to-story-play",
                    "titleReturnOnHomeStageId": "plain-play"
                }
            ]
        })];

        let unresolved = assign_return_targets(&mut entries, &HashMap::new());
        assert!(unresolved.is_empty());
        let children = entries[0]
            .get("children")
            .and_then(|value| value.as_array())
            .expect("root children");

        assert_eq!(
            children[1]
                .get("titleReturnOnHome")
                .and_then(|v| v.as_str()),
            Some("target-menu")
        );
        assert_eq!(
            children[2]
                .get("titleReturnOnHomeNone")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            children[3]
                .get("titleReturnOnHome")
                .and_then(|v| v.as_str()),
            Some("story_play:plain-story")
        );
        assert!(children[1].get("titleReturnOnHomeStageId").is_none());
        assert!(children[2].get("titleReturnOnHomeStageId").is_none());
    }

    #[test]
    fn autoplay_choice_options_are_imported_as_story_leaves() {
        let doc = serde_json::json!({
            "title": "Autoplay choices",
            "nightModeAvailable": false,
            "actionNodes": [
                { "id": "square-action", "options": ["composer", "standalone"] },
                { "id": "composer-action", "options": ["piece-1", "piece-2"] },
                { "id": "piece-1-action", "options": ["piece-1", "piece-2"] },
                { "id": "piece-2-action", "options": ["bell"] },
                { "id": "bell-action", "options": ["info"] },
                { "id": "info-action", "options": ["ok-prompt"] },
                { "id": "prompt-action", "options": ["piece-3", "bonus"] },
                { "id": "home-action", "options": ["composer"] }
            ],
            "stageNodes": [
                {
                    "uuid": "square",
                    "squareOne": true,
                    "okTransition": { "actionNode": "square-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false }
                },
                {
                    "uuid": "composer",
                    "name": "Composer",
                    "audio": "composer.mp3",
                    "image": "composer.png",
                    "okTransition": { "actionNode": "composer-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
                },
                {
                    "uuid": "piece-1",
                    "name": "Piece 1",
                    "audio": "piece-1.mp3",
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                    "okTransition": { "actionNode": "piece-1-action", "optionIndex": 1 },
                    "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
                },
                {
                    "uuid": "piece-2",
                    "name": "Piece 2",
                    "audio": "piece-2.mp3",
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                    "okTransition": { "actionNode": "piece-2-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
                },
                {
                    "uuid": "bell",
                    "name": "Bell",
                    "audio": "bell.mp3",
                    "okTransition": { "actionNode": "bell-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
                },
                {
                    "uuid": "info",
                    "name": "Info",
                    "audio": "info.mp3",
                    "okTransition": { "actionNode": "info-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": false }
                },
                {
                    "uuid": "ok-prompt",
                    "name": "Ok ?",
                    "audio": "ok.mp3",
                    "okTransition": { "actionNode": "prompt-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": false, "ok": true, "home": true }
                },
                {
                    "uuid": "piece-3",
                    "name": "Piece 3",
                    "audio": "piece-3.mp3",
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
                },
                {
                    "uuid": "bonus",
                    "name": "Bonus",
                    "audio": "bonus.mp3",
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
                },
                {
                    "uuid": "standalone",
                    "name": "Standalone",
                    "audio": "standalone.mp3",
                    "controlSettings": { "autoplay": false }
                }
            ]
        });
        let assets = HashMap::from([
            ("composer.mp3".to_string(), PathBuf::from("composer.mp3")),
            ("composer.png".to_string(), PathBuf::from("composer.png")),
            ("piece-1.mp3".to_string(), PathBuf::from("piece-1.mp3")),
            ("piece-2.mp3".to_string(), PathBuf::from("piece-2.mp3")),
            ("piece-3.mp3".to_string(), PathBuf::from("piece-3.mp3")),
            ("bonus.mp3".to_string(), PathBuf::from("bonus.mp3")),
            ("bell.mp3".to_string(), PathBuf::from("bell.mp3")),
            ("info.mp3".to_string(), PathBuf::from("info.mp3")),
            ("ok.mp3".to_string(), PathBuf::from("ok.mp3")),
            (
                "standalone.mp3".to_string(),
                PathBuf::from("standalone.mp3"),
            ),
        ]);

        let result = walk_story_doc_to_entries(&doc, &assets).expect("imported entries");
        assert_eq!(
            result
                .get("advancedTransitionsDetected")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        let entries = result
            .get("entries")
            .and_then(|value| value.as_array())
            .expect("entries array");
        let composer = entries
            .iter()
            .find(|entry| entry.get("id").and_then(|value| value.as_str()) == Some("composer"))
            .expect("composer entry");
        let children = composer
            .get("children")
            .and_then(|value| value.as_array())
            .expect("composer children");

        assert_eq!(children.len(), 3);
        assert_eq!(
            children[2].get("type").and_then(|value| value.as_str()),
            Some("menu")
        );
        assert_eq!(
            children[0]
                .get("returnAfterPlay")
                .and_then(|value| value.as_str()),
            Some("story:piece-2")
        );
        assert_eq!(
            children[1]
                .get("returnAfterPlay")
                .and_then(|value| value.as_str()),
            Some("story_play:piece-2-sequence-choice-ok-prompt-piece-3")
        );
        let sequence = children[1]
            .get("afterPlaybackSequence")
            .and_then(|value| value.as_array())
            .expect("piece 2 sequence");
        assert_eq!(sequence.len(), 3);
        assert_eq!(
            sequence[0].get("name").and_then(|value| value.as_str()),
            Some("Bell")
        );
        assert_eq!(
            sequence[0].get("audio").and_then(|value| value.as_str()),
            Some("bell.mp3")
        );
        assert_eq!(
            sequence[2].get("name").and_then(|value| value.as_str()),
            Some("Ok ?")
        );
        assert_eq!(
            sequence[2].get("okTarget").and_then(|value| value.as_str()),
            Some("piece-2-sequence-choice-ok-prompt")
        );
        let continuation_children = children[2]
            .get("children")
            .and_then(|value| value.as_array())
            .expect("continuation children");
        assert_eq!(continuation_children.len(), 2);
        assert_eq!(
            continuation_children[0]
                .get("name")
                .and_then(|value| value.as_str()),
            Some("Piece 3")
        );
        assert_eq!(
            continuation_children[0]
                .get("id")
                .and_then(|value| value.as_str()),
            Some("piece-2-sequence-choice-ok-prompt-piece-3")
        );
        assert_eq!(
            continuation_children[1]
                .get("name")
                .and_then(|value| value.as_str()),
            Some("Bonus")
        );
        assert_eq!(
            continuation_children[1]
                .get("id")
                .and_then(|value| value.as_str()),
            Some("piece-2-sequence-choice-ok-prompt-bonus")
        );
        assert!(children[0].get("children").is_none());
    }

    #[test]
    fn home_transition_to_story_entry_is_not_advanced() {
        let title_stage = serde_json::json!({
            "uuid": "story-title",
            "okTransition": { "actionNode": "title-action", "optionIndex": 0 },
            "controlSettings": { "autoplay": false }
        });
        let play_stage = serde_json::json!({
            "uuid": "story-play",
            "audio": "story.mp3",
            "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
            "okTransition": { "actionNode": "ok-action", "optionIndex": 0 },
            "controlSettings": { "autoplay": true }
        });
        let menu_stage = serde_json::json!({
            "uuid": "return-menu",
            "controlSettings": { "autoplay": false }
        });
        let title_action = serde_json::json!({
            "id": "title-action",
            "options": ["story-play"]
        });
        let home_action = serde_json::json!({
            "id": "home-action",
            "options": ["story-title"]
        });
        let ok_action = serde_json::json!({
            "id": "ok-action",
            "options": ["return-menu"]
        });

        let stages = HashMap::from([
            ("story-title", &title_stage),
            ("story-play", &play_stage),
            ("return-menu", &menu_stage),
        ]);
        let actions = HashMap::from([
            ("title-action", &title_action),
            ("home-action", &home_action),
            ("ok-action", &ok_action),
        ]);
        let prompt_stage_usage = HashMap::new();
        let story_play_stage_ids = HashSet::from(["story-play"]);

        let detection = detect_story_return_stage_id(
            &play_stage,
            &stages,
            &actions,
            &prompt_stage_usage,
            false,
            &story_play_stage_ids,
        );

        assert!(!detection.advanced);
        assert_eq!(detection.target_stage_id.as_deref(), Some("return-menu"));
        assert_eq!(
            detection.home_story_stage_id.as_deref(),
            Some("story-title")
        );
    }

    #[test]
    fn non_autoplay_prompt_stage_is_detected_as_after_playback_prompt() {
        let play_stage = serde_json::json!({
            "uuid": "story-play",
            "audio": "story.mp3",
            "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
            "okTransition": { "actionNode": "prompt-entry-action", "optionIndex": 0 },
            "controlSettings": { "autoplay": true, "ok": false, "home": true }
        });
        let prompt_stage = serde_json::json!({
            "uuid": "prompt-stage",
            "audio": "prompt.mp3",
            "homeTransition": null,
            "okTransition": { "actionNode": "prompt-ok-action", "optionIndex": 0 },
            "controlSettings": {
                "autoplay": false,
                "wheel": false,
                "pause": false,
                "ok": true,
                "home": true
            }
        });
        let current_title_stage = serde_json::json!({
            "uuid": "current-title",
            "okTransition": { "actionNode": "current-title-action", "optionIndex": 0 },
            "controlSettings": { "autoplay": false }
        });
        let next_title_stage = serde_json::json!({
            "uuid": "next-title",
            "okTransition": { "actionNode": "next-title-action", "optionIndex": 0 },
            "controlSettings": { "autoplay": false }
        });
        let next_play_stage = serde_json::json!({
            "uuid": "next-play",
            "audio": "next.mp3",
            "controlSettings": { "autoplay": true }
        });
        let home_action = serde_json::json!({
            "id": "home-action",
            "options": ["current-title"]
        });
        let prompt_entry_action = serde_json::json!({
            "id": "prompt-entry-action",
            "options": ["prompt-stage"]
        });
        let prompt_ok_action = serde_json::json!({
            "id": "prompt-ok-action",
            "options": ["next-title"]
        });
        let current_title_action = serde_json::json!({
            "id": "current-title-action",
            "options": ["story-play"]
        });
        let next_title_action = serde_json::json!({
            "id": "next-title-action",
            "options": ["next-play"]
        });

        let stages = HashMap::from([
            ("story-play", &play_stage),
            ("prompt-stage", &prompt_stage),
            ("current-title", &current_title_stage),
            ("next-title", &next_title_stage),
            ("next-play", &next_play_stage),
        ]);
        let actions = HashMap::from([
            ("home-action", &home_action),
            ("prompt-entry-action", &prompt_entry_action),
            ("prompt-ok-action", &prompt_ok_action),
            ("current-title-action", &current_title_action),
            ("next-title-action", &next_title_action),
        ]);
        let prompt_stage_usage = HashMap::from([("prompt-stage".to_string(), 1)]);
        let story_play_stage_ids = HashSet::from(["story-play", "next-play"]);

        let detection = detect_story_return_stage_id(
            &play_stage,
            &stages,
            &actions,
            &prompt_stage_usage,
            true,
            &story_play_stage_ids,
        );

        assert!(!detection.advanced);
        assert_eq!(detection.prompt_stage_id.as_deref(), Some("prompt-stage"));
        assert_eq!(detection.prompt_ok_stage_id.as_deref(), Some("next-title"));
        assert_eq!(detection.prompt_home_stage_id, None);
        assert_eq!(detection.next_story_stage_id.as_deref(), Some("next-title"));
        assert_eq!(
            detection.home_story_stage_id.as_deref(),
            Some("current-title")
        );
        assert!(detection.prompt_home_transition_none);
        assert_eq!(
            detection
                .prompt_control_settings
                .as_ref()
                .and_then(|controls| controls.get("autoplay"))
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn repeated_prompt_stages_are_not_imported_as_global_night_mode() {
        let doc = serde_json::json!({
            "title": "Prompt pack",
            "nightModeAvailable": true,
            "actionNodes": [
                { "id": "root-action", "options": ["story-1", "story-2"] },
                { "id": "story-1-title-action", "options": ["story-1-play"] },
                { "id": "story-2-title-action", "options": ["story-2-play"] },
                { "id": "story-1-play-action", "options": ["story-1-prompt"] },
                { "id": "story-2-play-action", "options": ["story-2-prompt"] },
                { "id": "story-1-prompt-action", "options": ["story-2"] },
                { "id": "story-2-prompt-action", "options": ["story-1"] },
                { "id": "story-1-home-action", "options": ["story-1"] },
                { "id": "story-2-home-action", "options": ["story-2"] }
            ],
            "stageNodes": [
                {
                    "uuid": "square",
                    "squareOne": true,
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false }
                },
                {
                    "uuid": "story-1",
                    "name": "Lombric",
                    "audio": "story-1-title.mp3",
                    "okTransition": { "actionNode": "story-1-title-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
                },
                {
                    "uuid": "story-1-play",
                    "name": "Lombric lecture",
                    "audio": "story-1.mp3",
                    "homeTransition": { "actionNode": "story-1-home-action", "optionIndex": 0 },
                    "okTransition": { "actionNode": "story-1-play-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
                },
                {
                    "uuid": "story-1-prompt",
                    "name": "Une autre bestiole",
                    "audio": "prompt.mp3",
                    "homeTransition": null,
                    "okTransition": { "actionNode": "story-1-prompt-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": false, "ok": true, "home": true }
                },
                {
                    "uuid": "story-2",
                    "name": "Limace",
                    "audio": "story-2-title.mp3",
                    "okTransition": { "actionNode": "story-2-title-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
                },
                {
                    "uuid": "story-2-play",
                    "name": "Limace lecture",
                    "audio": "story-2.mp3",
                    "homeTransition": { "actionNode": "story-2-home-action", "optionIndex": 0 },
                    "okTransition": { "actionNode": "story-2-play-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
                },
                {
                    "uuid": "story-2-prompt",
                    "name": "Une autre bestiole",
                    "audio": "prompt.mp3",
                    "homeTransition": null,
                    "okTransition": { "actionNode": "story-2-prompt-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": false, "ok": true, "home": true }
                }
            ]
        });
        let assets = HashMap::from([
            (
                "story-1-title.mp3".to_string(),
                PathBuf::from("story-1-title.mp3"),
            ),
            ("story-1.mp3".to_string(), PathBuf::from("story-1.mp3")),
            (
                "story-2-title.mp3".to_string(),
                PathBuf::from("story-2-title.mp3"),
            ),
            ("story-2.mp3".to_string(), PathBuf::from("story-2.mp3")),
            ("prompt.mp3".to_string(), PathBuf::from("prompt.mp3")),
        ]);

        let result = walk_story_doc_to_entries(&doc, &assets).expect("imported entries");
        assert_eq!(result["nightMode"].as_bool(), Some(false));
        assert!(result["nightModeAudio"].is_null());
        assert!(result["nightModeReturn"].is_null());

        let entries = result["entries"].as_array().expect("entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0]["afterPlaybackPromptAudio"].as_str(),
            Some("prompt.mp3")
        );
        assert_eq!(
            entries[0]["afterPlaybackPromptOkTarget"].as_str(),
            Some("story:story-2")
        );
        assert_eq!(
            entries[1]["afterPlaybackPromptOkTarget"].as_str(),
            Some("story:story-1")
        );
    }

    #[test]
    fn duplicated_night_stages_are_imported_as_next_story_night_mode() {
        let doc = serde_json::json!({
            "title": "Night next",
            "nightModeAvailable": true,
            "actionNodes": [
                { "id": "root-action", "options": ["story-1", "story-2"] },
                { "id": "story-1-title-action", "options": ["story-1-play"] },
                { "id": "story-2-title-action", "options": ["story-2-play"] },
                { "id": "story-1-play-action", "options": ["story-1-night"] },
                { "id": "story-2-play-action", "options": ["story-2-night"] },
                { "id": "story-1-night-action", "options": ["story-2"] },
                { "id": "story-2-night-action", "options": ["story-2"] },
                { "id": "story-1-home-action", "options": ["story-1"] },
                { "id": "story-2-home-action", "options": ["story-2"] }
            ],
            "stageNodes": [
                {
                    "uuid": "square",
                    "squareOne": true,
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false }
                },
                {
                    "uuid": "story-1",
                    "name": "Lombric",
                    "audio": "story-1-title.mp3",
                    "okTransition": { "actionNode": "story-1-title-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
                },
                {
                    "uuid": "story-1-play",
                    "name": "Lombric lecture",
                    "audio": "story-1.mp3",
                    "homeTransition": { "actionNode": "story-1-home-action", "optionIndex": 0 },
                    "okTransition": { "actionNode": "story-1-play-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
                },
                {
                    "uuid": "story-1-night",
                    "name": "nightStage",
                    "audio": "night.mp3",
                    "homeTransition": null,
                    "okTransition": { "actionNode": "story-1-night-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": true, "home": true }
                },
                {
                    "uuid": "story-2",
                    "name": "Limace",
                    "audio": "story-2-title.mp3",
                    "okTransition": { "actionNode": "story-2-title-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
                },
                {
                    "uuid": "story-2-play",
                    "name": "Limace lecture",
                    "audio": "story-2.mp3",
                    "homeTransition": { "actionNode": "story-2-home-action", "optionIndex": 0 },
                    "okTransition": { "actionNode": "story-2-play-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
                },
                {
                    "uuid": "story-2-night",
                    "name": "nightStage",
                    "audio": "night.mp3",
                    "homeTransition": null,
                    "okTransition": { "actionNode": "story-2-night-action", "optionIndex": 0 },
                    "controlSettings": { "autoplay": true, "wheel": false, "ok": true, "home": true }
                }
            ]
        });
        let assets = HashMap::from([
            (
                "story-1-title.mp3".to_string(),
                PathBuf::from("story-1-title.mp3"),
            ),
            ("story-1.mp3".to_string(), PathBuf::from("story-1.mp3")),
            (
                "story-2-title.mp3".to_string(),
                PathBuf::from("story-2-title.mp3"),
            ),
            ("story-2.mp3".to_string(), PathBuf::from("story-2.mp3")),
            ("night.mp3".to_string(), PathBuf::from("night.mp3")),
        ]);

        let result = walk_story_doc_to_entries(&doc, &assets).expect("imported entries");
        assert_eq!(result["nightMode"].as_bool(), Some(true));
        assert_eq!(result["nightModeAudio"].as_str(), Some("night.mp3"));
        assert_eq!(result["nightModeReturn"].as_str(), Some("next_story"));

        let entries = result["entries"].as_array().expect("entries");
        assert!(entries
            .iter()
            .all(|entry| entry["afterPlaybackPromptAudio"].as_str().is_none()));
        assert!(entries
            .iter()
            .all(|entry| entry["returnAfterPlay"].as_str().is_none()));
    }

    #[test]
    fn modeled_after_playback_sequence_is_not_reported_as_unresolved_transition() {
        let mut entries = vec![serde_json::json!({
            "id": "menu",
            "type": "menu",
            "name": "Menu",
            "children": [
                {
                    "id": "story",
                    "type": "story",
                    "name": "Story",
                    "_playStageId": "story-play",
                    "afterPlaybackSequence": [
                        {
                            "id": "step",
                            "name": "Ok ?",
                            "okStageId": "next-play",
                            "homeStageId": "menu"
                        }
                    ]
                },
                {
                    "id": "next",
                    "type": "story",
                    "name": "Next",
                    "_playStageId": "next-play"
                }
            ]
        })];

        let unresolved = assign_return_targets(&mut entries, &HashMap::new());
        let step = &entries[0]["children"][0]["afterPlaybackSequence"][0];

        assert!(unresolved.is_empty());
        assert_eq!(step["okTarget"].as_str(), Some("story_play:next"));
        assert_eq!(step["homeTarget"].as_str(), Some("menu"));
    }

    #[test]
    fn unresolved_after_playback_sequence_target_is_reported() {
        let mut entries = vec![serde_json::json!({
            "id": "story",
            "type": "story",
            "name": "Story",
            "afterPlaybackSequence": [
                {
                    "id": "step",
                    "name": "Ok ?",
                    "okStageId": "missing-stage"
                }
            ]
        })];

        let unresolved = assign_return_targets(
            &mut entries,
            &HashMap::from([("missing-stage".to_string(), "Hidden target".to_string())]),
        );

        assert_eq!(unresolved.len(), 1);
        assert_eq!(
            unresolved[0]["targetStageName"].as_str(),
            Some("Hidden target")
        );
        assert!(entries[0]["afterPlaybackSequence"][0]
            .get("okTarget")
            .is_none());
    }

    #[test]
    fn cloche_retour_home_targets_do_not_flood_import_warnings() {
        let mut entries = vec![serde_json::json!({
            "id": "story",
            "type": "story",
            "name": "Story",
            "returnOnHomeStageId": "cloche-retour"
        })];

        let unresolved = assign_return_targets(
            &mut entries,
            &HashMap::from([("cloche-retour".to_string(), "Cloche retour".to_string())]),
        );

        assert!(unresolved.is_empty());
        assert!(entries[0].get("returnOnHome").is_none());
    }

    #[test]
    fn total_asset_size_limit_is_five_gib() {
        ensure_total_asset_size(5 * 1024 * 1024 * 1024).unwrap();
        let err = ensure_total_asset_size(5 * 1024 * 1024 * 1024 + 1).unwrap_err();
        assert!(err.contains("maximum 5120 Mo"));
    }
}
