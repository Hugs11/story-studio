use std::fs;
use std::process::Command;

use super::super::validate_existing_file_path;
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};
use crate::support::temp::TEMP_IMAGES_DIR;
pub(crate) fn looks_like_missing_embedded_image(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("matches no streams")
        || lower.contains("does not contain any stream")
        || lower.contains("stream map '0:v:0'")
}

pub fn extract_audio_embedded_image(audio_path: &str) -> Result<Option<String>, String> {
    let source = validate_existing_file_path(audio_path, "Fichier audio")?;
    let ffmpeg = get_ffmpeg_path()?;

    let temp_dir = std::env::temp_dir().join(TEMP_IMAGES_DIR);
    fs::create_dir_all(&temp_dir).map_err(|e| {
        format!(
            "Impossible de creer le dossier temporaire des images : {}",
            e
        )
    })?;

    let output_path = temp_dir.join(format!("metadata_{}.png", now_millis()));

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-i")
        .arg(&source)
        .arg("-an")
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1")
        .arg("-c:v")
        .arg("png")
        .arg(&output_path);
    apply_no_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Impossible d'extraire l'image embarquee : {}", e))?;

    if output.status.success() {
        if output_path.exists() {
            return Ok(Some(output_path.to_string_lossy().to_string()));
        }
        return Ok(None);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if looks_like_missing_embedded_image(&stderr) {
        return Ok(None);
    }

    Err(format!(
        "Impossible d'extraire l'image embarquee depuis {} : {}",
        source.display(),
        stderr.trim()
    ))
}
