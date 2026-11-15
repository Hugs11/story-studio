//! Portable author intent. No pack, stage, action, source path or media filename is serialized.
//! Media lookup uses logical roles (rootAudio, nightModeAudio, entry/{id}/audio,
//! entry/{id}/titleAudio, entry/{id}/titleImage, entry/{id}/promptAudio,
//! entry/{id}/sequence/{step-id}/audio|image, entry/{id}/homeStep/audio|image).
//! The caller supplies media; this module never reads a pack or the filesystem.
use super::canonical::*;
use crate::domain::project::*;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};

pub(crate) const FILE_NAME: &str = "storystudio-recipe.json";
/// Unique builder convention. Increment when the same canonical input would produce
/// a different graph (controls, transitions, options, roles or stage topology).
/// A schema-only change increments recipeVersion instead. Never use the app version.
pub(crate) const GENERATION_CONVENTION_VERSION: u32 = 1;
// Numeric versions are represented by a closed newtype, validated on deserialization.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(transparent)]
pub(crate) struct RecipeVersion(u32);
impl<'de> Deserialize<'de> for RecipeVersion {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        match u32::deserialize(d)? {
            1 => Ok(Self(1)),
            _ => Err(serde::de::Error::custom("unknown recipe version")),
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(transparent)]
pub(crate) struct ConventionVersion(u32);
impl<'de> Deserialize<'de> for ConventionVersion {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        match u32::deserialize(d)? {
            GENERATION_CONVENTION_VERSION => Ok(Self(GENERATION_CONVENTION_VERSION)),
            _ => Err(serde::de::Error::custom("unknown generation convention")),
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectType {
    Pack,
    Simple,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PromptAudio {
    None,
    Own,
    Global,
}
fn required_option<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(d)
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(transparent)]
pub(crate) struct TreeColor(String);
impl<'de> Deserialize<'de> for TreeColor {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if s.len() == 7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            Ok(Self(s))
        } else {
            Err(serde::de::Error::custom("expected #rrggbb"))
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Target {
    // Empty struct variants, not unit variants: serde ignores extra keys next to the
    // tag of an internally tagged unit variant, even under deny_unknown_fields.
    Root {},
    CurrentMenu {},
    NextStory {},
    Menu { entry: u32 },
    StoryTitle { entry: u32 },
    StoryPlay { entry: u32 },
    StoryHomeStep { entry: u32 },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum Entry {
    Menu(Menu),
    Story(Story),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Recipe {
    pub(crate) recipe_version: RecipeVersion,
    pub(crate) generation_convention_version: ConventionVersion,
    pub(crate) project_type: ProjectType,
    pub(crate) root_name: String,
    pub(crate) end_name: String,
    #[serde(deserialize_with = "required_option")]
    pub(crate) tree_color: Option<TreeColor>,
    pub(crate) settings: Settings,
    pub(crate) root_roles: Roles,
    pub(crate) global_end: GlobalEnd,
    pub(crate) entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub(crate) auto_next: bool,
    pub(crate) night_mode: bool,
    pub(crate) end_message_autoplay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Roles {
    pub(crate) audio: bool,
    pub(crate) image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoryRoles {
    pub(crate) audio: bool,
    pub(crate) title_audio: bool,
    pub(crate) title_image: bool,
    pub(crate) prompt_audio: PromptAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GlobalEnd {
    pub(crate) present: bool,
    pub(crate) audio: bool,
    #[serde(deserialize_with = "required_option")]
    pub(crate) return_target: Option<Target>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) home_target: Option<Target>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Controls {
    pub(crate) wheel: bool,
    pub(crate) ok: bool,
    pub(crate) home: bool,
    pub(crate) autoplay: bool,
    pub(crate) pause: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PartialControls {
    #[serde(deserialize_with = "required_option")]
    pub(crate) wheel: Option<bool>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) ok: Option<bool>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) home: Option<bool>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) autoplay: Option<bool>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) pause: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Menu {
    pub(crate) id: u32,
    pub(crate) name: String,
    #[serde(deserialize_with = "required_option")]
    pub(crate) tree_color: Option<TreeColor>,
    pub(crate) roles: Roles,
    pub(crate) auto_black_image: bool,
    pub(crate) controls: Controls,
    #[serde(deserialize_with = "required_option")]
    pub(crate) return_after_play: Option<Target>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) return_on_home: Option<Target>,
    pub(crate) children: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Story {
    pub(crate) id: u32,
    pub(crate) name: String,
    #[serde(deserialize_with = "required_option")]
    pub(crate) tree_color: Option<TreeColor>,
    pub(crate) roles: StoryRoles,
    pub(crate) controls: Controls,
    #[serde(deserialize_with = "required_option")]
    pub(crate) title_controls: Option<PartialControls>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) return_after_play: Option<Target>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) return_on_home: Option<Target>,
    pub(crate) return_on_home_none: bool,
    #[serde(deserialize_with = "required_option")]
    pub(crate) title_return_on_home: Option<Target>,
    pub(crate) title_return_on_home_none: bool,
    #[serde(deserialize_with = "required_option")]
    pub(crate) prompt_controls: Option<PartialControls>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) prompt_ok_target: Option<Target>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) prompt_home_target: Option<Target>,
    pub(crate) prompt_home_none: bool,
    pub(crate) sequence: Vec<Step>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) home_step: Option<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Step {
    pub(crate) id: u32,
    pub(crate) name: String,
    pub(crate) roles: Roles,
    #[serde(deserialize_with = "required_option")]
    pub(crate) controls: Option<PartialControls>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) ok_target: Option<Target>,
    pub(crate) ok_choice_targets: Vec<Target>,
    #[serde(deserialize_with = "required_option")]
    pub(crate) home_target: Option<Target>,
    pub(crate) home_follows_ok: bool,
    pub(crate) home_none: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refusal(pub(crate) &'static str);
type Result<T> = std::result::Result<T, Refusal>;

mod adapt;
pub(crate) use adapt::adapt;

mod reconstruct;
pub(crate) use reconstruct::reconstruct;
mod model;
pub(crate) use model::{build_project_model, build_role_model};
