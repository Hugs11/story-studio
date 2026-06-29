use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::after_playback::{candidate_prompt_stage_id, detect_story_return_stage_id};
use super::chaining::{chain_intro_entries_before_content, chase_single_chain};
use super::graph_import::project_story_graph_values;
use super::native_graph::{
    build_native_graph_flat_stage_map_entry, build_native_graph_projection_entries,
    has_interactive_branching_graph, native_graph_with_resolved_assets,
};
use super::navigation_targets::{
    assign_return_targets, build_story_stage_map, extract_auto_next_return_overrides,
    remove_night_mode_return_overrides,
};
use super::night_mode::detect_imported_night_mode;
use super::sequence_menus::expand_sequence_choice_menus;
use super::stage::{
    action_options, is_stage_autoplay, resolve_asset, stage_action_options, stage_control_bool,
    stage_controls, stage_uuid,
};
use super::story_entry::{
    autoplay_stage_to_story_entry, resolve_after_playback_sequence_assets,
    resolve_after_playback_step_assets,
};
use super::transitions::{has_transition_target, transition_target_stage_id};
use crate::native_pack::StoryDocument;

/// Convertit le document story.json en `{ rootAudio, rootImage, entries }`.
/// rootAudio/rootImage = assets du squareOne (cover du pack).
/// entries = entrées éditables (story/menu) issues de la navigation.
pub(super) fn walk_story_doc_to_entries(
    doc: &serde_json::Value,
    assets: &HashMap<String, PathBuf>,
) -> Result<serde_json::Value, String> {
    let pack_title = doc
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Pack importé")
        .to_string();

    let stages: HashMap<&str, &serde_json::Value> = doc
        .get("stageNodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("uuid").and_then(|u| u.as_str()).map(|id| (id, s)))
                .collect()
        })
        .unwrap_or_default();

    let actions: HashMap<&str, &serde_json::Value> = doc
        .get("actionNodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("id").and_then(|u| u.as_str()).map(|id| (id, a)))
                .collect()
        })
        .unwrap_or_default();

    let sq = doc
        .get("stageNodes")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|s| {
                s.get("squareOne")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
        })
        .ok_or_else(|| "Aucun stage squareOne dans le ZIP".to_string())?;

    let sq_id = sq.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
    let root_audio = resolve_asset(sq.get("audio").and_then(|v| v.as_str()), assets);
    let root_image = resolve_asset(sq.get("image").and_then(|v| v.as_str()), assets);

    let root_action_id = sq
        .get("okTransition")
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "squareOne sans okTransition".to_string())?;

    let root_action = actions
        .get(root_action_id)
        .ok_or_else(|| format!("Action racine introuvable : {}", root_action_id))?;

    let root_opts = action_options(root_action);
    let night_mode_available = doc
        .get("nightModeAvailable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let prompt_stage_usage: HashMap<String, usize> = stages
        .values()
        .filter(|stage| is_stage_autoplay(stage))
        .filter_map(|stage| candidate_prompt_stage_id(stage, &stages, &actions).map(str::to_string))
        .fold(HashMap::new(), |mut acc, stage_id| {
            *acc.entry(stage_id).or_insert(0) += 1;
            acc
        });

    // Stages autoplay avec audio = candidats play stages d'histoires (pour détection story→story)
    let mut story_play_stage_ids: HashSet<&str> = stages
        .values()
        .filter(|stage| {
            is_stage_autoplay(stage)
                && stage_control_bool(stage, "wheel", false)
                && stage.get("audio").and_then(|v| v.as_str()).is_some()
        })
        .filter_map(|stage| stage_uuid(stage))
        .collect();
    for stage in stages.values() {
        if is_stage_autoplay(stage) || !stage_control_bool(stage, "wheel", false) {
            continue;
        }
        let opts = stage_action_options(stage, &actions);
        if opts.len() != 1 {
            continue;
        }
        let Some(play_stage) = stages.get(opts[0]) else {
            continue;
        };
        if is_stage_autoplay(play_stage)
            && play_stage
                .get("audio")
                .and_then(|value| value.as_str())
                .is_some()
        {
            story_play_stage_ids.insert(opts[0]);
        }
    }

    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(sq_id.to_string());

    let mut effective_root_audio = root_audio.clone();
    let mut effective_root_image = root_image.clone();

    let mut entries: Vec<serde_json::Value> = match root_opts.len() {
        0 => return Err("Le pack ne contient aucune entrée".to_string()),
        1 => {
            let first_id = root_opts[0];
            visited.insert(first_id.to_string());

            // Collecter les stages autoplay à option unique en tête de pack (intros/covers
            // qui jouent automatiquement avant d'arriver au vrai contenu sélectionnable).
            let mut intro_entries: Vec<serde_json::Value> = Vec::new();
            let mut eff_first_id = first_id;
            while let Some(s) = stages.get(eff_first_id) {
                if !is_stage_autoplay(s) {
                    break;
                }
                let opts = stage_action_options(s, &actions);
                if opts.len() != 1 {
                    break;
                }
                let next = opts[0];
                if visited.contains(next) {
                    break;
                }
                let intro_audio = resolve_asset(s.get("audio").and_then(|v| v.as_str()), assets);
                let intro_name = s
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or("Intro")
                    .to_string();
                intro_entries.push(serde_json::json!({
                    "id": stage_uuid(s).unwrap_or(""),
                    "type": "story",
                    "name": intro_name,
                    "audio": intro_audio,
                    "itemAudio": serde_json::Value::Null,
                    "itemImage": serde_json::Value::Null,
                    "controlSettings": stage_controls(s),
                }));
                visited.insert(next.to_string());
                eff_first_id = next;
            }

            let chain_audio = stages
                .get(eff_first_id)
                .and_then(|s| resolve_asset(s.get("audio").and_then(|v| v.as_str()), assets))
                .or_else(|| root_audio.clone());
            let chain_image = stages
                .get(eff_first_id)
                .and_then(|s| resolve_asset(s.get("image").and_then(|v| v.as_str()), assets));

            let terminal_id = chase_single_chain(eff_first_id, &stages, &actions, &mut visited);

            let terminal = stages
                .get(terminal_id.as_str())
                .ok_or_else(|| "Stage terminal introuvable depuis squareOne".to_string())?;
            let term_opts = stage_action_options(terminal, &actions);

            let content_entries: Vec<serde_json::Value> = match term_opts.len() {
                0 => vec![serde_json::json!({
                    "id": stage_uuid(terminal).unwrap_or(""),
                    "type": "story",
                    "name": pack_title,
                    "audio": resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets)
                              .or_else(|| chain_audio.clone()),
                    "itemAudio": chain_audio.clone(),
                    "itemImage": chain_image.clone(),
                    "controlSettings": stage_controls(terminal),
                })],
                1 => {
                    // Si terminal est autoplay, c'est lui-même le stage de lecture
                    let (story_audio, story_controls) = if is_stage_autoplay(terminal) {
                        (
                            resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(terminal),
                        )
                    } else {
                        let play_id = term_opts[0];
                        let play_stage = stages.get(play_id).copied().unwrap_or(terminal);
                        (
                            resolve_asset(play_stage.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(play_stage),
                        )
                    };
                    let story_name = terminal
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(&pack_title)
                        .to_string();
                    let detection_opt = if is_stage_autoplay(terminal) {
                        let d = detect_story_return_stage_id(
                            terminal,
                            &stages,
                            &actions,
                            &prompt_stage_usage,
                            night_mode_available,
                            &story_play_stage_ids,
                        );
                        Some(d)
                    } else {
                        None
                    };
                    vec![serde_json::json!({
                        "id": stage_uuid(terminal).unwrap_or(""),
                        "type": "story",
                        "name": story_name,
                        "audio": story_audio,
                        "itemAudio": resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets),
                        "itemImage": resolve_asset(terminal.get("image").and_then(|v| v.as_str()), assets),
                        "titleControlSettings": stage_controls(terminal),
                        "titleReturnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), &actions),
                        "titleReturnOnHomeNone": !has_transition_target(terminal.get("homeTransition"), &actions),
                        "returnStageId": detection_opt.as_ref().and_then(|d| d.target_stage_id.clone()),
                        "returnStoryStageId": detection_opt.as_ref().and_then(|d| d.next_story_stage_id.clone()),
                        "returnOnHomeStageId": detection_opt.as_ref().and_then(|d| d.home_stage_id.clone()),
                        "returnOnHomeNone": detection_opt.as_ref().map(|d| d.home_stage_id.is_none()).unwrap_or(false),
                        "homeStoryStageId": detection_opt.as_ref().and_then(|d| d.home_story_stage_id.clone()),
                        "afterPlaybackPromptAudio": detection_opt.as_ref().and_then(|d| {
                            d.prompt_stage_id.as_ref().and_then(|stage_id| {
                                stages
                                    .get(stage_id.as_str())
                                    .and_then(|stage| resolve_asset(stage.get("audio").and_then(|v| v.as_str()), assets))
                            })
                        }),
                        "afterPlaybackPromptControlSettings": detection_opt.as_ref().and_then(|d| d.prompt_control_settings.clone()),
                        "afterPlaybackPromptOkStageId": detection_opt.as_ref().and_then(|d| d.prompt_ok_stage_id.clone()),
                        "afterPlaybackPromptHomeStageId": detection_opt.as_ref().and_then(|d| d.prompt_home_stage_id.clone()),
                        "afterPlaybackPromptHomeNone": detection_opt.as_ref().map(|d| d.prompt_home_transition_none).unwrap_or(false),
                        "afterPlaybackSequence": detection_opt
                            .as_ref()
                            .map(|d| resolve_after_playback_sequence_assets(&d.after_playback_sequence, assets))
                            .unwrap_or_default(),
                        "afterPlaybackHomeStep": detection_opt
                            .as_ref()
                            .and_then(|d| d.home_step.as_ref())
                            .map(|step| resolve_after_playback_step_assets(step, assets)),
                        "controlSettings": story_controls,
                    })]
                }
                _ => {
                    let term_audio =
                        resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets);
                    let term_image =
                        resolve_asset(terminal.get("image").and_then(|v| v.as_str()), assets);
                    let children = collect_children_entries(
                        terminal,
                        &stages,
                        &actions,
                        assets,
                        &mut visited,
                        &prompt_stage_usage,
                        night_mode_available,
                        &story_play_stage_ids,
                    );
                    if term_audio.is_some() || term_image.is_some() {
                        // Nœud intermédiaire avec audio/image → le préserver comme entrée menu
                        // (ex: "qui sera le héros ?" dans Suzanne et Gaston)
                        vec![serde_json::json!({
                            "id": stage_uuid(terminal).unwrap_or(""),
                            "type": "menu",
                            "name": terminal.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "audio": term_audio,
                            "image": term_image,
                            "autoBlackImage": term_image.is_none(),
                            "controlSettings": stage_controls(terminal),
                            "returnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), &actions),
                            "children": children
                        })]
                    } else {
                        // Nœud de navigation transparent → absorber l'audio et aplatir
                        if effective_root_audio.is_none() {
                            effective_root_audio = chain_audio;
                        }
                        if effective_root_image.is_none() {
                            effective_root_image = chain_image;
                        }
                        children
                    }
                }
            };

            chain_intro_entries_before_content(intro_entries, content_entries)
        }
        _ => {
            // Plusieurs options directement depuis squareOne → entrées plates
            root_opts
                .iter()
                .filter_map(|id| {
                    if visited.contains(*id) {
                        return None;
                    }
                    visited.insert((*id).to_string());
                    stages.get(id).and_then(|s| {
                        walk_entry(
                            s,
                            &stages,
                            &actions,
                            assets,
                            &mut visited,
                            &prompt_stage_usage,
                            night_mode_available,
                            &story_play_stage_ids,
                        )
                        .ok()
                    })
                })
                .collect()
        }
    };

    let stage_names: HashMap<String, String> = stages
        .values()
        .filter_map(|stage| {
            let id = stage_uuid(stage)?;
            let name = stage
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            Some((id.to_string(), name.to_string()))
        })
        .collect();
    let existing_story_stage_ids: HashSet<String> =
        build_story_stage_map(&entries).keys().cloned().collect();
    entries = expand_sequence_choice_menus(
        entries,
        &stages,
        &actions,
        assets,
        &prompt_stage_usage,
        night_mode_available,
        &story_play_stage_ids,
        &existing_story_stage_ids,
    );
    let night_mode_detection = detect_imported_night_mode(
        night_mode_available,
        sq_id,
        &entries,
        &stages,
        &actions,
        assets,
    );
    let (night_mode_audio, night_mode_return, night_mode_home_return) = night_mode_detection
        .map(|detection| {
            (
                Some(detection.audio),
                detection.return_target,
                detection.home_target,
            )
        })
        .unwrap_or((None, None, None));
    let unresolved_transitions = assign_return_targets(&mut entries, &stage_names);
    if let Some(target) = night_mode_return.as_deref() {
        remove_night_mode_return_overrides(&mut entries, target, None);
    }
    let unresolved_transitions_detected = !unresolved_transitions.is_empty();
    let has_branching_graph = has_interactive_branching_graph(&stages, &actions);
    let needs_native_graph_projection = unresolved_transitions_detected && has_branching_graph;
    let graph_import_projection = if has_branching_graph && !unresolved_transitions_detected {
        serde_json::from_value::<StoryDocument>(doc.clone())
            .ok()
            .and_then(|document| project_story_graph_values(&document, assets).ok())
            .filter(|projection| {
                projection.diagnostics.is_empty() && !projection.root_entries.is_empty()
            })
    } else {
        None
    };
    let uses_graph_import_projection = graph_import_projection.is_some();
    let mut shared_entries = Vec::new();
    let native_graph = if needs_native_graph_projection && !uses_graph_import_projection {
        Some(native_graph_with_resolved_assets(doc, assets))
    } else {
        None
    };
    if let Some(graph_projection) = graph_import_projection {
        entries = graph_projection.root_entries;
        shared_entries = graph_projection.shared_entries;
    } else if needs_native_graph_projection {
        let mut projected_entries =
            build_native_graph_projection_entries(sq, &stages, &actions, assets);
        if projected_entries.is_empty() {
            projected_entries = build_native_graph_flat_stage_map_entry(&stages, assets);
        }
        if !projected_entries.is_empty() {
            entries = projected_entries;
        }
    }
    let auto_next_detected = !uses_graph_import_projection
        && !needs_native_graph_projection
        && extract_auto_next_return_overrides(&mut entries);
    let reported_unresolved_transitions = if needs_native_graph_projection {
        Vec::new()
    } else {
        unresolved_transitions
    };
    let reported_unresolved_transitions_detected = !reported_unresolved_transitions.is_empty();

    let pack_version = doc.get("version").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
    let pack_description = doc
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let night_mode_detected = night_mode_audio.is_some();
    let effective_night_mode_detected = night_mode_detected && !auto_next_detected;

    Ok(serde_json::json!({
        "rootId": format!("import-root:{}", sq_id),
        "title": pack_title,
        "packVersion": pack_version,
        "packDescription": pack_description,
        "rootAudio": effective_root_audio,
        "rootImage": effective_root_image,
        "autoNext": auto_next_detected,
        "nightMode": effective_night_mode_detected,
        "nightModeAudio": if auto_next_detected { None } else { night_mode_audio },
        "nightModeReturn": if auto_next_detected { None } else { night_mode_return },
        "nightModeHomeReturn": if auto_next_detected { None } else { night_mode_home_return },
        "nativeGraph": native_graph,
        "advancedTransitionsDetected": reported_unresolved_transitions_detected,
        "unresolvedTransitions": reported_unresolved_transitions,
        "sharedEntries": shared_entries,
        "entries": entries
    }))
}

#[allow(clippy::too_many_arguments)]
fn collect_children_entries(
    stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    visited: &mut HashSet<String>,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> Vec<serde_json::Value> {
    stage_action_options(stage, actions)
        .iter()
        .filter_map(|id| {
            if visited.contains(*id) {
                return None;
            }
            visited.insert((*id).to_string());
            stages.get(id).and_then(|s| {
                walk_entry(
                    s,
                    stages,
                    actions,
                    assets,
                    visited,
                    prompt_stage_usage,
                    night_mode_available,
                    story_play_stage_ids,
                )
                .ok()
            })
        })
        .collect()
}

/// Classifie un stage comme entrée projet (story ou menu).
/// Utilise chase_single_chain pour traverser les chaînes de navigation imbriquées.
#[allow(clippy::too_many_arguments)]
pub(super) fn walk_entry(
    stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    visited: &mut HashSet<String>,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> Result<serde_json::Value, String> {
    let name = stage
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Histoire")
        .to_string();

    let item_audio = resolve_asset(stage.get("audio").and_then(|v| v.as_str()), assets);
    let item_image = resolve_asset(stage.get("image").and_then(|v| v.as_str()), assets);
    let opts = stage_action_options(stage, actions);

    if is_stage_autoplay(stage) {
        return Ok(autoplay_stage_to_story_entry(
            stage,
            name,
            item_audio,
            item_image,
            assets,
            actions,
            stages,
            prompt_stage_usage,
            night_mode_available,
            story_play_stage_ids,
        ));
    }

    match opts.len() {
        0 => {
            // Feuille pure : stage de lecture sans navigation
            Ok(serde_json::json!({
                "id": stage_uuid(stage).unwrap_or(""),
                "type": "story",
                "name": name,
                "audio": item_audio,
                "itemAudio": item_audio,
                "itemImage": item_image,
                "controlSettings": stage_controls(stage),
            }))
        }
        1 => {
            let next_id = opts[0];
            if visited.contains(next_id) {
                // Cycle (transition retour) → traiter comme fin d'histoire
                return Ok(serde_json::json!({
                    "id": stage_uuid(stage).unwrap_or(""),
                    "type": "story",
                    "name": name,
                    "audio": item_audio,
                    "itemAudio": item_audio,
                    "itemImage": item_image,
                    "controlSettings": stage_controls(stage),
                }));
            }
            visited.insert(next_id.to_string());
            // Suivre la chaîne single-option jusqu'à la décision (feuille ou sélection N≥2)
            let terminal_id = chase_single_chain(next_id, stages, actions, visited);
            let terminal = stages
                .get(terminal_id.as_str())
                .ok_or_else(|| format!("Stage terminal introuvable : {}", terminal_id))?;
            let term_opts = stage_action_options(terminal, actions);

            match term_opts.len() {
                0 => {
                    // Terminal est une feuille : stage courant = titre, terminal = lecture
                    let story_audio =
                        resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets);
                    Ok(serde_json::json!({
                        "id": stage_uuid(stage).unwrap_or(""),
                        "type": "story",
                        "name": name,
                        "audio": story_audio,
                        "itemAudio": item_audio,
                        "itemImage": item_image,
                        "titleControlSettings": stage_controls(stage),
                        "titleReturnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                        "titleReturnOnHomeNone": !has_transition_target(stage.get("homeTransition"), actions),
                        "controlSettings": stage_controls(terminal),
                    }))
                }
                1 => {
                    // Cas spécial : terminal autoplay avec 1 seule cible étant un nœud de navigation
                    // (wheel=true, N≥2 options) — ex: Contemporaine-sélecteur → JohnWilliams (5 films).
                    // Créer un menu au lieu d'une histoire pour conserver la structure complète.
                    if is_stage_autoplay(terminal) {
                        let single_next_id = term_opts[0];
                        let terminal_is_story_play_stage = stage_uuid(terminal)
                            .map(|id| story_play_stage_ids.contains(id))
                            .unwrap_or(false);
                        let single_next_is_wheel_nav =
                            stages.get(single_next_id).is_some_and(|s| {
                                s.get("controlSettings")
                                    .and_then(|c| c.get("wheel"))
                                    .and_then(|w| w.as_bool())
                                    .unwrap_or(false)
                                    && !s
                                        .get("controlSettings")
                                        .and_then(|c| c.get("autoplay"))
                                        .and_then(|a| a.as_bool())
                                        .unwrap_or(false)
                            });
                        if !terminal_is_story_play_stage
                            && !story_play_stage_ids.contains(single_next_id)
                            && single_next_is_wheel_nav
                        {
                            if let Some(single_next_stage) = stages.get(single_next_id) {
                                let single_next_opts =
                                    stage_action_options(single_next_stage, actions);
                                if single_next_opts.len() >= 2 {
                                    if !visited.contains(single_next_id) {
                                        visited.insert(single_next_id.to_string());
                                    }
                                    let children = collect_children_entries(
                                        single_next_stage,
                                        stages,
                                        actions,
                                        assets,
                                        visited,
                                        prompt_stage_usage,
                                        night_mode_available,
                                        story_play_stage_ids,
                                    );
                                    let term_audio = resolve_asset(
                                        terminal.get("audio").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let term_image = resolve_asset(
                                        terminal.get("image").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let single_audio = resolve_asset(
                                        single_next_stage.get("audio").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let single_image = resolve_asset(
                                        single_next_stage.get("image").and_then(|v| v.as_str()),
                                        assets,
                                    );
                                    let single_name = single_next_stage
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let inner_menu = serde_json::json!({
                                        "id": stage_uuid(single_next_stage).unwrap_or(""),
                                        "type": "menu",
                                        "name": single_name,
                                        "audio": single_audio,
                                        "image": single_image,
                                        "autoBlackImage": single_image.is_none(),
                                        "controlSettings": stage_controls(single_next_stage),
                                        "returnOnHomeStageId": transition_target_stage_id(single_next_stage.get("homeTransition"), actions),
                                        "children": children,
                                    });
                                    return if term_audio.is_some() {
                                        let mid_menu = serde_json::json!({
                                            "id": stage_uuid(terminal).unwrap_or(""),
                                            "type": "menu",
                                            "name": terminal.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                            "audio": term_audio,
                                            "image": term_image,
                                            "autoBlackImage": term_image.is_none(),
                                            "controlSettings": stage_controls(terminal),
                                            "returnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), actions),
                                            "children": [inner_menu],
                                        });
                                        Ok(serde_json::json!({
                                            "id": stage_uuid(stage).unwrap_or(""),
                                            "type": "menu",
                                            "name": name,
                                            "audio": item_audio,
                                            "image": item_image,
                                            "autoBlackImage": item_image.is_none(),
                                            "controlSettings": stage_controls(stage),
                                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                                            "children": [mid_menu],
                                        }))
                                    } else {
                                        Ok(serde_json::json!({
                                            "id": stage_uuid(stage).unwrap_or(""),
                                            "type": "menu",
                                            "name": name,
                                            "audio": item_audio,
                                            "image": item_image,
                                            "autoBlackImage": item_image.is_none(),
                                            "controlSettings": stage_controls(stage),
                                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                                            "children": [inner_menu],
                                        }))
                                    };
                                }
                            }
                        }
                    }
                    // Si terminal est autoplay, c'est lui-même le stage de lecture
                    // (ex: pack natif Lunii où Histoire → loop nuit, la cible est un stage nuit)
                    let (play_audio, play_controls) = if is_stage_autoplay(terminal) {
                        (
                            resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(terminal),
                        )
                    } else {
                        let play_id = term_opts[0];
                        if !visited.contains(play_id) {
                            visited.insert(play_id.to_string());
                        }
                        let play_stage = stages.get(play_id).copied().unwrap_or(terminal);
                        (
                            resolve_asset(play_stage.get("audio").and_then(|v| v.as_str()), assets),
                            stage_controls(play_stage),
                        )
                    };
                    let detection = detect_story_return_stage_id(
                        terminal,
                        stages,
                        actions,
                        prompt_stage_usage,
                        night_mode_available,
                        story_play_stage_ids,
                    );
                    let after_playback_prompt_audio =
                        detection.prompt_stage_id.as_ref().and_then(|stage_id| {
                            stages.get(stage_id.as_str()).and_then(|stage| {
                                resolve_asset(stage.get("audio").and_then(|v| v.as_str()), assets)
                            })
                        });
                    Ok(serde_json::json!({
                        "id": stage_uuid(stage).unwrap_or(""),
                        "type": "story",
                        "name": name,
                        "audio": play_audio,
                        "itemAudio": item_audio,
                        "itemImage": item_image,
                        "_playStageId": stage_uuid(terminal),
                        "titleControlSettings": stage_controls(stage),
                        "titleReturnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                        "titleReturnOnHomeNone": !has_transition_target(stage.get("homeTransition"), actions),
                        "returnStageId": detection.target_stage_id,
                        "returnStoryStageId": detection.next_story_stage_id,
                        "returnOnHomeStageId": detection
                            .home_stage_id
                            .clone()
                            .filter(|target| Some(target.as_str()) != detection.target_stage_id.as_deref()),
                        "returnOnHomeNone": detection.home_stage_id.is_none(),
                        "homeStoryStageId": detection.home_story_stage_id,
                        "afterPlaybackPromptAudio": after_playback_prompt_audio,
                        "afterPlaybackPromptControlSettings": detection.prompt_control_settings,
                        "afterPlaybackPromptOkStageId": detection.prompt_ok_stage_id,
                        "afterPlaybackPromptHomeStageId": detection.prompt_home_stage_id,
                        "afterPlaybackPromptHomeNone": detection.prompt_home_transition_none,
                        "afterPlaybackSequence": resolve_after_playback_sequence_assets(&detection.after_playback_sequence, assets),
                        "afterPlaybackHomeStep": detection.home_step.as_ref().map(|step| resolve_after_playback_step_assets(step, assets)),
                        "controlSettings": play_controls,
                    }))
                }
                _ => {
                    // Si le terminal est autoplay ET que le stage courant est dans ses options,
                    // c'est un cycle de retour (returnAfterPlay) — traiter comme fin d'histoire.
                    if is_stage_autoplay(terminal) {
                        let current_stage_id = stage_uuid(stage).unwrap_or("");
                        if !current_stage_id.is_empty() && term_opts.contains(&current_stage_id) {
                            let play_audio = resolve_asset(
                                terminal.get("audio").and_then(|v| v.as_str()),
                                assets,
                            );
                            let detection = detect_story_return_stage_id(
                                terminal,
                                stages,
                                actions,
                                prompt_stage_usage,
                                night_mode_available,
                                story_play_stage_ids,
                            );
                            let after_playback_prompt_audio =
                                detection.prompt_stage_id.as_ref().and_then(|stage_id| {
                                    stages.get(stage_id.as_str()).and_then(|stage| {
                                        resolve_asset(
                                            stage.get("audio").and_then(|v| v.as_str()),
                                            assets,
                                        )
                                    })
                                });
                            return Ok(serde_json::json!({
                                "id": stage_uuid(stage).unwrap_or(""),
                                "type": "story",
                                "name": name,
                                "audio": play_audio,
                                "itemAudio": item_audio,
                                "itemImage": item_image,
                                "_playStageId": stage_uuid(terminal),
                                "titleControlSettings": stage_controls(stage),
                                "titleReturnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                                "titleReturnOnHomeNone": !has_transition_target(stage.get("homeTransition"), actions),
                                "returnStageId": detection.target_stage_id,
                                "returnStoryStageId": detection.next_story_stage_id,
                                "returnOnHomeStageId": detection
                                    .home_stage_id
                                    .clone()
                                    .filter(|target| Some(target.as_str()) != detection.target_stage_id.as_deref()),
                                "returnOnHomeNone": detection.home_stage_id.is_none(),
                                "homeStoryStageId": detection.home_story_stage_id,
                                "afterPlaybackPromptAudio": after_playback_prompt_audio,
                                "afterPlaybackPromptControlSettings": detection.prompt_control_settings,
                                "afterPlaybackPromptOkStageId": detection.prompt_ok_stage_id,
                                "afterPlaybackPromptHomeStageId": detection.prompt_home_stage_id,
                                "afterPlaybackPromptHomeNone": detection.prompt_home_transition_none,
                                "afterPlaybackSequence": resolve_after_playback_sequence_assets(&detection.after_playback_sequence, assets),
                                "afterPlaybackHomeStep": detection.home_step.as_ref().map(|step| resolve_after_playback_step_assets(step, assets)),
                                "controlSettings": stage_controls(terminal),
                            }));
                        }
                    }
                    let children = collect_children_entries(
                        terminal,
                        stages,
                        actions,
                        assets,
                        visited,
                        prompt_stage_usage,
                        night_mode_available,
                        story_play_stage_ids,
                    );
                    let term_audio =
                        resolve_asset(terminal.get("audio").and_then(|v| v.as_str()), assets);
                    let term_image =
                        resolve_asset(terminal.get("image").and_then(|v| v.as_str()), assets);
                    // Si le terminal a un audio propre, c'est un vrai nœud de sélection
                    // (ex: "qui Suzanne va-t-elle rencontrer ?") → sous-menu imbriqué.
                    if term_audio.is_some() {
                        let sub = serde_json::json!({
                            "id": stage_uuid(terminal).unwrap_or(""),
                            "type": "menu",
                            "name": terminal.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "audio": term_audio,
                            "image": term_image,
                            "autoBlackImage": term_image.is_none(),
                            "controlSettings": stage_controls(terminal),
                            "returnOnHomeStageId": transition_target_stage_id(terminal.get("homeTransition"), actions),
                            "children": children
                        });
                        Ok(serde_json::json!({
                            "id": stage_uuid(stage).unwrap_or(""),
                            "type": "menu",
                            "name": name,
                            "audio": item_audio,
                            "image": item_image,
                            "autoBlackImage": item_image.is_none(),
                            "controlSettings": stage_controls(stage),
                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                            "children": [sub]
                        }))
                    } else {
                        // Terminal transparent (pur nœud de navigation) → aplatir
                        Ok(serde_json::json!({
                            "id": stage_uuid(stage).unwrap_or(""),
                            "type": "menu",
                            "name": name,
                            "audio": item_audio,
                            "image": item_image,
                            "autoBlackImage": item_image.is_none(),
                            "controlSettings": stage_controls(stage),
                            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                            "children": children
                        }))
                    }
                }
            }
        }
        _ => {
            // Stage avec N≥2 options directes → menu
            let children = collect_children_entries(
                stage,
                stages,
                actions,
                assets,
                visited,
                prompt_stage_usage,
                night_mode_available,
                story_play_stage_ids,
            );
            Ok(serde_json::json!({
                "id": stage_uuid(stage).unwrap_or(""),
                "type": "menu",
                "name": name,
                "audio": item_audio,
                "image": item_image,
                "autoBlackImage": item_image.is_none(),
                "controlSettings": stage_controls(stage),
                "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                "children": children
            }))
        }
    }
}
