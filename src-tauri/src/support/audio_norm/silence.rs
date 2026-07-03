use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::ffmpeg::apply_no_window;

use super::filters::format_filter_num;
use super::types::EDGE_SILENCE_SEC;

pub(crate) const EDGE_RMS_WINDOW_SAMPLES: usize = 1024;
pub(crate) const EDGE_RMS_FLOOR_PERCENTILE: f64 = 0.05;
pub(crate) const EDGE_RMS_CONTENT_PERCENTILE: f64 = 0.75;
pub(crate) const EDGE_RMS_MARGIN_DB: f64 = 8.0;
pub(crate) const EDGE_RMS_GAP_FRACTION: f64 = 0.4;
pub(crate) const EDGE_RMS_ABS_FLOOR_DB: f64 = -55.0;
pub(crate) const EDGE_RMS_ABS_CEIL_DB: f64 = -36.0;
pub(crate) const EDGE_MIN_ONSET_MS: f64 = 60.0;
/// Marge de sécurité retirée du trim mesuré : on coupe un peu moins que le
/// silence détecté pour ne jamais entamer l'attaque du contenu. Le pad propre
/// (zéros) réinjecté ensuite garantit la convergence de la ré-analyse.
pub(crate) const EDGE_TRIM_GUARD_SEC: f64 = 0.02;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum EdgeMeasure {
    Measured { leading: f64, trailing: f64 },
    AllSilence,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EdgeSilenceFilters {
    pub pre_filters: Vec<String>,
    pub post_filters: Vec<String>,
}

pub(crate) fn measure_edge_silence(ffmpeg: &Path, input: &Path) -> Result<EdgeMeasure, String> {
    let envelope_filter = format!(
        "aformat=channel_layouts=mono,asetnsamples=n={}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        EDGE_RMS_WINDOW_SAMPLES
    );
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(input)
        .arg("-map")
        .arg("0:a:0")
        .arg("-af")
        .arg(envelope_filter)
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "Mesure des silences échouée : {}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(edges_from_envelope(&parse_rms_envelope(
        &String::from_utf8_lossy(&out.stderr),
    )))
}

pub(crate) fn build_edge_silence_filters(
    leading: f64,
    trailing: f64,
    target: f64,
) -> EdgeSilenceFilters {
    let target = if target.is_finite() && target >= 0.0 {
        target
    } else {
        EDGE_SILENCE_SEC
    };
    let mut pre_filters = Vec::new();
    let mut post_filters = Vec::new();

    let lead_trim = (leading - EDGE_TRIM_GUARD_SEC).max(0.0);
    let trail_trim = (trailing - EDGE_TRIM_GUARD_SEC).max(0.0);

    if lead_trim > 0.001 {
        pre_filters.push(format!("atrim=start={}", format_seconds(lead_trim)));
        pre_filters.push("asetpts=PTS-STARTPTS".to_string());
    }
    if trail_trim > 0.001 {
        pre_filters.push("areverse".to_string());
        pre_filters.push(format!("atrim=start={}", format_seconds(trail_trim)));
        pre_filters.push("asetpts=PTS-STARTPTS".to_string());
        pre_filters.push("areverse".to_string());
        pre_filters.push("asetpts=PTS-STARTPTS".to_string());
    }

    if target > 0.001 {
        post_filters.push(format!("adelay={}", (target * 1000.0).round()));
        post_filters.push(format!("apad=pad_dur={}", format_seconds(target)));
    }

    EdgeSilenceFilters {
        pre_filters,
        post_filters,
    }
}

/// Lit les paires `(temps, RMS_dB)` produites par
/// `astats=metadata=1:reset=1,ametadata=print`. `pts_time:` et `RMS_level=`
/// sont sur deux lignes successives.
pub(crate) fn parse_rms_envelope(stderr: &str) -> Vec<(f64, f64)> {
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
            let rms = token.parse::<f64>().unwrap_or(f64::NEG_INFINITY);
            let rms = if rms.is_nan() { f64::NEG_INFINITY } else { rms };
            if let Some(time) = pending_time.take() {
                out.push((time, rms));
            }
        }
    }
    out
}

pub(crate) fn edges_from_envelope(env: &[(f64, f64)]) -> EdgeMeasure {
    if env.is_empty() {
        return EdgeMeasure::Unreadable;
    }
    if env.iter().all(|(_, rms)| !rms.is_finite()) {
        return EdgeMeasure::AllSilence;
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

fn format_seconds(value: f64) -> String {
    format_filter_num(value)
}

fn compact_ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "erreur inconnue".to_string();
    }
    let start = lines.len().saturating_sub(5);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: f64 = 1024.0 / 44_100.0;

    fn build_env(segments: &[(f64, usize)]) -> Vec<(f64, f64)> {
        let mut env = Vec::new();
        let mut time = 0.0;
        for (level, count) in segments {
            for _ in 0..*count {
                env.push((time, *level));
                time += WIN;
            }
        }
        env
    }

    fn measured(measure: EdgeMeasure) -> (f64, f64) {
        match measure {
            EdgeMeasure::Measured { leading, trailing } => (
                (leading * 100.0).round() / 100.0,
                (trailing * 100.0).round() / 100.0,
            ),
            other => panic!("attendu Measured, obtenu {:?}", other),
        }
    }

    #[test]
    fn rms_envelope_parser_reads_pairs_and_handles_inf() {
        let stderr = "\
[Parsed_ametadata_1 @ x] frame:0 pts:0 pts_time:0
[Parsed_ametadata_1 @ x] lavfi.astats.Overall.RMS_level=-43.2
[Parsed_ametadata_1 @ x] frame:1 pts:1024 pts_time:0.0232
[Parsed_ametadata_1 @ x] lavfi.astats.Overall.RMS_level=-inf
[Parsed_ametadata_1 @ x] frame:2 pts:2048 pts_time:0.0464
[Parsed_ametadata_1 @ x] lavfi.astats.Overall.RMS_level=-12.0
";
        let env = parse_rms_envelope(stderr);
        assert_eq!(env.len(), 3);
        assert_eq!(env[0].0, 0.0);
        assert_eq!(env[0].1, -43.2);
        assert!(!env[1].1.is_finite());
        assert_eq!(env[2].1, -12.0);
    }

    #[test]
    fn edges_measure_leading_and_trailing_on_studio_like_floor() {
        let env = build_env(&[(-43.0, 26), (-27.0, 43), (-43.0, 30)]);
        let (leading, trailing) = measured(edges_from_envelope(&env));
        assert!((leading - 26.0 * WIN).abs() < WIN, "début {}", leading);
        assert!((trailing - 30.0 * WIN).abs() < WIN, "fin {}", trailing);
    }

    #[test]
    fn edges_measure_trailing_without_relying_on_declared_duration() {
        let env = build_env(&[(-12.0, 40), (f64::NEG_INFINITY, 30)]);
        let (leading, trailing) = measured(edges_from_envelope(&env));
        assert_eq!(leading, 0.0);
        assert!((trailing - 30.0 * WIN).abs() < WIN, "fin {}", trailing);
    }

    #[test]
    fn edges_ignore_isolated_leading_click() {
        let env = build_env(&[(-10.0, 1), (f64::NEG_INFINITY, 20), (-20.0, 30)]);
        let (leading, _) = measured(edges_from_envelope(&env));
        assert!(
            leading > 10.0 * WIN,
            "le clic n'a pas été ignoré : {}",
            leading
        );
    }

    #[test]
    fn edges_do_not_trim_soft_intro() {
        let env = build_env(&[(-34.0, 40), (-20.0, 40)]);
        let (leading, trailing) = measured(edges_from_envelope(&env));
        assert_eq!(leading, 0.0, "intro douce rognée à tort");
        assert_eq!(trailing, 0.0);
    }

    #[test]
    fn edges_all_silence_for_pure_digital_silence() {
        let env = build_env(&[(f64::NEG_INFINITY, 50)]);
        assert_eq!(edges_from_envelope(&env), EdgeMeasure::AllSilence);
    }

    #[test]
    fn edges_unreadable_for_empty_envelope() {
        assert_eq!(edges_from_envelope(&[]), EdgeMeasure::Unreadable);
    }

    #[test]
    fn builds_edge_silence_filters_with_trim_guard() {
        // Le trim retire EDGE_TRIM_GUARD_SEC (0.02 s) pour ne pas entamer l'attaque :
        // 1.0 -> 0.98, 0.25 -> 0.23.
        assert_eq!(
            build_edge_silence_filters(1.0, 0.25, EDGE_SILENCE_SEC),
            EdgeSilenceFilters {
                pre_filters: vec![
                    "atrim=start=0.98".to_string(),
                    "asetpts=PTS-STARTPTS".to_string(),
                    "areverse".to_string(),
                    "atrim=start=0.23".to_string(),
                    "asetpts=PTS-STARTPTS".to_string(),
                    "areverse".to_string(),
                    "asetpts=PTS-STARTPTS".to_string(),
                ],
                post_filters: vec!["adelay=400".to_string(), "apad=pad_dur=0.4".to_string()],
            }
        );
    }

    #[test]
    fn edge_silence_trim_guard_skips_tiny_edges() {
        // Un silence plus court que le garde-fou ne déclenche aucun trim.
        let filters = build_edge_silence_filters(0.01, 0.0, EDGE_SILENCE_SEC);
        assert!(filters.pre_filters.is_empty());
    }
}
