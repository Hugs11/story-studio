use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};

#[derive(Debug, Clone)]
pub(crate) struct StageAssetRef {
    pub stage_index: usize,
    pub stage_id: String,
    pub stage_name: String,
    pub asset_name: String,
    pub item_type: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LoadedPackDoc {
    pub story: serde_json::Value,
    pub asset_names: HashSet<String>,
    pub audio_refs: Vec<StageAssetRef>,
    pub image_refs: Vec<StageAssetRef>,
    pub stage_count: usize,
    pub action_count: usize,
}

pub(crate) fn read_pack_doc(zip_path: &Path) -> Result<LoadedPackDoc, String> {
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Archive ZIP invalide : {}", e))?;
    ensure_entry_count(archive.len(), zip_path)?;

    let mut asset_names = HashSet::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Lecture ZIP index {} impossible : {}", i, e))?;
        if entry.is_dir() {
            continue;
        }
        ensure_entry_size(entry.name(), entry.size())?;
        let name = entry.name().replace('\\', "/");
        if let Some(short) = name.strip_prefix("assets/") {
            if is_safe_asset_name(short) {
                asset_names.insert(short.to_string());
            }
        }
    }

    let story_json = read_zip_entry_to_string(zip_path, "story.json")?;
    let story: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;
    let (audio_refs, image_refs, stage_count, action_count) = collect_asset_refs(&story);

    Ok(LoadedPackDoc {
        story,
        asset_names,
        audio_refs,
        image_refs,
        stage_count,
        action_count,
    })
}

pub(crate) fn read_zip_entry_bytes(zip_path: &Path, entry_name: &str) -> Result<Vec<u8>, String> {
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Archive ZIP invalide : {}", e))?;
    ensure_entry_count(archive.len(), zip_path)?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| format!("Entrée introuvable dans le ZIP : {}", entry_name))?;
    ensure_entry_size(entry_name, entry.size())?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Lecture {} impossible : {}", entry_name, e))?;
    Ok(bytes)
}

pub(crate) fn update_story_asset_refs(
    story: &mut serde_json::Value,
    audio_map: &HashMap<String, String>,
    image_map: &HashMap<String, String>,
) {
    let Some(stages) = story
        .get_mut("stageNodes")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for stage in stages {
        if let Some(audio) = stage.get_mut("audio") {
            if let Some(current) = audio.as_str().and_then(|value| audio_map.get(value)) {
                *audio = serde_json::Value::String(current.clone());
            }
        }
        if let Some(image) = stage.get_mut("image") {
            if let Some(current) = image.as_str().and_then(|value| image_map.get(value)) {
                *image = serde_json::Value::String(current.clone());
            }
        }
    }
}

pub(crate) fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn read_zip_entry_to_string(zip_path: &Path, entry_name: &str) -> Result<String, String> {
    let bytes = read_zip_entry_bytes(zip_path, entry_name)?;
    String::from_utf8(bytes).map_err(|e| format!("{} n'est pas en UTF-8 : {}", entry_name, e))
}

fn ensure_entry_count(len: usize, zip_path: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err(format!(
            "Archive trop volumineuse : {} entrées dans {} (maximum {}).",
            len,
            zip_path.display(),
            ARCHIVE_MAX_ENTRIES
        ));
    }
    Ok(())
}

fn ensure_entry_size(name: &str, size: u64) -> Result<(), String> {
    if size > ARCHIVE_MAX_FILE_BYTES {
        return Err(format!(
            "Fichier trop volumineux : {} fait {} Mo (maximum {} Mo).",
            name,
            size / 1024 / 1024,
            ARCHIVE_MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn collect_asset_refs(
    story: &serde_json::Value,
) -> (Vec<StageAssetRef>, Vec<StageAssetRef>, usize, usize) {
    let stages = story
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let action_count = story
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);

    let mut audio_refs = Vec::new();
    let mut image_refs = Vec::new();
    let stage_labels = display_labels_by_stage_id(story, &stages);
    for (index, stage) in stages.iter().enumerate() {
        let stage_id = stage
            .get("uuid")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let stage_name = stage
            .get("name")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Élément {}", index + 1));
        let display_name = stage_labels
            .get(stage_id.as_str())
            .cloned()
            .unwrap_or_else(|| stage_name.clone());
        let item_type = classify_stage(stage);
        if let Some(audio) = stage
            .get("audio")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
        {
            audio_refs.push(StageAssetRef {
                stage_index: index,
                stage_id: stage_id.clone(),
                stage_name: display_name.clone(),
                asset_name: audio.to_string(),
                item_type: item_type.clone(),
            });
        }
        if let Some(image) = stage
            .get("image")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
        {
            image_refs.push(StageAssetRef {
                stage_index: index,
                stage_id: stage_id.clone(),
                stage_name: display_name.clone(),
                asset_name: image.to_string(),
                item_type: item_type.clone(),
            });
        }
    }
    (audio_refs, image_refs, stages.len(), action_count)
}

fn display_labels_by_stage_id(
    story: &serde_json::Value,
    stages: &[serde_json::Value],
) -> HashMap<String, String> {
    let stage_by_id: HashMap<&str, &serde_json::Value> = stages
        .iter()
        .filter_map(|stage| Some((stage.get("uuid")?.as_str()?, stage)))
        .collect();
    let action_options_by_id = action_options_by_id(story);
    let mut labels = HashMap::new();

    for stage in stages {
        if is_stage_autoplay(stage) || !stage_control_bool(stage, "wheel", false) {
            continue;
        }
        let Some(visible_name) = stage_name(stage) else {
            continue;
        };
        let Some(play_stage_id) = single_ok_target_stage_id(stage, &action_options_by_id) else {
            continue;
        };
        let Some(play_stage) = stage_by_id.get(play_stage_id) else {
            continue;
        };
        if is_stage_autoplay(play_stage)
            && play_stage
                .get("audio")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .is_some()
        {
            labels.insert(play_stage_id.to_string(), visible_name.to_string());
        }
    }

    labels
}

fn action_options_by_id(story: &serde_json::Value) -> HashMap<&str, Vec<&str>> {
    story
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .map(|actions| {
            actions
                .iter()
                .filter_map(|action| {
                    let id = action.get("id").and_then(|value| value.as_str())?;
                    let options = action
                        .get("options")
                        .and_then(|value| value.as_array())?
                        .iter()
                        .filter_map(|value| value.as_str())
                        .collect::<Vec<_>>();
                    Some((id, options))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn classify_stage(stage: &serde_json::Value) -> String {
    if stage
        .get("squareOne")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return "Racine".to_string();
    }
    let controls = stage.get("controlSettings");
    let autoplay = controls
        .and_then(|value| value.get("autoplay"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let wheel = controls
        .and_then(|value| value.get("wheel"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if autoplay {
        "Histoire".to_string()
    } else if wheel {
        "Titre".to_string()
    } else {
        "Navigation".to_string()
    }
}

fn stage_name(stage: &serde_json::Value) -> Option<&str> {
    stage
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

fn is_stage_autoplay(stage: &serde_json::Value) -> bool {
    stage_control_bool(stage, "autoplay", false)
}

fn stage_control_bool(stage: &serde_json::Value, key: &str, default: bool) -> bool {
    stage
        .get("controlSettings")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_bool())
        .unwrap_or(default)
}

fn single_ok_target_stage_id<'a>(
    stage: &'a serde_json::Value,
    action_options_by_id: &'a HashMap<&str, Vec<&str>>,
) -> Option<&'a str> {
    let action_id = stage
        .get("okTransition")
        .and_then(|value| value.get("actionNode"))
        .and_then(|value| value.as_str())?;
    let options = action_options_by_id.get(action_id)?;
    if options.len() == 1 {
        options.first().copied()
    } else {
        None
    }
}
