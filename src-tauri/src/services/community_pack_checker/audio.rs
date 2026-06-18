use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::audio_norm::{
    build_edge_silence_filters, build_loudness_filters, loudness_in_validation_window,
    measure_edge_silence, measure_loudness_ebur128, plan_loudness_fix, EdgeMeasure, LoudnessAction,
    EDGE_SILENCE_SEC, EXPECTED_FINAL_TRUE_PEAK_DBTP, NEAR_MUTE_LUFS, TARGET_LUFS,
    VALIDATION_WINDOW_LUFS,
};

/// Détection d'écrêtage **côté lecture** : on décode en 16 bits entier (ce que
/// fait la Lunii), ce qui sature les dépassements de plein-échelle en plateaux,
/// puis on compte le ratio d'échantillons rabotés au pic. C'est la mesure la plus
/// fiable — un MP3 écrêté peut afficher un flat factor nul en décodage flottant
/// alors qu'il sature franchement en 16 bits. Un fichier propre en compte ~0
/// (≤ quelques échantillons isolés) ; un fichier écrêté en compte des milliers
/// (ratio mesuré 0,09–0,19 %, soit > 400× le bruit de fond d'un fichier sain).
const CLIP_SAMPLE_RATIO_WARN: f64 = 0.0002; // 0,02 %
/// Plancher absolu : sous ce nombre d'échantillons rabotés, on n'alerte jamais —
/// évite tout faux positif sur les fichiers très courts (invites) qui peuvent
/// toucher le pic sur 1 ou 2 échantillons isolés.
const CLIP_SAMPLE_MIN_COUNT: u64 = 32;
use crate::support::ffmpeg::apply_no_window;

use super::models::{
    issue, round_secs, AudioValidationItem, PackValidationIssue, PackValidationSeverity,
    AUDIO_MAX_EDGE_SILENCE_SECONDS, AUDIO_MIN_EDGE_SILENCE_SECONDS,
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
    clipped_samples: Option<u64>,
    total_samples: Option<u64>,
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
        Some(lufs) if lufs < NEAR_MUTE_LUFS => {
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
        Some(lufs) if !loudness_in_validation_window(lufs) => {
            let direction = if lufs < VALIDATION_WINDOW_LUFS.0 {
                "trop faible"
            } else {
                "trop fort"
            };
            let action = probe
                .true_peak_db
                .map(|peak| plan_loudness_fix(lufs, peak))
                .unwrap_or_else(|| LoudnessAction::Uncorrectable {
                    reason: "crête vraie non mesurée".to_string(),
                });
            let can_normalize = action.is_correctable();
            let details = if can_normalize {
                format!(
                    "Volume moyen mesuré : {:.1} LUFS. Fenêtre valide : {:.0} à {:.0} LUFS. Correction visée : {:.0} LUFS, crête MP3 attendue ≈ {:.1} dBTP.",
                    lufs,
                    VALIDATION_WINDOW_LUFS.0,
                    VALIDATION_WINDOW_LUFS.1,
                    TARGET_LUFS,
                    EXPECTED_FINAL_TRUE_PEAK_DBTP
                )
            } else {
                format!(
                    "Volume moyen mesuré : {:.1} LUFS, crête vraie : {:.1} dBTP. Fenêtre valide : {:.0} à {:.0} LUFS. Normalisation automatique indisponible : {}.",
                    lufs,
                    probe.true_peak_db.unwrap_or_default(),
                    VALIDATION_WINDOW_LUFS.0,
                    VALIDATION_WINDOW_LUFS.1,
                    loudness_action_reason(&action)
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
        // Volume dans la fenêtre valide : jamais un avertissement, rien à faire.
        Some(_) => {}
        // Uniquement le cas réellement non mesurable. Un volume correct ne doit
        // JAMAIS atterrir ici.
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

    // Écrêtage côté lecture (mesuré en 16 bits, comme la boîte) → audio saturé,
    // dont la qualité est dégradée **dans la source elle-même**. Indépendant du
    // niveau moyen : un fichier au bon volume peut être franchement écrêté.
    // Purement **informatif** : on ne tente pas de réparer un signal déjà saturé
    // (le ré-encodage limiterait la crête mais ne restaure rien), on conseille à
    // l'utilisateur de vérifier sa source.
    if !probe.audio_is_silent {
        if let (Some(clipped), Some(total)) = (probe.clipped_samples, probe.total_samples) {
            if audio_is_clipped(clipped, total) {
                let pct = 100.0 * clipped as f64 / total as f64;
                let peak = probe
                    .true_peak_db
                    .map(|p| format!(" (crête vraie {:.1} dBTP)", p))
                    .unwrap_or_default();
                push_audio_issue(
                    &mut issues,
                    PackValidationSeverity::Warning,
                    target,
                    "Cet audio est saturé : qualité dégradée par la source.",
                    Some(format!(
                        "Écrêtage détecté sur {:.2} % des échantillons{}. La saturation est déjà présente dans le fichier d'origine ; aucune régénération ne la restaure. Conseil : vérifiez la source et, si possible, remplacez-la par un enregistrement de meilleure qualité.",
                        pct, peak
                    )),
                    false,
                    None,
                );
                if status != PackValidationSeverity::Error {
                    status = PackValidationSeverity::Warning;
                }
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
    let rebuild_leading = item.leading_silence_secs.is_some();
    let rebuild_trailing = item.trailing_silence_secs.is_some();
    let trim_start = item.leading_silence_secs.unwrap_or(0.0);
    let trim_trailing = item.trailing_silence_secs.unwrap_or(0.0);

    let mut pre_filters = Vec::new();
    if let Some(duration) = item.duration_secs {
        if trim_start + trim_trailing >= duration - 0.05 {
            return Err(format!(
                "Audio trop court après ajustement des silences : {}",
                item.file_path
            ));
        }
    }
    let edge_filters = build_edge_silence_filters(trim_start, trim_trailing, EDGE_SILENCE_SEC);
    if rebuild_leading || rebuild_trailing {
        pre_filters.extend(edge_filters.pre_filters);
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

    let mut filters = pre_filters;
    // On corrige le niveau quand il est hors fenêtre, ou — si l'harmonisation
    // opt-in est demandée — quand il est dans la fenêtre mais hors bande morte.
    let should_fix_loudness = item
        .integrated_lufs
        .map(|value| !loudness_in_validation_window(value))
        .unwrap_or(false);
    if should_fix_loudness {
        let measure = measure_loudness_ebur128(ffmpeg, input, &filters).map_err(|e| {
            format!(
                "Mesure de niveau impossible pendant la correction de {} : {}",
                item.file_path, e
            )
        })?;
        let action = plan_loudness_fix(measure.integrated_lufs, measure.true_peak_db);
        if matches!(action, LoudnessAction::Uncorrectable { .. }) {
            return Err(format!(
                "Normalisation audio indisponible pour {} : {}",
                item.file_path,
                loudness_action_reason(&action)
            ));
        }
        filters.extend(build_loudness_filters(&action));
    }

    if rebuild_leading {
        filters.push(format!("adelay={}", (EDGE_SILENCE_SEC * 1000.0).round()));
    }
    if rebuild_trailing {
        filters.push(format!("apad=pad_dur={}", format_seconds(EDGE_SILENCE_SEC)));
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

    if let Ok(edge_measure) = measure_edge_silence(ffmpeg, input) {
        match edge_measure {
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

    let mut loudness_filters = edge_trim_filters(
        probe.leading_silence_secs,
        probe.trailing_silence_secs,
        probe.duration_secs,
    );
    loudness_filters.push("aformat=channel_layouts=mono".to_string());
    if let Ok(measure) = measure_loudness_ebur128(ffmpeg, input, &loudness_filters) {
        probe.integrated_lufs = Some(measure.integrated_lufs);
        probe.true_peak_db = Some(measure.true_peak_db);
    }

    if let Some((clipped, total)) = measure_clip_stats(ffmpeg, input) {
        probe.clipped_samples = Some(clipped);
        probe.total_samples = Some(total);
    }

    Ok(probe)
}

/// Compte les échantillons écrêtés **en décodant comme la boîte** : `aformat=s16`
/// sature les dépassements de plein-échelle (que le décodage flottant laisserait
/// passer en sur-1.0), puis `astats` reporte le nombre d'échantillons au pic et le
/// total. Renvoie `(écrêtés, total)`.
fn measure_clip_stats(ffmpeg: &Path, input: &Path) -> Option<(u64, u64)> {
    let filter = "aformat=sample_fmts=s16:channel_layouts=mono,\
astats=metadata=0:measure_perchannel=none:measure_overall=Peak_count+Number_of_samples";
    let stderr = run_ffmpeg(
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
            filter,
            "-f",
            "null",
            "-",
        ],
    )
    .ok()?;
    let clipped = parse_count_field(&stderr, "Peak count:")?;
    let total = parse_count_field(&stderr, "Number of samples:")?;
    Some((clipped, total))
}

/// `astats` imprime ses compteurs en flottant (`Peak count: 24374.000000`) ;
/// on lit donc un `f64` avant de convertir.
fn parse_count_field(stderr: &str, label: &str) -> Option<u64> {
    let pos = stderr.find(label)? + label.len();
    let token = stderr[pos..].split_whitespace().next()?.trim();
    let value = token.parse::<f64>().ok()?;
    (value.is_finite() && value >= 0.0).then_some(value as u64)
}

/// Écrêtage avéré : assez d'échantillons rabotés (au-dessus du plancher absolu)
/// **et** un ratio significatif — pour ne déclencher ni sur un fichier court ni
/// sur de rares touchers de pic isolés d'un fichier propre.
fn audio_is_clipped(clipped_samples: u64, total_samples: u64) -> bool {
    total_samples > 0
        && clipped_samples >= CLIP_SAMPLE_MIN_COUNT
        && (clipped_samples as f64) / (total_samples as f64) >= CLIP_SAMPLE_RATIO_WARN
}

fn edge_trim_filters(
    leading_silence_secs: Option<f64>,
    trailing_silence_secs: Option<f64>,
    duration_secs: Option<f64>,
) -> Vec<String> {
    let trim_start = leading_silence_secs
        .map(|value| value.max(0.0))
        .unwrap_or(0.0);
    let trim_trailing = trailing_silence_secs
        .map(|value| value.max(0.0))
        .unwrap_or(0.0);
    if duration_secs
        .map(|duration| trim_start + trim_trailing >= duration - 0.05)
        .unwrap_or(false)
    {
        return Vec::new();
    }

    build_edge_silence_filters(trim_start, trim_trailing, EDGE_SILENCE_SEC).pre_filters
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
        let missing = EDGE_SILENCE_SEC - measured;
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
                side, EDGE_SILENCE_SEC
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
                EDGE_SILENCE_SEC
            )),
            true,
            Some(format!(
                "Réduire le silence au {} à {:.2} s.",
                side, EDGE_SILENCE_SEC
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

fn loudness_action_reason(action: &LoudnessAction) -> &str {
    match action {
        LoudnessAction::Uncorrectable { reason } => reason,
        _ => "correction non requise",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_clipping_only_on_sustained_full_scale_runs() {
        // Témoins propres (mesurés) : 2–4 échantillons au pic sur des fichiers de
        // plusieurs minutes → jamais d'alerte.
        let five_min = 5 * 60 * 44_100;
        assert!(!audio_is_clipped(2, five_min));
        assert!(!audio_is_clipped(4, five_min));
        // Fichier court (invite) touchant le pic sur quelques échantillons : le
        // plancher absolu évite le faux positif malgré un ratio non négligeable.
        assert!(!audio_is_clipped(5, 3 * 44_100));
        // Fichiers V6 réellement écrêtés (mesurés : 8 000–24 000 échantillons,
        // 0,09–0,19 %) → signalés.
        assert!(audio_is_clipped(8_214, five_min));
        assert!(audio_is_clipped(24_374, 294 * 44_100));
        // Garde-fous : total nul ou en dessous du plancher → pas d'alerte.
        assert!(!audio_is_clipped(0, 0));
        assert!(!audio_is_clipped(20, five_min));
        // Long fichier propre touchant le pic plus de 32 fois mais à un ratio
        // infime : le garde-fou de ratio évite le faux positif.
        assert!(!audio_is_clipped(100, 100_000_000));
    }

    #[test]
    fn parses_astats_count_fields() {
        // astats imprime Peak count en flottant, Number of samples en entier.
        let stderr = "[Parsed_astats_1 @ x] Peak count: 24374.000000\n\
                      [Parsed_astats_1 @ x] Number of samples: 12946554\n";
        assert_eq!(parse_count_field(stderr, "Peak count:"), Some(24_374));
        assert_eq!(parse_count_field(stderr, "Number of samples:"), Some(12_946_554));
        assert_eq!(parse_count_field(stderr, "Absent:"), None);
    }

    /// Harnais manuel : passe le vrai `analyze_audio_file` sur des assets réels et
    /// imprime statut + alertes. No-op sauf si les variables d'env sont posées :
    ///   SS_CHECK_ASSETS = chemins MP3 séparés par `|`
    ///   SS_FFMPEG       = chemin de ffmpeg.exe
    #[test]
    fn check_assets_from_env() {
        let Ok(assets) = std::env::var("SS_CHECK_ASSETS") else {
            return;
        };
        let ffmpeg = std::env::var("SS_FFMPEG").expect("SS_FFMPEG");
        let ffmpeg = std::path::PathBuf::from(ffmpeg);
        for (i, path) in assets.split('|').enumerate() {
            let path = path.trim();
            if path.is_empty() {
                continue;
            }
            let p = std::path::Path::new(path);
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let (item, issues) =
                analyze_audio_file(&ffmpeg, p, &name, &format!("asset{i}"), "story");
            eprintln!(
                "[{name}] status={} tp={:?} dBTP lufs={:?}",
                item.status, item.true_peak_db, item.integrated_lufs
            );
            for iss in &issues {
                eprintln!("    - {:?} | {}", iss.severity, iss.message);
            }
        }
    }
}
