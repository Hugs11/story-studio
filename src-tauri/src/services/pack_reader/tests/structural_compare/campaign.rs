//! Pilote de comparaison : relit un FS produit par une passerelle, applique le
//! comparateur, écrit une ligne de résultat.
//!
//! Ce module **ne convertit rien** : les FS sont produits par un harnais externe
//! de conversion. Il ne lance pas non plus de campagne complète — le point
//! d'entrée est ignoré par défaut et ne traite que le manifeste qu'on lui donne.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::native_pack::StoryDocument;
use crate::services::pack_reader::load_pack_zip;
use crate::support::fs_pack_diagnostics::{read_fs_pack_with_diagnostics, FsPackV1Report};

use super::{compare_structure, StructuralComparison, StructuralVerdict};

pub(crate) const RESULT_SCHEMA_VERSION: u32 = 1;

/// Une ligne du manifeste d'entrée : le ZIP soumis à la passerelle et le dossier FS
/// qu'elle a produit. Le harnais de conversion connaît déjà les deux.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComparisonJob {
    pub(crate) pack_id: String,
    pub(crate) bridge: String,
    pub(crate) source_zip: PathBuf,
    pub(crate) fs_path: PathBuf,
    #[serde(default)]
    pub(crate) bridge_version: Option<String>,
    #[serde(default)]
    pub(crate) bridge_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComparisonRow {
    pub(crate) schema_version: u32,
    pub(crate) pack_id: String,
    pub(crate) bridge: String,
    pub(crate) bridge_version: Option<String>,
    pub(crate) bridge_commit: Option<String>,
    pub(crate) source_zip: String,
    pub(crate) fs_path: String,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) comparison: Option<StructuralComparison>,
    /// Instrumentation de la **relecture** : si un défaut du lecteur se manifeste
    /// enfin sur un FS tiers, il est visible ici et n'est pas imputé en aveugle au
    /// convertisseur.
    pub(crate) readback_reader_report: Option<ReaderCounters>,
}

/// Compteurs de la relecture, réduits à ce qui sert à défalquer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReaderCounters {
    pub(crate) stage_count: usize,
    pub(crate) action_count: usize,
    pub(crate) native_transition_count: usize,
    pub(crate) shared_offset_reuse_count: usize,
    pub(crate) q1_collision_count: usize,
    pub(crate) q2_dropped_option_count: usize,
    pub(crate) q3_mismatch_count: usize,
    pub(crate) q4_out_of_range_count: usize,
    pub(crate) q6_non_uuid_count: usize,
}

impl From<&FsPackV1Report> for ReaderCounters {
    fn from(report: &FsPackV1Report) -> Self {
        Self {
            stage_count: report.stage_count,
            action_count: report.action_count,
            native_transition_count: report.native_transition_count,
            shared_offset_reuse_count: report.shared_offset_reuse_count,
            q1_collision_count: report.q1_collision_count,
            q2_dropped_option_count: report.q2_dropped_option_count,
            q3_mismatch_count: report.q3.mismatch_count,
            q4_out_of_range_count: report.q4_out_of_range_count,
            q6_non_uuid_count: report.q6_non_uuid_count,
        }
    }
}

/// Document source : le `story.json` du ZIP Story Studio soumis à la passerelle.
pub(crate) fn read_source_document(zip_path: &Path) -> Result<StoryDocument, String> {
    let story = load_pack_zip(zip_path.to_string_lossy().as_ref())?;
    serde_json::from_str(&story)
        .map_err(|error| format!("story.json source non modélisable : {error}"))
}

/// Document relu : le FS produit par la passerelle repasse par `fs_pack_reader`,
/// exactement comme à l'import, avec l'instrumentation active.
pub(crate) fn read_fs_document(
    fs_dir: &Path,
    work_dir: &Path,
    title: &str,
) -> Result<(StoryDocument, FsPackV1Report), String> {
    fs::create_dir_all(work_dir).map_err(|error| format!("répertoire de travail : {error}"))?;
    let zip_path = work_dir.join("readback.zip");
    let (report, value) = read_fs_pack_with_diagnostics(fs_dir, &zip_path, title)?;
    let document: StoryDocument = serde_json::from_value(value)
        .map_err(|error| format!("story.json relu non modélisable : {error}"))?;
    Ok((document, report))
}

pub(crate) fn run_job(job: &ComparisonJob, work_root: &Path) -> ComparisonRow {
    let mut row = ComparisonRow {
        schema_version: RESULT_SCHEMA_VERSION,
        pack_id: job.pack_id.clone(),
        bridge: job.bridge.clone(),
        bridge_version: job.bridge_version.clone(),
        bridge_commit: job.bridge_commit.clone(),
        source_zip: job.source_zip.display().to_string(),
        fs_path: job.fs_path.display().to_string(),
        status: "OK".to_string(),
        error: None,
        comparison: None,
        readback_reader_report: None,
    };

    let source = match read_source_document(&job.source_zip) {
        Ok(document) => document,
        Err(error) => {
            row.status = "ERREUR_SOURCE".to_string();
            row.error = Some(error);
            return row;
        }
    };
    let work_dir = work_root.join(format!("{}-{}", job.pack_id, job.bridge));
    let readback = match read_fs_document(&job.fs_path, &work_dir, &job.pack_id) {
        Ok(pair) => pair,
        Err(error) => {
            row.status = "ERREUR_RELECTURE".to_string();
            row.error = Some(error);
            return row;
        }
    };
    row.readback_reader_report = Some(ReaderCounters::from(&readback.1));
    row.comparison = Some(compare_structure(&source, &readback.0));
    row
}

pub(crate) fn read_manifest(path: &Path) -> Result<Vec<ComparisonJob>, String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("manifeste illisible : {error}"))?;
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str::<ComparisonJob>(line)
                .map_err(|error| format!("ligne de manifeste invalide : {error} — {line}"))
        })
        .collect()
}

#[cfg(test)]
mod entry_points {
    use super::*;
    use std::collections::BTreeMap;

    fn env_path(name: &str) -> Option<PathBuf> {
        std::env::var_os(name).map(PathBuf::from)
    }

    /// Bout en bout : manifeste `{packId, bridge, sourceZip, fsPath}` → verdicts.
    ///
    /// ```bash
    /// STORY_STUDIO_D0B_MANIFEST=/chemin/manifeste.jsonl \
    /// STORY_STUDIO_D0B_OUT=/chemin/resultats \
    ///   cargo test --lib structural_compare -- --ignored --nocapture
    /// ```
    ///
    /// Il ne convertit rien et n'ouvre aucun corpus : ce qu'on lui donne, il le
    /// compare.
    #[test]
    #[ignore = "campagne explicite : demande un manifeste de conversions déjà produites"]
    fn compare_declared_conversions() {
        let manifest_path =
            env_path("STORY_STUDIO_D0B_MANIFEST").expect("STORY_STUDIO_D0B_MANIFEST requis");
        let out_dir = env_path("STORY_STUDIO_D0B_OUT")
            .unwrap_or_else(|| std::env::temp_dir().join("story-studio-d0b-comparaison"));
        fs::create_dir_all(&out_dir).expect("répertoire de sortie");
        let work_root = out_dir.join("relectures");

        let jobs = read_manifest(&manifest_path).expect("manifeste");
        assert!(!jobs.is_empty(), "manifeste vide");

        let mut lines = Vec::with_capacity(jobs.len());
        let mut verdicts: BTreeMap<String, usize> = BTreeMap::new();
        for job in &jobs {
            let row = run_job(job, &work_root);
            let verdict = row
                .comparison
                .as_ref()
                .map(|comparison| comparison.verdict.as_str().to_string())
                .unwrap_or_else(|| row.status.clone());
            *verdicts.entry(verdict.clone()).or_insert(0) += 1;
            println!(
                "{} / {} : {}",
                job.pack_id,
                job.bridge,
                row.comparison
                    .as_ref()
                    .map(StructuralComparison::summary)
                    .unwrap_or_else(|| format!(
                        "{} — {}",
                        row.status,
                        row.error.clone().unwrap_or_default()
                    ))
            );
            if let Some(comparison) = row.comparison.as_ref() {
                for gap in &comparison.divergences {
                    println!(
                        "    écart {:?} — {} — {}",
                        gap.code, gap.witness, gap.detail
                    );
                }
                for gap in &comparison.reader_known_losses {
                    println!("    défalqué {:?} — {}", gap.code, gap.detail);
                }
                for ambiguity in &comparison.ambiguities {
                    println!("    ambigu {:?} — {}", ambiguity.code, ambiguity.detail);
                }
            }
            lines.push(serde_json::to_string(&row).expect("ligne JSON"));
        }

        let results_path = out_dir.join("d0b-comparaison.jsonl");
        fs::write(&results_path, lines.join("\n") + "\n").expect("écriture des résultats");
        println!("\n{} ligne(s) → {}", jobs.len(), results_path.display());
        for (verdict, count) in &verdicts {
            println!("  {verdict} : {count}");
        }

        // La condition de réussite du smoke test appartient à l'appelant : ce point
        // d'entrée mesure, il ne rend pas de verdict d'interopérabilité.
        assert_eq!(
            lines.len(),
            jobs.len(),
            "toutes les conversions déclarées doivent produire une ligne"
        );
    }

    /// Smoke test de bout en bout : le même manifeste, mais avec l'exigence minimale :
    /// au moins une passerelle disponible, aucune erreur de relecture,
    /// et un verdict rendu pour chaque conversion.
    #[test]
    #[ignore = "smoke explicite : demande un manifeste de conversions déjà produites"]
    fn smoke_every_declared_bridge_gets_a_verdict() {
        let manifest_path =
            env_path("STORY_STUDIO_D0B_MANIFEST").expect("STORY_STUDIO_D0B_MANIFEST requis");
        let jobs = read_manifest(&manifest_path).expect("manifeste");
        let work_root = std::env::temp_dir().join("story-studio-d0b-smoke");
        let mut bridges: BTreeMap<String, Vec<StructuralVerdict>> = BTreeMap::new();

        for job in &jobs {
            let row = run_job(job, &work_root);
            let comparison = row
                .comparison
                .unwrap_or_else(|| panic!("{} / {} : {:?}", job.pack_id, job.bridge, row.error));
            println!(
                "{} / {} : {}",
                job.pack_id,
                job.bridge,
                comparison.summary()
            );
            for gap in &comparison.divergences {
                println!(
                    "    écart {:?} — {} — {}",
                    gap.code, gap.witness, gap.detail
                );
            }
            bridges
                .entry(job.bridge.clone())
                .or_default()
                .push(comparison.verdict);
        }

        assert!(
            bridges.len() >= 2,
            "le smoke test demande au moins un FS de chaque passerelle disponible ; vu : {:?}",
            bridges.keys().collect::<Vec<_>>()
        );
    }
}
