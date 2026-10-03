use std::fs;
use std::fs::OpenOptions;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use super::observed_gates::{
    gates_header, observe_archive_review, observe_document_gates, refusal_from_gates,
    GateObservation, GatePolicy,
};
use super::pack_zip::{local_zip_path, write_pack_zip, ArchiveAsset, ArchiveContents};
use super::{
    build_story_document, pack_identity_refusal, prepare_native_pack_assets_report_with_cancel,
    CanonicalProject, NativeAssetPreparationReport, NativeGenerationWarning, Presence,
    StoryDocument,
};
use crate::domain::project::Project;
use crate::services::project_files::validate_existing_file_path;
use crate::support::paths::path_for_frontend;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePackGenerationResult {
    pub(crate) zip_path: String,
    pub(crate) warnings: Vec<NativeGenerationWarning>,
    /// Ce que les trois contrôles de l'éditeur avancé ont constaté, **sans
    /// refuser**. Une observation ne conditionne rien : le pack est
    /// publié qu'elle signale un motif de refus ou non.
    pub(crate) gate_observations: Vec<GateObservation>,
}

pub(crate) fn generate_native_pack_v1_with_cancel(
    project: &Project,
    output_folder: &str,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<NativePackGenerationResult, String> {
    let output_dir = PathBuf::from(output_folder);
    preflight_output_directory(&output_dir)?;
    // Avant toute conversion : une identité absente ou illisible ne donnera
    // jamais un pack livrable, inutile d'en faire payer la préparation.
    libre_pack_identity(&project.pack_uuid)?;
    let asset_report = prepare_native_pack_assets_report_with_cancel(project, emit, should_cancel)?;

    let result = (|| {
        check_cancelled(should_cancel)?;
        let story = build_story_document(&asset_report)?;
        check_cancelled(should_cancel)?;
        let local_output_dir = PathBuf::from(&asset_report.stage_dir).join("pack-export");
        emit("📦 Assemblage du ZIP dans le cache local...");
        let written = write_native_pack_archive(&asset_report, &story, &local_output_dir)?;
        check_cancelled(should_cancel)?;

        // Les trois contrôles d'archive, **bloquants**. Ils sont placés entre
        // l'archive locale complète et sa publication : c'est le seul endroit
        // où les trois ont leur objet sous la main, et il est antérieur au
        // point de publication unique. Un refus coûte donc du temps de
        // conversion, jamais un pack abîmé livré.
        let observations = run_free_chain_gates(&asset_report, &written, emit)?;

        emit("📤 Transfert du ZIP vers le dossier choisi...");
        let zip_path = transfer_completed_zip(
            &written.zip_path,
            &output_dir,
            &asset_report.project.name,
            should_cancel,
        )
        .map_err(TransferError::into_message)?;
        emit(&format!(
            "✅ ZIP natif v1 genere : {}",
            zip_path.to_string_lossy()
        ));
        Ok(NativePackGenerationResult {
            zip_path: path_for_frontend(&zip_path),
            warnings: asset_report.warnings.clone(),
            gate_observations: observations,
        })
    })();

    let _ = fs::remove_dir_all(&asset_report.stage_dir);
    result
}

/// Exécute les trois contrôles d'archive sur ce que la chaîne Libre vient
/// d'écrire, les journalise, et refuse ce que la politique lui dit de refuser.
///
/// La politique n'est pas décidée ici : `GatePolicy::ENFORCED` la porte, en un
/// seul endroit, et cette fonction ne fait que l'appliquer. Un refus arrive
/// **avant** `transfer_completed_zip`, donc aucune archive n'est publiée.
fn run_free_chain_gates(
    asset_report: &NativeAssetPreparationReport,
    written: &WrittenNativePack,
    emit: &dyn Fn(&str),
) -> Result<Vec<GateObservation>, String> {
    let policy = GatePolicy::ENFORCED;
    emit(gates_header(policy));
    let mut observations = observe_document_gates(
        &written.story_json,
        Some(asset_report.pack_uuid.as_str()),
        policy,
    );

    let staged_assets = asset_report
        .assets
        .iter()
        .map(|asset| {
            (
                asset.staged_asset_name.clone(),
                asset.staged_asset_path.clone(),
            )
        })
        .collect::<Vec<_>>();
    observations.push(observe_archive_review(
        &written.zip_path,
        &written.story_json,
        &staged_assets,
        written.has_thumbnail,
        policy,
    ));

    for observation in &observations {
        emit(&observation.log_line());
    }
    match refusal_from_gates(&observations) {
        Some(refusal) => {
            emit(&refusal);
            Err(refusal)
        }
        None => Ok(observations),
    }
}

fn check_cancelled(should_cancel: &(dyn Fn() -> bool + Sync)) -> Result<(), String> {
    if should_cancel() {
        Err(CANCELLED_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

/// Le message d'annulation du mode Libre, dont son appelant dépend.
pub(super) const CANCELLED_MESSAGE: &str = "Génération annulée.";

/// L'issue d'un transfert, **typée à la source**.
///
/// Le transfert est le seul endroit de la publication où deux issues très
/// différentes se ressemblent : une annulation demandée par l'auteur et une
/// panne d'écriture réelle interrompent toutes deux la copie, et toutes deux
/// laissent le dossier de destination sans archive. Les distinguer par leur
/// texte reviendrait à reconstruire un type depuis un message, ce qu'il faut
/// éviter. Elles sont donc distinctes **avant** de remonter, et chaque appelant
/// les traduit dans son propre vocabulaire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TransferError {
    /// L'auteur a demandé l'arrêt. Ce n'est pas une panne.
    Cancelled,
    /// Une écriture, une lecture ou un renommage a réellement échoué.
    Write { path: String, message: String },
}

impl TransferError {
    fn write(path: &Path, message: impl std::fmt::Display) -> Self {
        Self::Write {
            path: path.to_string_lossy().to_string(),
            message: message.to_string(),
        }
    }

    /// Le vocabulaire du mode Libre, qui ne connaît que des chaînes.
    ///
    /// L'annulation y garde **exactement** le message que son appelant attend :
    /// `generate_native_pack_v1_with_cancel` le propage tel quel, et le typage
    /// ajouté ici ne change pas un octet de ce que le mode Libre rapporte.
    pub(super) fn into_message(self) -> String {
        match self {
            Self::Cancelled => CANCELLED_MESSAGE.to_string(),
            Self::Write { message, .. } => message,
        }
    }
}

fn transfer_cancelled(should_cancel: &(dyn Fn() -> bool + Sync)) -> Result<(), TransferError> {
    if should_cancel() {
        Err(TransferError::Cancelled)
    } else {
        Ok(())
    }
}

/// Ce que l'assemblage du ZIP local a réellement écrit.
///
/// Le chemin suffisait tant que personne ne relisait l'archive. La relecture en
/// observation a besoin de deux choses de plus, et elle ne peut pas les
/// recalculer sans cesser de contrôler ce qui a été écrit : le `story.json`
/// **exact** qui est entré dans le ZIP, et la présence ou non d'une couverture.
/// Les re-dériver reviendrait à comparer l'archive à une seconde opinion.
#[derive(Debug, Clone)]
pub(crate) struct WrittenNativePack {
    pub(crate) zip_path: PathBuf,
    pub(crate) story_json: String,
    pub(crate) has_thumbnail: bool,
}

/// Assemble le ZIP local du mode Libre, et rend ce qu'il a écrit.
///
/// L'écriture elle-même appartient à `pack_zip`, partagée avec l'export avancé :
/// même ordre d'entrées, même `assets/` plat, même sidecar de couverture. Ce
/// writer garde ce qui lui est propre — la sérialisation `story.json` du pack
/// Libre et la source de couverture d'un projet canonique.
pub(crate) fn write_native_pack_archive(
    asset_report: &NativeAssetPreparationReport,
    story: &StoryDocument,
    output_dir: &Path,
) -> Result<WrittenNativePack, String> {
    let story_json = serialize_story_with_pack_uuid(story, &asset_report.pack_uuid)?;
    let zip_path = local_zip_path(output_dir, &asset_report.project.name)
        .map_err(|error| error.to_string())?;

    let assets = asset_report
        .assets
        .iter()
        .map(|asset| ArchiveAsset {
            archive_name: asset.staged_asset_name.as_str(),
            source_path: Path::new(&asset.staged_asset_path),
        })
        .collect();

    let thumbnail_png = match thumbnail_source_path(&asset_report.project) {
        Some(source) => {
            let thumbnail = validate_existing_file_path(&source, "Thumbnail source")?;
            Some(encode_thumbnail_png(&thumbnail)?)
        }
        None => None,
    };
    let has_thumbnail = thumbnail_png.is_some();

    write_pack_zip(
        &ArchiveContents {
            story_json: &story_json,
            assets,
            thumbnail_png,
        },
        &zip_path,
    )
    .map_err(|error| error.to_string())?;
    Ok(WrittenNativePack {
        zip_path,
        story_json,
        has_thumbnail,
    })
}

pub(super) fn preflight_output_directory(output_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(output_dir).map_err(|e| {
        format!(
            "Impossible d'accéder au dossier de destination '{}': {e}",
            output_dir.display()
        )
    })?;

    let probe_path = output_dir.join(format!(".story-studio-write-test-{}.tmp", Uuid::new_v4()));
    let probe_result = (|| {
        let mut probe = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe_path)
            .map_err(|e| {
                format!(
                    "Le dossier de destination '{}' n'autorise pas la création de fichiers: {e}",
                    output_dir.display()
                )
            })?;
        probe.write_all(b"story-studio").map_err(|e| {
            format!(
                "Le dossier de destination '{}' n'autorise pas l'écriture de fichiers: {e}",
                output_dir.display()
            )
        })?;
        probe.flush().map_err(|e| {
            format!(
                "Impossible de terminer le test d'écriture dans '{}': {e}",
                output_dir.display()
            )
        })
    })();

    if let Err(error) = probe_result {
        let _ = fs::remove_file(&probe_path);
        return Err(error);
    }

    fs::remove_file(&probe_path).map_err(|e| {
        format!(
            "Le dossier de destination '{}' n'autorise pas la suppression du fichier de test '{}': {e}",
            output_dir.display(),
            probe_path.display()
        )
    })
}

/// Publie le ZIP local dans le dossier choisi par l'auteur.
///
/// C'est le **point de publication unique** des deux writers : le renommage
/// `.partial → .zip` est le seul instant où une archive devient visible. Son
/// issue est typée (`TransferError`) pour que l'annulation ne se confonde pas
/// avec une panne d'écriture au moment de remonter.
pub(super) fn transfer_completed_zip(
    local_zip_path: &Path,
    output_dir: &Path,
    project_name: &str,
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<PathBuf, TransferError> {
    fs::create_dir_all(output_dir).map_err(|e| {
        TransferError::write(
            output_dir,
            format!(
                "Impossible d'accéder au dossier de destination '{}': {e}",
                output_dir.display()
            ),
        )
    })?;

    let mut final_path = export_zip_path(output_dir, project_name);
    let partial_path = output_dir.join(format!(
        "{}.{}.partial",
        final_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("story-studio.zip"),
        Uuid::new_v4()
    ));

    let transfer_result = (|| {
        let mut source = fs::File::open(local_zip_path).map_err(|e| {
            TransferError::write(
                local_zip_path,
                format!(
                    "Impossible de relire le ZIP local '{}': {e}",
                    local_zip_path.display()
                ),
            )
        })?;
        let expected_size = source
            .metadata()
            .map_err(|e| {
                TransferError::write(
                    local_zip_path,
                    format!(
                        "Impossible de contrôler la taille du ZIP local '{}': {e}",
                        local_zip_path.display()
                    ),
                )
            })?
            .len();
        let mut partial = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)
            .map_err(|e| {
                TransferError::write(
                    &partial_path,
                    format!(
                        "Impossible de créer le transfert temporaire '{}': {e}",
                        partial_path.display()
                    ),
                )
            })?;

        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut transferred_size = 0_u64;
        loop {
            // L'annulation est relue à chaque bloc : elle peut donc tomber
            // à l'entrée du transfert comme au milieu de la copie, et elle
            // remonte typée dans les deux cas.
            transfer_cancelled(should_cancel)?;
            let read = source.read(&mut buffer).map_err(|e| {
                TransferError::write(
                    local_zip_path,
                    format!(
                        "Impossible de lire le ZIP local pendant le transfert '{}': {e}",
                        local_zip_path.display()
                    ),
                )
            })?;
            if read == 0 {
                break;
            }
            partial.write_all(&buffer[..read]).map_err(|e| {
                TransferError::write(
                    output_dir,
                    format!(
                        "Impossible d'écrire le ZIP dans le dossier de destination '{}': {e}",
                        output_dir.display()
                    ),
                )
            })?;
            transferred_size += read as u64;
        }
        partial.flush().map_err(|e| {
            TransferError::write(
                output_dir,
                format!(
                    "Impossible de terminer l'écriture du ZIP dans '{}': {e}",
                    output_dir.display()
                ),
            )
        })?;
        drop(partial);

        let published_size = fs::metadata(&partial_path)
            .map_err(|e| {
                TransferError::write(
                    &partial_path,
                    format!(
                        "Impossible de vérifier le transfert temporaire '{}': {e}",
                        partial_path.display()
                    ),
                )
            })?
            .len();
        if transferred_size != expected_size || published_size != expected_size {
            return Err(TransferError::write(
                output_dir,
                format!(
                    "Le transfert du ZIP vers '{}' est incomplet (attendu: {expected_size} octets, transféré: {transferred_size}, présent: {published_size}).",
                    output_dir.display()
                ),
            ));
        }

        if final_path.exists() {
            final_path = export_zip_path(output_dir, project_name);
        }
        fs::rename(&partial_path, &final_path).map_err(|e| {
            TransferError::write(
                &final_path,
                format!(
                    "Le ZIP a été transféré, mais son renommage final de '{}' vers '{}' a échoué: {e}",
                    partial_path.display(),
                    final_path.display()
                ),
            )
        })?;
        Ok(final_path.clone())
    })();

    if transfer_result.is_err() {
        match fs::remove_file(&partial_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(cleanup_error) => {
                // Le fichier incomplet est resté : c'est une panne d'écriture,
                // quelle qu'ait été la cause de l'interruption. Elle **remplace**
                // l'issue d'origine plutôt que de la déguiser, parce qu'un
                // résidu dans le dossier de l'auteur est le fait le plus grave à
                // rapporter — une annulation propre, elle, ne laisse rien.
                return Err(TransferError::write(
                    &partial_path,
                    format!(
                        "Le fichier incomplet '{}' n'a pas pu être supprimé après l'arrêt du transfert: {cleanup_error}",
                        partial_path.display()
                    ),
                ));
            }
        }
    }

    transfer_result
}

/// L'identité du projet, telle que le pack Libre la portera.
///
/// Elle devient l'UUID de l'Écran d'entrée, que les passerelles réduisent à ses
/// huit derniers caractères hexadécimaux pour nommer le pack sur l'appareil.
/// Une graphie qu'elles lisent différemment, ou pas du tout, est refusée ici
/// plutôt que livrée : elle ne serait pas le pack que l'auteur a choisi.
pub(super) fn libre_pack_identity(pack_uuid: &str) -> Result<&str, String> {
    let identity = pack_uuid.trim();
    if identity.is_empty() {
        return Err(
            "Identité de pack absente : elle doit être choisie et persistée avant l'export."
                .to_string(),
        );
    }
    match pack_identity_refusal(identity) {
        Some(refusal) => Err(format!(
            "{refusal} Le corriger, ou en générer un nouveau, dans la fenêtre des métadonnées du pack."
        )),
        None => Ok(identity),
    }
}

/// Écrit le `story.json` du pack Libre. `uuid` appartient au modèle : le writer
/// le pose sur une copie du document au lieu de l'injecter dans la `Value`
/// produite, ce qui le rendrait invisible à toute relecture.
pub(super) fn serialize_story_with_pack_uuid(
    story: &StoryDocument,
    pack_uuid: &str,
) -> Result<String, String> {
    let mut story = story.clone();
    let pack_uuid = pack_uuid.trim();
    if !pack_uuid.is_empty() {
        story.uuid = Presence::Value(libre_pack_identity(pack_uuid)?.to_string());
    } else if story
        .uuid
        .as_deref()
        .is_none_or(|uuid| uuid.trim().is_empty())
    {
        return Err(
            "Identité de pack absente : elle doit être choisie et persistée avant l'export."
                .to_string(),
        );
    }
    restore_required_media_keys(&mut story);
    refuse_incomplete_control_settings(&story)?;
    let story_value = serde_json::to_value(&story)
        .map_err(|e| format!("Impossible de serialiser story.json natif : {}", e))?;
    serde_json::to_string_pretty(&story_value)
        .map_err(|e| format!("Impossible de serialiser story.json natif : {}", e))
}

/// Rétablit `audio` et `image` sur la **copie de sortie** du pack Libre.
///
/// Un Stage importé peut omettre ces clés ; `Presence::Absent` les fait alors
/// disparaître du pack, alors qu'elles y étaient toujours émises à `null`.
/// STUdio figé déréférence `imageNode.getAsString()` / `audioNode.getAsString()`
/// dès que la clé manque — `Optional.ofNullable(node).filter(JsonElement::isJsonNull).isEmpty()`
/// est vrai pour une clé absente comme pour une valeur non nulle
/// (`ArchiveStoryPackReader.java:200-210`) — et lève une `NullPointerException`,
/// que la même clé à `null` évite. Le document d'auteur, lui, conserve
/// l'omission : absent et `null` ne doivent pas être confondus, et la sortie
/// standard avancée a ses propres règles de préparation.
fn restore_required_media_keys(story: &mut StoryDocument) {
    for stage in &mut story.stage_nodes {
        if stage.audio.is_absent() {
            stage.audio = Presence::Null;
        }
        if stage.image.is_absent() {
            stage.image = Presence::Null;
        }
    }
}

/// Refuse d'écrire un pack dont un Stage ne porte pas les cinq contrôles
/// explicites.
///
/// L'entrée conserve un `controlSettings` incomplet dans le document, mais
/// l'objet doit être complet en sortie et on ne complète pas les valeurs
/// manquantes à la place de l'auteur — les deux passerelles figées lisent d'ailleurs les
/// cinq membres sans garde (`ArchiveStoryPackReader.java:188-191`). Le writer
/// s'arrête donc avec un message localisé plutôt que d'inventer un contrôle ou
/// de produire un pack que STUdio ne peut pas lire.
fn refuse_incomplete_control_settings(story: &StoryDocument) -> Result<(), String> {
    let incomplete = story
        .stage_nodes
        .iter()
        .filter(|stage| !stage.control_settings.is_complete())
        .map(|stage| format!("'{}' ({})", stage.label(), stage.uuid))
        .collect::<Vec<_>>();
    if incomplete.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Contrôles incomplets : {} n'ont pas leurs cinq valeurs (wheel, ok, home, pause, autoplay). \
         Renseignez-les explicitement avant de générer le pack : elles ne peuvent pas être déduites.",
        incomplete.join(", ")
    ))
}

fn thumbnail_source_path(project: &CanonicalProject) -> Option<String> {
    project
        .thumbnail_image
        .clone()
        .or_else(|| project.root_image.clone())
}

/// Ré-encode une image déjà validée en PNG de couverture.
///
/// L'export avancé la réutilise sur son **asset image préparé** de l'écran
/// d'entrée : la couverture dérive du média que la préparation a déjà
/// contrôlé, jamais d'une seconde lecture du fichier d'origine.
pub(super) fn encode_thumbnail_png(thumbnail: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(thumbnail).map_err(|e| format!("Lecture thumbnail impossible : {}", e))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Image thumbnail illisible : {}", e))?;
    let mut output = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| format!("Encodage thumbnail PNG impossible : {}", e))?;
    Ok(output)
}

pub(crate) fn sanitized_project_name(name: &str) -> String {
    let mut sanitized = String::new();
    let mut previous_char: Option<char> = None;

    for ch in name.trim().chars() {
        let mapped = if ch.is_alphanumeric()
            || matches!(ch, '_' | '-' | '.' | '(' | ')' | '[' | ']' | '+')
        {
            Some(ch)
        } else if ch.is_whitespace() || matches!(ch, '\'' | '`' | '’') {
            Some('_')
        } else {
            Some('-')
        };

        if let Some(next_char) = mapped {
            let duplicate_separator =
                matches!(next_char, '_' | '-') && previous_char == Some(next_char);
            if duplicate_separator {
                continue;
            }
            sanitized.push(next_char);
            previous_char = Some(next_char);
        }
    }

    let trimmed = sanitized.trim_matches(|c| matches!(c, '_' | '-' | '.' | ' '));
    if trimmed.is_empty() {
        "story-studio".to_string()
    } else {
        let candidate = trimmed.to_string();
        let upper = candidate.to_ascii_uppercase();
        match upper.as_str() {
            "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
            | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
            | "LPT7" | "LPT8" | "LPT9" => {
                format!("{}_pack", candidate)
            }
            _ => candidate,
        }
    }
}

pub(crate) fn export_zip_path(output_dir: &Path, project_name: &str) -> PathBuf {
    let base_name = sanitized_project_name(project_name);
    let mut candidate = output_dir.join(format!("{}.zip", base_name));
    let mut suffix = 2usize;

    while candidate.exists() {
        candidate = output_dir.join(format!("{}-{}.zip", base_name, suffix));
        suffix += 1;
    }

    candidate
}

pub(crate) fn display_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}
