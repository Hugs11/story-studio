use super::core::StoryBuilder;
use super::story::EndNavContext;

use super::super::*;
use super::transitions::*;

impl<'a> StoryBuilder<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::native_pack::builder) fn build_story_branch(
        &mut self,
        story: &CanonicalStory,
        role_prefix: &str,
        title_home_transition: Option<Transition>,
        play_home_transition: Option<Transition>,
        play_return_transition: Transition,
        night_bridge_return: Transition,
        night_bridge_home: Option<Transition>,
        simple_leaf_playback: bool,
        nav: EndNavContext<'_>,
    ) -> Result<String, String> {
        let mut effective_play_home_transition = play_home_transition.clone();
        let title_stage_id = self.next_id();
        let prealloc = self.story_prealloc.get(&story.id);
        let play_stage_id = prealloc
            .map(|p| p.play_stage_id.clone())
            .unwrap_or_else(|| self.next_id());
        let play_action_id = prealloc
            .map(|p| p.play_action_id.clone())
            .unwrap_or_else(|| self.next_id());
        let base_story_name = display_label(&story.name, "Story");
        let auto_next_active = self.report.project.options.auto_next;
        let has_effective_night_mode =
            self.report.project.night_mode_audio.is_some() && !auto_next_active;
        // force_autoplay garantit que le firmware déclenche okTransition automatiquement.
        // Requis avec returnAfterPlay, et aussi quand l'histoire est dans un menu imbriqué
        // sans contrôles de navigation explicites ; sinon l'audio boucle.
        let force_autoplay = auto_next_active
            || story
                .return_after_play
                .as_deref()
                .map(|r| !r.trim().is_empty())
                .unwrap_or(false)
            || has_effective_night_mode
            || (simple_leaf_playback && !story.ok && !story.autoplay);
        let play_controls = ControlSettings {
            wheel: story.wheel,
            ok: story.ok,
            home: story.home,
            pause: story.pause,
            autoplay: force_autoplay || story.autoplay,
        };
        let play_ok_transition = if auto_next_active {
            Some(play_return_transition.clone())
        } else if !story.after_playback_sequence.is_empty() {
            let sequence_transitions = self.build_after_playback_sequence(
                story,
                role_prefix,
                play_return_transition.clone(),
                play_home_transition
                    .clone()
                    .unwrap_or_else(|| play_return_transition.clone()),
                nav,
            )?;
            if let Some(home_transition) = sequence_transitions.home {
                effective_play_home_transition = Some(home_transition);
            }
            Some(sequence_transitions.ok)
        } else if story.after_playback_prompt_audio.is_some() {
            let prompt_stage_id = self.next_id();
            let prompt_action_id = self.next_id();
            let prompt_ok_transition = self.resolve_story_return_transition(
                nav.resolve(story.after_playback_prompt_ok_target.as_deref())
                    .as_deref(),
                play_return_transition.clone(),
            );
            let prompt_home_transition = if story.after_playback_prompt_home_none {
                None
            } else {
                Some(self.resolve_story_home_transition(
                    nav.resolve(story.after_playback_prompt_home_target.as_deref())
                        .as_deref(),
                    prompt_ok_transition.clone(),
                ))
            };

            self.action_nodes.push(ActionNode {
                id: prompt_action_id.clone(),
                name: action_node_name(),
                options: vec![prompt_stage_id.clone()],
                position: zero_position(),
            });

            self.stage_nodes.push(StageNode {
                uuid: prompt_stage_id,
                name: format!("Fin - {}", base_story_name),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some(self.asset_name(&format!("{}/afterPlaybackPromptAudio", role_prefix))?),
                image: None,
                control_settings: prompt_controls_from_settings(
                    story.after_playback_prompt_control_settings.as_ref(),
                ),
                home_transition: prompt_home_transition,
                ok_transition: Some(prompt_ok_transition),
                position: zero_position(),
            });

            Some(transition(&prompt_action_id, 0))
        } else if has_effective_night_mode
            && (!should_emit_combined_story_stage(story, true) || story.return_after_play.is_none())
        {
            Some(
                self.build_night_bridge_to(night_bridge_return.clone(), night_bridge_home.clone())?,
            )
        } else if play_controls.ok || play_controls.autoplay {
            Some(play_return_transition.clone())
        } else {
            None
        };

        if should_emit_combined_story_stage(story, has_effective_night_mode) {
            self.action_nodes.push(ActionNode {
                id: play_action_id,
                name: action_node_name(),
                options: vec![play_stage_id.clone()],
                position: zero_position(),
            });

            self.stage_nodes.push(StageNode {
                uuid: play_stage_id.clone(),
                name: base_story_name,
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some(self.asset_name(&format!("{}/storyAudio", role_prefix))?),
                image: story
                    .item_image
                    .as_ref()
                    .map(|_| self.asset_name(&format!("{}/itemImage", role_prefix)))
                    .transpose()?,
                control_settings: play_controls,
                home_transition: effective_play_home_transition,
                ok_transition: play_ok_transition,
                position: zero_position(),
            });

            return Ok(play_stage_id);
        }

        self.action_nodes.push(ActionNode {
            id: play_action_id.clone(),
            name: action_node_name(),
            options: vec![play_stage_id.clone()],
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: title_stage_id.clone(),
            name: format!("Titre - {}", base_story_name),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: story
                .item_audio
                .as_ref()
                .map(|_| self.asset_name(&format!("{}/itemAudio", role_prefix)))
                .transpose()?,
            image: story
                .item_image
                .as_ref()
                .map(|_| self.asset_name(&format!("{}/itemImage", role_prefix)))
                .transpose()?,
            control_settings: title_controls_from_settings(story.title_control_settings.as_ref()),
            home_transition: title_home_transition,
            ok_transition: Some(Transition {
                action_node: play_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: play_stage_id,
            name: format!("Histoire - {}", base_story_name),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: Some(self.asset_name(&format!("{}/storyAudio", role_prefix))?),
            image: None,
            control_settings: play_controls,
            home_transition: effective_play_home_transition,
            ok_transition: play_ok_transition,
            position: zero_position(),
        });

        Ok(title_stage_id)
    }
}
