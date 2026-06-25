//! Baseline métriques d'import (Étape 2d) — garde-fou observationnel.
//!
//! `#[ignore]` : ne tourne pas en CI (les packs sont hors repo). Lancer explicitement :
//!   $env:STORY_STUDIO_BASELINE_DIR="C:\chemin\vers\packs"; \
//!   cargo test --manifest-path src-tauri/Cargo.toml baseline_import -- --ignored --nocapture
//!
//! Le dossier doit contenir `lapin/story.json`, `ders/story.json`, `best/story.json`
//! (les packs absents sont simplement ignorés). Sert à comparer AVANT/APRÈS les
//! changements d'import : compteurs bruts, classes d'arêtes, projection, sortie d'import.

use super::*;

fn baseline_dir() -> String {
    std::env::var("STORY_STUDIO_BASELINE_DIR")
        .unwrap_or_else(|_| "C:\\Users\\hugs\\AppData\\Local\\Temp\\lunii_audit".to_string())
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
            arr.iter()
                .find(|s| s.get("squareOne").and_then(|v| v.as_bool()).unwrap_or(false))
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

fn run_metrics(label: &str, subdir: &str) {
    let path = format!("{}/{}/story.json", baseline_dir(), subdir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        println!("\n=== {label} === SKIP (absent: {path})");
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

    println!("\n=== {label} ===");
    println!("brut          : stages={} actions={}", stages.len(), actions.len());
    println!(
        "classes arêtes: ok={} choix={} home={} unresolved={}",
        totals.ok, totals.choice, totals.home, totals.unresolved
    );
    println!(
        "projection    : containment={} reference={} home={} unresolved={}",
        proj.containment, proj.reference, proj.home, proj.unresolved
    );
    println!(
        "import actuel : top={} menus={} stories={} refs={} nativeGraph={}",
        entries.len(),
        imported.0,
        imported.1,
        imported.2,
        native_graph
    );
}

#[test]
#[ignore]
fn baseline_import_metrics() {
    for (label, subdir) in [
        ("LAPIN", "lapin"),
        ("DERSOUZALA", "ders"),
        ("BESTIOLES", "best"),
    ] {
        run_metrics(label, subdir);
    }
}
