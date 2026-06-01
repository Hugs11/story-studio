use super::core::StoryBuilder;

use super::super::*;
use super::transitions::*;

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack::builder) fn build_menu_branch(
        &mut self,
        menu: &CanonicalMenu,
        role_prefix: &str,
        menu_replay_transition: Transition,
        menu_home_transition: Option<Transition>,
        force_choice_node: bool,
    ) -> Result<String, String> {
        let menu_label = role_prefix.to_string();
        let menu_stage_id = self.next_id();
        // Utilise l'action ID pré-alloué si disponible (nécessaire pour returnAfterPlay cross-menu)
        let menu_action_id = self
            .menu_prealloc
            .get(&menu.id)
            .map(|p| p.action_id.clone())
            .unwrap_or_else(|| self.next_id());
        let mut option_stage_ids = Vec::new();
        let explicit_menu_home_transition = menu.return_on_home.as_deref().map(|target| {
            self.resolve_story_home_transition(Some(target), menu_replay_transition.clone())
        });
        let is_choice_node = explicit_menu_home_transition.is_some()
            || menu_home_transition.is_some()
            || force_choice_node;

        // Pre-pass: record approach_transition for each story so returnAfterPlay "story:id"
        // can navigate to the title screen (not directly to the play stage).
        for (idx, child) in menu.children.iter().enumerate() {
            if let CanonicalEntry::Story(s) = child {
                if let Some(prealloc) = self.story_prealloc.get_mut(&s.id) {
                    prealloc.approach_transition = Some(transition(&menu_action_id, idx as i32));
                }
            }
        }

        for (child_index, child) in menu.children.iter().enumerate() {
            match child {
                CanonicalEntry::Story(story) => {
                    let menu_return = resolve_next_story_target(
                        menu.return_after_play.as_deref(),
                        &menu.children,
                        child_index,
                    );
                    // Default return when neither menu nor story sets returnAfterPlay:
                    // go back to the menu stage (matching the UI's resolveReturnTarget fallback).
                    let fallback_transition = self.resolve_story_return_transition(
                        menu_return.as_deref(),
                        menu_replay_transition.clone(),
                    );
                    // auto_next: when globally active and no explicit per-story/per-menu override,
                    // the story goes directly to the next sibling's play stage instead of the menu.
                    let auto_next_active = self.report.project.options.auto_next
                        && story.return_after_play.is_none()
                        && menu.return_after_play.is_none();
                    let play_return_transition = if auto_next_active {
                        match find_next_story_id(&menu.children, child_index) {
                            Some(next_id) => self
                                .story_prealloc
                                .get(next_id)
                                .map(|p| transition(&p.play_action_id, 0))
                                .unwrap_or(fallback_transition),
                            None => fallback_transition,
                        }
                    } else {
                        let story_return = resolve_next_story_target(
                            story.return_after_play.as_deref(),
                            &menu.children,
                            child_index,
                        );
                        self.resolve_story_return_transition(
                            story_return.as_deref(),
                            fallback_transition,
                        )
                    };
                    let story_home = resolve_next_story_target(
                        story.return_on_home.as_deref(),
                        &menu.children,
                        child_index,
                    );
                    // When returnOnHome is not set but returnAfterPlay IS set,
                    // home goes to the parent menu so it differs from ok (which advances to next story).
                    // When auto_next is active and play_return_transition points to the next story,
                    // home must also stay on the menu — not inherit the next-story target.
                    let play_home_transition = if story.return_on_home_none {
                        None
                    } else {
                        Some(
                            if story.return_on_home.is_none() && story.return_after_play.is_some() {
                                self.resolve_story_home_transition(
                                    None,
                                    menu_replay_transition.clone(),
                                )
                            } else if auto_next_active && story.return_on_home.is_none() {
                                menu_replay_transition.clone()
                            } else {
                                self.resolve_story_home_transition(
                                    story_home.as_deref(),
                                    play_return_transition.clone(),
                                )
                            },
                        )
                    };
                    // Force autoplay for stories with no explicit controls in any menu context
                    // (not just nested menus) so they never hang after playback.
                    let effective_simple_leaf =
                        menu.return_after_play.is_none() && story.return_after_play.is_none();
                    let (night_bridge_return, night_bridge_home) = self
                        .compute_night_bridge_targets(
                            &menu.children,
                            child_index,
                            play_return_transition.clone(),
                        );
                    option_stage_ids.push(self.build_story_branch(
                        story,
                        &scoped_label_id(&menu_label, &story.id, &story.name),
                        self.resolve_title_home_transition(
                            story,
                            &menu.children,
                            child_index,
                            menu_replay_transition.clone(),
                        ),
                        play_home_transition,
                        play_return_transition,
                        night_bridge_return,
                        night_bridge_home,
                        effective_simple_leaf,
                    )?);
                }
                CanonicalEntry::Zip(zip) => {
                    option_stage_ids.push(self.build_imported_zip_branch(
                        zip,
                        &scoped_label_id(&menu_label, &zip.id, &zip.name),
                        transition(&menu_action_id, child_index as i32),
                        true,
                    )?);
                }
                CanonicalEntry::Menu(submenu) => {
                    option_stage_ids.push(self.build_menu_branch(
                        submenu,
                        &scoped_label_id(&menu_label, &submenu.id, &submenu.name),
                        transition(&menu_action_id, child_index as i32),
                        Some(menu_replay_transition.clone()),
                        false,
                    )?);
                }
            }
        }

        if option_stage_ids.is_empty() {
            return Err(format!(
                "Le menu {} ne contient aucune histoire exploitable pour le generateur natif v1.",
                display_label(&menu.name, "Collection")
            ));
        }

        self.action_nodes.push(ActionNode {
            id: menu_action_id.clone(),
            name: action_node_name(),
            options: option_stage_ids,
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: menu_stage_id.clone(),
            name: display_label(&menu.name, "Menu"),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: menu
                .audio
                .as_ref()
                .map(|_| self.asset_name(&format!("{}/menuAudio", menu_label)))
                .transpose()?,
            image: if menu.auto_black_image {
                None
            } else {
                Some(self.asset_name(&format!("{}/menuImage", menu_label))?)
            },
            control_settings: ControlSettings {
                wheel: if is_choice_node { menu.wheel } else { false },
                ok: menu.ok,
                home: menu.home,
                pause: menu.pause,
                autoplay: if is_choice_node { menu.autoplay } else { true },
            },
            home_transition: explicit_menu_home_transition,
            ok_transition: Some(Transition {
                action_node: menu_action_id,
                option_index: 0,
            }),
            position: zero_position(),
        });
        Ok(menu_stage_id)
    }
}
