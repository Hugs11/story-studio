use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use super::{
    build_story_document, prepare_native_pack_assets_report_with_cancel, CanonicalProject,
    NativeAssetPreparationReport, StoryDocument,
};
use crate::domain::project::Project;
use crate::services::project_files::validate_existing_file_path;
use uuid::Uuid;

pub(crate) fn generate_native_pack_v1_with_cancel(
    project: &Project,
    output_folder: &str,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<String, String> {
    let asset_report = prepare_native_pack_assets_report_with_cancel(project, emit, should_cancel)?;

    let result = (|| {
        check_cancelled(should_cancel)?;
        let story = build_story_document(&asset_report)?;
        check_cancelled(should_cancel)?;
        let zip_path = write_native_pack_zip(&asset_report, &story, &PathBuf::from(output_folder))?;
        emit(&format!(
            "✅ ZIP natif v1 genere : {}",
            zip_path.to_string_lossy()
        ));
        Ok(zip_path.to_string_lossy().to_string())
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

    fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
    let zip_path = export_zip_path(output_dir, &asset_report.project.name);

    let out_file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut out_zip = zip::ZipWriter::new(out_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    out_zip
        .start_file("story.json", opts)
        .map_err(|e| e.to_string())?;
    out_zip
        .write_all(story_json.as_bytes())
        .map_err(|e| e.to_string())?;

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
            .map_err(|e| e.to_string())?;
        out_zip.write_all(&asset_bytes).map_err(|e| e.to_string())?;
    }

    if let Some(thumbnail_source) = thumbnail_source_path(&asset_report.project) {
        let thumbnail = validate_existing_file_path(&thumbnail_source, "Thumbnail source")?;
        let bytes = encode_thumbnail_png(&thumbnail)?;
        out_zip
            .start_file("thumbnail.png", opts)
            .map_err(|e| e.to_string())?;
        out_zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    out_zip.finish().map_err(|e| e.to_string())?;
    Ok(zip_path)
}

fn serialize_story_with_pack_uuid(story: &StoryDocument, pack_uuid: &str) -> Result<String, String> {
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
