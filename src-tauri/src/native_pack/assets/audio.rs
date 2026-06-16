use sha1::{Digest, Sha1};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::super::{sanitize_stage_label, CanonicalOptions};
use crate::services::project_files::validate_existing_file_path;
use crate::support::ffmpeg::{
    apply_no_window, file_ext, loudnorm_filter, measure_loudnorm, now_millis, LoudnormStats,
};

const MP3_HEADER_SCAN_BYTES: usize = 1024 * 1024;
const DEFAULT_AUDIO_EDGE_SILENCE_SECONDS: f64 = 0.5;
const LOUDNORM_TARGET_I: f64 = -12.0;
const LOUDNORM_TARGET_TP: f64 = -1.5;
const LOUDNORM_TARGET_LRA: f64 = 11.0;

pub(crate) fn audio_needs_processing(
    source_path: &str,
    options: &CanonicalOptions,
    skip_silence: bool,
) -> bool {
    let ext = file_ext(source_path).to_ascii_lowercase();
    if options.add_silence && !skip_silence {
        return true;
    }
    if ext == "webm" {
        return true;
    }
    if !options.convert_format {
        return false;
    }
    if ext != "mp3" {
        return true;
    }

    !mp3_file_is_native_compatible(source_path).unwrap_or(false)
}

fn mp3_file_is_native_compatible(source_path: &str) -> Result<bool, String> {
    let mut file = fs::File::open(source_path)
        .map_err(|e| format!("Lecture header MP3 impossible pour {} : {}", source_path, e))?;
    let mut bytes = Vec::with_capacity(MP3_HEADER_SCAN_BYTES);
    Read::by_ref(&mut file)
        .take(MP3_HEADER_SCAN_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Lecture header MP3 impossible pour {} : {}", source_path, e))?;
    Ok(mp3_header_is_native_compatible(&bytes))
}

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
    // Loudnorm deux passes : on mesure d'abord (sur le contenu passé en mono),
    // puis on normalise en mode linéaire pour viser précisément I=-12 sans
    // compression dynamique. En cas d'échec de mesure, repli une passe.
    let stats = measure_loudnorm(
        ffmpeg,
        &source,
        &["aformat=channel_layouts=mono".to_string()],
        LOUDNORM_TARGET_I,
        LOUDNORM_TARGET_TP,
        LOUDNORM_TARGET_LRA,
    );
    let filters = audio_filters_two_pass(options, skip_silence, silence_duration_sec, stats);

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
    audio_filters_with_duration(options, skip_silence, DEFAULT_AUDIO_EDGE_SILENCE_SECONDS)
}

#[cfg(test)]
pub(crate) fn audio_filters_with_duration(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
) -> String {
    audio_filters_two_pass(options, skip_silence, silence_duration_sec, None)
}

/// Construit la chaîne de filtres. Si `stats` est fourni, loudnorm passe en
/// mode linéaire (seconde passe) ; sinon une passe dynamique (repli ou tests).
pub(crate) fn audio_filters_two_pass(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
    stats: Option<LoudnormStats>,
) -> String {
    let mut filters = vec![
        "aformat=channel_layouts=mono".to_string(),
        loudnorm_filter(
            stats,
            LOUDNORM_TARGET_I,
            LOUDNORM_TARGET_TP,
            LOUDNORM_TARGET_LRA,
        ),
    ];
    if options.add_silence && !skip_silence {
        // ffmpeg 4.2 (fourni avec SPG) ne supporte pas `adelay=...:all=1`.
        // On force donc d'abord un vrai mono, on normalise le contenu utile,
        // puis on applique le silence en dernier pour qu'il reste numeriquement
        // silencieux et ne perturbe pas la mesure loudnorm.
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
    filters.join(",")
}

fn normalized_silence_duration_sec(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        DEFAULT_AUDIO_EDGE_SILENCE_SECONDS
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
