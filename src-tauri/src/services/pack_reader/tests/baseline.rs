//! Baseline métriques d'import (Étape 2d) — garde-fou observationnel.
//!
//! `#[ignore]` : ne tourne pas en CI (les packs sont hors repo). Lancer explicitement :
//!   $env:STORY_STUDIO_BASELINE_DIR="C:\chemin\vers\packs"; \
//!   cargo test --manifest-path src-tauri/Cargo.toml baseline_import -- --ignored --nocapture
//!
//! Le dossier peut contenir un `story.json` direct ou des sous-dossiers `<pack>/story.json`.
//! Les packs absents sont simplement ignorés. Sert à comparer AVANT/APRÈS les
//! changements d'import : compteurs bruts, classes d'arêtes, projection, sortie d'import.

use super::*;

fn baseline_dir() -> Option<PathBuf> {
    std::env::var_os("STORY_STUDIO_BASELINE_DIR").map(PathBuf::from)
}

fn baseline_story_paths() -> Vec<(String, PathBuf)> {
    let Some(dir) = baseline_dir() else {
        return Vec::new();
    };
    let direct_story = dir.join("story.json");
    if direct_story.is_file() {
        let label = dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("PACK")
            .to_string();
        return vec![(label, direct_story)];
    }

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut packs: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path().join("story.json");
            if !path.is_file() {
                return None;
            }
            let label = entry.file_name().to_string_lossy().to_string();
            Some((label, path))
        })
        .collect();
    packs.sort_by(|left, right| left.0.cmp(&right.0));
    packs
}

fn assets_from_doc(doc: &serde_json::Value) -> HashMap<String, PathBuf> {
    let mut assets = HashMap::new();
    if let Some(stages) = doc.get("stageNodes").and_then(|v| v.as_array()) {
        for s in stages {
            for key in ["audio", "image"] {
                if let Some(name) = s.get(key).and_then(|v| v.as_str()) {
                    assets.insert(name.to_string(), PathBuf::from(name));
                }
            }
        }
    }
    assets
}

fn index_doc(
    doc: &serde_json::Value,
) -> (
    HashMap<&str, &serde_json::Value>,
    HashMap<&str, &serde_json::Value>,
    Option<String>,
) {
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
    let square = doc
        .get("stageNodes")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|s| {
                s.get("squareOne")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
        })
        .and_then(|s| s.get("uuid").and_then(|u| u.as_str()))
        .map(str::to_string);
    (stages, actions, square)
}

#[derive(Default)]
struct EdgeClassTotals {
    ok: usize,
    choice: usize,
    home: usize,
    unresolved: usize,
}

fn edge_class_totals(
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> EdgeClassTotals {
    let empty = HashSet::new();
    let mut totals = EdgeClassTotals::default();
    for stage in stages.values() {
        for edge in classify_stage_edges(stage, stages, actions, &empty) {
            match edge.class {
                EdgeClass::Ok => totals.ok += 1,
                EdgeClass::ChoiceOption => totals.choice += 1,
                EdgeClass::Home => totals.home += 1,
                EdgeClass::GlobalNight => {}
                EdgeClass::Unresolved => totals.unresolved += 1,
            }
        }
    }
    totals
}

fn count_imported(entries: &[serde_json::Value], counts: &mut (usize, usize, usize)) {
    for e in entries {
        match e.get("type").and_then(|v| v.as_str()).unwrap_or("story") {
            "menu" => counts.0 += 1,
            "ref" => counts.2 += 1,
            _ => counts.1 += 1,
        }
        if let Some(children) = e.get("children").and_then(|v| v.as_array()) {
            count_imported(children, counts);
        }
    }
}

fn run_metrics(label: &str, path: &Path) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        println!("\n=== {label} === SKIP (absent: {})", path.display());
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("parse story.json");
    let (stages, actions, square) = index_doc(&doc);
    let totals = edge_class_totals(&stages, &actions);
    let proj: ProjectionStats = square
        .as_deref()
        .map(|sq| project_graph(sq, &stages, &actions, &HashSet::new()))
        .unwrap_or_default();

    let assets = assets_from_doc(&doc);
    let graph_import = serde_json::from_value::<crate::native_pack::StoryDocument>(doc.clone())
        .ok()
        .and_then(|document| {
            super::super::graph_import::project_story_graph_values(&document, &assets).ok()
        });
    let result = walk_story_doc_to_entries(&doc, &assets).expect("import");
    let entries = result
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut imported = (0usize, 0usize, 0usize);
    count_imported(&entries, &mut imported);
    let native_graph = result
        .get("nativeGraph")
        .map(|v| !v.is_null())
        .unwrap_or(false);
    let uses_graph_projection = result
        .get("usesGraphProjection")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let shared_entries = result
        .get("sharedEntries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    println!("\n=== {label} ===");
    println!(
        "brut          : stages={} actions={}",
        stages.len(),
        actions.len()
    );
    println!(
        "classes arêtes: ok={} choix={} home={} unresolved={}",
        totals.ok, totals.choice, totals.home, totals.unresolved
    );
    println!(
        "projection    : containment={} reference={} home={} unresolved={}",
        proj.containment, proj.reference, proj.home, proj.unresolved
    );
    if let Some(graph_import) = graph_import {
        println!(
            "graph import  : root={} shared={} diagnostics={}",
            graph_import.root_entries.len(),
            graph_import.shared_entries.len(),
            graph_import.diagnostics.len()
        );
        for diagnostic in graph_import.diagnostics.iter().take(5) {
            println!("  - {diagnostic}");
        }
    }
    println!(
        "import actuel : top={} menus={} stories={} refs={} nativeGraph={} usesGraphProjection={}",
        entries.len(),
        imported.0,
        imported.1,
        imported.2,
        native_graph,
        uses_graph_projection
    );
    if !shared_entries.is_empty() {
        let sample: Vec<String> = shared_entries
            .iter()
            .take(5)
            .map(|entry| {
                format!(
                    "{}:{}",
                    entry
                        .get("type")
                        .and_then(|value| value.as_str())
                        .unwrap_or("?"),
                    entry
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("?")
                )
            })
            .collect();
        println!(
            "shared actuel : count={} sample={}",
            shared_entries.len(),
            sample.join(", ")
        );
    }
}

#[test]
#[ignore]
fn baseline_import_metrics() {
    let packs = baseline_story_paths();
    if packs.is_empty() {
        println!("[BASELINE] SKIP - definir STORY_STUDIO_BASELINE_DIR");
        return;
    }
    for (label, path) in packs {
        run_metrics(&label, &path);
    }
}
