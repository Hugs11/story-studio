//! Campagne de corpus des trois portes de l'éditeur avancé : ce qu'elles
//! refuseraient sur le corpus éditable, si elles bloquaient.
//!
//! Elle est ignorée par défaut et pilotée par deux variables, comme les autres
//! campagnes de corpus : la bibliothèque est privée et ne quitte pas la machine.
//!
//! ```bash
//! STORY_STUDIO_L07_LIBRARY=/chemin/vers/la/bibliotheque \
//! STORY_STUDIO_L07_OUTPUT=/chemin/vers/le/releve \
//! cargo test --lib l07_ -- --ignored --nocapture
//! ```
//!
//! Deux options supplémentaires, toutes optionnelles (comportement inchangé
//! si absentes) :
//!
//! - `SS_L07_KEEP_DIR` : conserve les sorties. Chaque pack mesuré comme
//!   `editable` est alors généré une seconde fois, et les deux zips sont
//!   copiés dans ce dossier plutôt que détruits, avec un verdict de
//!   déterminisme (octets identiques ou non, et si non, quelles entrées
//!   d'archive diffèrent) porté par chaque ligne du relevé.
//! - `STORY_STUDIO_L07_LIMIT` (déjà existante) : plafonne le nombre de packs mesurés.
//!
//! ## Ce qu'elle mesure, et comment
//!
//! Elle ouvre chaque archive **comme le mode Libre l'ouvre**, puis lance la
//! **vraie** chaîne de production sur le projet obtenu. Les trois portes
//! tournent donc à leur place réelle, sur une archive réellement écrite. Rien
//! n'est simulé : une porte en observation qui ne tournerait pas vraiment ne
//! mesurerait rien.
//!
//! Le relevé se lit pack par pack, avec sa raison. Un compte agrégé ne permet
//! de trancher entre trois hypothèses : défaut du pack, règle trop stricte,
//! défaut de branchement.
//!
//! ## Ce qu'elle mesure aujourd'hui
//!
//! La campagne a d'abord servi de **phase de mesure**, portes en observation.
//! Les portes bloquant désormais, elle sert de campagne de **non-régression** :
//! un pack qu'une porte arrêterait ressort en `generation-error`, avec son
//! motif.
//!
//! Le relevé initial reste transposable sans être rejoué, et c'est prouvé plutôt
//! qu'affirmé : `the_policy_changes_the_right_to_refuse_never_the_finding`
//! établit que la politique change le droit de refuser, jamais le constat.
//!
//! ## Ce qu'elle ne fait pas
//!
//! Elle ne modifie aucune règle et ne conserve aucune archive, sauf demande
//! explicite (`SS_L07_KEEP_DIR`) : par défaut, chaque pack produit est détruit
//! après mesure. Elle n'écrit que son relevé.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use serde_json::json;

use crate::domain::project::Project;
use crate::native_pack::generate_native_pack_v1_with_cancel;
use crate::native_pack::observed_gates::{GateObservation, GateOutcome};
use crate::services::pack_reader::{classify_pack_editability, import_pack_as_free_project};

/// Ce que le contrôle de déterminisme (`SS_L07_KEEP_DIR`) a constaté pour un
/// pack : deux générations du même projet importé, comparées octet à octet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeterminismCheck {
    /// Les octets des deux zips conservés sont strictement identiques.
    identical: bool,
    /// Chemin du premier zip conservé (vide si la conservation a échoué avant
    /// d'y arriver).
    first_zip: String,
    /// Chemin du second zip conservé (vide si la 2e génération, ou sa
    /// conservation, a échoué).
    second_zip: String,
    /// Noms des entrées d'archive dont le contenu, l'absence ou la présence
    /// diffère entre les deux zips. Vide si `identical`, ou si la comparaison
    /// n'a pas pu avoir lieu (voir `second_generation_error`).
    differing_entries: Vec<String>,
    /// Motif si la 2e génération ou sa conservation a échoué avant toute
    /// comparaison possible.
    second_generation_error: Option<String>,
}

/// Une ligne du relevé : un pack, et ce que chaque porte en a dit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackMeasurement {
    relative_path: String,
    size_bytes: u64,
    /// `editable`, `read-only`, `import-error`, `generation-error`.
    status: String,
    /// Le motif, quand le pack n'a pas pu être mesuré.
    reason: Option<String>,
    elapsed_ms: u128,
    observations: Vec<GateObservation>,
    /// Présent seulement si `SS_L07_KEEP_DIR` est posée et que le pack est
    /// `editable`.
    determinism: Option<DeterminismCheck>,
}

impl PackMeasurement {
    fn would_refuse(&self) -> bool {
        self.observations
            .iter()
            .any(|observation| observation.outcome == GateOutcome::WouldRefuse)
    }
}

fn library_root() -> PathBuf {
    PathBuf::from(
        std::env::var("STORY_STUDIO_L07_LIBRARY").expect("STORY_STUDIO_L07_LIBRARY requis"),
    )
}

fn output_root() -> PathBuf {
    PathBuf::from(std::env::var("STORY_STUDIO_L07_OUTPUT").expect("STORY_STUDIO_L07_OUTPUT requis"))
}

/// Le nombre maximal de packs à mesurer, quand la campagne est restreinte à un
/// échantillon. Absent, le corpus entier est parcouru.
fn measurement_limit() -> Option<usize> {
    std::env::var("STORY_STUDIO_L07_LIMIT")
        .ok()
        .and_then(|value| value.parse().ok())
}

/// Dossier où conserver les zips produits deux fois, pour le contrôle de
/// déterminisme (B-06). Absent, aucune conservation : comportement historique
/// inchangé (chaque pack généré une seule fois, sortie détruite).
fn keep_dir() -> Option<PathBuf> {
    std::env::var("SS_L07_KEEP_DIR").ok().map(PathBuf::from)
}

fn library_archives(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
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

/// Nom de fichier stable et sans caractère spécial pour conserver un zip sous
/// `SS_L07_KEEP_DIR`, à partir du chemin relatif (à la bibliothèque) du pack
/// mesuré.
fn keep_file_name(relative_path: &str, suffix: &str) -> String {
    let sanitized: String = relative_path
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{sanitized}{suffix}")
}

/// Lit toutes les entrées d'un zip en mémoire, nom -> octets. Réservé à la
/// comparaison de déterminisme : ces zips restent petits face à la mémoire
/// disponible sur un poste de développement.
fn read_zip_entries(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|error| error.to_string())?;
        entries.insert(name, buffer);
    }
    Ok(entries)
}

/// Compare deux zips entrée par entrée. Vide si identiques ; sinon, le nom de
/// chaque entrée dont le contenu, l'absence ou la présence diffère entre les
/// deux archives.
fn differing_zip_entries(first: &Path, second: &Path) -> Result<Vec<String>, String> {
    let first_entries = read_zip_entries(first)?;
    let second_entries = read_zip_entries(second)?;
    let mut names: BTreeSet<&String> = first_entries.keys().collect();
    names.extend(second_entries.keys());
    let mut differing = Vec::new();
    for name in names {
        match (first_entries.get(name), second_entries.get(name)) {
            (Some(a), Some(b)) if a != b => differing.push(name.clone()),
            (Some(_), None) => differing.push(format!("{name} (absent de la 2e génération)")),
            (None, Some(_)) => differing.push(format!("{name} (absent de la 1re génération)")),
            _ => {}
        }
    }
    Ok(differing)
}

/// Génère le même projet une seconde fois, conserve les deux zips sous
/// `keep_dir`, et dit si leurs octets sont identiques (B-06). `first_zip` est
/// le zip déjà produit par la première génération (celle dont le relevé porte
/// les observations de porte) : il n'est jamais régénéré, seulement copié.
fn check_determinism(
    project: &Project,
    keep_dir: &Path,
    second_output_dir: &Path,
    first_zip: &Path,
    relative_path: &str,
) -> DeterminismCheck {
    let _ = std::fs::create_dir_all(keep_dir);
    let kept_first = keep_dir.join(keep_file_name(relative_path, "-gen1.zip"));
    let kept_second = keep_dir.join(keep_file_name(relative_path, "-gen2.zip"));

    if let Err(error) = std::fs::copy(first_zip, &kept_first) {
        return DeterminismCheck {
            identical: false,
            first_zip: String::new(),
            second_zip: String::new(),
            differing_entries: Vec::new(),
            second_generation_error: Some(format!(
                "copie du 1er zip vers SS_L07_KEEP_DIR impossible : {error}"
            )),
        };
    }

    match generate_native_pack_v1_with_cancel(
        project,
        &second_output_dir.to_string_lossy(),
        &|_| {},
        &|| false,
    ) {
        Ok(second_result) => {
            let second_zip = PathBuf::from(&second_result.zip_path);
            if let Err(error) = std::fs::copy(&second_zip, &kept_second) {
                return DeterminismCheck {
                    identical: false,
                    first_zip: path_display(&kept_first),
                    second_zip: String::new(),
                    differing_entries: Vec::new(),
                    second_generation_error: Some(format!(
                        "copie du 2e zip vers SS_L07_KEEP_DIR impossible : {error}"
                    )),
                };
            }
            let differing_entries = differing_zip_entries(&kept_first, &kept_second)
                .unwrap_or_else(|error| {
                    vec![format!("comparaison des archives impossible : {error}")]
                });
            DeterminismCheck {
                identical: differing_entries.is_empty(),
                first_zip: path_display(&kept_first),
                second_zip: path_display(&kept_second),
                differing_entries,
                second_generation_error: None,
            }
        }
        Err(error) => DeterminismCheck {
            identical: false,
            first_zip: path_display(&kept_first),
            second_zip: String::new(),
            differing_entries: Vec::new(),
            second_generation_error: Some(error),
        },
    }
}

fn path_display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Mesure un pack : import comme le mode Libre, puis production réelle. Si
/// `keep_dir` est posé et que le pack est `editable`, le projet importé est
/// généré une seconde fois et les deux zips sont conservés (`check_determinism`).
fn measure_pack(
    zip_path: &Path,
    library: &Path,
    workspace: &Path,
    keep_dir: Option<&Path>,
) -> PackMeasurement {
    let started = Instant::now();
    let relative_path = zip_path
        .strip_prefix(library)
        .unwrap_or(zip_path)
        .to_string_lossy()
        .to_string();
    let size_bytes = std::fs::metadata(zip_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let finish = |status: &str, reason: Option<String>, observations: Vec<GateObservation>| {
        PackMeasurement {
            relative_path: relative_path.clone(),
            size_bytes,
            status: status.to_string(),
            reason,
            elapsed_ms: started.elapsed().as_millis(),
            observations,
            determinism: None,
        }
    };

    let zip = zip_path.to_string_lossy().to_string();
    match classify_pack_editability(&zip) {
        Err(error) => return finish("import-error", Some(error), Vec::new()),
        Ok(report) if !report.authoring_editable => {
            return finish("read-only", Some(report.reason.clone()), Vec::new())
        }
        Ok(_) => {}
    }

    let extract_dir = workspace.join("import");
    let output_dir = workspace.join("out");
    let second_output_dir = workspace.join("out-2");
    let mut project = match import_pack_as_free_project(&zip, &extract_dir.to_string_lossy()) {
        Ok(project) => project,
        Err(error) => return finish("import-error", Some(error), Vec::new()),
    };
    // Dans l'app, la normalisation du projet donne une identité neuve à un
    // pack repris qui n'en porte pas (`schema.js`), avant même la fiche. Sans
    // cette étape, la campagne mesurait un refus « identité absente » que
    // l'auteur ne rencontre jamais.
    if project.pack_uuid.trim().is_empty() {
        project.pack_uuid = uuid::Uuid::new_v4().to_string();
    }

    let measurement = match generate_native_pack_v1_with_cancel(
        &project,
        &output_dir.to_string_lossy(),
        &|_| {},
        &|| false,
    ) {
        Ok(result) => {
            let first_zip = result.zip_path.clone();
            let mut measurement = finish("editable", None, result.gate_observations);
            if let Some(keep_dir) = keep_dir {
                measurement.determinism = Some(check_determinism(
                    &project,
                    keep_dir,
                    &second_output_dir,
                    Path::new(&first_zip),
                    &measurement.relative_path,
                ));
            }
            measurement
        }
        // Un refus de la chaîne Libre elle-même n'est pas un refus de porte :
        // c'est un pack que la production n'accepte pas aujourd'hui, et le
        // distinguer est ce qui rend le relevé exploitable.
        Err(error) => finish("generation-error", Some(error), Vec::new()),
    };

    let _ = std::fs::remove_dir_all(&extract_dir);
    let _ = std::fs::remove_dir_all(&output_dir);
    let _ = std::fs::remove_dir_all(&second_output_dir);
    measurement
}

#[test]
#[ignore = "campagne corpus locale : STORY_STUDIO_L07_LIBRARY et STORY_STUDIO_L07_OUTPUT requis"]
fn l07_measures_what_the_advanced_gates_would_refuse_on_the_free_corpus() {
    let library = library_root();
    let output = output_root();
    std::fs::create_dir_all(&output).expect("dossier de relevé");

    let mut archives = library_archives(&library);
    assert!(
        !archives.is_empty(),
        "bibliothèque vide : prérequis manquant"
    );
    let attempted_total = archives.len();
    if let Some(limit) = measurement_limit() {
        archives.truncate(limit);
    }

    let workspace = std::env::temp_dir().join(format!("story_studio_l07_{}", std::process::id()));
    std::fs::create_dir_all(&workspace).expect("espace de travail");
    let keep_dir = keep_dir();
    if let Some(dir) = &keep_dir {
        std::fs::create_dir_all(dir).expect("dossier de conservation SS_L07_KEEP_DIR");
    }

    let mut measurements = Vec::new();
    for (index, zip_path) in archives.iter().enumerate() {
        let measurement = measure_pack(zip_path, &library, &workspace, keep_dir.as_deref());
        let determinism_note = match &measurement.determinism {
            Some(check) if check.identical => " — déterminisme OK".to_string(),
            Some(check) => format!(
                " — déterminisme KO ({})",
                check
                    .second_generation_error
                    .clone()
                    .unwrap_or_else(|| format!(
                        "{} entrée(s) diffèrent",
                        check.differing_entries.len()
                    ))
            ),
            None => String::new(),
        };
        println!(
            "[{}/{}] {} — {} ({} ms){}{}",
            index + 1,
            archives.len(),
            measurement.relative_path,
            measurement.status,
            measurement.elapsed_ms,
            if measurement.would_refuse() {
                " — AURAIT REFUSÉ"
            } else {
                ""
            },
            determinism_note
        );
        for observation in &measurement.observations {
            if observation.outcome == GateOutcome::WouldRefuse {
                for reason in &observation.reasons {
                    println!(
                        "      {:?} · {} {} — {}",
                        observation.gate, reason.code, reason.path, reason.message
                    );
                }
            }
        }
        measurements.push(measurement);
    }
    let _ = std::fs::remove_dir_all(&workspace);

    let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_gate_code: BTreeMap<String, usize> = BTreeMap::new();
    for measurement in &measurements {
        *by_status.entry(measurement.status.clone()).or_default() += 1;
        for observation in &measurement.observations {
            for reason in &observation.reasons {
                *by_gate_code
                    .entry(format!("{:?}/{}", observation.gate, reason.code))
                    .or_default() += 1;
            }
        }
    }
    let determinism_checked = measurements
        .iter()
        .filter(|measurement| measurement.determinism.is_some())
        .count();
    let determinism_identical = measurements
        .iter()
        .filter(|measurement| {
            measurement
                .determinism
                .as_ref()
                .is_some_and(|check| check.identical)
        })
        .count();

    let summary = json!({
        "libraryArchives": attempted_total,
        "measured": measurements.len(),
        "byStatus": by_status,
        "byGateCode": by_gate_code,
        "wouldRefuse": measurements.iter().filter(|m| m.would_refuse()).count(),
        "determinismChecked": determinism_checked,
        "determinismIdentical": determinism_identical,
    });
    println!(
        "\n== Synthèse ==\n{}",
        serde_json::to_string_pretty(&summary).unwrap()
    );

    let rows = measurements
        .iter()
        .map(|measurement| serde_json::to_string(measurement).expect("ligne sérialisable"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(output.join("l07-portes-en-observation.jsonl"), rows)
        .expect("écriture du relevé");
    std::fs::write(
        output.join("l07-synthese.json"),
        serde_json::to_string_pretty(&summary).expect("synthèse sérialisable"),
    )
    .expect("écriture de la synthèse");
}
