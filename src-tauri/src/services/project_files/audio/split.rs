use std::fs;
use std::path::PathBuf;

use super::super::project_dir_from_save_path;
use super::{
    run_ffmpeg_audio_edit, unique_audio_assembly_path, validate_audio_assembly_filename,
    validate_audio_assembly_input, AudioEditParams, FfmpegAudioEditRequest,
    WORKING_AUDIO_EXTENSION,
};
use crate::support::ffmpeg::get_ffmpeg_path;
use crate::support::paths::path_for_frontend;

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioSplitSegment {
    pub output_file_name: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioSplitSuccess {
    pub output_path: String,
    pub output_file_name: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioSplitFailure {
    pub output_file_name: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub error: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioSplitResult {
    pub created: Vec<AudioSplitSuccess>,
    pub failed: Vec<AudioSplitFailure>,
}

fn split_target_dir(save_path: &str, workspace_dir: Option<&str>) -> Result<PathBuf, String> {
    let has_workspace = workspace_dir.map(|s| !s.trim().is_empty()).unwrap_or(false);
    if save_path.trim().is_empty() && !has_workspace {
        return Err("Enregistrez le projet avant de découper un audio.".to_string());
    }

    let target_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
        Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
        None => project_dir_from_save_path(save_path)?.join("fichiers-importes"),
    };
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
    fs::canonicalize(&target_dir)
        .map_err(|e| format!("Dossier fichiers-importes inaccessible : {}", e))
}

fn split_one_segment(
    ffmpeg: &std::path::Path,
    input_path: &str,
    target_dir: &std::path::Path,
    segment: &AudioSplitSegment,
) -> Result<AudioSplitSuccess, String> {
    if !segment.start_sec.is_finite() || segment.start_sec < 0.0 {
        return Err("Le point d'entrée est invalide.".to_string());
    }
    if !segment.end_sec.is_finite() || segment.end_sec <= segment.start_sec {
        return Err("Le point de sortie doit être après le point d'entrée.".to_string());
    }

    let output_name = validate_audio_assembly_filename(&segment.output_file_name)?;
    let output_path = unique_audio_assembly_path(target_dir, &output_name)?;
    let params = AudioEditParams {
        mode: "trim",
        start_sec: segment.start_sec,
        end_sec: segment.end_sec,
        fade_in_sec: 0.0,
        fade_out_sec: 0.0,
        cut_fade_sec: 0.0,
    };

    let result = run_ffmpeg_audio_edit(FfmpegAudioEditRequest {
        ffmpeg,
        input: input_path,
        output: &output_path.to_string_lossy(),
        params,
        ext: WORKING_AUDIO_EXTENSION,
    });
    if let Err(err) = result {
        let _ = fs::remove_file(&output_path);
        return Err(err);
    }

    Ok(AudioSplitSuccess {
        output_path: path_for_frontend(&output_path.to_string_lossy()),
        output_file_name: output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&output_name)
            .to_string(),
        start_sec: segment.start_sec,
        end_sec: segment.end_sec,
    })
}

pub fn split_audio_segments(
    save_path: &str,
    input_path: &str,
    segments: &[AudioSplitSegment],
    workspace_dir: Option<&str>,
) -> Result<AudioSplitResult, String> {
    if segments.is_empty() {
        return Err("Ajoutez au moins un extrait à générer.".to_string());
    }
    let input = validate_audio_assembly_input(input_path)?;
    let input_path = input.to_string_lossy().to_string();
    let target_dir = split_target_dir(save_path, workspace_dir)?;
    let ffmpeg = get_ffmpeg_path()?;

    let mut created = Vec::new();
    let mut failed = Vec::new();
    for segment in segments {
        match split_one_segment(&ffmpeg, &input_path, &target_dir, segment) {
            Ok(success) => created.push(success),
            Err(error) => failed.push(AudioSplitFailure {
                output_file_name: segment.output_file_name.clone(),
                start_sec: segment.start_sec,
                end_sec: segment.end_sec,
                error,
            }),
        }
    }

    Ok(AudioSplitResult { created, failed })
}
