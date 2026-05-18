use image::ImageReader;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path};

#[derive(Serialize, Deserialize, Clone)]
pub struct MediaMeta {
    pub path: String,
    pub size_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_secs: Option<f64>,
    pub sample_rate: Option<u32>,
    pub codec: Option<String>,
    pub modified_at: Option<u64>,
}

fn parse_duration(stderr: &str) -> Option<f64> {
    let marker = "Duration: ";
    let start = stderr.find(marker)? + marker.len();
    let end = start + stderr[start..].find(',')?;
    let ts = stderr[start..end].trim();
    let mut parts = ts.splitn(3, ':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let s: f64 = parts.next()?.trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn parse_audio_stream(stderr: &str) -> Option<(String, u32)> {
    let marker = "Audio: ";
    let start = stderr.find(marker)? + marker.len();
    let rest = &stderr[start..];
    let comma = rest.find(',')?;
    let codec = rest[..comma].trim().to_string();
    let after = rest[comma + 1..].trim_start();
    let hz_pos = after.find(" Hz")?;
    let sr: u32 = after[..hz_pos].trim().parse().ok()?;
    Some((codec, sr))
}

fn probe_one(path: &str) -> MediaMeta {
    let fs_meta = std::fs::metadata(path).ok();
    let size_bytes = fs_meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified_at = fs_meta
        .and_then(|m| m.created().or_else(|_| m.modified()).ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let is_image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif");
    let is_audio = matches!(ext.as_str(), "mp3" | "ogg" | "wav" | "m4a" | "webm" | "flac");

    let mut width = None;
    let mut height = None;
    let mut duration_secs = None;
    let mut sample_rate = None;
    let mut codec = None;

    if is_image {
        if let Ok(reader) = ImageReader::open(path) {
            if let Ok(reader) = reader.with_guessed_format() {
                if let Ok((w, h)) = reader.into_dimensions() {
                    width = Some(w);
                    height = Some(h);
                }
            }
        }
    }

    if is_audio {
        if let Ok(ffmpeg) = get_ffmpeg_path() {
            let mut cmd = std::process::Command::new(&ffmpeg);
            cmd.args(["-i", path]);
            cmd.stderr(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::null());
            apply_no_window(&mut cmd);
            if let Ok(output) = cmd.output() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                duration_secs = parse_duration(&stderr);
                if let Some((c, sr)) = parse_audio_stream(&stderr) {
                    codec = Some(c);
                    sample_rate = Some(sr);
                }
            }
        }
    }

    MediaMeta {
        path: path.to_string(),
        size_bytes,
        width,
        height,
        duration_secs,
        sample_rate,
        codec,
        modified_at,
    }
}

#[tauri::command]
pub async fn probe_media_files(paths: Vec<String>) -> Vec<MediaMeta> {
    tauri::async_runtime::spawn_blocking(move || -> Vec<MediaMeta> {
        paths.iter().map(|p| probe_one(p)).collect()
    })
    .await
    .unwrap_or_default()
}
