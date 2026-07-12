use std::collections::HashMap;

use uuid::Uuid;

use super::super::{resolve_next_story_target, CanonicalEntry, Transition};
use super::{menu::MenuPrealloc, transitions::transition};

/// Contexte de navigation minimal pour résoudre `next_story` dans les cibles de fin
/// (prompt et séquence) : la fratrie de l'histoire source et sa position. Il porte la même
/// résolution `next_story` déjà appliquée aux retours de lecture (`resolve_next_story_target`),
/// afin que prompt et séquence partagent une règle unique sans brancher dans chaque champ.
#[derive(Clone, Copy)]
pub(crate) struct EndNavContext<'a> {
    pub(crate) siblings: &'a [CanonicalEntry],
    pub(crate) story_index: usize,
}

impl EndNavContext<'_> {
    /// Pré-résout `next_story` → `story:<id>` selon la fratrie ; laisse toute autre cible
    /// (y compris les cibles importées explicites) inchangée.
    pub(crate) fn resolve(&self, target: Option<&str>) -> Option<String> {
        resolve_next_story_target(target, self.siblings, self.story_index)
    }
}

pub(crate) struct StoryPrealloc {
    pub(crate) play_stage_id: String,
    pub(crate) play_action_id: String,
    pub(crate) home_step_stage_id: Option<String>,
    pub(crate) home_step_action_id: Option<String>,
    // Défini pendant la prépasse build_menu_branch ; utilisé par returnAfterPlay
    // "story:id" pour revenir sur l'écran titre, pas directement sur le stage de lecture.
    pub(crate) approach_transition: Option<Transition>,
}

pub(crate) fn preallocate_story_play_stages(
    entries: &[CanonicalEntry],
    result: &mut HashMap<String, StoryPrealloc>,
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

pub(crate) fn preallocate_story_approach_transitions(
    entries: &[CanonicalEntry],
    parent_action_id: &str,
    menu_preallocs: &HashMap<String, MenuPrealloc>,
    story_preallocs: &mut HashMap<String, StoryPrealloc>,
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
