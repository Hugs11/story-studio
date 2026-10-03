//! Garantie 2 — contrôle **perceptuel de conformance**, borné.
//!
//! Ce module ne tourne **jamais** sur un export utilisateur, et rien du chemin
//! de production ne l'appelle : il est compilé pour les seuls bancs. Il ne doit
//! pas introduire silencieusement un refus qu'un résultat non concluant
//! pourrait déclencher sur un média parfaitement valide.
//!
//! ## Ce qu'une empreinte d'enveloppe ne prouve pas, et ce qui reste
//!
//! Une empreinte d'enveloppe ne prouve pas l'identité d'un média, et la mesure
//! le montre mieux que l'argument : deux signaux carrés à **441 Hz et 220,5 Hz**, de même
//! amplitude, ont la **même valeur absolue à chaque échantillon**. Leurs
//! énergies sont égales quelle que soit la segmentation. Tout seuil acceptant le
//! positif accepte l'échange.
//!
//! L'empreinte subsiste donc **à sa place** : un contrôle sur un corpus de
//! fixtures dont la distinguabilité est **prouvée par une matrice de
//! distances**, jamais un prouveur universel. Un couple indistinguable est
//! **exclu du corpus**, pas résolu par un seuil ; une ambiguïté est rapportée
//! **non concluante**, jamais convertie en succès.
//!
//! ## Calibration
//!
//! Les valeurs ci-dessous sont mesurées sur le corpus synthétique de
//! `tests/fixtures.rs`. **Les seuils des sondes de banc ne deviennent pas
//! ceux du produit** : il n'y a pas de seuil produit, puisque
//! rien de tout ceci ne s'exécute pendant un export.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::native_pack::option_selection::OptionSelection;
use crate::native_pack::StoryDocument;

use super::MediaKind;

/// Nombre de segments d'énergie d'une empreinte audio.
///
/// Choisi pour que les fixtures du corpus — dont les événements durent un tiers
/// de seconde — tombent dans des segments distincts, sans descendre au point où
/// chaque segment ne porterait que du bruit de quantification.
pub(crate) const AUDIO_SEGMENTS: usize = 24;

/// Grille d'échantillonnage d'une empreinte image, en (colonnes, lignes).
///
/// Le rapport 4:3 est celui du format cible 320×240 : une grille qui ne le
/// respecterait pas mélangerait des zones que l'écran sépare.
pub(crate) const IMAGE_GRID: (u32, u32) = (16, 12);

/// Distance maximale admise entre un média préparé et sa **référence
/// transformée par le même plan**. Au-delà, l'appariement est refusé.
pub(crate) const MATCH_TOLERANCE: f64 = 0.08;

/// Distance minimale exigée entre deux médias du corpus pour qu'ils soient
/// tenus pour distinguables. En dessous, le couple est **exclu**.
pub(crate) const DISTINCT_MINIMUM: f64 = 0.40;

/// Contraste minimal d'une grille de luminance, en niveaux, au-dessous duquel
/// une image n'a pas de forme mesurable. Un niveau entier sur toute la grille :
/// moins que cela ne distingue plus rien du bruit de quantification.
const IMAGE_MIN_CONTRAST: f64 = 1.0;

/// Distance conventionnelle entre un média silencieux et un média qui ne l'est
/// pas : la borne supérieure de la distance L1 sur des vecteurs normalisés.
const SILENT_AGAINST_SOUND: f64 = 2.0;

/// L'empreinte d'un média, ou le constat qu'il n'a pas d'énergie.
///
/// Un média entièrement silencieux ne reçoit pas une empreinte ordinaire : il
/// n'a ni gain de référence, ni contenu à segmenter, et normaliser diviserait
/// par zéro. `Silent` contre `Silent` est un appariement ; `Silent` contre une
/// forme est un échec. Aucune division n'est effectuée.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Fingerprint {
    Silent,
    Shape(Vec<f64>),
}

/// Le verdict d'un appariement. `Inconclusive` n'est jamais promu en succès.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MatchVerdict {
    Matched,
    Mismatched,
    Inconclusive,
}

impl Fingerprint {
    /// Distance L1 entre deux empreintes normalisées, dans `[0, 2]`.
    pub(crate) fn distance(&self, other: &Fingerprint) -> f64 {
        match (self, other) {
            (Fingerprint::Silent, Fingerprint::Silent) => 0.0,
            (Fingerprint::Silent, Fingerprint::Shape(_))
            | (Fingerprint::Shape(_), Fingerprint::Silent) => SILENT_AGAINST_SOUND,
            (Fingerprint::Shape(left), Fingerprint::Shape(right)) => {
                if left.len() != right.len() {
                    return SILENT_AGAINST_SOUND;
                }
                left.iter()
                    .zip(right)
                    .map(|(a, b)| (a - b).abs())
                    .sum::<f64>()
            }
        }
    }

    /// Apparie un média préparé à sa référence.
    ///
    /// `distinguishable_from` porte les empreintes des **autres** places que le
    /// banc aurait pu confondre avec celle-ci. La question posée d'abord n'est
    /// pas « ce candidat ressemble-t-il à quelqu'un d'autre ? » — un candidat
    /// qui ressemble à un autre média est précisément la signature d'un
    /// **échange**, et la taire reviendrait à ne jamais détecter un échange. La
    /// question est : la **référence** est-elle seulement distinguable de ces
    /// alternatives ? Si elle ne l'est pas, aucun appariement n'est fondé, et
    /// le résultat est **non concluant** — jamais un succès, jamais un échec.
    pub(crate) fn match_against(
        &self,
        reference: &Fingerprint,
        distinguishable_from: &[Fingerprint],
    ) -> MatchVerdict {
        let ambiguous = distinguishable_from
            .iter()
            .any(|other| reference.distance(other) < DISTINCT_MINIMUM);
        if ambiguous {
            return MatchVerdict::Inconclusive;
        }
        if self.distance(reference) <= MATCH_TOLERANCE {
            MatchVerdict::Matched
        } else {
            MatchVerdict::Mismatched
        }
    }
}

/// Empreinte d'un fichier audio, décodée par un chemin **indépendant** de
/// l'exécuteur éprouvé : le banc invoque l'outil lui-même.
pub(crate) fn audio_fingerprint(ffmpeg: &Path, input: &Path) -> Result<Fingerprint, String> {
    let samples = decode_pcm_mono(ffmpeg, input)?;
    Ok(shape_from_energy(&samples, AUDIO_SEGMENTS))
}

/// Empreinte d'une image : luminance moyenne par case d'une grille 4:3,
/// normalisée par la somme.
pub(crate) fn image_fingerprint(bytes: &[u8]) -> Result<Fingerprint, String> {
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let (columns, rows) = IMAGE_GRID;
    let sampled = image
        .resize_exact(columns, rows, image::imageops::FilterType::Triangle)
        .to_luma8();
    let levels: Vec<f64> = sampled.pixels().map(|pixel| f64::from(pixel[0])).collect();
    Ok(normalize_contrast(&levels))
}

/// Normalisation d'une grille de luminance, **invariante à une transformation
/// affine des niveaux** `v → a·v + b` avec `a > 0`.
///
/// ## Pourquoi elle existe
///
/// Une même archive soumise aux deux passerelles : STUdio rend les images au
/// pixel près ; Lunii.QT les requantifie sur sa palette 4 bits, ce qui déplace
/// les niveaux — noirs `8 → 0`, blancs `246 → 239`. Écart maximal mesuré : **16
/// niveaux sur 255, et aucun pixel ne bascule du clair au sombre**. L'image est
/// la même.
///
/// La normalisation par la seule somme n'était pas invariante à ce décalage, et
/// l'amplifiait d'autant plus que l'image est sombre et pauvre en niveaux :
/// quand les sept huitièmes d'une image reposent sur un fond à `8`, le ramener à
/// `0` redistribue toute la masse. Mesure du même écart selon le contenu :
///
/// | Image | Distance après `8 → 0` |
/// |---|---|
/// | Bande claire une-sur-huit sur fond noir | **0,3179** |
/// | Dégradé horizontal | 0,0319 |
/// | Motif à contraste varié | 0,0098 |
/// | Texture grise | 0,0005 |
///
/// Retrancher le minimum de la grille avant la mise à l'échelle annule `b`, et
/// la division par la somme annule `a`. Sur le couple réellement observé, la
/// distance tombe de **0,3486 à 0,0045**. Ce n'est pas un desserrage de seuil :
/// `MATCH_TOLERANCE` est inchangé, et c'est l'instrument qui cesse de mesurer
/// une grandeur dont il n'avait que faire.
///
/// ## Sa limite, déclarée
///
/// Une image sans contraste mesurable n'a pas de forme : retrancher son minimum
/// ne laisserait que du bruit de quantification, amplifié par la mise à
/// l'échelle. En dessous de `IMAGE_MIN_CONTRAST`, l'empreinte retombe donc sur
/// la normalisation simple — qui rend une grille uniforme, c'est-à-dire
/// l'aveu qu'il n'y a rien à distinguer. Deux aplats de niveaux différents
/// étaient **déjà** indistinguables avant ce changement, pour la même raison.
fn normalize_contrast(levels: &[f64]) -> Fingerprint {
    let minimum = levels.iter().copied().fold(f64::INFINITY, f64::min);
    let maximum = levels.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !(maximum - minimum).is_finite() || maximum - minimum < IMAGE_MIN_CONTRAST {
        return normalize(levels);
    }
    let above: Vec<f64> = levels.iter().map(|level| level - minimum).collect();
    normalize(&above)
}

/// Décode en PCM mono 16 bits, et rend les échantillons.
fn decode_pcm_mono(ffmpeg: &Path, input: &Path) -> Result<Vec<i16>, String> {
    let output = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-v",
            "error",
            "-i",
            &input.to_string_lossy(),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-f",
            "s16le",
            "-",
        ])
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(output
        .stdout
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

/// Énergie RMS par segment, puis normalisation par la somme.
fn shape_from_energy(samples: &[i16], segments: usize) -> Fingerprint {
    if samples.is_empty() {
        return Fingerprint::Silent;
    }
    let per_segment = samples.len().div_ceil(segments).max(1);
    let energies: Vec<f64> = samples
        .chunks(per_segment)
        .map(|chunk| {
            let sum: f64 = chunk
                .iter()
                .map(|sample| {
                    let value = f64::from(*sample) / f64::from(i16::MAX);
                    value * value
                })
                .sum();
            (sum / chunk.len() as f64).sqrt()
        })
        .collect();
    normalize(&energies)
}

fn normalize(energies: &[f64]) -> Fingerprint {
    let total: f64 = energies.iter().sum();
    if total <= f64::EPSILON {
        return Fingerprint::Silent;
    }
    Fingerprint::Shape(energies.iter().map(|value| value / total).collect())
}

/// Matrice de distances d'un corpus, et les couples qu'elle exclut.
#[derive(Debug, Clone, Default)]
pub(crate) struct DistanceMatrix {
    pub(crate) distances: BTreeMap<(String, String), f64>,
    pub(crate) indistinguishable: Vec<(String, String)>,
}

/// Mesure la distinguabilité d'un corpus **avant** de s'en servir.
///
/// Un couple sous `DISTINCT_MINIMUM` n'est pas un échec du corpus : c'est un
/// couple que la garantie 2 n'a pas le droit de juger, et qu'elle exclut.
pub(crate) fn distance_matrix(corpus: &BTreeMap<String, Fingerprint>) -> DistanceMatrix {
    let mut matrix = DistanceMatrix::default();
    let names: Vec<&String> = corpus.keys().collect();
    for (index, left) in names.iter().enumerate() {
        for right in names.iter().skip(index + 1) {
            let distance = corpus[*left].distance(&corpus[*right]);
            matrix
                .distances
                .insert(((*left).clone(), (*right).clone()), distance);
            if distance < DISTINCT_MINIMUM {
                matrix
                    .indistinguishable
                    .push(((*left).clone(), (*right).clone()));
            }
        }
    }
    matrix
}

/// Adresse d'un Stage par **parcours enraciné** depuis l'entrée.
///
/// Le lecteur FS régénère les UUID intérieurs : chercher une destination par son
/// média serait circulaire, et par un UUID relu serait faux. L'ancrage est donc
/// un chemin d'arêtes étiquetées `ok`, `home` et `opt:<indice>`, indépendant du
/// contenu comme des identifiants.
pub(crate) fn rooted_stage_addresses(document: &StoryDocument) -> BTreeMap<String, String> {
    let Some(entry) = document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
    else {
        return BTreeMap::new();
    };

    let mut addresses = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::new();
    addresses.insert(entry.uuid.clone(), String::new());
    seen.insert(entry.uuid.clone());
    queue.push_back(entry.uuid.clone());

    while let Some(uuid) = queue.pop_front() {
        let address = addresses[&uuid].clone();
        let Some(stage) = document.stage_nodes.iter().find(|stage| stage.uuid == uuid) else {
            continue;
        };
        for (label, transition) in [
            ("ok", stage.ok_transition.value()),
            ("home", stage.home_transition.value()),
        ] {
            let Some(transition) = transition else {
                continue;
            };
            let Some(action) = document
                .action_nodes
                .iter()
                .find(|action| action.id == transition.action_node)
            else {
                continue;
            };
            // Une sélection aléatoire ouvre **toutes** les options : chacune
            // reçoit son adresse, aucune n'est privilégiée.
            let indices: Vec<usize> = match transition.selection {
                OptionSelection::Fixed(index) => vec![index],
                OptionSelection::Random => (0..action.options.len()).collect(),
            };
            for index in indices {
                let Some(target) = action.option_target(index) else {
                    continue;
                };
                if !seen.insert(target.to_string()) {
                    continue;
                }
                let child = if address.is_empty() {
                    format!("{label}/opt:{index}")
                } else {
                    format!("{address}/{label}/opt:{index}")
                };
                addresses.insert(target.to_string(), child);
                queue.push_back(target.to_string());
            }
        }
    }
    addresses
}

/// Adresse de chaque **place média** : le chemin du Stage, puis son champ.
pub(crate) fn rooted_destination_addresses(document: &StoryDocument) -> BTreeMap<String, String> {
    let stages = rooted_stage_addresses(document);
    let mut destinations = BTreeMap::new();
    for stage in &document.stage_nodes {
        let Some(address) = stages.get(&stage.uuid) else {
            continue;
        };
        for (kind, value) in [
            (MediaKind::Audio, stage.audio.value()),
            (MediaKind::Image, stage.image.value()),
        ] {
            let Some(asset_ref) = value else { continue };
            destinations.insert(format!("{address}#{}", kind.label()), asset_ref.clone());
        }
    }
    destinations
}
