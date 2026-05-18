use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
pub(crate) struct GlobalOptions {
    #[serde(rename = "convertFormat")]
    pub(crate) convert_format: bool,
    #[serde(rename = "addSilence")]
    pub(crate) add_silence: bool,
    #[serde(rename = "autoNext")]
    pub(crate) auto_next: bool,
    #[serde(rename = "selectNext")]
    pub(crate) select_next: bool,
    #[serde(rename = "nightMode")]
    pub(crate) night_mode: bool,
}

#[derive(Deserialize, Clone)]
pub(crate) struct StoryItem {
    #[serde(rename = "type")]
    pub(crate) item_type: String,
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    #[serde(rename = "itemAudio")]
    pub(crate) item_audio: Option<String>,
    #[serde(rename = "itemImage")]
    pub(crate) item_image: Option<String>,
    #[serde(rename = "zipPath")]
    pub(crate) zip_path: Option<String>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct Menu {
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    #[serde(rename = "autoBlackImage", default)]
    pub(crate) auto_black_image: bool,
    pub(crate) items: Vec<StoryItem>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub(crate) struct EntryControlSettings {
    pub(crate) autoplay: Option<bool>,
    pub(crate) wheel: Option<bool>,
    pub(crate) pause: Option<bool>,
    pub(crate) ok: Option<bool>,
    pub(crate) home: Option<bool>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub(crate) struct AudioFieldProcessing {
    #[serde(rename = "skipSilence", default)]
    pub(crate) skip_silence: bool,
}

#[derive(Deserialize, Clone, Default)]
pub(crate) struct AfterPlaybackSequenceStep {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    #[serde(rename = "controlSettings", default)]
    pub(crate) control_settings: Option<EntryControlSettings>,
    #[serde(rename = "okTarget", default)]
    pub(crate) ok_target: Option<String>,
    #[serde(rename = "okChoiceTargets", default)]
    pub(crate) ok_choice_targets: Vec<String>,
    #[serde(rename = "homeTarget", default)]
    pub(crate) home_target: Option<String>,
    #[serde(rename = "homeFollowsOk", default)]
    pub(crate) home_follows_ok: bool,
    #[serde(rename = "homeNone", default)]
    pub(crate) home_none: bool,
}

#[derive(Deserialize, Clone, Default)]
pub(crate) struct ProjectEntry {
    #[serde(default)]
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) entry_type: String,
    #[serde(default)]
    pub(crate) name: String,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    #[serde(rename = "itemAudio")]
    pub(crate) item_audio: Option<String>,
    #[serde(rename = "itemImage")]
    pub(crate) item_image: Option<String>,
    #[serde(rename = "zipPath")]
    pub(crate) zip_path: Option<String>,
    #[serde(rename = "autoBlackImage", default)]
    pub(crate) auto_black_image: bool,
    #[serde(rename = "controlSettings", default)]
    pub(crate) control_settings: Option<EntryControlSettings>,
    #[serde(rename = "returnAfterPlay", default)]
    pub(crate) return_after_play: Option<String>,
    #[serde(rename = "returnOnHome", default)]
    pub(crate) return_on_home: Option<String>,
    #[serde(rename = "returnOnHomeNone", default)]
    pub(crate) return_on_home_none: bool,
    #[serde(rename = "titleReturnOnHome", default)]
    pub(crate) title_return_on_home: Option<String>,
    #[serde(rename = "titleReturnOnHomeNone", default)]
    pub(crate) title_return_on_home_none: bool,
    #[serde(rename = "titleControlSettings", default)]
    pub(crate) title_control_settings: Option<EntryControlSettings>,
    #[serde(rename = "afterPlaybackPromptAudio", default)]
    pub(crate) after_playback_prompt_audio: Option<String>,
    #[serde(rename = "afterPlaybackPromptControlSettings", default)]
    pub(crate) after_playback_prompt_control_settings: Option<EntryControlSettings>,
    #[serde(rename = "afterPlaybackPromptOkTarget", default)]
    pub(crate) after_playback_prompt_ok_target: Option<String>,
    #[serde(rename = "afterPlaybackPromptHomeTarget", default)]
    pub(crate) after_playback_prompt_home_target: Option<String>,
    #[serde(rename = "afterPlaybackPromptHomeNone", default)]
    pub(crate) after_playback_prompt_home_none: bool,
    #[serde(rename = "afterPlaybackSequence", default)]
    pub(crate) after_playback_sequence: Vec<AfterPlaybackSequenceStep>,
    #[serde(rename = "afterPlaybackHomeStep", default)]
    pub(crate) after_playback_home_step: Option<AfterPlaybackSequenceStep>,
    #[serde(rename = "audioProcessing", default)]
    pub(crate) audio_processing: HashMap<String, AudioFieldProcessing>,
    #[serde(default)]
    pub(crate) children: Vec<ProjectEntry>,
}

#[derive(Deserialize)]
pub(crate) struct Project {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(rename = "projectType")]
    pub(crate) project_type: Option<String>,
    #[serde(rename = "rootAudio")]
    pub(crate) root_audio: Option<String>,
    #[serde(rename = "rootImage")]
    pub(crate) root_image: Option<String>,
    #[serde(rename = "thumbnailImage")]
    pub(crate) thumbnail_image: Option<String>,
    #[serde(rename = "nightModeAudio")]
    pub(crate) night_mode_audio: Option<String>,
    #[serde(rename = "nightModeReturn")]
    pub(crate) night_mode_return: Option<String>,
    #[serde(rename = "nightModeHomeReturn")]
    pub(crate) night_mode_home_return: Option<String>,
    #[serde(rename = "audioProcessing", default)]
    pub(crate) audio_processing: HashMap<String, AudioFieldProcessing>,
    #[serde(rename = "nativeGraph", default)]
    pub(crate) native_graph: Option<serde_json::Value>,
    #[serde(rename = "packVersion", default = "default_pack_version")]
    pub(crate) pack_version: i32,
    #[serde(rename = "packDescription", default)]
    pub(crate) pack_description: String,
    #[serde(rename = "rootEntries", default)]
    pub(crate) root_entries: Vec<ProjectEntry>,
    #[serde(rename = "rootItems", default)]
    pub(crate) root_items: Vec<StoryItem>,
    #[serde(rename = "globalOptions")]
    pub(crate) global_options: GlobalOptions,
    pub(crate) menus: Vec<Menu>,
}

fn default_pack_version() -> i32 { 1 }
