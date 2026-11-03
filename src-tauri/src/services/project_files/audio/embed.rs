use crate::support::user_message;
use crate::support::user_message::codes;
use std::fs;
use std::path::Path;
use std::process::Command;

use super::super::validate_existing_file_path;
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};
use crate::support::paths::path_for_frontend;
pub(crate) fn looks_like_missing_embedded_image(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("matches no streams")
        || lower.contains("does not contain any stream")
        || lower.contains("stream map '0:v:0'")
}

pub fn extract_audio_embedded_image(
    audio_path: &str,
    output_dir: &Path,
) -> Result<Option<String>, String> {
    let source = validate_existing_file_path(audio_path, codes::AUDIO_FILE_LABEL_TRANSPORT)?;
    let ffmpeg = get_ffmpeg_path()?;

    fs::create_dir_all(output_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_TEMP_IMAGES_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de creer le dossier temporaire des images : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let output_path = output_dir.join(format!("metadata_{}.png", now_millis()));

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

    let output = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_EMBEDDED_IMAGE_EXTRACT_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible d'extraire l'image embarquee : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    if output.status.success() {
        if output_path.exists() {
            return Ok(Some(path_for_frontend(&output_path)));
        }
        return Ok(None);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if looks_like_missing_embedded_image(&stderr) {
        return Ok(None);
    }

    Err({
        let _msg_source = (source.display()).to_string();
        let _msg_stderr = (stderr.trim()).to_string();
        user_message::UserMessage::new(codes::FILES_NAMED_IMAGE_EXTRACT_FAILED)
            .param("source", user_message::transport_param(_msg_source.clone()))
            .param("stderr", user_message::transport_param(_msg_stderr.clone()))
            .with_detail(format!(
                "Impossible d'extraire l'image embarquee depuis {_msg_source} : {_msg_stderr}",
                _msg_source = user_message::transport_detail(&_msg_source),
                _msg_stderr = user_message::transport_detail(&_msg_stderr)
            ))
            .into_transport()
    })
}
