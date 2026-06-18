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
    // 1) Gain (niveau) — découplé du contrôle de crête. Dans la bande morte on ne
    //    touche pas au volume ; sinon on vise -14 LUFS en **plafonnant le gain
    //    montant** pour ne jamais avoir à limiter plus de MAX_LIMITING_DB de signal
    //    *amplifié* (sinon on pomperait une source réellement faible et dynamique).
    //    Un gain montant n'est jamais transformé en atténuation.
    let gain_db = if in_range(integrated_lufs, DEADBAND_LUFS) {
        0.0
    } else {
        let ideal_gain = TARGET_LUFS - integrated_lufs;
        if ideal_gain <= 0.0 {
            ideal_gain
        } else {
            let max_boost = (LIMITER_SAMPLE_PEAK_DBFS + MAX_LIMITING_DB - true_peak_db).max(0.0);
            let capped = ideal_gain.min(max_boost);
            // Trop faible pour être remontée : même le gain plafonné n'atteint pas
            // le plancher de la fenêtre de validation.
            if capped < ideal_gain
                && integrated_lufs + capped < VALIDATION_WINDOW_LUFS.0 + VALIDATION_FLOOR_SAFETY_LU
            {
                return LoudnessAction::Uncorrectable {
                    reason: "audio trop dynamique/faible pour monter sans écraser".to_string(),
                };
            }
            capped
        }
    };

    // 2) Plafond de crête — **toujours** enforcé quand la crête (après gain) dépasse
    //    le plafond. `alimiter` est un brickwall : il ne rabote que les crêtes
    //    au-dessus du plafond, donc il ne touche pas un fichier propre et mate
    //    n'importe quelle source chaude/écrêtée, quelle que soit l'ampleur (pas de
    //    budget maximal de limitation : une source à +10 dBFS exige >12 dB et doit
    //    quand même être ramenée sous le plafond, sinon elle écrête sur la boîte).
    let projected_peak = true_peak_db + gain_db;
    if projected_peak <= LIMITER_SAMPLE_PEAK_DBFS {
        return if in_range(integrated_lufs, DEADBAND_LUFS) {
            LoudnessAction::None
        } else {
            LoudnessAction::Gain { gain_db }
        };
    }
    LoudnessAction::GainLimit {
        gain_db,
        expected_limiting_db: projected_peak - LIMITER_SAMPLE_PEAK_DBFS,
    }
}

pub(crate) fn loudness_in_validation_window(integrated_lufs: f64) -> bool {
    in_range(integrated_lufs, VALIDATION_WINDOW_LUFS)
}

/// Bande morte de correction : aucune retouche de niveau dans `[-15.5, -12.5]`.
/// Sert au checker pour distinguer un fichier déjà au niveau cible (rien à
/// faire) d'un fichier dans la fenêtre mais harmonisable vers ‑14.
pub(crate) fn loudness_in_deadband(integrated_lufs: f64) -> bool {
    in_range(integrated_lufs, DEADBAND_LUFS)
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
    fn deadband_membership_matches_spec_window() {
        assert!(loudness_in_deadband(-14.0));
        assert!(loudness_in_deadband(-15.5));
        assert!(loudness_in_deadband(-12.5));
        // Hors bande morte mais dans la fenêtre : candidat à l'harmonisation.
        assert!(!loudness_in_deadband(-16.0));
        assert!(!loudness_in_deadband(-11.0));
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
    fn limits_hot_clipped_source_inside_deadband() {
        // Niveau déjà dans la bande morte mais source écrêtée (crête +10 dBFS) :
        // on enforce le plafond, peu importe l'ampleur du rabotage requis.
        assert_eq!(
            plan_loudness_fix(-14.0, 10.0),
            LoudnessAction::GainLimit {
                gain_db: 0.0,
                expected_limiting_db: 12.0,
            }
        );
    }

    #[test]
    fn enforces_ceiling_on_extremely_hot_peak() {
        // Aucun budget maximal : une crête absurde est quand même ramenée au plafond.
        assert_eq!(
            plan_loudness_fix(-13.5, 14.0),
            LoudnessAction::GainLimit {
                gain_db: 0.0,
                expected_limiting_db: 16.0,
            }
        );
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
    fn limits_valid_but_clipped_audio_without_changing_level() {
        // Niveau valide hors bande morte (-16) mais source écrêtée (+8 dBFS) : on ne
        // remonte pas (le gain montant est plafonné à 0 par la crête) mais on enforce
        // le plafond — on ne laisse jamais passer l'écrêtage.
        assert_eq!(
            plan_loudness_fix(-16.0, 8.0),
            LoudnessAction::GainLimit {
                gain_db: 0.0,
                expected_limiting_db: 10.0,
            }
        );
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
