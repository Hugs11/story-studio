use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::ffmpeg::apply_no_window;

use super::models::{
    issue, round_secs, AudioValidationItem, PackValidationIssue, PackValidationSeverity,
    AUDIO_MAX_EDGE_SILENCE_SECONDS, AUDIO_MAX_RECOMMENDED_LUFS, AUDIO_MIN_EDGE_SILENCE_SECONDS,
    AUDIO_MIN_RECOMMENDED_LUFS, AUDIO_TARGET_EDGE_SILENCE_SECONDS, AUDIO_TARGET_INTEGRATED_LUFS,
    AUDIO_TARGET_LRA, AUDIO_TARGET_TRUE_PEAK_DB,
};

#[derive(Debug, Clone, Default)]
struct AudioProbe {
    duration_secs: Option<f64>,
    codec: Option<String>,
    sample_rate: Option<u32>,
    channels: Option<String>,
    leading_silence_secs: Option<f64>,
    trailing_silence_secs: Option<f64>,
    integrated_lufs: Option<f64>,
    true_peak_db: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
struct AudioIssueTarget<'a> {
    label: &'a str,
    file_path: &'a str,
    item_type: &'a str,
}

pub(crate) fn analyze_audio_file(
    ffmpeg: &Path,
    input: &Path,
    asset_name: &str,
    label: &str,
    item_type: &str,
) -> (AudioValidationItem, Vec<PackValidationIssue>) {
    let probe = probe_audio(ffmpeg, input).unwrap_or_default();
    let mut issues = Vec::new();
    let mut fix_parts = Vec::new();
    let mut status = PackValidationSeverity::Ok;
    let mut manual_block = false;
    let file_path = format!("assets/{}", asset_name);
    let target = AudioIssueTarget {
        label,
        file_path: &file_path,
        item_type,
    };

    let ext = Path::new(asset_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let codec_is_mp3 = probe
        .codec
        .as_deref()
        .map(|value| value.to_ascii_lowercase().contains("mp3"))
        .unwrap_or(false);

    if ext != "mp3" || !codec_is_mp3 {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Error,
            target,
            "Cet audio n'est pas au bon format pour la Lunii.",
            Some(format!(
                "Détecté : extension {}, codec {}. Attendu : MP3.",
                if ext.is_empty() { "inconnue" } else { &ext },
                probe.codec.as_deref().unwrap_or("inconnu")
            )),
            true,
            Some("Convertir en MP3.".to_string()),
        );
        status = PackValidationSeverity::Error;
        fix_parts.push("convertir en MP3");
    }

    if probe.sample_rate != Some(44_100) {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Error,
            target,
            "Cet audio n'a pas la bonne fréquence pour la Lunii.",
            Some(format!(
                "Détecté : {}. Attendu : 44.1 kHz.",
                probe
                    .sample_rate
                    .map(|value| format!("{} Hz", value))
                    .unwrap_or_else(|| "inconnu".to_string())
            )),
            true,
            Some("Convertir en 44.1 kHz.".to_string()),
        );
        status = PackValidationSeverity::Error;
        fix_parts.push("convertir en 44.1 kHz");
    }

    let is_mono = probe
        .channels
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("mono"))
        .unwrap_or(false);
    if !is_mono {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Error,
            target,
            "Cet audio n'est pas en mono.",
            Some(format!(
                "Détecté : {}. Attendu : mono.",
                probe.channels.as_deref().unwrap_or("inconnu")
            )),
            true,
            Some("Convertir en mono.".to_string()),
        );
        status = PackValidationSeverity::Error;
        fix_parts.push("convertir en mono");
    }

    if let Some(duration) = probe.duration_secs {
        if duration < 0.25 {
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Error,
                target,
                "Cet audio est trop court pour être corrigé automatiquement.",
                Some(format!("Durée détectée : {:.2} s.", duration)),
                false,
                None,
            );
            status = PackValidationSeverity::Error;
            manual_block = true;
        }
    } else {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Error,
            target,
            "Story Studio n'arrive pas à mesurer cet audio.",
            None,
            false,
            None,
        );
        status = PackValidationSeverity::Error;
        manual_block = true;
    }

    add_silence_issue(
        &mut issues,
        &mut status,
        &mut fix_parts,
        target,
        "début",
        probe.leading_silence_secs,
    );
    add_silence_issue(
        &mut issues,
        &mut status,
        &mut fix_parts,
        target,
        "fin",
        probe.trailing_silence_secs,
    );

    match probe.integrated_lufs {
        Some(lufs) if lufs < -45.0 => {
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Error,
                target,
                "Cet audio semble presque muet.",
                Some(format!("Volume moyen mesuré : {:.1} LUFS.", lufs)),
                false,
                None,
            );
            status = PackValidationSeverity::Error;
            manual_block = true;
        }
        Some(lufs) if !(AUDIO_MIN_RECOMMENDED_LUFS..=AUDIO_MAX_RECOMMENDED_LUFS).contains(&lufs) => {
            let direction = if lufs < AUDIO_MIN_RECOMMENDED_LUFS {
                "trop faible"
            } else {
                "trop fort"
            };
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Warning,
                target,
                format!("Le volume moyen de cet audio est {}.", direction),
                Some(format!(
                    "Volume moyen mesuré : {:.1} LUFS. Recommandé : -18 à -10 LUFS.",
                    lufs
                )),
                true,
                Some("Normaliser le volume.".to_string()),
            );
            if status != PackValidationSeverity::Error {
                status = PackValidationSeverity::Warning;
            }
            fix_parts.push("normaliser le volume");
        }
        _ => {
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Warning,
                target,
                "Le volume n'a pas pu être mesuré précisément.",
                None,
                false,
                None,
            );
            if status == PackValidationSeverity::Ok {
                status = PackValidationSeverity::Warning;
            }
        }
    }

    let auto_fix_available = !manual_block && !fix_parts.is_empty();
    if manual_block {
        for issue in &mut issues {
            issue.auto_fix_available = false;
            issue.auto_fix_description = None;
        }
    }
    let fix_summary = if auto_fix_available {
        Some(unique_join(&fix_parts))
    } else {
        None
    };

    (
        AudioValidationItem {
            file_path,
            label: label.to_string(),
            item_type: item_type.to_string(),
            status: status.as_status().to_string(),
            auto_fix_available,
            fix_summary,
            duration_secs: probe.duration_secs.map(round_secs),
            codec: probe.codec,
            sample_rate: probe.sample_rate,
            channels: probe.channels,
            leading_silence_secs: probe.leading_silence_secs.map(round_secs),
            trailing_silence_secs: probe.trailing_silence_secs.map(round_secs),
            integrated_lufs: probe.integrated_lufs.map(|value| (value * 10.0).round() / 10.0),
            true_peak_db: probe.true_peak_db.map(|value| (value * 10.0).round() / 10.0),
        },
        issues,
    )
}

pub(crate) fn fix_audio_file(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    item: &AudioValidationItem,
) -> Result<(), String> {
    let mut filters = Vec::new();
    let trim_start = item
        .leading_silence_secs
        .filter(|value| *value > AUDIO_MAX_EDGE_SILENCE_SECONDS)
        .map(|value| (value - AUDIO_TARGET_EDGE_SILENCE_SECONDS).max(0.0))
        .unwrap_or(0.0);
    let trim_end = match (item.trailing_silence_secs, item.duration_secs) {
        (Some(trailing), Some(duration)) if trailing > AUDIO_MAX_EDGE_SILENCE_SECONDS => {
            Some(duration - (trailing - AUDIO_TARGET_EDGE_SILENCE_SECONDS))
        }
        _ => None,
    };
    if trim_start > 0.001 || trim_end.is_some() {
        let mut trim = format!("atrim=start={}", format_seconds(trim_start));
        if let Some(end) = trim_end {
            if end <= trim_start + 0.05 {
                return Err(format!(
                    "Audio trop court après ajustement des silences : {}",
                    item.file_path
                ));
            }
            trim.push_str(&format!(":end={}", format_seconds(end)));
        }
        filters.push(trim);
        filters.push("asetpts=PTS-STARTPTS".to_string());
    }

    filters.push("aformat=channel_layouts=mono".to_string());
    filters.push(format!(
        "loudnorm=I={}:TP={}:LRA={}",
        format_seconds(AUDIO_TARGET_INTEGRATED_LUFS),
        format_seconds(AUDIO_TARGET_TRUE_PEAK_DB),
        format_seconds(AUDIO_TARGET_LRA)
    ));

    if let Some(leading) = item.leading_silence_secs {
        if leading < AUDIO_MIN_EDGE_SILENCE_SECONDS {
            let missing = (AUDIO_TARGET_EDGE_SILENCE_SECONDS - leading).max(0.0);
            filters.push(format!("adelay={}", (missing * 1000.0).round()));
        }
    }
    if let Some(trailing) = item.trailing_silence_secs {
        if trailing < AUDIO_MIN_EDGE_SILENCE_SECONDS {
            let missing = (AUDIO_TARGET_EDGE_SILENCE_SECONDS - trailing).max(0.0);
            filters.push(format!("apad=pad_dur={}", format_seconds(missing)));
        }
    }

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-map")
        .arg("0:a:0")
        .arg("-af")
        .arg(filters.join(","))
        .arg("-ar")
        .arg("44100")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-q:a")
        .arg("5")
        .arg("-map_metadata")
        .arg("-1")
        .arg("-id3v2_version")
        .arg("0")
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "Correction audio échouée pour {} :\n{}",
            item.file_path,
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

fn probe_audio(ffmpeg: &Path, input: &Path) -> Result<AudioProbe, String> {
    let mut probe = AudioProbe::default();
    let metadata = run_ffmpeg(ffmpeg, input, &["-hide_banner", "-i"])?;
    probe.duration_secs = parse_duration(&metadata);
    let (codec, sample_rate, channels) = parse_audio_stream(&metadata);
    probe.codec = codec;
    probe.sample_rate = sample_rate;
    probe.channels = channels;

    if let Ok(silence) = run_ffmpeg(
        ffmpeg,
        input,
        &[
            "-hide_banner",
            "-nostats",
            "-i",
            "__INPUT__",
            "-af",
            "silencedetect=noise=-50dB:d=0.05",
            "-f",
            "null",
            "-",
        ],
    ) {
        let (leading, trailing) = parse_silence_edges(&silence, probe.duration_secs);
        probe.leading_silence_secs = leading;
        probe.trailing_silence_secs = trailing;
    }

    if let Ok(loudness) = run_ffmpeg(
        ffmpeg,
        input,
        &[
            "-hide_banner",
            "-nostats",
            "-i",
            "__INPUT__",
            "-af",
            "loudnorm=I=-12:TP=-1.5:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ],
    ) {
        let (lufs, peak) = parse_loudnorm(&loudness);
        probe.integrated_lufs = lufs;
        probe.true_peak_db = peak;
    }

    Ok(probe)
}

fn run_ffmpeg(ffmpeg: &Path, input: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(ffmpeg);
    for arg in args {
        if *arg == "__INPUT__" {
            cmd.arg(input);
        } else {
            cmd.arg(arg);
        }
    }
    if !args.contains(&"__INPUT__") {
        cmd.arg(input);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    Ok(String::from_utf8_lossy(&out.stderr).to_string())
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

fn parse_audio_stream(stderr: &str) -> (Option<String>, Option<u32>, Option<String>) {
    let Some(start) = stderr.find("Audio: ").map(|index| index + "Audio: ".len()) else {
        return (None, None, None);
    };
    let rest = &stderr[start..];
    let line = rest.lines().next().unwrap_or(rest);
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    let codec = parts
        .first()
        .and_then(|value| value.split_whitespace().next())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let sample_rate = parts.iter().find_map(|part| {
        let hz_pos = part.find(" Hz")?;
        part[..hz_pos].trim().parse::<u32>().ok()
    });
    let channels = parts.iter().find_map(|part| {
        let lower = part.to_ascii_lowercase();
        if lower == "mono" || lower.contains(" mono") {
            Some("mono".to_string())
        } else if lower.contains("stereo") {
            Some("stereo".to_string())
        } else if lower.contains("dual") {
            Some("dual channel".to_string())
        } else {
            None
        }
    });
    (codec, sample_rate, channels)
}

fn parse_silence_edges(stderr: &str, duration: Option<f64>) -> (Option<f64>, Option<f64>) {
    let mut starts: Vec<f64> = Vec::new();
    let mut events: Vec<(f64, Option<f64>)> = Vec::new();
    for line in stderr.lines() {
        if let Some(value) = parse_after(line, "silence_start:") {
            starts.push(value);
            events.push((value, None));
        }
        if let Some(end) = parse_after(line, "silence_end:") {
            if let Some(last) = events.last_mut() {
                if last.1.is_none() {
                    last.1 = Some(end);
                }
            }
        }
    }

    let leading = if events.is_empty() && duration.is_some() {
        Some(0.0)
    } else {
        events.first().map(|(start, end)| {
            if *start <= 0.05 {
                end.or(duration).unwrap_or(*start) - *start
            } else {
                0.0
            }
        })
    };
    let trailing = match (events.last(), duration) {
        (None, Some(_)) => Some(0.0),
        (Some((start, Some(end))), Some(duration)) if *end >= duration - 0.08 => {
            Some((duration - *start).max(0.0))
        }
        (Some((start, None)), Some(duration)) => Some((duration - *start).max(0.0)),
        (Some(_), Some(_)) => Some(0.0),
        _ => None,
    };
    (leading, trailing)
}

fn parse_loudnorm(stderr: &str) -> (Option<f64>, Option<f64>) {
    let Some(start) = stderr.find('{') else {
        return (None, None);
    };
    let Some(end) = stderr.rfind('}') else {
        return (None, None);
    };
    let json_text = &stderr[start..=end];
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json_text) else {
        return (None, None);
    };
    let input_i = value
        .get("input_i")
        .and_then(|value| value.as_str())
        .and_then(parse_finite_float);
    let input_tp = value
        .get("input_tp")
        .and_then(|value| value.as_str())
        .and_then(parse_finite_float);
    (input_i, input_tp)
}

fn parse_after(line: &str, marker: &str) -> Option<f64> {
    let start = line.find(marker)? + marker.len();
    line[start..]
        .trim()
        .split([' ', '|'])
        .next()
        .and_then(parse_finite_float)
}

fn parse_finite_float(raw: &str) -> Option<f64> {
    let value = raw.trim().parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn add_silence_issue(
    issues: &mut Vec<PackValidationIssue>,
    status: &mut PackValidationSeverity,
    fix_parts: &mut Vec<&'static str>,
    target: AudioIssueTarget<'_>,
    side: &str,
    measured: Option<f64>,
) {
    let Some(measured) = measured else {
        push_audio_issue(
            issues,
            PackValidationSeverity::Warning,
            target,
            format!("Le silence de {} n'a pas pu être mesuré.", side),
            None,
            false,
            None,
        );
        if *status == PackValidationSeverity::Ok {
            *status = PackValidationSeverity::Warning;
        }
        return;
    };
    if measured < AUDIO_MIN_EDGE_SILENCE_SECONDS {
        let missing = AUDIO_TARGET_EDGE_SILENCE_SECONDS - measured;
        push_audio_issue(
            issues,
            PackValidationSeverity::Warning,
            target,
            format!("Le silence au {} est trop court.", side),
            Some(format!(
                "Détecté : {:.2} s. Accepté : 0.5 à 1.0 s. Correction proposée : ajouter {:.2} s.",
                measured, missing.max(0.0)
            )),
            true,
            Some(format!(
                "Ajouter du silence au {} pour atteindre {:.2} s.",
                side, AUDIO_TARGET_EDGE_SILENCE_SECONDS
            )),
        );
        if *status != PackValidationSeverity::Error {
            *status = PackValidationSeverity::Warning;
        }
        fix_parts.push("ajuster les silences");
    } else if measured > AUDIO_MAX_EDGE_SILENCE_SECONDS {
        push_audio_issue(
            issues,
            PackValidationSeverity::Warning,
            target,
            format!("Le silence au {} est trop long.", side),
            Some(format!(
                "Détecté : {:.2} s. Accepté : 0.5 à 1.0 s. Correction proposée : ramener à {:.2} s.",
                measured, AUDIO_TARGET_EDGE_SILENCE_SECONDS
            )),
            true,
            Some(format!(
                "Réduire le silence au {} à {:.2} s.",
                side, AUDIO_TARGET_EDGE_SILENCE_SECONDS
            )),
        );
        if *status != PackValidationSeverity::Error {
            *status = PackValidationSeverity::Warning;
        }
        fix_parts.push("ajuster les silences");
    }
}

fn push_audio_issue(
    issues: &mut Vec<PackValidationIssue>,
    severity: PackValidationSeverity,
    target: AudioIssueTarget<'_>,
    message: impl Into<String>,
    technical_details: Option<String>,
    auto_fix_available: bool,
    auto_fix_description: Option<String>,
) {
    let mut entry = issue(severity, "audio", target.label, message);
    entry.technical_details = technical_details;
    entry.file_path = Some(target.file_path.to_string());
    entry.item_type = Some(target.item_type.to_string());
    entry.auto_fix_available = auto_fix_available;
    entry.auto_fix_description = auto_fix_description;
    issues.push(entry);
}

fn unique_join(parts: &[&str]) -> String {
    let mut out = Vec::new();
    for part in parts {
        if !out.contains(part) {
            out.push(*part);
        }
    }
    out.join(", ")
}

fn format_seconds(value: f64) -> String {
    let formatted = format!("{:.3}", value);
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn compact_ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "Erreur FFmpeg inconnue.".to_string();
    }
    let start = lines.len().saturating_sub(8);
    lines[start..].join("\n")
}
