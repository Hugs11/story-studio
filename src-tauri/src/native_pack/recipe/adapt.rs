use super::*;
use crate::native_pack::assets::pipeline::collect_asset_requests;
use crate::native_pack::scoped_label_id;

/// Builds the recipe from the author project and its canonical form. Exhaustive
/// destructuring (no `..`): a field added to one of these types breaks compilation
/// until it is classified here as exported or private.
pub(crate) fn adapt(source: &Project, canonical: &CanonicalProject) -> Result<Recipe> {
    audit_source(source);
    let Project {
        root_name,
        end_node_name,
        tree_color,
        global_options,
        name: _,
        project_type: _,
        root_audio: _,
        root_image: _,
        thumbnail_image: _,
        night_mode_audio: _,
        night_mode_return: _,
        night_mode_home_return: _,
        native_graph: _,
        pack_version: _,
        pack_description: _,
        pack_uuid: _,
        official_provenance: _,
        official_origin_uuid: _,
        contains_official_content: _,
        root_entries: _,
        shared_entries: _,
    } = source;
    let GlobalOptions {
        end_node,
        add_silence: _,
        silence_mode: _,
        add_silence_duration_sec: _,
        auto_next: _,
        night_mode: _,
        end_message_autoplay: _,
        harmonize_loudness: _,
    } = global_options;
    let CanonicalProject {
        name: _,
        project_type,
        pack_version: _,
        pack_description: _,
        root_audio: _,
        root_image: _,
        thumbnail_image: _,
        night_mode_audio,
        night_mode_return,
        night_mode_home_return,
        native_graph: _,
        options,
        entries,
        shared_entries,
    } = canonical;
    let CanonicalOptions {
        silence_mode: _,
        auto_next,
        night_mode,
        end_message_autoplay,
        harmonize_loudness: _,
    } = options;
    if !shared_entries.is_empty() || !source.shared_entries.is_empty() {
        return Err(Refusal("shared entries"));
    }
    // Reject every nested pack, including ignored entries in a malformed simple DTO.
    fn contains_zip(entries: &[ProjectEntry]) -> bool {
        entries
            .iter()
            .any(|e| e.entry_type == "zip" || contains_zip(&e.children))
    }
    if contains_zip(&source.root_entries) {
        return Err(Refusal("nested pack"));
    }
    let project_type = match project_type.as_str() {
        "pack" => ProjectType::Pack,
        "simple" => ProjectType::Simple,
        _ => return Err(Refusal("project type")),
    };
    let mut adapter = Adapter {
        ids: HashMap::new(),
        roles: collect_asset_requests(canonical, 0.0, 0.0)
            .into_iter()
            .map(|r| r.role)
            .collect(),
        global_audio: night_mode_audio.as_deref(),
        global_recoverable: false,
    };
    adapter.index(entries)?;
    let converted = entries
        .iter()
        .zip(&source.root_entries)
        .map(|(e, s)| adapter.entry(e, s, "root"))
        .collect::<Result<Vec<_>>>()?;
    if converted.len() != entries.len() {
        return Err(Refusal("source tree mismatch"));
    }
    Ok(Recipe {
        recipe_version: RecipeVersion(1),
        generation_convention_version: ConventionVersion(GENERATION_CONVENTION_VERSION),
        project_type,
        root_name: root_name.clone(),
        end_name: end_node_name.clone(),
        tree_color: color(tree_color)?,
        settings: Settings {
            auto_next: *auto_next,
            night_mode: *night_mode,
            end_message_autoplay: *end_message_autoplay,
        },
        root_roles: Roles {
            audio: adapter.has("rootAudio"),
            image: adapter.has("rootImage"),
        },
        global_end: GlobalEnd {
            present: *end_node,
            audio: adapter.has("nightModeAudio") || adapter.global_recoverable,
            return_target: adapter.target(night_mode_return)?,
            home_target: adapter.target(night_mode_home_return)?,
        },
        entries: converted,
    })
}
fn color(raw: &Option<String>) -> Result<Option<TreeColor>> {
    raw.as_ref()
        .map(|s| {
            serde_json::from_value(serde_json::Value::String(s.clone()))
                .map_err(|_| Refusal("tree color"))
        })
        .transpose()
}
struct Adapter<'a> {
    ids: HashMap<&'a str, (u32, bool, bool)>,
    roles: HashSet<String>,
    global_audio: Option<&'a str>,
    global_recoverable: bool,
}
impl<'a> Adapter<'a> {
    fn has(&self, role: &str) -> bool {
        self.roles.contains(role)
    }
    fn index(&mut self, entries: &'a [CanonicalEntry]) -> Result<()> {
        for entry in entries {
            let (id, menu, home_step) = match entry {
                CanonicalEntry::Menu(m) => (m.id.as_str(), true, false),
                CanonicalEntry::Story(s) => {
                    (s.id.as_str(), false, s.after_playback_home_step.is_some())
                }
                CanonicalEntry::Zip(CanonicalZip {
                    id: _,
                    name: _,
                    zip_path: _,
                }) => return Err(Refusal("nested pack")),
            };
            let local = self.ids.len() as u32;
            if self.ids.insert(id, (local, menu, home_step)).is_some() {
                return Err(Refusal("duplicate entry id"));
            }
            if let CanonicalEntry::Menu(m) = entry {
                self.index(&m.children)?;
            }
        }
        Ok(())
    }
    fn target(&self, raw: &Option<String>) -> Result<Option<Target>> {
        Ok(match decode_navigation_target(raw.as_deref()) {
            None => None,
            Some(NavigationTarget::Root) => Some(Target::Root {}),
            Some(NavigationTarget::CurrentMenu) => Some(Target::CurrentMenu {}),
            Some(NavigationTarget::NextStory) => Some(Target::NextStory {}),
            Some(t) => {
                let (id, want_menu, want_home) = match t {
                    NavigationTarget::Menu(id) => (id, true, false),
                    NavigationTarget::Story(id) | NavigationTarget::StoryPlay(id) => {
                        (id, false, false)
                    }
                    NavigationTarget::StoryHomeStep(id) => (id, false, true),
                    _ => unreachable!(),
                };
                let (entry, menu, home) = self.ids.get(id).ok_or(Refusal("orphan target"))?;
                if *menu != want_menu || (want_home && !home) {
                    return Err(Refusal("target type"));
                }
                Some(match t {
                    NavigationTarget::Menu(_) => Target::Menu { entry: *entry },
                    NavigationTarget::Story(_) => Target::StoryTitle { entry: *entry },
                    NavigationTarget::StoryPlay(_) => Target::StoryPlay { entry: *entry },
                    NavigationTarget::StoryHomeStep(_) => Target::StoryHomeStep { entry: *entry },
                    _ => unreachable!(),
                })
            }
        })
    }
    fn step(&self, s: &CanonicalAfterPlaybackStep, id: u32, label: &str) -> Result<Step> {
        let CanonicalAfterPlaybackStep {
            id: _,
            name,
            audio: _,
            image: _,
            control_settings,
            ok_target,
            ok_choice_targets,
            home_target,
            home_follows_ok,
            home_none,
        } = s;
        Ok(Step {
            id,
            name: name.clone(),
            roles: Roles {
                audio: self.has(&format!("{label}/audio")),
                image: self.has(&format!("{label}/image")),
            },
            controls: partial(control_settings),
            ok_target: self.target(ok_target)?,
            ok_choice_targets: ok_choice_targets
                .iter()
                .map(|t| {
                    self.target(&Some(t.clone()))?
                        .ok_or(Refusal("empty choice target"))
                })
                .collect::<Result<_>>()?,
            home_target: self.target(home_target)?,
            home_follows_ok: *home_follows_ok,
            home_none: *home_none,
        })
    }
    fn entry(&mut self, e: &CanonicalEntry, s: &ProjectEntry, prefix: &str) -> Result<Entry> {
        Ok(match e {
            CanonicalEntry::Menu(m) => {
                let CanonicalMenu {
                    id,
                    name,
                    audio: _,
                    image: _,
                    auto_black_image,
                    wheel,
                    ok,
                    home,
                    autoplay,
                    pause,
                    return_after_play,
                    return_on_home,
                    children,
                } = m;
                let label = scoped_label_id(prefix, id, name);
                if children.len() != s.children.len() {
                    return Err(Refusal("source tree mismatch"));
                }
                Entry::Menu(Menu {
                    id: self.ids[id.as_str()].0,
                    name: name.clone(),
                    tree_color: color(&s.tree_color)?,
                    roles: Roles {
                        audio: self.has(&format!("{label}/menuAudio")),
                        image: self.has(&format!("{label}/menuImage")),
                    },
                    auto_black_image: *auto_black_image,
                    controls: Controls {
                        wheel: *wheel,
                        ok: *ok,
                        home: *home,
                        autoplay: *autoplay,
                        pause: *pause,
                    },
                    return_after_play: self.target(return_after_play)?,
                    return_on_home: self.target(return_on_home)?,
                    children: children
                        .iter()
                        .zip(&s.children)
                        .map(|(e, s)| self.entry(e, s, &label))
                        .collect::<Result<_>>()?,
                })
            }
            CanonicalEntry::Story(s2) => {
                let CanonicalStory {
                    id,
                    name,
                    native_stage_id: _,
                    audio: _,
                    item_audio: _,
                    item_image: _,
                    after_playback_prompt_audio,
                    after_playback_prompt_control_settings,
                    after_playback_prompt_ok_target,
                    after_playback_prompt_home_target,
                    after_playback_prompt_home_none,
                    after_playback_sequence,
                    after_playback_home_step,
                    autoplay,
                    pause,
                    wheel,
                    ok,
                    home,
                    return_after_play,
                    return_on_home,
                    return_on_home_none,
                    title_return_on_home,
                    title_return_on_home_none,
                    title_control_settings,
                } = s2;
                let label = scoped_label_id(prefix, id, name);
                let prompt_audio = if !self.has(&format!("{label}/afterPlaybackPromptAudio")) {
                    PromptAudio::None
                } else if after_playback_prompt_audio.as_deref() == self.global_audio {
                    self.global_recoverable = true;
                    PromptAudio::Global
                } else {
                    PromptAudio::Own
                };
                Entry::Story(Story {
                    id: self.ids[id.as_str()].0,
                    name: name.clone(),
                    tree_color: color(&s.tree_color)?,
                    roles: StoryRoles {
                        audio: self.has(&format!("{label}/storyAudio")),
                        title_audio: self.has(&format!("{label}/itemAudio")),
                        title_image: self.has(&format!("{label}/itemImage")),
                        prompt_audio,
                    },
                    controls: Controls {
                        wheel: *wheel,
                        ok: *ok,
                        home: *home,
                        autoplay: *autoplay,
                        pause: *pause,
                    },
                    title_controls: partial(title_control_settings),
                    return_after_play: self.target(return_after_play)?,
                    return_on_home: self.target(return_on_home)?,
                    return_on_home_none: *return_on_home_none,
                    title_return_on_home: self.target(title_return_on_home)?,
                    title_return_on_home_none: *title_return_on_home_none,
                    prompt_controls: partial(after_playback_prompt_control_settings),
                    prompt_ok_target: self.target(after_playback_prompt_ok_target)?,
                    prompt_home_target: self.target(after_playback_prompt_home_target)?,
                    prompt_home_none: *after_playback_prompt_home_none,
                    sequence: after_playback_sequence
                        .iter()
                        .enumerate()
                        .map(|(i, s)| {
                            self.step(s, i as u32, &format!("{label}/afterPlaybackSequence/{i}"))
                        })
                        .collect::<Result<_>>()?,
                    home_step: after_playback_home_step
                        .as_ref()
                        .map(|s| {
                            self.step(
                                s,
                                after_playback_sequence.len() as u32,
                                &format!("{label}/afterPlaybackHomeStep"),
                            )
                        })
                        .transpose()?,
                })
            }
            CanonicalEntry::Zip(CanonicalZip {
                id: _,
                name: _,
                zip_path: _,
            }) => return Err(Refusal("nested pack")),
        })
    }
}
fn partial(raw: &Option<EntryControlSettings>) -> Option<PartialControls> {
    raw.as_ref().map(|c| {
        let EntryControlSettings {
            wheel,
            ok,
            home,
            autoplay,
            pause,
        } = c;
        PartialControls {
            wheel: *wheel,
            ok: *ok,
            home: *home,
            autoplay: *autoplay,
            pause: *pause,
        }
    })
}

fn audit_source(project: &Project) {
    fn audit_entry(entry: &ProjectEntry) {
        let ProjectEntry {
            tree_color: _,
            id: _,
            entry_type: _,
            name: _,
            native_stage_id: _,
            audio: _,
            image: _,
            item_audio: _,
            item_image: _,
            silent_title_stage: _,
            zip_path: _,
            pack_uuid: _,
            official_provenance: _,
            official_origin_uuid: _,
            contains_official_content: _,
            auto_black_image: _,
            imported_continuation: _,
            control_settings: _,
            return_after_play: _,
            return_on_home: _,
            return_on_home_none: _,
            title_return_on_home: _,
            title_return_on_home_none: _,
            title_control_settings: _,
            after_playback_prompt_audio: _,
            after_playback_prompt_control_settings: _,
            after_playback_prompt_ok_target: _,
            after_playback_prompt_home_target: _,
            after_playback_prompt_home_none: _,
            after_playback_sequence: _,
            after_playback_home_step: _,
            children: _,
        } = entry;
        for child in &entry.children {
            audit_entry(child);
        }
        for step in &entry.after_playback_sequence {
            audit_step(step);
        }
        if let Some(step) = &entry.after_playback_home_step {
            audit_step(step);
        }
    }
    fn audit_step(step: &AfterPlaybackSequenceStep) {
        let AfterPlaybackSequenceStep {
            id: _,
            name: _,
            audio: _,
            image: _,
            control_settings: _,
            ok_target: _,
            ok_choice_targets: _,
            home_target: _,
            home_follows_ok: _,
            home_none: _,
        } = step;
    }
    for entry in project.root_entries.iter().chain(&project.shared_entries) {
        audit_entry(entry);
    }
}
