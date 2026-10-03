//! Préparation de la famille A (packs convertis à l'import).
//!
//! Le point d'entrée ignoré par défaut matérialise les 136 ZIP **produits à
//! l'import**, établit leur topologie source et prouve sur trois packs que leur
//! `story.json` est sémantiquement égal au `nativeGraph.document` conservé par
//! l'import. Il ne lance aucune passerelle et ne modifie aucun pack du corpus.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::native_pack::StoryDocument;
use crate::services::pack_reader::{imported_native_graph_document_for_test, load_pack_zip};
use crate::support::imported_pack::ensure_studio_pack_zip;

const EXPECTED_READ_ONLY: usize = 136;
const PROVENANCE_PROOF_COUNT: usize = 3;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialRecord {
    relative_path: String,
    size_bytes: u64,
    status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V1Record {
    relative_path: String,
    source_format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRow {
    schema_version: u32,
    pack_id: String,
    relative_path: String,
    original_source: String,
    source_format: String,
    source_zip: String,
    source_zip_sha256: String,
    source_zip_bytes: u64,
    stage_count: usize,
    action_count: usize,
    square_one_count: usize,
    cyclic: bool,
    cyclic_stage_count: usize,
    cyclic_component_count: usize,
    self_loop_count: usize,
    provenance_proof_sample: bool,
    native_graph_semantic_equality: Option<bool>,
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("JSONL illisible {} : {error}", path.display()))?;
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect()
}

fn source_pack_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let normalized = relative_path.replace('\\', "/");
    let relative = Path::new(&normalized);
    let state = "02 - Lecture seule";
    let original = root.join(state).join("FR").join(relative);
    if original.is_file() {
        return Ok(original);
    }
    let matches = [
        "01 - Candidat hierarchie simple",
        "02 - Candidat hierarchie avec limite",
        "03 - Defaut de projection ou validation",
        "04 - Hors perimetre hierarchique",
        "05 - Revue expert necessaire",
    ]
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
        [path] => Ok(path.clone()),
        [] => Err(format!(
            "archive du corpus absente : {}",
            original.display()
        )),
        _ => Err(format!(
            "plusieurs archives correspondent à {relative_path} : {}",
            matches
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("ouverture impossible {} : {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("lecture impossible {} : {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn publish_source_zip(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.is_file() {
        // Une reprise ne remplace jamais silencieusement un ZIP déjà valide.
        load_pack_zip(destination.to_string_lossy().as_ref())?;
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("destination sans parent : {}", destination.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staged = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source.zip"),
        uuid::Uuid::new_v4()
    ));
    fs::copy(source, &staged).map_err(|error| {
        format!(
            "copie impossible {} -> {} : {error}",
            source.display(),
            staged.display()
        )
    })?;
    if let Err(error) = fs::rename(&staged, destination) {
        let _ = fs::remove_file(&staged);
        return Err(format!(
            "publication impossible {} : {error}",
            destination.display()
        ));
    }
    Ok(())
}

pub(super) fn resolved_edges(document: &StoryDocument) -> Vec<Vec<usize>> {
    let stage_indices = document
        .stage_nodes
        .iter()
        .enumerate()
        .map(|(index, stage)| (stage.uuid.as_str(), index))
        .collect::<HashMap<_, _>>();
    let actions = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action.options.as_slice()))
        .collect::<HashMap<_, _>>();
    document
        .stage_nodes
        .iter()
        .map(|stage| {
            let mut destinations = Vec::new();
            for transition in [stage.ok_transition.value(), stage.home_transition.value()]
                .into_iter()
                .flatten()
            {
                if let Some(options) = actions.get(transition.action_node.as_str()) {
                    for option in *options {
                        if let Some(index) = option
                            .as_deref()
                            .and_then(|option| stage_indices.get(option))
                        {
                            destinations.push(*index);
                        }
                    }
                }
            }
            destinations.sort_unstable();
            destinations.dedup();
            destinations
        })
        .collect()
}

pub(super) fn cycle_metrics(edges: &[Vec<usize>]) -> (bool, usize, usize, usize) {
    struct Tarjan<'a> {
        edges: &'a [Vec<usize>],
        next_index: usize,
        indices: Vec<Option<usize>>,
        lowlink: Vec<usize>,
        stack: Vec<usize>,
        on_stack: HashSet<usize>,
        cyclic_stages: usize,
        cyclic_components: usize,
    }

    impl Tarjan<'_> {
        fn visit(&mut self, node: usize) {
            let index = self.next_index;
            self.next_index += 1;
            self.indices[node] = Some(index);
            self.lowlink[node] = index;
            self.stack.push(node);
            self.on_stack.insert(node);

            for &target in &self.edges[node] {
                if self.indices[target].is_none() {
                    self.visit(target);
                    self.lowlink[node] = self.lowlink[node].min(self.lowlink[target]);
                } else if self.on_stack.contains(&target) {
                    self.lowlink[node] = self.lowlink[node].min(self.indices[target].unwrap());
                }
            }

            if self.lowlink[node] == self.indices[node].unwrap() {
                let mut component = Vec::new();
                loop {
                    let member = self.stack.pop().expect("pile Tarjan non vide");
                    self.on_stack.remove(&member);
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                let cyclic =
                    component.len() > 1 || self.edges[component[0]].contains(&component[0]);
                if cyclic {
                    self.cyclic_stages += component.len();
                    self.cyclic_components += 1;
                }
            }
        }
    }

    let self_loops = edges
        .iter()
        .enumerate()
        .filter(|(index, targets)| targets.contains(index))
        .count();
    let mut tarjan = Tarjan {
        edges,
        next_index: 0,
        indices: vec![None; edges.len()],
        lowlink: vec![0; edges.len()],
        stack: Vec::new(),
        on_stack: HashSet::new(),
        cyclic_stages: 0,
        cyclic_components: 0,
    };
    for node in 0..edges.len() {
        if tarjan.indices[node].is_none() {
            tarjan.visit(node);
        }
    }
    (
        tarjan.cyclic_components > 0,
        tarjan.cyclic_stages,
        tarjan.cyclic_components,
        self_loops,
    )
}

fn write_jsonl(path: &Path, rows: &[SourceRow]) -> Result<(), String> {
    let mut file = fs::File::create(path)
        .map_err(|error| format!("création impossible {} : {error}", path.display()))?;
    for row in rows {
        serde_json::to_writer(&mut file, row).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[test]
#[ignore = "campagne famille A explicite : demande le corpus local et matérialise 136 ZIP"]
fn prepare_family_a_sources() {
    let corpus_root = std::env::var_os("STORY_STUDIO_D0B_CORPUS_ROOT")
        .map(PathBuf::from)
        .expect("STORY_STUDIO_D0B_CORPUS_ROOT requis");
    let work_dir = std::env::var_os("STORY_STUDIO_D0B_WORK_DIR")
        .map(PathBuf::from)
        .expect("STORY_STUDIO_D0B_WORK_DIR requis");
    let v1_results = std::env::var_os("STORY_STUDIO_D0B_V1_RESULTS")
        .map(PathBuf::from)
        .expect("STORY_STUDIO_D0B_V1_RESULTS requis");
    fs::create_dir_all(&work_dir).expect("répertoire de campagne");
    let sources_dir = work_dir.join("sources");
    fs::create_dir_all(&sources_dir).expect("répertoire des ZIP sources");

    let mut records: Vec<InitialRecord> =
        read_jsonl(&corpus_root.join("classification-results.jsonl"))
            .expect("baseline de classification");
    records.retain(|record| record.status == "READ_ONLY");
    records.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    assert_eq!(records.len(), EXPECTED_READ_ONLY, "baseline READ_ONLY");
    let v1_formats = read_jsonl::<V1Record>(&v1_results)
        .expect("résultats du lecteur")
        .into_iter()
        .map(|row| (row.relative_path, row.source_format))
        .collect::<HashMap<_, _>>();
    assert_eq!(
        v1_formats.len(),
        EXPECTED_READ_ONLY,
        "couverture des résultats du lecteur"
    );

    let proof_paths = {
        let mut by_size = records.clone();
        by_size.sort_by(|left, right| {
            left.size_bytes
                .cmp(&right.size_bytes)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        by_size
            .into_iter()
            .take(PROVENANCE_PROOF_COUNT)
            .map(|record| record.relative_path)
            .collect::<HashSet<_>>()
    };

    let mut rows = Vec::with_capacity(records.len());
    for (index, record) in records.iter().enumerate() {
        let pack_id = format!("A{:03}", index + 1);
        let original = source_pack_path(&corpus_root, &record.relative_path)
            .unwrap_or_else(|error| panic!("{pack_id} : {error}"));
        let original_size = fs::metadata(&original)
            .unwrap_or_else(|error| panic!("{} : {error}", original.display()))
            .len();
        assert_eq!(
            original_size, record.size_bytes,
            "{pack_id} : la source a changé depuis la baseline"
        );
        let import_zip = ensure_studio_pack_zip(original.to_string_lossy().as_ref())
            .unwrap_or_else(|error| panic!("{pack_id} : préparation du ZIP d'import : {error}"))
            .zip_path;
        let destination = sources_dir.join(format!("{pack_id}.zip"));
        publish_source_zip(&import_zip, &destination)
            .unwrap_or_else(|error| panic!("{pack_id} : {error}"));

        let story = load_pack_zip(destination.to_string_lossy().as_ref())
            .unwrap_or_else(|error| panic!("{pack_id} : story.json : {error}"));
        let source_value: serde_json::Value = serde_json::from_str(&story)
            .unwrap_or_else(|error| panic!("{pack_id} : JSON source : {error}"));
        let document: StoryDocument = serde_json::from_value(source_value.clone())
            .unwrap_or_else(|error| panic!("{pack_id} : StoryDocument : {error}"));
        let proof_sample = proof_paths.contains(&record.relative_path);
        let semantic_equality = if proof_sample {
            let native_document =
                imported_native_graph_document_for_test(destination.to_string_lossy().as_ref())
                    .unwrap_or_else(|error| panic!("{pack_id} : import de preuve : {error}"));
            assert_eq!(
                source_value, native_document,
                "{pack_id} : story.json différent de nativeGraph.document"
            );
            Some(true)
        } else {
            None
        };

        let edges = resolved_edges(&document);
        let (cyclic, cyclic_stage_count, cyclic_component_count, self_loop_count) =
            cycle_metrics(&edges);
        let source_format = v1_formats
            .get(&record.relative_path)
            .unwrap_or_else(|| panic!("{pack_id} : format source absent"))
            .clone();
        let source_zip_bytes = fs::metadata(&destination).expect("taille ZIP").len();
        let source_zip_sha256 = sha256_file(&destination).expect("sha256 ZIP");
        let square_one_count = document
            .stage_nodes
            .iter()
            .filter(|stage| stage.is_square_one())
            .count();

        println!(
            "{pack_id}/{} : {} stages, {} actions, cyclique={}, preuve={}",
            EXPECTED_READ_ONLY,
            document.stage_nodes.len(),
            document.action_nodes.len(),
            cyclic,
            proof_sample
        );
        rows.push(SourceRow {
            schema_version: 1,
            pack_id,
            relative_path: record.relative_path.clone(),
            original_source: original.display().to_string(),
            source_format,
            source_zip: destination.display().to_string(),
            source_zip_sha256,
            source_zip_bytes,
            stage_count: document.stage_nodes.len(),
            action_count: document.action_nodes.len(),
            square_one_count,
            cyclic,
            cyclic_stage_count,
            cyclic_component_count,
            self_loop_count,
            provenance_proof_sample: proof_sample,
            native_graph_semantic_equality: semantic_equality,
        });
    }

    assert_eq!(
        rows.iter()
            .filter(|row| row.native_graph_semantic_equality == Some(true))
            .count(),
        PROVENANCE_PROOF_COUNT
    );
    assert!(rows.iter().all(|row| row.square_one_count == 1));
    let manifest = work_dir.join("sources.jsonl");
    write_jsonl(&manifest, &rows).expect("manifeste des sources");
    println!("{} ZIP d'import -> {}", rows.len(), manifest.display());
}
