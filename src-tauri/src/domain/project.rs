use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SilenceMode {
    Off,
    Add,
    #[default]
    Normalize,
}

#[derive(Deserialize)]
pub(crate) struct GlobalOptions {
    #[serde(rename = "addSilence", default)]
    pub(crate) add_silence: bool,
    #[serde(rename = "silenceMode", default)]
    pub(crate) silence_mode: Option<SilenceMode>,
    #[serde(
        rename = "addSilenceDurationSec",
        default = "default_add_silence_duration_sec"
    )]
    pub(crate) add_silence_duration_sec: f64,
    #[serde(rename = "autoNext")]
    pub(crate) auto_next: bool,
    #[serde(rename = "nightMode")]
    pub(crate) night_mode: bool,
    // Harmonisation du volume (-14 LUFS) à la génération. Absent des anciens
    // projets → `true` (comportement historique : volume toujours harmonisé).
    #[serde(rename = "harmonizeLoudness", default = "default_true")]
    pub(crate) harmonize_loudness: bool,
}

impl GlobalOptions {
    pub(crate) fn silence_mode(&self) -> SilenceMode {
        self.silence_mode.unwrap_or(match self.add_silence {
            true => SilenceMode::Add,
            false => SilenceMode::Off,
        })
    }
}

fn default_add_silence_duration_sec() -> f64 {
    // Aligné sur la cible du vérificateur de pack (0.4 s) et sur le défaut
    // frontend PACK_AUDIO_EDGE_SILENCE_SECONDS. Repli pour les projets dont le
    // JSON ne porte pas encore le champ.
    0.4
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub(crate) struct EntryControlSettings {
    pub(crate) autoplay: Option<bool>,
    pub(crate) wheel: Option<bool>,
    pub(crate) pause: Option<bool>,
    pub(crate) ok: Option<bool>,
    pub(crate) home: Option<bool>,
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
    #[serde(rename = "nativeStageId", default)]
    pub(crate) native_stage_id: Option<String>,
    /// Cible typée d'un nœud `ref` (`menu:`/`story:`/`story_play:`/`story_home_step:`).
    #[serde(default)]
    pub(crate) target: Option<String>,
    /// Présentation d'un `ref` : `continue` (avant) | `return` (arrière).
    #[serde(rename = "refKind", default)]
    pub(crate) ref_kind: Option<String>,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    #[serde(rename = "itemAudio")]
    pub(crate) item_audio: Option<String>,
    #[serde(rename = "itemImage")]
    pub(crate) item_image: Option<String>,
    #[serde(rename = "silentTitleStage", default)]
    pub(crate) silent_title_stage: bool,
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
    #[serde(rename = "nativeGraph", default)]
    pub(crate) native_graph: Option<serde_json::Value>,
    #[serde(rename = "packVersion", default = "default_pack_version")]
    pub(crate) pack_version: i32,
    #[serde(rename = "packDescription", default)]
    pub(crate) pack_description: String,
    #[serde(rename = "packUuid", default)]
    pub(crate) pack_uuid: String,
    #[serde(rename = "rootEntries", default)]
    pub(crate) root_entries: Vec<ProjectEntry>,
    #[serde(rename = "sharedEntries", default)]
    pub(crate) shared_entries: Vec<ProjectEntry>,
    #[serde(rename = "globalOptions")]
    pub(crate) global_options: GlobalOptions,
}

fn default_pack_version() -> i32 {
    1
}
