//! La relecture réelle d'une archive écrite, et son contrôle exact.
//!
//! Ce module porte le contrôle que l'export avancé exécutait à son étape 12.
//! Il en sort ici pour une raison précise : la chaîne Libre branche ce même
//! contrôle, et un second contrôle écrit en miroir aurait divergé du premier à
//! la première correction. Il y a donc **un** relecteur d'archive, et
//! deux appelants qui lui décrivent leurs attentes.
//!
//! Il vérifie quatre égalités, sur l'artefact lui-même :
//!
//! 1. `story.json` relu est **exactement** ce que la sérialisation a produit ;
//! 2. chaque entrée `assets/` porte le **SHA-256 exact** de la sortie que la
//!    préparation a enregistrée sous ce nom ;
//! 3. l'ensemble des entrées `assets/` est **exactement** celui des noms
//!    distincts attendus — ni fichier orphelin, ni fichier manquant ;
//! 4. les références médias que le `story.json` relu porte **réellement**
//!    désignent une entrée présente, et chaque entrée est désignée.
//!
//! ## Pourquoi il ne passe pas par notre décodeur
//!
//! Les références sont relues dans le JSON **brut**, membre par membre, et non
//! par `decode_story_document`. Les deux passerelles figées lisent le fichier,
//! pas notre dialecte : un contrôle qui hériterait des normalisations du
//! décodeur vérifierait ce que nous croyons avoir écrit plutôt que ce qui est
//! écrit. Et il n'emprunte évidemment pas la fonction qui vient d'écrire.
//!
//! ## Ce qu'il ne décide pas
//!
//! Il **constate**, et rend ses désaccords. Ce qu'un désaccord vaut appartient à
//! l'appelant : les deux chaînes refusent dessus aujourd'hui, mais c'est leur
//! politique qui le dit, pas ce module. C'est la condition pour qu'un même
//! relecteur serve une porte qui décide et une porte qui observe sans qu'aucune
//! des deux n'ait à recopier son travail — et pour qu'un changement de politique
//! ne demande pas d'y revenir.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::assets::advanced::oracle::OracleDisagreement;

pub(crate) const STORY_ENTRY: &str = "story.json";
pub(crate) const THUMBNAIL_ENTRY: &str = "thumbnail.png";
pub(crate) const ASSETS_PREFIX: &str = "assets/";

/// Un fichier que l'archive doit porter, et l'empreinte exacte attendue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExpectedArchiveEntry {
    pub(crate) archive_name: String,
    pub(crate) output_sha256: String,
}

/// Ce que l'appelant affirme avoir écrit.
///
/// `distinct_names` et `entries` sont distincts parce qu'ils le sont chez les
/// deux appelants : la table de noms peut rattacher plusieurs références au
/// même fichier, et c'est l'ensemble des noms **distincts** qui décrit le
/// contenu de `assets/`.
#[derive(Debug, Clone)]
pub(crate) struct ArchiveExpectation<'a> {
    pub(crate) story_json: &'a str,
    pub(crate) distinct_names: BTreeSet<String>,
    pub(crate) entries: Vec<ExpectedArchiveEntry>,
    pub(crate) expects_thumbnail: bool,
}

/// Ce que la relecture a effectivement trouvé.
#[derive(Debug, Clone)]
pub(crate) struct ArchiveReview {
    pub(crate) entry_names: Vec<String>,
    pub(crate) disagreements: Vec<OracleDisagreement>,
}

impl ArchiveReview {
    pub(crate) fn is_conformant(&self) -> bool {
        self.disagreements.is_empty()
    }
}

/// Relit l'archive et confronte son contenu aux attentes de l'appelant.
///
/// Une archive illisible est un désaccord, pas une panne d'écriture : le
/// fichier vient d'être écrit et doit être relisible.
pub(crate) fn review_written_archive(
    zip_path: &Path,
    expectation: &ArchiveExpectation<'_>,
) -> ArchiveReview {
    let entries = match read_archive_entries(zip_path) {
        Ok(entries) => entries,
        Err(disagreement) => {
            return ArchiveReview {
                entry_names: Vec::new(),
                disagreements: vec![disagreement],
            }
        }
    };
    let mut disagreements = Vec::new();

    // 1. `story.json`, à l'octet près.
    match entries.get(STORY_ENTRY) {
        None => disagreements.push(missing_entry(STORY_ENTRY)),
        Some(bytes) if bytes.as_slice() != expectation.story_json.as_bytes() => {
            disagreements.push(OracleDisagreement {
                asset_ref: STORY_ENTRY.to_string(),
                stage_uuid: None,
                kind: None,
                expected: format!("{} octets sérialisés", expectation.story_json.len()),
                observed: format!("{} octets relus dans l'archive", bytes.len()),
            });
        }
        Some(_) => {}
    }

    // 2. et 3. Les médias : mêmes noms, mêmes octets.
    let written: BTreeSet<&str> = entries
        .keys()
        .filter_map(|name| name.strip_prefix(ASSETS_PREFIX))
        .collect();
    let expected: BTreeSet<&str> = expectation
        .distinct_names
        .iter()
        .map(String::as_str)
        .collect();

    for name in expected.difference(&written) {
        disagreements.push(missing_entry(&format!("{ASSETS_PREFIX}{name}")));
    }
    for name in written.difference(&expected) {
        disagreements.push(OracleDisagreement {
            asset_ref: (*name).to_string(),
            stage_uuid: None,
            kind: None,
            expected: "un nom d'archive issu de la table".to_string(),
            observed: "une entrée que la préparation n'a pas produite".to_string(),
        });
    }

    for entry in &expectation.entries {
        let Some(bytes) = entries.get(&format!("{ASSETS_PREFIX}{}", entry.archive_name)) else {
            continue;
        };
        let observed = sha256_hex(bytes);
        if observed != entry.output_sha256 {
            disagreements.push(OracleDisagreement {
                asset_ref: entry.archive_name.clone(),
                stage_uuid: None,
                kind: None,
                expected: entry.output_sha256.clone(),
                observed,
            });
        }
    }

    // 4. Complétude croisée : ce que le fichier dit, et ce qu'il contient.
    disagreements.extend(cross_check_story_references(
        entries.get(STORY_ENTRY),
        &written,
        expectation.distinct_names.len(),
    ));

    // La couverture est un sidecar : présente si et seulement si l'écran
    // d'entrée portait une image préparée.
    let has_thumbnail = entries.contains_key(THUMBNAIL_ENTRY);
    if has_thumbnail != expectation.expects_thumbnail {
        disagreements.push(OracleDisagreement {
            asset_ref: THUMBNAIL_ENTRY.to_string(),
            stage_uuid: None,
            kind: None,
            expected: if expectation.expects_thumbnail {
                "une couverture, l'écran d'entrée portant une image".to_string()
            } else {
                "aucune couverture, l'écran d'entrée n'ayant pas d'image".to_string()
            },
            observed: if has_thumbnail {
                "une couverture présente".to_string()
            } else {
                "aucune couverture".to_string()
            },
        });
    }

    ArchiveReview {
        entry_names: entries.into_keys().collect(),
        disagreements,
    }
}

/// Confronte les références que le `story.json` relu porte réellement aux
/// fichiers réellement présents, dans les deux sens.
///
/// Une référence sans fichier produirait un pack troué ; un fichier sans
/// référence, un pack alourdi d'un média que rien ne joue. Ce contrôle porte
/// sur l'artefact, pas sur la table.
fn cross_check_story_references(
    story_bytes: Option<&Vec<u8>>,
    written: &BTreeSet<&str>,
    expected_distinct_names: usize,
) -> Vec<OracleDisagreement> {
    let Some(bytes) = story_bytes else {
        return Vec::new();
    };
    let Ok(story) = serde_json::from_slice::<Value>(bytes) else {
        return vec![OracleDisagreement {
            asset_ref: STORY_ENTRY.to_string(),
            stage_uuid: None,
            kind: None,
            expected: "un JSON relisible".to_string(),
            observed: "un story.json que la relecture ne parse pas".to_string(),
        }];
    };

    let mut disagreements = Vec::new();
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    let stages = story
        .get("stageNodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();

    for stage in stages {
        let stage_uuid = stage
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        for field in ["audio", "image"] {
            let Some(name) = stage.get(field).and_then(Value::as_str) else {
                continue;
            };
            if name.trim().is_empty() {
                continue;
            }
            referenced.insert(name.to_string());
            if !written.contains(name) {
                disagreements.push(OracleDisagreement {
                    asset_ref: name.to_string(),
                    stage_uuid: Some(stage_uuid.clone()),
                    kind: None,
                    expected: format!("l'entrée '{ASSETS_PREFIX}{name}' dans l'archive"),
                    observed: "une référence sans fichier".to_string(),
                });
            }
        }
    }

    for name in written {
        if !referenced.contains(*name) {
            disagreements.push(OracleDisagreement {
                asset_ref: (*name).to_string(),
                stage_uuid: None,
                kind: None,
                expected: "un média utilisé dans le pack".to_string(),
                observed: "un fichier qu'aucun élément du pack ne désigne".to_string(),
            });
        }
    }

    // La copie doit porter exactement autant de noms distincts que la table :
    // une substitution partielle serait invisible aux deux contrôles ci-dessus
    // si elle laissait un ancien nom qui existe aussi comme fichier.
    if referenced.len() != expected_distinct_names {
        disagreements.push(OracleDisagreement {
            asset_ref: STORY_ENTRY.to_string(),
            stage_uuid: None,
            kind: None,
            expected: format!("{expected_distinct_names} nom(s) d'archive distinct(s)"),
            observed: format!("{} référencé(s) par la copie", referenced.len()),
        });
    }

    disagreements
}

/// Ouvre l'archive avec un lecteur ZIP ordinaire et rend ses entrées.
fn read_archive_entries(zip_path: &Path) -> Result<BTreeMap<String, Vec<u8>>, OracleDisagreement> {
    let file = std::fs::File::open(zip_path).map_err(|error| unreadable(zip_path, error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| unreadable(zip_path, error))?;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| unreadable(zip_path, error))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| unreadable(zip_path, error))?;
        entries.insert(name, bytes);
    }
    Ok(entries)
}

fn unreadable(zip_path: &Path, error: impl std::fmt::Display) -> OracleDisagreement {
    OracleDisagreement {
        asset_ref: zip_path.to_string_lossy().to_string(),
        stage_uuid: None,
        kind: None,
        expected: "une archive relisible".to_string(),
        observed: error.to_string(),
    }
}

fn missing_entry(name: &str) -> OracleDisagreement {
    OracleDisagreement {
        asset_ref: name.to_string(),
        stage_uuid: None,
        kind: None,
        expected: format!("l'entrée '{name}'"),
        observed: "absente de l'archive".to_string(),
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
