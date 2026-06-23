use super::*;

// Optional external-pack fidelity harness. It is driven only by LUNII_FIDELITY_* env vars.
// ── Fidelity tests (structure navigation) ─────────────────────────────────

fn rewrite_fidelity_nav(target: Option<String>, promoted_id: &str) -> Option<String> {
    let t = target?;
    if t.is_empty() {
        return None;
    }
    if t == format!("menu:{}", promoted_id) {
        Some("root".to_string())
    } else {
        Some(t)
    }
}

fn rewrite_fidelity_entry(entry: &mut ProjectEntry, promoted_id: &str) {
    entry.return_after_play = rewrite_fidelity_nav(entry.return_after_play.take(), promoted_id);
    entry.return_on_home = rewrite_fidelity_nav(entry.return_on_home.take(), promoted_id);
    entry.title_return_on_home =
        rewrite_fidelity_nav(entry.title_return_on_home.take(), promoted_id);
    entry.after_playback_prompt_ok_target =
        rewrite_fidelity_nav(entry.after_playback_prompt_ok_target.take(), promoted_id);
    entry.after_playback_prompt_home_target =
        rewrite_fidelity_nav(entry.after_playback_prompt_home_target.take(), promoted_id);
    for step in &mut entry.after_playback_sequence {
        step.ok_target = rewrite_fidelity_nav(step.ok_target.take(), promoted_id);
        step.home_target = rewrite_fidelity_nav(step.home_target.take(), promoted_id);
    }
    for child in &mut entry.children {
        rewrite_fidelity_entry(child, promoted_id);
    }
}

fn fidelity_project(extracted: &serde_json::Value, title: &str) -> Project {
    let root_audio = extracted["rootAudio"].as_str().map(str::to_string);
    let root_image = extracted["rootImage"].as_str().map(str::to_string);
    let night_mode = extracted["nightMode"].as_bool().unwrap_or(false);
    let night_mode_audio = extracted["nightModeAudio"].as_str().map(str::to_string);
    let night_mode_return = extracted["nightModeReturn"].as_str().map(str::to_string);
    let night_mode_home_return = extracted["nightModeHomeReturn"]
        .as_str()
        .map(str::to_string);
    let wrapper_id = extracted["rootId"].as_str().unwrap_or("").to_string();

    let mut entries: Vec<ProjectEntry> =
        serde_json::from_value(extracted["entries"].clone()).expect("parse extracted entries");
    for entry in &mut entries {
        rewrite_fidelity_entry(entry, &wrapper_id);
    }

    Project {
        name: title.to_string(),
        project_type: Some("pack".to_string()),
        root_audio: root_audio.clone(),
        root_image: root_image.clone(),
        thumbnail_image: root_image,
        night_mode_audio: if night_mode { night_mode_audio } else { None },
        night_mode_return: if night_mode { night_mode_return } else { None },
        night_mode_home_return: if night_mode {
            night_mode_home_return
        } else {
            None
        },
        native_graph: extracted
            .get("nativeGraph")
            .filter(|value| !value.is_null())
            .cloned(),
        root_entries: entries,
        global_options: GlobalOptions {
            add_silence: false,
            silence_mode: None,
            harmonize_loudness: true,
            add_silence_duration_sec: 1.0,
            auto_next: false,
            night_mode,
        },
        pack_version: 1,
        pack_description: String::new(),
    }
}

fn fidelity_fake_assets(canonical: &CanonicalProject) -> Vec<PreparedAsset> {
    collect_asset_requests(canonical, 1.0)
        .into_iter()
        .enumerate()
        .map(|(i, req)| {
            let ext = match req.source_kind {
                AssetSourceKind::Image => "bmp",
                _ => "mp3",
            };
            prepared_asset(&req.role, &format!("f{}.{}", i, ext))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct FidelityStageTargetShape {
    square_one: bool,
    has_audio: bool,
    has_image: bool,
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct FidelityStageShape {
    square_one: bool,
    has_audio: bool,
    has_image: bool,
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
    has_ok_transition: bool,
    has_home_transition: bool,
    ok_target: Option<FidelityStageTargetShape>,
    home_target: Option<FidelityStageTargetShape>,
}

fn fidelity_target_shape(stage: &StageNode) -> FidelityStageTargetShape {
    FidelityStageTargetShape {
        square_one: stage.square_one,
        has_audio: stage.audio.is_some(),
        has_image: stage.image.is_some(),
        wheel: stage.control_settings.wheel,
        ok: stage.control_settings.ok,
        home: stage.control_settings.home,
        pause: stage.control_settings.pause,
        autoplay: stage.control_settings.autoplay,
    }
}

fn fidelity_transition_target<'a>(
    transition: Option<&Transition>,
    actions: &HashMap<&'a str, &'a ActionNode>,
    stages: &HashMap<&'a str, &'a StageNode>,
) -> Option<&'a StageNode> {
    let transition = transition?;
    if transition.option_index < 0 {
        return None;
    }
    let action = actions.get(transition.action_node.as_str())?;
    let stage_id = action.options.get(transition.option_index as usize)?;
    stages.get(stage_id.as_str()).copied()
}

fn fidelity_stage_shapes(
    document: &StoryDocument,
) -> std::collections::BTreeMap<FidelityStageShape, usize> {
    fidelity_stage_shape_names(document)
        .into_iter()
        .map(|(shape, names)| (shape, names.len()))
        .collect()
}

fn fidelity_stage_shape_names(
    document: &StoryDocument,
) -> std::collections::BTreeMap<FidelityStageShape, Vec<String>> {
    let actions: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let stages: HashMap<&str, &StageNode> = document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.as_str(), stage))
        .collect();
    let mut shapes = std::collections::BTreeMap::new();
    for stage in &document.stage_nodes {
        let ok_target = fidelity_transition_target(stage.ok_transition.as_ref(), &actions, &stages)
            .map(fidelity_target_shape);
        let home_target =
            fidelity_transition_target(stage.home_transition.as_ref(), &actions, &stages)
                .map(fidelity_target_shape);
        let shape = FidelityStageShape {
            square_one: stage.square_one,
            has_audio: stage.audio.is_some(),
            has_image: stage.image.is_some(),
            wheel: stage.control_settings.wheel,
            ok: stage.control_settings.ok,
            home: stage.control_settings.home,
            pause: stage.control_settings.pause,
            autoplay: stage.control_settings.autoplay,
            has_ok_transition: stage.ok_transition.is_some(),
            has_home_transition: stage.home_transition.is_some(),
            ok_target,
            home_target,
        };
        shapes.entry(shape).or_insert_with(Vec::new).push(format!(
            "{} | ok={} | home={}",
            stage.name,
            fidelity_transition_target(stage.ok_transition.as_ref(), &actions, &stages)
                .map(|target| target.name.as_str())
                .unwrap_or("-"),
            fidelity_transition_target(stage.home_transition.as_ref(), &actions, &stages)
                .map(|target| target.name.as_str())
                .unwrap_or("-")
        ));
    }
    shapes
}

fn assert_fidelity_stage_shapes(
    original: &StoryDocument,
    generated: &StoryDocument,
    pack_id: &str,
) {
    let orig_shapes = fidelity_stage_shapes(original);
    let gen_shapes = fidelity_stage_shapes(generated);
    if gen_shapes != orig_shapes {
        eprintln!(
            "[{pack_id}] strict diff:\n{}",
            fidelity_stage_shape_diff(original, generated)
        );
    }
    assert_eq!(
        gen_shapes, orig_shapes,
        "[{pack_id}] formes de stages/navigation differentes",
    );
}

fn fidelity_stage_shape_diff(original: &StoryDocument, generated: &StoryDocument) -> String {
    let orig_names = fidelity_stage_shape_names(original);
    let gen_names = fidelity_stage_shape_names(generated);
    let mut keys: std::collections::BTreeSet<FidelityStageShape> =
        orig_names.keys().cloned().collect();
    keys.extend(gen_names.keys().cloned());
    let mut lines = Vec::new();
    for key in keys {
        let orig = orig_names.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        let gen = gen_names.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        if orig.len() == gen.len() {
            continue;
        }
        lines.push(format!(
            "generated={} original={} shape={:?}",
            gen.len(),
            orig.len(),
            key
        ));
        lines.push(format!(
            "  generated examples: {}",
            gen.iter().take(5).cloned().collect::<Vec<_>>().join(" | ")
        ));
        lines.push(format!(
            "  original examples: {}",
            orig.iter().take(5).cloned().collect::<Vec<_>>().join(" | ")
        ));
    }
    lines.join("\n")
}

#[derive(Default)]
struct FidelityProjectCounts {
    menus: usize,
    imported_continuation_menus: usize,
    stories: usize,
    story_wheel: usize,
    story_autoplay: usize,
    story_wheel_autoplay: usize,
    stories_with_sequence: usize,
    sequence_steps: usize,
    stories_with_prompt: usize,
}

fn collect_fidelity_project_counts(entries: &[ProjectEntry], counts: &mut FidelityProjectCounts) {
    for entry in entries {
        match entry.entry_type.as_str() {
            "menu" => {
                counts.menus += 1;
                if entry.id.contains("-sequence-choice-") {
                    counts.imported_continuation_menus += 1;
                }
                collect_fidelity_project_counts(&entry.children, counts);
            }
            "story" => {
                counts.stories += 1;
                let controls = entry.control_settings.as_ref();
                let wheel = controls.and_then(|c| c.wheel).unwrap_or(false);
                let autoplay = controls.and_then(|c| c.autoplay).unwrap_or(false);
                if wheel {
                    counts.story_wheel += 1;
                }
                if autoplay {
                    counts.story_autoplay += 1;
                }
                if wheel && autoplay {
                    counts.story_wheel_autoplay += 1;
                }
                if !entry.after_playback_sequence.is_empty() {
                    counts.stories_with_sequence += 1;
                    counts.sequence_steps += entry.after_playback_sequence.len();
                }
                if entry.after_playback_prompt_audio.is_some() {
                    counts.stories_with_prompt += 1;
                }
            }
            _ => collect_fidelity_project_counts(&entry.children, counts),
        }
    }
}

fn fidelity_stage_count_summary(document: &StoryDocument) -> (usize, usize, usize, usize) {
    let total = document.stage_nodes.len();
    let wheel = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.control_settings.wheel)
        .count();
    let autoplay = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.control_settings.autoplay)
        .count();
    let wheel_autoplay = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.control_settings.wheel && stage.control_settings.autoplay)
        .count();
    (total, wheel, autoplay, wheel_autoplay)
}

fn report_fidelity_diagnostics(
    pack_id: &str,
    orig: &StoryDocument,
    gen: &StoryDocument,
    project: &Project,
) {
    let mut project_counts = FidelityProjectCounts::default();
    collect_fidelity_project_counts(&project.root_entries, &mut project_counts);
    let (orig_total, orig_wheel, orig_auto, orig_wheel_auto) = fidelity_stage_count_summary(orig);
    let (gen_total, gen_wheel, gen_auto, gen_wheel_auto) = fidelity_stage_count_summary(gen);
    eprintln!(
        "[{pack_id}] stages original={orig_total} generated={gen_total} delta={}",
        gen_total as isize - orig_total as isize
    );
    eprintln!(
            "[{pack_id}] wheel original={orig_wheel} generated={gen_wheel}; autoplay original={orig_auto} generated={gen_auto}; wheel+autoplay original={orig_wheel_auto} generated={gen_wheel_auto}"
        );
    eprintln!(
            "[{pack_id}] project menus={} continuation_menus={} stories={} story_wheel={} story_autoplay={} story_wheel+autoplay={} stories_with_sequence={} sequence_steps={} stories_with_prompt={}",
            project_counts.menus,
            project_counts.imported_continuation_menus,
            project_counts.stories,
            project_counts.story_wheel,
            project_counts.story_autoplay,
            project_counts.story_wheel_autoplay,
            project_counts.stories_with_sequence,
            project_counts.sequence_steps,
            project_counts.stories_with_prompt
        );
    let shape_diff = fidelity_stage_shape_diff(orig, gen);
    if !shape_diff.is_empty() {
        eprintln!("[{pack_id}] strict diff:\n{shape_diff}");
    }
}

fn assert_fidelity(zip_path: Option<String>, pack_id: &str) {
    let Some(zip_path) = zip_path else {
        return;
    };

    let tmp = std::env::temp_dir().join(format!("fidelity_{}_{}", pack_id, now_millis()));
    std::fs::create_dir_all(&tmp).expect("create tmp dir");

    let orig_str = crate::services::pack_reader::load_pack_zip(&zip_path)
        .unwrap_or_else(|e| panic!("[{pack_id}] load_pack_zip: {e}"));
    let orig: StoryDocument = serde_json::from_str(&orig_str)
        .unwrap_or_else(|e| panic!("[{pack_id}] parse orig story.json: {e}"));

    let extracted =
        crate::services::pack_reader::unpack_zip_to_entries(&zip_path, tmp.to_str().unwrap())
            .unwrap_or_else(|e| panic!("[{pack_id}] unpack_zip_to_entries: {e}"));

    let pack_title = if orig.title.trim().is_empty() {
        "Pack importé".to_string()
    } else {
        orig.title.clone()
    };
    let project = fidelity_project(&extracted, &pack_title);
    if std::env::var_os("LUNII_FIDELITY_DUMP_PROJECT").is_some() {
        eprintln!(
            "[{pack_id}] extracted project:\n{}",
            serde_json::to_string_pretty(&extracted).unwrap_or_default()
        );
    }
    let canonical = canonicalize_project(&project);
    let assets = fidelity_fake_assets(&canonical);
    let report = report_for(canonical, assets, vec![]);

    let gen = build_story_document(&report)
        .unwrap_or_else(|e| panic!("[{pack_id}] build_story_document: {e}"));
    if let Some(dump_dir) = std::env::var_os("LUNII_FIDELITY_DUMP_DOCS") {
        let dump_dir = std::path::PathBuf::from(dump_dir);
        std::fs::create_dir_all(&dump_dir).expect("create fidelity dump dir");
        std::fs::write(
            dump_dir.join(format!("{pack_id}.original.story.json")),
            serde_json::to_string_pretty(&orig).unwrap_or_default(),
        )
        .expect("write original story dump");
        std::fs::write(
            dump_dir.join(format!("{pack_id}.generated.story.json")),
            serde_json::to_string_pretty(&gen).unwrap_or_default(),
        )
        .expect("write generated story dump");
        std::fs::write(
            dump_dir.join(format!("{pack_id}.project.json")),
            serde_json::to_string_pretty(&extracted).unwrap_or_default(),
        )
        .expect("write project dump");
    }

    let orig_stages = orig.stage_nodes.len();
    let gen_stages = gen.stage_nodes.len();
    let orig_wheel = orig
        .stage_nodes
        .iter()
        .filter(|s| s.control_settings.wheel)
        .count();
    let gen_wheel = gen
        .stage_nodes
        .iter()
        .filter(|s| s.control_settings.wheel)
        .count();
    let orig_auto = orig
        .stage_nodes
        .iter()
        .filter(|s| s.control_settings.autoplay)
        .count();
    let gen_auto = gen
        .stage_nodes
        .iter()
        .filter(|s| s.control_settings.autoplay)
        .count();

    if std::env::var_os("LUNII_FIDELITY_REPORT").is_some() {
        report_fidelity_diagnostics(pack_id, &orig, &gen, &project);
    }

    assert!(
        gen.stage_nodes.iter().any(|s| s.square_one),
        "[{pack_id}] squareOne stage manquant",
    );
    assert_eq!(
        gen_stages, orig_stages,
        "[{pack_id}] stages : généré={gen_stages} original={orig_stages}",
    );
    assert_eq!(
        gen_wheel, orig_wheel,
        "[{pack_id}] wheel stages : généré={gen_wheel} original={orig_wheel}",
    );
    assert_eq!(
        gen_auto, orig_auto,
        "[{pack_id}] autoplay stages : généré={gen_auto} original={orig_auto}",
    );
    assert_eq!(
        gen.night_mode_available, orig.night_mode_available,
        "[{pack_id}] nightModeAvailable : généré={} original={}",
        gen.night_mode_available, orig.night_mode_available,
    );
    validate_document_for_studio_compat(&gen)
        .unwrap_or_else(|e| panic!("[{pack_id}] validation STUdio : {e}"));
    if std::env::var_os("LUNII_FIDELITY_STRICT").is_some() {
        assert_fidelity_stage_shapes(&orig, &gen, pack_id);
    } else if fidelity_stage_shapes(&orig) != fidelity_stage_shapes(&gen) {
        eprintln!(
                "[{pack_id}] strict navigation probe differs; set LUNII_FIDELITY_STRICT=1 to fail on it"
            );
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Structural-only fidelity: verifies generation succeeds and produces a
/// STUdio-compatible document. Does NOT compare stage counts against the
/// original because some packs use a model that differs structurally from
/// our editable projection (wheel+auto merged stages, shared nodes).
fn assert_fidelity_structural(zip_path: Option<String>, pack_id: &str) {
    let Some(zip_path) = zip_path else {
        return;
    };

    let tmp = std::env::temp_dir().join(format!("fidelity_{}_{}", pack_id, now_millis()));
    std::fs::create_dir_all(&tmp).expect("create tmp dir");

    let orig_str = crate::services::pack_reader::load_pack_zip(&zip_path)
        .unwrap_or_else(|e| panic!("[{pack_id}] load_pack_zip: {e}"));
    let orig: StoryDocument = serde_json::from_str(&orig_str)
        .unwrap_or_else(|e| panic!("[{pack_id}] parse orig story.json: {e}"));

    let extracted =
        crate::services::pack_reader::unpack_zip_to_entries(&zip_path, tmp.to_str().unwrap())
            .unwrap_or_else(|e| panic!("[{pack_id}] unpack_zip_to_entries: {e}"));

    let pack_title = if orig.title.trim().is_empty() {
        "Pack importé".to_string()
    } else {
        orig.title.clone()
    };
    let project = fidelity_project(&extracted, &pack_title);
    let canonical = canonicalize_project(&project);
    let assets = fidelity_fake_assets(&canonical);
    let report = report_for(canonical, assets, vec![]);

    let gen = build_story_document(&report)
        .unwrap_or_else(|e| panic!("[{pack_id}] build_story_document: {e}"));

    if std::env::var_os("LUNII_FIDELITY_REPORT").is_some() {
        report_fidelity_diagnostics(pack_id, &orig, &gen, &project);
    }

    assert!(
        gen.stage_nodes.iter().any(|s| s.square_one),
        "[{pack_id}] squareOne stage manquant",
    );
    assert_eq!(
        gen.night_mode_available, orig.night_mode_available,
        "[{pack_id}] nightModeAvailable : généré={} original={}",
        gen.night_mode_available, orig.night_mode_available,
    );
    validate_document_for_studio_compat(&gen)
        .unwrap_or_else(|e| panic!("[{pack_id}] validation STUdio : {e}"));

    let _ = std::fs::remove_dir_all(&tmp);
}

fn fidelity_pack_id(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("PACK")
        .to_string()
}

fn fidelity_pack_paths_from_env() -> Vec<(String, String)> {
    let mut packs = Vec::new();

    if let Some(path) = std::env::var_os("LUNII_FIDELITY_PACK") {
        let path = std::path::PathBuf::from(path);
        let pack_id =
            std::env::var("LUNII_FIDELITY_PACK_ID").unwrap_or_else(|_| fidelity_pack_id(&path));
        packs.push((pack_id, path.to_string_lossy().to_string()));
    }

    if let Some(dir) = std::env::var_os("LUNII_FIDELITY_PACK_DIR") {
        let dir = std::path::PathBuf::from(dir);
        if !dir.exists() {
            eprintln!("[FIDELITY] SKIP - dossier absent : {}", dir.display());
        } else {
            let mut paths: Vec<_> = std::fs::read_dir(&dir)
                .unwrap_or_else(|e| {
                    panic!("[FIDELITY] lecture dossier packs {} : {e}", dir.display())
                })
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "zip" | "7z"))
                        .unwrap_or(false)
                })
                .collect();
            paths.sort();
            packs.extend(paths.into_iter().map(|path| {
                let pack_id = fidelity_pack_id(&path);
                (pack_id, path.to_string_lossy().to_string())
            }));
        }
    }

    packs
}

#[test]
fn fidelity_external_packs_from_env() {
    let packs = fidelity_pack_paths_from_env();
    if packs.is_empty() {
        eprintln!(
                "[FIDELITY] SKIP - definir LUNII_FIDELITY_PACK ou LUNII_FIDELITY_PACK_DIR pour tester des packs externes"
            );
        return;
    }

    let structural_only = std::env::var_os("LUNII_FIDELITY_STRUCTURAL").is_some();
    for (pack_id, path) in packs {
        if structural_only {
            assert_fidelity_structural(Some(path), &pack_id);
        } else {
            assert_fidelity(Some(path), &pack_id);
        }
    }
}
