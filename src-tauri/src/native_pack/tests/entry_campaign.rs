//! Campagne « Écran d'entrée » — les formes que la règle « l'entrée n'est jamais
//! une destination » interdit existent-elles dans les packs réels, après import
//! dans le graphe et après copie par la passerelle ?
//!
//! Elle est ignorée par défaut et pilotée par des variables, comme `l07_campaign.rs` :
//! la bibliothèque est privée et ne quitte pas la machine.
//!
//! ```bash
//! STORY_STUDIO_ENTRY_LIBRARY=/racine/du/corpus \
//! STORY_STUDIO_ENTRY_OUTPUT=/chemin/du/releve.jsonl \
//! cargo test --lib entry_ -- --ignored --nocapture
//! ```
//!
//! `STORY_STUDIO_ENTRY_LIMIT` (optionnelle) plafonne le nombre d'archives, `STORY_STUDIO_ENTRY_SKIP` (optionnelle) en saute les premières, `STORY_STUDIO_ENTRY_STACK_MB` règle la pile du fil de mesure. Le
//! corpus est parcouru récursivement (`.zip` et `.7z`, toutes catégories) ; le
//! dossier `Triage avance` est ignoré.
//!
//! ## Ce qu'elle mesure
//!
//! Pour chaque archive, deux chemins réels, sans simulation :
//!
//! - **graphe** : `import_pack_as_advanced_document`, l'acquisition que l'app
//!   appelle (`acquire_advanced_pack_document`), puis les mesures sur le document ;
//! - **passerelle** : `import_pack_as_free_project` → `graph_copy_of_project` →
//!   relecture du payload d'auteur, mêmes mesures. Le projet par menus lui-même
//!   est mesuré sur sa projection (`project_story_for_simulation`), sans
//!   diagnostics : ils demandent un payload d'auteur.
//!
//! Les diagnostics sont ceux que le vrai code émet
//! (`diagnose_enriched_metadata`), dont les règles de navigation de STUdio
//! (`PORT_RULE_CODES`), comptées à part.
//!
//! Le relevé est écrit ligne à ligne : une panne en cours de campagne ne perd
//! pas ce qui a été mesuré.
//!
//! ## Ce qu'elle ne fait pas
//!
//! Elle ne modifie aucune règle, ne génère aucun pack et n'écrit que son relevé.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use serde_json::json;

use crate::native_pack::authoring::diagnose_enriched_metadata;
use crate::native_pack::graph_copy::graph_copy_of_project;
use crate::native_pack::persistence::decode_authoring_payload;
use crate::native_pack::simulation::project_story_for_simulation;
use crate::native_pack::{OptionSelection, StageNode, StoryDocument};
use crate::services::pack_reader::{
    classify_pack_editability, import_pack_as_advanced_document, import_pack_as_free_project,
};

const PORT_RULE_CODES: &[&str] = &[
    "HOME_LOOPS_TO_SELF",
    "OK_LOOPS_TO_SELF",
    "ENTRY_STAGE_AS_OPTION",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfLoops {
    /// L'Écran d'entrée : son Accueil explicite revient à lui-même.
    entry: bool,
    /// Autres Écrans dont l'Accueil explicite revient à eux-mêmes (admis : des
    /// packs publiés relancent ainsi une question).
    others: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryMeasures {
    /// Nombre d'Écrans `squareOne: true`.
    entry_count: usize,
    /// Options d'Actions dont la cible est l'uuid de l'Écran d'entrée.
    options_to_entry: usize,
    /// Entrée : bouton Accueil actif ET `homeTransition` sans valeur.
    entry_home_active_no_dest: bool,
    explicit_home_self_loops: SelfLoops,
    /// Retours Lunii dérivés (voir `derived_home_returns`).
    derived_home_returns: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmittedDiagnostic {
    code: String,
    level: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentReport {
    measures: EntryMeasures,
    diagnostics: Vec<EmittedDiagnostic>,
    /// Nombre de diagnostics des règles de navigation (`PORT_RULE_CODES`).
    entry_diagnostics: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackRow {
    rel_path: String,
    category: String,
    ext: String,
    editability: serde_json::Value,
    graph: Option<DocumentReport>,
    graph_error: Option<String>,
    gateway: Option<DocumentReport>,
    copy_error: Option<String>,
    /// Le projet par menus (projection), quand il est simple à mesurer.
    menus_project: Option<EntryMeasures>,
}

/// L'Écran d'entrée unique du document, comme `defaultHomeTarget` : `unique`
/// veut dire exactement un Écran `squareOne: true`.
fn unique_entry(document: &StoryDocument) -> Option<&StageNode> {
    let mut entries = document.stage_nodes.iter().filter(|s| s.is_square_one());
    let first = entries.next()?;
    entries.next().is_none().then_some(first)
}

/// Correspondance avec `src/store/advancedGraphView/defaultHomeReturns.js`
/// (`hasDefaultHomeReturn`) : un Écran **autre que l'entrée** dont le bouton
/// Accueil est actif (`presence === 'value'` et `true`, soit `home()`) et dont
/// `homeTransition` n'a pas de valeur (absent ou `null`, soit `!is_value`) ;
/// aucun retour si l'entrée n'est pas unique (`entry.status !== 'unique'`).
fn derived_home_returns(document: &StoryDocument) -> usize {
    let Some(entry) = unique_entry(document) else {
        return 0;
    };
    document
        .stage_nodes
        .iter()
        .filter(|stage| stage.uuid != entry.uuid)
        .filter(|stage| stage.control_settings.home() && !stage.home_transition.is_value())
        .count()
}

/// Vrai si l'Accueil explicite de l'Écran mène à une option qui est l'Écran
/// lui-même. Sélection fixe : l'option d'indice donné ; aléatoire : toute option.
fn home_returns_to_itself(document: &StoryDocument, stage: &StageNode) -> bool {
    let Some(transition) = stage.home_transition.value() else {
        return false;
    };
    let Some(action) = document
        .action_nodes
        .iter()
        .find(|action| action.id == transition.action_node)
    else {
        return false;
    };
    match transition.selection {
        OptionSelection::Fixed(index) => action.option_target(index) == Some(stage.uuid.as_str()),
        OptionSelection::Random => action.named_options().any(|target| target == stage.uuid),
    }
}

fn measure_document(document: &StoryDocument) -> EntryMeasures {
    let entry_count = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.is_square_one())
        .count();
    let entry = document.stage_nodes.iter().find(|s| s.is_square_one());
    let options_to_entry = entry.map_or(0, |entry| {
        document
            .action_nodes
            .iter()
            .flat_map(|action| action.named_options())
            .filter(|target| *target == entry.uuid)
            .count()
    });
    let mut loops = SelfLoops::default();
    for stage in &document.stage_nodes {
        if home_returns_to_itself(document, stage) {
            if stage.is_square_one() {
                loops.entry = true;
            } else {
                loops.others += 1;
            }
        }
    }
    EntryMeasures {
        entry_count,
        options_to_entry,
        entry_home_active_no_dest: entry
            .is_some_and(|e| e.control_settings.home() && !e.home_transition.is_value()),
        explicit_home_self_loops: loops,
        derived_home_returns: derived_home_returns(document),
    }
}

fn report_of_payload(payload: &str) -> Result<DocumentReport, String> {
    let decoded = decode_authoring_payload(payload).map_err(|error| format!("{error:?}"))?;
    let diagnostics: Vec<EmittedDiagnostic> = diagnose_enriched_metadata(&decoded)
        .into_iter()
        .map(|d| EmittedDiagnostic {
            code: d.code,
            level: format!("{:?}", d.level),
        })
        .collect();
    let entry_diagnostics = diagnostics
        .iter()
        .filter(|d| PORT_RULE_CODES.contains(&d.code.as_str()))
        .count();
    Ok(DocumentReport {
        measures: measure_document(&decoded.document),
        diagnostics,
        entry_diagnostics,
    })
}

fn library_root() -> PathBuf {
    PathBuf::from(
        std::env::var("STORY_STUDIO_ENTRY_LIBRARY").expect("STORY_STUDIO_ENTRY_LIBRARY requis"),
    )
}

fn output_file() -> PathBuf {
    PathBuf::from(
        std::env::var("STORY_STUDIO_ENTRY_OUTPUT").expect("STORY_STUDIO_ENTRY_OUTPUT requis"),
    )
}

fn env_number(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
}

fn stack_mb() -> usize {
    env_number("STORY_STUDIO_ENTRY_STACK_MB").unwrap_or(256)
}

fn limit() -> Option<usize> {
    std::env::var("STORY_STUDIO_ENTRY_LIMIT")
        .ok()
        .and_then(|value| value.parse().ok())
}

fn library_archives(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                let skipped = path.file_name().is_some_and(|name| {
                    name.to_string_lossy().eq_ignore_ascii_case("Triage avance")
                });
                if !skipped {
                    walk(&path, found);
                }
            } else if path.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("zip") || extension.eq_ignore_ascii_case("7z")
            }) {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    walk(root, &mut found);
    found.sort();
    found
}

fn relative_path(archive: &Path, library: &Path) -> String {
    archive
        .strip_prefix(library)
        .unwrap_or(archive)
        .to_string_lossy()
        .replace('\\', "/")
}

fn measure_pack(archive: &Path, library: &Path, workspace: &Path) -> PackRow {
    let rel_path = relative_path(archive, library);
    let category = if rel_path.contains('/') {
        rel_path.split('/').next().unwrap_or_default().to_string()
    } else {
        String::new()
    };
    let ext = archive
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let zip = archive.to_string_lossy().to_string();

    let editability = match classify_pack_editability(&zip) {
        Ok(report) => serde_json::to_value(&report)
            .unwrap_or_else(|e| json!({ "serializeError": e.to_string() })),
        Err(error) => json!({ "error": error }),
    };

    // Chemin graphe : la même acquisition que la commande de l'app.
    let assets_dir = workspace.join("graph-assets");
    let (graph, graph_error) =
        match import_pack_as_advanced_document(&zip, &assets_dir.to_string_lossy()) {
            Ok(acquired) => match report_of_payload(&acquired.payload) {
                Ok(report) => (Some(report), None),
                Err(error) => (None, Some(error)),
            },
            Err(error) => (None, Some(error)),
        };

    // Chemin passerelle : projet par menus, puis copie graphe.
    let extract_dir = workspace.join("free-import");
    let (gateway, copy_error, menus_project) =
        match import_pack_as_free_project(&zip, &extract_dir.to_string_lossy()) {
            Ok(project) => {
                let menus = project_story_for_simulation(&project)
                    .ok()
                    .map(|projection| measure_document(&projection.story));
                match graph_copy_of_project(&project) {
                    Ok(copy) => match report_of_payload(&copy.payload) {
                        Ok(report) => (Some(report), None, menus),
                        Err(error) => (None, Some(error), menus),
                    },
                    Err(error) => (None, Some(error), menus),
                }
            }
            Err(error) => (None, Some(format!("import libre : {error}")), None),
        };

    let _ = std::fs::remove_dir_all(&assets_dir);
    let _ = std::fs::remove_dir_all(&extract_dir);
    PackRow {
        rel_path,
        category,
        ext,
        editability,
        graph,
        graph_error,
        gateway,
        copy_error,
        menus_project,
    }
}

#[test]
#[ignore = "campagne corpus locale : STORY_STUDIO_ENTRY_LIBRARY et STORY_STUDIO_ENTRY_OUTPUT requis"]
fn entry_measures_import_and_gateway_on_the_corpus() {
    let library = library_root();
    let output = output_file();
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).expect("dossier de relevé");
    }
    let mut archives = library_archives(&library);
    assert!(
        !archives.is_empty(),
        "bibliothèque vide : prérequis manquant"
    );
    if let Some(skip) = env_number("STORY_STUDIO_ENTRY_SKIP") {
        archives.drain(..skip.min(archives.len()));
    }
    if let Some(limit) = limit() {
        archives.truncate(limit);
    }
    let workspace = std::env::temp_dir().join(format!("story_studio_entry_{}", std::process::id()));
    std::fs::create_dir_all(&workspace).expect("espace de travail");
    let mut file = std::fs::File::create(&output).expect("relevé");

    let started = Instant::now();
    let mut totals: BTreeMap<String, usize> = BTreeMap::new();
    let mut bump = |key: &str, by: usize| *totals.entry(key.to_string()).or_default() += by;
    for (index, archive) in archives.iter().enumerate() {
        // Le fil de test n'a que 2 Mo de pile : une acquisition profonde y
        // déborde, ce que rien ne rattrape. Un fil dédié, à pile réglable
        // (`STORY_STUDIO_ENTRY_STACK_MB`, 256 par défaut ; 2 pour reproduire
        // les conditions du fil bloquant de l'app), garde la campagne vivante.
        let attempt = std::thread::scope(|scope| {
            std::thread::Builder::new()
                .name("entry-campaign-pack".to_string())
                .stack_size(stack_mb() * 1024 * 1024)
                .spawn_scoped(scope, || measure_pack(archive, &library, &workspace))
                .expect("fil de mesure")
                .join()
        });
        let row = attempt.unwrap_or_else(|_| PackRow {
            rel_path: relative_path(archive, &library),
            category: String::new(),
            ext: String::new(),
            editability: json!({ "error": "panic" }),
            graph: None,
            graph_error: Some("panic pendant la mesure".to_string()),
            gateway: None,
            copy_error: Some("panic pendant la mesure".to_string()),
            menus_project: None,
        });
        println!("[{}/{}] {}", index + 1, archives.len(), row.rel_path);
        bump("archives", 1);
        for (label, report) in [("graph", &row.graph), ("gateway", &row.gateway)] {
            match report {
                Some(report) => {
                    let m = &report.measures;
                    bump(&format!("{label}.measured"), 1);
                    bump(&format!("{label}.optionsToEntry"), m.options_to_entry);
                    bump(
                        &format!("{label}.packsWithOptionsToEntry"),
                        usize::from(m.options_to_entry > 0),
                    );
                    bump(
                        &format!("{label}.entryHomeActiveNoDest"),
                        usize::from(m.entry_home_active_no_dest),
                    );
                    bump(
                        &format!("{label}.entrySelfLoop"),
                        usize::from(m.explicit_home_self_loops.entry),
                    );
                    bump(
                        &format!("{label}.otherSelfLoopPacks"),
                        usize::from(m.explicit_home_self_loops.others > 0),
                    );
                    bump(
                        &format!("{label}.derivedHomeReturns"),
                        m.derived_home_returns,
                    );
                    bump(
                        &format!("{label}.packsWithEntryDiagnostic"),
                        usize::from(report.entry_diagnostics > 0),
                    );
                }
                None => bump(&format!("{label}.errors"), 1),
            }
        }
        writeln!(
            file,
            "{}",
            serde_json::to_string(&row).expect("ligne sérialisable")
        )
        .and_then(|_| file.flush())
        .expect("écriture du relevé");
    }
    let _ = std::fs::remove_dir_all(&workspace);
    let summary = json!({ "elapsedSec": started.elapsed().as_secs(), "totals": totals });
    println!(
        "\n== Synthèse ==\n{}",
        serde_json::to_string_pretty(&summary).unwrap()
    );
}

// Contre-épreuve : les mesures comptent ce qu'elles prétendent compter.

fn document_of(stages: serde_json::Value, actions: serde_json::Value) -> StoryDocument {
    let story = json!({
        "title": "Mesure", "version": 1, "description": "", "format": "v1",
        "nightModeAvailable": false, "stageNodes": stages, "actionNodes": actions,
    });
    crate::native_pack::decode_story_document(&story.to_string())
        .expect("document d'essai")
        .document
}

fn controls(home: bool) -> serde_json::Value {
    json!({ "wheel": false, "ok": true, "home": home, "pause": false, "autoplay": false })
}

fn stage(
    uuid: &str,
    entry: bool,
    home: bool,
    home_transition: serde_json::Value,
) -> serde_json::Value {
    json!({
        "uuid": uuid, "type": "stage", "squareOne": entry, "audio": format!("{uuid}.mp3"),
        "controlSettings": controls(home),
        "okTransition": null, "homeTransition": home_transition,
    })
}

#[test]
fn entry_measures_count_the_forbidden_shapes_and_only_them() {
    // Formes interdites : un choix vise l'entrée, et l'entrée a Accueil actif
    // sans destination. « other » a lui aussi Accueil actif sans destination.
    let bad = document_of(
        json!([
            stage("entry", true, true, json!(null)),
            stage("other", false, true, json!(null))
        ]),
        json!([{ "id": "root", "name": "", "options": ["other", "entry"] }]),
    );
    let measures = measure_document(&bad);
    assert_eq!(measures.options_to_entry, 1);
    assert!(measures.entry_home_active_no_dest);
    assert_eq!(measures.derived_home_returns, 1);
    assert_eq!(measures.explicit_home_self_loops, SelfLoops::default());

    // Un Accueil explicite qui ramène « other » sur lui-même est compté à part.
    let looping = document_of(
        json!([
            stage("entry", true, false, json!(null)),
            stage(
                "other",
                false,
                true,
                json!({"actionNode": "root", "optionIndex": 0})
            )
        ]),
        json!([{ "id": "root", "name": "", "options": ["other"] }]),
    );
    let looping = measure_document(&looping);
    assert!(!looping.explicit_home_self_loops.entry);
    assert_eq!(looping.explicit_home_self_loops.others, 1);
    assert_eq!(looping.derived_home_returns, 0);

    // Document sain : rien à compter.
    let healthy = document_of(
        json!([
            stage("entry", true, false, json!(null)),
            stage("other", false, false, json!(null))
        ]),
        json!([{ "id": "root", "name": "", "options": ["other"] }]),
    );
    assert_eq!(
        measure_document(&healthy),
        EntryMeasures {
            entry_count: 1,
            ..EntryMeasures::default()
        }
    );
}
