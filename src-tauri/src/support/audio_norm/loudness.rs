use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::ffmpeg::apply_no_window;

use super::types::{
    LoudnessAction, LoudnessMeasure, DEADBAND_LUFS, LIMITER_SAMPLE_PEAK_DBFS, MAX_LIMITING_DB,
    NEAR_MUTE_LUFS, TARGET_LUFS, VALIDATION_WINDOW_LUFS,
};

/// Marge sous laquelle un gain plafonné est jugé trop court : le résultat
/// resterait collé au plancher de la fenêtre de validation.
const VALIDATION_FLOOR_SAFETY_LU: f64 = 0.5;

/// Arguments de la mesure EBU R128, extraits pour la même raison que
/// `edge_envelope_args` : une seule mesure, deux orchestrations.
pub(crate) fn ebur128_args(input: &Path, pre_filters: &[String]) -> Vec<String> {
    let mut filters = pre_filters.to_vec();
    filters.push("ebur128=peak=true".to_string());
    vec![
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-map".to_string(),
        "0:a:0".to_string(),
        "-af".to_string(),
        filters.join(","),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ]
}

pub(crate) fn measure_loudness_ebur128(
    ffmpeg: &Path,
    input: &Path,
    pre_filters: &[String],
) -> Result<LoudnessMeasure, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(ebur128_args(input, pre_filters))
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
    //    touche pas au volume ; sinon on vise -14 LUFS avec un gain statique.
    //
    //    Un gain montant est d'abord **plafonné** pour ne pas limiter plus de
    //    MAX_LIMITING_DB de signal amplifié : une narration dynamique s'arrête un
    //    peu sous la cible, sans avertissement, comme jusqu'en 0.9.6.
    //
    //    Quand ce plafond laisserait la source sous la fenêtre de validation —
    //    le cas que 0.9.6 refusait —, l'harmonisation demandée est forcée
    //    jusqu'à la cible : le limiteur absorbe la différence et le générateur
    //    signale la forte limitation. Plus aucune source mesurable ne bloque.
    let mut capped_at_budget = false;
    let gain_db = if in_range(integrated_lufs, DEADBAND_LUFS) {
        0.0
    } else {
        let ideal_gain = TARGET_LUFS - integrated_lufs;
        let max_boost = (LIMITER_SAMPLE_PEAK_DBFS + MAX_LIMITING_DB - true_peak_db).max(0.0);
        if ideal_gain <= max_boost {
            ideal_gain
        } else if integrated_lufs + max_boost
            >= VALIDATION_WINDOW_LUFS.0 + VALIDATION_FLOOR_SAFETY_LU
        {
            capped_at_budget = max_boost > 0.0;
            max_boost
        } else {
            ideal_gain
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
        // Au plafond, la limitation vaut exactement le budget : l'arithmétique
        // flottante ne doit pas la faire passer au-dessus et déclencher un
        // avertissement.
        expected_limiting_db: if capped_at_budget {
            MAX_LIMITING_DB
        } else {
            projected_peak - LIMITER_SAMPLE_PEAK_DBFS
        },
    }
}

/// Ce qu'une harmonisation a coûté et qui mérite d'être dit à l'auteur.
///
/// Une seule décision pour les deux chaînes de génération : le même son reçoit
/// le même avertissement, qu'il parte de l'éditeur par menus ou du graphe.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HarmonizationNotice {
    pub(crate) code: &'static str,
    pub(crate) initial_integrated_lufs: f64,
    pub(crate) gain_db: f64,
    pub(crate) expected_limiting_db: f64,
}

pub(crate) const NOTICE_NEAR_MUTE_BOOST: &str = "AUDIO_NEAR_MUTE_BOOST";
pub(crate) const NOTICE_STRONG_LIMITING: &str = "AUDIO_STRONG_LIMITING";

pub(crate) fn harmonization_notice(
    integrated_lufs: f64,
    action: &LoudnessAction,
) -> Option<HarmonizationNotice> {
    let (gain_db, expected_limiting_db) = match action {
        LoudnessAction::Gain { gain_db } => (*gain_db, 0.0),
        LoudnessAction::GainLimit {
            gain_db,
            expected_limiting_db,
        } => (*gain_db, *expected_limiting_db),
        LoudnessAction::None | LoudnessAction::Uncorrectable { .. } => (0.0, 0.0),
    };
    let code = if integrated_lufs < NEAR_MUTE_LUFS {
        NOTICE_NEAR_MUTE_BOOST
    } else if gain_db > 0.0 && expected_limiting_db > MAX_LIMITING_DB {
        // Seul un gain peut faire de l'harmonisation la cause d'une forte
        // limitation. Sans gain, le limiteur ne fait que ramener une source déjà
        // chaude sous le plafond, comme il l'a toujours fait : rien à signaler.
        NOTICE_STRONG_LIMITING
    } else {
        return None;
    };
    Some(HarmonizationNotice {
        code,
        initial_integrated_lufs: integrated_lufs,
        gain_db,
        expected_limiting_db,
    })
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
    fn caps_gain_at_limiting_budget_when_the_window_stays_reachable() {
        assert_eq!(
            plan_loudness_fix(-22.0, 0.0),
            LoudnessAction::GainLimit {
                gain_db: 4.0,
                expected_limiting_db: 6.0,
            }
        );
    }

    /// Une narration Toudou, mesurée après passage en mono : l'harmonisation
    /// s'arrête au budget de limitation, sans avertissement, comme en 0.9.6.
    #[test]
    fn dynamic_narration_stops_at_budget_without_strong_limiting() {
        let LoudnessAction::GainLimit {
            gain_db,
            expected_limiting_db,
        } = plan_loudness_fix(-16.5, 2.4)
        else {
            panic!("gain et limiteur attendus");
        };
        assert!((gain_db - 1.6).abs() < 1e-9);
        assert_eq!(expected_limiting_db, MAX_LIMITING_DB);
    }

    #[test]
    fn limits_valid_but_clipped_audio_without_changing_level() {
        // Niveau valide hors bande morte (-16) mais source écrêtée (+8 dBFS) : le
        // plafond ne laisse aucun gain, et le limiteur ramène la crête sous le
        // plafond de sortie.
        assert_eq!(
            plan_loudness_fix(-16.0, 8.0),
            LoudnessAction::GainLimit {
                gain_db: 0.0,
                expected_limiting_db: 10.0,
            }
        );
    }

    #[test]
    /// Le cas que 0.9.6 refusait : le plafond laisserait la source sous la
    /// fenêtre. L'harmonisation est forcée jusqu'à la cible, avec avertissement.
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
