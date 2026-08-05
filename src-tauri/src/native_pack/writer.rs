use std::collections::HashSet;
use std::fs;
use std::fs::OpenOptions;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{
    build_story_document, prepare_native_pack_assets_report_with_cancel, CanonicalProject,
    NativeAssetPreparationReport, NativeGenerationWarning, StoryDocument,
};
use crate::domain::project::Project;
use crate::services::project_files::validate_existing_file_path;
use crate::support::paths::path_for_frontend;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePackGenerationResult {
    pub(crate) zip_path: String,
    pub(crate) warnings: Vec<NativeGenerationWarning>,
}

pub(crate) fn generate_native_pack_v1_with_cancel(
    project: &Project,
    output_folder: &str,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<NativePackGenerationResult, String> {
    let output_dir = PathBuf::from(output_folder);
    preflight_output_directory(&output_dir)?;
    let asset_report = prepare_native_pack_assets_report_with_cancel(project, emit, should_cancel)?;

    let result = (|| {
        check_cancelled(should_cancel)?;
        let story = build_story_document(&asset_report)?;
        check_cancelled(should_cancel)?;
        let local_output_dir = PathBuf::from(&asset_report.stage_dir).join("pack-export");
        emit("📦 Assemblage du ZIP dans le cache local...");
        let local_zip_path = write_native_pack_zip(&asset_report, &story, &local_output_dir)?;
        check_cancelled(should_cancel)?;
        emit("📤 Transfert du ZIP vers le dossier choisi...");
        let zip_path = transfer_completed_zip(
            &local_zip_path,
            &output_dir,
            &asset_report.project.name,
            should_cancel,
        )?;
        emit(&format!(
            "✅ ZIP natif v1 genere : {}",
            zip_path.to_string_lossy()
        ));
        Ok(NativePackGenerationResult {
            zip_path: path_for_frontend(&zip_path),
            warnings: asset_report.warnings.clone(),
        })
    })();

    let _ = fs::remove_dir_all(&asset_report.stage_dir);
    result
}

fn check_cancelled(should_cancel: &(dyn Fn() -> bool + Sync)) -> Result<(), String> {
    if should_cancel() {
        Err("Génération annulée.".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn write_native_pack_zip(
    asset_report: &NativeAssetPreparationReport,
    story: &StoryDocument,
    output_dir: &Path,
) -> Result<PathBuf, String> {
    let story_json = serialize_story_with_pack_uuid(story, &asset_report.pack_uuid)?;

    fs::create_dir_all(output_dir).map_err(|e| {
        format!(
            "Impossible de préparer le dossier ZIP local '{}': {e}",
            output_dir.display()
        )
    })?;
    let zip_path = export_zip_path(output_dir, &asset_report.project.name);

    let out_file = fs::File::create(&zip_path).map_err(|e| {
        format!(
            "Impossible de créer le ZIP local '{}': {e}",
            zip_path.display()
        )
    })?;
    let mut out_zip = zip::ZipWriter::new(out_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    out_zip
        .start_file("story.json", opts)
        .map_err(|e| format!("Impossible d'ajouter story.json au ZIP local: {e}"))?;
    out_zip
        .write_all(story_json.as_bytes())
        .map_err(|e| format!("Impossible d'écrire story.json dans le ZIP local: {e}"))?;

    let mut written_assets = HashSet::new();
    for asset in &asset_report.assets {
        if !written_assets.insert(asset.staged_asset_name.clone()) {
            continue;
        }
        let asset_bytes = fs::read(&asset.staged_asset_path).map_err(|e| {
            format!(
                "Lecture asset stage impossible {} : {}",
                asset.staged_asset_name, e
            )
        })?;
        let zip_asset_name = format!("assets/{}", asset.staged_asset_name);
        out_zip
            .start_file(&zip_asset_name, opts)
            .map_err(|e| format!("Impossible d'ajouter '{zip_asset_name}' au ZIP local: {e}"))?;
        out_zip.write_all(&asset_bytes).map_err(|e| {
            format!("Impossible d'écrire '{zip_asset_name}' dans le ZIP local: {e}")
        })?;
    }

    if let Some(thumbnail_source) = thumbnail_source_path(&asset_report.project) {
        let thumbnail = validate_existing_file_path(&thumbnail_source, "Thumbnail source")?;
        let bytes = encode_thumbnail_png(&thumbnail)?;
        out_zip
            .start_file("thumbnail.png", opts)
            .map_err(|e| format!("Impossible d'ajouter thumbnail.png au ZIP local: {e}"))?;
        out_zip
            .write_all(&bytes)
            .map_err(|e| format!("Impossible d'écrire thumbnail.png dans le ZIP local: {e}"))?;
    }

    out_zip.finish().map_err(|e| {
        format!(
            "Impossible de finaliser le ZIP local '{}': {e}",
            zip_path.display()
        )
    })?;
    Ok(zip_path)
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

pub(super) fn transfer_completed_zip(
    local_zip_path: &Path,
    output_dir: &Path,
    project_name: &str,
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<PathBuf, String> {
    fs::create_dir_all(output_dir).map_err(|e| {
        format!(
            "Impossible d'accéder au dossier de destination '{}': {e}",
            output_dir.display()
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
            format!(
                "Impossible de relire le ZIP local '{}': {e}",
                local_zip_path.display()
            )
        })?;
        let expected_size = source
            .metadata()
            .map_err(|e| {
                format!(
                    "Impossible de contrôler la taille du ZIP local '{}': {e}",
                    local_zip_path.display()
                )
            })?
            .len();
        let mut partial = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)
            .map_err(|e| {
                format!(
                    "Impossible de créer le transfert temporaire '{}': {e}",
                    partial_path.display()
                )
            })?;

        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut transferred_size = 0_u64;
        loop {
            check_cancelled(should_cancel)?;
            let read = source.read(&mut buffer).map_err(|e| {
                format!(
                    "Impossible de lire le ZIP local pendant le transfert '{}': {e}",
                    local_zip_path.display()
                )
            })?;
            if read == 0 {
                break;
            }
            partial.write_all(&buffer[..read]).map_err(|e| {
                format!(
                    "Impossible d'écrire le ZIP dans le dossier de destination '{}': {e}",
                    output_dir.display()
                )
            })?;
            transferred_size += read as u64;
        }
        partial.flush().map_err(|e| {
            format!(
                "Impossible de terminer l'écriture du ZIP dans '{}': {e}",
                output_dir.display()
            )
        })?;
        drop(partial);

        let published_size = fs::metadata(&partial_path)
            .map_err(|e| {
                format!(
                    "Impossible de vérifier le transfert temporaire '{}': {e}",
                    partial_path.display()
                )
            })?
            .len();
        if transferred_size != expected_size || published_size != expected_size {
            return Err(format!(
                "Le transfert du ZIP vers '{}' est incomplet (attendu: {expected_size} octets, transféré: {transferred_size}, présent: {published_size}).",
                output_dir.display()
            ));
        }

        if final_path.exists() {
            final_path = export_zip_path(output_dir, project_name);
        }
        fs::rename(&partial_path, &final_path).map_err(|e| {
            format!(
                "Le ZIP a été transféré, mais son renommage final de '{}' vers '{}' a échoué: {e}",
                partial_path.display(),
                final_path.display()
            )
        })?;
        Ok(final_path.clone())
    })();

    if transfer_result.is_err() {
        match fs::remove_file(&partial_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(cleanup_error) => {
                let transfer_error = transfer_result
                    .err()
                    .unwrap_or_else(|| "Transfert du ZIP impossible.".to_string());
                return Err(format!(
                    "{transfer_error} Le fichier incomplet '{}' n'a pas pu être supprimé: {cleanup_error}",
                    partial_path.display()
                ));
            }
        }
    }

    transfer_result
}

fn serialize_story_with_pack_uuid(
    story: &StoryDocument,
    pack_uuid: &str,
) -> Result<String, String> {
    let mut story_value = serde_json::to_value(story)
        .map_err(|e| format!("Impossible de serialiser story.json natif : {}", e))?;
    let uuid = if pack_uuid.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        pack_uuid.trim().to_string()
    };
    if let Some(object) = story_value.as_object_mut() {
        object.insert("uuid".to_string(), serde_json::Value::String(uuid));
    }
    serde_json::to_string_pretty(&story_value)
        .map_err(|e| format!("Impossible de serialiser story.json natif : {}", e))
}

fn thumbnail_source_path(project: &CanonicalProject) -> Option<String> {
    project
        .thumbnail_image
        .clone()
        .or_else(|| project.root_image.clone())
}

fn encode_thumbnail_png(thumbnail: &Path) -> Result<Vec<u8>, String> {
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
