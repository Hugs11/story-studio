use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::ffmpeg::{apply_no_window, loudnorm_filter, measure_loudnorm};

use super::models::{
    issue, round_secs, AudioValidationItem, PackValidationIssue, PackValidationSeverity,
    AUDIO_MAX_EDGE_SILENCE_SECONDS, AUDIO_MAX_RECOMMENDED_LUFS, AUDIO_MIN_EDGE_SILENCE_SECONDS,
    AUDIO_MIN_RECOMMENDED_LUFS, AUDIO_TARGET_EDGE_SILENCE_SECONDS, AUDIO_TARGET_INTEGRATED_LUFS,
    AUDIO_TARGET_LRA, AUDIO_TARGET_TRUE_PEAK_DB, EDGE_MIN_ONSET_MS, EDGE_RMS_ABS_CEIL_DB,
    EDGE_RMS_ABS_FLOOR_DB, EDGE_RMS_CONTENT_PERCENTILE, EDGE_RMS_FLOOR_PERCENTILE,
    EDGE_RMS_GAP_FRACTION, EDGE_RMS_MARGIN_DB, EDGE_RMS_WINDOW_SAMPLES, EDGE_TRIM_GUARD_SECONDS,
};

#[derive(Debug, Clone, Default)]
struct AudioProbe {
    duration_secs: Option<f64>,
    codec: Option<String>,
    sample_rate: Option<u32>,
    channels: Option<String>,
    leading_silence_secs: Option<f64>,
    trailing_silence_secs: Option<f64>,
    audio_is_silent: bool,
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

    if probe.audio_is_silent {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Error,
            target,
            "Cet audio ne contient aucun son audible.",
            Some("Aucun contenu détecté au-dessus du plancher de bruit.".to_string()),
            false,
            None,
        );
        status = PackValidationSeverity::Error;
        manual_block = true;
    } else {
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
    }

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
        Some(lufs)
            if !(AUDIO_MIN_RECOMMENDED_LUFS..=AUDIO_MAX_RECOMMENDED_LUFS).contains(&lufs) =>
        {
            let direction = if lufs < AUDIO_MIN_RECOMMENDED_LUFS {
                "trop faible"
            } else {
                "trop fort"
            };
            let can_normalize = probe
                .true_peak_db
                .map(|peak| has_loudness_gain_headroom(lufs, peak))
                .unwrap_or(true);
            let details = if can_normalize {
                format!(
                    "Volume moyen mesuré : {:.1} LUFS. Recommandé : {:.0} à {:.0} LUFS.",
                    lufs, AUDIO_MIN_RECOMMENDED_LUFS, AUDIO_MAX_RECOMMENDED_LUFS
                )
            } else {
                format!(
                    "Volume moyen mesuré : {:.1} LUFS, crête vraie : {:.1} dBTP. Recommandé : {:.0} à {:.0} LUFS. La crête laisse trop peu de marge pour une normalisation automatique transparente.",
                    lufs,
                    probe.true_peak_db.unwrap_or_default(),
                    AUDIO_MIN_RECOMMENDED_LUFS,
                    AUDIO_MAX_RECOMMENDED_LUFS
                )
            };
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Warning,
                target,
                format!("Le volume moyen de cet audio est {}.", direction),
                Some(details),
                can_normalize,
                can_normalize.then(|| "Normaliser le volume.".to_string()),
            );
            if status != PackValidationSeverity::Error {
                status = PackValidationSeverity::Warning;
            }
            if can_normalize {
                fix_parts.push("normaliser le volume");
            }
        }
        // Volume mesuré et dans la plage recommandée : rien à signaler.
        Some(_) => {}
        // Uniquement le cas réellement non mesurable (loudnorm n'a pas produit
        // de mesure exploitable). Un volume correct ne doit JAMAIS atterrir ici.
        None => {
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
            integrated_lufs: probe
                .integrated_lufs
                .map(|value| (value * 10.0).round() / 10.0),
            true_peak_db: probe
                .true_peak_db
                .map(|value| (value * 10.0).round() / 10.0),
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
    // Stratégie anti « dé-silençage » : pour tout bord dont le silence est
    // mesurable, on retire le silence existant AVANT loudnorm, puis on recrée
    // un silence numériquement pur (zéros) à la cible APRÈS loudnorm. La
    // réanalyse mesure ainsi toujours un bord propre et converge, au lieu de
    // voir un ancien silence dont le plancher de bruit aurait été remonté par
    // la normalisation. C'est aligné sur la génération native (loudnorm puis
    // adelay/apad). Un bord non mesurable est laissé intact.
    let rebuild_leading = item.leading_silence_secs.is_some();
    let rebuild_trailing = item.trailing_silence_secs.is_some();

    // Trim conservateur : on coupe un poil moins que la mesure réelle (la valeur
    // affichée à l'utilisateur reste, elle, la mesure exacte) pour ne jamais
    // entamer l'attaque du contenu. Le silence pur réinjecté ensuite garantit la
    // convergence de la ré-analyse.
    let trim_start = if rebuild_leading {
        (item.leading_silence_secs.unwrap_or(0.0) - EDGE_TRIM_GUARD_SECONDS).max(0.0)
    } else {
        0.0
    };
    let trim_trailing = if rebuild_trailing {
        (item.trailing_silence_secs.unwrap_or(0.0) - EDGE_TRIM_GUARD_SECONDS).max(0.0)
    } else {
        0.0
    };

    let mut pre_filters = Vec::new();
    if let Some(duration) = item.duration_secs {
        if trim_start + trim_trailing >= duration - 0.05 {
            return Err(format!(
                "Audio trop court après ajustement des silences : {}",
                item.file_path
            ));
        }
    }
    if trim_start > 0.001 {
        pre_filters.push(format!("atrim=start={}", format_seconds(trim_start)));
        pre_filters.push("asetpts=PTS-STARTPTS".to_string());
    }
    if trim_trailing > 0.001 {
        pre_filters.push("areverse".to_string());
        pre_filters.push(format!("atrim=start={}", format_seconds(trim_trailing)));
        pre_filters.push("asetpts=PTS-STARTPTS".to_string());
        pre_filters.push("areverse".to_string());
        pre_filters.push("asetpts=PTS-STARTPTS".to_string());
    }

    if pre_filters
        .iter()
        .any(|filter| filter.starts_with("atrim="))
    {
        if let Some(duration) = item.duration_secs {
            if duration <= 0.05 {
                return Err(format!(
                    "Audio trop court après ajustement des silences : {}",
                    item.file_path
                ));
            }
        }
    }

    pre_filters.push("aformat=channel_layouts=mono".to_string());

    // Loudnorm deux passes : on mesure sur le contenu réellement normalisé
    // (après trim des bords + mono), puis application en mode linéaire pour
    // viser précisément I=-12 sans compression dynamique. Repli une passe si
    // la mesure échoue.
    let stats = measure_loudnorm(
        ffmpeg,
        input,
        &pre_filters,
        AUDIO_TARGET_INTEGRATED_LUFS,
        AUDIO_TARGET_TRUE_PEAK_DB,
        AUDIO_TARGET_LRA,
    );

    let mut filters = pre_filters;
    filters.push(loudnorm_filter(
        stats,
        AUDIO_TARGET_INTEGRATED_LUFS,
        AUDIO_TARGET_TRUE_PEAK_DB,
        AUDIO_TARGET_LRA,
    ));

    if rebuild_leading {
        filters.push(format!(
            "adelay={}",
            (AUDIO_TARGET_EDGE_SILENCE_SECONDS * 1000.0).round()
        ));
    }
    if rebuild_trailing {
        filters.push(format!(
            "apad=pad_dur={}",
            format_seconds(AUDIO_TARGET_EDGE_SILENCE_SECONDS)
        ));
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

    // Une seule passe avant : enveloppe RMS par fenêtre (mono mixdown). On en
    // déduit les deux bords sans `areverse` ni dépendance à la durée déclarée du
    // MP3 (la fin est calculée depuis l'horodatage mesuré de la dernière fenêtre).
    let envelope_filter = format!(
        "aformat=channel_layouts=mono,asetnsamples=n={}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        EDGE_RMS_WINDOW_SAMPLES
    );
    if let Ok(stderr) = run_ffmpeg(
        ffmpeg,
        input,
        &[
            "-hide_banner",
            "-nostats",
            "-i",
            "__INPUT__",
            "-map",
            "0:a:0",
            "-af",
            envelope_filter.as_str(),
            "-f",
            "null",
            "-",
        ],
    ) {
        match edges_from_envelope(&parse_rms_envelope(&stderr)) {
            EdgeMeasure::Measured { leading, trailing } => {
                probe.leading_silence_secs = Some(leading);
                probe.trailing_silence_secs = Some(trailing);
            }
            EdgeMeasure::AllSilence => {
                probe.audio_is_silent = true;
            }
            EdgeMeasure::Unreadable => {}
        }
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

/// Résultat de la mesure des silences de bord à partir de l'enveloppe RMS.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum EdgeMeasure {
    /// Bords mesurés (en secondes). `0.0` = pas de silence de ce côté.
    Measured { leading: f64, trailing: f64 },
    /// Aucune fenêtre de contenu soutenue : fichier silencieux / sans son audible.
    AllSilence,
    /// Enveloppe vide : impossible à mesurer.
    Unreadable,
}

/// Lit les paires `(temps, RMS_dB)` produites par
/// `astats=metadata=1:reset=1,ametadata=print`. `pts_time:` et `RMS_level=`
/// sont sur deux lignes successives. Les valeurs non finies (`-inf`, `nan`,
/// silence numérique pur) sont conservées comme `-inf` (donc « sous tout seuil »).
pub(super) fn parse_rms_envelope(stderr: &str) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    let mut pending_time: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(pos) = line.find("pts_time:") {
            let token = line[pos + "pts_time:".len()..]
                .split_whitespace()
                .next()
                .unwrap_or("");
            if let Ok(time) = token.trim().parse::<f64>() {
                pending_time = Some(time);
            }
        } else if let Some(pos) = line.find("RMS_level=") {
            let token = line[pos + "RMS_level=".len()..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim();
            // f64::parse gère « -inf » / « nan » nativement.
            let rms = token.parse::<f64>().unwrap_or(f64::NEG_INFINITY);
            let rms = if rms.is_nan() {
                f64::NEG_INFINITY
            } else {
                rms
            };
            if let Some(time) = pending_time.take() {
                out.push((time, rms));
            }
        }
    }
    out
}

/// Calcule les silences de bord depuis l'enveloppe RMS. Seuil auto-calibré sur
/// le plancher du fichier, plafonné à une fraction de l'écart plancher→contenu
/// (jamais de rognage d'une intro douce), et exigence d'« attaque soutenue »
/// (≥ `EDGE_MIN_ONSET_MS`) pour ignorer un clic isolé en bord.
pub(super) fn edges_from_envelope(env: &[(f64, f64)]) -> EdgeMeasure {
    if env.is_empty() {
        return EdgeMeasure::Unreadable;
    }
    if env.iter().all(|(_, rms)| !rms.is_finite()) {
        return EdgeMeasure::AllSilence; // que du silence numérique
    }

    let win = median_window_len(env);
    let env_end = env.last().map(|(time, _)| time + win).unwrap_or(0.0);

    let mut sorted: Vec<f64> = env.iter().map(|(_, rms)| *rms).collect();
    sorted.sort_by(f64::total_cmp);
    let floor = percentile_sorted(&sorted, EDGE_RMS_FLOOR_PERCENTILE);
    let content = percentile_sorted(&sorted, EDGE_RMS_CONTENT_PERCENTILE);
    let gap = content - floor;
    let margin = if gap.is_finite() {
        EDGE_RMS_MARGIN_DB.min(gap * EDGE_RMS_GAP_FRACTION)
    } else {
        EDGE_RMS_MARGIN_DB
    };
    let thresh = (floor + margin).clamp(EDGE_RMS_ABS_FLOOR_DB, EDGE_RMS_ABS_CEIL_DB);

    let need = (((EDGE_MIN_ONSET_MS / 1000.0) / win).ceil()).max(2.0) as usize;

    match (
        first_sustained_above(env, thresh, need),
        last_sustained_above(env, thresh, need),
    ) {
        (Some(first), Some(last)) => EdgeMeasure::Measured {
            leading: env[first].0,
            trailing: (env_end - (env[last].0 + win)).max(0.0),
        },
        _ => EdgeMeasure::AllSilence,
    }
}

fn median_window_len(env: &[(f64, f64)]) -> f64 {
    let mut gaps: Vec<f64> = env
        .windows(2)
        .map(|pair| pair[1].0 - pair[0].0)
        .filter(|gap| *gap > 0.0)
        .collect();
    if gaps.is_empty() {
        return EDGE_RMS_WINDOW_SAMPLES as f64 / 44_100.0;
    }
    gaps.sort_by(f64::total_cmp);
    gaps[gaps.len() / 2]
}

fn percentile_sorted(sorted: &[f64], percentile: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NEG_INFINITY;
    }
    let idx = (((sorted.len() - 1) as f64) * percentile).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Indice de la première fenêtre d'un palier de `need` fenêtres consécutives
/// au-dessus du seuil (= début du contenu utile).
fn first_sustained_above(env: &[(f64, f64)], thresh: f64, need: usize) -> Option<usize> {
    if env.len() < need {
        return (!env.is_empty() && env.iter().all(|(_, rms)| *rms > thresh)).then_some(0);
    }
    let mut run = 0usize;
    for (idx, (_, rms)) in env.iter().enumerate() {
        if *rms > thresh {
            run += 1;
            if run >= need {
                return Some(idx + 1 - need);
            }
        } else {
            run = 0;
        }
    }
    None
}

/// Indice de la dernière fenêtre du dernier palier de `need` fenêtres
/// consécutives au-dessus du seuil (= fin du contenu utile). Un clic isolé en
/// toute fin n'est pas « soutenu » et n'écrase donc pas le silence de fin.
fn last_sustained_above(env: &[(f64, f64)], thresh: f64, need: usize) -> Option<usize> {
    if env.len() < need {
        return (!env.is_empty() && env.iter().all(|(_, rms)| *rms > thresh))
            .then_some(env.len() - 1);
    }
    let mut run = 0usize;
    for idx in (0..env.len()).rev() {
        if env[idx].1 > thresh {
            run += 1;
            if run >= need {
                return Some(idx + need - 1);
            }
        } else {
            run = 0;
        }
    }
    None
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

fn has_loudness_gain_headroom(measured_i: f64, measured_tp: f64) -> bool {
    let needed_gain = AUDIO_TARGET_INTEGRATED_LUFS - measured_i;
    if needed_gain <= 0.0 {
        return true;
    }
    let peak_headroom = AUDIO_TARGET_TRUE_PEAK_DB - measured_tp;
    needed_gain <= peak_headroom + 0.25
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
                "Détecté : {:.2} s. Accepté : {:.1} à {:.1} s. Correction proposée : ajouter {:.2} s.",
                measured,
                AUDIO_MIN_EDGE_SILENCE_SECONDS,
                AUDIO_MAX_EDGE_SILENCE_SECONDS,
                missing.max(0.0)
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
                "Détecté : {:.2} s. Accepté : {:.1} à {:.1} s. Correction proposée : ramener à {:.2} s.",
                measured,
                AUDIO_MIN_EDGE_SILENCE_SECONDS,
                AUDIO_MAX_EDGE_SILENCE_SECONDS,
                AUDIO_TARGET_EDGE_SILENCE_SECONDS
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
