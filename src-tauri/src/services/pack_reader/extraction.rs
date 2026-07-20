use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::projection::walk_story_doc_to_entries;
use super::stage::{is_stage_autoplay, stage_action_options, stage_control_bool, stage_uuid};
use super::validation::*;
use crate::domain::project::{GlobalOptions, Project, ProjectEntry};
use crate::domain::validation::validate_project_structure_for_generation;
use crate::native_pack::fidelity_judge::{canonical_roundtrip_is_faithful, FidelityReport};
use crate::native_pack::{canonicalize_project, StoryDocument};
use crate::support::imported_pack::ensure_studio_pack_zip;

const ROOT_REF_RATIO_LIMIT: f64 = 0.5;
pub fn load_pack_zip(zip_path: &str) -> Result<String, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    read_story_json_from_zip(&zip_path)
}

pub fn get_pack_asset(zip_path: &str, asset_name: &str) -> Result<Vec<u8>, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let asset_name = validate_pack_asset_name(asset_name)?;
    let file =
        fs::File::open(&zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), &zip_path)?;
    let mut entry = archive
        .by_name(&asset_name)
        .map_err(|_| format!("Asset introuvable : {}", asset_name))?;
    ensure_zip_entry_size("Asset", &asset_name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Dézipe un ZIP/7z Lunii et retourne `{ rootAudio, rootImage, entries }`.
/// Les fichiers audio et image sont copiés dans `dest_dir`.
pub fn unpack_zip_to_entries(zip_path: &str, dest_dir: &str) -> Result<serde_json::Value, String> {
    unpack_zip_to_entries_with_policy(zip_path, dest_dir, false)
}

pub fn unpack_zip_to_entries_with_policy(
    zip_path: &str,
    dest_dir: &str,
    allow_unsupported: bool,
) -> Result<serde_json::Value, String> {
    if allow_unsupported {
        return unpack_zip_to_entries_unchecked(zip_path, dest_dir);
    }
    let editability = classify_pack_editability(zip_path)?;
    if !editability.authoring_editable {
        return Err(format!(
            "Pack non éditable dans Story Studio : {}",
            editability.reason
        ));
    }
    unpack_zip_to_entries_unchecked(zip_path, dest_dir)
}

/// Projection brute d'un pack, réservée aux tests et outils de mesure. Les chemins
/// produit doivent passer par `unpack_zip_to_entries`, qui applique le verdict
/// d'éditabilité avant de transformer un ZIP en arbre modifiable.
pub(crate) fn unpack_zip_to_entries_unchecked(
    zip_path: &str,
    dest_dir: &str,
) -> Result<serde_json::Value, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let dest = Path::new(dest_dir);
    fs::create_dir_all(dest)
        .map_err(|e| format!("Impossible de créer le dossier de destination : {}", e))?;

    let story_json = read_story_json_from_zip(&zip_path)?;
    let doc: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;

    let asset_map = extract_all_zip_assets(&zip_path, dest)?;
    let thumbnail_path = extract_zip_thumbnail(&zip_path, dest)?;

    let mut result = walk_story_doc_to_entries(&doc, &asset_map)?;
    if let Some(uuid) = doc
        .get("uuid")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        result["uuid"] = serde_json::Value::String(uuid.to_string());
    }
    if let Some(thumb) = thumbnail_path {
        result["thumbnailImage"] = serde_json::Value::String(thumb.to_string_lossy().to_string());
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackEditabilityReport {
    pub round_trip_faithful: bool,
    pub authoring_editable: bool,
    pub read_only_inspectable: bool,
    pub reason: String,
    pub fidelity: Option<FidelityReport>,
    pub projected_entry_count: usize,
    pub root_entry_count: usize,
    pub shared_entry_count: usize,
    pub has_native_graph: bool,
    pub uses_graph_projection: bool,
    pub root_ref_ratio: f64,
    pub root_ref_only: bool,
    pub shared_entry_ratio: f64,
    pub has_unmodeled_wheel: bool,
}

impl PackEditabilityReport {
    fn unsupported(reason: String) -> Self {
        Self {
            round_trip_faithful: false,
            authoring_editable: false,
            read_only_inspectable: false,
            reason,
            fidelity: None,
            projected_entry_count: 0,
            root_entry_count: 0,
            shared_entry_count: 0,
            has_native_graph: false,
            uses_graph_projection: false,
            root_ref_ratio: 0.0,
            root_ref_only: false,
            shared_entry_ratio: 0.0,
            has_unmodeled_wheel: false,
        }
    }

    fn read_only_unprojected(reason: String) -> Self {
        Self {
            read_only_inspectable: true,
            reason,
            ..Self::unsupported(String::new())
        }
    }
}

/// Classe un pack en séparant fidélité round-trip, éditabilité authoring et
/// inspection read-only. La fidélité seule ne rend jamais un pack éditable.
pub fn classify_pack_editability(zip_path: &str) -> Result<PackEditabilityReport, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let story_json = read_story_json_from_zip(&zip_path)?;
    let doc: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;
    let story_document_is_simulable = serde_json::from_value::<StoryDocument>(doc.clone()).is_ok();
    if !story_document_is_simulable {
        return Ok(PackEditabilityReport::unsupported(
            "story.json non simulable par Story Studio.".to_string(),
        ));
    }
    let missing_assets = missing_referenced_assets(&zip_path, &doc)?;
    if !missing_assets.is_empty() {
        let rendered = missing_assets
            .iter()
            .map(|name| format!("assets/{name}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(PackEditabilityReport::unsupported(format!(
            "Asset(s) référencé(s) absent(s) du ZIP : {rendered}"
        )));
    }
    let assets = presence_faithful_asset_map(&doc);
    let imported = match walk_story_doc_to_entries(&doc, &assets) {
        Ok(imported) => imported,
        Err(error) => {
            return Ok(PackEditabilityReport::read_only_unprojected(format!(
                "Lecture seule : simulation native possible, projection authoring impossible ({error})."
            )))
        }
    };

    let title = doc
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Pack importé");
    let mut project = project_from_imported_entries(&imported, title)?;
    // L'extraction doit pouvoir ouvrir un pack existant incomplet pour que
    // l'éditeur le signale et propose l'exception silencieuse. Cette tolérance
    // ne concerne que le verdict d'import : le projet réellement retourné à
    // l'UI garde son marqueur à false et la génération reste bloquante.
    allow_missing_selection_audio_for_import_validation(&mut project.root_entries);
    allow_missing_selection_audio_for_import_validation(&mut project.shared_entries);
    let root_entry_count = count_project_entries(&project.root_entries);
    let shared_entry_count = count_project_entries(&project.shared_entries);
    let projected_entry_count = root_entry_count + shared_entry_count;
    let root_ref_count = project
        .root_entries
        .iter()
        .filter(|entry| entry.entry_type == "ref")
        .count();
    let root_ref_ratio = ratio(root_ref_count, project.root_entries.len());
    let root_ref_only =
        !project.root_entries.is_empty() && root_ref_count == project.root_entries.len();
    let shared_entry_ratio = ratio(shared_entry_count, projected_entry_count);
    let has_native_graph = imported
        .get("nativeGraph")
        .filter(|value| !value.is_null())
        .is_some();
    let uses_graph_projection = imported
        .get("usesGraphProjection")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let has_unmodeled_wheel = has_unmodeled_wheel(&doc);
    let structural_validation = validate_project_structure_for_generation(&project);
    let structural_validation_ok = structural_validation.is_ok();
    let structural_error = structural_validation.err().and_then(|error| {
        error
            .lines()
            .next()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
    });
    project.native_graph = Some(serde_json::json!({
        "preserveForRoundTrip": true,
        "document": doc,
    }));

    let canonical = canonicalize_project(&project);
    let fidelity = canonical_roundtrip_is_faithful(&canonical)?;
    let canonical_round_trip_faithful = fidelity.faithful;
    let round_trip_faithful = canonical_round_trip_faithful;
    let aggregate_wrapper_count = story_studio_aggregation_wrapper_count(&doc);
    let aggregate_end_gap_tolerated =
        aggregate_end_gap_is_tolerated(aggregate_wrapper_count, &fidelity);
    let end_home_or_night_gap_tolerated = end_home_or_night_gap_is_tolerated(&fidelity);
    let authoring_editable = projected_entry_count > 0
        && structural_validation_ok
        && !uses_graph_projection
        && root_ref_ratio < ROOT_REF_RATIO_LIMIT
        && shared_entry_count == 0
        && !has_unmodeled_wheel
        && (round_trip_faithful || aggregate_end_gap_tolerated || end_home_or_night_gap_tolerated);
    let read_only_inspectable = !authoring_editable && story_document_is_simulable;
    let reason = if authoring_editable {
        if round_trip_faithful {
            "Pack authoring éditable : génération canonique fidèle au story.json d'origine."
                .to_string()
        } else if aggregate_end_gap_tolerated {
            "Pack authoring éditable : agrégat Story Studio projeté, écart strict limité aux retours de fin/night par sous-pack.".to_string()
        } else {
            "Pack authoring éditable : écart strict limité aux retours/prompts de fin/night, sans perte de nœud ni d'asset.".to_string()
        }
    } else if projected_entry_count == 0 {
        "Lecture seule : aucune entrée authoring projetée depuis le story.json.".to_string()
    } else if has_unmodeled_wheel {
        "Lecture seule : roue/carrousel natif non modélisé en authoring.".to_string()
    } else if let Some(error) = structural_error {
        error
    } else if shared_entry_count > 0 {
        "Lecture seule : projection hors arbre avec éléments partagés non prise en charge en authoring."
            .to_string()
    } else if uses_graph_projection {
        "Lecture seule : graph_import a produit une projection fidèle mais non authoring."
            .to_string()
    } else if root_ref_only {
        "Lecture seule : la racine importée est uniquement composée de références.".to_string()
    } else if root_ref_ratio >= ROOT_REF_RATIO_LIMIT {
        "Lecture seule : trop de références à la racine du projet importé.".to_string()
    } else if !round_trip_faithful {
        "Lecture seule : simulation native possible, génération canonique non fidèle au story.json d'origine."
            .to_string()
    } else {
        "Lecture seule : le pack est fidèle en round-trip mais hors critères authoring.".to_string()
    };

    Ok(PackEditabilityReport {
        round_trip_faithful,
        authoring_editable,
        read_only_inspectable,
        reason,
        fidelity: Some(fidelity),
        projected_entry_count,
        root_entry_count,
        shared_entry_count,
        has_native_graph,
        uses_graph_projection,
        root_ref_ratio,
        root_ref_only,
        shared_entry_ratio,
        has_unmodeled_wheel,
    })
}

fn story_studio_aggregation_wrapper_count(doc: &serde_json::Value) -> usize {
    let stages: HashMap<&str, &serde_json::Value> = doc
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|stage| stage_uuid(stage).map(|id| (id, stage)))
                .collect()
        })
        .unwrap_or_default();
    let actions: HashMap<&str, &serde_json::Value> = doc
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|action| {
                    action
                        .get("id")
                        .and_then(|id| id.as_str())
                        .map(|id| (id, action))
                })
                .collect()
        })
        .unwrap_or_default();
    let Some(square_one) = stages.values().find(|stage| {
        stage
            .get("squareOne")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }) else {
        return 0;
    };
    let mut visited = HashSet::new();
    story_studio_aggregation_wrapper_count_from(square_one, &stages, &actions, &mut visited)
}

fn story_studio_aggregation_wrapper_count_from(
    stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    visited: &mut HashSet<String>,
) -> usize {
    let Some(stage_id) = stage_uuid(stage) else {
        return 0;
    };
    if !visited.insert(stage_id.to_string()) {
        return 0;
    }

    let options = stage_action_options(stage, actions);
    if options.len() >= 2
        && options.iter().all(|option| {
            stages.get(option).is_some_and(|candidate| {
                is_story_studio_aggregation_wrapper(candidate, stages, actions)
            })
        })
    {
        return options.len();
    }

    options
        .iter()
        .filter_map(|option| stages.get(option).copied())
        .map(|child| story_studio_aggregation_wrapper_count_from(child, stages, actions, visited))
        .sum()
}

fn is_story_studio_aggregation_wrapper(
    stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    if is_stage_autoplay(stage)
        || !stage_control_bool(stage, "wheel", false)
        || !stage_control_bool(stage, "ok", false)
        || !stage_has_audio(stage)
    {
        return false;
    }

    let options = stage_action_options(stage, actions);
    let Some(first_id) = options.first().copied().filter(|_| options.len() == 1) else {
        return false;
    };
    let Some(first) = stages.get(first_id).copied() else {
        return false;
    };

    if !is_stage_autoplay(first) {
        return stage_has_media(first) && !stage_action_options(first, actions).is_empty();
    }
    if !is_aggregation_intro_stage(first) {
        return false;
    }

    let mut current = first;
    let mut visited = HashSet::new();
    loop {
        let current_id = stage_uuid(current).unwrap_or("");
        if !visited.insert(current_id) {
            return false;
        }
        let current_options = stage_action_options(current, actions);
        if current_options.len() >= 2 {
            return true;
        }
        let Some(next_id) = current_options
            .first()
            .copied()
            .filter(|_| current_options.len() == 1)
        else {
            return false;
        };
        let Some(next) = stages.get(next_id).copied() else {
            return false;
        };
        if !is_stage_autoplay(next) {
            return stage_control_bool(next, "wheel", false)
                && stage_action_options(next, actions).len() >= 2;
        }
        if !is_aggregation_intro_stage(next) {
            return false;
        }
        current = next;
    }
}

fn stage_has_media(stage: &serde_json::Value) -> bool {
    stage
        .get("audio")
        .and_then(|value| value.as_str())
        .is_some()
        || stage
            .get("image")
            .and_then(|value| value.as_str())
            .is_some()
}

fn stage_has_audio(stage: &serde_json::Value) -> bool {
    stage
        .get("audio")
        .and_then(|value| value.as_str())
        .is_some()
}

fn is_aggregation_intro_stage(stage: &serde_json::Value) -> bool {
    is_stage_autoplay(stage) && stage_control_bool(stage, "ok", false)
}

fn aggregate_end_gap_is_tolerated(wrapper_count: usize, fidelity: &FidelityReport) -> bool {
    if wrapper_count < 2
        || fidelity.faithful
        || fidelity.invalid_transition_count != 0
        || fidelity.generated_stage_count >= fidelity.oracle_stage_count
    {
        return false;
    }
    let missing_stage_count = fidelity.oracle_stage_count - fidelity.generated_stage_count;
    missing_stage_count <= wrapper_count
        && fidelity.asset_presence_gap_count <= missing_stage_count
        && !fidelity.topology_gaps.iter().any(|gap| {
            gap.contains("nightModeAvailable")
                || gap.contains("squareOne manquant")
                || gap.contains("transition invalide")
        })
}

fn end_home_or_night_gap_is_tolerated(fidelity: &FidelityReport) -> bool {
    if fidelity.faithful
        || fidelity.invalid_transition_count != 0
        || fidelity.asset_presence_gap_count != 0
        || fidelity.generated_stage_count != fidelity.oracle_stage_count
        || fidelity.topology_gaps.is_empty()
    {
        return false;
    }

    fidelity
        .topology_gaps
        .iter()
        .all(|gap| is_end_home_or_night_gap(gap))
}

fn is_end_home_or_night_gap(gap: &str) -> bool {
    gap.starts_with("nightModeAvailable :")
        || is_end_play_home_gap(gap)
        || is_end_prompt_ok_gap(gap)
}

fn is_end_play_home_gap(gap: &str) -> bool {
    gap.starts_with("transition ")
        && gap.contains("kind: Home")
        && gap.contains("pause: true")
        && gap.contains("autoplay: true")
        && !gap.contains("Invalid")
}

fn is_end_prompt_ok_gap(gap: &str) -> bool {
    gap.starts_with("transition ")
        && gap.contains("kind: Ok")
        && gap.contains("has_audio: true")
        && gap.contains("has_image: false")
        && gap.contains("wheel: false")
        && gap.contains("ok: true")
        && gap.contains("home: true")
        && gap.contains("pause: false")
        && !gap.contains("Invalid")
}

/// Teste « à sec » si un pack est éditable par Story Studio. Retourne :
///  - `Ok(true)`  : pack authoring-editable → ouvrable en édition.
///  - `Ok(false)` : pack valide mais non authoring-editable → simulable seulement.
///  - `Err(_)`    : archive invalide / illisible (ni éditable ni simulable).
pub fn check_pack_editability(zip_path: &str) -> Result<bool, String> {
    classify_pack_editability(zip_path).map(|report| report.authoring_editable)
}

fn presence_faithful_asset_map(doc: &serde_json::Value) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    let Some(stages) = doc.get("stageNodes").and_then(|value| value.as_array()) else {
        return map;
    };
    for stage in stages {
        for key in ["audio", "image"] {
            let Some(raw) = stage.get(key).and_then(|value| value.as_str()) else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let short = trimmed.strip_prefix("assets/").unwrap_or(trimmed);
            if short.is_empty() {
                continue;
            }
            map.entry(short.to_string())
                .or_insert_with(|| PathBuf::from(short));
        }
    }
    map
}

fn referenced_asset_names(doc: &serde_json::Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Some(stages) = doc.get("stageNodes").and_then(|value| value.as_array()) else {
        return names;
    };
    for stage in stages {
        for key in ["audio", "image"] {
            let Some(raw) = stage.get(key).and_then(|value| value.as_str()) else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let short = trimmed.strip_prefix("assets/").unwrap_or(trimmed);
            if !short.trim().is_empty() {
                names.insert(short.to_string());
            }
        }
    }
    names
}

fn zip_asset_names(zip_path: &Path) -> Result<HashSet<String>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP assets : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("Erreur lecture ZIP index {} : {}", index, e))?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with('/') {
            continue;
        }
        let Ok(asset_name) = validate_pack_asset_name(&name) else {
            continue;
        };
        let short = asset_name
            .strip_prefix("assets/")
            .ok_or_else(|| format!("Nom d'asset hors dossier assets/ : {asset_name}"))?;
        names.insert(short.to_string());
    }
    Ok(names)
}

fn missing_referenced_assets(
    zip_path: &Path,
    doc: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let available = zip_asset_names(zip_path)?;
    Ok(referenced_asset_names(doc)
        .into_iter()
        .filter(|name| !available.contains(name))
        .collect())
}

fn project_from_imported_entries(
    imported: &serde_json::Value,
    title: &str,
) -> Result<Project, String> {
    let root_audio = imported
        .get("rootAudio")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let root_image = imported
        .get("rootImage")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let night_mode = imported
        .get("nightMode")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let auto_next = imported
        .get("autoNext")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let night_mode_audio = imported
        .get("nightModeAudio")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let night_mode_return = imported
        .get("nightModeReturn")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let night_mode_home_return = imported
        .get("nightModeHomeReturn")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let wrapper_id = imported
        .get("rootId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();

    let mut entries: Vec<ProjectEntry> =
        serde_json::from_value(imported.get("entries").cloned().unwrap_or_default())
            .map_err(|error| format!("Entrées importées invalides : {error}"))?;
    for entry in &mut entries {
        rewrite_imported_root_targets(entry, &wrapper_id);
    }
    let mut shared_entries: Vec<ProjectEntry> =
        serde_json::from_value(imported.get("sharedEntries").cloned().unwrap_or_default())
            .map_err(|error| format!("Entrées partagées importées invalides : {error}"))?;
    for entry in &mut shared_entries {
        rewrite_imported_root_targets(entry, &wrapper_id);
    }

    Ok(Project {
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
        native_graph: imported
            .get("nativeGraph")
            .filter(|value| !value.is_null())
            .cloned(),
        pack_version: imported
            .get("packVersion")
            .and_then(|value| value.as_i64())
            .and_then(|value| i32::try_from(value).ok())
            .unwrap_or(1),
        pack_description: imported
            .get("packDescription")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        pack_uuid: imported
            .get("uuid")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        root_entries: entries,
        shared_entries,
        global_options: GlobalOptions {
            add_silence: false,
            silence_mode: None,
            add_silence_duration_sec: crate::domain::project::AudioEdgeSilenceDuration::uniform(
                1.0,
            ),
            auto_next,
            night_mode,
            harmonize_loudness: true,
        },
    })
}

fn allow_missing_selection_audio_for_import_validation(entries: &mut [ProjectEntry]) {
    for entry in entries {
        if entry.entry_type == "story"
            && entry
                .item_audio
                .as_deref()
                .map(str::trim)
                .is_none_or(str::is_empty)
        {
            entry.silent_title_stage = true;
        }
        allow_missing_selection_audio_for_import_validation(&mut entry.children);
    }
}

fn rewrite_imported_navigation_target(target: Option<String>, wrapper_id: &str) -> Option<String> {
    let target = target?;
    if target.is_empty() {
        return None;
    }
    if target == format!("menu:{wrapper_id}") {
        Some("root".to_string())
    } else {
        Some(target)
    }
}

fn rewrite_imported_root_targets(entry: &mut ProjectEntry, wrapper_id: &str) {
    entry.return_after_play =
        rewrite_imported_navigation_target(entry.return_after_play.take(), wrapper_id);
    entry.return_on_home =
        rewrite_imported_navigation_target(entry.return_on_home.take(), wrapper_id);
    entry.title_return_on_home =
        rewrite_imported_navigation_target(entry.title_return_on_home.take(), wrapper_id);
    entry.after_playback_prompt_ok_target = rewrite_imported_navigation_target(
        entry.after_playback_prompt_ok_target.take(),
        wrapper_id,
    );
    entry.after_playback_prompt_home_target = rewrite_imported_navigation_target(
        entry.after_playback_prompt_home_target.take(),
        wrapper_id,
    );
    for step in &mut entry.after_playback_sequence {
        step.ok_target = rewrite_imported_navigation_target(step.ok_target.take(), wrapper_id);
        step.ok_choice_targets = step
            .ok_choice_targets
            .drain(..)
            .filter_map(|target| rewrite_imported_navigation_target(Some(target), wrapper_id))
            .collect();
        step.home_target = rewrite_imported_navigation_target(step.home_target.take(), wrapper_id);
    }
    if let Some(step) = &mut entry.after_playback_home_step {
        step.ok_target = rewrite_imported_navigation_target(step.ok_target.take(), wrapper_id);
        step.ok_choice_targets = step
            .ok_choice_targets
            .drain(..)
            .filter_map(|target| rewrite_imported_navigation_target(Some(target), wrapper_id))
            .collect();
        step.home_target = rewrite_imported_navigation_target(step.home_target.take(), wrapper_id);
    }
    for child in &mut entry.children {
        rewrite_imported_root_targets(child, wrapper_id);
    }
}

fn count_project_entries(entries: &[ProjectEntry]) -> usize {
    entries
        .iter()
        .map(|entry| 1 + count_project_entries(&entry.children))
        .sum()
}

fn ratio(part: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        part as f64 / total as f64
    }
}

fn story_doc_indexes(
    doc: &serde_json::Value,
) -> (
    HashMap<&str, &serde_json::Value>,
    HashMap<&str, &serde_json::Value>,
) {
    let stages = doc
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .map(|stages| {
            stages
                .iter()
                .filter_map(|stage| stage_uuid(stage).map(|id| (id, stage)))
                .collect()
        })
        .unwrap_or_default();
    let actions = doc
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .map(|actions| {
            actions
                .iter()
                .filter_map(|action| {
                    action
                        .get("id")
                        .and_then(|value| value.as_str())
                        .filter(|id| !id.trim().is_empty())
                        .map(|id| (id, action))
                })
                .collect()
        })
        .unwrap_or_default();
    (stages, actions)
}

fn ok_path_reaches_stage(
    current_id: &str,
    target_id: &str,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    visited: &mut HashSet<String>,
    depth: usize,
) -> bool {
    if depth > 32 || !visited.insert(current_id.to_string()) {
        return false;
    }
    let Some(stage) = stages.get(current_id) else {
        return false;
    };
    for next_id in stage_action_options(stage, actions) {
        if next_id == target_id {
            return true;
        }
        if ok_path_reaches_stage(next_id, target_id, stages, actions, visited, depth + 1) {
            return true;
        }
    }
    false
}

fn has_unmodeled_wheel(doc: &serde_json::Value) -> bool {
    let (stages, actions) = story_doc_indexes(doc);
    stages.iter().any(|(stage_id, stage)| {
        if !stage_control_bool(stage, "wheel", false)
            || !stage_control_bool(stage, "autoplay", false)
        {
            return false;
        }
        let targets = stage_action_options(stage, &actions);
        if targets.len() < 2 {
            return false;
        }
        targets.contains(stage_id)
            || targets.iter().any(|target_id| {
                ok_path_reaches_stage(
                    target_id,
                    stage_id,
                    &stages,
                    &actions,
                    &mut HashSet::new(),
                    0,
                )
            })
    })
}

fn read_story_json_from_zip(zip_path: &Path) -> Result<String, String> {
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut entry = archive
        .by_name("story.json")
        .map_err(|_| "story.json introuvable dans le ZIP".to_string())?;
    ensure_zip_entry_size(
        "story.json",
        "story.json",
        entry.size(),
        MAX_STORY_JSON_BYTES,
    )?;
    let mut content = String::new();
    entry
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    Ok(content)
}

/// Extrait tous les fichiers `assets/*` du ZIP dans `dest_dir`.
/// Retourne une map nom_court → chemin absolu sur disque.
fn extract_all_zip_assets(
    zip_path: &Path,
    dest: &Path,
) -> Result<HashMap<String, PathBuf>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP assets : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut map = HashMap::new();
    let mut total_asset_bytes = 0_u64;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur lecture ZIP index {} : {}", i, e))?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with('/') {
            continue;
        }
        let Ok(asset_name) = validate_pack_asset_name(&name) else {
            continue;
        };
        let short = asset_name
            .strip_prefix("assets/")
            .ok_or_else(|| format!("Nom d'asset hors dossier assets/ : {asset_name}"))?;
        ensure_zip_entry_size("Asset", &name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
        total_asset_bytes = total_asset_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Taille totale des assets ZIP trop volumineuse.".to_string())?;
        ensure_total_asset_size(total_asset_bytes)?;
        let out_path = dest.join(short);
        if !out_path.exists() {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Création dossier asset {} impossible : {}", short, e))?;
            }
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Lecture asset {} impossible : {}", name, e))?;
            fs::write(&out_path, &buf)
                .map_err(|e| format!("Écriture asset {} impossible : {}", short, e))?;
        }
        map.insert(short.to_string(), out_path);
    }
    Ok(map)
}

fn extract_zip_thumbnail(zip_path: &Path, dest: &Path) -> Result<Option<PathBuf>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP thumbnail : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for name in &["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"] {
        if let Ok(mut entry) = archive.by_name(name) {
            ensure_zip_entry_size("Thumbnail", name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
            let file_name = Path::new(name).file_name().unwrap_or_default();
            let out_path = dest.join(file_name);
            if !out_path.exists() {
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Lecture thumbnail impossible : {}", e))?;
                fs::write(&out_path, &buf)
                    .map_err(|e| format!("Écriture thumbnail impossible : {}", e))?;
            }
            return Ok(Some(out_path));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{
        check_pack_editability, classify_pack_editability, unpack_zip_to_entries,
        unpack_zip_to_entries_unchecked, unpack_zip_to_entries_with_policy,
    };
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "story_studio_editability_test_{}_{}_{}",
            name,
            std::process::id(),
            nanos
        ))
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create zip parent");
        }
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start zip file");
            writer.write_all(bytes).expect("write zip file");
        }
        writer.finish().expect("finish zip");
    }

    fn write_story_zip(path: &Path, story: &serde_json::Value) {
        let raw = serde_json::to_vec(story).expect("serialize story");
        write_zip(
            path,
            &[
                ("story.json", raw.as_slice()),
                ("assets/root.mp3", b"root"),
                ("assets/cover.png", b"cover"),
                ("assets/item.mp3", b"item"),
                ("assets/item.png", b"item-image"),
                ("assets/story.mp3", b"story"),
                ("assets/extra.mp3", b"extra"),
            ],
        );
    }

    fn write_story_zip_with_assets(path: &Path, story: &serde_json::Value, assets: &[&str]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create zip parent");
        }
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let raw = serde_json::to_vec(story).expect("serialize story");
        writer
            .start_file("story.json", options)
            .expect("start story");
        writer.write_all(&raw).expect("write story");
        for asset in assets {
            writer
                .start_file(format!("assets/{asset}"), options)
                .expect("start asset");
            writer.write_all(asset.as_bytes()).expect("write asset");
        }
        writer.finish().expect("finish zip");
    }

    fn editable_story_json() -> serde_json::Value {
        serde_json::json!({
            "title": "Pack editable",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "cover", "name": "Cover", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "title", "name": "Titre", "type": "stage", "squareOne": false,
                    "audio": "item.mp3", "image": "item.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "play-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "play", "name": "Lecture", "type": "stage", "squareOne": false,
                    "audio": "story.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                    "okTransition": null,
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["title"] },
                { "id": "play-action", "name": "Play", "options": ["play"] }
            ]
        })
    }

    fn lapin_like_story_json() -> serde_json::Value {
        serde_json::json!({
            "title": "Lapin-like synthetic",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "root", "name": "Depart", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "dispatcher", "name": "Dispatcher", "type": "stage", "squareOne": false,
                    "audio": "dispatcher.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "dispatcher-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "branch-a", "name": "Choix A", "type": "stage", "squareOne": false,
                    "audio": "branch-a.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "branch-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "branch-b", "name": "Choix B", "type": "stage", "squareOne": false,
                    "audio": "branch-b.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "branch-b-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "branch-c", "name": "Choix C", "type": "stage", "squareOne": false,
                    "audio": "branch-c.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "branch-c-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "hub-title", "name": "Titre partage", "type": "stage", "squareOne": false,
                    "audio": "hub-title.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "hub-title-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "hub-play", "name": "Lecture partagee", "type": "stage", "squareOne": false,
                    "audio": "hub-play.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": { "actionNode": "hub-play-return-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "cycle-a", "name": "Cycle A", "type": "stage", "squareOne": false,
                    "audio": "cycle-a.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "cycle-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "cycle-b", "name": "Cycle B", "type": "stage", "squareOne": false,
                    "audio": "cycle-b.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "cycle-b-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["dispatcher"] },
                { "id": "dispatcher-action", "name": "Dispatcher", "options": ["branch-a", "branch-b", "branch-c"] },
                { "id": "branch-a-action", "name": "A", "options": ["hub-title"] },
                { "id": "branch-b-action", "name": "B", "options": ["cycle-a"] },
                { "id": "branch-c-action", "name": "C", "options": ["hub-title"] },
                { "id": "hub-title-action", "name": "Hub", "options": ["hub-play"] },
                { "id": "hub-play-return-action", "name": "Hub return", "options": ["hub-title", "cycle-a"] },
                { "id": "cycle-a-action", "name": "Cycle A", "options": ["cycle-b"] },
                { "id": "cycle-b-action", "name": "Cycle B", "options": ["cycle-a"] },
                { "id": "home-action", "name": "Home", "options": ["dispatcher"] }
            ]
        })
    }

    fn unmodeled_wheel_story_json() -> serde_json::Value {
        serde_json::json!({
            "title": "Wheel synthetic",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "carousel", "name": "Carousel", "type": "stage", "squareOne": false,
                    "audio": "story.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "carousel-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                },
                {
                    "uuid": "exit", "name": "Exit", "type": "stage", "squareOne": false,
                    "audio": "extra.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": null,
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["carousel"] },
                { "id": "carousel-action", "name": "Carousel", "options": ["carousel", "exit"] }
            ]
        })
    }

    fn autoplay_multi_ok_without_wheel_story_json() -> serde_json::Value {
        serde_json::json!({
            "title": "Autoplay multi OK synthetic",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "prompt", "name": "Prompt", "type": "stage", "squareOne": false,
                    "audio": "item.mp3", "image": "item.png",
                    "controlSettings": { "wheel": false, "ok": true, "home": true, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "prompt-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                },
                {
                    "uuid": "story-a", "name": "A", "type": "stage", "squareOne": false,
                    "audio": "story.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": null,
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                },
                {
                    "uuid": "story-b", "name": "B", "type": "stage", "squareOne": false,
                    "audio": "extra.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": null,
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["prompt"] },
                { "id": "prompt-action", "name": "Prompt", "options": ["story-a", "story-b"] }
            ]
        })
    }

    fn aggregate_with_child_night_bridges_story_json() -> serde_json::Value {
        serde_json::json!({
            "title": "Aggregate night bridge synthetic",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "wrap-a", "name": "Pack A", "type": "stage", "squareOne": false,
                    "audio": "wrap-a.mp3", "image": "wrap-a.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "wrap-a-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "title-a", "name": "A", "type": "stage", "squareOne": false,
                    "audio": "title-a.mp3", "image": "title-a.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "title-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                },
                {
                    "uuid": "play-a", "name": "Lecture A", "type": "stage", "squareOne": false,
                    "audio": "play-a.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": { "actionNode": "play-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                },
                {
                    "uuid": "night-a", "name": "nightStage", "type": "stage", "squareOne": false,
                    "audio": "night-a.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": true, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "night-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                },
                {
                    "uuid": "wrap-b", "name": "Pack B", "type": "stage", "squareOne": false,
                    "audio": "wrap-b.mp3", "image": "wrap-b.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "wrap-b-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "title-b", "name": "B", "type": "stage", "squareOne": false,
                    "audio": "title-b.mp3", "image": "title-b.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "title-b-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 1 }
                },
                {
                    "uuid": "play-b", "name": "Lecture B", "type": "stage", "squareOne": false,
                    "audio": "play-b.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": { "actionNode": "play-b-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 1 }
                },
                {
                    "uuid": "night-b", "name": "nightStage", "type": "stage", "squareOne": false,
                    "audio": "night-b.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": true, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "night-b-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 1 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["wrap-a", "wrap-b"] },
                { "id": "wrap-a-action", "name": "Pack A", "options": ["title-a"] },
                { "id": "title-a-action", "name": "A", "options": ["play-a"] },
                { "id": "play-a-action", "name": "Fin A", "options": ["night-a"] },
                { "id": "night-a-action", "name": "Retour A", "options": ["wrap-a"] },
                { "id": "wrap-b-action", "name": "Pack B", "options": ["title-b"] },
                { "id": "title-b-action", "name": "B", "options": ["play-b"] },
                { "id": "play-b-action", "name": "Fin B", "options": ["night-b"] },
                { "id": "night-b-action", "name": "Retour B", "options": ["wrap-b"] }
            ]
        })
    }

    fn aggregate_night_bridge_assets() -> Vec<&'static str> {
        vec![
            "root.mp3",
            "cover.png",
            "selector.mp3",
            "selector.png",
            "wrap-a.mp3",
            "wrap-a.png",
            "title-a.mp3",
            "title-a.png",
            "play-a.mp3",
            "night-a.mp3",
            "wrap-b.mp3",
            "wrap-b.png",
            "title-b.mp3",
            "title-b.png",
            "play-b.mp3",
            "night-b.mp3",
        ]
    }

    fn nested_aggregate_with_child_night_bridges_story_json() -> serde_json::Value {
        let mut story = aggregate_with_child_night_bridges_story_json();
        {
            let stages = story["stageNodes"].as_array_mut().expect("stage nodes");
            stages.push(serde_json::json!({
                "uuid": "selector", "name": "Choisis ton histoire", "type": "stage", "squareOne": false,
                "audio": "selector.mp3", "image": "selector.png",
                "controlSettings": { "wheel": false, "ok": true, "home": true, "pause": false, "autoplay": true },
                "okTransition": { "actionNode": "selector-action", "optionIndex": 0 },
                "homeTransition": null
            }));
            for (stage_id, option_index) in [
                ("title-a", 0),
                ("play-a", 0),
                ("night-a", 0),
                ("title-b", 1),
                ("play-b", 1),
                ("night-b", 1),
            ] {
                let stage = stages
                    .iter_mut()
                    .find(|stage| stage["uuid"].as_str() == Some(stage_id))
                    .expect("nested aggregate child stage");
                stage["homeTransition"] = serde_json::json!({
                    "actionNode": "selector-action",
                    "optionIndex": option_index,
                });
            }
        }
        {
            let actions = story["actionNodes"].as_array_mut().expect("action nodes");
            let root_action = actions
                .iter_mut()
                .find(|action| action["id"].as_str() == Some("root-action"))
                .expect("root action");
            root_action["options"] = serde_json::json!(["selector"]);
            actions.push(serde_json::json!({
                "id": "selector-action", "name": "Selector", "options": ["wrap-a", "wrap-b"]
            }));
        }
        story
    }

    #[test]
    fn wheel_autoplay_cycle_is_unmodeled() {
        assert!(super::has_unmodeled_wheel(&unmodeled_wheel_story_json()));
    }

    #[test]
    fn autoplay_multi_ok_without_wheel_is_not_unmodeled() {
        assert!(!super::has_unmodeled_wheel(
            &autoplay_multi_ok_without_wheel_story_json()
        ));
    }

    #[test]
    fn faithful_pack_is_editable() {
        let dir = temp_dir("editable");
        let zip_path = dir.join("pack.zip");
        write_story_zip(&zip_path, &editable_story_json());

        let editable = check_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(editable);
        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(report.round_trip_faithful);
        assert!(report.authoring_editable);
        assert!(!report.read_only_inspectable);
        assert!(!report.uses_graph_projection);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn pack_with_missing_selection_audio_is_importable_for_editor_correction() {
        let dir = temp_dir("missing_selection_audio");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        let title_stage = story["stageNodes"]
            .as_array_mut()
            .expect("stage nodes")
            .iter_mut()
            .find(|stage| stage["uuid"].as_str() == Some("title"))
            .expect("title stage");
        title_stage["audio"] = serde_json::Value::Null;
        write_story_zip(&zip_path, &story);

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("report");
        assert!(report.authoring_editable, "{}", report.reason);

        let imported = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            dir.join("out").to_str().expect("utf8"),
        )
        .expect("the editor must be able to correct missing selection audio");
        let imported_story = imported["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["name"].as_str() == Some("Pack editable"))
            .expect("silent title story");
        assert!(imported_story["itemAudio"].is_null());
        assert_eq!(imported_story["silentTitleStage"].as_bool(), Some(true));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn missing_selection_audio_field_is_not_marked_as_explicit_silence() {
        let dir = temp_dir("missing_selection_audio_field");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        let title_stage = story["stageNodes"]
            .as_array_mut()
            .expect("stage nodes")
            .iter_mut()
            .find(|stage| stage["uuid"].as_str() == Some("title"))
            .expect("title stage");
        title_stage
            .as_object_mut()
            .expect("title stage object")
            .remove("audio");
        write_story_zip(&zip_path, &story);

        let imported = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            dir.join("out").to_str().expect("utf8"),
        )
        .expect("the editor must be able to correct the malformed title stage");
        let imported_story = imported["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["name"].as_str() == Some("Pack editable"))
            .expect("title story");
        assert!(imported_story["itemAudio"].is_null());
        assert!(imported_story.get("silentTitleStage").is_none());

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn nested_assets_are_classified_and_extracted() {
        let dir = temp_dir("nested_assets");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        let stages = story
            .get_mut("stageNodes")
            .and_then(|value| value.as_array_mut())
            .expect("stage nodes");
        for stage in stages {
            match stage.get("uuid").and_then(|value| value.as_str()) {
                Some("cover") => {
                    stage["audio"] = serde_json::Value::String("audio/root.mp3".to_string());
                    stage["image"] = serde_json::Value::String("images/cover.png".to_string());
                }
                Some("title") => {
                    stage["audio"] = serde_json::Value::String("audio/item.mp3".to_string());
                    stage["image"] = serde_json::Value::String("images/item.png".to_string());
                }
                Some("play") => {
                    stage["audio"] = serde_json::Value::String("audio/story.mp3".to_string());
                }
                _ => {}
            }
        }
        write_story_zip_with_assets(
            &zip_path,
            &story,
            &[
                "audio/root.mp3",
                "images/cover.png",
                "audio/item.mp3",
                "images/item.png",
                "audio/story.mp3",
            ],
        );

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(report.authoring_editable, "{}", report.reason);

        let out_dir = dir.join("out");
        let imported = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            out_dir.to_str().expect("utf8"),
        )
        .expect("nested assets unpack");
        assert!(out_dir.join("audio").join("root.mp3").exists());
        assert!(out_dir.join("images").join("cover.png").exists());
        assert!(imported["rootAudio"]
            .as_str()
            .unwrap_or_default()
            .replace('\\', "/")
            .ends_with("/audio/root.mp3"));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn lapin_like_branching_graph_is_roundtrip_faithful_but_read_only() {
        let dir = temp_dir("lapin_like_graph");
        let zip_path = dir.join("pack.zip");
        let story = lapin_like_story_json();
        write_story_zip_with_assets(
            &zip_path,
            &story,
            &[
                "root.mp3",
                "cover.png",
                "dispatcher.mp3",
                "branch-a.mp3",
                "branch-b.mp3",
                "branch-c.mp3",
                "hub-title.mp3",
                "hub-play.mp3",
                "cycle-a.mp3",
                "cycle-b.mp3",
            ],
        );

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(
            report.round_trip_faithful,
            "diagnostic inattendu : {}",
            report.reason
        );
        assert!(!report.authoring_editable);
        assert!(report.read_only_inspectable);
        assert!(report.uses_graph_projection);
        assert!(report.shared_entry_ratio > 0.0);
        assert!(!report.has_native_graph);

        let public_error = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            dir.join("public-out").to_str().expect("utf8"),
        )
        .expect_err("graph projection must not open as authoring");
        assert!(public_error.contains("Pack non éditable"));

        let imported = unpack_zip_to_entries_unchecked(
            zip_path.to_str().expect("utf8"),
            dir.join("out").to_str().expect("utf8"),
        )
        .expect("unpack graph for read-only inspection");
        assert!(imported["nativeGraph"].is_null());
        assert_eq!(imported["usesGraphProjection"], true);
        let shared_entries = imported["sharedEntries"]
            .as_array()
            .expect("shared entries");
        assert_eq!(shared_entries.len(), 2);
        let shared_hub = shared_entries
            .iter()
            .find(|entry| entry["id"] == "hub-title")
            .expect("shared convergence title");
        assert_eq!(shared_hub["type"], "story");
        assert!(shared_hub["itemAudio"]
            .as_str()
            .is_some_and(|value| value.ends_with("hub-title.mp3")));
        assert!(shared_hub["audio"]
            .as_str()
            .is_some_and(|value| value.ends_with("hub-play.mp3")));
        assert!(shared_entries.iter().any(|entry| entry["id"] == "cycle-a"));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn branching_graph_with_unfaithful_orphan_native_helper_is_not_editable() {
        let dir = temp_dir("orphan_helper_graph");
        let zip_path = dir.join("pack.zip");
        let mut story = lapin_like_story_json();
        story["stageNodes"]
            .as_array_mut()
            .expect("stages")
            .push(serde_json::json!({
                "uuid": "orphan-helper", "name": "Helper orphelin", "type": "stage", "squareOne": false,
                "audio": null, "image": null,
                "controlSettings": { "wheel": false, "ok": true, "home": true, "pause": false, "autoplay": true },
                "okTransition": { "actionNode": "orphan-helper-action", "optionIndex": 0 },
                "homeTransition": null
            }));
        story["actionNodes"]
            .as_array_mut()
            .expect("actions")
            .push(serde_json::json!({
                "id": "orphan-helper-action", "name": "Helper orphelin", "options": ["branch-a"]
            }));
        write_story_zip_with_assets(
            &zip_path,
            &story,
            &[
                "root.mp3",
                "cover.png",
                "dispatcher.mp3",
                "branch-a.mp3",
                "branch-b.mp3",
                "branch-c.mp3",
                "hub-title.mp3",
                "hub-play.mp3",
                "cycle-a.mp3",
                "cycle-b.mp3",
            ],
        );

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");

        assert!(
            !report.authoring_editable,
            "un helper orphelin non fidèle ne doit pas être annoncé éditable"
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn aggregate_with_only_child_night_bridge_gap_is_authoring_editable() {
        let dir = temp_dir("aggregate_night_bridge");
        let zip_path = dir.join("pack.zip");
        let story = aggregate_with_child_night_bridges_story_json();
        assert_eq!(super::story_studio_aggregation_wrapper_count(&story), 2);
        write_story_zip_with_assets(&zip_path, &story, &aggregate_night_bridge_assets());

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");

        assert!(
            !report.round_trip_faithful,
            "le verdict strict doit rester visible"
        );
        assert!(
            report.authoring_editable,
            "{} | fidelity={:?}",
            report.reason, report.fidelity
        );
        assert!(
            report.reason.contains("agrégat Story Studio"),
            "{}",
            report.reason
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn nested_aggregation_wrapper_count_tracks_selector_island() {
        let story = nested_aggregate_with_child_night_bridges_story_json();

        assert_eq!(super::story_studio_aggregation_wrapper_count(&story), 2);
    }

    fn fidelity_with_topology_gaps(gaps: Vec<&str>) -> super::FidelityReport {
        super::FidelityReport {
            faithful: false,
            generated_stage_count: 10,
            oracle_stage_count: 10,
            invalid_transition_count: 0,
            asset_presence_gap_count: 0,
            topology_gaps: gaps.iter().map(|gap| gap.to_string()).collect(),
            asset_presence_gaps: Vec::new(),
            gaps: gaps.iter().map(|gap| gap.to_string()).collect(),
        }
    }

    #[test]
    fn end_home_or_night_gap_is_authoring_tolerated() {
        let fidelity = fidelity_with_topology_gaps(vec![
            "nightModeAvailable : généré=false oracle=true",
            "transition généré=131 oracle=0 : TopologyShape { source: ControlShape { square_one: false, has_audio: true, has_image: false, wheel: false, ok: false, home: true, pause: true, autoplay: true }, kind: Home, state: Selected { option_index: 0, option_count: 1 } }",
            "transition généré=144 oracle=14 : TopologyShape { source: ControlShape { square_one: false, has_audio: true, has_image: false, wheel: false, ok: true, home: true, pause: false, autoplay: false }, kind: Ok, state: Selected { option_index: 0, option_count: 1 } }",
        ]);

        assert!(super::end_home_or_night_gap_is_tolerated(&fidelity));
    }

    #[test]
    fn end_home_or_night_gap_requires_equal_stage_counts() {
        let mut fidelity = fidelity_with_topology_gaps(vec![
            "transition généré=1 oracle=0 : TopologyShape { source: ControlShape { square_one: false, has_audio: true, has_image: false, wheel: false, ok: false, home: true, pause: true, autoplay: true }, kind: Home, state: Selected { option_index: 0, option_count: 1 } }",
        ]);
        fidelity.generated_stage_count = 9;

        assert!(!super::end_home_or_night_gap_is_tolerated(&fidelity));
    }

    #[test]
    fn aggregate_with_extra_unmodeled_gap_stays_read_only() {
        let dir = temp_dir("aggregate_extra_gap");
        let zip_path = dir.join("pack.zip");
        let mut story = aggregate_with_child_night_bridges_story_json();
        let stages = story["stageNodes"].as_array_mut().expect("stage nodes");
        for index in 0..3 {
            stages.push(serde_json::json!({
                "uuid": format!("orphan-{index}"),
                "name": format!("Orphelin {index}"),
                "type": "stage",
                "squareOne": false,
                "audio": "extra.mp3",
                "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": null
            }));
        }
        let mut assets = aggregate_night_bridge_assets();
        assets.push("extra.mp3");
        write_story_zip_with_assets(&zip_path, &story, &assets);

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");

        assert!(!report.round_trip_faithful);
        assert!(!report.authoring_editable);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    fn corrupt_branching_graph_story_json() -> serde_json::Value {
        // Graphe branchant interactif (dispatcher autoplay -> deux roues) dont une histoire
        // a une okTransition pendante vers un stage inexistant. C'est l'ancien declencheur
        // de `needs_native_graph_projection` (transition non resolue, cible absente, que
        // graph_import decline). Doit rester lisible en lecture seule, sans projecteur natif.
        serde_json::json!({
            "title": "Corrupt branching synthetic",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "root", "name": "Depart", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "dispatcher", "name": "Dispatcher", "type": "stage", "squareOne": false,
                    "audio": "dispatcher.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "dispatcher-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "branch-a", "name": "Choix A", "type": "stage", "squareOne": false,
                    "audio": "branch-a.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "branch-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "branch-b", "name": "Choix B", "type": "stage", "squareOne": false,
                    "audio": "branch-b.mp3", "image": null,
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "branch-b-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "play-a", "name": "Lecture A", "type": "stage", "squareOne": false,
                    "audio": "story.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": true, "pause": true, "autoplay": true },
                    "okTransition": { "actionNode": "play-a-action", "optionIndex": 0 },
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                },
                {
                    "uuid": "play-b", "name": "Lecture B", "type": "stage", "squareOne": false,
                    "audio": "extra.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": true },
                    "okTransition": null,
                    "homeTransition": { "actionNode": "home-action", "optionIndex": 0 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["dispatcher"] },
                { "id": "dispatcher-action", "name": "Dispatcher", "options": ["branch-a", "branch-b"] },
                { "id": "branch-a-action", "name": "A", "options": ["play-a"] },
                { "id": "branch-b-action", "name": "B", "options": ["play-b"] },
                { "id": "play-a-action", "name": "Suite A", "options": ["missing-ghost"] },
                { "id": "home-action", "name": "Home", "options": ["dispatcher"] }
            ]
        })
    }

    #[test]
    fn corrupt_branching_graph_with_dangling_transition_is_read_only_without_native_graph() {
        let dir = temp_dir("corrupt_branching_graph");
        let zip_path = dir.join("pack.zip");
        write_story_zip_with_assets(
            &zip_path,
            &corrupt_branching_graph_story_json(),
            &[
                "root.mp3",
                "cover.png",
                "dispatcher.mp3",
                "branch-a.mp3",
                "branch-b.mp3",
                "story.mp3",
                "extra.mp3",
            ],
        );

        // Aucun panic malgre la transition pendante.
        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(!report.authoring_editable);
        assert!(report.read_only_inspectable);
        assert!(
            !report.has_native_graph,
            "plus de projecteur natif lossy : nativeGraph doit rester absent"
        );

        let imported = unpack_zip_to_entries_unchecked(
            zip_path.to_str().expect("utf8"),
            dir.join("out").to_str().expect("utf8"),
        )
        .expect("unpack corrupt graph for read-only inspection");
        assert!(imported["nativeGraph"].is_null());
        assert!(!imported["entries"].as_array().expect("entries").is_empty());

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    #[ignore]
    fn plan16_graph_pack_from_env_is_read_only_without_native_graph() {
        let Some(zip_path) = std::env::var_os("STORY_STUDIO_PLAN16_GRAPH_PACK") else {
            eprintln!("[PLAN16] SKIP - definir STORY_STUDIO_PLAN16_GRAPH_PACK vers un ZIP graphe");
            return;
        };
        let zip_path = PathBuf::from(zip_path);
        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(
            report.round_trip_faithful,
            "diagnostic inattendu : {}",
            report.reason
        );
        assert!(!report.authoring_editable);
        assert!(report.read_only_inspectable);
        assert!(
            !report.has_native_graph,
            "le pack est encore passé par le parachute nativeGraph"
        );
    }

    #[test]
    fn projectable_but_unfaithful_pack_is_not_editable() {
        let dir = temp_dir("unfaithful");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        story["stageNodes"]
            .as_array_mut()
            .expect("stages")
            .push(serde_json::json!({
                "uuid": "unreachable", "name": "Inatteignable", "type": "stage", "squareOne": false,
                "audio": "extra.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": null
            }));
        write_story_zip(&zip_path, &story);

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(!report.authoring_editable);
        assert!(report.fidelity.as_ref().is_some_and(|f| !f.faithful));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn canonical_generation_failure_is_not_editable() {
        let dir = temp_dir("canonical_failure");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        story["stageNodes"][1]["audio"] = serde_json::Value::Null;
        story["stageNodes"][1]["image"] = serde_json::Value::Null;
        story["stageNodes"][2]["audio"] = serde_json::Value::Null;
        write_story_zip(&zip_path, &story);

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(!report.authoring_editable);
        assert!(
            report.reason.contains("échec de génération canonique")
                || report
                    .fidelity
                    .as_ref()
                    .is_some_and(|fidelity| !fidelity.faithful),
            "diagnostic inattendu : {}",
            report.reason,
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn referenced_but_missing_asset_is_not_editable() {
        let dir = temp_dir("missing_asset");
        let zip_path = dir.join("pack.zip");
        let raw = serde_json::to_vec(&editable_story_json()).expect("serialize story");
        write_zip(
            &zip_path,
            &[
                ("story.json", raw.as_slice()),
                ("assets/root.mp3", b"root"),
                ("assets/cover.png", b"cover"),
                ("assets/item.mp3", b"item"),
                ("assets/item.png", b"item-image"),
            ],
        );

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");

        assert!(!report.authoring_editable);
        assert!(
            report.reason.contains("assets/story.mp3"),
            "diagnostic inattendu : {}",
            report.reason,
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn public_unpack_refuses_unfaithful_pack() {
        let dir = temp_dir("unpack_refuses_unfaithful");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        story["stageNodes"]
            .as_array_mut()
            .expect("stages")
            .push(serde_json::json!({
                "uuid": "unreachable", "name": "Inatteignable", "type": "stage", "squareOne": false,
                "audio": "extra.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": null
            }));
        write_story_zip(&zip_path, &story);

        let error = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            dir.join("out").to_str().expect("utf8"),
        )
        .expect_err("public extraction must enforce editability");

        assert!(
            error.contains("Pack non éditable"),
            "diagnostic inattendu : {error}",
        );

        let forced = unpack_zip_to_entries_with_policy(
            zip_path.to_str().expect("utf8"),
            dir.join("forced-out").to_str().expect("utf8"),
            true,
        )
        .expect("explicit unsafe extraction should bypass editability only");
        assert!(forced["entries"].is_array());

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn non_pack_archive_errors() {
        let dir = temp_dir("invalid");
        let zip_path = dir.join("pack.zip");
        write_zip(&zip_path, &[("readme.txt", b"not a pack")]);

        assert!(check_pack_editability(zip_path.to_str().expect("utf8")).is_err());

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    #[ignore]
    fn suzanne_pack_from_env_stays_authoring_editable() {
        let Some(zip_path) = std::env::var_os("STORY_STUDIO_SUZANNE_PACK") else {
            eprintln!(
                "[SUZANNE] SKIP - definir STORY_STUDIO_SUZANNE_PACK vers le ZIP Suzanne et Gaston"
            );
            return;
        };
        let zip_path = PathBuf::from(zip_path);
        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(
            report.round_trip_faithful,
            "diagnostic inattendu : {}",
            report.reason
        );
        assert!(
            report.authoring_editable,
            "diagnostic inattendu : {}",
            report.reason
        );
        assert!(!report.read_only_inspectable);
        assert!(!report.uses_graph_projection);
        assert!(!report.root_ref_only);
        assert_eq!(report.shared_entry_count, 0);
        assert!(!report.has_unmodeled_wheel);
    }

    #[test]
    #[ignore]
    fn authoring_pack_from_env_is_editable() {
        let Some(zip_path) = std::env::var_os("STORY_STUDIO_AUTHORING_PACK") else {
            eprintln!("[AUTHORING] SKIP - definir STORY_STUDIO_AUTHORING_PACK vers le ZIP");
            return;
        };
        let zip_path = PathBuf::from(zip_path);
        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        eprintln!(
            "[AUTHORING] roundTripFaithful={} authoringEditable={} reason={}",
            report.round_trip_faithful, report.authoring_editable, report.reason
        );
        if let Some(fidelity) = report.fidelity.as_ref() {
            eprintln!(
                "[AUTHORING] fidelity stages={}/{} invalidTransitions={} assetGaps={} topologyGaps={}",
                fidelity.generated_stage_count,
                fidelity.oracle_stage_count,
                fidelity.invalid_transition_count,
                fidelity.asset_presence_gap_count,
                fidelity.topology_gaps.len()
            );
            if !report.authoring_editable {
                for gap in fidelity.topology_gaps.iter().take(8) {
                    eprintln!("[AUTHORING] gap {gap}");
                }
                for gap in fidelity
                    .topology_gaps
                    .iter()
                    .filter(|gap| !super::is_end_home_or_night_gap(gap))
                    .take(8)
                {
                    eprintln!("[AUTHORING] non-tolerated gap {gap}");
                }
            }
        }
        assert!(report.authoring_editable, "{}", report.reason);
        let unpack_dir = temp_dir("authoring_pack_from_env");
        let imported = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            unpack_dir.to_str().expect("utf8"),
        )
        .expect("unpack authoring pack");
        eprintln!(
            "[AUTHORING] unpack entries={}",
            imported
                .get("entries")
                .and_then(|value| value.as_array())
                .map_or(0, Vec::len)
        );
        fs::remove_dir_all(unpack_dir).expect("cleanup");
    }
}
