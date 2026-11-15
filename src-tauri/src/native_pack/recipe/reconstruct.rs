use super::*;

/// Rebuild author intent with fresh local author IDs. Pack metadata and media come
/// from the caller, never from the recipe. Missing active media is a refusal.
/// `global` prompts share the exact supplied global audio (S1).
pub(crate) fn reconstruct(
    recipe: &Recipe,
    mut media: impl FnMut(&str) -> Option<String>,
) -> Result<Project> {
    let mut ids = HashMap::new();
    fn index(entries: &[Entry], ids: &mut HashMap<u32, (bool, bool)>) -> Result<()> {
        for e in entries {
            let (id, menu, home) = match e {
                Entry::Menu(m) => (m.id, true, false),
                Entry::Story(s) => (s.id, false, s.home_step.is_some()),
            };
            if ids.insert(id, (menu, home)).is_some() {
                return Err(Refusal("duplicate entry id"));
            }
            if let Entry::Menu(m) = e {
                index(&m.children, ids)?;
            }
        }
        Ok(())
    }
    index(&recipe.entries, &mut ids)?;
    if recipe.project_type == ProjectType::Simple
        && (recipe.entries.len() != 1 || !matches!(recipe.entries[0], Entry::Story(_)))
    {
        return Err(Refusal("simple shape"));
    }
    let global_audio = resolve(&mut media, recipe.global_end.audio, "nightModeAudio")?;
    let mut r = Reconstruction {
        ids,
        media: &mut media,
        global_audio: global_audio.clone(),
        project_type: recipe.project_type,
    };
    Ok(Project {
        root_name: recipe.root_name.clone(),
        end_node_name: recipe.end_name.clone(),
        tree_color: recipe.tree_color.as_ref().map(|c| c.0.clone()),
        name: String::new(),
        project_type: Some(
            match recipe.project_type {
                ProjectType::Pack => "pack",
                ProjectType::Simple => "simple",
            }
            .into(),
        ),
        root_audio: resolve(r.media, recipe.root_roles.audio, "rootAudio")?,
        root_image: resolve(r.media, recipe.root_roles.image, "rootImage")?,
        thumbnail_image: None,
        night_mode_audio: global_audio,
        night_mode_return: r.target(&recipe.global_end.return_target)?,
        night_mode_home_return: r.target(&recipe.global_end.home_target)?,
        native_graph: None,
        pack_version: 1,
        pack_description: String::new(),
        pack_uuid: String::new(),
        official_provenance: Default::default(),
        official_origin_uuid: None,
        contains_official_content: false,
        root_entries: recipe
            .entries
            .iter()
            .map(|e| r.entry(e))
            .collect::<Result<_>>()?,
        shared_entries: vec![],
        global_options: GlobalOptions {
            end_node: recipe.global_end.present,
            add_silence: false,
            silence_mode: Some(SilenceMode::Off),
            add_silence_duration_sec: AudioEdgeSilenceDuration::uniform(0.0),
            auto_next: recipe.settings.auto_next,
            night_mode: recipe.settings.night_mode,
            end_message_autoplay: recipe.settings.end_message_autoplay,
            harmonize_loudness: false,
        },
    })
}
fn resolve(
    media: &mut dyn FnMut(&str) -> Option<String>,
    present: bool,
    role: &str,
) -> Result<Option<String>> {
    if present {
        Ok(Some(
            media(role)
                .filter(|s| !s.trim().is_empty())
                .ok_or(Refusal("missing role media"))?,
        ))
    } else {
        Ok(None)
    }
}
struct Reconstruction<'a> {
    ids: HashMap<u32, (bool, bool)>,
    media: &'a mut dyn FnMut(&str) -> Option<String>,
    global_audio: Option<String>,
    project_type: ProjectType,
}
impl Reconstruction<'_> {
    fn target(&self, t: &Option<Target>) -> Result<Option<String>> {
        Ok(match t {
            None => None,
            Some(Target::Root {}) => Some("root".into()),
            Some(Target::CurrentMenu {}) => Some("current_menu".into()),
            Some(Target::NextStory {}) => Some("next_story".into()),
            Some(t) => {
                let (entry, want_menu, want_home, prefix) = match t {
                    Target::Menu { entry } => (*entry, true, false, "menu"),
                    Target::StoryTitle { entry } => (*entry, false, false, "story"),
                    Target::StoryPlay { entry } => (*entry, false, false, "story_play"),
                    Target::StoryHomeStep { entry } => (*entry, false, true, "story_home_step"),
                    _ => unreachable!(),
                };
                let (menu, home) = self.ids.get(&entry).ok_or(Refusal("orphan target"))?;
                if *menu != want_menu || (want_home && !home) {
                    return Err(Refusal("target type"));
                }
                Some(format!("{prefix}:recipe-{entry}"))
            }
        })
    }
    fn step(&mut self, s: &Step, prefix: &str) -> Result<AfterPlaybackSequenceStep> {
        Ok(AfterPlaybackSequenceStep {
            id: format!("step-{}", s.id),
            name: s.name.clone(),
            audio: resolve(self.media, s.roles.audio, &format!("{prefix}/audio"))?,
            image: resolve(self.media, s.roles.image, &format!("{prefix}/image"))?,
            control_settings: controls(&s.controls),
            ok_target: self.target(&s.ok_target)?,
            ok_choice_targets: s
                .ok_choice_targets
                .iter()
                .map(|t| {
                    self.target(&Some(t.clone()))?
                        .ok_or(Refusal("empty target"))
                })
                .collect::<Result<_>>()?,
            home_target: self.target(&s.home_target)?,
            home_follows_ok: s.home_follows_ok,
            home_none: s.home_none,
        })
    }
    fn entry(&mut self, e: &Entry) -> Result<ProjectEntry> {
        Ok(match e {
            Entry::Menu(m) => {
                let p = format!("entry/{}", m.id);
                ProjectEntry {
                    id: format!("recipe-{}", m.id),
                    entry_type: "menu".into(),
                    name: m.name.clone(),
                    tree_color: m.tree_color.as_ref().map(|c| c.0.clone()),
                    audio: resolve(self.media, m.roles.audio, &format!("{p}/audio"))?,
                    image: resolve(self.media, m.roles.image, &format!("{p}/image"))?,
                    auto_black_image: m.auto_black_image,
                    control_settings: Some(full_controls(&m.controls)),
                    return_after_play: self.target(&m.return_after_play)?,
                    return_on_home: self.target(&m.return_on_home)?,
                    children: m
                        .children
                        .iter()
                        .map(|e| self.entry(e))
                        .collect::<Result<_>>()?,
                    ..Default::default()
                }
            }
            Entry::Story(s) => {
                let p = format!("entry/{}", s.id);
                let prompt = match s.roles.prompt_audio {
                    PromptAudio::None => None,
                    PromptAudio::Own => resolve(self.media, true, &format!("{p}/promptAudio"))?,
                    PromptAudio::Global => Some(
                        self.global_audio
                            .clone()
                            .ok_or(Refusal("global prompt without global audio"))?,
                    ),
                };
                ProjectEntry {
                    id: format!("recipe-{}", s.id),
                    entry_type: "story".into(),
                    name: s.name.clone(),
                    tree_color: s.tree_color.as_ref().map(|c| c.0.clone()),
                    audio: resolve(self.media, s.roles.audio, &format!("{p}/audio"))?,
                    item_audio: resolve(
                        self.media,
                        s.roles.title_audio,
                        &format!("{p}/titleAudio"),
                    )?,
                    item_image: resolve(
                        self.media,
                        s.roles.title_image,
                        &format!("{p}/titleImage"),
                    )?,
                    // S4: a pack title without emitted title audio is explicitly silent.
                    silent_title_stage: self.project_type == ProjectType::Pack
                        && !s.roles.title_audio,
                    control_settings: Some(full_controls(&s.controls)),
                    return_after_play: self.target(&s.return_after_play)?,
                    return_on_home: self.target(&s.return_on_home)?,
                    return_on_home_none: s.return_on_home_none,
                    title_return_on_home: self.target(&s.title_return_on_home)?,
                    title_return_on_home_none: s.title_return_on_home_none,
                    title_control_settings: controls(&s.title_controls),
                    after_playback_prompt_audio: prompt,
                    after_playback_prompt_control_settings: controls(&s.prompt_controls),
                    after_playback_prompt_ok_target: self.target(&s.prompt_ok_target)?,
                    after_playback_prompt_home_target: self.target(&s.prompt_home_target)?,
                    after_playback_prompt_home_none: s.prompt_home_none,
                    after_playback_sequence: s
                        .sequence
                        .iter()
                        .map(|step| self.step(step, &format!("{p}/sequence/{}", step.id)))
                        .collect::<Result<_>>()?,
                    after_playback_home_step: s
                        .home_step
                        .as_ref()
                        .map(|step| self.step(step, &format!("{p}/homeStep")))
                        .transpose()?,
                    ..Default::default()
                }
            }
        })
    }
}
fn full_controls(c: &Controls) -> EntryControlSettings {
    EntryControlSettings {
        wheel: Some(c.wheel),
        ok: Some(c.ok),
        home: Some(c.home),
        autoplay: Some(c.autoplay),
        pause: Some(c.pause),
    }
}
fn controls(raw: &Option<PartialControls>) -> Option<EntryControlSettings> {
    raw.as_ref().map(|c| {
        let PartialControls {
            wheel,
            ok,
            home,
            autoplay,
            pause,
        } = c;
        EntryControlSettings {
            wheel: *wheel,
            ok: *ok,
            home: *home,
            autoplay: *autoplay,
            pause: *pause,
        }
    })
}
