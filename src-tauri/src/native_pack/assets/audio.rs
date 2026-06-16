use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::super::{sanitize_stage_label, CanonicalOptions};
use crate::domain::project::SilenceMode;
use crate::services::project_files::validate_existing_file_path;
use crate::support::audio_norm::{
    build_edge_silence_filters, build_loudness_filters, measure_edge_silence,
    measure_loudness_ebur128, plan_loudness_fix, EdgeMeasure, EdgeSilenceFilters, LoudnessAction,
    EDGE_SILENCE_SEC,
};
use crate::support::ffmpeg::{apply_no_window, now_millis};

struct GenerationEdgePlan {
    measure_pre_filters: Vec<String>,
    output_filters: Option<EdgeSilenceFilters>,
}

pub(crate) fn audio_needs_processing(
    _source_path: &str,
    _options: &CanonicalOptions,
    _skip_silence: bool,
) -> bool {
    true
}

#[cfg(test)]
pub(crate) fn mp3_header_is_native_compatible(bytes: &[u8]) -> bool {
    let Some(offset) = find_mpeg_sync(bytes) else {
        return false;
    };
    if offset + 4 > bytes.len() {
        return false;
    }

    let h = &bytes[offset..offset + 4];
    let mpeg_version = (h[1] >> 3) & 0x03;
    let sample_rate_index = (h[2] >> 2) & 0x03;
    let channel_mode = (h[3] >> 6) & 0x03;

    mpeg_version == 3 && sample_rate_index == 0 && channel_mode == 3
}

#[cfg(test)]
pub(crate) fn find_mpeg_sync(bytes: &[u8]) -> Option<usize> {
    let start = if bytes.starts_with(b"ID3") && bytes.len() >= 10 {
        let size = ((bytes[6] as usize) << 21)
            | ((bytes[7] as usize) << 14)
            | ((bytes[8] as usize) << 7)
            | (bytes[9] as usize);
        10 + size
    } else {
        0
    };

    let search = bytes.get(start..)?;
    for i in 0..search.len().saturating_sub(1) {
        if search[i] == 0xFF && (search[i + 1] & 0xE0) == 0xE0 {
            return Some(start + i);
        }
    }
    None
}

pub(crate) fn process_audio_asset(
    source_path: &str,
    ffmpeg: &Path,
    processed_audio_dir: &Path,
    options: &CanonicalOptions,
    silence_duration_sec: f64,
    skip_silence: bool,
    role: &str,
) -> Result<PathBuf, String> {
    let source = validate_existing_file_path(source_path, role)?;
    let output_name = processed_audio_output_name(role);
    let output = processed_audio_dir.join(output_name);
    let edge_plan = edge_plan_for_generation(
        ffmpeg,
        &source,
        options,
        silence_duration_sec,
        skip_silence,
        role,
    )?;
    let mut measure_filters = edge_plan.measure_pre_filters.clone();
    measure_filters.push("aformat=channel_layouts=mono".to_string());

    let measure = measure_loudness_ebur128(ffmpeg, &source, &measure_filters)
        .map_err(|e| format!("Mesure audio native échouée pour {} : {}", role, e))?;
    let action = plan_loudness_fix(measure.integrated_lufs, measure.true_peak_db);
    if matches!(action, LoudnessAction::Uncorrectable { .. }) {
        return Err(format!(
            "Preparation audio native impossible pour {} : {}",
            role,
            loudness_action_reason(&action)
        ));
    }
    let filters = audio_filter_chain(
        options,
        skip_silence,
        silence_duration_sec,
        &action,
        edge_plan.output_filters.as_ref(),
    );

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-i",
        source.to_string_lossy().as_ref(),
        "-ac",
        "1",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "5",
        "-map_metadata",
        "-1",
        "-id3v2_version",
        "0",
        "-map",
        "0:a",
        "-af",
        &filters,
        output.to_string_lossy().as_ref(),
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let output_result = cmd
        .output()
        .map_err(|e| format!("ffmpeg introuvable pour {} : {}", role, e))?;
    if !output_result.status.success() {
        let stderr = String::from_utf8_lossy(&output_result.stderr);
        let summary = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Erreur ffmpeg inconnue");
        return Err(format!(
            "Preparation audio native echouee pour {} : {}",
            role, summary
        ));
    }
    Ok(output)
}

#[cfg(test)]
pub(crate) fn audio_filters(options: &CanonicalOptions, skip_silence: bool) -> String {
    audio_filters_with_duration(options, skip_silence, EDGE_SILENCE_SEC)
}

#[cfg(test)]
pub(crate) fn audio_filters_with_duration(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
) -> String {
    audio_filters_with_action(
        options,
        skip_silence,
        silence_duration_sec,
        &LoudnessAction::None,
    )
}

#[cfg(test)]
pub(crate) fn audio_filters_with_action(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
    action: &LoudnessAction,
) -> String {
    audio_filter_chain(options, skip_silence, silence_duration_sec, action, None)
}

/// Construit la chaîne de filtres audio natifs : mono, correction de niveau
/// planifiée par `audio_norm`, puis silence final si l'option le demande.
fn audio_filter_chain(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
    action: &LoudnessAction,
    edge_filters: Option<&EdgeSilenceFilters>,
) -> String {
    let mut filters = Vec::new();
    if matches!(options.silence_mode, SilenceMode::Normalize) && !skip_silence {
        if let Some(edge_filters) = edge_filters {
            filters.extend(edge_filters.pre_filters.clone());
        }
    }
    filters.push("aformat=channel_layouts=mono".to_string());
    filters.extend(build_loudness_filters(action));
    match options.silence_mode {
        SilenceMode::Off => {}
        SilenceMode::Add if !skip_silence => {
            let silence_duration_sec = normalized_silence_duration_sec(silence_duration_sec);
            filters.push(format!(
                "adelay={}",
                (silence_duration_sec * 1000.0).round()
            ));
            filters.push(format!(
                "apad=pad_dur={}",
                format_ffmpeg_seconds(silence_duration_sec)
            ));
        }
        SilenceMode::Normalize if !skip_silence => {
            if let Some(edge_filters) = edge_filters {
                filters.extend(edge_filters.post_filters.clone());
            } else {
                filters.extend(
                    build_edge_silence_filters(0.0, 0.0, silence_duration_sec).post_filters,
                );
            }
        }
        _ => {}
    }
    filters.join(",")
}

fn edge_plan_for_generation(
    ffmpeg: &Path,
    source: &Path,
    options: &CanonicalOptions,
    silence_duration_sec: f64,
    skip_silence: bool,
    role: &str,
) -> Result<GenerationEdgePlan, String> {
    let measured_edges = match measure_edge_silence(ffmpeg, source)
        .map_err(|e| format!("Mesure des silences native échouée pour {} : {}", role, e))?
    {
        EdgeMeasure::Measured { leading, trailing } => Some((leading, trailing)),
        EdgeMeasure::AllSilence => {
            return Err(format!(
                "Preparation audio native impossible pour {} : audio silencieux",
                role
            ))
        }
        EdgeMeasure::Unreadable => None,
    };

    let measure_pre_filters = measured_edges
        .map(|(leading, trailing)| {
            build_edge_silence_filters(leading, trailing, EDGE_SILENCE_SEC).pre_filters
        })
        .unwrap_or_default();

    let output_filters = if matches!(options.silence_mode, SilenceMode::Normalize) && !skip_silence
    {
        let (leading, trailing) = measured_edges.unwrap_or((0.0, 0.0));
        Some(build_edge_silence_filters(
            leading,
            trailing,
            silence_duration_sec,
        ))
    } else {
        None
    };

    Ok(GenerationEdgePlan {
        measure_pre_filters,
        output_filters,
    })
}

fn loudness_action_reason(action: &LoudnessAction) -> &str {
    match action {
        LoudnessAction::Uncorrectable { reason } => reason,
        _ => "correction non requise",
    }
}

fn normalized_silence_duration_sec(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        EDGE_SILENCE_SEC
    }
}

fn format_ffmpeg_seconds(value: f64) -> String {
    let formatted = format!("{:.3}", value);
    let trimmed = formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string();
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed
    }
}

pub(crate) fn hashed_asset_name(bytes: &[u8], extension: &str) -> String {
    format!("{:x}.{}", Sha1::digest(bytes), extension)
}

pub(crate) fn processed_audio_output_name(role: &str) -> String {
    let sanitized = sanitize_stage_label(role);
    let prefix: String = sanitized.chars().take(48).collect();
    let prefix = if prefix.is_empty() {
        "audio".to_string()
    } else {
        prefix
    };
    format!(
        "{}_{:x}_{}.mp3",
        prefix,
        Sha1::digest(role.as_bytes()),
        now_millis()
    )
}
