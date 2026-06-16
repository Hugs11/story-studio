use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::ffmpeg::apply_no_window;

use super::types::{
    LoudnessAction, LoudnessMeasure, DEADBAND_LUFS, LIMITER_SAMPLE_PEAK_DBFS, MAX_LIMITING_DB,
    NEAR_MUTE_LUFS, TARGET_LUFS, VALIDATION_WINDOW_LUFS,
};

const VALIDATION_FLOOR_SAFETY_LU: f64 = 0.5;

pub(crate) fn measure_loudness_ebur128(
    ffmpeg: &Path,
    input: &Path,
    pre_filters: &[String],
) -> Result<LoudnessMeasure, String> {
    let mut filters = pre_filters.to_vec();
    filters.push("ebur128=peak=true".to_string());

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(input)
        .arg("-map")
        .arg("0:a:0")
        .arg("-af")
        .arg(filters.join(","))
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
            "Mesure audio ebur128 échouée : {}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    parse_ebur128_summary(&String::from_utf8_lossy(&out.stderr))
        .ok_or_else(|| "Mesure audio ebur128 incomplète.".to_string())
}

pub(crate) fn parse_ebur128_summary(stderr: &str) -> Option<LoudnessMeasure> {
    let summary = stderr.rsplit("Summary:").next().unwrap_or(stderr);
    let mut section = "";
    let mut integrated_lufs = None;
    let mut true_peak_db = None;
    let mut loudness_range_lu = None;

    for line in summary.lines().map(str::trim) {
        match line {
            "Integrated loudness:" => section = "integrated",
            "Loudness range:" => section = "range",
            "True peak:" => section = "peak",
            _ => {
                if section == "integrated" && line.starts_with("I:") {
                    integrated_lufs = parse_measure_value(line);
                } else if section == "range" && line.starts_with("LRA:") {
                    loudness_range_lu = parse_measure_value(line);
                } else if section == "peak" && line.starts_with("Peak:") {
                    true_peak_db = parse_measure_value(line);
                }
            }
        }
    }

    Some(LoudnessMeasure {
        integrated_lufs: integrated_lufs?,
        true_peak_db: true_peak_db?,
        loudness_range_lu: loudness_range_lu?,
    })
}

pub(crate) fn plan_loudness_fix(integrated_lufs: f64, true_peak_db: f64) -> LoudnessAction {
    if !integrated_lufs.is_finite() || !true_peak_db.is_finite() {
        return LoudnessAction::Uncorrectable {
            reason: "mesure de niveau invalide".to_string(),
        };
    }
    if integrated_lufs < NEAR_MUTE_LUFS {
        return LoudnessAction::Uncorrectable {
            reason: "audio presque muet".to_string(),
        };
    }
    if in_range(integrated_lufs, DEADBAND_LUFS) {
        let limiting_db = true_peak_db - LIMITER_SAMPLE_PEAK_DBFS;
        if limiting_db <= 0.0 {
            return LoudnessAction::None;
        }
        if limiting_db > MAX_LIMITING_DB {
            return LoudnessAction::None;
        }
        return LoudnessAction::GainLimit {
            gain_db: 0.0,
            expected_limiting_db: limiting_db,
        };
    }

    let ideal_gain = TARGET_LUFS - integrated_lufs;
    let projected_peak = true_peak_db + ideal_gain;
    if projected_peak <= LIMITER_SAMPLE_PEAK_DBFS {
        return LoudnessAction::Gain {
            gain_db: ideal_gain,
        };
    }

    let ideal_limiting = projected_peak - LIMITER_SAMPLE_PEAK_DBFS;
    if ideal_limiting <= MAX_LIMITING_DB {
        return LoudnessAction::GainLimit {
            gain_db: ideal_gain,
            expected_limiting_db: ideal_limiting,
        };
    }

    let capped_gain = LIMITER_SAMPLE_PEAK_DBFS + MAX_LIMITING_DB - true_peak_db;
    if ideal_gain > 0.0 && capped_gain <= 0.0 {
        if loudness_in_validation_window(integrated_lufs) {
            return LoudnessAction::None;
        }
        return LoudnessAction::Uncorrectable {
            reason: "audio trop dynamique/faible pour monter sans écraser".to_string(),
        };
    }
    let capped_lufs = integrated_lufs + capped_gain;
    if capped_lufs >= VALIDATION_WINDOW_LUFS.0 + VALIDATION_FLOOR_SAFETY_LU {
        return LoudnessAction::GainLimit {
            gain_db: capped_gain,
            expected_limiting_db: MAX_LIMITING_DB,
        };
    }

    LoudnessAction::Uncorrectable {
        reason: "audio trop dynamique/faible pour monter sans écraser".to_string(),
    }
}

pub(crate) fn loudness_in_validation_window(integrated_lufs: f64) -> bool {
    in_range(integrated_lufs, VALIDATION_WINDOW_LUFS)
}

fn in_range(value: f64, (min, max): (f64, f64)) -> bool {
    (min..=max).contains(&value)
}

fn parse_measure_value(line: &str) -> Option<f64> {
    let value = line.split(':').nth(1)?.split_whitespace().next()?;
    let parsed = value.parse::<f64>().ok()?;
    parsed.is_finite().then_some(parsed)
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

    #[test]
    fn parses_ebur128_summary() {
        let stderr = "\
[Parsed_ebur128_0 @ 000] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.9 LUFS

  Loudness range:
    LRA:         2.1 LU
    Threshold: -34.9 LUFS
    LRA low:   -15.1 LUFS
    LRA high:  -13.0 LUFS

  True peak:
    Peak:       -0.4 dBFS
";
        assert_eq!(
            parse_ebur128_summary(stderr),
            Some(LoudnessMeasure {
                integrated_lufs: -14.3,
                true_peak_db: -0.4,
                loudness_range_lu: 2.1,
            })
        );
    }

    #[test]
    fn plans_noop_inside_deadband() {
        assert_eq!(plan_loudness_fix(-14.2, -3.0), LoudnessAction::None);
    }

    #[test]
    fn plans_limiter_inside_deadband_when_peak_is_hot() {
        assert_eq!(
            plan_loudness_fix(-13.5, 0.5),
            LoudnessAction::GainLimit {
                gain_db: 0.0,
                expected_limiting_db: 2.5,
            }
        );
    }

    #[test]
    fn does_not_overlimit_inside_deadband() {
        assert_eq!(plan_loudness_fix(-14.3, 6.6), LoudnessAction::None);
    }

    #[test]
    fn plans_gain_when_peak_has_headroom() {
        assert_eq!(
            plan_loudness_fix(-18.0, -8.0),
            LoudnessAction::Gain { gain_db: 4.0 }
        );
    }

    #[test]
    fn plans_gain_limiter_when_target_needs_peak_control() {
        assert_eq!(
            plan_loudness_fix(-18.0, -4.0),
            LoudnessAction::GainLimit {
                gain_db: 4.0,
                expected_limiting_db: 2.0,
            }
        );
    }

    #[test]
    fn caps_gain_when_target_exceeds_limiting_budget_but_window_is_reachable() {
        assert_eq!(
            plan_loudness_fix(-22.0, 0.0),
            LoudnessAction::GainLimit {
                gain_db: 4.0,
                expected_limiting_db: 6.0,
            }
        );
    }

    #[test]
    fn does_not_lower_valid_audio_to_fit_limiting_budget() {
        assert_eq!(plan_loudness_fix(-16.0, 6.6), LoudnessAction::None);
    }

    #[test]
    fn marks_uncorrectable_when_even_validation_floor_is_unreachable() {
        assert!(matches!(
            plan_loudness_fix(-32.0, 0.0),
            LoudnessAction::Uncorrectable { .. }
        ));
    }

    #[test]
    fn marks_uncorrectable_when_capped_gain_lands_on_validation_floor() {
        assert!(matches!(
            plan_loudness_fix(-28.5, -4.5),
            LoudnessAction::Uncorrectable { .. }
        ));
    }
}
