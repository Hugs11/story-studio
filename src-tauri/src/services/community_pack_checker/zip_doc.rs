use crate::support::user_message;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::support::user_message::{codes, UserMessage};

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

pub(crate) fn read_pack_doc(zip_path: &Path) -> Result<LoadedPackDoc, UserMessage> {
    let file = fs::File::open(zip_path).map_err(|e| {
        UserMessage::new(codes::CHECKER_PACK_UNREADABLE).with_detail(
            UserMessage::new(codes::CHECKER_ZIP_OPEN_FAILED)
                .param("error", e.to_string())
                .with_detail(format!("Impossible d'ouvrir le ZIP : {e}"))
                .into_transport(),
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        UserMessage::new(codes::CHECKER_ZIP_INVALID)
            .with_detail(format!("Archive ZIP invalide : {e}"))
    })?;
    ensure_entry_count(archive.len(), zip_path).map_err(unreadable_pack_error)?;

    let mut asset_names = HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| {
            unreadable_pack_error({
                let _msg_i = (i).to_string();
                let _msg_e = (e).to_string();
                user_message::UserMessage::new(codes::CHECKER_ANALYSIS_ZIP_INDEX_FAILED)
                    .param("index", user_message::transport_param(_msg_i.clone()))
                    .param("error", user_message::transport_param(_msg_e.clone()))
                    .with_detail(format!(
                        "Lecture ZIP index {_msg_i} impossible : {_msg_e}",
                        _msg_e = user_message::transport_detail(&_msg_e),
                        _msg_i = user_message::transport_detail(&_msg_i),
                    ))
                    .into_transport()
            })
        })?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        ensure_entry_size(entry.name(), entry.size())
            .map_err(|detail| oversized_entry_error(&name, detail))?;
        if let Some(short) = name.strip_prefix("assets/") {
            if is_safe_asset_name(short) {
                asset_names.insert(short.to_string());
            }
        }
    }

    let story_json = read_zip_entry_to_string(zip_path, "story.json")
        .map_err(|e| UserMessage::new(codes::CHECKER_STORY_UNREADABLE).with_detail(e))?;
    let story: serde_json::Value = serde_json::from_str(&story_json).map_err(|e| {
        UserMessage::new(codes::CHECKER_STORY_UNREADABLE)
            .with_detail(format!("story.json invalide : {e}"))
    })?;
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
    let file = fs::File::open(zip_path).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_ZIP_OPEN_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible d'ouvrir le ZIP : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_ZIP_ARCHIVE_INVALID)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Archive ZIP invalide : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    ensure_entry_count(archive.len(), zip_path)?;
    let actual_name = archive
        .file_names()
        .find(|name| *name == entry_name)
        .or_else(|| {
            archive
                .file_names()
                .find(|name| name.replace('\\', "/") == entry_name)
        })
        .unwrap_or(entry_name)
        .to_string();
    let mut entry = archive.by_name(&actual_name).map_err(|_| {
        let _msg_entry_name = (entry_name).to_string();
        user_message::UserMessage::new(codes::CHECKER_ZIP_ENTRY_MISSING)
            .param(
                "entryName",
                user_message::transport_param(_msg_entry_name.clone()),
            )
            .with_detail(format!(
                "Entrée introuvable dans le ZIP : {_msg_entry_name}",
                _msg_entry_name = user_message::transport_detail(&_msg_entry_name)
            ))
            .into_transport()
    })?;
    ensure_entry_size(entry_name, entry.size())?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|e| {
        let _msg_entry_name = (entry_name).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_ASSET_READ_FAILED)
            .param(
                "entryName",
                user_message::transport_param(_msg_entry_name.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Lecture {_msg_entry_name} impossible : {_msg_error}",
                _msg_entry_name = user_message::transport_detail(&_msg_entry_name),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
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
    String::from_utf8(bytes).map_err(|e| {
        let _msg_entry_name = (entry_name).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_TEXT_UTF8_INVALID)
            .param(
                "entryName",
                user_message::transport_param(_msg_entry_name.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "{_msg_entry_name} n'est pas en UTF-8 : {_msg_error}",
                _msg_entry_name = user_message::transport_detail(&_msg_entry_name),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
}

fn ensure_entry_count(len: usize, zip_path: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err({
            let _msg_len = (len).to_string();
            let _msg_zip_path = (zip_path.display()).to_string();
            let _msg_archive_max_entries = (ARCHIVE_MAX_ENTRIES).to_string();
            user_message::UserMessage::new(
                codes::CHECKER_ARCHIVE_ENTRY_LIMIT,
            )
                .param("count", user_message::transport_param(_msg_len.clone()))
                .param("zipPath", user_message::transport_param(_msg_zip_path.clone()))
                .param(
                    "maxEntries",
                    user_message::transport_param(_msg_archive_max_entries.clone()),
                )
                .with_detail(format!(
                    "Archive trop volumineuse : {_msg_len} entrées dans {_msg_zip_path} (maximum {_msg_archive_max_entries}).",
                    _msg_archive_max_entries = user_message::transport_detail(&_msg_archive_max_entries),
                    _msg_len = user_message::transport_detail(&_msg_len),
                    _msg_zip_path = user_message::transport_detail(&_msg_zip_path),
                ))
                .into_transport()
        });
    }
    Ok(())
}

fn ensure_entry_size(name: &str, size: u64) -> Result<(), String> {
    if size > ARCHIVE_MAX_FILE_BYTES {
        return Err({
            let _msg_name = (name).to_string();
            let _msg_size_1024_1024 = (size / 1024 / 1024).to_string();
            let file_size_limit_mb = (ARCHIVE_MAX_FILE_BYTES / 1024 / 1024).to_string();
            user_message::UserMessage::new(
                codes::CHECKER_ARCHIVE_FILE_SIZE_LIMIT,
            )
                .param("name", user_message::transport_param(_msg_name.clone()))
                .param("sizeMb", user_message::transport_param(_msg_size_1024_1024.clone()))
                .param(
                    "maxFileMb",
                    user_message::transport_param(file_size_limit_mb.clone()),
                )
                .with_detail(format!(
                    "Fichier trop volumineux : {_msg_name} fait {_msg_size_1024_1024} Mo (maximum {file_size_limit_mb} Mo).",
                    file_size_limit_mb = user_message::transport_detail(&file_size_limit_mb),
                    _msg_name = user_message::transport_detail(&_msg_name),
                    _msg_size_1024_1024 = user_message::transport_detail(&_msg_size_1024_1024),
                ))
                .into_transport()
        });
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
    let story_ids = story_stage_ids(story);
    let end_ids = end_message_stage_ids(story, &stages, &story_ids);
    let title_labels = story_title_labels(story, &stages, &story_ids);
    for (index, stage) in stages.iter().enumerate() {
        let stage_id = stage
            .get("uuid")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let stage_name = stage
            .get("name")
            .and_then(|value| value.as_str())
            .map(|name| {
                if is_generic_stage_name(name) {
                    title_labels
                        .get(stage_id.as_str())
                        .map(String::as_str)
                        .unwrap_or(name)
                } else {
                    name
                }
            })
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let _msg_index_1 = (index + 1).to_string();
                user_message::UserMessage::new(codes::CHECKER_REPORT_ELEMENT_LABEL)
                    .param(
                        "itemNumber",
                        user_message::transport_param(_msg_index_1.clone()),
                    )
                    .with_detail(format!(
                        "Élément {_msg_index_1}",
                        _msg_index_1 = user_message::transport_detail(&_msg_index_1)
                    ))
                    .into_transport()
            });
        let item_type = classify_stage(stage, &story_ids, &end_ids);
        if let Some(audio) = stage
            .get("audio")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
        {
            audio_refs.push(StageAssetRef {
                stage_index: index,
                stage_id: stage_id.clone(),
                stage_name: stage_name.clone(),
                asset_name: audio.to_string(),
                item_type: item_type.clone().unwrap_or_else(|| "audio".to_owned()),
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
                stage_name: stage_name.clone(),
                asset_name: image.to_string(),
                item_type: item_type.clone().unwrap_or_else(|| "image".to_owned()),
            });
        }
    }
    (audio_refs, image_refs, stages.len(), action_count)
}

// Prefer import/catalogue classification, including terminal stories without autoplay.
// Unclassifiable packs fall back to non-root pausable sounds without a wheel:
// prompts, wheels and end messages are never stories.
// An empty set means unknown, never a known count of zero.
pub(crate) fn story_stage_ids(story: &serde_json::Value) -> HashSet<String> {
    let classified = serde_json::from_value::<crate::native_pack::StoryDocument>(story.clone())
        .ok()
        .and_then(|document| crate::services::pack_reader::story_audio(&document))
        .filter(|stories| !stories.is_empty());
    if let Some(stories) = classified {
        return stories.into_iter().map(|(id, _)| id).collect();
    }
    story
        .get("stageNodes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|stage| {
            !stage
                .get("squareOne")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && stage_control_bool(stage, "pause", false)
                && !stage_control_bool(stage, "wheel", false)
                && stage
                    .get("audio")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|audio| !audio.trim().is_empty())
        })
        .filter_map(|stage| stage.get("uuid")?.as_str().map(str::to_owned))
        .collect()
}

fn is_generic_stage_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "" | "stage" | "stage node" | "stage title"
    )
}

fn story_title_labels(
    story: &serde_json::Value,
    stages: &[serde_json::Value],
    story_ids: &HashSet<String>,
) -> HashMap<String, String> {
    let actions = action_options_by_id(story);
    stages
        .iter()
        .filter_map(|stage| {
            if !stage_control_bool(stage, "wheel", false) {
                return None;
            }
            let name = stage.get("name")?.as_str()?;
            let target = single_ok_target_stage_id(stage, &actions)?;
            (story_ids.contains(target) && !is_generic_stage_name(name))
                .then(|| (target.to_owned(), name.to_owned()))
        })
        .collect()
}

fn end_message_stage_ids(
    story: &serde_json::Value,
    stages: &[serde_json::Value],
    story_ids: &HashSet<String>,
) -> HashSet<String> {
    let stage_by_id: HashMap<&str, &serde_json::Value> = stages
        .iter()
        .filter_map(|stage| Some((stage.get("uuid")?.as_str()?, stage)))
        .collect();
    let actions = action_options_by_id(story);
    // A menu prompt shared by the entry path and story returns is navigation.
    let mut before_story = HashSet::new();
    let mut pending: Vec<&str> = stages
        .iter()
        .filter(|stage| {
            stage
                .get("squareOne")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|stage| stage.get("uuid")?.as_str())
        .collect();
    while let Some(id) = pending.pop() {
        if story_ids.contains(id) || !before_story.insert(id) {
            continue;
        }
        if let Some(options) = stage_by_id
            .get(id)
            .and_then(|stage| stage.get("okTransition"))
            .and_then(|transition| transition.get("actionNode"))
            .and_then(serde_json::Value::as_str)
            .and_then(|action| actions.get(action))
        {
            pending.extend(options);
        }
    }
    let mut ends = HashSet::new();
    // Follow the non-selectable sounds after a story; a menu or another story
    // ends the sequence. Return edges are navigation, never additional stories.
    for id in story_ids {
        let mut current = stage_by_id.get(id.as_str()).copied();
        let mut visited = HashSet::new();
        while let Some(target) =
            current.and_then(|stage| single_ok_target_stage_id(stage, &actions))
        {
            if !visited.insert(target)
                || story_ids.contains(target)
                || before_story.contains(target)
            {
                break;
            }
            let Some(stage) = stage_by_id.get(target).copied() else {
                break;
            };
            if stage
                .get("squareOne")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                || stage_control_bool(stage, "wheel", false)
                || !(stage_control_bool(stage, "autoplay", false)
                    || stage_control_bool(stage, "ok", false))
            {
                break;
            }
            if stage
                .get("audio")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|audio| !audio.trim().is_empty())
            {
                ends.insert(target.to_owned());
            }
            current = Some(stage);
        }
    }
    ends
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

fn classify_stage(
    stage: &serde_json::Value,
    story_ids: &HashSet<String>,
    end_ids: &HashSet<String>,
) -> Option<String> {
    let id = stage
        .get("uuid")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let code = if stage
        .get("squareOne")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        codes::CHECKER_ROLE_ROOT
    } else if story_ids.contains(id) {
        codes::CHECKER_ROLE_STORY
    } else if end_ids.contains(id) {
        codes::CHECKER_ROLE_END_MESSAGE
    } else if stage_control_bool(stage, "wheel", false) {
        codes::CHECKER_ROLE_TITLE
    } else if story_ids.is_empty() {
        return None;
    } else {
        codes::CHECKER_ROLE_NAVIGATION
    };
    Some(code.to_owned())
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

fn unreadable_pack_error(detail: String) -> UserMessage {
    UserMessage::new(codes::CHECKER_PACK_UNREADABLE).with_detail(detail)
}

fn oversized_entry_error(name: &str, detail: String) -> UserMessage {
    if name == "story.json" {
        UserMessage::new(codes::CHECKER_STORY_UNREADABLE).with_detail(detail)
    } else {
        unreadable_pack_error(detail)
    }
}

#[cfg(test)]
mod size_error_tests {
    use super::*;
    #[test]
    fn oversized_story_keeps_the_unreadable_story_cause() {
        for (name, code) in [
            ("story.json", codes::CHECKER_STORY_UNREADABLE),
            ("assets/a.mp3", codes::CHECKER_PACK_UNREADABLE),
        ] {
            let detail = ensure_entry_size(
                name,
                crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES + 1,
            )
            .unwrap_err();
            let error = oversized_entry_error(name, detail.clone());
            assert_eq!(error.code, code);
            assert_eq!(error.detail.as_deref(), Some(detail.as_str()));
        }
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;
    use std::io::Write;

    // story.json copied verbatim from 62-fin-propre-sans-global.zip (no media).
    fn pack_62() -> serde_json::Value {
        serde_json::from_str(
            r#"{
  "actionNodes": [
    {
      "id": "6539718f-32bc-4d45-8814-d890e00315e9",
      "name": "Action node",
      "options": [
        "76d836dd-825e-4727-969e-0a8ac188afb2",
        "bfdddaea-86dc-4810-809a-494bf2ebca6c",
        "4fd855da-10f5-45dc-80af-592827599667"
      ]
    },
    {
      "id": "5f732be9-71ca-40b3-8628-cda4a2d0f73a",
      "name": "Action node",
      "options": [
        "cc1f7792-68cf-4f34-8179-ed8af42b1573"
      ]
    },
    {
      "id": "3b4cb648-622f-480a-ad78-3a172107a03f",
      "name": "Action node",
      "options": [
        "5bb81eb0-3d71-4ca3-a754-265ef6c52079"
      ]
    },
    {
      "id": "5e5e0a6a-c4b5-415c-8928-4a8626fa42ae",
      "name": "Action node",
      "options": [
        "812cadf9-06b0-4217-b4c9-9b5ada73877c"
      ]
    },
    {
      "id": "e7d173cb-67ba-4ea2-9fc6-76313b24e1ab",
      "name": "Action node",
      "options": [
        "45dc789f-bcd6-4ddb-a0f4-e55c5a2c382d"
      ]
    }
  ],
  "description": "",
  "format": "v1",
  "nightModeAvailable": false,
  "stageNodes": [
    {
      "audio": "d44b53ea8311be452f97426be17f1135c3652ace.mp3",
      "controlSettings": {
        "autoplay": false,
        "home": false,
        "ok": true,
        "pause": false,
        "wheel": true
      },
      "homeTransition": null,
      "image": "4e3ccf4a639f9bbf8169eea6f12cc0f102858e8e.png",
      "name": "Cover node",
      "okTransition": {
        "actionNode": "6539718f-32bc-4d45-8814-d890e00315e9",
        "optionIndex": 0
      },
      "squareOne": true,
      "type": "stage",
      "uuid": "a0620000-0000-4000-8000-000000000062"
    },
    {
      "audio": "8b9bcf43522e402f445fdec174786404deea358d.mp3",
      "controlSettings": {
        "autoplay": false,
        "home": true,
        "ok": true,
        "pause": false,
        "wheel": true
      },
      "homeTransition": null,
      "image": "8929aa2fd9ba7c14b22c5c774a84b28f48a5556e.png",
      "name": "Titre - Chat",
      "okTransition": {
        "actionNode": "5f732be9-71ca-40b3-8628-cda4a2d0f73a",
        "optionIndex": 0
      },
      "squareOne": false,
      "type": "stage",
      "uuid": "76d836dd-825e-4727-969e-0a8ac188afb2"
    },
    {
      "audio": "de1b32664051eb540cc907ee13612ead42c663a5.mp3",
      "controlSettings": {
        "autoplay": false,
        "home": true,
        "ok": true,
        "pause": false,
        "wheel": true
      },
      "homeTransition": null,
      "image": "a092e969db1157235a3345077b24d5fa152ae83d.png",
      "name": "Titre - Chien",
      "okTransition": {
        "actionNode": "3b4cb648-622f-480a-ad78-3a172107a03f",
        "optionIndex": 0
      },
      "squareOne": false,
      "type": "stage",
      "uuid": "bfdddaea-86dc-4810-809a-494bf2ebca6c"
    },
    {
      "audio": "1d01319476b1552c3498849f0d9cb679a8beb6e0.mp3",
      "controlSettings": {
        "autoplay": false,
        "home": true,
        "ok": true,
        "pause": false,
        "wheel": true
      },
      "homeTransition": null,
      "image": "37d5f5b8f47781202962179035ca5c816606a455.png",
      "name": "Titre - Oiseau",
      "okTransition": {
        "actionNode": "5e5e0a6a-c4b5-415c-8928-4a8626fa42ae",
        "optionIndex": 0
      },
      "squareOne": false,
      "type": "stage",
      "uuid": "4fd855da-10f5-45dc-80af-592827599667"
    },
    {
      "audio": "0152d37b849d8e579f9488369a339366b528750f.mp3",
      "controlSettings": {
        "autoplay": false,
        "home": true,
        "ok": false,
        "pause": true,
        "wheel": false
      },
      "homeTransition": {
        "actionNode": "6539718f-32bc-4d45-8814-d890e00315e9",
        "optionIndex": 0
      },
      "image": null,
      "name": "Histoire - Chat",
      "okTransition": null,
      "squareOne": false,
      "type": "stage",
      "uuid": "cc1f7792-68cf-4f34-8179-ed8af42b1573"
    },
    {
      "audio": "309631928493496a1a2eae63ea6c6f1fce4905ad.mp3",
      "controlSettings": {
        "autoplay": true,
        "home": true,
        "ok": false,
        "pause": true,
        "wheel": false
      },
      "homeTransition": {
        "actionNode": "6539718f-32bc-4d45-8814-d890e00315e9",
        "optionIndex": 1
      },
      "image": null,
      "name": "Histoire - Chien",
      "okTransition": {
        "actionNode": "e7d173cb-67ba-4ea2-9fc6-76313b24e1ab",
        "optionIndex": 0
      },
      "squareOne": false,
      "type": "stage",
      "uuid": "5bb81eb0-3d71-4ca3-a754-265ef6c52079"
    },
    {
      "audio": "c0c68fef913d9ed975cd0cdd20bba318fddf3d44.mp3",
      "controlSettings": {
        "autoplay": false,
        "home": true,
        "ok": false,
        "pause": true,
        "wheel": false
      },
      "homeTransition": {
        "actionNode": "6539718f-32bc-4d45-8814-d890e00315e9",
        "optionIndex": 2
      },
      "image": null,
      "name": "Histoire - Oiseau",
      "okTransition": null,
      "squareOne": false,
      "type": "stage",
      "uuid": "812cadf9-06b0-4217-b4c9-9b5ada73877c"
    },
    {
      "audio": "1007677f2559fd508f5c2d15b95b1ee702594258.mp3",
      "controlSettings": {
        "autoplay": true,
        "home": true,
        "ok": true,
        "pause": false,
        "wheel": false
      },
      "homeTransition": {
        "actionNode": "6539718f-32bc-4d45-8814-d890e00315e9",
        "optionIndex": 1
      },
      "image": null,
      "name": "Fin - Chien",
      "okTransition": {
        "actionNode": "6539718f-32bc-4d45-8814-d890e00315e9",
        "optionIndex": 1
      },
      "squareOne": false,
      "type": "stage",
      "uuid": "45dc789f-bcd6-4ddb-a0f4-e55c5a2c382d"
    }
  ],
  "title": "Test_62_fin_propre",
  "uuid": "a0620000-0000-4000-8000-000000000062",
  "version": 1
}"#,
        )
        .unwrap()
    }

    fn check_report(story: serde_json::Value) {
        let dir = std::env::temp_dir().join(format!("checker_roles_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pack.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("story.json", options).unwrap();
        zip.write_all(serde_json::to_string(&story).unwrap().as_bytes())
            .unwrap();
        // Presence is enough: structure checks do not decode media.
        for stage in story["stageNodes"].as_array().unwrap() {
            for field in ["audio", "image"] {
                if let Some(asset) = stage[field].as_str() {
                    zip.start_file(format!("assets/{asset}"), options).unwrap();
                }
            }
        }
        zip.finish().unwrap();
        let doc = read_pack_doc(&path).unwrap();
        for name in ["Histoire - Chat", "Histoire - Chien", "Histoire - Oiseau"] {
            let item = doc
                .audio_refs
                .iter()
                .find(|item| item.stage_name == name)
                .unwrap_or_else(|| panic!("Missing own screen name: {name}"));
            assert_eq!(item.item_type, "CHECKER_ROLE_STORY", "{name}");
        }
        let end = doc
            .audio_refs
            .iter()
            .find(|item| item.stage_name == "Fin - Chien")
            .unwrap();
        assert_eq!(end.item_type, "CHECKER_ROLE_END_MESSAGE");
        for item in &doc.image_refs {
            assert_eq!(
                item.stage_name,
                story["stageNodes"][item.stage_index]["name"]
                    .as_str()
                    .unwrap()
            );
        }
        let mut report = super::super::empty_report("roles", path.to_str().unwrap());
        super::super::validate_structure(&doc, &path, &dir, &mut report);
        assert_eq!(report.structure_summary.story_count, Some(3));
        // The HTML export reads this exact serialized field.
        assert_eq!(
            serde_json::to_value(&report).unwrap()["structureSummary"]["storyCount"],
            3
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pack_62_uses_own_screen_names_and_three_stories() {
        check_report(pack_62());
    }

    fn reported_count(story: &serde_json::Value) -> serde_json::Value {
        let (audio_refs, image_refs, stage_count, action_count) = collect_asset_refs(story);
        let doc = LoadedPackDoc {
            story: story.clone(),
            asset_names: HashSet::new(),
            audio_refs,
            image_refs,
            stage_count,
            action_count,
        };
        let mut report = super::super::empty_report("roles", "pack.zip");
        super::super::validate_structure(&doc, Path::new("pack.zip"), Path::new("."), &mut report);
        serde_json::to_value(report).unwrap()["structureSummary"]["storyCount"].clone()
    }

    fn assert_catalogue_unknown(story: &serde_json::Value) {
        let document = serde_json::from_value(story.clone()).unwrap();
        assert!(crate::services::pack_reader::story_audio(&document).is_none());
    }

    #[test]
    fn unclassifiable_official_like_prompts_and_wheels_keep_unknown_count() {
        let story = serde_json::json!({
            "stageNodes": [
                {"uuid":"root", "squareOne":true, "okTransition":{"actionNode":"menu", "optionIndex":0}},
                {"uuid":"a", "audio":"a.mp3", "controlSettings":{"autoplay":true, "ok":true}, "okTransition":{"actionNode":"back", "optionIndex":0}},
                {"uuid":"b", "audio":"b.mp3", "controlSettings":{"autoplay":true, "ok":true}, "okTransition":{"actionNode":"back", "optionIndex":0}},
                {"uuid":"c", "audio":"c.mp3", "controlSettings":{"autoplay":true, "ok":true, "pause":true, "wheel":true}, "okTransition":{"actionNode":"back", "optionIndex":0}},
                {"uuid":"d", "audio":"d.mp3", "controlSettings":{"autoplay":true, "ok":true, "wheel":true}, "okTransition":{"actionNode":"back", "optionIndex":0}}
            ],
            "actionNodes":[{"id":"menu", "options":["a","b","c","d"]}, {"id":"back", "options":["root"]}]
        });
        assert_catalogue_unknown(&story);
        assert!(reported_count(&story).is_null());
        let (audio, _, _, _) = collect_asset_refs(&story);
        assert!(audio
            .iter()
            .all(|item| item.item_type != codes::CHECKER_ROLE_STORY));
    }

    #[test]
    fn broken_references_keep_three_pausable_stories_and_the_end_message() {
        let mut story = pack_62();
        story["stageNodes"][1]["okTransition"]["actionNode"] = serde_json::json!("missing-action");
        story["stageNodes"][6]["homeTransition"]["actionNode"] = serde_json::json!("missing-home");
        story["actionNodes"][3]["options"][0] = serde_json::json!("missing-story");
        assert_catalogue_unknown(&story);
        assert_eq!(reported_count(&story), 3);
        let (audio, _, _, _) = collect_asset_refs(&story);
        for name in ["Histoire - Chat", "Histoire - Chien", "Histoire - Oiseau"] {
            let item = audio.iter().find(|item| item.stage_name == name).unwrap();
            assert_eq!(item.item_type, codes::CHECKER_ROLE_STORY, "{name}");
        }
        let end = audio
            .iter()
            .find(|item| item.stage_name == "Fin - Chien")
            .unwrap();
        assert_eq!(end.item_type, codes::CHECKER_ROLE_END_MESSAGE);
        assert_eq!(
            audio
                .iter()
                .filter(|item| item.item_type == codes::CHECKER_ROLE_END_MESSAGE)
                .count(),
            1
        );
    }

    #[test]
    fn no_catalogue_or_pausable_stories_means_unknown_count_and_neutral_role() {
        let mut story = pack_62();
        story["stageNodes"][1]["okTransition"]["actionNode"] = serde_json::json!("missing-action");
        for stage in story["stageNodes"].as_array_mut().unwrap() {
            stage["controlSettings"]["autoplay"] = serde_json::json!(false);
            stage["controlSettings"]["pause"] = serde_json::json!(false);
        }
        assert_catalogue_unknown(&story);
        assert!(reported_count(&story).is_null());
        let (audio, _, _, _) = collect_asset_refs(&story);
        assert_eq!(audio[0].item_type, codes::CHECKER_ROLE_ROOT);
        assert_eq!(audio[1].item_type, codes::CHECKER_ROLE_TITLE);
        assert_eq!(audio[4].item_type, "audio");
    }

    #[test]
    fn menu_question_reachable_before_and_after_story_is_navigation() {
        let mut story = pack_62();
        let mut question = story["stageNodes"][7].clone();
        question["uuid"] = serde_json::json!("question");
        question["name"] = serde_json::json!("Choisis ton histoire");
        story["stageNodes"][0]["okTransition"]["actionNode"] = serde_json::json!("open-question");
        story["stageNodes"][4]["okTransition"] =
            serde_json::json!({"actionNode":"open-question", "optionIndex":0});
        story["stageNodes"][4]["controlSettings"]["autoplay"] = serde_json::json!(true);
        story["stageNodes"].as_array_mut().unwrap().push(question);
        story["actionNodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id":"open-question", "options":["question"]}));
        assert_eq!(reported_count(&story), 3);
        let (audio, _, _, _) = collect_asset_refs(&story);
        assert_eq!(
            audio
                .iter()
                .find(|item| item.stage_id == "question")
                .unwrap()
                .item_type,
            codes::CHECKER_ROLE_NAVIGATION
        );
        assert_eq!(
            audio
                .iter()
                .find(|item| item.stage_name == "Fin - Chien")
                .unwrap()
                .item_type,
            codes::CHECKER_ROLE_END_MESSAGE
        );
    }

    #[test]
    fn generic_story_name_borrows_title_but_own_name_takes_precedence() {
        let mut story = pack_62();
        story["stageNodes"][4]["name"] = serde_json::json!("Stage node");
        let (audio, _, _, _) = collect_asset_refs(&story);
        assert_eq!(audio[4].stage_name, "Titre - Chat");
        assert_eq!(audio[5].stage_name, "Histoire - Chien");
    }

    #[test]
    fn folder_menus_preserve_story_roles_and_count() {
        let mut story = pack_62();
        let mut folder = story["stageNodes"][1].clone();
        folder["uuid"] = serde_json::json!("folder");
        folder["name"] = serde_json::json!("Animaux");
        folder["audio"] = serde_json::Value::Null;
        folder["image"] = serde_json::Value::Null;
        folder["okTransition"]["actionNode"] = story["actionNodes"][0]["id"].clone();
        story["stageNodes"][0]["okTransition"]["actionNode"] = serde_json::json!("open-folder");
        story["stageNodes"].as_array_mut().unwrap().push(folder);
        story["actionNodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id":"open-folder", "options":["folder"]}));
        check_report(story);
    }

    #[test]
    fn official_like_autoplay_stories_do_not_count_intro_or_end_message() {
        let mut story = pack_62();
        for index in [4, 6] {
            story["stageNodes"][index]["controlSettings"]["autoplay"] = serde_json::json!(true);
        }
        let mut intro = story["stageNodes"][4].clone();
        intro["uuid"] = serde_json::json!("intro");
        intro["name"] = serde_json::json!("Introduction");
        intro["audio"] = serde_json::json!("intro.mp3");
        intro["controlSettings"]["autoplay"] = serde_json::json!(true);
        intro["controlSettings"]["ok"] = serde_json::json!(true);
        intro["okTransition"] = story["stageNodes"][0]["okTransition"].clone();
        story["stageNodes"][0]["okTransition"]["actionNode"] = serde_json::json!("open-intro");
        story["stageNodes"].as_array_mut().unwrap().push(intro);
        story["actionNodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id":"open-intro", "options":["intro"]}));
        check_report(story);
    }
}
