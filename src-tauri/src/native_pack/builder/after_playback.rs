use super::core::StoryBuilder;
use super::story::EndNavContext;

use super::super::*;
use super::transitions::*;

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack::builder) fn build_after_playback_sequence(
        &mut self,
        story: &CanonicalStory,
        role_prefix: &str,
        play_return_transition: Transition,
        play_home_transition: Transition,
        nav: EndNavContext<'_>,
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
        let home_sequence_transition = if let (Some(home_step), Some(first_next_action_id)) = (
            story.after_playback_home_step.as_ref().filter(|_| {
                end_home_step_is_active(
                    self.report.project.options.auto_next,
                    story.after_playback_sequence.len(),
                    story.home,
                )
            }),
            action_ids.get(1),
        ) {
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
                    nav.resolve(home_step.home_target.as_deref()).as_deref(),
                    play_home_transition.clone(),
                ))
            };
            self.action_nodes.push(ActionNode {
                id: home_action_id.clone(),
                name: action_node_name(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(vec![home_stage_id.clone()]),
                position: no_authored_position(),
            });
            self.push_entry_stage(
                &story.id,
                StageNode {
                    uuid: home_stage_id,
                    name: Presence::Value(home_step.name.clone()),
                    stage_type: default_stage_type(),
                    square_one: Presence::Value(false),
                    group_id: Presence::Absent,
                    audio: Presence::from_nullable(
                        home_step
                            .audio
                            .as_ref()
                            .map(|_| {
                                self.asset_name(&format!(
                                    "{}/afterPlaybackHomeStep/audio",
                                    role_prefix
                                ))
                            })
                            .transpose()?,
                    ),
                    image: Presence::from_nullable(
                        home_step
                            .image
                            .as_ref()
                            .map(|_| {
                                self.asset_name(&format!(
                                    "{}/afterPlaybackHomeStep/image",
                                    role_prefix
                                ))
                            })
                            .transpose()?,
                    ),
                    control_settings: Presence::Value(prompt_controls_from_settings(
                        home_step.control_settings.as_ref(),
                    )),
                    home_transition: Presence::from_nullable(home_transition),
                    ok_transition: Presence::Value(next_transition),
                    position: no_authored_position(),
                },
            );
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
                    nav.resolve(step.ok_target.as_deref()).as_deref(),
                    play_return_transition.clone(),
                )
            } else {
                Transition::fixed(action_ids[index + 1].clone(), 0)
            };
            if is_last && step.ok_choice_targets.len() > 1 {
                let mut options = Vec::new();
                for target in &step.ok_choice_targets {
                    // Résolveur unifié (sucre au-dessus de `ref`) : préalloué pour les
                    // convergences « en avant », repli sur le retour de lecture (indulgent).
                    if let Some(stage_id) =
                        self.resolve_target_stage(target, Some(play_return_transition.clone()))
                    {
                        options.push(stage_id);
                    }
                }
                if options.len() > 1 {
                    let choice_action_id = self.next_id();
                    self.action_nodes.push(ActionNode {
                        id: choice_action_id.clone(),
                        name: action_node_name(),
                        action_type: Presence::Absent,
                        group_id: Presence::Absent,
                        options: named_option_targets(options),
                        position: no_authored_position(),
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
                    nav.resolve(step.home_target.as_deref()).as_deref(),
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
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(vec![stage_id.clone()]),
                position: no_authored_position(),
            });

            self.push_entry_stage(
                &story.id,
                StageNode {
                    uuid: stage_id,
                    name: Presence::Value(stage_name),
                    stage_type: default_stage_type(),
                    square_one: Presence::Value(false),
                    group_id: Presence::Absent,
                    audio: Presence::from_nullable(
                        step.audio
                            .as_ref()
                            .map(|_| {
                                self.asset_name(&format!(
                                    "{}/afterPlaybackSequence/{}/audio",
                                    role_prefix, index
                                ))
                            })
                            .transpose()?,
                    ),
                    image: Presence::from_nullable(
                        step.image
                            .as_ref()
                            .map(|_| {
                                self.asset_name(&format!(
                                    "{}/afterPlaybackSequence/{}/image",
                                    role_prefix, index
                                ))
                            })
                            .transpose()?,
                    ),
                    control_settings: Presence::Value(prompt_controls_from_settings(
                        step.control_settings.as_ref(),
                    )),
                    home_transition: Presence::from_nullable(home_transition),
                    ok_transition: Presence::Value(next_transition),
                    position: no_authored_position(),
                },
            );
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
}
