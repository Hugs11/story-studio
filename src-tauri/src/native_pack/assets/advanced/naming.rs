//! Table `assetRef → nom d'archive`, et la garde du suffixe de huit caractères.
//!
//! Le nom d'un fichier dans l'archive n'est pas décoratif : STUdio en
//! dérive le **type** de l'asset, Lunii.QT y décide le **transcodage** et en
//! tire l'**adresse** du fichier FS produit, sur ses **huit derniers
//! caractères** avant extension, mis en capitales. Deux contenus distincts
//! qui partageraient ce suffixe s'écraseraient en silence sur la boîte.
//!
//! Une collision réelle de suffixe existe (`f7d40bc2`) entre deux
//! SHA-1 complets différents : trente-deux bits, la garde n'est pas théorique.
//!
//! **Déterminisme.** L'allocation ne dépend pas de l'ordre dans lequel les
//! conversions rendent la main : les contenus sont ordonnés par leur propre
//! empreinte avant d'être nommés. Deux exports du même état d'auteur produisent
//! donc la même table.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use sha1::{Digest, Sha1};

use super::super::audio::hashed_asset_name;
use super::super::parallel::try_map_parallel;
use super::workspace::WorkspaceError;

/// Nombre de re-dérivations tentées avant de rendre la main au refus
/// `archive-name-collision`, qui reste une garde de dernier recours.
const MAX_REDERIVATIONS: u32 = 64;

/// Longueur du suffixe que Lunii.QT retient.
const LUNII_SUFFIX_LEN: usize = 8;

/// Un contenu de sortie à nommer.
pub(crate) struct NameCandidate<'a> {
    pub(crate) asset_ref: &'a str,
    pub(crate) output_sha256: &'a str,
    pub(crate) output_path: &'a Path,
    pub(crate) extension: &'static str,
}

/// Deux références dont les contenus distincts se disputent un suffixe.
///
/// Sérialisable : le refus `archive-name-collision` la rend telle quelle
/// à l'appelant de l'export, sans reconstruire de texte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveNameConflict {
    pub(crate) asset_ref: String,
    pub(crate) archive_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NamingError {
    Collision(Vec<ArchiveNameConflict>),
    Write(WorkspaceError),
}

/// La table des noms d'archive : une image par référence, partagée par les contenus égaux.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ArchiveNameTable {
    names: BTreeMap<String, String>,
}

impl ArchiveNameTable {
    pub(crate) fn archive_name(&self, asset_ref: &str) -> Option<&str> {
        self.names.get(asset_ref).map(String::as_str)
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.names
            .iter()
            .map(|(asset_ref, name)| (asset_ref.as_str(), name.as_str()))
    }

    pub(crate) fn len(&self) -> usize {
        self.names.len()
    }

    /// Noms distincts effectivement écrits dans l'archive.
    pub(crate) fn distinct_names(&self) -> std::collections::BTreeSet<&str> {
        self.names.values().map(String::as_str).collect()
    }
}

/// Alloue les noms d'archive, en ordre indépendant des conversions.
pub(crate) fn build_archive_name_table(
    candidates: &[NameCandidate<'_>],
) -> Result<ArchiveNameTable, NamingError> {
    // Un contenu, c'est une empreinte **et** une extension : le nom porte les
    // deux, et c'est le couple qui se déduplique.
    let mut groups: BTreeMap<(&str, &'static str), Vec<&str>> = BTreeMap::new();
    for candidate in candidates {
        groups
            .entry((candidate.output_sha256, candidate.extension))
            .or_default()
            .push(candidate.asset_ref);
    }

    // Deux temps, et la séparation est fonctionnelle, pas une commodité.
    //
    // **Lire** les sorties est indépendant groupe par groupe, et c'est tout le
    // coût : un contenu par nom distinct. **Allouer** les noms ne l'est pas —
    // la résolution d'une collision d'empreintes consulte les noms déjà
    // réservés, donc elle dépend de l'ordre. Elle reste donc séquentielle, et
    // dans l'ordre trié de `groups`, exactement comme avant.
    let ordered: Vec<((&str, &'static str), Vec<&str>)> = groups.into_iter().collect();
    let contents = try_map_parallel(&ordered, |((output_sha256, extension), _)| {
        let path = candidates
            .iter()
            .find(|candidate| {
                candidate.output_sha256 == *output_sha256 && candidate.extension == *extension
            })
            .map(|candidate| candidate.output_path)
            .expect("le groupe vient des candidats");
        fs::read(path).map_err(|error| {
            NamingError::Write(WorkspaceError {
                path: path.to_string_lossy().to_string(),
                message: error.to_string(),
            })
        })
    })?;

    let mut names = BTreeMap::new();
    let mut reserved: BTreeMap<String, String> = BTreeMap::new();
    for (((_, extension), refs), bytes) in ordered.into_iter().zip(contents) {
        let name = allocate_name(&bytes, extension, &mut reserved, refs.first())?;
        for asset_ref in refs {
            names.insert(asset_ref.to_string(), name.clone());
        }
    }

    Ok(ArchiveNameTable { names })
}

fn allocate_name(
    bytes: &[u8],
    extension: &'static str,
    reserved: &mut BTreeMap<String, String>,
    first_ref: Option<&&str>,
) -> Result<String, NamingError> {
    let base = hashed_asset_name(bytes, extension);
    let mut attempt = 0_u32;
    let mut candidate = base.clone();
    loop {
        let suffix = lunii_suffix(&candidate);
        match reserved.get(&suffix) {
            None => {
                reserved.insert(suffix, candidate.clone());
                return Ok(candidate);
            }
            // Le même nom pour le même contenu : c'est la déduplication, elle
            // est légitime et elle s'arrête ici.
            Some(taken) if *taken == candidate => return Ok(candidate),
            Some(_) => {
                attempt += 1;
                if attempt > MAX_REDERIVATIONS {
                    return Err(NamingError::Collision(vec![ArchiveNameConflict {
                        asset_ref: first_ref
                            .map(|value| (*value).to_string())
                            .unwrap_or_default(),
                        archive_name: candidate,
                    }]));
                }
                candidate = rederive(bytes, extension, attempt);
            }
        }
    }
}

/// Re-dérivation déterministe : le contenu reste la source du nom, et le rang
/// de la tentative n'est jamais un compteur d'ordre d'arrivée.
fn rederive(bytes: &[u8], extension: &str, attempt: u32) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    hasher.update(b"#");
    hasher.update(attempt.to_string().as_bytes());
    format!("{:x}.{}", hasher.finalize(), extension)
}

/// Le nom est-il **dérivé de ce contenu** ?
///
/// Ce n'est pas la question de la cohérence. Permuter deux entrées de la table
/// conserve une bijection nom ↔ contenu parfaitement cohérente : la première
/// version de l'oracle laissait donc passer la permutation. Ce qui la distingue
/// d'une table correcte, c'est que chaque nom doit être **le nom de son propre
/// contenu** — l'empreinte de ses octets, ou l'une des re-dérivations bornées
/// qu'une collision de suffixe autorise. Rien d'autre n'est un nom légitime.
pub(crate) fn is_derived_name(bytes: &[u8], extension: &str, name: &str) -> bool {
    if name == hashed_asset_name(bytes, extension) {
        return true;
    }
    (1..=MAX_REDERIVATIONS).any(|attempt| name == rederive(bytes, extension, attempt))
}

/// Le suffixe que Lunii.QT retient : `splitext(nom)[0]`, huit derniers
/// caractères, en capitales.
pub(crate) fn lunii_suffix(archive_name: &str) -> String {
    let stem = archive_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(archive_name);
    let start = stem.len().saturating_sub(LUNII_SUFFIX_LEN);
    stem[start..].to_ascii_uppercase()
}

/// Table construite depuis des couples explicites — **bancs seulement**.
///
/// Les bancs permutent deux entrées de la table après coup et vérifient
/// que le rattachement le refuse. Sans ce constructeur, la contre-épreuve
/// devrait passer par un mutateur public, et un mutateur public rendrait la
/// permutation possible en production : la garde s'affaiblirait pour rendre son
/// propre test écrivable.
#[cfg(test)]
pub(crate) fn table_from_pairs(pairs: &[(&str, &str)]) -> ArchiveNameTable {
    ArchiveNameTable {
        names: pairs
            .iter()
            .map(|(asset_ref, name)| (asset_ref.to_string(), name.to_string()))
            .collect(),
    }
}
