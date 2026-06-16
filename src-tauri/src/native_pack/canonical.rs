use serde::Serialize;
use std::collections::HashMap;

use crate::domain::project::{
    AfterPlaybackSequenceStep, AudioFieldProcessing, EntryControlSettings, GlobalOptions, Project,
    ProjectEntry, SilenceMode,
};
use crate::domain::validation::project_root_entries;

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
    pub(crate) silence_mode: SilenceMode,
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

pub(crate) enum NavigationTarget<'a> {
    Root,
    CurrentMenu,
    NextStory,
    Menu(&'a str),
    Story(&'a str),
    StoryPlay(&'a str),
    StoryHomeStep(&'a str),
}

pub(crate) fn decode_navigation_target(target: Option<&str>) -> Option<NavigationTarget<'_>> {
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
pub(crate) fn find_next_story_id(
    children: &[CanonicalEntry],
    current_index: usize,
) -> Option<&str> {
    children[(current_index + 1)..].iter().find_map(|e| {
        if let CanonicalEntry::Story(s) = e {
            Some(s.id.as_str())
        } else {
            None
        }
    })
}

/// Résout `next_story` en `story:<id>` si un sibling suivant existe, sinon laisse la valeur inchangée.
pub(crate) fn resolve_next_story_target(
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

fn canonicalize_options(options: &GlobalOptions) -> CanonicalOptions {
    CanonicalOptions {
        silence_mode: options.silence_mode(),
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
