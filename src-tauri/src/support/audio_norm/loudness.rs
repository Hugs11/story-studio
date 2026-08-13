use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::ffmpeg::apply_no_window;

use super::types::{
    LoudnessAction, LoudnessMeasure, DEADBAND_LUFS, LIMITER_SAMPLE_PEAK_DBFS, TARGET_LUFS,
    VALIDATION_WINDOW_LUFS,
};

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
    // 1) Gain (niveau) — découplé du contrôle de crête. Dans la bande morte on ne
    //    touche pas au volume ; sinon on vise -14 LUFS avec un gain statique. Une
    //    source très dynamique peut demander une limitation forte : ce n'est plus
    //    un motif de refus, car l'utilisateur a explicitement demandé
    //    l'harmonisation. Le générateur la traite et remonte un avertissement.
    let gain_db = if in_range(integrated_lufs, DEADBAND_LUFS) {
        0.0
    } else {
        TARGET_LUFS - integrated_lufs
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
    fn reaches_target_even_when_strong_limiting_is_required() {
        assert_eq!(
            plan_loudness_fix(-22.0, 0.0),
            LoudnessAction::GainLimit {
                gain_db: 8.0,
                expected_limiting_db: 10.0,
            }
        );
    }

    #[test]
    fn harmonizes_valid_but_clipped_audio_and_enforces_ceiling() {
        // Niveau valide hors bande morte (-16) mais source écrêtée (+8 dBFS) :
        // l'harmonisation demandée vise quand même -14 LUFS et le limiteur
        // maintient le plafond de sortie.
        assert_eq!(
            plan_loudness_fix(-16.0, 8.0),
            LoudnessAction::GainLimit {
                gain_db: 2.0,
                expected_limiting_db: 12.0,
            }
        );
    }

    #[test]
    fn reaches_target_for_very_dynamic_weak_audio() {
        assert_eq!(
            plan_loudness_fix(-32.0, 0.0),
            LoudnessAction::GainLimit {
                gain_db: 18.0,
                expected_limiting_db: 20.0,
            }
        );
    }

    #[test]
    fn reaches_target_for_near_mute_but_measurable_audio() {
        assert_eq!(
            plan_loudness_fix(-50.0, -55.0),
            LoudnessAction::Gain { gain_db: 36.0 }
        );
    }

    #[test]
    fn rejects_only_invalid_measurements() {
        assert!(matches!(
            plan_loudness_fix(f64::NAN, -3.0),
            LoudnessAction::Uncorrectable { .. }
        ));
    }
}
