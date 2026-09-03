//! Audit de corpus 0.9.9, volontairement ignoré par défaut.
//!
//! Ce module observe le lecteur existant et écrit ses rapports dans le corpus
//! indiqué par `STORY_STUDIO_TRIAGE_ROOT`. Il ne déplace jamais de pack et ne
//! modifie aucune décision de production.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::domain::project::{AudioEdgeSilenceDuration, GlobalOptions, Project, ProjectEntry};
use crate::domain::validation::validate_project_structure_for_generation;
use crate::native_pack::{
    canonicalize_project, fidelity_judge::canonical_roundtrip_is_faithful, ActionNode, StageNode,
    StoryDocument,
};
use crate::services::pack_reader::{classify_pack_editability, load_pack_zip};
use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};

const REPORT_SCHEMA_VERSION: u32 = 1;
const REPORT_SCHEMA_VERSION_V2: u32 = 2;
const EXPECTED_READ_ONLY: usize = 136;
const EXPECTED_IMPORT_ERRORS: usize = 11;
const EXPANSION_LIMIT: u64 = 1_000_000;
const EXPANSION_REVIEW_LIMIT: u64 = 10_000;
const DEPTH_REVIEW_LIMIT: usize = 61;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialRecord {
    relative_path: String,
    size_bytes: u64,
    last_write_time_utc: i64,
    status: String,
    reason: String,
}

#[derive(Debug, Clone)]
struct CorpusPack {
    initial: InitialRecord,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EdgeDiagnostic {
    source_stage_id: String,
    source_stage_kind: String,
    trigger: String,
    action_node_id: Option<String>,
    declared_option_index: Option<i32>,
    candidate_target_ids: Vec<String>,
    effective_target_ids: Vec<String>,
    is_interactive_choice: bool,
    is_global_semantic: bool,
    resolution_status: String,
    witness: Option<String>,
}

#[derive(Debug, Clone)]
struct EffectiveEdge {
    source: String,
    target: String,
    action: String,
    option_index: i32,
    trigger: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphMetrics {
    stage_count: usize,
    action_count: usize,
    reachable_stage_count: usize,
    unreachable_stage_count: usize,
    effective_ok_edge_count: usize,
    choice_action_count: usize,
    indexed_router_action_count: usize,
    missing_action_count: usize,
    missing_target_count: usize,
    out_of_range_option_count: usize,
    convergent_target_count: usize,
    max_effective_indegree: usize,
    strongly_connected_component_count: usize,
    cyclic_stage_count: usize,
    self_loop_count: usize,
    max_dag_depth: Option<usize>,
    estimated_expanded_entry_count: u64,
    expansion_overflow: bool,
    home_edge_count: usize,
    night_bridge_count: usize,
    unreachable_helper_count: usize,
    edge_diagnostics: Vec<EdgeDiagnostic>,
    witness_paths: Vec<String>,
    cycle_witnesses: Vec<String>,
    unreachable_stage_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionMetrics {
    current_reason: String,
    round_trip_faithful: bool,
    projected_entry_count: usize,
    root_entry_count: usize,
    shared_entry_count: usize,
    projected_ref_count: usize,
    uses_graph_projection: bool,
    has_unmodeled_wheel: bool,
    structural_validation_error: Option<String>,
    generated_stage_count: usize,
    oracle_stage_count: usize,
    invalid_transition_count: usize,
    asset_presence_gap_count: usize,
    topology_gaps: Vec<String>,
    asset_presence_gaps: Vec<String>,
    graph_diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlyAudit {
    schema_version: u32,
    relative_path: String,
    size_bytes: u64,
    last_write_time_utc: i64,
    initial_status: String,
    current_status: String,
    triage_category: String,
    triage_confidence: String,
    triage_evidence: Vec<String>,
    reason: String,
    graph: GraphMetrics,
    projection: ProjectionMetrics,
    structural_signature: String,
    recommended_expert_action: String,
    duration_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildPackResult {
    name: String,
    size_bytes: u64,
    status: String,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportErrorAudit {
    schema_version: u32,
    relative_path: String,
    size_bytes: u64,
    sha256: String,
    initial_error: String,
    container_readable: bool,
    container_entry_count: usize,
    marker_counts: BTreeMap<String, usize>,
    nested_archive_count: usize,
    bt_length: Option<usize>,
    has_cleartext_marker: bool,
    seven_zip_test_result: Option<String>,
    child_pack_results: Vec<ChildPackResult>,
    triage_category: String,
    triage_confidence: String,
    triage_evidence: Vec<String>,
    recommended_expert_action: String,
    duration_ms: u128,
}

#[derive(Debug, Clone)]
struct TriagePlanRow {
    relative_path: String,
    source_state: String,
    category: String,
    confidence: String,
    structural_signature: String,
    source: PathBuf,
    destination: PathBuf,
    reason: String,
    move_eligible: bool,
}

#[derive(Debug, Clone)]
struct GraphAnalysis {
    metrics: GraphMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogicalEdgeDiagnostic {
    source_id: String,
    source_kind: String,
    runtime_source_stage_ids: Vec<String>,
    runtime_source_kinds: Vec<String>,
    trigger: String,
    target_id: Option<String>,
    target_kind: Option<String>,
    semantic_class: String,
    collapse_rule: String,
    resolution_status: String,
    witness: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogicalGraphMetrics {
    node_count: usize,
    reachable_node_count: usize,
    unreachable_node_count: usize,
    containment_edge_count: usize,
    reference_edge_count: usize,
    return_edge_count: usize,
    global_edge_count: usize,
    native_only_target_count: usize,
    missing_target_count: usize,
    duplicate_id_count: usize,
    convergent_target_count: usize,
    max_effective_indegree: usize,
    strongly_connected_component_count: usize,
    cyclic_node_count: usize,
    self_loop_count: usize,
    max_dag_depth: Option<usize>,
    estimated_expanded_entry_count: u64,
    expansion_overflow: bool,
    edge_diagnostics: Vec<LogicalEdgeDiagnostic>,
    cycle_witnesses: Vec<String>,
    unreachable_node_ids: Vec<String>,
}

type ProjectedIdOccurrence = (String, String, String, String, String);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlyAuditV2 {
    schema_version: u32,
    relative_path: String,
    size_bytes: u64,
    last_write_time_utc: i64,
    initial_status: String,
    current_status: String,
    structural_family: String,
    family_confidence: String,
    family_evidence: Vec<String>,
    reason: String,
    runtime_graph: GraphMetrics,
    logical_graph: LogicalGraphMetrics,
    projection: ProjectionMetrics,
    family_signature: String,
    recommended_expert_action: String,
    duration_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Color {
    White,
    Gray,
    Black,
}

fn env_path(name: &str, default: &Path) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| default.to_path_buf())
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("lecture impossible de {}: {error}", path.display()))?;
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| format!("JSONL invalide: {error}")))
        .collect()
}

fn source_pack_path(root: &Path, state: &str, relative_path: &str) -> PathBuf {
    let relative = Path::new(relative_path);
    let original = root.join(state).join("FR").join(relative);
    if original.is_file() {
        return original;
    }
    let triage_folders = match state {
        "02 - Lecture seule" => &[
            "01 - Candidat hierarchie simple",
            "02 - Candidat hierarchie avec limite",
            "03 - Defaut de projection ou validation",
            "04 - Hors perimetre hierarchique",
            "05 - Revue expert necessaire",
        ][..],
        "04 - Erreur import" => &[
            "01 - Bundle multi-pack supportable",
            "02 - Compression ZIP a adapter",
            "03 - Chiffrement ou variante inconnue",
            "04 - Archive cassee confirmee",
            "05 - Revue expert necessaire",
        ][..],
        _ => &[][..],
    };
    let matches = triage_folders
        .iter()
        .map(|folder| {
            root.join(state)
                .join("Triage")
                .join(folder)
                .join("FR")
                .join(relative)
        })
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [path] => path.clone(),
        [] => original,
        _ => panic!(
            "plusieurs sources de triage pour {state}/{relative_path}: {}",
            matches
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn initial_records(root: &Path, status: &str) -> Result<Vec<CorpusPack>, String> {
    let initial_report = env_path(
        "STORY_STUDIO_TRIAGE_INITIAL_REPORT",
        &root.join("classification-results.jsonl"),
    );
    let records: Vec<InitialRecord> = read_jsonl(&initial_report)?;
    let mut packs = records
        .into_iter()
        .filter(|record| record.status == status)
        .map(|initial| CorpusPack {
            path: source_pack_path(root, state_for_status(status), &initial.relative_path),
            initial,
        })
        .collect::<Vec<_>>();
    packs.sort_by(|left, right| left.initial.relative_path.cmp(&right.initial.relative_path));
    Ok(packs)
}

fn state_for_status(status: &str) -> &'static str {
    match status {
        "READ_ONLY" => "02 - Lecture seule",
        "IMPORT_ERROR" => "04 - Erreur import",
        other => panic!("état inattendu {other}"),
    }
}

fn file_metadata(pack: &CorpusPack) -> Result<(u64, i64), String> {
    let metadata = fs::metadata(&pack.path)
        .map_err(|error| format!("archive absente {}: {error}", pack.path.display()))?;
    if !metadata.is_file() {
        return Err(format!("source non régulière: {}", pack.path.display()));
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("date illisible {}: {error}", pack.path.display()))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("date invalide {}: {error}", pack.path.display()))?
        .as_millis() as i64;
    Ok((metadata.len(), modified))
}

fn relative_report_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn sanitize_error(error: &str) -> String {
    let mut result = error.replace('\\', "/");
    if let Ok(temp) = std::env::var("TEMP") {
        result = result.replace(&temp.replace('\\', "/"), "<temp>");
    }
    if let Ok(temp) = std::env::var("TMP") {
        result = result.replace(&temp.replace('\\', "/"), "<temp>");
    }
    result
}

fn write_jsonl<T: Serialize>(path: &Path, rows: &[T]) -> Result<(), String> {
    let mut file = File::create(path)
        .map_err(|error| format!("création impossible de {}: {error}", path.display()))?;
    for row in rows {
        serde_json::to_writer(&mut file, row).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn append_jsonl<T: Serialize>(file: &mut File, row: &T) -> Result<(), String> {
    serde_json::to_writer(&mut *file, row).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

fn open_partial_report(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("ouverture impossible de {}: {error}", path.display()))
}

fn partial_read_only_rows(
    path: &Path,
    packs: &[CorpusPack],
) -> Result<HashMap<String, ReadOnlyAudit>, String> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let expected = packs
        .iter()
        .map(|pack| (pack.initial.relative_path.as_str(), pack))
        .collect::<HashMap<_, _>>();
    let mut rows = HashMap::new();
    for row in read_jsonl::<ReadOnlyAudit>(path)? {
        let pack = expected.get(row.relative_path.as_str()).ok_or_else(|| {
            format!(
                "rapport partiel lecture seule: chemin inattendu {}",
                row.relative_path
            )
        })?;
        if row.size_bytes != pack.initial.size_bytes
            || row.last_write_time_utc != pack.initial.last_write_time_utc
        {
            return Err(format!(
                "rapport partiel lecture seule: métadonnées modifiées {}",
                row.relative_path
            ));
        }
        if rows.insert(row.relative_path.clone(), row).is_some() {
            return Err("rapport partiel lecture seule: chemin dupliqué".to_string());
        }
    }
    Ok(rows)
}

fn partial_read_only_rows_v2(
    path: &Path,
    packs: &[CorpusPack],
) -> Result<HashMap<String, ReadOnlyAuditV2>, String> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let expected = packs
        .iter()
        .map(|pack| (pack.initial.relative_path.as_str(), pack))
        .collect::<HashMap<_, _>>();
    let mut rows = HashMap::new();
    for row in read_jsonl::<ReadOnlyAuditV2>(path)? {
        if row.schema_version != REPORT_SCHEMA_VERSION_V2 {
            return Err(format!(
                "rapport v2: schéma {} inattendu pour {}",
                row.schema_version, row.relative_path
            ));
        }
        let pack = expected
            .get(row.relative_path.as_str())
            .ok_or_else(|| format!("rapport v2: chemin inattendu {}", row.relative_path))?;
        if row.size_bytes != pack.initial.size_bytes
            || row.last_write_time_utc != pack.initial.last_write_time_utc
        {
            return Err(format!("rapport v2: source modifiée {}", row.relative_path));
        }
        if rows.insert(row.relative_path.clone(), row).is_some() {
            return Err("rapport v2: chemin dupliqué".to_string());
        }
    }
    Ok(rows)
}

fn partial_import_error_rows(
    path: &Path,
    packs: &[CorpusPack],
) -> Result<HashMap<String, ImportErrorAudit>, String> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let expected = packs
        .iter()
        .map(|pack| (pack.initial.relative_path.as_str(), pack))
        .collect::<HashMap<_, _>>();
    let mut rows = HashMap::new();
    for row in read_jsonl::<ImportErrorAudit>(path)? {
        let pack = expected.get(row.relative_path.as_str()).ok_or_else(|| {
            format!(
                "rapport partiel erreurs import: chemin inattendu {}",
                row.relative_path
            )
        })?;
        if row.size_bytes != pack.initial.size_bytes {
            return Err(format!(
                "rapport partiel erreurs import: taille modifiée {}",
                row.relative_path
            ));
        }
        if rows.insert(row.relative_path.clone(), row).is_some() {
            return Err("rapport partiel erreurs import: chemin dupliqué".to_string());
        }
    }
    Ok(rows)
}

fn csv_escape(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn write_csv(path: &Path, headers: &[&str], rows: &[Vec<String>]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    file.write_all(
        format!(
            "{}\n",
            headers
                .iter()
                .map(|value| csv_escape(value))
                .collect::<Vec<_>>()
                .join(",")
        )
        .as_bytes(),
    )
    .map_err(|error| error.to_string())?;
    for row in rows {
        file.write_all(
            format!(
                "{}\n",
                row.iter()
                    .map(|value| csv_escape(value))
                    .collect::<Vec<_>>()
                    .join(",")
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    }
    file.flush().map_err(|error| error.to_string())?;
    Ok(())
}

fn temp_pack_dir(label: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "story_studio_triage_{}_{}_{}",
        label,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn action_map(document: &StoryDocument) -> HashMap<String, ActionNode> {
    document
        .action_nodes
        .iter()
        .cloned()
        .map(|action| (action.id.clone(), action))
        .collect()
}

fn stage_map(document: &StoryDocument) -> HashMap<String, StageNode> {
    document
        .stage_nodes
        .iter()
        .cloned()
        .map(|stage| (stage.uuid.clone(), stage))
        .collect()
}

fn stage_kind(stage: &StageNode) -> String {
    if stage.square_one {
        "squareOne".to_string()
    } else if stage.control_settings.autoplay {
        "play".to_string()
    } else if stage.control_settings.wheel {
        "choice".to_string()
    } else {
        stage.stage_type.clone()
    }
}

fn transition_data(stage: &StageNode, home: bool) -> Option<(&str, i32)> {
    let transition = if home {
        stage.home_transition.as_ref()
    } else {
        stage.ok_transition.as_ref()
    }?;
    Some((transition.action_node.as_str(), transition.option_index))
}

fn indexed_router_actions(
    document: &StoryDocument,
    stages: &HashMap<String, StageNode>,
) -> HashSet<String> {
    let actions = action_map(document);
    let mut indices: HashMap<&str, BTreeSet<i32>> = HashMap::new();
    for stage in &document.stage_nodes {
        if let Some((action, index)) = transition_data(stage, false) {
            indices.entry(action).or_default().insert(index.max(0));
        }
    }
    indices
        .into_iter()
        .filter_map(|(id, used_indices)| {
            let action = actions.get(id)?;
            let non_interactive = action.options.iter().all(|target| {
                stages
                    .get(target)
                    .is_some_and(|stage| !stage.control_settings.wheel)
            });
            (used_indices.len() > 1 && non_interactive).then_some(id.to_string())
        })
        .collect()
}

fn witness_step(edge: &EffectiveEdge) -> String {
    format!(
        " --{} /action {}[{}]--> {}",
        edge.trigger, edge.action, edge.option_index, edge.target
    )
}

fn analyze_graph(document: &StoryDocument) -> GraphAnalysis {
    let actions = action_map(document);
    let stages = stage_map(document);
    let routers = indexed_router_actions(document, &stages);
    let mut metrics = GraphMetrics {
        stage_count: stages.len(),
        action_count: actions.len(),
        indexed_router_action_count: routers.len(),
        ..GraphMetrics::default()
    };
    let mut effective_edges = Vec::new();
    let mut diagnostics = Vec::new();

    for stage in document
        .stage_nodes
        .iter()
        .filter(|stage| stage.ok_transition.is_some())
    {
        let Some((action_id, option_index)) = transition_data(stage, false) else {
            continue;
        };
        // `autoplay` décrit le déclencheur de la transition, pas une sémantique
        // globale. L'arête reste dans le graphe runtime ; seule la projection
        // authoring v2 peut ensuite reconnaître Home, fin, next_story ou night.
        let global_semantic = false;
        let Some(action) = actions.get(action_id) else {
            metrics.missing_action_count += 1;
            diagnostics.push(EdgeDiagnostic {
                source_stage_id: stage.uuid.clone(),
                source_stage_kind: stage_kind(stage),
                trigger: if stage.control_settings.autoplay {
                    "autoplay"
                } else {
                    "OK"
                }
                .to_string(),
                action_node_id: Some(action_id.to_string()),
                declared_option_index: Some(option_index),
                candidate_target_ids: Vec::new(),
                effective_target_ids: Vec::new(),
                is_interactive_choice: false,
                is_global_semantic: global_semantic,
                resolution_status: "ACTION_MISSING".to_string(),
                witness: None,
            });
            continue;
        };
        let candidates = action.options.clone();
        let valid_candidates: Vec<String> = candidates
            .iter()
            .filter(|target| stages.contains_key(*target))
            .cloned()
            .collect();
        metrics.missing_target_count += candidates.len().saturating_sub(valid_candidates.len());
        let interactive = !stage.control_settings.autoplay && !routers.contains(action_id);
        if interactive && valid_candidates.len() > 1 {
            metrics.choice_action_count += 1;
        }
        let (effective_targets, out_of_range) = if routers.contains(action_id) {
            let index = option_index.max(0) as usize;
            match candidates.get(index) {
                Some(target) if stages.contains_key(target) => (vec![target.clone()], false),
                Some(_) | None => (Vec::new(), true),
            }
        } else {
            (valid_candidates.clone(), false)
        };
        if out_of_range {
            metrics.out_of_range_option_count += 1;
        }
        let status = if out_of_range {
            "INDEX_OOB"
        } else if effective_targets.is_empty() {
            "TARGET_MISSING"
        } else {
            "RESOLVED"
        };
        diagnostics.push(EdgeDiagnostic {
            source_stage_id: stage.uuid.clone(),
            source_stage_kind: stage_kind(stage),
            trigger: if stage.control_settings.autoplay {
                "autoplay"
            } else {
                "OK"
            }
            .to_string(),
            action_node_id: Some(action_id.to_string()),
            declared_option_index: Some(option_index),
            candidate_target_ids: candidates,
            effective_target_ids: effective_targets.clone(),
            is_interactive_choice: interactive && effective_targets.len() > 1,
            is_global_semantic: global_semantic,
            resolution_status: status.to_string(),
            witness: None,
        });
        for target in effective_targets {
            effective_edges.push(EffectiveEdge {
                source: stage.uuid.clone(),
                target,
                action: action_id.to_string(),
                option_index,
                trigger: if stage.control_settings.autoplay {
                    "autoplay"
                } else if interactive && valid_candidates.len() > 1 {
                    "choice"
                } else {
                    "OK"
                }
                .to_string(),
            });
        }
    }

    for stage in &document.stage_nodes {
        if let Some((action_id, option_index)) = transition_data(stage, true) {
            metrics.home_edge_count += 1;
            let (targets, status) = match actions.get(action_id) {
                None => (Vec::new(), "ACTION_MISSING"),
                Some(action) => match action.options.get(option_index.max(0) as usize) {
                    None => (Vec::new(), "INDEX_OOB"),
                    Some(target) if stages.contains_key(target) => {
                        (vec![target.clone()], "RESOLVED")
                    }
                    Some(_) => (Vec::new(), "TARGET_MISSING"),
                },
            };
            diagnostics.push(EdgeDiagnostic {
                source_stage_id: stage.uuid.clone(),
                source_stage_kind: stage_kind(stage),
                trigger: "Home".to_string(),
                action_node_id: Some(action_id.to_string()),
                declared_option_index: Some(option_index),
                candidate_target_ids: actions
                    .get(action_id)
                    .map(|action| action.options.clone())
                    .unwrap_or_default(),
                effective_target_ids: targets,
                is_interactive_choice: false,
                is_global_semantic: true,
                resolution_status: status.to_string(),
                witness: None,
            });
        }
    }

    let mut adjacency: HashMap<String, Vec<usize>> = HashMap::new();
    let mut indegree: HashMap<String, usize> = HashMap::new();
    for (index, edge) in effective_edges.iter().enumerate() {
        adjacency
            .entry(edge.source.clone())
            .or_default()
            .push(index);
        *indegree.entry(edge.target.clone()).or_default() += 1;
    }
    let square_one = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .map(|stage| stage.uuid.clone());
    let mut reachable = HashSet::new();
    let mut witness_by_stage: HashMap<String, String> = HashMap::new();
    if let Some(root) = square_one.clone() {
        let mut queue = vec![root.clone()];
        reachable.insert(root.clone());
        witness_by_stage.insert(root, "squareOne".to_string());
        while let Some(source) = queue.pop() {
            for edge_index in adjacency.get(&source).into_iter().flatten() {
                let edge = &effective_edges[*edge_index];
                let step = format!("{}{}", witness_by_stage[&source], witness_step(edge));
                if reachable.insert(edge.target.clone()) {
                    witness_by_stage.insert(edge.target.clone(), step);
                    queue.push(edge.target.clone());
                }
            }
        }
    }
    metrics.reachable_stage_count = reachable.len();
    metrics.unreachable_stage_count = stages.len().saturating_sub(reachable.len());
    metrics.unreachable_stage_ids = stages
        .keys()
        .filter(|id| !reachable.contains(*id))
        .cloned()
        .collect();
    metrics.unreachable_stage_ids.sort();
    metrics.unreachable_helper_count = metrics
        .unreachable_stage_ids
        .iter()
        .filter(|id| adjacency.contains_key(*id) || stages[*id].home_transition.is_some())
        .count();
    metrics.effective_ok_edge_count = effective_edges
        .iter()
        .filter(|edge| reachable.contains(&edge.source) && reachable.contains(&edge.target))
        .count();
    let reachable_targets: Vec<String> = indegree
        .iter()
        .filter(|(target, _)| reachable.contains(*target))
        .map(|(target, _)| target.clone())
        .collect();
    metrics.convergent_target_count = reachable_targets
        .iter()
        .filter(|target| indegree.get(*target).copied().unwrap_or(0) > 1)
        .count();
    metrics.max_effective_indegree = reachable_targets
        .iter()
        .map(|target| indegree.get(target).copied().unwrap_or(0))
        .max()
        .unwrap_or(0);
    metrics.self_loop_count = effective_edges
        .iter()
        .filter(|edge| edge.source == edge.target && reachable.contains(&edge.source))
        .count();
    metrics.night_bridge_count = document
        .stage_nodes
        .iter()
        .filter(|stage| {
            let name = stage.name.to_ascii_lowercase();
            reachable.contains(&stage.uuid) && (name.contains("night") || name.contains("nuit"))
        })
        .count();

    let mut colors = stages
        .keys()
        .map(|id| (id.clone(), Color::White))
        .collect::<HashMap<_, _>>();
    let mut stack = Vec::new();
    let mut cycle_witnesses = Vec::new();
    let mut max_depth = 0;
    if let Some(root) = square_one.as_deref() {
        dfs_cycle_depth(
            root,
            &adjacency,
            &effective_edges,
            &reachable,
            &mut colors,
            &mut stack,
            &mut cycle_witnesses,
            &mut max_depth,
        );
    }
    metrics.cycle_witnesses = cycle_witnesses;
    metrics.cyclic_stage_count = metrics
        .cycle_witnesses
        .iter()
        .flat_map(|witness| witness.split(" -> "))
        .filter_map(|part| part.split_whitespace().next())
        .collect::<HashSet<_>>()
        .len();
    metrics.strongly_connected_component_count = cyclic_scc_count(&reachable, &effective_edges);
    let acyclic = metrics.strongly_connected_component_count == 0;
    metrics.max_dag_depth = acyclic.then_some(max_depth);
    if acyclic {
        let root_value = square_one
            .as_deref()
            .map(|root| {
                let mut overflow = false;
                expanded_count(
                    root,
                    &adjacency,
                    &effective_edges,
                    &mut HashMap::new(),
                    &mut overflow,
                )
            })
            .unwrap_or(0);
        metrics.estimated_expanded_entry_count = root_value.saturating_sub(1);
        metrics.expansion_overflow = root_value >= EXPANSION_LIMIT;
    } else {
        metrics.expansion_overflow = true;
    }
    metrics.witness_paths = witness_by_stage
        .iter()
        .filter(|(id, _)| {
            metrics
                .cycle_witnesses
                .iter()
                .any(|w| w.contains(id.as_str()))
                || metrics.unreachable_stage_count > 0
                    && id.as_str() != square_one.as_deref().unwrap_or("")
        })
        .map(|(_, witness)| witness.clone())
        .take(24)
        .collect();
    for diagnostic in &mut diagnostics {
        if let Some(witness) = witness_by_stage.get(&diagnostic.source_stage_id) {
            diagnostic.witness = Some(witness.clone());
        }
    }
    metrics.edge_diagnostics = diagnostics;

    GraphAnalysis { metrics }
}

#[allow(clippy::too_many_arguments)]
fn dfs_cycle_depth(
    stage_id: &str,
    adjacency: &HashMap<String, Vec<usize>>,
    edges: &[EffectiveEdge],
    reachable: &HashSet<String>,
    colors: &mut HashMap<String, Color>,
    stack: &mut Vec<String>,
    cycle_witnesses: &mut Vec<String>,
    max_depth: &mut usize,
) {
    colors.insert(stage_id.to_string(), Color::Gray);
    stack.push(stage_id.to_string());
    *max_depth = (*max_depth).max(stack.len().saturating_sub(1));
    for edge_index in adjacency.get(stage_id).into_iter().flatten() {
        let edge = &edges[*edge_index];
        if !reachable.contains(&edge.target) {
            continue;
        }
        match colors.get(&edge.target).copied().unwrap_or(Color::White) {
            Color::White => dfs_cycle_depth(
                &edge.target,
                adjacency,
                edges,
                reachable,
                colors,
                stack,
                cycle_witnesses,
                max_depth,
            ),
            Color::Gray => {
                if let Some(start) = stack.iter().position(|id| id == &edge.target) {
                    let mut cycle = stack[start..].to_vec();
                    cycle.push(edge.target.clone());
                    cycle_witnesses.push(cycle.join(" -> "));
                }
            }
            Color::Black => {}
        }
    }
    stack.pop();
    colors.insert(stage_id.to_string(), Color::Black);
}

fn expanded_count(
    stage_id: &str,
    adjacency: &HashMap<String, Vec<usize>>,
    edges: &[EffectiveEdge],
    memo: &mut HashMap<String, u64>,
    overflow: &mut bool,
) -> u64 {
    if let Some(value) = memo.get(stage_id) {
        return *value;
    }
    let mut total = 1_u64;
    for edge_index in adjacency.get(stage_id).into_iter().flatten() {
        let child = expanded_count(&edges[*edge_index].target, adjacency, edges, memo, overflow);
        total = total.saturating_add(child);
        if total >= EXPANSION_LIMIT {
            *overflow = true;
            total = EXPANSION_LIMIT;
            break;
        }
    }
    memo.insert(stage_id.to_string(), total);
    total
}

fn cyclic_scc_count(reachable: &HashSet<String>, edges: &[EffectiveEdge]) -> usize {
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
    for id in reachable {
        graph.entry(id.clone()).or_default();
        reverse.entry(id.clone()).or_default();
    }
    for edge in edges {
        if reachable.contains(&edge.source) && reachable.contains(&edge.target) {
            graph
                .entry(edge.source.clone())
                .or_default()
                .push(edge.target.clone());
            reverse
                .entry(edge.target.clone())
                .or_default()
                .push(edge.source.clone());
        }
    }
    let mut visited = HashSet::new();
    let mut order = Vec::new();
    for id in reachable {
        kosaraju_order(id, &graph, &mut visited, &mut order);
    }
    let mut visited = HashSet::new();
    let mut count = 0;
    for id in order.into_iter().rev() {
        if visited.contains(&id) {
            continue;
        }
        let mut component = Vec::new();
        kosaraju_collect(&id, &reverse, &mut visited, &mut component);
        if component.len() > 1 || graph.get(&id).is_some_and(|targets| targets.contains(&id)) {
            count += 1;
        }
    }
    count
}

fn kosaraju_order(
    id: &str,
    graph: &HashMap<String, Vec<String>>,
    visited: &mut HashSet<String>,
    order: &mut Vec<String>,
) {
    if !visited.insert(id.to_string()) {
        return;
    }
    for next in graph.get(id).into_iter().flatten() {
        kosaraju_order(next, graph, visited, order);
    }
    order.push(id.to_string());
}

fn kosaraju_collect(
    id: &str,
    graph: &HashMap<String, Vec<String>>,
    visited: &mut HashSet<String>,
    component: &mut Vec<String>,
) {
    if !visited.insert(id.to_string()) {
        return;
    }
    component.push(id.to_string());
    for next in graph.get(id).into_iter().flatten() {
        kosaraju_collect(next, graph, visited, component);
    }
}

fn count_projected_type(value: &Value, entry_type: &str) -> usize {
    let Some(entries) = value.as_array() else {
        return 0;
    };
    entries
        .iter()
        .map(|entry| {
            usize::from(entry.get("type").and_then(Value::as_str) == Some(entry_type))
                + count_projected_type(entry.get("children").unwrap_or(&Value::Null), entry_type)
        })
        .sum()
}

fn collect_projected_id_occurrences(
    entries: &Value,
    path: &str,
    occurrences: &mut BTreeMap<String, Vec<ProjectedIdOccurrence>>,
) {
    let Some(entries) = entries.as_array() else {
        return;
    };
    for (index, entry) in entries.iter().enumerate() {
        let entry_type = entry.get("type").and_then(Value::as_str).unwrap_or("?");
        let entry_id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        let entry_path = format!("{path}/{index}:{entry_type}");
        if !entry_id.is_empty() {
            let mut hasher = Sha256::new();
            hasher.update(serde_json::to_vec(entry).expect("projection json"));
            let source_step = entry
                .get("_importedContinuation")
                .and_then(|value| value.get("sourceStepName"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let summary = format!(
                "type={entry_type},native={},children={},name={}",
                entry
                    .get("nativeStageId")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                entry
                    .get("children")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0),
                entry.get("name").and_then(Value::as_str).unwrap_or("")
            );
            occurrences.entry(entry_id.to_string()).or_default().push((
                entry_path.clone(),
                format!("{:x}", hasher.finalize()),
                source_step,
                entry_type.to_string(),
                summary,
            ));
        }
        collect_projected_id_occurrences(
            entry.get("children").unwrap_or(&Value::Null),
            &entry_path,
            occurrences,
        );
    }
}

fn collect_projected_navigation_references(
    value: &Value,
    path: &str,
    references: &mut Vec<(String, String, String)>,
) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = format!("{path}/{key}");
                let is_target = matches!(
                    key.as_str(),
                    "target"
                        | "okTarget"
                        | "homeTarget"
                        | "returnAfterPlay"
                        | "returnOnHome"
                        | "titleReturnOnHome"
                        | "afterPlaybackPromptOkTarget"
                        | "afterPlaybackPromptHomeTarget"
                        | "targetId"
                        | "effectiveTargetId"
                );
                if is_target {
                    if let Some(target) = child.as_str() {
                        references.push((child_path.clone(), key.clone(), target.to_string()));
                    }
                } else if key == "okChoiceTargets" {
                    if let Some(targets) = child.as_array() {
                        for (index, target) in targets.iter().enumerate() {
                            if let Some(target) = target.as_str() {
                                references.push((
                                    format!("{child_path}/{index}"),
                                    key.clone(),
                                    target.to_string(),
                                ));
                            }
                        }
                    }
                }
                collect_projected_navigation_references(child, &child_path, references);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_projected_navigation_references(
                    child,
                    &format!("{path}/{index}"),
                    references,
                );
            }
        }
        _ => {}
    }
}

fn projection_for_pack(
    raw_document: &Value,
    classification: &crate::services::pack_reader::PackEditabilityReport,
) -> Result<(ProjectionMetrics, Value), String> {
    // La classification de production a déjà vérifié les assets et effectué
    // l'extraction contrôlée. Ici on rejoue uniquement la projection pure avec
    // des chemins fictifs, afin de mesurer sa sortie sans décompresser le pack
    // une seconde fois ni conserver de média dans l'audit.
    let mut assets = HashMap::new();
    if let Some(stages) = raw_document.get("stageNodes").and_then(Value::as_array) {
        for stage in stages {
            for key in ["audio", "image"] {
                if let Some(name) = stage.get(key).and_then(Value::as_str) {
                    assets.insert(name.to_string(), PathBuf::from(name));
                }
            }
        }
    }
    let imported = super::super::projection::walk_story_doc_to_entries(raw_document, &assets)?;
    let entries = imported.get("entries").unwrap_or(&Value::Null);
    let shared = imported.get("sharedEntries").unwrap_or(&Value::Null);
    let fidelity = classification.fidelity.as_ref();
    let current_reason = classification.reason.clone();
    let structural_validation_error = current_reason
        .contains("incompatible")
        .then_some(current_reason.clone());
    let metrics = ProjectionMetrics {
        current_reason,
        round_trip_faithful: classification.round_trip_faithful,
        projected_entry_count: classification.projected_entry_count,
        root_entry_count: classification.root_entry_count,
        shared_entry_count: classification.shared_entry_count,
        projected_ref_count: count_projected_type(entries, "ref")
            + count_projected_type(shared, "ref"),
        uses_graph_projection: imported
            .get("usesGraphProjection")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        has_unmodeled_wheel: classification.has_unmodeled_wheel,
        structural_validation_error,
        generated_stage_count: fidelity
            .map(|report| report.generated_stage_count)
            .unwrap_or(0),
        oracle_stage_count: fidelity
            .map(|report| report.oracle_stage_count)
            .unwrap_or(0),
        invalid_transition_count: fidelity
            .map(|report| report.invalid_transition_count)
            .unwrap_or(0),
        asset_presence_gap_count: fidelity
            .map(|report| report.asset_presence_gap_count)
            .unwrap_or(0),
        topology_gaps: fidelity
            .map(|report| report.topology_gaps.clone())
            .unwrap_or_default(),
        asset_presence_gaps: fidelity
            .map(|report| report.asset_presence_gaps.clone())
            .unwrap_or_default(),
        graph_diagnostics: imported
            .get("graphDiagnostics")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    };
    Ok((metrics, imported))
}

#[derive(Debug, Clone)]
struct PendingLogicalEdge {
    source: String,
    source_kind: String,
    trigger: String,
    raw_target: String,
    semantic_class: String,
}

fn navigation_target_id(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || matches!(trimmed, "root" | "current_menu" | "next_story") {
        return None;
    }
    Some(trimmed.split_once(':').map(|(_, id)| id).unwrap_or(trimmed))
}

fn global_navigation_class(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "root" => Some("root"),
        "current_menu" => Some("current_menu"),
        "next_story" => Some("next_story"),
        _ => None,
    }
}

fn collect_logical_entries(
    entries: &Value,
    parent_id: Option<&str>,
    nodes: &mut HashMap<String, String>,
    aliases: &mut HashMap<String, String>,
    runtime_sources: &mut HashMap<String, Vec<String>>,
    pending_edges: &mut Vec<PendingLogicalEdge>,
    duplicate_ids: &mut HashSet<String>,
) {
    let Some(entries) = entries.as_array() else {
        return;
    };
    for entry in entries {
        let entry_type = entry
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let entry_id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        if entry_type == "ref" {
            if let (Some(parent), Some(target)) =
                (parent_id, entry.get("target").and_then(Value::as_str))
            {
                pending_edges.push(PendingLogicalEdge {
                    source: parent.to_string(),
                    source_kind: nodes
                        .get(parent)
                        .cloned()
                        .unwrap_or_else(|| "unknown".to_string()),
                    trigger: "ref".to_string(),
                    raw_target: target.to_string(),
                    semantic_class: "reference".to_string(),
                });
            }
            continue;
        }
        if entry_id.is_empty() {
            continue;
        }
        if nodes
            .insert(entry_id.to_string(), entry_type.to_string())
            .is_some()
        {
            duplicate_ids.insert(entry_id.to_string());
        }
        for field in ["nativeStageId", "_playStageId"] {
            if let Some(alias) = entry.get(field).and_then(Value::as_str) {
                aliases.insert(alias.to_string(), entry_id.to_string());
                runtime_sources
                    .entry(entry_id.to_string())
                    .or_default()
                    .push(alias.to_string());
            }
        }
        if let Some(parent) = parent_id {
            pending_edges.push(PendingLogicalEdge {
                source: parent.to_string(),
                source_kind: nodes
                    .get(parent)
                    .cloned()
                    .unwrap_or_else(|| "root".to_string()),
                trigger: "child".to_string(),
                raw_target: entry_id.to_string(),
                semantic_class: "containment".to_string(),
            });
        }
        if let Some(target) = entry.get("returnAfterPlay").and_then(Value::as_str) {
            pending_edges.push(PendingLogicalEdge {
                source: entry_id.to_string(),
                source_kind: entry_type.to_string(),
                trigger: "returnAfterPlay".to_string(),
                raw_target: target.to_string(),
                semantic_class: global_navigation_class(target)
                    .unwrap_or("return_after_play")
                    .to_string(),
            });
        }
        for field in ["returnOnHome", "titleReturnOnHome"] {
            if let Some(target) = entry.get(field).and_then(Value::as_str) {
                pending_edges.push(PendingLogicalEdge {
                    source: entry_id.to_string(),
                    source_kind: entry_type.to_string(),
                    trigger: field.to_string(),
                    raw_target: target.to_string(),
                    semantic_class: global_navigation_class(target)
                        .unwrap_or("home")
                        .to_string(),
                });
            }
        }
        collect_logical_entries(
            entry.get("children").unwrap_or(&Value::Null),
            Some(entry_id),
            nodes,
            aliases,
            runtime_sources,
            pending_edges,
            duplicate_ids,
        );
    }
}

fn analyze_logical_projection(
    imported: &Value,
    runtime_root_stage_id: Option<&str>,
    runtime_stage_kinds: &HashMap<String, String>,
) -> LogicalGraphMetrics {
    const ROOT: &str = "__authoring_root__";
    let mut nodes = HashMap::from([(ROOT.to_string(), "root".to_string())]);
    let mut aliases = HashMap::new();
    let mut runtime_sources = HashMap::new();
    if let Some(runtime_root_stage_id) = runtime_root_stage_id {
        runtime_sources.insert(ROOT.to_string(), vec![runtime_root_stage_id.to_string()]);
    }
    let mut pending_edges = Vec::new();
    let mut duplicate_ids = HashSet::new();
    collect_logical_entries(
        imported.get("entries").unwrap_or(&Value::Null),
        Some(ROOT),
        &mut nodes,
        &mut aliases,
        &mut runtime_sources,
        &mut pending_edges,
        &mut duplicate_ids,
    );
    collect_logical_entries(
        imported.get("sharedEntries").unwrap_or(&Value::Null),
        None,
        &mut nodes,
        &mut aliases,
        &mut runtime_sources,
        &mut pending_edges,
        &mut duplicate_ids,
    );

    let mut metrics = LogicalGraphMetrics {
        node_count: nodes.len().saturating_sub(1),
        duplicate_id_count: duplicate_ids.len(),
        ..LogicalGraphMetrics::default()
    };
    let mut effective_edges = Vec::new();
    for pending in pending_edges {
        let raw_target_id = navigation_target_id(&pending.raw_target);
        let targets_runtime_root = raw_target_id
            .zip(runtime_root_stage_id)
            .is_some_and(|(target, root)| target == root);
        let is_global = targets_runtime_root
            || matches!(
                pending.semantic_class.as_str(),
                "root" | "current_menu" | "next_story" | "home"
            );
        let target_id = raw_target_id.map(|target| {
            aliases
                .get(target)
                .cloned()
                .unwrap_or_else(|| target.to_string())
        });
        let resolution_status = if is_global {
            metrics.global_edge_count += 1;
            "GLOBAL"
        } else if target_id
            .as_ref()
            .is_some_and(|target| nodes.contains_key(target))
        {
            match pending.semantic_class.as_str() {
                "containment" => metrics.containment_edge_count += 1,
                "reference" => metrics.reference_edge_count += 1,
                "return_after_play" => metrics.return_edge_count += 1,
                _ => {}
            }
            let target = target_id.as_ref().expect("resolved target").clone();
            effective_edges.push(EffectiveEdge {
                source: pending.source.clone(),
                target,
                action: pending.semantic_class.clone(),
                option_index: 0,
                trigger: pending.trigger.clone(),
            });
            "RESOLVED"
        } else if target_id
            .as_ref()
            .is_some_and(|target| runtime_stage_kinds.contains_key(target))
        {
            metrics.native_only_target_count += 1;
            "NATIVE_ONLY"
        } else {
            metrics.missing_target_count += 1;
            "TARGET_MISSING"
        };
        let runtime_source_stage_ids = runtime_sources
            .get(&pending.source)
            .cloned()
            .unwrap_or_default();
        let runtime_source_kinds = runtime_source_stage_ids
            .iter()
            .filter_map(|stage_id| runtime_stage_kinds.get(stage_id).cloned())
            .collect::<Vec<_>>();
        let collapse_rule = if pending.source == ROOT {
            "square_one"
        } else if runtime_source_stage_ids.len() > 1 {
            "title_play"
        } else if runtime_source_stage_ids.len() == 1 {
            "direct"
        } else {
            "authoring_structure"
        };
        metrics.edge_diagnostics.push(LogicalEdgeDiagnostic {
            source_id: pending.source,
            source_kind: pending.source_kind,
            runtime_source_stage_ids,
            runtime_source_kinds,
            trigger: pending.trigger,
            target_kind: target_id
                .as_ref()
                .and_then(|target| {
                    nodes
                        .get(target)
                        .or_else(|| runtime_stage_kinds.get(target))
                })
                .cloned(),
            target_id,
            semantic_class: pending.semantic_class,
            collapse_rule: collapse_rule.to_string(),
            resolution_status: resolution_status.to_string(),
            witness: None,
        });
    }

    let mut adjacency: HashMap<String, Vec<usize>> = HashMap::new();
    let mut indegree: HashMap<String, usize> = HashMap::new();
    for (index, edge) in effective_edges.iter().enumerate() {
        adjacency
            .entry(edge.source.clone())
            .or_default()
            .push(index);
        *indegree.entry(edge.target.clone()).or_default() += 1;
    }
    let mut reachable = HashSet::from([ROOT.to_string()]);
    let mut witness_by_node = HashMap::from([(ROOT.to_string(), "authoringRoot".to_string())]);
    let mut queue = vec![ROOT.to_string()];
    while let Some(source) = queue.pop() {
        for edge_index in adjacency.get(&source).into_iter().flatten() {
            let edge = &effective_edges[*edge_index];
            let step = format!("{}{}", witness_by_node[&source], witness_step(edge));
            if reachable.insert(edge.target.clone()) {
                witness_by_node.insert(edge.target.clone(), step);
                queue.push(edge.target.clone());
            }
        }
    }
    metrics.reachable_node_count = reachable.len().saturating_sub(1);
    metrics.unreachable_node_ids = nodes
        .keys()
        .filter(|id| id.as_str() != ROOT && !reachable.contains(*id))
        .cloned()
        .collect();
    metrics.unreachable_node_ids.sort();
    metrics.unreachable_node_count = metrics.unreachable_node_ids.len();
    let reachable_targets = indegree
        .iter()
        .filter(|(target, _)| reachable.contains(*target))
        .collect::<Vec<_>>();
    metrics.convergent_target_count = reachable_targets
        .iter()
        .filter(|(_, count)| **count > 1)
        .count();
    metrics.max_effective_indegree = reachable_targets
        .iter()
        .map(|(_, count)| **count)
        .max()
        .unwrap_or(0);
    metrics.self_loop_count = effective_edges
        .iter()
        .filter(|edge| edge.source == edge.target && reachable.contains(&edge.source))
        .count();

    let mut colors = nodes
        .keys()
        .map(|id| (id.clone(), Color::White))
        .collect::<HashMap<_, _>>();
    let mut stack = Vec::new();
    let mut max_depth = 0;
    dfs_cycle_depth(
        ROOT,
        &adjacency,
        &effective_edges,
        &reachable,
        &mut colors,
        &mut stack,
        &mut metrics.cycle_witnesses,
        &mut max_depth,
    );
    metrics.cyclic_node_count = metrics
        .cycle_witnesses
        .iter()
        .flat_map(|witness| witness.split(" -> "))
        .collect::<HashSet<_>>()
        .len();
    metrics.strongly_connected_component_count = cyclic_scc_count(&reachable, &effective_edges);
    let acyclic = metrics.strongly_connected_component_count == 0;
    metrics.max_dag_depth = acyclic.then_some(max_depth.saturating_sub(1));
    if acyclic {
        let mut overflow = false;
        let expanded = expanded_count(
            ROOT,
            &adjacency,
            &effective_edges,
            &mut HashMap::new(),
            &mut overflow,
        );
        metrics.estimated_expanded_entry_count = expanded.saturating_sub(1);
        metrics.expansion_overflow = overflow || expanded >= EXPANSION_LIMIT;
    } else {
        metrics.expansion_overflow = true;
    }
    for diagnostic in &mut metrics.edge_diagnostics {
        diagnostic.witness = witness_by_node.get(&diagnostic.source_id).cloned();
    }
    metrics
}

fn category_for_read_only(
    graph: &GraphMetrics,
    projection: &ProjectionMetrics,
) -> (String, String, Vec<String>, String) {
    let mut evidence = Vec::new();
    if graph.strongly_connected_component_count > 0 || graph.self_loop_count > 0 {
        evidence.push(format!(
            "cycle atteignable: {} SCC cyclique, {} stage(s) cyclique(s)",
            graph.strongly_connected_component_count, graph.cyclic_stage_count
        ));
        return (
            "OUT_OF_SCOPE_NON_HIERARCHICAL".to_string(),
            "HIGH".to_string(),
            evidence,
            "Transmettre le trajet de cycle et les arêtes orientées pour confirmer la limite d'un arbre fini.".to_string(),
        );
    }
    if graph.missing_action_count > 0
        || graph.missing_target_count > 0
        || graph.out_of_range_option_count > 0
    {
        evidence.push(format!(
            "résolution incomplète: actions={}, cibles={}, indices={}",
            graph.missing_action_count, graph.missing_target_count, graph.out_of_range_option_count
        ));
        return (
            "PROJECTION_OR_DATA_DEFECT".to_string(),
            "HIGH".to_string(),
            evidence,
            "Reproduire le défaut de données ou de projection avec la table des arêtes avant toute correction.".to_string(),
        );
    }
    if projection.projected_entry_count == 0 {
        evidence.push("aucune entrée authoring projetée".to_string());
        return (
            "PROJECTION_OR_DATA_DEFECT".to_string(),
            "MEDIUM".to_string(),
            evidence,
            "Vérifier si la collection vide vient du story.json source ou de la projection."
                .to_string(),
        );
    }
    if projection.current_reason.contains("absent") || projection.asset_presence_gap_count > 0 {
        evidence.push(format!(
            "écart asset: {}",
            projection.asset_presence_gap_count
        ));
        return (
            "PROJECTION_OR_DATA_DEFECT".to_string(),
            "HIGH".to_string(),
            evidence,
            "Corriger ou relier la donnée manquante après confirmation de sa présence dans le source.".to_string(),
        );
    }
    if graph.max_dag_depth.unwrap_or(0) > DEPTH_REVIEW_LIMIT
        || graph.expansion_overflow
        || graph.estimated_expanded_entry_count > EXPANSION_REVIEW_LIMIT
    {
        evidence.push(format!(
            "coût arbre estimé: profondeur={:?}, entrées={}, overflow={}",
            graph.max_dag_depth, graph.estimated_expanded_entry_count, graph.expansion_overflow
        ));
        return (
            "HIERARCHY_LIMIT_CANDIDATE".to_string(),
            "HIGH".to_string(),
            evidence,
            "Mesurer la profondeur et le coût de duplication, puis décider d'une limite sans l'augmenter dans ce chantier.".to_string(),
        );
    }
    if graph.convergent_target_count > 0 {
        evidence.push(format!(
            "convergence acyclique: {} cible(s), expansion par duplication={}",
            graph.convergent_target_count, graph.estimated_expanded_entry_count
        ));
    }
    if graph.indexed_router_action_count > 0 {
        evidence.push(format!(
            "routeurs indexés résolus: {}",
            graph.indexed_router_action_count
        ));
    }
    if graph.night_bridge_count > 0 {
        evidence.push(format!(
            "stage(s) de pont nuit repéré(s): {}",
            graph.night_bridge_count
        ));
    }
    if projection.shared_entry_count > 0 {
        evidence.push(format!(
            "éléments partagés projetés: {}",
            projection.shared_entry_count
        ));
    }
    if !projection.round_trip_faithful {
        evidence.push("génération canonique non fidèle selon le juge".to_string());
    }
    if projection.has_unmodeled_wheel {
        evidence.push("roue/carrousel natif signalé par le classifieur".to_string());
    }
    (
        "HIERARCHY_SIMPLE_CANDIDATE".to_string(),
        "HIGH".to_string(),
        evidence,
        "Tester la projection par duplication hiérarchique sur ce représentant, sans lien ni pool partagé.".to_string(),
    )
}

fn size_bucket(value: usize) -> &'static str {
    match value {
        0..=25 => "tiny",
        26..=100 => "small",
        101..=500 => "medium",
        501..=2_000 => "large",
        2_001..=10_000 => "very_large",
        _ => "extreme",
    }
}

fn explicit_data_defect_reason(reason: &str) -> bool {
    let reason = reason.to_lowercase();
    [
        "image manquant",
        "audio manquant",
        "collection vide",
        "destination de navigation",
        "identifiant duplique",
        "identifiant dupliqué",
    ]
    .iter()
    .any(|needle| reason.contains(needle))
}

fn fidelity_gap_kind(gap: &str) -> &'static str {
    let normalized = gap.to_lowercase();
    if normalized.starts_with("présence asset") || normalized.starts_with("presence asset") {
        "asset_presence"
    } else if normalized.starts_with("transition") {
        "transition"
    } else if normalized.starts_with("stage") {
        "stage_shape"
    } else if normalized.contains("asset") {
        "asset"
    } else {
        "other"
    }
}

fn family_for_v2(
    runtime: &GraphMetrics,
    logical: &LogicalGraphMetrics,
    projection: &ProjectionMetrics,
) -> (String, String, Vec<String>, String) {
    let mut evidence = vec![format!(
        "runtime atteignable={}/{}; logique atteignable={}/{}",
        runtime.reachable_stage_count,
        runtime.stage_count,
        logical.reachable_node_count,
        logical.node_count
    )];
    if logical.duplicate_id_count > 0 || logical.missing_target_count > 0 {
        evidence.push(format!(
            "projection logique invalide: doublons={}, cibles manquantes={}",
            logical.duplicate_id_count, logical.missing_target_count
        ));
        return (
            "PROJECTION_DEFECT".to_string(),
            "HIGH".to_string(),
            evidence,
            "Distinguer le défaut du story.json source de celui introduit par la projection."
                .to_string(),
        );
    }
    if runtime.missing_action_count > 0
        || runtime.missing_target_count > 0
        || runtime.out_of_range_option_count > 0
    {
        evidence.push(format!(
            "runtime non résolu: actions={}, cibles={}, indices={}",
            runtime.missing_action_count,
            runtime.missing_target_count,
            runtime.out_of_range_option_count
        ));
        return (
            "SOURCE_OR_PROJECTION_DEFECT".to_string(),
            "HIGH".to_string(),
            evidence,
            "Reproduire la transition non résolue et localiser son origine avant toute correction."
                .to_string(),
        );
    }
    if projection.projected_entry_count == 0
        || explicit_data_defect_reason(&projection.current_reason)
    {
        evidence.push(format!(
            "donnée/projection: entrées={}, écarts asset={}",
            projection.projected_entry_count, projection.asset_presence_gap_count
        ));
        return (
            "SOURCE_OR_PROJECTION_DEFECT".to_string(),
            "HIGH".to_string(),
            evidence,
            "Comparer les données obligatoires du source et la projection sur un représentant."
                .to_string(),
        );
    }
    if logical.native_only_target_count > 0 {
        evidence.push(format!(
            "retours vers stages natifs non projetés={}",
            logical.native_only_target_count
        ));
        return (
            "NATIVE_RETURN_BRIDGE_REVIEW".to_string(),
            "MEDIUM".to_string(),
            evidence,
            "Vérifier sur un représentant si le stage natif non projeté correspond à un retour technique reconnu, puis formaliser cette sémantique dans la projection logique."
                .to_string(),
        );
    }
    if logical.strongly_connected_component_count > 0 || logical.self_loop_count > 0 {
        evidence.push(format!(
            "cycle logique: SCC={}, nœuds={}, retours={}, refs={}",
            logical.strongly_connected_component_count,
            logical.cyclic_node_count,
            logical.return_edge_count,
            logical.reference_edge_count
        ));
        let family = if logical.return_edge_count > 0 {
            "RETURN_CYCLE_REVIEW"
        } else {
            "BUSINESS_CYCLE"
        };
        return (
            family.to_string(),
            "HIGH".to_string(),
            evidence,
            "Examiner le trajet orienté du plus petit représentant et décider si le retour correspond à une sémantique authoring reconnue."
                .to_string(),
        );
    }
    if logical.max_dag_depth.unwrap_or(0) > DEPTH_REVIEW_LIMIT
        || logical.expansion_overflow
        || logical.estimated_expanded_entry_count > EXPANSION_REVIEW_LIMIT
        || projection.projected_entry_count > EXPANSION_REVIEW_LIMIT as usize
    {
        evidence.push(format!(
            "DAG coûteux: profondeur={:?}, expansion={}, projection={}",
            logical.max_dag_depth,
            logical.estimated_expanded_entry_count,
            projection.projected_entry_count
        ));
        return (
            "ACYCLIC_EXPANSION_LIMIT".to_string(),
            "HIGH".to_string(),
            evidence,
            "Mesurer le coût d'édition avant de décider une limite produit.".to_string(),
        );
    }
    if logical.reference_edge_count > 0 || projection.shared_entry_count > 0 {
        evidence.push(format!(
            "DAG partagé: refs={}, pool={}, convergence={}, inatteignables={}, expansion={}",
            logical.reference_edge_count,
            projection.shared_entry_count,
            logical.convergent_target_count,
            logical.unreachable_node_count,
            logical.estimated_expanded_entry_count
        ));
        return (
            "ACYCLIC_SHARED_DAG".to_string(),
            "HIGH".to_string(),
            evidence,
            "Prouver la duplication hiérarchique sur le plus petit représentant sans pool partagé."
                .to_string(),
        );
    }
    if logical.convergent_target_count > 0 {
        evidence.push(format!(
            "DAG convergent: cibles={}, expansion={}",
            logical.convergent_target_count, logical.estimated_expanded_entry_count
        ));
        return (
            "ACYCLIC_CONVERGENT_DAG".to_string(),
            "HIGH".to_string(),
            evidence,
            "Prouver que chaque convergence finie est duplicable sans changer les retours."
                .to_string(),
        );
    }
    if projection.has_unmodeled_wheel {
        evidence.push("roue finie non modélisée signalée par le classifieur".to_string());
        return (
            "FINITE_WHEEL".to_string(),
            "MEDIUM".to_string(),
            evidence,
            "Comparer la forme runtime à un Menu/Histoire sur le représentant minimal.".to_string(),
        );
    }
    evidence.push(format!(
        "arbre logique fini: profondeur={:?}, expansion={}",
        logical.max_dag_depth, logical.estimated_expanded_entry_count
    ));
    (
        "ACYCLIC_TREE".to_string(),
        "HIGH".to_string(),
        evidence,
        "Vérifier pourquoi le juge ou la validation refuse encore cet arbre.".to_string(),
    )
}

fn family_signature_v2(
    family: &str,
    logical: &LogicalGraphMetrics,
    projection: &ProjectionMetrics,
) -> String {
    let normalized = json!({
        "family": family,
        "sizeBucket": size_bucket(logical.node_count),
        "expansionBucket": size_bucket(logical.estimated_expanded_entry_count as usize),
        "hasContainment": logical.containment_edge_count > 0,
        "hasReferences": logical.reference_edge_count > 0,
        "hasReturns": logical.return_edge_count > 0,
        "hasGlobals": logical.global_edge_count > 0,
        "hasNativeOnlyTargets": logical.native_only_target_count > 0,
        "hasUnreachableNodes": logical.unreachable_node_count > 0,
        "hasConvergence": logical.convergent_target_count > 0,
        "hasCycle": logical.strongly_connected_component_count > 0,
        "hasSelfLoop": logical.self_loop_count > 0,
        "overflow": logical.expansion_overflow,
        "wheel": projection.has_unmodeled_wheel,
        "faithful": projection.round_trip_faithful,
        "gapKinds": projection.topology_gaps.iter()
            .chain(projection.asset_presence_gaps.iter())
            .map(|gap| fidelity_gap_kind(gap))
            .collect::<BTreeSet<_>>(),
        "validationKind": projection.structural_validation_error.as_ref()
            .map(|value| value.split(':').next().unwrap_or(value)),
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&normalized).expect("family signature json"));
    format!("sha256:{:x}", hasher.finalize())
}

fn audit_read_only_pack_v2(pack: &CorpusPack) -> ReadOnlyAuditV2 {
    let started = Instant::now();
    let (size, modified) = file_metadata(pack).expect("v2: métadonnées");
    assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
    assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
    let story_json =
        load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("v2: story.json lisible");
    let raw_document: Value = serde_json::from_str(&story_json).expect("v2: story.json valide");
    let document: StoryDocument =
        serde_json::from_value(raw_document.clone()).expect("v2: StoryDocument valide");
    let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
        .expect("v2: classification");
    let runtime = analyze_graph(&document).metrics;
    let (projection, imported) =
        projection_for_pack(&raw_document, &classification).expect("v2: projection");
    let runtime_root_stage_id = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .map(|stage| stage.uuid.as_str());
    let runtime_stage_kinds = document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
        .collect::<HashMap<_, _>>();
    let logical =
        analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);
    let (family, confidence, evidence, expert_action) =
        family_for_v2(&runtime, &logical, &projection);
    let signature = family_signature_v2(&family, &logical, &projection);
    ReadOnlyAuditV2 {
        schema_version: REPORT_SCHEMA_VERSION_V2,
        relative_path: pack.initial.relative_path.clone(),
        size_bytes: size,
        last_write_time_utc: modified,
        initial_status: pack.initial.status.clone(),
        current_status: if classification.read_only_inspectable {
            "READ_ONLY"
        } else if classification.authoring_editable {
            "EDITABLE"
        } else {
            "UNSUPPORTED"
        }
        .to_string(),
        structural_family: family,
        family_confidence: confidence,
        family_evidence: evidence,
        reason: sanitize_error(&pack.initial.reason),
        runtime_graph: runtime,
        logical_graph: logical,
        projection,
        family_signature: signature,
        recommended_expert_action: expert_action,
        duration_ms: started.elapsed().as_millis(),
    }
}

fn structural_signature(
    category: &str,
    graph: &GraphMetrics,
    projection: &ProjectionMetrics,
) -> String {
    let normalized = json!({
        "category": category,
        "stages": graph.stage_count,
        "actions": graph.action_count,
        "edges": graph.effective_ok_edge_count,
        "choices": graph.choice_action_count,
        "routers": graph.indexed_router_action_count,
        "indegree": graph.max_effective_indegree,
        "convergence": graph.convergent_target_count,
        "scc": graph.strongly_connected_component_count,
        "cyclicStages": graph.cyclic_stage_count,
        "selfLoops": graph.self_loop_count,
        "depth": graph.max_dag_depth,
        "expanded": graph.estimated_expanded_entry_count,
        "overflow": graph.expansion_overflow,
        "wheel": projection.has_unmodeled_wheel,
        "shared": projection.shared_entry_count,
        "refs": projection.projected_ref_count,
        "graphProjection": projection.uses_graph_projection,
        "fidelityGaps": projection.topology_gaps.iter().map(|gap| gap.split(':').next().unwrap_or(gap)).collect::<Vec<_>>(),
        "validation": projection.structural_validation_error.as_ref().map(|value| value.split(':').next().unwrap_or(value)),
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&normalized).expect("signature json"));
    format!("sha256:{:x}", hasher.finalize())
}

fn audit_read_only_pack(pack: &CorpusPack) -> ReadOnlyAudit {
    let started = Instant::now();
    let (size, modified) = file_metadata(pack).expect("lecture seule: métadonnées");
    assert_eq!(
        size, pack.initial.size_bytes,
        "taille modifiée: {}",
        pack.initial.relative_path
    );
    assert_eq!(
        modified, pack.initial.last_write_time_utc,
        "date modifiée: {}",
        pack.initial.relative_path
    );
    let story_json =
        load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json lisible");
    let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
    let document: StoryDocument =
        serde_json::from_value(raw_document.clone()).expect("StoryDocument valide");
    let classification =
        classify_pack_editability(pack.path.to_string_lossy().as_ref()).expect("classification");
    let graph = analyze_graph(&document);
    let (projection, _) =
        projection_for_pack(&raw_document, &classification).expect("projection d'audit");
    let (category, confidence, evidence, expert_action) =
        category_for_read_only(&graph.metrics, &projection);
    let signature = structural_signature(&category, &graph.metrics, &projection);
    ReadOnlyAudit {
        schema_version: REPORT_SCHEMA_VERSION,
        relative_path: pack.initial.relative_path.clone(),
        size_bytes: size,
        last_write_time_utc: modified,
        initial_status: pack.initial.status.clone(),
        current_status: if classification.read_only_inspectable {
            "READ_ONLY"
        } else if classification.authoring_editable {
            "EDITABLE"
        } else {
            "UNSUPPORTED"
        }
        .to_string(),
        triage_category: category,
        triage_confidence: confidence,
        triage_evidence: evidence,
        reason: sanitize_error(&pack.initial.reason),
        graph: GraphMetrics {
            edge_diagnostics: graph.metrics.edge_diagnostics.clone(),
            ..graph.metrics
        },
        projection,
        structural_signature: signature,
        recommended_expert_action: expert_action,
        duration_ms: started.elapsed().as_millis(),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn marker_name(name: &str) -> Option<&'static str> {
    let normalized = name.replace('\\', "/");
    let leaf = normalized.rsplit('/').next().unwrap_or(&normalized);
    match leaf {
        "ni" => Some("ni"),
        "ri" => Some("ri"),
        "si" => Some("si"),
        "li" => Some("li"),
        "bt" => Some("bt"),
        ".cleartext" => Some(".cleartext"),
        "uuid.bin" => Some("uuid.bin"),
        "story.json" => Some("story.json"),
        _ => None,
    }
}

fn seven_zip_test(path: &Path) -> Option<String> {
    let default = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tools")
        .join("7z.exe");
    let executable = env_path("STORY_STUDIO_7Z_PATH", &default);
    if !executable.is_file() {
        return Some("UNAVAILABLE".to_string());
    }
    let result = Command::new(executable)
        .arg("t")
        .arg("--")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Some(match result {
        Ok(status) if status.success() => "PASS".to_string(),
        Ok(_) => "FAIL".to_string(),
        Err(_) => "ERROR".to_string(),
    })
}

fn child_packs(path: &Path, entries: &mut ZipArchive<File>, temp: &Path) -> Vec<ChildPackResult> {
    let mut children = Vec::new();
    for index in 0..entries.len() {
        let Ok(mut entry) = entries.by_index(index) else {
            continue;
        };
        let name = entry.name().replace('\\', "/");
        if !name.to_ascii_lowercase().ends_with(".zip") || entry.is_dir() {
            continue;
        }
        let child_name = Path::new(&name)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("child.zip");
        let child_path = temp.join(format!("{}-{}", index, child_name));
        let Ok(mut file) = File::create(&child_path) else {
            children.push(ChildPackResult {
                name: name.clone(),
                size_bytes: entry.size(),
                status: "ERROR".to_string(),
                reason: Some("fichier temporaire enfant impossible".to_string()),
            });
            continue;
        };
        let copy_result = std::io::copy(&mut entry, &mut file);
        let result = if copy_result.is_err() {
            ChildPackResult {
                name: name.clone(),
                size_bytes: entry.size(),
                status: "ERROR".to_string(),
                reason: Some("extraction temporaire enfant impossible".to_string()),
            }
        } else {
            match classify_pack_editability(child_path.to_string_lossy().as_ref()) {
                Ok(report) => ChildPackResult {
                    name: name.clone(),
                    size_bytes: entry.size(),
                    status: if report.authoring_editable {
                        "EDITABLE"
                    } else if report.read_only_inspectable {
                        "READ_ONLY"
                    } else {
                        "UNSUPPORTED"
                    }
                    .to_string(),
                    reason: Some(sanitize_error(&report.reason)),
                },
                Err(error) => ChildPackResult {
                    name: name.clone(),
                    size_bytes: entry.size(),
                    status: "IMPORT_ERROR".to_string(),
                    reason: Some(sanitize_error(&error)),
                },
            }
        };
        children.push(result);
    }
    let _ = path;
    children
}

fn audit_import_error_pack(pack: &CorpusPack) -> ImportErrorAudit {
    let started = Instant::now();
    let (size, modified) = file_metadata(pack).expect("erreur import: métadonnées");
    assert_eq!(
        size, pack.initial.size_bytes,
        "taille modifiée: {}",
        pack.initial.relative_path
    );
    assert_eq!(
        modified, pack.initial.last_write_time_utc,
        "date modifiée: {}",
        pack.initial.relative_path
    );
    let sha256 = sha256_file(&pack.path).expect("sha256");
    let temp = temp_pack_dir("children").expect("temp enfants");
    let mut marker_counts = BTreeMap::new();
    let mut nested_archive_count = 0;
    let mut bt_length = None;
    let mut has_cleartext_marker = false;
    let mut container_readable = false;
    let mut container_entry_count = 0;
    let mut children = Vec::new();
    if let Ok(file) = File::open(&pack.path) {
        if let Ok(mut archive) = ZipArchive::new(file) {
            container_readable = true;
            container_entry_count = archive.len();
            assert!(
                container_entry_count <= ARCHIVE_MAX_ENTRIES,
                "limite entrées archive"
            );
            for index in 0..archive.len() {
                let entry = archive.by_index(index).expect("entrée ZIP");
                let name = entry.name().replace('\\', "/");
                if let Some(marker) = marker_name(&name) {
                    *marker_counts.entry(marker.to_string()).or_insert(0) += 1;
                    if marker == "bt" {
                        bt_length = Some(entry.size() as usize);
                    }
                    if marker == ".cleartext" {
                        has_cleartext_marker = true;
                    }
                }
                if name.to_ascii_lowercase().ends_with(".zip") {
                    nested_archive_count += 1;
                }
                assert!(entry.size() <= ARCHIVE_MAX_FILE_BYTES, "entrée trop grande");
            }
            if nested_archive_count > 0 {
                children = child_packs(&pack.path, &mut archive, &temp);
            }
        }
    }
    let is_lzma = pack.initial.reason.contains("LzmaError");
    let seven_zip_result = is_lzma.then(|| seven_zip_test(&pack.path)).flatten();
    let all_children_recognized = !children.is_empty()
        && children
            .iter()
            .all(|child| matches!(child.status.as_str(), "EDITABLE" | "READ_ONLY"));
    let (category, confidence, mut evidence, expert_action) = if !children.is_empty() {
        if all_children_recognized {
            (
                "BUNDLE_IMPORT_CANDIDATE",
                "HIGH",
                vec![format!("{} archives enfants reconnues", children.len())],
                "Évaluer un conteneur de sélection/import multiple sans agréger leur navigation."
                    .to_string(),
            )
        } else {
            ("BUNDLE_MIXED_REVIEW", "HIGH", vec![format!("{} archives enfants, au moins une invalide ou non reconnue", children.len())], "Faire examiner les enfants individuellement avant toute prise en charge du conteneur.".to_string())
        }
    } else if is_lzma {
        match seven_zip_result.as_deref() {
            Some("PASS") => (
                "ZIP_COMPRESSION_FALLBACK_CANDIDATE",
                "HIGH",
                vec!["7-Zip valide l'archive malgré l'échec LZMA du lecteur".to_string()],
                "Évaluer un fallback de lecture ZIP contrôlé, sans recomprimer la source."
                    .to_string(),
            ),
            Some("FAIL") => (
                "BROKEN_ARCHIVE_CONFIRMED",
                "HIGH",
                vec!["7-Zip confirme l'échec de l'archive".to_string()],
                "Conserver comme archive cassée confirmée; aucun correctif de graphe.".to_string(),
            ),
            _ => (
                "NEEDS_EXPERT_REVIEW",
                "LOW",
                vec![
                    "les outils de validation se contredisent ou 7-Zip est indisponible"
                        .to_string(),
                ],
                "Faire valider l'état de l'archive avec un second outil.".to_string(),
            ),
        }
    } else if bt_length.is_some()
        && marker_counts.contains_key("ni")
        && marker_counts.contains_key("ri")
        && marker_counts.contains_key("si")
        && marker_counts.contains_key("li")
    {
        ("UNKNOWN_ENCRYPTION_VARIANT", "MEDIUM", vec![format!("markers filesystem ni/ri/si/li; btLength={:?}; cleartext={}", bt_length, has_cleartext_marker)], "Identifier le format public et l'information externe manquante; ne rechercher aucune clé privée.".to_string())
    } else if !container_readable {
        (
            "BROKEN_ARCHIVE_CONFIRMED",
            "HIGH",
            vec!["table centrale ZIP illisible".to_string()],
            "Conserver comme archive cassée confirmée.".to_string(),
        )
    } else {
        (
            "NEEDS_EXPERT_REVIEW",
            "LOW",
            vec!["aucune famille automatique sûre".to_string()],
            "Faire examiner les marqueurs structurels sans extraire de secret.".to_string(),
        )
    };
    evidence.push(format!(
        "entrées={}, archives imbriquées={}, btLength={:?}",
        container_entry_count, nested_archive_count, bt_length
    ));
    let _ = fs::remove_dir_all(temp);
    let _ = modified;
    ImportErrorAudit {
        schema_version: REPORT_SCHEMA_VERSION,
        relative_path: pack.initial.relative_path.clone(),
        size_bytes: size,
        sha256,
        initial_error: sanitize_error(&pack.initial.reason),
        container_readable,
        container_entry_count,
        marker_counts,
        nested_archive_count,
        bt_length,
        has_cleartext_marker,
        seven_zip_test_result: seven_zip_result,
        child_pack_results: children,
        triage_category: category.to_string(),
        triage_confidence: confidence.to_string(),
        triage_evidence: evidence,
        recommended_expert_action: expert_action,
        duration_ms: started.elapsed().as_millis(),
    }
}

fn triage_root(root: &Path) -> PathBuf {
    root.join("Triage avance")
}

fn audit_root_rows(
    root: &Path,
    rows: &[ReadOnlyAudit],
    errors: &[ImportErrorAudit],
) -> Result<(), String> {
    let dir = triage_root(root);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    write_jsonl(
        &env_path(
            "STORY_STUDIO_TRIAGE_READ_ONLY_REPORT",
            &dir.join("read-only-audit.jsonl"),
        ),
        rows,
    )?;
    write_jsonl(
        &env_path(
            "STORY_STUDIO_TRIAGE_IMPORT_ERROR_REPORT",
            &dir.join("import-error-audit.jsonl"),
        ),
        errors,
    )?;
    let read_csv = rows
        .iter()
        .map(|row| {
            vec![
                row.relative_path.clone(),
                row.triage_category.clone(),
                row.triage_confidence.clone(),
                row.structural_signature.clone(),
                row.graph.stage_count.to_string(),
                row.graph.action_count.to_string(),
                row.graph.reachable_stage_count.to_string(),
                row.graph.effective_ok_edge_count.to_string(),
                row.graph.convergent_target_count.to_string(),
                row.graph.strongly_connected_component_count.to_string(),
                row.graph.cyclic_stage_count.to_string(),
                row.graph
                    .max_dag_depth
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                row.graph.estimated_expanded_entry_count.to_string(),
                row.graph.expansion_overflow.to_string(),
                row.projection.projected_entry_count.to_string(),
                row.projection.shared_entry_count.to_string(),
                row.projection.projected_ref_count.to_string(),
                row.projection.round_trip_faithful.to_string(),
                row.reason.clone(),
                row.recommended_expert_action.clone(),
            ]
        })
        .collect::<Vec<_>>();
    write_csv(
        &dir.join("read-only-audit.csv"),
        &[
            "relativePath",
            "triageCategory",
            "triageConfidence",
            "structuralSignature",
            "stageCount",
            "actionCount",
            "reachableStageCount",
            "effectiveOkEdgeCount",
            "convergentTargetCount",
            "stronglyConnectedComponentCount",
            "cyclicStageCount",
            "maxDagDepth",
            "estimatedExpandedEntryCount",
            "expansionOverflow",
            "projectedEntryCount",
            "sharedEntryCount",
            "projectedRefCount",
            "roundTripFaithful",
            "reason",
            "recommendedExpertAction",
        ],
        &read_csv,
    )?;
    let error_csv = errors
        .iter()
        .map(|row| {
            vec![
                row.relative_path.clone(),
                row.triage_category.clone(),
                row.triage_confidence.clone(),
                row.sha256.clone(),
                row.container_readable.to_string(),
                row.container_entry_count.to_string(),
                row.nested_archive_count.to_string(),
                row.bt_length.map(|v| v.to_string()).unwrap_or_default(),
                row.has_cleartext_marker.to_string(),
                row.seven_zip_test_result.clone().unwrap_or_default(),
                row.child_pack_results.len().to_string(),
                row.initial_error.clone(),
                row.recommended_expert_action.clone(),
            ]
        })
        .collect::<Vec<_>>();
    write_csv(
        &dir.join("import-error-audit.csv"),
        &[
            "relativePath",
            "triageCategory",
            "triageConfidence",
            "sha256",
            "containerReadable",
            "containerEntryCount",
            "nestedArchiveCount",
            "btLength",
            "hasCleartextMarker",
            "sevenZipTestResult",
            "childPackCount",
            "initialError",
            "recommendedExpertAction",
        ],
        &error_csv,
    )?;
    Ok(())
}

fn plan_rows(
    root: &Path,
    rows: &[ReadOnlyAudit],
    errors: &[ImportErrorAudit],
) -> Vec<TriagePlanRow> {
    let mut result = Vec::new();
    for row in rows {
        result.push(plan_row(
            root,
            "02 - Lecture seule",
            &row.relative_path,
            &row.triage_category,
            &row.triage_confidence,
            &row.structural_signature,
            &row.reason,
            true,
        ));
    }
    for row in errors {
        result.push(plan_row(
            root,
            "04 - Erreur import",
            &row.relative_path,
            &row.triage_category,
            &row.triage_confidence,
            &row.sha256,
            &row.initial_error,
            true,
        ));
    }
    result.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    result
}

#[allow(clippy::too_many_arguments)]
fn plan_row(
    root: &Path,
    source_state: &str,
    relative_path: &str,
    category: &str,
    confidence: &str,
    signature: &str,
    reason: &str,
    move_eligible: bool,
) -> TriagePlanRow {
    let folder = match category {
        "HIERARCHY_SIMPLE_CANDIDATE" => "01 - Candidat hierarchie simple",
        "HIERARCHY_LIMIT_CANDIDATE" => "02 - Candidat hierarchie avec limite",
        "PROJECTION_OR_DATA_DEFECT" => "03 - Defaut de projection ou validation",
        "OUT_OF_SCOPE_NON_HIERARCHICAL" => "04 - Hors perimetre hierarchique",
        "BUNDLE_IMPORT_CANDIDATE" => "01 - Bundle multi-pack supportable",
        "ZIP_COMPRESSION_FALLBACK_CANDIDATE" => "02 - Compression ZIP a adapter",
        "UNKNOWN_ENCRYPTION_VARIANT" | "DEVICE_KEY_REQUIRED" | "KNOWN_FORMAT_READER_CANDIDATE" => {
            "03 - Chiffrement ou variante inconnue"
        }
        "BROKEN_ARCHIVE_CONFIRMED" => "04 - Archive cassee confirmee",
        _ => "05 - Revue expert necessaire",
    };
    let family = match source_state {
        "02 - Lecture seule" => format!("02 - Lecture seule/Triage/{folder}"),
        "04 - Erreur import" => format!("04 - Erreur import/Triage/{folder}"),
        _ => format!("Triage avance/{folder}"),
    };
    let source = source_pack_path(root, source_state, relative_path);
    let destination = root.join(family).join("FR").join(relative_path);
    TriagePlanRow {
        relative_path: relative_path.to_string(),
        source_state: source_state.to_string(),
        category: category.to_string(),
        confidence: confidence.to_string(),
        structural_signature: signature.to_string(),
        source,
        destination,
        reason: reason.to_string(),
        move_eligible,
    }
}

fn write_move_plan(root: &Path, rows: &[TriagePlanRow]) -> Result<(), String> {
    let path = triage_root(root).join("triage-move-plan.csv");
    let values = rows
        .iter()
        .map(|row| {
            vec![
                relative_report_path(root, &row.source),
                row.source_state.clone(),
                row.category.clone(),
                row.confidence.clone(),
                relative_report_path(root, &row.destination),
                row.structural_signature.clone(),
                row.move_eligible.to_string(),
                row.reason.clone(),
            ]
        })
        .collect::<Vec<_>>();
    write_csv(
        &path,
        &[
            "relativeSource",
            "sourceState",
            "triageCategory",
            "triageConfidence",
            "relativeDestination",
            "structuralSignature",
            "moveEligible",
            "reason",
        ],
        &values,
    )
}

fn expert_selection(root: &Path, rows: &[TriagePlanRow]) -> Vec<Vec<String>> {
    let mut grouped: BTreeMap<(String, String), Vec<&TriagePlanRow>> = BTreeMap::new();
    for row in rows
        .iter()
        .filter(|row| row.move_eligible && row.category != "BROKEN_ARCHIVE_CONFIRMED")
    {
        grouped
            .entry((row.category.clone(), row.structural_signature.clone()))
            .or_default()
            .push(row);
    }
    let mut selected = Vec::new();
    for ((category, signature), mut candidates) in grouped {
        candidates.sort_by_key(|row| {
            (
                fs::metadata(&row.source)
                    .map(|m| m.len())
                    .unwrap_or(u64::MAX),
                row.relative_path.clone(),
            )
        });
        let smallest_size = fs::metadata(&candidates[0].source)
            .map(|metadata| metadata.len())
            .unwrap_or(u64::MAX);
        let second_is_materially_larger = candidates.get(1).is_some_and(|candidate| {
            fs::metadata(&candidate.source)
                .map(|metadata| metadata.len() >= smallest_size.saturating_mul(2))
                .unwrap_or(false)
        });
        let selected_count = if second_is_materially_larger { 2 } else { 1 };
        for (index, row) in candidates.into_iter().take(selected_count).enumerate() {
            selected.push(vec![
                (index + 1).to_string(),
                relative_report_path(root, &row.destination),
                row.source_state.clone(),
                category.clone(),
                signature.clone(),
                selected_count.to_string(),
                if index == 0 {
                    "plus petit représentant de la signature".to_string()
                } else {
                    "second représentant avec compteurs plus élevés".to_string()
                },
                "services/pack_reader ou format d'import selon catégorie".to_string(),
                "Quelle correction commune couvre cette signature sans lien ni clé privée ?"
                    .to_string(),
            ]);
        }
    }
    selected.sort_by(|a, b| a[0].cmp(&b[0]).then(a[1].cmp(&b[1])));
    selected
}

fn write_report(
    root: &Path,
    rows: &[ReadOnlyAudit],
    errors: &[ImportErrorAudit],
    plans: &[TriagePlanRow],
) -> Result<(), String> {
    let dir = triage_root(root);
    let mut signatures = HashSet::new();
    for row in rows {
        signatures.insert(row.structural_signature.clone());
    }
    for row in errors {
        signatures.insert(format!("{}:{}", row.triage_category, row.sha256));
    }
    let simple = rows
        .iter()
        .filter(|row| row.triage_category == "HIERARCHY_SIMPLE_CANDIDATE")
        .count();
    let limit = rows
        .iter()
        .filter(|row| row.triage_category == "HIERARCHY_LIMIT_CANDIDATE")
        .count();
    let defect = rows
        .iter()
        .filter(|row| row.triage_category == "PROJECTION_OR_DATA_DEFECT")
        .count();
    let cycles = rows
        .iter()
        .filter(|row| row.triage_category == "OUT_OF_SCOPE_NON_HIERARCHICAL")
        .count();
    let bundles = errors
        .iter()
        .filter(|row| row.triage_category == "BUNDLE_IMPORT_CANDIDATE")
        .count();
    let lzma = errors
        .iter()
        .filter(|row| row.seven_zip_test_result.is_some())
        .collect::<Vec<_>>();
    let encrypted = errors
        .iter()
        .filter(|row| row.bt_length.is_some() && row.nested_archive_count == 0)
        .count();
    let expert = expert_selection(root, plans);
    write_csv(
        &dir.join("expert-selection.csv"),
        &[
            "priority",
            "relativePath",
            "sourceState",
            "triageCategory",
            "structuralSignature",
            "representativeOfCount",
            "whySelected",
            "expectedCodeArea",
            "blockingQuestion",
        ],
        &expert,
    )?;
    write_csv(
        &dir.join("triage-move-log.csv"),
        &[
            "timestampUtc",
            "relativeSource",
            "sourceState",
            "triageCategory",
            "relativeDestination",
            "moveStatus",
            "error",
        ],
        &[],
    )?;
    let mut report = String::new();
    report.push_str("# Rapport de triage avancé 0.9.9\n\n");
    report.push_str("- Baseline: 230 éditables, 136 lecture seule, 0 non supportés, 11 erreurs d'import, 0 à vérifier.\n");
    report.push_str("- Commit testé: `a3ce2574f091fbd4d6978f665b74d21d4b862663`.\n");
    report.push_str(&format!(
        "- Packs audités: {} lecture seule + {} erreurs d'import.\n",
        rows.len(),
        errors.len()
    ));
    report.push_str(&format!(
        "- Signatures structurelles: {}.\n",
        signatures.len()
    ));
    report.push_str(&format!("- Candidats hiérarchiques simples: {} ; avec limite: {} ; défauts projection/données: {} ; graphes cycliques hors périmètre: {}.\n", simple, limit, defect, cycles));
    report.push_str(&format!(
        "- Bundles multi-pack: {} ; ZIP LZMA: {} ; variantes avec `bt`: {}.\n",
        bundles,
        lzma.len(),
        encrypted
    ));
    report.push_str("\n## Décisions\n\n");
    report.push_str("Les candidats hiérarchiques sont des arbres finis à dérouler par duplication. Les cycles atteignables sont séparés avec leurs trajets orientés; aucun lien, `ref` ou pool partagé n'est proposé comme solution.\n\n");
    report.push_str("Les erreurs de conteneur, l'échec LZMA, les variantes chiffrées et les archives cassées sont traités indépendamment de l'authoring. Les rapports ne contiennent ni octets média, ni clé, ni contenu privé de métadonnées.\n\n");
    report.push_str("## Représentants experts\n\n");
    for row in expert.iter().take(20) {
        report.push_str(&format!("- `{}` — `{}` — {}\n", row[1], row[3], row[6]));
    }
    report.push_str("\n## Questions ouvertes\n\n- Quelle forme de duplication hiérarchique couvre chaque signature candidate sans modifier la sémantique enfant ?\n- Les trois bundles doivent-ils devenir une sélection d'enfants reconnue plutôt qu'un import agrégé ?\n- Le ZIP LZMA validé par 7-Zip nécessite-t-il un fallback local contrôlé ?\n- Le format filesystem avec `bt` est-il documenté sans clé d'appareil dans le cas étudié ?\n\n");
    report.push_str("## Fichiers\n\n");
    for name in [
        "read-only-audit.jsonl",
        "read-only-audit.csv",
        "import-error-audit.jsonl",
        "import-error-audit.csv",
        "triage-move-plan.csv",
        "triage-move-log.csv",
        "expert-selection.csv",
    ] {
        report.push_str(&format!("- `{name}`\n"));
    }
    report.push_str("\n## Contrôles\n\n- Le déplacement physique est effectué séparément en PowerShell après contrôle du plan; ce harnais ne déplace aucun fichier.\n- Tests synthétiques du graphe et contrôles de reprise déterministes exécutés par les tests Rust ignorés.\n");
    fs::write(dir.join("triage-report.md"), report).map_err(|error| error.to_string())?;
    Ok(())
}

fn select_experts_v2(rows: &[ReadOnlyAuditV2]) -> Vec<&ReadOnlyAuditV2> {
    let mut by_family: BTreeMap<&str, Vec<&ReadOnlyAuditV2>> = BTreeMap::new();
    for row in rows {
        by_family
            .entry(row.structural_family.as_str())
            .or_default()
            .push(row);
    }
    let mut selected = Vec::new();
    for candidates in by_family.values_mut() {
        candidates.sort_by_key(|row| (row.size_bytes, row.relative_path.as_str()));
        let smallest = candidates[0];
        selected.push(smallest);
        let stress = candidates.iter().copied().max_by_key(|row| {
            (
                row.logical_graph.node_count,
                row.projection.projected_entry_count,
                row.size_bytes,
            )
        });
        if let Some(stress) = stress {
            let materially_different = size_bucket(stress.logical_graph.node_count)
                != size_bucket(smallest.logical_graph.node_count)
                || size_bucket(stress.projection.projected_entry_count)
                    != size_bucket(smallest.projection.projected_entry_count);
            if materially_different && stress.relative_path != smallest.relative_path {
                selected.push(stress);
            }
        }
    }
    selected.sort_by(|left, right| {
        left.structural_family
            .cmp(&right.structural_family)
            .then(left.size_bytes.cmp(&right.size_bytes))
            .then(left.relative_path.cmp(&right.relative_path))
    });
    selected
}

fn write_v2_artifacts(dir: &Path, rows: &[ReadOnlyAuditV2]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    write_jsonl(&dir.join("read-only-audit-v2.jsonl"), rows)?;
    let csv_rows = rows
        .iter()
        .map(|row| {
            vec![
                row.relative_path.clone(),
                row.structural_family.clone(),
                row.family_confidence.clone(),
                row.family_signature.clone(),
                row.runtime_graph.stage_count.to_string(),
                row.runtime_graph.reachable_stage_count.to_string(),
                row.runtime_graph
                    .strongly_connected_component_count
                    .to_string(),
                row.logical_graph.node_count.to_string(),
                row.logical_graph.reachable_node_count.to_string(),
                row.logical_graph.reference_edge_count.to_string(),
                row.logical_graph.return_edge_count.to_string(),
                row.logical_graph.native_only_target_count.to_string(),
                row.logical_graph.missing_target_count.to_string(),
                row.logical_graph.unreachable_node_count.to_string(),
                row.logical_graph.convergent_target_count.to_string(),
                row.logical_graph
                    .strongly_connected_component_count
                    .to_string(),
                row.logical_graph.estimated_expanded_entry_count.to_string(),
                row.logical_graph.expansion_overflow.to_string(),
                row.projection.projected_entry_count.to_string(),
                row.projection.round_trip_faithful.to_string(),
                row.reason.clone(),
                row.recommended_expert_action.clone(),
            ]
        })
        .collect::<Vec<_>>();
    write_csv(
        &dir.join("read-only-audit-v2.csv"),
        &[
            "relativePath",
            "structuralFamily",
            "familyConfidence",
            "familySignature",
            "runtimeStageCount",
            "runtimeReachableStageCount",
            "runtimeCyclicSccCount",
            "logicalNodeCount",
            "logicalReachableNodeCount",
            "logicalReferenceEdgeCount",
            "logicalReturnEdgeCount",
            "logicalNativeOnlyTargetCount",
            "logicalMissingTargetCount",
            "logicalUnreachableNodeCount",
            "logicalConvergentTargetCount",
            "logicalCyclicSccCount",
            "estimatedExpandedEntryCount",
            "expansionOverflow",
            "projectedEntryCount",
            "roundTripFaithful",
            "reason",
            "recommendedExpertAction",
        ],
        &csv_rows,
    )?;

    let mut family_rows = Vec::new();
    let mut by_family: BTreeMap<&str, Vec<&ReadOnlyAuditV2>> = BTreeMap::new();
    for row in rows {
        by_family
            .entry(row.structural_family.as_str())
            .or_default()
            .push(row);
    }
    for (family, members) in &by_family {
        family_rows.push(json!({
            "familyId": family,
            "count": members.len(),
            "faithfulCount": members.iter().filter(|row| row.projection.round_trip_faithful).count(),
            "minLogicalNodes": members.iter().map(|row| row.logical_graph.node_count).min().unwrap_or(0),
            "maxLogicalNodes": members.iter().map(|row| row.logical_graph.node_count).max().unwrap_or(0),
            "maxProjectedEntries": members.iter().map(|row| row.projection.projected_entry_count).max().unwrap_or(0),
            "signatures": members.iter().map(|row| row.family_signature.as_str()).collect::<BTreeSet<_>>(),
        }));
    }
    let mut families_file =
        File::create(dir.join("structural-families-v2.json")).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut families_file, &family_rows)
        .map_err(|error| error.to_string())?;
    families_file.flush().map_err(|error| error.to_string())?;

    let experts = select_experts_v2(rows);
    let expert_rows = experts
        .iter()
        .map(|row| {
            vec![
                row.structural_family.clone(),
                row.relative_path.clone(),
                if row.size_bytes
                    == by_family[row.structural_family.as_str()]
                        .iter()
                        .map(|member| member.size_bytes)
                        .min()
                        .unwrap_or(row.size_bytes)
                {
                    "plus petit représentant de la famille".to_string()
                } else {
                    "cas de stress d'une classe de taille différente".to_string()
                },
                row.runtime_graph
                    .cycle_witnesses
                    .first()
                    .cloned()
                    .unwrap_or_default(),
                row.logical_graph
                    .cycle_witnesses
                    .first()
                    .cloned()
                    .unwrap_or_default(),
                row.projection.round_trip_faithful.to_string(),
                row.logical_graph.estimated_expanded_entry_count.to_string(),
                row.recommended_expert_action.clone(),
            ]
        })
        .collect::<Vec<_>>();
    write_csv(
        &dir.join("expert-selection-v2.csv"),
        &[
            "familyId",
            "relativePath",
            "whyRepresentative",
            "runtimeWitness",
            "logicalWitness",
            "currentFidelity",
            "estimatedExpansion",
            "expertQuestion",
        ],
        &expert_rows,
    )?;

    let mut report = String::from("# Rapport audit structurel v2\n\n");
    report.push_str(&format!("- Packs audités : {}.\n", rows.len()));
    report.push_str(&format!("- Familles : {}.\n", by_family.len()));
    report.push_str(&format!("- Représentants : {}.\n", experts.len()));
    report.push_str(&format!(
        "- Fidèles au round-trip actuel : {}.\n\n",
        rows.iter()
            .filter(|row| row.projection.round_trip_faithful)
            .count()
    ));
    report.push_str("## Familles\n\n");
    for (family, members) in by_family {
        report.push_str(&format!("- `{family}` : {} pack(s).\n", members.len()));
    }
    report.push_str("\n## Garde-fous\n\n");
    report.push_str("- Les transitions `autoplay` restent dans le graphe runtime.\n");
    report.push_str("- Le graphe logique est dérivé de la projection authoring et conserve les `ref` et retours typés comme arêtes visibles.\n");
    report
        .push_str("- Home, `root`, `current_menu` et `next_story` sont inventoriés séparément.\n");
    fs::write(dir.join("audit-v2-report.md"), report).map_err(|error| error.to_string())?;
    Ok(())
}

fn pick_e1_sample<F>(rows: &[ReadOnlyAudit], selected: &mut HashSet<String>, predicate: F)
where
    F: Fn(&ReadOnlyAudit) -> bool,
{
    if let Some(row) = rows
        .iter()
        .filter(|row| !selected.contains(&row.relative_path) && predicate(row))
        .min_by_key(|row| {
            (
                row.projection.projected_entry_count,
                row.size_bytes,
                row.relative_path.as_str(),
            )
        })
    {
        selected.insert(row.relative_path.clone());
    }
}

fn select_e1_sample_packs(root: &Path, packs: &mut Vec<CorpusPack>, limit: usize) {
    let v1_path = triage_root(root).join("read-only-audit.jsonl");
    let Ok(rows) = read_jsonl::<ReadOnlyAudit>(&v1_path) else {
        packs.truncate(limit);
        return;
    };
    let mut selected = HashSet::new();
    pick_e1_sample(&rows, &mut selected, |row| {
        row.projection.round_trip_faithful && row.projection.projected_entry_count <= 500
    });
    pick_e1_sample(&rows, &mut selected, |row| {
        row.projection.shared_entry_count > 0 && row.projection.projected_entry_count <= 500
    });
    pick_e1_sample(&rows, &mut selected, |row| {
        row.projection.has_unmodeled_wheel && row.projection.projected_entry_count <= 500
    });
    pick_e1_sample(&rows, &mut selected, |row| {
        explicit_data_defect_reason(&row.projection.current_reason)
    });
    let mut remaining = rows
        .iter()
        .filter(|row| {
            !selected.contains(&row.relative_path) && row.projection.projected_entry_count <= 500
        })
        .collect::<Vec<_>>();
    remaining.sort_by_key(|row| {
        (
            row.projection.projected_entry_count,
            row.size_bytes,
            row.relative_path.as_str(),
        )
    });
    for row in remaining {
        if selected.len() >= limit {
            break;
        }
        selected.insert(row.relative_path.clone());
    }
    packs.retain(|pack| selected.contains(&pack.initial.relative_path));
    packs.sort_by(|left, right| left.initial.relative_path.cmp(&right.initial.relative_path));
    packs.truncate(limit);
}

fn run_corpus_audit_v2(sample_limit: Option<usize>) -> Result<(), String> {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let mut packs = initial_records(&root, "READ_ONLY")?;
    if packs.len() != EXPECTED_READ_ONLY {
        return Err(format!("baseline v2 inattendue: {} packs", packs.len()));
    }
    packs.sort_by_key(|pack| {
        (
            fs::metadata(&pack.path)
                .map(|metadata| metadata.len())
                .unwrap_or(u64::MAX),
            pack.initial.relative_path.clone(),
        )
    });
    if let Some(limit) = sample_limit {
        select_e1_sample_packs(&root, &mut packs, limit);
    }
    let report_dir = triage_root(&root)
        .join("Audit v2")
        .join(if sample_limit.is_some() {
            "E1 sample"
        } else {
            ""
        });
    fs::create_dir_all(&report_dir).map_err(|error| error.to_string())?;
    let report_path = report_dir.join("read-only-audit-v2.jsonl");
    let mut previous = partial_read_only_rows_v2(&report_path, &packs)?;
    let mut report_file = open_partial_report(&report_path)?;
    let mut rows = Vec::new();
    for pack in &packs {
        let row = if let Some(row) = previous.remove(&pack.initial.relative_path) {
            row
        } else {
            let row = catch_unwind(AssertUnwindSafe(|| audit_read_only_pack_v2(pack)))
                .unwrap_or_else(|_| ReadOnlyAuditV2 {
                    schema_version: REPORT_SCHEMA_VERSION_V2,
                    relative_path: pack.initial.relative_path.clone(),
                    size_bytes: pack.initial.size_bytes,
                    last_write_time_utc: pack.initial.last_write_time_utc,
                    initial_status: pack.initial.status.clone(),
                    current_status: "NEEDS_EXPERT_REVIEW".to_string(),
                    structural_family: "NEEDS_EXPERT_REVIEW".to_string(),
                    family_confidence: "LOW".to_string(),
                    family_evidence: vec!["panique capturée par pack".to_string()],
                    reason: sanitize_error(&pack.initial.reason),
                    runtime_graph: GraphMetrics::default(),
                    logical_graph: LogicalGraphMetrics::default(),
                    projection: ProjectionMetrics::default(),
                    family_signature: "panic".to_string(),
                    recommended_expert_action: "Reproduire ce pack avec l'agent expert."
                        .to_string(),
                    duration_ms: 0,
                });
            append_jsonl(&mut report_file, &row)?;
            row
        };
        rows.push(row);
    }
    rows.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let experts = select_experts_v2(&rows);
    if sample_limit.is_none() && experts.len() > 20 {
        return Err(format!(
            "typologie v2 trop large: {} représentants; revue experte requise",
            experts.len()
        ));
    }
    write_v2_artifacts(&report_dir, &rows)?;
    Ok(())
}

fn run_corpus_audit() -> Result<(), String> {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let read_only = initial_records(&root, "READ_ONLY")?;
    let import_errors = initial_records(&root, "IMPORT_ERROR")?;
    if read_only.len() != EXPECTED_READ_ONLY || import_errors.len() != EXPECTED_IMPORT_ERRORS {
        return Err(format!(
            "baseline inattendue: {} lecture seule, {} erreurs",
            read_only.len(),
            import_errors.len()
        ));
    }
    let report_dir = triage_root(&root);
    fs::create_dir_all(&report_dir).map_err(|error| error.to_string())?;
    let read_only_report = env_path(
        "STORY_STUDIO_TRIAGE_READ_ONLY_REPORT",
        &report_dir.join("read-only-audit.jsonl"),
    );
    let import_error_report = env_path(
        "STORY_STUDIO_TRIAGE_IMPORT_ERROR_REPORT",
        &report_dir.join("import-error-audit.jsonl"),
    );
    if let Some(parent) = read_only_report.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if let Some(parent) = import_error_report.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut previous_read_only = partial_read_only_rows(&read_only_report, &read_only)?;
    let mut previous_import_errors =
        partial_import_error_rows(&import_error_report, &import_errors)?;
    let mut read_only_file = open_partial_report(&read_only_report)?;
    let mut rows = Vec::new();
    for pack in &read_only {
        let row = if let Some(row) = previous_read_only.remove(&pack.initial.relative_path) {
            row
        } else {
            let row = catch_unwind(AssertUnwindSafe(|| audit_read_only_pack(pack))).unwrap_or_else(
                |_| ReadOnlyAudit {
                    schema_version: REPORT_SCHEMA_VERSION,
                    relative_path: pack.initial.relative_path.clone(),
                    size_bytes: pack.initial.size_bytes,
                    last_write_time_utc: pack.initial.last_write_time_utc,
                    initial_status: pack.initial.status.clone(),
                    current_status: "NEEDS_EXPERT_REVIEW".to_string(),
                    triage_category: "NEEDS_EXPERT_REVIEW".to_string(),
                    triage_confidence: "LOW".to_string(),
                    triage_evidence: vec!["panique capturée par pack".to_string()],
                    reason: sanitize_error(&pack.initial.reason),
                    graph: GraphMetrics::default(),
                    projection: ProjectionMetrics::default(),
                    structural_signature: "panic".to_string(),
                    recommended_expert_action: "Reproduire ce pack isolément avec l'agent expert."
                        .to_string(),
                    duration_ms: 0,
                },
            );
            append_jsonl(&mut read_only_file, &row)?;
            row
        };
        rows.push(row);
    }
    let mut import_error_file = open_partial_report(&import_error_report)?;
    let mut errors = Vec::new();
    for pack in &import_errors {
        let row = if let Some(row) = previous_import_errors.remove(&pack.initial.relative_path) {
            row
        } else {
            let row = catch_unwind(AssertUnwindSafe(|| audit_import_error_pack(pack)))
                .unwrap_or_else(|_| ImportErrorAudit {
                    schema_version: REPORT_SCHEMA_VERSION,
                    relative_path: pack.initial.relative_path.clone(),
                    size_bytes: pack.initial.size_bytes,
                    sha256: "unavailable".to_string(),
                    initial_error: sanitize_error(&pack.initial.reason),
                    container_readable: false,
                    container_entry_count: 0,
                    marker_counts: BTreeMap::new(),
                    nested_archive_count: 0,
                    bt_length: None,
                    has_cleartext_marker: false,
                    seven_zip_test_result: None,
                    child_pack_results: Vec::new(),
                    triage_category: "NEEDS_EXPERT_REVIEW".to_string(),
                    triage_confidence: "LOW".to_string(),
                    triage_evidence: vec!["panique capturée par pack".to_string()],
                    recommended_expert_action: "Reproduire ce pack isolément avec l'agent expert."
                        .to_string(),
                    duration_ms: 0,
                });
            append_jsonl(&mut import_error_file, &row)?;
            row
        };
        errors.push(row);
    }
    rows.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    errors.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    audit_root_rows(&root, &rows, &errors)?;
    let plans = plan_rows(&root, &rows, &errors);
    write_move_plan(&root, &plans)?;
    write_report(&root, &rows, &errors, &plans)?;
    assert_eq!(rows.len(), EXPECTED_READ_ONLY);
    assert_eq!(errors.len(), EXPECTED_IMPORT_ERRORS);
    assert!(plans
        .iter()
        .all(|row| row.source.starts_with(&root) && row.destination.starts_with(&root)));
    Ok(())
}

#[test]
#[ignore = "campagne corpus locale explicite; définit STORY_STUDIO_TRIAGE_ROOT pour un autre corpus"]
fn triage_corpus_0_9_9() {
    run_corpus_audit().expect("audit de corpus");
}

#[test]
#[ignore = "jalon C1 explicite: campagne structurelle v2 complète sur le corpus privé"]
fn triage_corpus_v2_0_9_9() {
    run_corpus_audit_v2(None).expect("audit structurel v2");
}

#[test]
#[ignore = "jalon E1 explicite: contrôle des cinq plus petits packs du corpus privé"]
fn triage_corpus_v2_e1_sample() {
    run_corpus_audit_v2(Some(5)).expect("échantillon structurel v2");
}

#[test]
#[ignore = "jalon E2 explicite: preuve privée de promotion des refs racine fidèles"]
fn triage_corpus_v2_e2_root_ref_promotion_proof() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let rows = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("rapport C1 v2");
    let candidates = rows
        .iter()
        .filter(|row| {
            row.projection.round_trip_faithful
                && row.projection.projected_ref_count == 1
                && row.projection.shared_entry_count > 0
        })
        .map(|row| row.relative_path.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(candidates.len(), 8, "nombre de candidats racine-only");

    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let expected = HashSet::from([
        "05/Histoires farfelues d'orthographe - Les frères S et autres histoires.zip",
        "05/Histoires farfelues d’orthographe - Le roi Ponctuation et autre histoire.zip",
    ]);
    let mut editable = Vec::new();
    let mut faithful_candidates_read_only = 0;
    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification");
        if classification.authoring_editable {
            editable.push(pack.initial.relative_path.replace('\\', "/"));
            let (projection, imported) =
                projection_for_pack(&raw_document, &classification).expect("projection");
            assert_eq!(projection.shared_entry_count, 0);
            assert_eq!(projection.projected_ref_count, 0);
            assert_eq!(classification.root_ref_ratio, 0.0);
            assert!(classification.round_trip_faithful);
            assert_eq!(imported["sharedEntries"].as_array().map(Vec::len), Some(0));
            assert_eq!(count_projected_type(&imported["entries"], "ref"), 0);
            let title = raw_document
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Pack importé");
            assert!(
                super::super::extraction::imported_entries_roundtrip_is_faithful(&imported, title)
                    .expect("juge de fidélité après promotion")
            );
        } else {
            assert!(classification.read_only_inspectable);
            faithful_candidates_read_only += 1;
        }
    }
    editable.sort();
    let mut expected = expected.into_iter().map(str::to_string).collect::<Vec<_>>();
    expected.sort();
    eprintln!(
        "promotions production={editable:#?}; candidats fidèles restés lecture seule={faithful_candidates_read_only}"
    );
    assert_eq!(
        editable, expected,
        "exactement les deux promotions attendues"
    );
    assert_eq!(faithful_candidates_read_only, 6);
}

#[test]
#[ignore = "campagne E3 fraîche: les 136 packs lecture seule, sans reprise du JSONL C1"]
fn triage_corpus_v2_e3_fresh_root_ref_promotion_campaign() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    assert_eq!(packs.len(), EXPECTED_READ_ONLY);

    let expected = HashSet::from([
        "05/Histoires farfelues d'orthographe - Les frères S et autres histoires.zip",
        "05/Histoires farfelues d’orthographe - Le roi Ponctuation et autre histoire.zip",
    ]);
    let mut editable = Vec::new();
    let mut other_editable = Vec::new();

    for pack in &packs {
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let relative_path = pack.initial.relative_path.replace('\\', "/");
        if classification.authoring_editable {
            editable.push(relative_path.clone());
            if !expected.contains(relative_path.as_str()) {
                other_editable.push(relative_path);
                continue;
            }

            let story_json =
                load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
            let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
            let (projection, imported) =
                projection_for_pack(&raw_document, &classification).expect("projection");
            assert!(classification.round_trip_faithful);
            assert_eq!(classification.root_ref_ratio, 0.0);
            assert_eq!(projection.shared_entry_count, 0);
            assert_eq!(projection.projected_ref_count, 0);
            assert_eq!(imported["sharedEntries"].as_array().map(Vec::len), Some(0));
            assert_eq!(count_projected_type(&imported["entries"], "ref"), 0);
            let title = raw_document
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Pack importé");
            assert!(
                super::super::extraction::imported_entries_roundtrip_is_faithful(&imported, title)
                    .expect("juge de fidélité après promotion")
            );
        } else {
            assert!(classification.read_only_inspectable);
        }
    }

    editable.sort();
    let mut expected = expected.into_iter().map(str::to_string).collect::<Vec<_>>();
    expected.sort();
    assert_eq!(
        editable, expected,
        "exactement deux packs nouvellement éditables"
    );
    assert!(
        other_editable.is_empty(),
        "aucune autre décision ne doit devenir éditable: {other_editable:#?}"
    );
}

#[test]
#[ignore = "jalon E4 explicite: diagnostic privé des collisions sequence-choice"]
fn triage_corpus_v2_e4_sequence_choice_collision_audit() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let rows = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("rapport C1 v2");
    let candidates = rows
        .iter()
        .filter(|row| row.logical_graph.duplicate_id_count > 0)
        .map(|row| row.relative_path.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(candidates.len(), 8, "projections avec ids dupliqués");

    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut audited = 0;
    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification");
        let (_, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection");
        let mut occurrences = BTreeMap::new();
        collect_projected_id_occurrences(&imported["entries"], "entries", &mut occurrences);
        collect_projected_id_occurrences(
            &imported["sharedEntries"],
            "sharedEntries",
            &mut occurrences,
        );
        let duplicates = occurrences
            .iter()
            .filter(|(_, values)| values.len() > 1)
            .collect::<Vec<_>>();
        let duplicate_ids = duplicates
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<HashSet<_>>();
        let mut references = Vec::new();
        collect_projected_navigation_references(&imported, "projection", &mut references);
        let references_to_duplicates = references
            .iter()
            .filter(|(_, _, target)| {
                navigation_target_id(target)
                    .map(|target_id| duplicate_ids.contains(target_id))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        let form_pairs = duplicates
            .iter()
            .map(|(_, values)| {
                let mut forms = values
                    .iter()
                    .map(|value| value.3.as_str())
                    .collect::<Vec<_>>();
                forms.sort_unstable();
                forms.join("+")
            })
            .fold(BTreeMap::<String, usize>::new(), |mut counts, pair| {
                *counts.entry(pair).or_default() += 1;
                counts
            });
        assert!(!duplicates.is_empty(), "collision attendue");
        assert!(duplicates
            .iter()
            .all(|(id, _)| id.contains("-sequence-choice-")));
        let menu_duplicates = duplicates
            .iter()
            .filter(|(_, values)| values.iter().any(|value| value.3 == "menu"))
            .count();
        let identical_bodies = duplicates
            .iter()
            .filter(|(_, values)| {
                values
                    .iter()
                    .map(|value| value.1.as_str())
                    .collect::<HashSet<_>>()
                    .len()
                    == 1
            })
            .count();
        let repeated_step_names = duplicates
            .iter()
            .flat_map(|(_, values)| values.iter().map(|value| value.2.as_str()))
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .len();
        eprintln!(
            "{}: ids_dupliqués={}, menus_dupliqués={}, corps_identiques={}, noms_étape={}, occurrence_max={}, refs_vers_dupliqués={}, formes={:?}, exemple_paths={:?}",
            pack.initial.relative_path,
            duplicates.len(),
            menu_duplicates,
            identical_bodies,
            repeated_step_names,
            duplicates
                .iter()
                .map(|(_, values)| values.len())
                .max()
                .unwrap_or(0),
            references_to_duplicates.len(),
            form_pairs,
            duplicates[0]
                .1
                .iter()
                .map(|value| value.0.as_str())
                .collect::<Vec<_>>(),
        );
        if !references_to_duplicates.is_empty() {
            eprintln!("  références={references_to_duplicates:?}");
        }
        eprintln!(
            "  exemple_id={}; formes={:?}",
            duplicates[0].0,
            duplicates[0]
                .1
                .iter()
                .map(|value| value.4.as_str())
                .collect::<Vec<_>>()
        );
        audited += 1;
    }
    assert_eq!(audited, candidates.len());
}

fn projected_children_count(entries: &Value) -> usize {
    let Some(entries) = entries.as_array() else {
        return 0;
    };
    entries
        .iter()
        .map(|entry| {
            let children = entry
                .get("children")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            children + projected_children_count(entry.get("children").unwrap_or(&Value::Null))
        })
        .sum()
}

fn sequence_choice_candidates(rows: &[ReadOnlyAuditV2]) -> HashSet<&str> {
    rows.iter()
        .filter(|row| row.logical_graph.duplicate_id_count > 0)
        .map(|row| row.relative_path.as_str())
        .collect()
}

#[test]
#[ignore = "jalon E5 explicite: preuve fraîche des huit collisions sequence-choice"]
fn triage_corpus_v2_e5_sequence_choice_targeted_proof() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let baseline = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("rapport C1 v2");
    let candidates = sequence_choice_candidates(&baseline);
    assert_eq!(candidates.len(), 8, "projections C1 avec ids dupliqués");

    let baseline_by_path = baseline
        .iter()
        .map(|row| (row.relative_path.as_str(), row))
        .collect::<HashMap<_, _>>();
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut audited = 0;
    let mut second_occurrences = 0;
    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let baseline = baseline_by_path[pack.initial.relative_path.as_str()];
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let (projection, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection fraîche");
        let document: StoryDocument = serde_json::from_value(raw_document).expect("StoryDocument");
        let runtime_root_stage_id = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .map(|stage| stage.uuid.as_str());
        let runtime_stage_kinds = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
            .collect::<HashMap<_, _>>();
        let logical =
            analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);

        let entries = &imported["entries"];
        let shared_entries = &imported["sharedEntries"];
        let entry_count = count_projected_type(entries, "menu")
            + count_projected_type(entries, "story")
            + count_projected_type(entries, "ref")
            + count_projected_type(shared_entries, "menu")
            + count_projected_type(shared_entries, "story")
            + count_projected_type(shared_entries, "ref");
        let child_count =
            projected_children_count(entries) + projected_children_count(shared_entries);
        let mut occurrences = BTreeMap::new();
        collect_projected_id_occurrences(entries, "entries", &mut occurrences);
        collect_projected_id_occurrences(shared_entries, "sharedEntries", &mut occurrences);
        assert_eq!(
            logical.duplicate_id_count, 0,
            "duplicate_id_count après correction: {}",
            pack.initial.relative_path
        );
        assert!(
            occurrences.values().all(|values| values.len() == 1),
            "id dupliqué après correction: {}",
            pack.initial.relative_path
        );
        let pack_second_occurrences = occurrences
            .keys()
            .filter(|id| id.contains("-sequence-choice-") && id.ends_with("-occurrence-2"))
            .count();
        second_occurrences += pack_second_occurrences;
        assert_eq!(
            projection.projected_entry_count, baseline.projection.projected_entry_count,
            "nombre d'entrées changé: {}",
            pack.initial.relative_path
        );
        assert_eq!(entry_count, projection.projected_entry_count);
        assert_eq!(
            logical.missing_target_count, baseline.logical_graph.missing_target_count,
            "cible manquante modifiée: {}",
            pack.initial.relative_path
        );
        assert!(
            !baseline.projection.round_trip_faithful || projection.round_trip_faithful,
            "fidélité régressée: {}",
            pack.initial.relative_path
        );
        eprintln!(
            "{}: duplicate_id_count={}, occurrences_secondaires={}, entries={}, menu={}, story={}, ref={}, children={}, faithful={}, editable={}, reason={}",
            pack.initial.relative_path,
            logical.duplicate_id_count,
            pack_second_occurrences,
            projection.projected_entry_count,
            count_projected_type(entries, "menu") + count_projected_type(shared_entries, "menu"),
            count_projected_type(entries, "story") + count_projected_type(shared_entries, "story"),
            count_projected_type(entries, "ref") + count_projected_type(shared_entries, "ref"),
            child_count,
            projection.round_trip_faithful,
            classification.authoring_editable,
            classification.reason,
        );
        let (size, modified) = file_metadata(pack).expect("métadonnées post-projection");
        assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
        assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
        audited += 1;
    }
    assert_eq!(audited, candidates.len());
    assert_eq!(second_occurrences, 90, "secondes occurrences renommées");
}

#[test]
#[ignore = "jalon E5 explicite: campagne fraîche des 136 packs après la preuve ciblée"]
fn triage_corpus_v2_e5_sequence_choice_fresh_campaign() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let baseline = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("rapport C1 v2");
    let candidates = sequence_choice_candidates(&baseline);
    assert_eq!(candidates.len(), 8, "projections C1 avec ids dupliqués");
    let baseline_by_path = baseline
        .iter()
        .map(|row| (row.relative_path.as_str(), row))
        .collect::<HashMap<_, _>>();
    let c2a_editable = HashSet::from([
        "05/Histoires farfelues d'orthographe - Les frères S et autres histoires.zip",
        "05/Histoires farfelues d’orthographe - Le roi Ponctuation et autre histoire.zip",
    ]);
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    assert_eq!(packs.len(), EXPECTED_READ_ONLY);

    let mut decisions = BTreeMap::new();
    for pack in &packs {
        let fresh = audit_read_only_pack_v2(pack);
        let normalized_path = pack.initial.relative_path.replace('\\', "/");
        let expected = if c2a_editable.contains(normalized_path.as_str()) {
            "EDITABLE"
        } else {
            baseline_by_path[pack.initial.relative_path.as_str()]
                .current_status
                .as_str()
        };
        if !candidates.contains(pack.initial.relative_path.as_str()) {
            assert_eq!(
                fresh.current_status, expected,
                "décision hors des huit candidats modifiée: {}",
                pack.initial.relative_path
            );
        }
        decisions.insert(
            pack.initial.relative_path.clone(),
            (expected.to_string(), fresh),
        );
    }

    let delta = decisions
        .iter()
        .filter(|(_, (before, after))| before != &after.current_status)
        .map(|(path, (before, after))| format!("{path}: {before} -> {}", after.current_status))
        .collect::<Vec<_>>();
    for path in candidates.iter().copied().collect::<BTreeSet<_>>() {
        let (_, result) = &decisions[path];
        eprintln!(
            "candidat {}: décision={}, fidèle={}, raison={}",
            path,
            result.current_status,
            result.projection.round_trip_faithful,
            result.projection.current_reason
        );
    }
    eprintln!("delta décisions 136: {delta:#?}");
    assert!(
        delta.iter().all(|change| {
            candidates
                .iter()
                .any(|candidate| change.starts_with(candidate))
                || c2a_editable.iter().any(|path| change.starts_with(path))
        }),
        "delta hors C2-A ou huit candidats: {delta:#?}"
    );
}

#[test]
#[ignore = "jalon E6 explicite: diagnostics frais des quatre arbres acycliques privés"]
fn triage_corpus_v2_e6_acyclic_tree_diagnostics() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let candidates = BTreeSet::from([
        r"03\3+ Cachés - Les animaux autour de toi.7z",
        r"05\5+ L'horloge Enchantée.7z",
        r"05\5+ Mes tableaux à écouter, le peintre aux nénuphars et autres histoires.7z",
        r"07\Le tour du monde en 80 jours.zip",
    ]);
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut diagnostics = Vec::new();

    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let started = Instant::now();
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let document: StoryDocument =
            serde_json::from_value(raw_document.clone()).expect("StoryDocument");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let (projection, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection fraîche");
        let runtime = analyze_graph(&document).metrics;
        let runtime_root_stage_id = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .map(|stage| stage.uuid.as_str());
        let runtime_stage_kinds = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
            .collect::<HashMap<_, _>>();
        let logical =
            analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);

        assert_eq!(classification.shared_entry_count, 0);
        assert_eq!(projection.projected_ref_count, 0);
        assert!(!projection.uses_graph_projection);
        diagnostics.push(json!({
            "relativePath": pack.initial.relative_path,
            "sizeBytes": pack.initial.size_bytes,
            "lastWriteTimeUtc": pack.initial.last_write_time_utc,
            "classification": {
                "authoringEditable": classification.authoring_editable,
                "readOnlyInspectable": classification.read_only_inspectable,
                "roundTripFaithful": classification.round_trip_faithful,
                "reason": classification.reason,
                "rootEntryCount": classification.root_entry_count,
                "sharedEntryCount": classification.shared_entry_count,
                "hasUnmodeledWheel": classification.has_unmodeled_wheel,
            },
            "runtimeGraph": runtime,
            "logicalGraph": logical,
            "projectionMetrics": projection,
            "rawDocument": raw_document,
            "freshProjection": imported,
            "durationMs": started.elapsed().as_millis(),
        }));

        let (size, modified) = file_metadata(pack).expect("métadonnées post-diagnostic");
        assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
        assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
    }

    assert_eq!(diagnostics.len(), candidates.len());
    let output = triage_root(&root)
        .join("Audit v2")
        .join("e6-acyclic-tree-fresh-diagnostics.json");
    let mut file = File::create(&output).expect("création diagnostic E6");
    serde_json::to_writer_pretty(&mut file, &diagnostics).expect("écriture diagnostic E6");
    file.write_all(b"\n").expect("fin diagnostic E6");
    eprintln!("diagnostic E6 écrit: {}", output.display());
}

fn raw_stage_action_options<'a>(
    stage: &'a Value,
    actions: &HashMap<&'a str, &'a Value>,
) -> Vec<&'a str> {
    stage
        .get("okTransition")
        .and_then(|transition| transition.get("actionNode"))
        .and_then(Value::as_str)
        .and_then(|action_id| actions.get(action_id).copied())
        .and_then(|action| action.get("options"))
        .and_then(Value::as_array)
        .map(|options| options.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn raw_resolved_transition_target<'a>(
    stage: &'a Value,
    field: &str,
    actions: &HashMap<&'a str, &'a Value>,
) -> Option<String> {
    let transition = stage.get(field)?;
    let action_id = transition.get("actionNode")?.as_str()?;
    let option_index = transition.get("optionIndex")?.as_i64()?;
    let index = usize::try_from(option_index).ok()?;
    actions
        .get(action_id)?
        .get("options")?
        .as_array()?
        .get(index)?
        .as_str()
        .map(str::to_string)
}

fn raw_ok_reaches_stage(
    start_id: &str,
    target_id: &str,
    stages: &HashMap<&str, &Value>,
    actions: &HashMap<&str, &Value>,
) -> bool {
    let mut pending = vec![start_id];
    let mut visited = HashSet::new();
    while let Some(stage_id) = pending.pop() {
        if stage_id == target_id {
            return true;
        }
        if !visited.insert(stage_id) {
            continue;
        }
        if let Some(stage) = stages.get(stage_id) {
            pending.extend(raw_stage_action_options(stage, actions));
        }
    }
    false
}

fn collect_projected_stories<'a>(entries: &'a Value, stories: &mut Vec<&'a Value>) {
    let Some(entries) = entries.as_array() else {
        return;
    };
    for entry in entries {
        match entry.get("type").and_then(Value::as_str) {
            Some("story") => stories.push(entry),
            Some("menu") => {
                collect_projected_stories(entry.get("children").unwrap_or(&Value::Null), stories)
            }
            _ => {}
        }
    }
}

fn collect_projected_menus<'a>(entries: &'a Value, menus: &mut Vec<&'a Value>) {
    let Some(entries) = entries.as_array() else {
        return;
    };
    for entry in entries {
        if entry.get("type").and_then(Value::as_str) == Some("menu") {
            menus.push(entry);
            collect_projected_menus(entry.get("children").unwrap_or(&Value::Null), menus);
        }
    }
}

fn projected_menu_depth(entries: &Value, depth: usize) -> usize {
    entries
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            if entry.get("type").and_then(Value::as_str) == Some("menu") {
                depth.max(projected_menu_depth(
                    entry.get("children").unwrap_or(&Value::Null),
                    depth + 1,
                ))
            } else {
                depth
            }
        })
        .max()
        .unwrap_or(depth)
}

fn collect_projected_entries<'a>(entries: &'a Value, values: &mut Vec<&'a Value>) {
    let Some(entries) = entries.as_array() else {
        return;
    };
    for entry in entries {
        values.push(entry);
        if entry.get("type").and_then(Value::as_str) == Some("menu") {
            collect_projected_entries(entry.get("children").unwrap_or(&Value::Null), values);
        }
    }
}

fn projected_entry_stage_identity(entry: &Value) -> Option<&str> {
    entry
        .get("nativeStageId")
        .or_else(|| entry.get("id"))
        .and_then(Value::as_str)
}

fn e10_rewrite_promoted_root_target(target: Option<String>, promoted_id: &str) -> Option<String> {
    let target = target?;
    if target == format!("menu:{promoted_id}") {
        Some("root".to_string())
    } else {
        Some(target)
    }
}

fn e10_rewrite_promoted_root_entry(entry: &mut ProjectEntry, promoted_id: &str) {
    entry.return_after_play =
        e10_rewrite_promoted_root_target(entry.return_after_play.take(), promoted_id);
    entry.return_on_home =
        e10_rewrite_promoted_root_target(entry.return_on_home.take(), promoted_id);
    entry.title_return_on_home =
        e10_rewrite_promoted_root_target(entry.title_return_on_home.take(), promoted_id);
    entry.after_playback_prompt_ok_target =
        e10_rewrite_promoted_root_target(entry.after_playback_prompt_ok_target.take(), promoted_id);
    entry.after_playback_prompt_home_target = e10_rewrite_promoted_root_target(
        entry.after_playback_prompt_home_target.take(),
        promoted_id,
    );
    for step in &mut entry.after_playback_sequence {
        step.ok_target = e10_rewrite_promoted_root_target(step.ok_target.take(), promoted_id);
        step.ok_choice_targets = step
            .ok_choice_targets
            .drain(..)
            .filter_map(|target| e10_rewrite_promoted_root_target(Some(target), promoted_id))
            .collect();
        step.home_target = e10_rewrite_promoted_root_target(step.home_target.take(), promoted_id);
    }
    if let Some(step) = &mut entry.after_playback_home_step {
        step.ok_target = e10_rewrite_promoted_root_target(step.ok_target.take(), promoted_id);
        step.ok_choice_targets = step
            .ok_choice_targets
            .drain(..)
            .filter_map(|target| e10_rewrite_promoted_root_target(Some(target), promoted_id))
            .collect();
        step.home_target = e10_rewrite_promoted_root_target(step.home_target.take(), promoted_id);
    }
    for child in &mut entry.children {
        e10_rewrite_promoted_root_entry(child, promoted_id);
    }
}

fn e10_project_for_fidelity(imported: &Value) -> Project {
    let root_audio = imported["rootAudio"].as_str().map(str::to_string);
    let root_image = imported["rootImage"].as_str().map(str::to_string);
    let night_mode = imported["nightMode"].as_bool().unwrap_or(false);
    let promoted_root_id = imported["rootId"].as_str().unwrap_or("").to_string();
    let mut root_entries: Vec<ProjectEntry> =
        serde_json::from_value(imported["entries"].clone()).expect("entries E10 valides");
    let mut shared_entries: Vec<ProjectEntry> = serde_json::from_value(
        imported
            .get("sharedEntries")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )
    .expect("shared entries E10 valides");
    for entry in root_entries.iter_mut().chain(shared_entries.iter_mut()) {
        e10_rewrite_promoted_root_entry(entry, &promoted_root_id);
    }
    Project {
        name: imported["title"]
            .as_str()
            .unwrap_or("Pack importé")
            .to_string(),
        project_type: Some("pack".to_string()),
        root_audio: root_audio.clone(),
        root_image: root_image.clone(),
        thumbnail_image: root_image,
        night_mode_audio: night_mode.then(|| {
            imported["nightModeAudio"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        }),
        night_mode_return: night_mode.then(|| {
            imported["nightModeReturn"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        }),
        night_mode_home_return: night_mode.then(|| {
            imported["nightModeHomeReturn"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        }),
        native_graph: imported
            .get("nativeGraph")
            .filter(|value| !value.is_null())
            .cloned(),
        root_entries,
        global_options: GlobalOptions {
            add_silence: false,
            silence_mode: None,
            harmonize_loudness: true,
            add_silence_duration_sec: AudioEdgeSilenceDuration::uniform(1.0),
            auto_next: false,
            night_mode,
            end_message_autoplay: imported["endMessageAutoplay"].as_bool().unwrap_or(true),
        },
        pack_version: 1,
        pack_description: String::new(),
        pack_uuid: String::new(),
        shared_entries,
    }
}

fn e10_materialize_root_ref_menu_story_fanout(imported: &Value) -> Option<Value> {
    let mut candidate = imported.clone();
    let roots = candidate.get("entries")?.as_array()?;
    let shared = candidate.get("sharedEntries")?.as_array()?;
    if roots.len() != 1 || shared.is_empty() {
        return None;
    }
    let root_target = roots[0].get("target")?.as_str()?.to_string();
    if roots[0].get("type")?.as_str()? != "ref" || roots[0].get("refKind")?.as_str()? != "continue"
    {
        return None;
    }
    let menu_index = shared.iter().position(|entry| {
        entry.get("type").and_then(Value::as_str) == Some("menu")
            && typed_ref_target_matches_entry(&root_target, entry)
    })?;
    let mut menu = shared[menu_index].clone();
    let children = menu.get("children")?.as_array()?;
    if children.is_empty()
        || children.iter().any(|child| {
            child.get("type").and_then(Value::as_str) != Some("ref")
                || child.get("refKind").and_then(Value::as_str) != Some("continue")
                || child.get("target").and_then(Value::as_str).is_none()
                || !child["target"]
                    .as_str()
                    .is_some_and(|target| target.starts_with("story:"))
        })
    {
        return None;
    }
    let child_targets = children
        .iter()
        .map(|child| {
            child["target"]
                .as_str()
                .expect("cible ref vérifiée")
                .to_string()
        })
        .collect::<Vec<_>>();
    let mut target_indices = Vec::with_capacity(child_targets.len());
    for target in &child_targets {
        let matches = shared
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                entry.get("type").and_then(Value::as_str) == Some("story")
                    && typed_ref_target_matches_entry(target, entry)
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.len() != 1 || target_indices.contains(&matches[0]) {
            return None;
        }
        target_indices.push(matches[0]);
    }
    if shared.len() != target_indices.len() + 1
        || shared.iter().enumerate().any(|(index, entry)| {
            index != menu_index
                && (!target_indices.contains(&index)
                    || entry.get("type").and_then(Value::as_str) != Some("story"))
        })
    {
        return None;
    }
    let materialized_children = target_indices
        .iter()
        .map(|index| shared[*index].clone())
        .collect::<Vec<_>>();
    if materialized_children.iter().any(|entry| {
        let mut refs = Vec::new();
        collect_projected_refs(entry, "candidate-story", &mut refs);
        !refs.is_empty()
    }) {
        return None;
    }
    *menu.get_mut("children")? = Value::Array(materialized_children);
    let object = candidate.as_object_mut()?;
    object.insert("entries".to_string(), Value::Array(vec![menu]));
    object.insert("sharedEntries".to_string(), Value::Array(Vec::new()));
    Some(candidate)
}

#[test]
fn e10_root_ref_menu_story_fanout_predicate_is_strict_and_order_preserving() {
    let candidate = json!({
        "entries": [{"type": "ref", "id": "root-ref", "refKind": "continue", "target": "menu:root-menu"}],
        "sharedEntries": [
            {"type": "story", "id": "story-b", "children": []},
            {
                "type": "menu",
                "id": "root-menu",
                "children": [
                    {"type": "ref", "id": "ref-a", "refKind": "continue", "target": "story:story-a"},
                    {"type": "ref", "id": "ref-b", "refKind": "continue", "target": "story:story-b"}
                ]
            },
            {"type": "story", "id": "story-a", "children": []}
        ]
    });
    let materialized = e10_materialize_root_ref_menu_story_fanout(&candidate)
        .expect("le fanout autonome minimal doit être matérialisable");
    assert_eq!(materialized["sharedEntries"], json!([]));
    assert_eq!(
        materialized["entries"][0]["children"]
            .as_array()
            .expect("enfants matérialisés")
            .iter()
            .map(|entry| entry["id"].as_str().expect("id story"))
            .collect::<Vec<_>>(),
        vec!["story-a", "story-b"],
        "l'ordre du menu, et non celui du pool partagé, est conservé"
    );

    let mut duplicate_target = candidate.clone();
    duplicate_target["sharedEntries"][1]["children"][1]["target"] = json!("story:story-a");
    let mut extra_shared = candidate.clone();
    extra_shared["sharedEntries"]
        .as_array_mut()
        .expect("pool")
        .push(json!({"type": "story", "id": "orphan", "children": []}));
    let mut nested_ref = candidate.clone();
    nested_ref["sharedEntries"][0]["children"] =
        json!([{"type": "ref", "id": "nested", "target": "story:story-a"}]);
    let mut missing_target = candidate.clone();
    missing_target["sharedEntries"][1]["children"][0]["target"] = json!("story:missing");
    let mut concrete_root = candidate.clone();
    concrete_root["entries"][0]["type"] = json!("menu");
    let mut return_ref = candidate.clone();
    return_ref["sharedEntries"][1]["children"][0]["refKind"] = json!("return");
    let mut return_root_ref = candidate.clone();
    return_root_ref["entries"][0]["refKind"] = json!("return");
    let mut internal_story_target = candidate.clone();
    internal_story_target["sharedEntries"][1]["children"][0]["target"] =
        json!("story_play:story-a");
    let mut concrete_child = candidate.clone();
    concrete_child["sharedEntries"][1]["children"][0]["type"] = json!("story");

    for negative in [
        duplicate_target,
        extra_shared,
        nested_ref,
        missing_target,
        concrete_root,
        return_ref,
        return_root_ref,
        internal_story_target,
        concrete_child,
    ] {
        assert!(
            e10_materialize_root_ref_menu_story_fanout(&negative).is_none(),
            "le prédicat doit refuser toute relation supplémentaire ou ambiguë"
        );
    }
}

fn collect_typed_project_entry_ids(
    entries: &[crate::domain::project::ProjectEntry],
    ids: &mut BTreeSet<String>,
) {
    for entry in entries {
        ids.insert(entry.id.clone());
        collect_typed_project_entry_ids(&entry.children, ids);
    }
}

fn normalized_asset_name(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .strip_prefix("assets/")
        .unwrap_or(value.trim())
        .to_string()
}

fn source_asset_inventory(raw_document: &Value) -> BTreeSet<String> {
    raw_document
        .get("stageNodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|stage| {
            ["audio", "image"].into_iter().filter_map(move |field| {
                stage
                    .get(field)
                    .and_then(Value::as_str)
                    .map(normalized_asset_name)
                    .filter(|asset| !asset.is_empty())
            })
        })
        .collect()
}

fn collect_projected_asset_inventory(value: &Value, assets: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if matches!(
                    key.as_str(),
                    "audio"
                        | "image"
                        | "itemAudio"
                        | "itemImage"
                        | "rootAudio"
                        | "rootImage"
                        | "nightModeAudio"
                        | "thumbnailImage"
                ) {
                    if let Some(asset) = child.as_str().map(normalized_asset_name) {
                        if !asset.is_empty() {
                            assets.insert(asset);
                        }
                    }
                }
                collect_projected_asset_inventory(child, assets);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_projected_asset_inventory(child, assets);
            }
        }
        _ => {}
    }
}

fn collect_projected_refs(value: &Value, path: &str, refs: &mut Vec<Value>) {
    match value {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("ref") {
                refs.push(json!({
                    "path": path,
                    "id": object.get("id"),
                    "target": object.get("target"),
                    "refKind": object.get("refKind"),
                }));
            }
            for (key, child) in object {
                collect_projected_refs(child, &format!("{path}/{key}"), refs);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_projected_refs(child, &format!("{path}/{index}"), refs);
            }
        }
        _ => {}
    }
}

fn typed_ref_target_matches_entry(target: &str, entry: &Value) -> bool {
    let Some((kind, target_id)) = target.trim().split_once(':') else {
        return false;
    };
    let entry_id = entry.get("id").and_then(Value::as_str);
    let native_stage_id = entry.get("nativeStageId").and_then(Value::as_str);
    if target_id.trim().is_empty()
        || (entry_id != Some(target_id.trim()) && native_stage_id != Some(target_id.trim()))
    {
        return false;
    }
    matches!(
        (kind.trim(), entry.get("type").and_then(Value::as_str)),
        ("menu", Some("menu"))
            | ("story", Some("story"))
            | ("story_play", Some("story"))
            | ("story_home_step", Some("story"))
    )
}

#[test]
#[ignore = "jalon E7 explicite: diagnostics frais des trois DAG convergents privés"]
fn triage_corpus_v2_e7_acyclic_convergent_dag_diagnostics() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let baseline = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("baseline Audit v2");
    let candidates = baseline
        .iter()
        .filter(|row| row.structural_family == "ACYCLIC_CONVERGENT_DAG")
        .map(|row| row.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(candidates.len(), 3, "membres E7 de la famille Audit v2");

    let baseline_by_path = baseline
        .iter()
        .map(|row| (row.relative_path.as_str(), row))
        .collect::<HashMap<_, _>>();
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut diagnostics = Vec::new();

    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let baseline = baseline_by_path[pack.initial.relative_path.as_str()];
        assert_eq!(
            pack.initial.size_bytes, baseline.size_bytes,
            "taille baseline E7"
        );
        assert_eq!(
            pack.initial.last_write_time_utc, baseline.last_write_time_utc,
            "date baseline E7"
        );

        let started = Instant::now();
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let document: StoryDocument =
            serde_json::from_value(raw_document.clone()).expect("StoryDocument");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let (projection, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection fraîche");
        let runtime = analyze_graph(&document).metrics;
        let runtime_root_stage_id = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .map(|stage| stage.uuid.as_str());
        let runtime_stage_kinds = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
            .collect::<HashMap<_, _>>();
        let logical =
            analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);

        let raw_stages = raw_document
            .get("stageNodes")
            .and_then(Value::as_array)
            .expect("stages bruts")
            .iter()
            .filter_map(|stage| {
                stage
                    .get("uuid")
                    .and_then(Value::as_str)
                    .map(|id| (id, stage))
            })
            .collect::<HashMap<_, _>>();
        let raw_actions = raw_document
            .get("actionNodes")
            .and_then(Value::as_array)
            .expect("actions brutes")
            .iter()
            .filter_map(|action| {
                action
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id, action))
            })
            .collect::<HashMap<_, _>>();
        let mut projected_stories = Vec::new();
        collect_projected_stories(
            imported.get("entries").unwrap_or(&Value::Null),
            &mut projected_stories,
        );
        collect_projected_stories(
            imported.get("sharedEntries").unwrap_or(&Value::Null),
            &mut projected_stories,
        );
        let causal_home_equals_ok_stories = projected_stories
            .into_iter()
            .filter(|entry| {
                entry.get("controlSettings").and_then(|controls| controls.get("wheel"))
                    == Some(&Value::Bool(true))
                    && entry.get("titleControlSettings").is_none_or(Value::is_null)
                    && entry.get("returnAfterPlay").is_none()
                    && entry.get("returnOnHome").is_none()
            })
            .map(|entry| {
                let stage_id = entry
                    .get("nativeStageId")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    .expect("story projetée reliée à un stage brut");
                let stage = raw_stages[stage_id];
                let raw_options = raw_stage_action_options(stage, &raw_actions);
                let raw_ok_target = raw_resolved_transition_target(stage, "okTransition", &raw_actions);
                let raw_home_target =
                    raw_resolved_transition_target(stage, "homeTransition", &raw_actions);
                let raw_ok_equals_home = raw_ok_target == raw_home_target;

                // Cette combinaison est exactement la branche `walk_entry` de retour
                // cyclique : une option unique vise déjà `visited`, ce qui transforme le
                // stage roue en story-feuille sans contrôles de titre ni retour explicite.
                assert!(!stage["controlSettings"]["autoplay"].as_bool().unwrap_or(false));
                assert!(stage["controlSettings"]["wheel"].as_bool().unwrap_or(false));
                assert_eq!(raw_options.len(), 1, "branche cycle attendue: {stage_id}");
                assert!(raw_ok_target.is_some(), "OK brut attendu: {stage_id}");
                assert_ne!(
                    raw_ok_target, raw_home_target,
                    "la source ne doit pas déjà violer Home != OK: {stage_id}"
                );
                assert!(
                    raw_ok_reaches_stage(
                        raw_ok_target.as_deref().expect("cible OK"),
                        stage_id,
                        &raw_stages,
                        &raw_actions,
                    ),
                    "la cible OK doit revenir au stage source: {stage_id}"
                );
                assert!(entry.get("titleControlSettings").is_none_or(Value::is_null));
                assert!(entry.get("returnAfterPlay").is_none());
                assert!(entry.get("returnOnHome").is_none());
                let projected_name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .expect("nom de story projetée");
                assert!(
                    projection
                        .topology_gaps
                        .iter()
                        .any(|gap| gap.contains(&format!("Histoire - {projected_name}"))),
                    "le stage causal doit être nommé par l'échec canonique: {stage_id}"
                );

                json!({
                    "stageId": stage_id,
                    "stageName": stage.get("name"),
                    "rawOkOptionCount": raw_options.len(),
                    "rawOkTarget": raw_ok_target,
                    "rawHomeTarget": raw_home_target,
                    "rawOkEqualsHome": raw_ok_equals_home,
                    "walkVisitedTargetState": "inferred true: this final entry shape is emitted only by walk_entry options_len_1 when visited.contains(next)",
                    "walkActivePathState": "not applicable: walk_entry has no active_path; cycle branch is visited.contains(next)",
                    "projectionBranch": "walk_entry/non_autoplay/options_len_1/visited_cycle_story_leaf",
                    "projected": {
                        "id": entry.get("id"),
                        "nativeStageId": entry.get("nativeStageId"),
                        "titleControlSettings": entry.get("titleControlSettings"),
                        "returnAfterPlay": entry.get("returnAfterPlay"),
                        "returnOnHome": entry.get("returnOnHome"),
                        "titleReturnOnHome": entry.get("titleReturnOnHome"),
                        "controlSettings": entry.get("controlSettings"),
                        "audio": entry.get("audio"),
                        "itemAudio": entry.get("itemAudio"),
                        "itemImage": entry.get("itemImage"),
                    },
                    "rawAssets": {
                        "audio": stage.get("audio"),
                        "image": stage.get("image"),
                    },
                })
            })
            .collect::<Vec<_>>();
        let expected_causal_story_count = match pack.initial.relative_path.as_str() {
            r"07\7+ Flora et Colette - Le pendentif du destin.7z" => 15,
            r"07\7+ Les Fabuleuses Aventures de Flora et Colette.7z" => 12,
            r"07\7+ Raconte-moi la ville de Paris.7z" => 2,
            path => panic!("membre E7 inattendu: {path}"),
        };
        assert_eq!(
            causal_home_equals_ok_stories.len(),
            expected_causal_story_count,
            "occurrences feuille roue sans retour explicite"
        );
        let causal_stage_names = causal_home_equals_ok_stories
            .iter()
            .filter_map(|story| story.get("stageName").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        assert_eq!(
            causal_stage_names.len(),
            expected_causal_story_count,
            "les stages causaux doivent avoir des noms distincts"
        );
        let home_equals_ok_error_count = projection
            .topology_gaps
            .iter()
            .map(|gap| {
                gap.matches(
                    "homeTransition et okTransition arrivent sur le même nœud (interdit par STUdio)",
                )
                .count()
            })
            .sum::<usize>();
        assert_eq!(
            home_equals_ok_error_count, expected_causal_story_count,
            "bijection attendue entre stages causaux et erreurs Home=OK"
        );

        let source_assets = source_asset_inventory(&raw_document);
        let mut projected_assets = BTreeSet::new();
        collect_projected_asset_inventory(&imported, &mut projected_assets);
        let absorbed_assets = source_assets
            .difference(&projected_assets)
            .cloned()
            .collect::<Vec<_>>();
        let projected_only_assets = projected_assets
            .difference(&source_assets)
            .cloned()
            .collect::<Vec<_>>();
        let missing_source_assets = classification
            .reason
            .starts_with("Asset(s) référencé(s) absent(s) du ZIP")
            .then_some(classification.reason.clone());
        assert!(
            missing_source_assets.is_none(),
            "un asset physiquement absent ne doit pas être confondu avec un asset absorbé"
        );

        let mut occurrences = BTreeMap::new();
        collect_projected_id_occurrences(
            imported.get("entries").unwrap_or(&Value::Null),
            "entries",
            &mut occurrences,
        );
        collect_projected_id_occurrences(
            imported.get("sharedEntries").unwrap_or(&Value::Null),
            "sharedEntries",
            &mut occurrences,
        );
        let duplicate_projected_ids = occurrences
            .into_iter()
            .filter_map(|(id, occurrences)| (occurrences.len() > 1).then_some((id, occurrences)))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(classification.shared_entry_count, 0);
        assert_eq!(projection.shared_entry_count, 0);
        assert_eq!(projection.projected_ref_count, 0);
        assert!(!projection.uses_graph_projection);
        diagnostics.push(json!({
            "relativePath": pack.initial.relative_path,
            "sizeBytes": pack.initial.size_bytes,
            "lastWriteTimeUtc": pack.initial.last_write_time_utc,
            "baseline": {
                "structuralFamily": baseline.structural_family,
                "runtimeGraph": baseline.runtime_graph,
                "logicalGraph": baseline.logical_graph,
                "projectionMetrics": baseline.projection,
            },
            "classification": {
                "authoringEditable": classification.authoring_editable,
                "readOnlyInspectable": classification.read_only_inspectable,
                "roundTripFaithful": classification.round_trip_faithful,
                "reason": classification.reason,
                "rootEntryCount": classification.root_entry_count,
                "sharedEntryCount": classification.shared_entry_count,
                "hasUnmodeledWheel": classification.has_unmodeled_wheel,
            },
            "runtimeGraph": runtime,
            "logicalGraph": logical,
            "projectionMetrics": projection,
            "projectedIdOccurrences": duplicate_projected_ids,
            "homeEqualsOkLeafCausalStories": causal_home_equals_ok_stories,
            "assetInventory": {
                "sourceReferenced": source_assets,
                "projectedReferenced": projected_assets,
                "missingSourceFiles": missing_source_assets,
                "absorbedByProjection": absorbed_assets,
                "projectedOnly": projected_only_assets,
                "physicalPresenceEvidence": "fresh classify_pack_editability checked every referenced source asset before projection",
            },
            "rawDocument": raw_document,
            "freshProjection": imported,
            "durationMs": started.elapsed().as_millis(),
        }));

        let (size, modified) = file_metadata(pack).expect("métadonnées post-diagnostic");
        assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
        assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
    }

    assert_eq!(diagnostics.len(), candidates.len());
    let output = triage_root(&root)
        .join("Audit v2")
        .join("e7-acyclic-convergent-dag-fresh-diagnostics.json");
    let mut file = File::create(&output).expect("création diagnostic E7");
    serde_json::to_writer_pretty(&mut file, &diagnostics).expect("écriture diagnostic E7");
    file.write_all(b"\n").expect("fin diagnostic E7");
    eprintln!("diagnostic E7 écrit: {}", output.display());
}

#[test]
#[ignore = "jalon E8 explicite: diagnostic frais du DAG partagé privé"]
fn triage_corpus_v2_e8_acyclic_shared_dag_diagnostics() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let baseline = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("baseline Audit v2");
    let candidates = baseline
        .iter()
        .filter(|row| row.structural_family == "ACYCLIC_SHARED_DAG")
        .map(|row| row.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(candidates.len(), 1, "membre E8 de la famille Audit v2");
    let baseline_by_path = baseline
        .iter()
        .map(|row| (row.relative_path.as_str(), row))
        .collect::<HashMap<_, _>>();
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut diagnostics = Vec::new();

    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let baseline = baseline_by_path[pack.initial.relative_path.as_str()];
        assert_eq!(
            pack.initial.size_bytes, baseline.size_bytes,
            "taille baseline E8"
        );
        assert_eq!(
            pack.initial.last_write_time_utc, baseline.last_write_time_utc,
            "date baseline E8"
        );
        let started = Instant::now();
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let document: StoryDocument =
            serde_json::from_value(raw_document.clone()).expect("StoryDocument");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let (projection, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection fraîche");
        let runtime = analyze_graph(&document).metrics;
        let runtime_root_stage_id = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .map(|stage| stage.uuid.as_str());
        let runtime_stage_kinds = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
            .collect::<HashMap<_, _>>();
        let logical =
            analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);

        let raw_stages = raw_document["stageNodes"]
            .as_array()
            .expect("stages bruts E8")
            .iter()
            .filter_map(|stage| stage["uuid"].as_str().map(|id| (id, stage)))
            .collect::<HashMap<_, _>>();
        let raw_actions = raw_document["actionNodes"]
            .as_array()
            .expect("actions brutes E8")
            .iter()
            .filter_map(|action| action["id"].as_str().map(|id| (id, action)))
            .collect::<HashMap<_, _>>();
        let graph_import_only = super::super::graph_import::project_story_graph(&document)
            .expect("projection graphe E8 avant nettoyage night");
        let graph_import_only_root_count = graph_import_only.root_entries.len();
        let graph_import_only_shared_count = graph_import_only.shared_entries.len();
        let mut graph_import_only_ids = BTreeSet::new();
        collect_typed_project_entry_ids(
            &graph_import_only.root_entries,
            &mut graph_import_only_ids,
        );
        collect_typed_project_entry_ids(
            &graph_import_only.shared_entries,
            &mut graph_import_only_ids,
        );
        let hubs = raw_stages
            .values()
            .filter(|stage| {
                stage["controlSettings"]["autoplay"].as_bool() == Some(true)
                    && raw_stage_action_options(stage, &raw_actions).len() == 25
            })
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(hubs.len(), 1, "hub autoplay à 25 branches E8");
        let hub = hubs[0];
        let hub_id = hub["uuid"].as_str().expect("id hub E8");
        let hub_targets = raw_stage_action_options(hub, &raw_actions);
        let hub_branches = hub_targets
            .iter()
            .map(|title_id| {
                let title = raw_stages[*title_id];
                let title_targets = raw_stage_action_options(title, &raw_actions);
                assert_eq!(title_targets.len(), 1, "titre mono-cible: {title_id}");
                let play_id = title_targets[0];
                let play = raw_stages[play_id];
                let play_ok_target = raw_resolved_transition_target(play, "okTransition", &raw_actions);
                let play_home_target = raw_resolved_transition_target(play, "homeTransition", &raw_actions);
                assert!(title["controlSettings"]["wheel"].as_bool().unwrap_or(false));
                assert!(!title["controlSettings"]["autoplay"].as_bool().unwrap_or(false));
                assert!(title.get("audio").and_then(Value::as_str).is_some());
                assert!(title.get("image").and_then(Value::as_str).is_some());
                assert!(play["controlSettings"]["autoplay"].as_bool().unwrap_or(false));
                assert!(play.get("audio").and_then(Value::as_str).is_some());
                assert_eq!(play_ok_target.as_deref(), Some(hub_id));
                assert_eq!(play_home_target.as_deref(), Some(hub_id));
                json!({"titleStageId": title_id, "titleControls": title.get("controlSettings"), "titleAudio": title.get("audio"), "titleImage": title.get("image"), "playStageId": play_id, "playControls": play.get("controlSettings"), "playAudio": play.get("audio"), "playImage": play.get("image"), "playOkTarget": play_ok_target, "playHomeTarget": play_home_target})
            })
            .collect::<Vec<_>>();
        assert_eq!(hub_targets.len(), 25);
        assert!(
            graph_import_only_ids.contains(hub_id),
            "graph_import seul doit encore contenir le hub"
        );
        for title_id in &hub_targets {
            assert!(
                graph_import_only_ids.contains(*title_id),
                "graph_import seul doit encore contenir la branche {title_id}"
            );
        }
        let mut projected_occurrences = BTreeMap::new();
        collect_projected_id_occurrences(
            &imported["entries"],
            "entries",
            &mut projected_occurrences,
        );
        collect_projected_id_occurrences(
            &imported["sharedEntries"],
            "sharedEntries",
            &mut projected_occurrences,
        );
        let projected_ids = projected_occurrences.into_keys().collect::<BTreeSet<_>>();
        let missing_hub_branch_titles = hub_targets
            .iter()
            .filter(|id| !projected_ids.contains::<str>(*id))
            .map(|id| (*id).to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            missing_hub_branch_titles.len(),
            25,
            "le nettoyage night perd les 25 branches"
        );
        assert!(
            !projected_ids.contains(hub_id),
            "le hub est retiré de la projection finale"
        );
        assert_eq!(raw_document["nightModeAvailable"].as_bool(), Some(true));
        assert_eq!(imported["nightMode"].as_bool(), Some(true));
        assert_eq!(imported["nightModeAudio"], hub["audio"]);
        let expected_night_return = format!("story:{}", hub_targets[0]);
        assert_eq!(
            imported["nightModeReturn"].as_str(),
            Some(expected_night_return.as_str()),
            "le faux pont night ne conserve que la première des 25 options"
        );
        assert!(projection.uses_graph_projection);
        let helper_ids = runtime.unreachable_stage_ids.clone();
        assert_eq!(helper_ids.len(), 1, "helper orphelin E8 unique");
        let helper_id = &helper_ids[0];
        let helper = raw_stages[helper_id.as_str()];
        let helper_ok_incoming = raw_stages
            .iter()
            .filter(|(_, stage)| {
                raw_resolved_transition_target(stage, "okTransition", &raw_actions).as_deref()
                    == Some(helper_id.as_str())
            })
            .map(|(id, _)| (*id).to_string())
            .collect::<Vec<_>>();
        let helper_home_incoming = raw_stages
            .iter()
            .filter(|(_, stage)| {
                raw_resolved_transition_target(stage, "homeTransition", &raw_actions).as_deref()
                    == Some(helper_id.as_str())
            })
            .map(|(id, _)| (*id).to_string())
            .collect::<Vec<_>>();
        assert!(helper_ok_incoming.is_empty());
        assert!(helper_home_incoming.is_empty());
        assert_eq!(
            (
                projection.generated_stage_count,
                projection.oracle_stage_count
            ),
            (4, 54)
        );

        let roots = imported["entries"].as_array().expect("racines projetées");
        let shared = imported["sharedEntries"]
            .as_array()
            .expect("entrées partagées projetées");
        let mut root_refs = Vec::new();
        collect_projected_refs(&imported["entries"], "entries", &mut root_refs);
        let mut shared_refs = Vec::new();
        collect_projected_refs(
            &imported["sharedEntries"],
            "sharedEntries",
            &mut shared_refs,
        );
        let direct_root_ref = roots
            .first()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("ref"));
        let direct_root_target = direct_root_ref
            .and_then(|entry| entry.get("target"))
            .and_then(Value::as_str);
        let root_target_shared_index = direct_root_target.and_then(|target| {
            shared
                .iter()
                .position(|entry| typed_ref_target_matches_entry(target, entry))
        });
        let c2a_autonomous_root_ref = roots.len() == 1
            && shared.len() == 1
            && root_refs.len() == 1
            && shared_refs.is_empty()
            && root_target_shared_index.is_some();
        assert_eq!(projection.shared_entry_count, 2, "partage E8 attendu");
        assert_eq!(projection.projected_ref_count, 1, "ref E8 attendue");
        assert!(projection.uses_graph_projection);
        assert!(!c2a_autonomous_root_ref, "E8 ne doit pas satisfaire C2-A");

        let mut occurrences = BTreeMap::new();
        collect_projected_id_occurrences(&imported["entries"], "entries", &mut occurrences);
        collect_projected_id_occurrences(
            &imported["sharedEntries"],
            "sharedEntries",
            &mut occurrences,
        );
        let duplicate_projected_ids = occurrences
            .into_iter()
            .filter_map(|(id, values)| (values.len() > 1).then_some((id, values)))
            .collect::<BTreeMap<_, _>>();
        let mut navigation_references = Vec::new();
        collect_projected_navigation_references(
            &imported,
            "projection",
            &mut navigation_references,
        );
        let shared_identity = shared
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                json!({
                    "index": index,
                    "id": entry.get("id"),
                    "nativeStageId": entry.get("nativeStageId"),
                    "type": entry.get("type"),
                    "incomingReferences": navigation_references.iter().filter(|(_, _, target)| {
                        typed_ref_target_matches_entry(target, entry)
                    }).collect::<Vec<_>>(),
                    "outgoingReferences": navigation_references.iter().filter(|(path, _, _)| {
                        path.starts_with(&format!("projection/sharedEntries/{index}"))
                    }).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();

        let source_assets = source_asset_inventory(&raw_document);
        let mut projected_assets = BTreeSet::new();
        collect_projected_asset_inventory(&imported, &mut projected_assets);
        let absorbed_assets = source_assets
            .difference(&projected_assets)
            .cloned()
            .collect::<Vec<_>>();
        let projected_only_assets = projected_assets
            .difference(&source_assets)
            .cloned()
            .collect::<Vec<_>>();
        let missing_source_assets = classification
            .reason
            .starts_with("Asset(s) référencé(s) absent(s) du ZIP")
            .then_some(classification.reason.clone());
        assert!(
            missing_source_assets.is_none(),
            "assets physiques E8 présents"
        );

        diagnostics.push(json!({
            "relativePath": pack.initial.relative_path,
            "sizeBytes": pack.initial.size_bytes,
            "lastWriteTimeUtc": pack.initial.last_write_time_utc,
            "baseline": {
                "structuralFamily": baseline.structural_family,
                "runtimeGraph": baseline.runtime_graph,
                "logicalGraph": baseline.logical_graph,
                "projectionMetrics": baseline.projection,
            },
            "classification": classification,
            "runtimeGraph": runtime,
            "logicalGraph": logical,
            "projectionMetrics": projection,
            "projectedIdOccurrences": duplicate_projected_ids,
            "assetInventory": {
                "sourceReferenced": source_assets,
                "projectedReferenced": projected_assets,
                "missingSourceFiles": missing_source_assets,
                "absorbedByProjection": absorbed_assets,
                "projectedOnly": projected_only_assets,
                "physicalPresenceEvidence": "fresh classify_pack_editability checked every referenced source asset before projection",
            },
            "sharedDagStructure": {
                "directRootEntryCount": roots.len(),
                "directRootRef": direct_root_ref,
                "allRootRefs": root_refs,
                "directSharedEntryCount": shared.len(),
                "allSharedRefs": shared_refs,
                "sharedEntries": shared_identity,
                "c2aAutonomousRootRefPredicate": c2a_autonomous_root_ref,
                "c2aFailure": "C2-A requires exactly one root ref, exactly one shared entry, no shared ref, and a typed target match",
            },
            "hubAndBranches": {
                "hubStageId": hub_id,
                "hubControls": hub.get("controlSettings"),
                "hubAudio": hub.get("audio"),
                "hubImage": hub.get("image"),
                "hubEffectiveOkTargets": hub_targets,
                "branches": hub_branches,
                "graphImportBeforeNightCleanup": {
                    "rootEntryCount": graph_import_only_root_count,
                    "sharedEntryCount": graph_import_only_shared_count,
                    "containsHub": graph_import_only_ids.contains(hub_id),
                    "containedBranchTitleCount": hub_targets.iter().filter(|id| graph_import_only_ids.contains(**id)).count(),
                },
                "firstProjectionLoss": "detect_imported_night_mode treats the 25-option autoplay hub as a night bridge; remove_projected_night_bridge then removes the hub and all 25 title/play branches, while nightModeReturn keeps only option 0",
                "missingProjectedBranchTitleIds": missing_hub_branch_titles,
            },
            "orphanHelper": {
                "stageId": helper_id,
                "stageName": helper.get("name"),
                "controls": helper.get("controlSettings"),
                "audio": helper.get("audio"),
                "image": helper.get("image"),
                "resolvedOkIncomingStageIds": helper_ok_incoming,
                "resolvedHomeIncomingStageIds": helper_home_incoming,
                "hypotheticalRemoval": {
                    "mutated": false,
                    "generatedStageCountUnchanged": projection.generated_stage_count,
                    "oracleStageCountAfterRemovingOnlyHelper": projection.oracle_stage_count - 1,
                    "missingHubBranchesRemain": hub_targets.len(),
                    "conclusion": "removing the unreachable helper cannot repair night cleanup loss of the 25 title/play branches",
                },
            },
            "rawDocument": raw_document,
            "freshProjection": imported,
            "durationMs": started.elapsed().as_millis(),
        }));
        let (size, modified) = file_metadata(pack).expect("métadonnées post-diagnostic");
        assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
        assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
    }

    assert_eq!(diagnostics.len(), candidates.len());
    let output = triage_root(&root)
        .join("Audit v2")
        .join("e8-acyclic-shared-dag-fresh-diagnostics.json");
    let mut file = File::create(&output).expect("création diagnostic E8");
    serde_json::to_writer_pretty(&mut file, &diagnostics).expect("écriture diagnostic E8");
    file.write_all(b"\n").expect("fin diagnostic E8");
    eprintln!("diagnostic E8 écrit: {}", output.display());
}

#[test]
#[ignore = "jalon E9 explicite: diagnostics frais des huit défauts de projection privés"]
fn triage_corpus_v2_e9_projection_defect_diagnostics() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let baseline = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("baseline Audit v2");
    let candidates = baseline
        .iter()
        .filter(|row| row.structural_family == "PROJECTION_DEFECT")
        .map(|row| row.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(candidates.len(), 8, "membres E9 de la famille Audit v2");
    let baseline_by_path = baseline
        .iter()
        .map(|row| (row.relative_path.as_str(), row))
        .collect::<HashMap<_, _>>();
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut diagnostics = Vec::new();

    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let baseline = baseline_by_path[pack.initial.relative_path.as_str()];
        assert_eq!(
            pack.initial.size_bytes, baseline.size_bytes,
            "taille baseline E9"
        );
        assert_eq!(
            pack.initial.last_write_time_utc, baseline.last_write_time_utc,
            "date baseline E9"
        );
        let started = Instant::now();
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let document: StoryDocument =
            serde_json::from_value(raw_document.clone()).expect("StoryDocument");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let (projection, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection fraîche");
        let runtime = analyze_graph(&document).metrics;
        let runtime_root_stage_id = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .map(|stage| stage.uuid.as_str());
        let runtime_stage_kinds = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
            .collect::<HashMap<_, _>>();
        let logical =
            analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);

        let raw_stages = raw_document["stageNodes"]
            .as_array()
            .expect("stages bruts E9")
            .iter()
            .filter_map(|stage| stage["uuid"].as_str().map(|id| (id, stage)))
            .collect::<HashMap<_, _>>();
        let raw_actions = raw_document["actionNodes"]
            .as_array()
            .expect("actions brutes E9")
            .iter()
            .filter_map(|action| action["id"].as_str().map(|id| (id, action)))
            .collect::<HashMap<_, _>>();
        let mut projected_stories = Vec::new();
        collect_projected_stories(&imported["entries"], &mut projected_stories);
        collect_projected_stories(&imported["sharedEntries"], &mut projected_stories);
        let wheel_leaf_cycle_evidence = projected_stories
            .iter()
            .filter(|entry| {
                entry["controlSettings"]["wheel"].as_bool() == Some(true)
                    && entry.get("returnAfterPlay").is_none()
                    && entry.get("returnOnHome").is_none()
            })
            .filter_map(|entry| {
                let projected_id = entry
                    .get("nativeStageId")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)?;
                let raw_id = raw_stages
                    .contains_key(projected_id)
                    .then_some(projected_id)
                    .or_else(|| {
                        let base = projected_id.split("-sequence-choice-").next()?;
                        raw_stages.contains_key(base).then_some(base)
                    })?;
                let stage = raw_stages[raw_id];
                let ok_target = raw_resolved_transition_target(stage, "okTransition", &raw_actions);
                let home_target = raw_resolved_transition_target(stage, "homeTransition", &raw_actions);
                let cycles_to_source = ok_target.as_deref().is_some_and(|target| {
                    raw_ok_reaches_stage(target, raw_id, &raw_stages, &raw_actions)
                });
                (ok_target != home_target && cycles_to_source).then(|| {
                    json!({"projectedId": projected_id, "rawStageId": raw_id, "rawOkOptionCount": raw_stage_action_options(stage, &raw_actions).len(), "rawOkTarget": ok_target, "rawHomeTarget": home_target, "rawOkEqualsHome": false, "rawOkReachesSource": true, "titleControlSettings": entry.get("titleControlSettings"), "returnAfterPlay": entry.get("returnAfterPlay"), "returnOnHome": entry.get("returnOnHome")})
                })
            })
            .collect::<Vec<_>>();
        let unique_cycle_source_ids = wheel_leaf_cycle_evidence
            .iter()
            .filter_map(|row| row.get("rawStageId").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        let home_equals_ok_error_occurrences = projection
            .topology_gaps
            .iter()
            .map(|gap| {
                gap.matches("homeTransition et okTransition arrivent sur le même nœud")
                    .count()
            })
            .sum::<usize>();
        let mut projected_menus = Vec::new();
        collect_projected_menus(&imported["entries"], &mut projected_menus);
        let projected_menu_audio_absence_evidence = projected_menus
            .iter()
            .filter(|entry| entry.get("audio").is_none_or(Value::is_null))
            .map(|entry| {
                let id = entry
                    .get("nativeStageId")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str);
                let raw_matches = id
                    .into_iter()
                    .flat_map(|id| {
                        raw_stages.iter().filter(move |(raw_id, _)| {
                            id == **raw_id
                                || id.ends_with(&format!("-{raw_id}"))
                                || id.contains(&format!("-{raw_id}-occurrence-"))
                        })
                    })
                    .collect::<Vec<_>>();
                let raw = (raw_matches.len() == 1).then(|| raw_matches[0]);
                json!({"projectedId": id, "projectedAudio": entry.get("audio"), "rawStageMatchCount": raw_matches.len(), "rawStageId": raw.map(|(raw_id, _)| raw_id), "rawAudio": raw.and_then(|(_, stage)| stage.get("audio")), "rawImage": raw.and_then(|(_, stage)| stage.get("image")), "rawControls": raw.and_then(|(_, stage)| stage.get("controlSettings")), "controls": entry.get("controlSettings")})
            })
            .collect::<Vec<_>>();
        if pack.initial.relative_path == r"05\Défi vilain - échappe à Scar !.zip" {
            assert_eq!(projected_menu_audio_absence_evidence.len(), 3);
            assert!(projected_menu_audio_absence_evidence
                .iter()
                .all(|row| row["rawStageMatchCount"].as_u64() == Some(1)));
            assert_eq!(
                projected_menu_audio_absence_evidence
                    .iter()
                    .filter(|row| {
                        row["rawAudio"].is_null()
                            && row["rawImage"].as_str().is_some()
                            && row["rawControls"]["wheel"].as_bool() == Some(true)
                    })
                    .count(),
                2,
                "deux menus Scar sont déjà illustrés mais silencieux dans la source"
            );
            assert_eq!(
                projected_menu_audio_absence_evidence
                    .iter()
                    .filter(|row| {
                        row["projectedAudio"].is_null() && row["rawAudio"].as_str().is_some()
                    })
                    .count(),
                1,
                "un wrapper de suite Scar perd son audio pendant la projection"
            );
        }
        assert!(
            wheel_leaf_cycle_evidence
                .iter()
                .all(|row| row["rawOkOptionCount"].as_u64() == Some(1)
                    && row["rawOkEqualsHome"].as_bool() == Some(false)
                    && row["rawOkReachesSource"].as_bool() == Some(true)),
            "chaque feuille cyclique retenue doit avoir une unique cible OK, distincte de Home, qui rejoint la source"
        );
        if home_equals_ok_error_occurrences > 0 {
            assert_eq!(
                wheel_leaf_cycle_evidence.len(),
                home_equals_ok_error_occurrences,
                "les pertes Home=OK doivent correspondre exactement aux occurrences de feuilles cycliques projetées"
            );
        }
        if matches!(
            pack.initial.relative_path.as_str(),
            r"03\3+ Pompy Super Pompier.7z"
                | r"05\Défi vilain - échappe à Ursula !.zip"
                | r"07\7+ Curieux de Nature !.7z"
        ) {
            assert!(
                !wheel_leaf_cycle_evidence.is_empty(),
                "signature E7 attendue sur le représentant prioritaire"
            );
        }
        let mut occurrences = BTreeMap::new();
        collect_projected_id_occurrences(&imported["entries"], "entries", &mut occurrences);
        collect_projected_id_occurrences(
            &imported["sharedEntries"],
            "sharedEntries",
            &mut occurrences,
        );
        let projected_ids = occurrences.keys().cloned().collect::<BTreeSet<_>>();
        let duplicate_projected_ids = occurrences
            .iter()
            .filter_map(|(id, values)| (values.len() > 1).then_some((id, values)))
            .collect::<BTreeMap<_, _>>();
        let source_stages_not_entry_ids = raw_stages
            .iter()
            .filter(|(id, _)| !projected_ids.contains::<str>(id))
            .map(|(id, stage)| {
                json!({
                    "stageId": id,
                    "name": stage.get("name"),
                    "controls": stage.get("controlSettings"),
                    "audio": stage.get("audio"),
                    "image": stage.get("image"),
                    "okOptionCount": raw_stage_action_options(stage, &raw_actions).len(),
                    "okTarget": raw_resolved_transition_target(stage, "okTransition", &raw_actions),
                    "homeTarget": raw_resolved_transition_target(stage, "homeTransition", &raw_actions),
                })
            })
            .collect::<Vec<_>>();
        let raw_empty_stages = raw_stages
            .iter()
            .filter(|(_, stage)| {
                stage.get("audio").and_then(Value::as_str).is_none()
                    && stage.get("image").and_then(Value::as_str).is_none()
                    && stage.get("okTransition").is_none_or(Value::is_null)
                    && stage.get("homeTransition").is_none_or(Value::is_null)
            })
            .map(|(id, stage)| json!({"stageId": id, "name": stage.get("name"), "controls": stage.get("controlSettings")}))
            .collect::<Vec<_>>();
        let source_assets = source_asset_inventory(&raw_document);
        let mut projected_assets = BTreeSet::new();
        collect_projected_asset_inventory(&imported, &mut projected_assets);
        let absorbed_assets = source_assets
            .difference(&projected_assets)
            .cloned()
            .collect::<Vec<_>>();
        let projected_only_assets = projected_assets
            .difference(&source_assets)
            .cloned()
            .collect::<Vec<_>>();
        let missing_source_assets = classification
            .reason
            .starts_with("Asset(s) référencé(s) absent(s) du ZIP")
            .then_some(classification.reason.clone());

        let projected_depth = projected_menu_depth(&imported["entries"], 0)
            .max(projected_menu_depth(&imported["sharedEntries"], 0));
        let depth_limit_reason = classification.reason.contains("Dossiers imbriqués");

        diagnostics.push(json!({
            "relativePath": pack.initial.relative_path,
            "sizeBytes": pack.initial.size_bytes,
            "lastWriteTimeUtc": pack.initial.last_write_time_utc,
            "baseline": {"structuralFamily": baseline.structural_family, "runtimeGraph": baseline.runtime_graph, "logicalGraph": baseline.logical_graph, "projectionMetrics": baseline.projection},
            "classification": classification,
            "nightMode": {"rawAvailable": raw_document.get("nightModeAvailable"), "projected": imported.get("nightMode"), "projectedAudio": imported.get("nightModeAudio"), "projectedReturn": imported.get("nightModeReturn"), "projectedHomeReturn": imported.get("nightModeHomeReturn"), "projectedEndMessageAutoplay": imported.get("endMessageAutoplay")},
            "runtimeGraph": runtime,
            "logicalGraph": logical,
            "projectionMetrics": projection,
            "generatedOracle": {"generatedStageCount": projection.generated_stage_count, "oracleStageCount": projection.oracle_stage_count, "topologyGaps": projection.topology_gaps, "assetPresenceGaps": projection.asset_presence_gaps},
            "wheelLeafCycleEvidence": {"projectedOccurrenceCount": wheel_leaf_cycle_evidence.len(), "uniqueRawStageCount": unique_cycle_source_ids.len(), "canonicalHomeEqualsOkErrorOccurrences": home_equals_ok_error_occurrences, "entries": wheel_leaf_cycle_evidence},
            "projectedMenuAudioAbsenceEvidence": projected_menu_audio_absence_evidence,
            "depthEvidence": {"projectedMenuDepth": projected_depth, "runtimeDagDepth": runtime.max_dag_depth, "logicalDagDepth": logical.max_dag_depth, "classifierReportsDepthLimit": depth_limit_reason, "note": "the fresh projection tree is measured directly; runtime/logical depths are retained separately and no limit is changed"},
            "projectedIdOccurrences": duplicate_projected_ids,
            "assetInventory": {"sourceReferenced": source_assets, "projectedReferenced": projected_assets, "missingSourceFiles": missing_source_assets, "absorbedByProjection": absorbed_assets, "projectedOnly": projected_only_assets, "physicalPresenceEvidence": "fresh classify_pack_editability checked every referenced source asset before projection"},
            "firstLossCandidates": {"sourceStagesWithoutProjectedEntryId": source_stages_not_entry_ids, "rawEmptyStages": raw_empty_stages, "runtimeUnreachableStageIds": runtime.unreachable_stage_ids, "runtimeUnreachableHelperCount": runtime.unreachable_helper_count, "note": "absence from projected entry ids is a diagnostic candidate only: title/play folding may be intentional; fidelity gaps remain the oracle evidence"},
            "rawDocument": raw_document,
            "freshProjection": imported,
            "durationMs": started.elapsed().as_millis(),
        }));
        let (size, modified) = file_metadata(pack).expect("métadonnées post-diagnostic");
        assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
        assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
    }

    assert_eq!(diagnostics.len(), candidates.len());
    let output = triage_root(&root)
        .join("Audit v2")
        .join("e9-projection-defect-fresh-diagnostics.json");
    let mut file = File::create(&output).expect("création diagnostic E9");
    serde_json::to_writer_pretty(&mut file, &diagnostics).expect("écriture diagnostic E9");
    file.write_all(b"\n").expect("fin diagnostic E9");
    eprintln!("diagnostic E9 écrit: {}", output.display());
}

#[test]
#[ignore = "jalon E10 explicite: diagnostic frais borné des ponts de retour natifs privés"]
fn triage_corpus_v2_e10_native_return_bridge_diagnostics() {
    let default_root = PathBuf::from(
        r"C:\Users\hugs\Documents\LUNIII\Test pack lunii story studio\Classement Story Studio",
    );
    let root = env_path("STORY_STUDIO_TRIAGE_ROOT", &default_root);
    let report_path = triage_root(&root)
        .join("Audit v2")
        .join("read-only-audit-v2.jsonl");
    let baseline = read_jsonl::<ReadOnlyAuditV2>(&report_path).expect("baseline Audit v2");
    let candidates = BTreeSet::from([
        r"05\Histoires farfelues d'orthographe - Les frères S et autres histoires.zip",
        r"05\Histoires farfelues d’orthographe - Le roi Ponctuation et autre histoire.zip",
        r"04\4+]Azuro.zip",
        r"A vérifier\J'aime_Lire_Spécial_Noël.zip",
        r"A vérifier\J'aime_Lire_Vol_01.zip",
        r"A vérifier\J'aime_Lire_Vol_15.zip",
    ]);
    let baseline_by_path = baseline
        .iter()
        .map(|row| (row.relative_path.as_str(), row))
        .collect::<HashMap<_, _>>();
    assert!(
        candidates.iter().all(|path| baseline_by_path
            .get(path)
            .is_some_and(|row| row.structural_family == "NATIVE_RETURN_BRIDGE_REVIEW")),
        "l'échantillon E10 doit rester dans la famille historique de ponts de retour"
    );
    let j_aime_lire_baseline = baseline
        .iter()
        .filter(|row| {
            row.relative_path == r"A vérifier\J'aime_Lire_Spécial_Noël.zip"
                || row
                    .relative_path
                    .starts_with(r"A vérifier\J'aime_Lire_Vol_")
        })
        .collect::<Vec<_>>();
    assert_eq!(j_aime_lire_baseline.len(), 16, "cohorte J'aime Lire E10");
    assert_eq!(
        j_aime_lire_baseline
            .iter()
            .map(|row| row.family_signature.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        1,
        "les 16 J'aime Lire ont la même signature Audit v2"
    );
    assert!(
        j_aime_lire_baseline.iter().all(|row| {
            row.projection.topology_gaps.iter().any(|gap| {
                gap.contains("Quelle histoire vas-tu écouter")
                    && gap.contains("homeTransition boucle sur lui-même")
            })
        }),
        "les 16 J'aime Lire doivent partager le self-loop Home natif"
    );
    let packs = initial_records(&root, "READ_ONLY").expect("baseline lecture seule");
    let mut diagnostics = Vec::new();

    for pack in packs
        .iter()
        .filter(|pack| candidates.contains(pack.initial.relative_path.as_str()))
    {
        let baseline = baseline_by_path[pack.initial.relative_path.as_str()];
        assert_eq!(
            pack.initial.size_bytes, baseline.size_bytes,
            "taille baseline E10"
        );
        assert_eq!(
            pack.initial.last_write_time_utc, baseline.last_write_time_utc,
            "date baseline E10"
        );
        let started = Instant::now();
        let story_json = load_pack_zip(pack.path.to_string_lossy().as_ref()).expect("story.json");
        let raw_document: Value = serde_json::from_str(&story_json).expect("story.json valide");
        let document: StoryDocument =
            serde_json::from_value(raw_document.clone()).expect("StoryDocument");
        let classification = classify_pack_editability(pack.path.to_string_lossy().as_ref())
            .expect("classification fraîche");
        let (projection, imported) =
            projection_for_pack(&raw_document, &classification).expect("projection fraîche");
        let runtime = analyze_graph(&document).metrics;
        let runtime_root_stage_id = document
            .stage_nodes
            .iter()
            .find(|stage| stage.square_one)
            .map(|stage| stage.uuid.as_str());
        let runtime_stage_kinds = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.clone(), stage_kind(stage)))
            .collect::<HashMap<_, _>>();
        let logical =
            analyze_logical_projection(&imported, runtime_root_stage_id, &runtime_stage_kinds);
        let raw_stages = raw_document["stageNodes"]
            .as_array()
            .expect("stages bruts E10")
            .iter()
            .filter_map(|stage| stage["uuid"].as_str().map(|id| (id, stage)))
            .collect::<HashMap<_, _>>();
        let raw_actions = raw_document["actionNodes"]
            .as_array()
            .expect("actions brutes E10")
            .iter()
            .filter_map(|action| action["id"].as_str().map(|id| (id, action)))
            .collect::<HashMap<_, _>>();

        let mut entries = Vec::new();
        collect_projected_entries(&imported["entries"], &mut entries);
        collect_projected_entries(&imported["sharedEntries"], &mut entries);
        let projected_stage_ids = entries
            .iter()
            .filter_map(|entry| projected_entry_stage_identity(entry))
            .filter(|id| raw_stages.contains_key(*id))
            .collect::<BTreeSet<_>>();
        let projected_returns = entries
            .iter()
            .filter_map(|entry| {
                let source_id = projected_entry_stage_identity(entry)?;
                let fields = ["returnAfterPlay", "returnOnHome", "titleReturnOnHome"]
                    .into_iter()
                    .filter_map(|field| {
                        entry
                            .get(field)
                            .and_then(Value::as_str)
                            .map(|target| json!({"field": field, "target": target}))
                    })
                    .collect::<Vec<_>>();
                (!fields.is_empty()).then(|| {
                    json!({
                        "projectedId": entry.get("id"),
                        "nativeStageId": entry.get("nativeStageId"),
                        "sourceStageId": source_id,
                        "type": entry.get("type"),
                        "returns": fields,
                        "controls": entry.get("controlSettings"),
                        "titleControls": entry.get("titleControlSettings"),
                    })
                })
            })
            .collect::<Vec<_>>();
        let raw_return_candidates = raw_stages
            .iter()
            .filter_map(|(id, stage)| {
                let ok_target = raw_resolved_transition_target(stage, "okTransition", &raw_actions);
                let home_target =
                    raw_resolved_transition_target(stage, "homeTransition", &raw_actions);
                let is_back_edge = ok_target.as_deref().is_some_and(|target| {
                    raw_ok_reaches_stage(target, id, &raw_stages, &raw_actions)
                }) || home_target.as_deref().is_some_and(|target| {
                    raw_ok_reaches_stage(target, id, &raw_stages, &raw_actions)
                });
                is_back_edge.then(|| {
                    json!({
                        "stageId": id,
                        "name": stage.get("name"),
                        "controls": stage.get("controlSettings"),
                        "audio": stage.get("audio"),
                        "image": stage.get("image"),
                        "okTarget": ok_target,
                        "homeTarget": home_target,
                        "okOptionCount": raw_stage_action_options(stage, &raw_actions).len(),
                    })
                })
            })
            .collect::<Vec<_>>();
        let raw_stages_without_projected_identity = raw_stages
            .iter()
            .filter(|(id, _)| !projected_stage_ids.contains(**id))
            .map(|(id, stage)| {
                json!({
                    "stageId": id,
                    "name": stage.get("name"),
                    "controls": stage.get("controlSettings"),
                    "audio": stage.get("audio"),
                    "image": stage.get("image"),
                    "okTarget": raw_resolved_transition_target(stage, "okTransition", &raw_actions),
                    "homeTarget": raw_resolved_transition_target(stage, "homeTransition", &raw_actions),
                })
            })
            .collect::<Vec<_>>();
        let raw_empty_stages = raw_stages
            .iter()
            .filter(|(_, stage)| {
                stage.get("audio").and_then(Value::as_str).is_none()
                    && stage.get("image").and_then(Value::as_str).is_none()
                    && stage.get("okTransition").is_none_or(Value::is_null)
                    && stage.get("homeTransition").is_none_or(Value::is_null)
            })
            .map(|(id, stage)| json!({"stageId": id, "name": stage.get("name")}))
            .collect::<Vec<_>>();
        let source_assets = source_asset_inventory(&raw_document);
        let mut projected_assets = BTreeSet::new();
        collect_projected_asset_inventory(&imported, &mut projected_assets);
        let absorbed_assets = source_assets
            .difference(&projected_assets)
            .cloned()
            .collect::<Vec<_>>();
        let projected_only_assets = projected_assets
            .difference(&source_assets)
            .cloned()
            .collect::<Vec<_>>();
        let missing_source_assets = classification
            .reason
            .starts_with("Asset(s) référencé(s) absent(s) du ZIP")
            .then_some(classification.reason.clone());
        let graph_import_only = super::super::graph_import::project_story_graph(&document)
            .expect("projection graphe E10 avant normalisations globales");
        let hypothetical_materialization = e10_materialize_root_ref_menu_story_fanout(&imported)
            .map(|candidate| {
                let mut candidate_project = e10_project_for_fidelity(&candidate);
                candidate_project.native_graph = Some(json!({
                    "preserveForRoundTrip": true,
                    "document": raw_document.clone(),
                }));
                validate_project_structure_for_generation(&candidate_project)
                    .expect("structure candidate E10 générable avant juge");
                let fidelity = canonical_roundtrip_is_faithful(&canonicalize_project(&candidate_project))
                    .expect("juge canonique hypothétique E10");
                let mut candidate_assets = BTreeSet::new();
                collect_projected_asset_inventory(&candidate, &mut candidate_assets);
                json!({
                    "predicateMatched": true,
                    "rootEntryCount": candidate["entries"].as_array().map(Vec::len),
                    "sharedEntryCount": candidate["sharedEntries"].as_array().map(Vec::len),
                    "projectedRefCount": count_projected_type(&candidate["entries"], "ref") + count_projected_type(&candidate["sharedEntries"], "ref"),
                    "structuralValidationPassed": true,
                    "roundTripFaithful": fidelity.faithful,
                    "generatedStageCount": fidelity.generated_stage_count,
                    "oracleStageCount": fidelity.oracle_stage_count,
                    "invalidTransitionCount": fidelity.invalid_transition_count,
                    "assetPresenceGapCount": fidelity.asset_presence_gap_count,
                    "topologyGaps": fidelity.topology_gaps,
                    "assetPresenceGaps": fidelity.asset_presence_gaps,
                    "projectedAssetCount": candidate_assets.len(),
                    "candidate": candidate,
                })
            });
        let roots = imported["entries"]
            .as_array()
            .expect("racines projetées E10");
        let shared = imported["sharedEntries"]
            .as_array()
            .expect("entrées partagées E10");
        let mut root_refs = Vec::new();
        collect_projected_refs(&imported["entries"], "entries", &mut root_refs);
        let mut shared_refs = Vec::new();
        collect_projected_refs(
            &imported["sharedEntries"],
            "sharedEntries",
            &mut shared_refs,
        );
        let direct_root_ref = roots
            .first()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("ref"));
        let direct_root_target = direct_root_ref
            .and_then(|entry| entry.get("target"))
            .and_then(Value::as_str);
        let c2a_target_shared_index = direct_root_target.and_then(|target| {
            shared
                .iter()
                .position(|entry| typed_ref_target_matches_entry(target, entry))
        });
        let c2a_autonomous_root_ref = roots.len() == 1
            && shared.len() == 1
            && root_refs.len() == 1
            && shared_refs.is_empty()
            && c2a_target_shared_index.is_some();

        assert!(
            !projected_returns.is_empty(),
            "tout représentant E10 doit porter des retours authoring observables"
        );
        assert!(
            missing_source_assets.is_none(),
            "assets E10 physiquement présents"
        );
        let c2a_historical_positive = matches!(
            pack.initial.relative_path.as_str(),
            r"05\Histoires farfelues d'orthographe - Les frères S et autres histoires.zip"
                | r"05\Histoires farfelues d’orthographe - Le roi Ponctuation et autre histoire.zip"
        );
        assert_eq!(
            classification.authoring_editable, c2a_historical_positive,
            "seuls les deux positifs historiques C2-A doivent être éditables dans cet échantillon"
        );
        assert_eq!(
            classification.round_trip_faithful, c2a_historical_positive,
            "les négatifs E10 ne doivent pas être déclarés fidèles par le diagnostic"
        );
        let j_aime_lire_sample = pack.initial.relative_path
            == r"A vérifier\J'aime_Lire_Spécial_Noël.zip"
            || pack.initial.relative_path == r"A vérifier\J'aime_Lire_Vol_01.zip"
            || pack.initial.relative_path == r"A vérifier\J'aime_Lire_Vol_15.zip";
        if j_aime_lire_sample {
            assert_eq!(roots.len(), 1, "J'aime Lire a une racine unique");
            let menu = &roots[0];
            assert_eq!(menu.get("type").and_then(Value::as_str), Some("menu"));
            let menu_stage_id = menu
                .get("nativeStageId")
                .and_then(Value::as_str)
                .expect("menu racine J'aime Lire lié à un stage natif");
            assert_eq!(
                raw_resolved_transition_target(
                    raw_stages[menu_stage_id],
                    "homeTransition",
                    &raw_actions
                )
                .as_deref(),
                Some(menu_stage_id),
                "le Home brut du menu racine J'aime Lire boucle sur lui-même"
            );
            assert_eq!(
                menu.get("returnOnHome").and_then(Value::as_str),
                Some(format!("menu:{menu_stage_id}").as_str()),
                "le retour authoring conserve le self-loop Home"
            );
            assert!(projection.topology_gaps.iter().any(|gap| {
                gap.contains("Quelle histoire vas-tu écouter")
                    && gap.contains("homeTransition boucle sur lui-même")
            }));
        }
        if pack.initial.relative_path == r"04\4+]Azuro.zip" {
            let hypothesis = hypothetical_materialization
                .as_ref()
                .expect("Azuro doit satisfaire le prédicat de matérialisation E10");
            assert_eq!(hypothesis["projectedRefCount"].as_u64(), Some(0));
            assert_eq!(hypothesis["sharedEntryCount"].as_u64(), Some(0));
            assert_eq!(
                hypothesis["structuralValidationPassed"].as_bool(),
                Some(true)
            );
            assert_eq!(hypothesis["roundTripFaithful"].as_bool(), Some(true));
            assert_eq!(hypothesis["generatedStageCount"].as_u64(), Some(44));
            assert_eq!(hypothesis["oracleStageCount"].as_u64(), Some(44));
            assert_eq!(hypothesis["invalidTransitionCount"].as_u64(), Some(0));
            assert_eq!(hypothesis["assetPresenceGapCount"].as_u64(), Some(0));
            assert_eq!(raw_document["nightModeAvailable"].as_bool(), Some(true));
            assert_eq!(imported["nightMode"].as_bool(), Some(true));
            assert!(imported["nightModeAudio"].as_str().is_some());
            assert_eq!(imported["nightModeReturn"].as_str(), Some("next_story"));
            assert_eq!(
                imported["nightModeHomeReturn"].as_str(),
                direct_root_target.and_then(navigation_target_id),
                "le retour Home night conserve le menu racine ciblé par la ref"
            );
            assert_eq!(source_assets.len(), 46);
            assert_eq!(projected_assets.len(), 46);
            assert!(absorbed_assets.is_empty());
        } else {
            assert!(
                hypothetical_materialization.is_none(),
                "les négatifs et positifs C2-A ne doivent pas satisfaire le nouveau prédicat de fanout"
            );
        }
        diagnostics.push(json!({
            "relativePath": pack.initial.relative_path,
            "sizeBytes": pack.initial.size_bytes,
            "lastWriteTimeUtc": pack.initial.last_write_time_utc,
            "baseline": {
                "structuralFamily": baseline.structural_family,
                "currentStatus": baseline.current_status,
                "projectionMetrics": baseline.projection,
            },
            "classification": classification,
            "nightMode": {
                "rawAvailable": raw_document.get("nightModeAvailable"),
                "projected": imported.get("nightMode"),
                "projectedAudio": imported.get("nightModeAudio"),
                "projectedReturn": imported.get("nightModeReturn"),
                "projectedHomeReturn": imported.get("nightModeHomeReturn"),
            },
            "runtimeGraph": runtime,
            "logicalGraph": logical,
            "projectionMetrics": projection,
            "generatedOracle": {
                "generatedStageCount": projection.generated_stage_count,
                "oracleStageCount": projection.oracle_stage_count,
                "topologyGaps": projection.topology_gaps,
                "assetPresenceGaps": projection.asset_presence_gaps,
            },
            "returnBridgeEvidence": {
                "projectedReturnEntries": projected_returns,
                "rawBackEdgeCandidates": raw_return_candidates,
                "graphImportBeforeGlobalNormalizations": {
                    "rootEntryCount": graph_import_only.root_entries.len(),
                    "sharedEntryCount": graph_import_only.shared_entries.len(),
                },
                "note": "raw back-edge candidates are observational only; a projected return is representable only when the canonical judge remains faithful",
            },
            "c2aTopology": {
                "directRootEntryCount": roots.len(),
                "directSharedEntryCount": shared.len(),
                "allRootRefs": root_refs,
                "allSharedRefs": shared_refs,
                "directRootRef": direct_root_ref,
                "directRootTargetSharedIndex": c2a_target_shared_index,
                "autonomousRootRefPredicate": c2a_autonomous_root_ref,
                "note": "C2-A is already applied in the fresh import; a false predicate on its two historical positives is expected after their successful promotion",
            },
            "hypotheticalRootRefMenuStoryFanoutMaterialization": hypothetical_materialization,
            "firstLossCandidates": {
                "rawStagesWithoutProjectedIdentity": raw_stages_without_projected_identity,
                "rawEmptyStages": raw_empty_stages,
                "runtimeUnreachableStageIds": runtime.unreachable_stage_ids,
                "runtimeUnreachableHelperCount": runtime.unreachable_helper_count,
                "note": "title/play folding may intentionally hide a raw stage identity; the judge remains the fidelity oracle",
            },
            "assetInventory": {
                "sourceReferenced": source_assets,
                "projectedReferenced": projected_assets,
                "missingSourceFiles": missing_source_assets,
                "absorbedByProjection": absorbed_assets,
                "projectedOnly": projected_only_assets,
            },
            "rawDocument": raw_document,
            "freshProjection": imported,
            "durationMs": started.elapsed().as_millis(),
        }));
        let (size, modified) = file_metadata(pack).expect("métadonnées post-diagnostic");
        assert_eq!(size, pack.initial.size_bytes, "taille modifiée");
        assert_eq!(modified, pack.initial.last_write_time_utc, "date modifiée");
    }

    assert_eq!(diagnostics.len(), candidates.len(), "six représentants E10");
    let output = triage_root(&root)
        .join("Audit v2")
        .join("e10-native-return-bridge-fresh-diagnostics.json");
    let mut file = File::create(&output).expect("création diagnostic E10");
    serde_json::to_writer_pretty(&mut file, &diagnostics).expect("écriture diagnostic E10");
    file.write_all(b"\n").expect("fin diagnostic E10");
    eprintln!("diagnostic E10 écrit: {}", output.display());
}

#[test]
fn indexed_router_is_not_an_interactive_choice() {
    let document = synthetic_document(
        vec![
            synthetic_stage("root", true, false, Some(("root-action", 0))),
            synthetic_stage("a", false, true, Some(("router", 0))),
            synthetic_stage("b", false, true, Some(("router", 1))),
            synthetic_stage("leaf-a", false, true, None),
            synthetic_stage("leaf-b", false, true, None),
        ],
        vec![
            synthetic_action("root-action", vec!["a"]),
            synthetic_action("router", vec!["leaf-a", "leaf-b"]),
        ],
    );
    let analysis = analyze_graph(&document);
    assert_eq!(analysis.metrics.indexed_router_action_count, 1);
    assert_eq!(analysis.metrics.choice_action_count, 0);
    assert_eq!(
        analysis
            .metrics
            .edge_diagnostics
            .iter()
            .filter(|edge| edge.action_node_id.as_deref() == Some("router"))
            .map(|edge| edge.effective_target_ids.len())
            .sum::<usize>(),
        2
    );
}

#[test]
fn autoplay_transition_remains_in_runtime_graph() {
    let document = synthetic_document(
        vec![
            synthetic_stage("root", true, false, Some(("root-action", 0))),
            synthetic_stage("title", false, false, Some(("title-action", 0))),
            synthetic_stage("play", false, true, Some(("play-action", 0))),
            synthetic_stage("next", false, false, None),
        ],
        vec![
            synthetic_action("root-action", vec!["title"]),
            synthetic_action("title-action", vec!["play"]),
            synthetic_action("play-action", vec!["next"]),
        ],
    );
    let analysis = analyze_graph(&document);
    assert_eq!(analysis.metrics.reachable_stage_count, 4);
    let autoplay = analysis
        .metrics
        .edge_diagnostics
        .iter()
        .find(|edge| edge.source_stage_id == "play")
        .expect("autoplay diagnostic");
    assert_eq!(autoplay.trigger, "autoplay");
    assert!(!autoplay.is_global_semantic);
    assert_eq!(autoplay.effective_target_ids, ["next"]);
}

#[test]
fn logical_next_story_is_global_but_typed_return_is_not() {
    let global = json!({
        "entries": [{
            "id": "menu", "type": "menu", "children": [
                {"id": "a", "type": "story", "returnAfterPlay": "next_story"},
                {"id": "b", "type": "story"}
            ]
        }],
        "sharedEntries": []
    });
    let metrics = analyze_logical_projection(&global, None, &HashMap::new());
    assert_eq!(metrics.global_edge_count, 1);
    assert_eq!(metrics.return_edge_count, 0);
    assert_eq!(metrics.strongly_connected_component_count, 0);

    let typed = json!({
        "entries": [{
            "id": "menu", "type": "menu", "children": [
                {"id": "a", "type": "story", "returnAfterPlay": "story:b"},
                {"id": "b", "type": "story"}
            ]
        }],
        "sharedEntries": []
    });
    let metrics = analyze_logical_projection(&typed, None, &HashMap::new());
    assert_eq!(metrics.global_edge_count, 0);
    assert_eq!(metrics.return_edge_count, 1);
    assert_eq!(metrics.convergent_target_count, 1);
}

#[test]
fn logical_runtime_root_and_native_stage_aliases_are_resolved() {
    let imported = json!({
        "entries": [{
            "id": "menu", "nativeStageId": "runtime-menu", "type": "menu", "children": [
                {
                    "id": "story", "nativeStageId": "runtime-title", "_playStageId": "runtime-play",
                    "type": "story", "returnAfterPlay": "menu:runtime-root"
                },
                {"id": "menu-ref", "type": "ref", "target": "menu:runtime-menu"}
            ]
        }],
        "sharedEntries": []
    });
    let metrics = analyze_logical_projection(&imported, Some("runtime-root"), &HashMap::new());
    assert_eq!(metrics.global_edge_count, 1);
    assert_eq!(metrics.reference_edge_count, 1);
    assert_eq!(metrics.missing_target_count, 0);
    let collapsed_return = metrics
        .edge_diagnostics
        .iter()
        .find(|edge| edge.source_id == "story" && edge.trigger == "returnAfterPlay")
        .expect("collapsed story return");
    assert_eq!(collapsed_return.collapse_rule, "title_play");
    assert_eq!(
        collapsed_return.runtime_source_stage_ids,
        ["runtime-title", "runtime-play"]
    );
}

#[test]
fn logical_native_only_return_is_not_reported_missing() {
    let imported = json!({
        "entries": [{
            "id": "story", "type": "story", "returnAfterPlay": "native-return"
        }],
        "sharedEntries": []
    });
    let runtime_stages = HashMap::from([("native-return".to_string(), "play".to_string())]);
    let metrics = analyze_logical_projection(&imported, None, &runtime_stages);
    assert_eq!(metrics.native_only_target_count, 1);
    assert_eq!(metrics.missing_target_count, 0);
    assert!(metrics.edge_diagnostics.iter().any(|edge| {
        edge.target_id.as_deref() == Some("native-return")
            && edge.target_kind.as_deref() == Some("play")
            && edge.resolution_status == "NATIVE_ONLY"
    }));
}

#[test]
fn unresolved_runtime_defect_takes_priority_over_native_only_review() {
    let runtime = GraphMetrics {
        missing_target_count: 1,
        ..GraphMetrics::default()
    };
    let logical = LogicalGraphMetrics {
        native_only_target_count: 1,
        ..LogicalGraphMetrics::default()
    };
    let projection = ProjectionMetrics {
        projected_entry_count: 1,
        ..ProjectionMetrics::default()
    };
    let (family, _, _, _) = family_for_v2(&runtime, &logical, &projection);
    assert_eq!(family, "SOURCE_OR_PROJECTION_DEFECT");
}

#[test]
fn logical_ref_dag_is_acyclic_and_expands_convergence() {
    let imported = json!({
        "entries": [{
            "id": "menu", "type": "menu", "children": [
                {"id": "left", "type": "menu", "children": [
                    {"id": "left-ref", "type": "ref", "target": "story:shared"}
                ]},
                {"id": "right", "type": "menu", "children": [
                    {"id": "right-ref", "type": "ref", "target": "story:shared"}
                ]}
            ]
        }],
        "sharedEntries": [{"id": "shared", "type": "story"}]
    });
    let metrics = analyze_logical_projection(&imported, None, &HashMap::new());
    assert_eq!(metrics.reference_edge_count, 2);
    assert_eq!(metrics.convergent_target_count, 1);
    assert_eq!(metrics.strongly_connected_component_count, 0);
    assert_eq!(metrics.estimated_expanded_entry_count, 5);
}

#[test]
fn logical_return_to_ancestor_stays_a_visible_cycle() {
    let imported = json!({
        "entries": [{
            "id": "menu", "type": "menu", "children": [
                {"id": "story", "type": "story", "returnAfterPlay": "menu:menu"}
            ]
        }],
        "sharedEntries": []
    });
    let metrics = analyze_logical_projection(&imported, None, &HashMap::new());
    assert_eq!(metrics.return_edge_count, 1);
    assert_eq!(metrics.strongly_connected_component_count, 1);
    assert!(metrics
        .cycle_witnesses
        .iter()
        .any(|witness| witness.contains("menu -> story -> menu")));
}

#[test]
fn convergence_is_acyclic_and_counts_duplication() {
    let document = synthetic_document(
        vec![
            synthetic_stage("root", true, false, Some(("root-action", 0))),
            synthetic_stage("left", false, false, Some(("left-action", 0))),
            synthetic_stage("right", false, false, Some(("right-action", 0))),
            synthetic_stage("hub", false, true, None),
        ],
        vec![
            synthetic_action("root-action", vec!["left", "right"]),
            synthetic_action("left-action", vec!["hub"]),
            synthetic_action("right-action", vec!["hub"]),
        ],
    );
    let analysis = analyze_graph(&document);
    assert_eq!(analysis.metrics.strongly_connected_component_count, 0);
    assert_eq!(analysis.metrics.convergent_target_count, 1);
    assert_eq!(analysis.metrics.estimated_expanded_entry_count, 4);
}

#[test]
fn reachable_cycle_is_out_of_scope_but_home_is_not_in_containment_graph() {
    let document = synthetic_document(
        vec![
            synthetic_stage("root", true, false, Some(("root-action", 0))),
            synthetic_stage("a", false, false, Some(("a-action", 0))),
            synthetic_stage("b", false, false, Some(("b-action", 0))),
        ],
        vec![
            synthetic_action("root-action", vec!["a"]),
            synthetic_action("a-action", vec!["b"]),
            synthetic_action("b-action", vec!["a"]),
        ],
    );
    let analysis = analyze_graph(&document);
    assert_eq!(analysis.metrics.strongly_connected_component_count, 1);
    assert_eq!(analysis.metrics.cyclic_stage_count, 2);
    assert!(analysis
        .metrics
        .cycle_witnesses
        .iter()
        .any(|witness| witness.contains("a -> b -> a")));

    let home_document = synthetic_document(
        vec![
            synthetic_stage_with_home(
                "root",
                true,
                false,
                Some(("root-action", 0)),
                Some(("home", 0)),
            ),
            synthetic_stage("story", false, true, None),
        ],
        vec![
            synthetic_action("root-action", vec!["story"]),
            synthetic_action("home", vec!["root"]),
        ],
    );
    let home = analyze_graph(&home_document);
    assert_eq!(home.metrics.strongly_connected_component_count, 0);
    assert_eq!(home.metrics.home_edge_count, 1);
}

#[test]
fn malformed_transition_is_recorded_without_resolving_an_edge() {
    let document = synthetic_document(
        vec![synthetic_stage("root", true, false, Some(("missing", 4)))],
        Vec::new(),
    );
    let analysis = analyze_graph(&document);
    assert_eq!(analysis.metrics.missing_action_count, 1);
    assert_eq!(analysis.metrics.effective_ok_edge_count, 0);
    assert_eq!(
        analysis.metrics.edge_diagnostics[0].resolution_status,
        "ACTION_MISSING"
    );
}

#[test]
fn expansion_saturates_without_allocating_an_expanded_tree() {
    let mut stages = vec![synthetic_stage(
        "root",
        true,
        false,
        Some(("root-action", 0)),
    )];
    let mut actions = vec![synthetic_action("root-action", vec!["n0"])];
    for index in 0..22 {
        let id = format!("n{index}");
        let next = format!("n{}", index + 1);
        stages.push(synthetic_stage(
            &id,
            false,
            false,
            Some((&format!("a{index}"), 0)),
        ));
        actions.push(synthetic_action(&format!("a{index}"), vec![&next]));
    }
    stages.push(synthetic_stage("n23", false, true, None));
    let analysis = analyze_graph(&synthetic_document(stages, actions));
    assert!(analysis.metrics.estimated_expanded_entry_count > 0);
    assert!(!analysis.metrics.expansion_overflow);
}

#[test]
fn partial_jsonl_resume_validates_path_size_and_date() {
    let temp = temp_pack_dir("resume").expect("temporaire");
    let initial = InitialRecord {
        relative_path: "00/test.zip".to_string(),
        size_bytes: 42,
        last_write_time_utc: 123,
        status: "READ_ONLY".to_string(),
        reason: "test".to_string(),
    };
    let pack = CorpusPack {
        initial: initial.clone(),
        path: temp.join("source.zip"),
    };
    let row = ReadOnlyAudit {
        schema_version: REPORT_SCHEMA_VERSION,
        relative_path: initial.relative_path.clone(),
        size_bytes: initial.size_bytes,
        last_write_time_utc: initial.last_write_time_utc,
        initial_status: initial.status,
        current_status: "READ_ONLY".to_string(),
        triage_category: "HIERARCHY_SIMPLE_CANDIDATE".to_string(),
        triage_confidence: "HIGH".to_string(),
        triage_evidence: Vec::new(),
        reason: "test".to_string(),
        graph: GraphMetrics::default(),
        projection: ProjectionMetrics::default(),
        structural_signature: "test".to_string(),
        recommended_expert_action: "test".to_string(),
        duration_ms: 0,
    };
    let report = temp.join("partial.jsonl");
    let mut file = open_partial_report(&report).expect("rapport partiel");
    append_jsonl(&mut file, &row).expect("écriture rapport partiel");
    let loaded = partial_read_only_rows(&report, &[pack]).expect("reprise");
    assert_eq!(loaded.len(), 1);
    assert_eq!(
        loaded["00/test.zip"].triage_category,
        "HIERARCHY_SIMPLE_CANDIDATE"
    );
    fs::remove_dir_all(temp).expect("nettoyage temporaire");
}

fn synthetic_action(id: &str, options: Vec<&str>) -> ActionNode {
    ActionNode {
        id: id.to_string(),
        name: id.to_string(),
        options: options.into_iter().map(str::to_string).collect(),
        position: zero_position(),
    }
}

fn synthetic_stage(
    id: &str,
    square_one: bool,
    autoplay: bool,
    ok: Option<(&str, i32)>,
) -> StageNode {
    synthetic_stage_with_home(id, square_one, autoplay, ok, None)
}

fn synthetic_stage_with_home(
    id: &str,
    square_one: bool,
    autoplay: bool,
    ok: Option<(&str, i32)>,
    home: Option<(&str, i32)>,
) -> StageNode {
    StageNode {
        uuid: id.to_string(),
        name: id.to_string(),
        stage_type: "stage".to_string(),
        square_one,
        audio: None,
        image: None,
        control_settings: crate::native_pack::ControlSettings {
            wheel: !autoplay,
            ok: ok.is_some(),
            home: home.is_some(),
            pause: false,
            autoplay,
        },
        home_transition: home.map(|(action, index)| crate::native_pack::Transition {
            action_node: action.to_string(),
            option_index: index,
        }),
        ok_transition: ok.map(|(action, index)| crate::native_pack::Transition {
            action_node: action.to_string(),
            option_index: index,
        }),
        position: zero_position(),
    }
}

fn synthetic_document(stages: Vec<StageNode>, actions: Vec<ActionNode>) -> StoryDocument {
    StoryDocument {
        title: "synthetic".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: actions,
        stage_nodes: stages,
    }
}

fn zero_position() -> crate::native_pack::Position {
    crate::native_pack::Position {
        x: serde_json::Number::from(0),
        y: serde_json::Number::from(0),
    }
}
