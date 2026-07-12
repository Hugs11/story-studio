use super::core::StoryBuilder;
use super::story::EndNavContext;

use super::super::*;
use super::transitions::*;

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack::builder) fn build_simple_story(
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
        let auto_next_active = project.options.auto_next;
        let night_mode_active = project.options.night_mode && !auto_next_active;
        let story_controls = if night_mode_active {
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
        let story_ok_transition = if project.night_mode_audio.is_some() && !auto_next_active {
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

    pub(in crate::native_pack::builder) fn build_root_entries(
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

    pub(in crate::native_pack::builder) fn build_root_entry(
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
                let auto_next_active = self.report.project.options.auto_next;
                let play_return_transition = if auto_next_active {
                    find_next_story_id(siblings, root_index)
                        .and_then(|next_id| {
                            self.story_prealloc
                                .get(next_id)
                                .map(|prealloc| transition(&prealloc.play_action_id, 0))
                        })
                        .unwrap_or_else(|| transition(root_action_id, 0))
                } else {
                    let story_return = resolve_next_story_target(
                        story.return_after_play.as_deref(),
                        siblings,
                        root_index,
                    );
                    self.resolve_story_return_transition(
                        story_return.as_deref(),
                        root_transition.clone(),
                    )
                };
                let story_home = resolve_next_story_target(
                    story.return_on_home.as_deref(),
                    siblings,
                    root_index,
                );
                let play_home_transition = if story.return_on_home_none {
                    None
                } else {
                    Some(if auto_next_active && story.return_on_home.is_none() {
                        root_transition.clone()
                    } else {
                        self.resolve_play_home_transition_for_story(
                            story,
                            story_home.as_deref(),
                            play_return_transition.clone(),
                        )
                    })
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
                    auto_next_active,
                    EndNavContext {
                        siblings,
                        story_index: root_index,
                    },
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
            CanonicalEntry::Ref(reference) => {
                // Référence racine : l'option racine pointera vers le stage natif de la cible.
                // Placeholder éphémère, réécrit par `resolve_pending_ref_options` (ou erreur).
                self.record_ref_option(root_action_id, root_index, &reference.target);
                Ok(self.next_id())
            }
        }
    }

    pub(in crate::native_pack::builder) fn preallocate_shared_entry_approaches(
        &mut self,
        entries: &[CanonicalEntry],
        approach_action_ids: &[String],
    ) {
        for (index, entry) in entries.iter().enumerate() {
            let Some(action_id) = approach_action_ids.get(index) else {
                continue;
            };
            let approach_transition = transition(action_id, 0);
            match entry {
                CanonicalEntry::Story(story) if !story.id.is_empty() => {
                    if shared_story_returns_to_self(story) {
                        continue;
                    }
                    if let Some(prealloc) = self.story_prealloc.get_mut(&story.id) {
                        prealloc.approach_transition = Some(approach_transition);
                    }
                }
                CanonicalEntry::Menu(menu) if !menu.id.is_empty() => {
                    if let Some(prealloc) = self.menu_prealloc.get_mut(&menu.id) {
                        prealloc.replay_transition = approach_transition;
                    }
                }
                _ => {}
            }
        }
    }

    pub(in crate::native_pack::builder) fn build_shared_entries(
        &mut self,
        entries: &[CanonicalEntry],
        shared_action_id: &str,
        approach_action_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let mut targets = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let approach_action_id = approach_action_ids
                .get(index)
                .ok_or_else(|| "Action d'approche partagee manquante.".to_string())?;
            let approach_transition = transition(approach_action_id, 0);
            let target = self.build_shared_entry(
                entry,
                index,
                entries,
                shared_action_id,
                approach_transition.clone(),
            )?;
            self.action_nodes.push(ActionNode {
                id: approach_action_id.clone(),
                name: action_node_name(),
                options: vec![target.clone()],
                position: zero_position(),
            });
            targets.push(target);
        }
        Ok(targets)
    }

    pub(in crate::native_pack::builder) fn build_shared_entry(
        &mut self,
        entry: &CanonicalEntry,
        shared_index: usize,
        siblings: &[CanonicalEntry],
        shared_action_id: &str,
        approach_transition: Transition,
    ) -> Result<String, String> {
        match entry {
            CanonicalEntry::Story(story) => {
                let auto_next_active = self.report.project.options.auto_next;
                let play_return_transition = if auto_next_active {
                    find_next_story_id(siblings, shared_index)
                        .and_then(|next_id| {
                            self.story_prealloc
                                .get(next_id)
                                .map(|prealloc| transition(&prealloc.play_action_id, 0))
                        })
                        .unwrap_or_else(|| approach_transition.clone())
                } else {
                    let story_return = resolve_next_story_target(
                        story.return_after_play.as_deref(),
                        siblings,
                        shared_index,
                    );
                    self.resolve_story_return_transition(
                        story_return.as_deref(),
                        approach_transition.clone(),
                    )
                };
                let story_home = resolve_next_story_target(
                    story.return_on_home.as_deref(),
                    siblings,
                    shared_index,
                );
                let play_home_transition = if story.return_on_home_none {
                    None
                } else {
                    Some(self.resolve_play_home_transition_for_story(
                        story,
                        story_home.as_deref(),
                        play_return_transition.clone(),
                    ))
                };
                let (night_bridge_return, night_bridge_home) = self.compute_night_bridge_targets(
                    siblings,
                    shared_index,
                    play_return_transition.clone(),
                );
                let title_home_transition =
                    if story.title_return_on_home.is_some() || story.title_return_on_home_none {
                        self.resolve_title_home_transition(
                            story,
                            siblings,
                            shared_index,
                            approach_transition.clone(),
                        )
                    } else {
                        None
                    };
                self.build_story_branch(
                    story,
                    &scoped_label_id("shared", &story.id, &story.name),
                    title_home_transition,
                    play_home_transition,
                    play_return_transition,
                    night_bridge_return,
                    night_bridge_home,
                    true,
                    EndNavContext {
                        siblings,
                        story_index: shared_index,
                    },
                )
            }
            CanonicalEntry::Menu(menu) => self.build_menu_branch(
                menu,
                &scoped_label_id("shared", &menu.id, &menu.name),
                approach_transition,
                None,
                true,
            ),
            CanonicalEntry::Zip(_) => {
                Err("Les elements partages de type ZIP ne sont pas pris en charge.".to_string())
            }
            CanonicalEntry::Ref(reference) => {
                self.record_ref_option(shared_action_id, shared_index, &reference.target);
                self.record_ref_option(
                    &approach_transition.action_node,
                    approach_transition.option_index as usize,
                    &reference.target,
                );
                Ok(self.next_id())
            }
        }
    }
}

fn shared_story_returns_to_self(story: &CanonicalStory) -> bool {
    let Some(target) = story.return_after_play.as_deref().map(str::trim) else {
        return false;
    };
    target == format!("story:{}", story.id)
}
