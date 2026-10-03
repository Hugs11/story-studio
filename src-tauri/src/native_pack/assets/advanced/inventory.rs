//! Inventaire : du document aux fichiers, et le refus quand il en manque un.
//!
//! Deux passes, jamais mélangées. La **résolution** établit qu'un fichier
//! lisible et non vide existe derrière chaque référence, et copie chacun dans
//! l'espace de travail. La **validation** établit, sur ces instantanés, le
//! format réel et la décodabilité. L'inventaire est complet avant qu'une seule
//! conversion commence, et un inventaire mixte est listé **entièrement** : rien
//! n'est prioritaire entre familles de causes.
//!
//! **Pourquoi un instantané.** Relire plusieurs fois une source externe
//! modifiable puis prétendre prouver les mêmes octets serait faux : entre deux
//! lectures, l'auteur peut avoir remplacé le fichier. Tout ce qui suit — plan,
//! clé de tâche, conversion, hachages, couverture — part de l'instantané, et de
//! lui seul.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::native_pack::persistence::AdvancedMediaBinding;
use crate::native_pack::StoryDocument;
use crate::services::project_files::validate_existing_file_path;

use super::super::parallel::partition_map_parallel;
use super::format::{
    detect_audio_container, image_format_label, parse_mpeg_frame_header, studio_image_extension,
    MpegFrameHeader,
};
use super::probe::{classify, decode_probe, ToolOperation};
use super::workspace::{AdvancedWorkspace, WorkspaceError};
use super::{MediaCause, MediaKind, MediaUnavailable};

const COPY_CHUNK: usize = 256 * 1024;

/// Une place du graphe qui attend un média : un Stage et l'un de ses deux
/// champs. C'est l'unité que la garantie 1 suit de bout en bout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaDestination {
    pub(crate) stage_uuid: String,
    pub(crate) kind: MediaKind,
    pub(crate) asset_ref: String,
}

/// Un média inventorié : son instantané, et ce que ses octets portent.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InventoriedMedia {
    pub(crate) asset_ref: String,
    pub(crate) kind: MediaKind,
    pub(crate) source_path: String,
    pub(crate) source_bytes: u64,
    pub(crate) snapshot_sha256: String,
    pub(crate) detected_source_format: String,
    /// En-tête de trame MPEG, **couche comprise**, quand les octets en portent
    /// un. Absent ne veut pas dire refusé : un WAV décodable est converti.
    pub(crate) mpeg_header: Option<MpegFrameHeader>,
    /// Dimensions et extension d'archive d'une image décodée.
    pub(crate) image_facts: Option<ImageFacts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ImageFacts {
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// `None` pour un format hors de la liste fermée des extensions que STUdio sait lire.
    pub(crate) studio_extension: Option<&'static str>,
}

/// Ce qui arrête l'inventaire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InventoryError {
    Unavailable(Vec<MediaUnavailable>),
    Write(WorkspaceError),
    /// Une même référence occupe une place audio **et** une place image : ses
    /// destinations sont en désaccord et aucune n'est arbitrable ici.
    Disagreement(Vec<MediaDestination>),
}

/// Toutes les places du graphe qui attendent un média, dans l'ordre du document.
///
/// Une chaîne vide n'est pas une référence : `referenced_asset_refs` l'écarte
/// déjà, et inventer un fichier derrière un champ vide serait une
/// résolution silencieuse. Les membres **opaques** ne sont jamais parcourus :
/// une extension peut mentionner un ancien nom d'asset sans être un média.
pub(crate) fn media_destinations(document: &StoryDocument) -> Vec<MediaDestination> {
    let mut destinations = Vec::new();
    for stage in &document.stage_nodes {
        for (kind, value) in [
            (MediaKind::Audio, stage.audio.value()),
            (MediaKind::Image, stage.image.value()),
        ] {
            let Some(asset_ref) = value else { continue };
            if asset_ref.trim().is_empty() {
                continue;
            }
            destinations.push(MediaDestination {
                stage_uuid: stage.uuid.clone(),
                kind,
                asset_ref: asset_ref.clone(),
            });
        }
    }
    destinations
}

/// Résout, copie et valide chaque référence du document.
pub(crate) fn inventory_media(
    document: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    workspace: &AdvancedWorkspace,
    ffmpeg: &Path,
    deadline: Duration,
) -> Result<Vec<InventoriedMedia>, InventoryError> {
    let destinations = media_destinations(document);
    let mut ordered_refs: Vec<&str> = Vec::new();
    for destination in &destinations {
        if !ordered_refs.contains(&destination.asset_ref.as_str()) {
            ordered_refs.push(&destination.asset_ref);
        }
    }

    let mut disagreements = Vec::new();
    for asset_ref in &ordered_refs {
        let kinds: Vec<MediaKind> = destinations
            .iter()
            .filter(|destination| destination.asset_ref == **asset_ref)
            .map(|destination| destination.kind)
            .collect();
        if kinds.contains(&MediaKind::Audio) && kinds.contains(&MediaKind::Image) {
            disagreements.extend(
                destinations
                    .iter()
                    .filter(|destination| destination.asset_ref == **asset_ref)
                    .cloned(),
            );
        }
    }
    if !disagreements.is_empty() {
        return Err(InventoryError::Disagreement(disagreements));
    }

    // Passe 1 — résolution et instantané. Chaque référence est indépendante :
    // elle lit **son** fichier source et écrit **son** instantané, à une adresse
    // dérivée de son propre contenu. Deux références ne peuvent pas se gêner.
    let (snapshots, resolution_failures) = partition_map_parallel(&ordered_refs, |asset_ref| {
        let kind = destinations
            .iter()
            .find(|destination| destination.asset_ref == **asset_ref)
            .map(|destination| destination.kind)
            .expect("une référence vient d'une destination");
        resolve_and_snapshot(asset_ref, kind, bindings, workspace)
    });

    // Les deux natures de défaut restent distinctes, et l'ordre d'entrée est
    // conservé : le message de refus ne dépend pas de la vitesse des disques.
    let mut unavailable = Vec::new();
    let mut write_failure = None;
    for failure in resolution_failures {
        match failure {
            ResolutionFailure::Media(entry) => unavailable.push(entry),
            ResolutionFailure::Write(error) => {
                write_failure.get_or_insert(error);
            }
        }
    }
    if !unavailable.is_empty() {
        return Err(InventoryError::Unavailable(fill_destinations(
            unavailable,
            &destinations,
            bindings,
        )));
    }
    if let Some(error) = write_failure {
        return Err(InventoryError::Write(error));
    }

    // Passe 2 — format réel et décodabilité, sur les instantanés. C'est la
    // passe la plus chère de l'inventaire : la décodabilité s'établit en
    // **décodant le média jusqu'au bout**. Une centaine de médias, c'est une
    // centaine de décodages — qui n'ont aucune raison de s'attendre.
    let (inventoried, invalid) = partition_map_parallel(&snapshots, |snapshot| {
        validate_snapshot(snapshot.clone(), workspace, ffmpeg, deadline)
    });
    if !invalid.is_empty() {
        return Err(InventoryError::Unavailable(fill_destinations(
            invalid,
            &destinations,
            bindings,
        )));
    }
    Ok(inventoried)
}

#[derive(Clone)]
struct SnapshotedMedia {
    asset_ref: String,
    kind: MediaKind,
    source_path: String,
    source_bytes: u64,
    snapshot_sha256: String,
}

enum ResolutionFailure {
    Media(MediaUnavailable),
    Write(WorkspaceError),
}

fn resolve_and_snapshot(
    asset_ref: &str,
    kind: MediaKind,
    bindings: &[AdvancedMediaBinding],
    workspace: &AdvancedWorkspace,
) -> Result<SnapshotedMedia, ResolutionFailure> {
    let refuse = |cause: MediaCause, detail: String| {
        ResolutionFailure::Media(MediaUnavailable {
            asset_ref: asset_ref.to_string(),
            kind,
            stage_ids: Vec::new(),
            last_known_path: None,
            cause,
            detail,
        })
    };

    let Some(binding) = bindings
        .iter()
        .find(|binding| binding.asset_ref == asset_ref)
    else {
        return Err(refuse(
            MediaCause::BindingAbsent,
            "aucune liaison ne porte cette référence".to_string(),
        ));
    };
    let Some(path) = binding
        .path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    else {
        return Err(refuse(
            MediaCause::PathNull,
            "la liaison ne désigne aucun fichier".to_string(),
        ));
    };

    // `symlink_metadata` d'abord : un lien pendant doit se lire « introuvable »
    // et non « refusé », et un lien vers un périphérique doit rester
    // « pas un fichier régulier ».
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(refuse(MediaCause::NotFound, error.to_string()))
        }
        Err(error) => return Err(refuse(MediaCause::ReadDenied, error.to_string())),
    };
    if metadata.is_dir() {
        return Err(refuse(
            MediaCause::NotRegular,
            "la liaison désigne un répertoire".to_string(),
        ));
    }
    // La garde de chemins est la même que celle du mode Libre. Une référence
    // qu'elle rejette n'est jamais transformée en adresse exploitable : elle
    // sort en refus, et son chemin ne sert plus qu'à nommer le manque.
    let canonical = validate_existing_file_path(path, "média avancé")
        .map_err(|message| refuse(MediaCause::NotRegular, message))?;

    let snapshot_dir = workspace.snapshots_dir();
    fs::create_dir_all(&snapshot_dir).map_err(|error| {
        ResolutionFailure::Write(WorkspaceError {
            path: snapshot_dir.to_string_lossy().to_string(),
            message: error.to_string(),
        })
    })?;
    let staging = snapshot_dir.join(format!(
        "staging-{:x}",
        Sha256::digest(asset_ref.as_bytes())
    ));
    let (snapshot_sha256, source_bytes) = match copy_and_hash(&canonical, &staging) {
        Ok(result) => result,
        Err(CopyFailure::Read(message)) => {
            let _ = fs::remove_file(&staging);
            return Err(refuse(MediaCause::ReadDenied, message));
        }
        Err(CopyFailure::Write(error)) => {
            let _ = fs::remove_file(&staging);
            return Err(ResolutionFailure::Write(error));
        }
    };
    if source_bytes == 0 {
        let _ = fs::remove_file(&staging);
        return Err(refuse(
            MediaCause::Empty,
            "le fichier ne porte aucun octet".to_string(),
        ));
    }

    let snapshot = workspace.snapshot_path(&snapshot_sha256);
    if snapshot.exists() {
        // Deux références au même contenu partagent leur instantané : c'est la
        // déduplication, et elle commence ici.
        let _ = fs::remove_file(&staging);
    } else {
        fs::rename(&staging, &snapshot).map_err(|error| {
            ResolutionFailure::Write(WorkspaceError {
                path: snapshot.to_string_lossy().to_string(),
                message: error.to_string(),
            })
        })?;
    }

    Ok(SnapshotedMedia {
        asset_ref: asset_ref.to_string(),
        kind,
        source_path: canonical.to_string_lossy().to_string(),
        source_bytes,
        snapshot_sha256,
    })
}

enum CopyFailure {
    Read(String),
    Write(WorkspaceError),
}

/// Copie en empreignant, et distingue le **côté** de la panne.
///
/// Une lecture source refusée est un défaut du média (`read-denied`) ; une
/// écriture locale qui échoue est une panne de notre espace de travail
/// (`output-write`). Les deux ne doivent jamais être confondues.
fn copy_and_hash(source: &Path, destination: &Path) -> Result<(String, u64), CopyFailure> {
    let mut input = File::open(source).map_err(|error| CopyFailure::Read(error.to_string()))?;
    let mut output = File::create(destination).map_err(|error| {
        CopyFailure::Write(WorkspaceError {
            path: destination.to_string_lossy().to_string(),
            message: error.to_string(),
        })
    })?;
    let mut hasher = Sha256::new();
    let mut scratch = vec![0_u8; COPY_CHUNK];
    let mut total = 0_u64;
    loop {
        let read = input
            .read(&mut scratch)
            .map_err(|error| CopyFailure::Read(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&scratch[..read]);
        output.write_all(&scratch[..read]).map_err(|error| {
            CopyFailure::Write(WorkspaceError {
                path: destination.to_string_lossy().to_string(),
                message: error.to_string(),
            })
        })?;
        total += read as u64;
    }
    output.flush().map_err(|error| {
        CopyFailure::Write(WorkspaceError {
            path: destination.to_string_lossy().to_string(),
            message: error.to_string(),
        })
    })?;
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn validate_snapshot(
    snapshot: SnapshotedMedia,
    workspace: &AdvancedWorkspace,
    ffmpeg: &Path,
    deadline: Duration,
) -> Result<InventoriedMedia, MediaUnavailable> {
    let path = workspace.snapshot_path(&snapshot.snapshot_sha256);
    let refuse = |cause: MediaCause, detail: String| MediaUnavailable {
        asset_ref: snapshot.asset_ref.clone(),
        kind: snapshot.kind,
        stage_ids: Vec::new(),
        last_known_path: None,
        cause,
        detail,
    };

    match snapshot.kind {
        MediaKind::Audio => {
            // Les premiers octets suffisent au conteneur et à l'en-tête de
            // trame ; la décodabilité, elle, exige le fichier entier.
            let head = read_head(&path, 1024 * 1024)
                .map_err(|error| refuse(MediaCause::ReadDenied, error.to_string()))?;
            let container = detect_audio_container(&head);
            let mpeg_header = parse_mpeg_frame_header(&head);

            let run = decode_probe(ffmpeg, &path, deadline);
            if let Some(cause) =
                classify(ToolOperation::Validation, &run.outcome, run.produced_data())
            {
                return Err(refuse(cause, run.detail()));
            }

            let detected_source_format = match mpeg_header {
                Some(header) => format!("{}/{}", container.label(), header.label()),
                None => container.label().to_string(),
            };
            Ok(InventoriedMedia {
                asset_ref: snapshot.asset_ref,
                kind: snapshot.kind,
                source_path: snapshot.source_path,
                source_bytes: snapshot.source_bytes,
                snapshot_sha256: snapshot.snapshot_sha256,
                detected_source_format,
                mpeg_header,
                image_facts: None,
            })
        }
        MediaKind::Image => {
            let bytes = fs::read(&path)
                .map_err(|error| refuse(MediaCause::ReadDenied, error.to_string()))?;
            let format = image::guess_format(&bytes).ok();
            // Le décodage image est en mémoire et rend tout ou rien : il n'a pas
            // d'échec « après données », donc `validation-failed` ne peut pas se
            // produire ici. La cause reste réservée aux flux progressifs.
            let decoded = image::load_from_memory(&bytes)
                .map_err(|error| refuse(MediaCause::Undecodable, error.to_string()))?;
            let (width, height) = (decoded.width(), decoded.height());
            if width == 0 || height == 0 {
                return Err(refuse(
                    MediaCause::Undecodable,
                    "l'image décodée est vide".to_string(),
                ));
            }
            let detected_source_format = format.map(image_format_label).unwrap_or("unknown");
            Ok(InventoriedMedia {
                asset_ref: snapshot.asset_ref,
                kind: snapshot.kind,
                source_path: snapshot.source_path,
                source_bytes: snapshot.source_bytes,
                snapshot_sha256: snapshot.snapshot_sha256,
                detected_source_format: format!("{detected_source_format}-{width}x{height}"),
                mpeg_header: None,
                image_facts: Some(ImageFacts {
                    width,
                    height,
                    studio_extension: format.and_then(studio_image_extension),
                }),
            })
        }
    }
}

fn read_head(path: &Path, max: usize) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0_u8; max];
    let mut filled = 0;
    while filled < max {
        let read = file.read(&mut buffer[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Complète chaque refus par les Stages concernés et le dernier chemin connu.
///
/// Chaque refus porte `{assetRef, field, stageIds[], lastKnownPath, cause,
/// detail}` : l'auteur doit voir **où** le média manque, pas seulement qu'il
/// manque.
fn fill_destinations(
    mut entries: Vec<MediaUnavailable>,
    destinations: &[MediaDestination],
    bindings: &[AdvancedMediaBinding],
) -> Vec<MediaUnavailable> {
    for entry in &mut entries {
        entry.stage_ids = destinations
            .iter()
            .filter(|destination| destination.asset_ref == entry.asset_ref)
            .map(|destination| destination.stage_uuid.clone())
            .collect();
        entry.last_known_path = bindings
            .iter()
            .find(|binding| binding.asset_ref == entry.asset_ref)
            .and_then(|binding| binding.path.clone());
    }
    entries
}
