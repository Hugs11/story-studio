use crate::support::user_message;
use crate::support::user_message::codes;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::support::audio_norm::{
    build_edge_silence_filters, build_loudness_filters, build_selected_edge_silence_filters,
    edges_after_gain, edges_from_envelope, loudness_in_validation_window, measure_edge_envelope,
    measure_loudness_ebur128, plan_loudness_fix, EdgeMeasure, EdgeSilenceSelection, LoudnessAction,
    EDGE_SILENCE_SEC, EXPECTED_FINAL_TRUE_PEAK_DBTP, MAX_LIMITING_DB, NEAR_MUTE_LUFS, TARGET_LUFS,
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
    issue, round_secs, AudioValidationItem, FixDisposition, PackValidationIssue,
    PackValidationSeverity, AUDIO_EDGE_SILENCE_MEASUREMENT_TOLERANCE_SECONDS,
    AUDIO_MAX_EDGE_SILENCE_SECONDS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EdgeSilenceClassification {
    TooShort,
    Accepted,
    LongSuggestion,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioEdge {
    Leading,
    Trailing,
}

impl AudioEdge {
    fn label(self) -> &'static str {
        match self {
            Self::Leading => codes::LABEL_SILENCE_START_TRANSPORT,
            Self::Trailing => codes::LABEL_SILENCE_END_TRANSPORT,
        }
    }

    fn short_code(self) -> &'static str {
        match self {
            Self::Leading => codes::CHECKER_AUDIO_LEADING_SHORT,
            Self::Trailing => codes::CHECKER_AUDIO_TRAILING_SHORT,
        }
    }

    fn long_code(self) -> &'static str {
        match self {
            Self::Leading => codes::CHECKER_AUDIO_LEADING_LONG,
            Self::Trailing => codes::CHECKER_AUDIO_TRAILING_LONG,
        }
    }
}

pub(crate) fn classify_edge_silence(measured: Option<f64>) -> EdgeSilenceClassification {
    let Some(measured) = measured.filter(|value| value.is_finite() && *value >= 0.0) else {
        return EdgeSilenceClassification::Unreadable;
    };
    let minimum = EDGE_SILENCE_SEC - AUDIO_EDGE_SILENCE_MEASUREMENT_TOLERANCE_SECONDS;
    if measured + f64::EPSILON * 8.0 < minimum {
        EdgeSilenceClassification::TooShort
    } else if measured > AUDIO_MAX_EDGE_SILENCE_SECONDS {
        EdgeSilenceClassification::LongSuggestion
    } else {
        EdgeSilenceClassification::Accepted
    }
}

#[derive(Debug, Clone, Default)]
struct AudioProbe {
    loudness_stays_quiet: bool,
    predicted_lufs: Option<f64>,
    edges_after_gain: Option<(f64, f64)>,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AudioFixPlan {
    pub fix_format_or_channels: bool,
    pub fix_loudness: bool,
    pub rebuild_leading_silence: bool,
    pub rebuild_trailing_silence: bool,
}

impl AudioFixPlan {
    pub(crate) fn has_operations(self) -> bool {
        self.fix_format_or_channels
            || self.fix_loudness
            || self.rebuild_leading_silence
            || self.rebuild_trailing_silence
    }
}

pub(crate) fn automatic_fix_plan(
    item: &AudioValidationItem,
    issues: &[PackValidationIssue],
) -> AudioFixPlan {
    let automatic_issues: Vec<&PackValidationIssue> = issues
        .iter()
        .filter(|issue| issue.file_path.as_deref() == Some(item.file_path.as_str()))
        .filter(|issue| issue.fix_disposition == FixDisposition::Automatic)
        .collect();
    if automatic_issues.is_empty() {
        return AudioFixPlan::default();
    }

    let format_invalid = audio_format_invalid(
        Path::new(&item.file_path),
        item.codec.as_deref(),
        item.sample_rate,
        item.channels.as_deref(),
    );
    let changes_signal = format_invalid
        || [item.leading_silence_secs, item.trailing_silence_secs]
            .into_iter()
            .any(|edge| classify_edge_silence(edge) == EdgeSilenceClassification::TooShort);
    let loudness_is_correctable = match (item.integrated_lufs, item.true_peak_db) {
        (Some(lufs), Some(peak)) if needs_loudness_fix(lufs, changes_signal) => {
            plan_loudness_fix(lufs, peak).is_correctable()
        }
        _ => false,
    };

    AudioFixPlan {
        fix_format_or_channels: format_invalid,
        fix_loudness: loudness_is_correctable,
        rebuild_leading_silence: automatic_issues
            .iter()
            .any(|issue| issue.code.as_deref() == Some("audioLeadingSilenceTooShort"))
            || (loudness_is_correctable
                && item.edges_after_gain.is_some_and(|(leading, _)| {
                    classify_edge_silence(Some(leading)) == EdgeSilenceClassification::TooShort
                })),
        rebuild_trailing_silence: automatic_issues
            .iter()
            .any(|issue| issue.code.as_deref() == Some("audioTrailingSilenceTooShort"))
            || (loudness_is_correctable
                && item.edges_after_gain.is_some_and(|(_, trailing)| {
                    classify_edge_silence(Some(trailing)) == EdgeSilenceClassification::TooShort
                })),
    }
}

fn audio_format_invalid(
    path: &Path,
    codec: Option<&str>,
    sample_rate: Option<u32>,
    channels: Option<&str>,
) -> bool {
    let extension_is_mp3 = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("mp3"));
    let codec_is_mp3 = codec.is_some_and(|value| value.to_ascii_lowercase().contains("mp3"));
    !extension_is_mp3
        || !codec_is_mp3
        || sample_rate != Some(44_100)
        || !channels.is_some_and(|value| value.eq_ignore_ascii_case("mono"))
}

// Leave half a LU of margin when another correction changes the signal.
// Padding, resampling and MP3 encoding must not move a boundary source outside
// the unchanged validation window on the next analysis.
fn needs_loudness_fix(lufs: f64, changes_signal: bool) -> bool {
    !loudness_in_validation_window(lufs)
        || (changes_signal
            && !(VALIDATION_WINDOW_LUFS.0 + 0.5..=VALIDATION_WINDOW_LUFS.1 - 0.5).contains(&lufs))
}

#[derive(Debug, Clone, Copy)]
struct AudioIssueTarget<'a> {
    code: Option<&'static str>,
    label: &'a str,
    file_path: &'a str,
    item_type: &'a str,
}

impl<'a> AudioIssueTarget<'a> {
    fn with_code(self, code: &'static str) -> Self {
        Self {
            code: Some(code),
            ..self
        }
    }
}

pub(crate) fn analyze_audio_file(
    ffmpeg: &Path,
    input: &Path,
    asset_name: &str,
    label: &str,
    item_type: &str,
) -> (AudioValidationItem, Vec<PackValidationIssue>) {
    let probe = probe_audio(ffmpeg, input).unwrap_or_default();
    analyze_audio_probe(probe, asset_name, label, item_type)
}

fn analyze_audio_probe(
    probe: AudioProbe,
    asset_name: &str,
    label: &str,
    item_type: &str,
) -> (AudioValidationItem, Vec<PackValidationIssue>) {
    let mut issues = Vec::new();
    let mut fix_parts = Vec::new();
    let mut status = PackValidationSeverity::Ok;
    let mut manual_block = false;
    let file_path = format!("assets/{}", asset_name);
    let target = AudioIssueTarget {
        code: None,
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
            PackValidationSeverity::Warning,
            target.with_code(codes::CHECKER_AUDIO_FORMAT),
            codes::CHECKER_AUDIO_FORMAT_TRANSPORT,
            Some({
                let detected_extension = (if ext.is_empty() {
                    codes::LABEL_AUDIO_CODEC_UNKNOWN_TRANSPORT
                } else {
                    &ext
                })
                .to_string();
                let detected_audio_codec = (probe
                    .codec
                    .as_deref()
                    .unwrap_or(codes::LABEL_IMAGE_FORMAT_UNKNOWN_TRANSPORT))
                .to_string();
                user_message::UserMessage::new(
                codes::CHECKER_AUDIO_CODEC_UNEXPECTED,
            )
                .param(
                    "extension",
                    user_message::transport_param(detected_extension.clone()),
                )
                .param("codec", user_message::transport_param(detected_audio_codec.clone()))
                .with_detail(format!(
                    "Détecté : extension {detected_extension}, codec {detected_audio_codec}. Attendu : MP3.",
                    detected_extension = user_message::transport_detail(&detected_extension),
                    detected_audio_codec = user_message::transport_detail(&detected_audio_codec),
                ))
                .into_transport()
            }),
            true,
            Some(
                user_message::UserMessage::new(codes::CHECKER_MP3_CONVERSION_TITLE)
                    .with_detail("Convertir en MP3.".to_string())
                    .into_transport(),
            ),
        );
        status = PackValidationSeverity::Warning;
        fix_parts.push(codes::CHECKER_MP3_CONVERSION_DESCRIPTION_TRANSPORT);
    }

    if probe.sample_rate != Some(44_100) {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Warning,
            target.with_code(codes::CHECKER_AUDIO_SAMPLE_RATE),
            codes::CHECKER_AUDIO_SAMPLE_RATE_TRANSPORT,
            Some({
                let sample_rate = probe
                    .sample_rate
                    .map(|value| format!("{} Hz", value))
                    .unwrap_or_else(|| codes::LABEL_IMAGE_FORMAT_UNKNOWN_TRANSPORT.to_string());
                user_message::UserMessage::new(codes::CHECKER_AUDIO_SAMPLERATE_UNEXPECTED)
                    .param(
                        "sampleRate",
                        user_message::transport_param(sample_rate.clone()),
                    )
                    .with_detail(format!(
                        "Détecté : {}. Attendu : 44.1 kHz.",
                        user_message::transport_detail(&sample_rate),
                    ))
                    .into_transport()
            }),
            true,
            Some(
                user_message::UserMessage::new(codes::CHECKER_SAMPLERATE_CONVERSION_TITLE)
                    .with_detail("Convertir en 44.1 kHz.".to_string())
                    .into_transport(),
            ),
        );
        status = PackValidationSeverity::Warning;
        fix_parts.push(codes::CHECKER_SAMPLERATE_CONVERT_DESCRIPTION_TRANSPORT);
    }

    let is_mono = probe
        .channels
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("mono"))
        .unwrap_or(false);
    if !is_mono {
        push_audio_issue(
            &mut issues,
            PackValidationSeverity::Warning,
            target.with_code(codes::CHECKER_AUDIO_CHANNELS),
            codes::CHECKER_AUDIO_CHANNELS_TRANSPORT,
            Some({
                let channels = probe
                    .channels
                    .as_deref()
                    .unwrap_or(codes::LABEL_IMAGE_FORMAT_UNKNOWN_TRANSPORT);
                user_message::UserMessage::new(codes::CHECKER_AUDIO_CHANNELS_UNEXPECTED)
                    .param(
                        "channels",
                        user_message::transport_param(channels.to_string()),
                    )
                    .with_detail(format!(
                        "Détecté : {}. Attendu : mono.",
                        user_message::transport_detail(channels),
                    ))
                    .into_transport()
            }),
            true,
            Some(
                user_message::UserMessage::new(codes::CHECKER_MONO_CONVERSION_TITLE)
                    .with_detail("Convertir en mono.".to_string())
                    .into_transport(),
            ),
        );
        status = PackValidationSeverity::Warning;
        fix_parts.push(codes::CHECKER_MONO_CONVERSION_DESCRIPTION_TRANSPORT);
    }

    if let Some(duration) = probe.duration_secs {
        if duration < 0.25 {
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Error,
                target.with_code(codes::CHECKER_AUDIO_TOO_SHORT),
                codes::CHECKER_AUDIO_TOO_SHORT_TRANSPORT,
                Some({
                    let _msg_duration = format!("{:.2}", duration);
                    user_message::UserMessage::new(codes::CHECKER_AUDIO_DURATION_DETECTED)
                        .param(
                            "duration",
                            user_message::transport_param(_msg_duration.clone()),
                        )
                        .with_detail(format!(
                            "Durée détectée : {_msg_duration} s.",
                            _msg_duration = user_message::transport_detail(&_msg_duration),
                        ))
                        .into_transport()
                }),
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
            target.with_code(codes::CHECKER_AUDIO_UNMEASURABLE),
            codes::CHECKER_AUDIO_UNMEASURABLE_TRANSPORT,
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
            target.with_code(codes::CHECKER_AUDIO_SILENT),
            codes::CHECKER_AUDIO_SILENT_TRANSPORT,
            Some(
                user_message::UserMessage::new(codes::CHECKER_AUDIO_CONTENT_UNDETECTED)
                    .with_detail(
                        "Aucun contenu détecté au-dessus du plancher de bruit.".to_string(),
                    )
                    .into_transport(),
            ),
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
            AudioEdge::Leading,
            probe.leading_silence_secs,
        );
        add_silence_issue(
            &mut issues,
            &mut status,
            &mut fix_parts,
            target,
            AudioEdge::Trailing,
            probe.trailing_silence_secs,
        );
    }

    match probe.integrated_lufs {
        Some(lufs) if lufs < NEAR_MUTE_LUFS => {
            let action = probe.true_peak_db.map(|peak| plan_loudness_fix(lufs, peak));
            let can_normalize = action
                .as_ref()
                .map(LoudnessAction::is_correctable)
                .unwrap_or(false);
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Warning,
                target.with_code(codes::CHECKER_AUDIO_NEAR_MUTE),
                codes::CHECKER_AUDIO_NEAR_MUTE_TRANSPORT,
                Some({
                    let _msg_lufs = format!("{:.1}", lufs);
                    user_message::UserMessage::new(
                    codes::CHECKER_VOLUME_BOOST_NOISE_RISK,
                )
                    .param("lufs", user_message::transport_param(_msg_lufs.clone()))
                    .with_detail(format!(
                        "Volume moyen mesuré : {_msg_lufs} LUFS. Story Studio peut l'amplifier fortement, mais le bruit de fond peut devenir plus audible.",
                        _msg_lufs = user_message::transport_detail(&_msg_lufs),
                    ))
                    .into_transport()
                }),
                can_normalize,
                can_normalize.then(|| {
                    user_message::UserMessage::new(if probe.loudness_stays_quiet {
                        codes::CHECKER_VOLUME_BEST_EFFORT
                    } else {
                        codes::CHECKER_VOLUME_BOOST_NORMALIZE
                    })
                    .into_transport()
                }),
            );
            if status != PackValidationSeverity::Error {
                status = PackValidationSeverity::Warning;
            }
            if can_normalize {
                fix_parts.push(codes::CHECKER_VOLUME_NORMALIZATION_TITLE_TRANSPORT);
            }
        }
        Some(lufs) if !loudness_in_validation_window(lufs) => {
            let direction = if lufs < VALIDATION_WINDOW_LUFS.0 {
                codes::CHECKER_VOLUME_TOO_QUIET_TRANSPORT
            } else {
                codes::CHECKER_VOLUME_TOO_LOUD_TRANSPORT
            };
            let action = probe
                .true_peak_db
                .map(|peak| plan_loudness_fix(lufs, peak))
                .unwrap_or_else(|| LoudnessAction::Uncorrectable {
                    reason: user_message::UserMessage::new(codes::CHECKER_PEAK_NOT_MEASURED)
                        .with_detail("crête vraie non mesurée".to_string())
                        .into_transport(),
                });
            let can_normalize = action.is_correctable();
            let strong_limiting = matches!(
                &action,
                LoudnessAction::GainLimit {
                    expected_limiting_db,
                    ..
                } if *expected_limiting_db > MAX_LIMITING_DB
            );
            let details = if can_normalize {
                let mut details = {
                    let _msg_lufs = format!("{:.1}", lufs);
                    let minimum_volume_lufs = format!("{:.0}", VALIDATION_WINDOW_LUFS.0);
                    let maximum_volume_lufs = format!("{:.0}", VALIDATION_WINDOW_LUFS.1);
                    let _msg_target_lufs = format!("{:.0}", TARGET_LUFS);
                    let expected_peak_dbtp = format!("{:.1}", EXPECTED_FINAL_TRUE_PEAK_DBTP);
                    user_message::UserMessage::new(
                        codes::CHECKER_VOLUME_CORRECTION_MEASUREMENTS,
                    )
                        .param("lufs", user_message::transport_param(_msg_lufs.clone()))
                        .param(
                            "minLufs",
                            user_message::transport_param(minimum_volume_lufs.clone()),
                        )
                        .param(
                            "maxLufs",
                            user_message::transport_param(maximum_volume_lufs.clone()),
                        )
                        .param(
                            "targetLufs",
                            user_message::transport_param(_msg_target_lufs.clone()),
                        )
                        .param(
                            "expectedTruePeakDbtp",
                            user_message::transport_param(expected_peak_dbtp.clone()),
                        )
                        .with_detail(format!(
                            "Volume moyen mesuré : {_msg_lufs} LUFS. Fenêtre valide : {minimum_volume_lufs} à {maximum_volume_lufs} LUFS. Correction visée : {_msg_target_lufs} LUFS, crête MP3 attendue ≈ {expected_peak_dbtp} dBTP.",
                            expected_peak_dbtp = user_message::transport_detail(&expected_peak_dbtp),
                            _msg_lufs = user_message::transport_detail(&_msg_lufs),
                            _msg_target_lufs = user_message::transport_detail(&_msg_target_lufs),
                            minimum_volume_lufs = user_message::transport_detail(&minimum_volume_lufs),
                            maximum_volume_lufs = user_message::transport_detail(&maximum_volume_lufs),
                        ))
                        .into_transport()
                };
                if strong_limiting {
                    details = crate::support::user_message::compose_messages(
                        &[
                            details,
                            codes::CHECKER_VOLUME_LIMITING_WARNING_TRANSPORT.to_string(),
                        ],
                        "",
                    );
                }
                details
            } else {
                {
                    let _msg_lufs = format!("{:.1}", lufs);
                    let measured_true_peak =
                        format!("{:.1}", probe.true_peak_db.unwrap_or_default());
                    let minimum_volume_lufs = format!("{:.0}", VALIDATION_WINDOW_LUFS.0);
                    let maximum_volume_lufs = format!("{:.0}", VALIDATION_WINDOW_LUFS.1);
                    let volume_adjustment_reason = (loudness_action_reason(&action)).to_string();
                    user_message::UserMessage::new(
                        codes::CHECKER_VOLUME_NORMALIZATION_UNAVAILABLE,
                    )
                        .param("lufs", user_message::transport_param(_msg_lufs.clone()))
                        .param("peak", user_message::transport_param(measured_true_peak.clone()))
                        .param(
                            "minLufs",
                            user_message::transport_param(minimum_volume_lufs.clone()),
                        )
                        .param(
                            "maxLufs",
                            user_message::transport_param(maximum_volume_lufs.clone()),
                        )
                        .param(
                            "normalizationReason",
                            user_message::transport_param(volume_adjustment_reason.clone()),
                        )
                        .with_detail(format!(
                            "Volume moyen mesuré : {_msg_lufs} LUFS, crête vraie : {measured_true_peak} dBTP. Fenêtre valide : {minimum_volume_lufs} à {maximum_volume_lufs} LUFS. Normalisation automatique indisponible : {volume_adjustment_reason}.",
                            volume_adjustment_reason = user_message::transport_detail(&volume_adjustment_reason),
                            _msg_lufs = user_message::transport_detail(&_msg_lufs),
                            minimum_volume_lufs = user_message::transport_detail(&minimum_volume_lufs),
                            maximum_volume_lufs = user_message::transport_detail(&maximum_volume_lufs),
                            measured_true_peak = user_message::transport_detail(&measured_true_peak),
                        ))
                        .into_transport()
                }
            };
            push_audio_issue(
                &mut issues,
                PackValidationSeverity::Warning,
                target.with_code(codes::CHECKER_AUDIO_VOLUME),
                {
                    let _msg_direction = (direction).to_string();
                    user_message::UserMessage::new(codes::CHECKER_AUDIO_VOLUME)
                        .param(
                            "direction",
                            user_message::transport_param(_msg_direction.clone()),
                        )
                        .with_detail(format!(
                            "Le volume moyen de cet audio est {_msg_direction}.",
                            _msg_direction = user_message::transport_detail(&_msg_direction),
                        ))
                        .into_transport()
                },
                Some(details),
                can_normalize,
                can_normalize.then(|| {
                    user_message::UserMessage::new(if probe.loudness_stays_quiet {
                        codes::CHECKER_VOLUME_BEST_EFFORT
                    } else {
                        codes::CHECKER_VOLUME_NORMALIZATION_DESCRIPTION
                    })
                    .into_transport()
                }),
            );
            if status != PackValidationSeverity::Error {
                status = PackValidationSeverity::Warning;
            }
            if can_normalize {
                fix_parts.push(codes::CHECKER_VOLUME_NORMALIZATION_TITLE_TRANSPORT);
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
                target.with_code(codes::CHECKER_AUDIO_VOLUME_UNMEASURABLE),
                codes::CHECKER_AUDIO_VOLUME_UNMEASURABLE_TRANSPORT,
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
                    .map(|p| {
                        let _msg_p = format!("{:.1}", p);
                        user_message::UserMessage::new(codes::CHECKER_PEAK_MEASUREMENT_VALUE)
                            .param("peak", user_message::transport_param(_msg_p.clone()))
                            .with_detail(format!(
                                " (crête vraie {_msg_p} dBTP)",
                                _msg_p = user_message::transport_detail(&_msg_p),
                            ))
                            .into_transport()
                    })
                    .unwrap_or_default();
                push_audio_issue(
                    &mut issues,
                    PackValidationSeverity::Warning,
                    target.with_code(codes::CHECKER_AUDIO_CLIPPED),
                    codes::CHECKER_AUDIO_CLIPPED_TRANSPORT,
                    Some({
                        let _msg_pct = format!("{:.2}", pct);
                        let _msg_peak = (peak).to_string();
                        user_message::UserMessage::new(
                        codes::CHECKER_AUDIO_ORIGINAL_CLIPPING,
                    )
                        .param("percent", user_message::transport_param(_msg_pct.clone()))
                        .param("peak", user_message::transport_param(_msg_peak.clone()))
                        .with_detail(format!(
                            "Écrêtage détecté sur {_msg_pct} % des échantillons{_msg_peak}. La saturation est déjà présente dans le fichier d'origine ; aucune régénération ne la restaure. Conseil : vérifiez la source et, si possible, remplacez-la par un enregistrement de meilleure qualité.",
                            _msg_pct = user_message::transport_detail(&_msg_pct),
                            _msg_peak = user_message::transport_detail(&_msg_peak),
                        ))
                        .into_transport()
                    }),
                    false,
                    None,
                );
                if status != PackValidationSeverity::Error {
                    status = PackValidationSeverity::Warning;
                }
            }
        }
    }

    // A boundary level can be valid in the source yet need gain as a dependent
    // operation of format/silence correction. Include it in the proposed work.
    let has_signal_correction = issues
        .iter()
        .any(|issue| issue.fix_disposition == FixDisposition::Automatic);
    if probe.integrated_lufs.is_some_and(|lufs| {
        loudness_in_validation_window(lufs) && needs_loudness_fix(lufs, has_signal_correction)
    }) {
        fix_parts.push(codes::CHECKER_VOLUME_NORMALIZATION_TITLE_TRANSPORT);
        if let Some(issue) = issues
            .iter_mut()
            .find(|issue| issue.fix_disposition == FixDisposition::Automatic)
        {
            let mut descriptions: Vec<String> =
                issue.auto_fix_description.take().into_iter().collect();
            descriptions.push(
                user_message::UserMessage::new(if probe.loudness_stays_quiet {
                    codes::CHECKER_VOLUME_BEST_EFFORT
                } else {
                    codes::CHECKER_VOLUME_NORMALIZATION_DESCRIPTION
                })
                .into_transport(),
            );
            issue.auto_fix_description = Some(user_message::compose_messages(&descriptions, " "));
        }
    }

    if let Some((leading, trailing)) = probe.edges_after_gain {
        let descriptions: Vec<String> = [
            (AudioEdge::Leading, leading),
            (AudioEdge::Trailing, trailing),
        ]
        .into_iter()
        .filter(|(edge, measured)| {
            classify_edge_silence(Some(*measured)) == EdgeSilenceClassification::TooShort
                && !issues
                    .iter()
                    .any(|issue| issue.code.as_deref() == Some(edge.short_code()))
        })
        .map(|(edge, _)| {
            user_message::UserMessage::new(codes::CHECKER_SILENCE_PADDING_DESCRIPTION)
                .param(
                    "side",
                    user_message::transport_param(edge.label().to_string()),
                )
                .param("targetSilenceSeconds", format!("{EDGE_SILENCE_SEC:.2}"))
                .into_transport()
        })
        .collect();
        if !descriptions.is_empty() {
            fix_parts.push(codes::CHECKER_SILENCE_ADJUSTMENT_TITLE_TRANSPORT);
            // These are dependent operations of the volume correction, not
            // errors in the source. Show both selected edges in its existing
            // correction details (screen and exported reports).
            let volume_index = issues.iter().position(|issue| {
                issue.fix_disposition == FixDisposition::Automatic
                    && matches!(
                        issue.code.as_deref(),
                        Some(codes::CHECKER_AUDIO_VOLUME | codes::CHECKER_AUDIO_NEAR_MUTE)
                    )
            });
            let target_index = volume_index.or_else(|| {
                issues
                    .iter()
                    .position(|issue| issue.fix_disposition == FixDisposition::Automatic)
            });
            if let Some(issue) = target_index.map(|index| &mut issues[index]) {
                let mut parts: Vec<String> =
                    issue.auto_fix_description.take().into_iter().collect();
                parts.extend(descriptions.iter().cloned());
                issue.auto_fix_description = Some(user_message::compose_messages(&parts, " "));
            }
        }
    }
    let auto_fix_available = !manual_block && !fix_parts.is_empty();
    if manual_block {
        for issue in &mut issues {
            issue.auto_fix_available = false;
            issue.auto_fix_description = None;
            issue.fix_disposition = FixDisposition::None;
        }
    }
    let fix_summary = if auto_fix_available {
        Some(unique_join(&fix_parts))
    } else {
        None
    };

    (
        AudioValidationItem {
            edges_after_gain: probe.edges_after_gain,
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
            // Keep decision data unrounded; presentation formats the values.
            leading_silence_secs: probe.leading_silence_secs,
            trailing_silence_secs: probe.trailing_silence_secs,
            integrated_lufs: probe.integrated_lufs,
            true_peak_db: probe.true_peak_db,
        },
        issues,
    )
}

pub(crate) fn fix_audio_file(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    item: &AudioValidationItem,
    plan: AudioFixPlan,
) -> Result<(), String> {
    if !plan.has_operations() {
        return Err({
            let _msg_item_file_path = (item.file_path).to_string();
            user_message::UserMessage::new(codes::CHECKER_AUDIO_CORRECTION_PLAN_EMPTY)
                .param(
                    "itemFilePath",
                    user_message::transport_param(_msg_item_file_path.clone()),
                )
                .with_detail(format!(
                    "Plan de correction audio vide : {_msg_item_file_path}",
                    _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path),
                ))
                .into_transport()
        });
    }
    let rebuild_leading = plan.rebuild_leading_silence;
    let rebuild_trailing = plan.rebuild_trailing_silence;
    // A fade may cease to be silence after gain: trim only the predicted quiet
    // part, preserving the newly audible content before adding clean padding.
    let trim_start = item
        .edges_after_gain
        .map(|edges| edges.0)
        .unwrap_or_else(|| item.leading_silence_secs.unwrap_or(0.0));
    let trim_trailing = item
        .edges_after_gain
        .map(|edges| edges.1)
        .unwrap_or_else(|| item.trailing_silence_secs.unwrap_or(0.0));

    let selected_trim = if rebuild_leading { trim_start } else { 0.0 }
        + if rebuild_trailing { trim_trailing } else { 0.0 };
    if let Some(duration) = item.duration_secs {
        if selected_trim >= duration - 0.05 {
            return Err({
                let _msg_item_file_path = (item.file_path).to_string();
                user_message::UserMessage::new(codes::CHECKER_AUDIO_CORRECTED_TOO_SHORT)
                    .param(
                        "itemFilePath",
                        user_message::transport_param(_msg_item_file_path.clone()),
                    )
                    .with_detail(format!(
                        "Audio trop court après ajustement des silences : {_msg_item_file_path}",
                        _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path),
                    ))
                    .into_transport()
            });
        }
    }
    let edge_filters = build_selected_edge_silence_filters(
        trim_start,
        trim_trailing,
        EDGE_SILENCE_SEC,
        EdgeSilenceSelection {
            leading: rebuild_leading,
            trailing: rebuild_trailing,
        },
    );
    let mut output_filters = edge_filters.pre_filters;

    if output_filters
        .iter()
        .any(|filter| filter.starts_with("atrim="))
    {
        if let Some(duration) = item.duration_secs {
            if duration <= 0.05 {
                return Err({
                    let _msg_item_file_path = (item.file_path).to_string();
                    user_message::UserMessage::new(
                        codes::CHECKER_AUDIO_CORRECTED_TOO_SHORT,
                    )
                        .param(
                            "itemFilePath",
                            user_message::transport_param(_msg_item_file_path.clone()),
                        )
                        .with_detail(format!(
                            "Audio trop court après ajustement des silences : {_msg_item_file_path}",
                            _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path),
                        ))
                        .into_transport()
                });
            }
        }
    }

    output_filters.push("aformat=channel_layouts=mono".to_string());

    if plan.fix_loudness {
        // Measure the selected trim, mono conversion AND added silence. The
        // integrated level changes when padding moves the EBU analysis blocks.
        let mut measurement_filters = output_filters.clone();
        measurement_filters.extend(edge_filters.post_filters.iter().cloned());
        let measure =
            measure_loudness_ebur128(ffmpeg, input, &measurement_filters).map_err(|e| {
                {
                let _msg_item_file_path = (item.file_path).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(
                    codes::CHECKER_CORRECTION_LEVEL_MEASURE_FAILED,
                )
                    .param(
                        "itemFilePath",
                        user_message::transport_param(_msg_item_file_path.clone()),
                    )
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Mesure de niveau impossible pendant la correction de {_msg_item_file_path} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path),
                    ))
                    .into_transport()
                }
            })?;
        let action = plan_loudness_fix(measure.integrated_lufs, measure.true_peak_db);
        if matches!(action, LoudnessAction::Uncorrectable { .. }) {
            return Err({
                let _msg_item_file_path = (item.file_path).to_string();
                let volume_adjustment_reason = (loudness_action_reason(&action)).to_string();
                user_message::UserMessage::new(
                    codes::CHECKER_AUDIO_NORMALIZATION_UNAVAILABLE,
                )
                    .param(
                        "itemFilePath",
                        user_message::transport_param(_msg_item_file_path.clone()),
                    )
                    .param(
                        "normalizationReason",
                        user_message::transport_param(volume_adjustment_reason.clone()),
                    )
                    .with_detail(format!(
                        "Normalisation audio indisponible pour {_msg_item_file_path} : {volume_adjustment_reason}",
                        _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path),
                        volume_adjustment_reason = user_message::transport_detail(&volume_adjustment_reason),
                    ))
                    .into_transport()
            });
        }
        output_filters.extend(build_loudness_filters(&action));
    }

    output_filters.extend(edge_filters.post_filters);

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-map")
        .arg("0:a:0")
        .arg("-af")
        .arg(output_filters.join(","))
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
    let out = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_FFMPEG_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer FFmpeg : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if !out.status.success() {
        return Err({
            let _msg_item_file_path = (item.file_path).to_string();
            let ffmpeg_error_message = (compact_ffmpeg_error(&out.stderr)).to_string();
            user_message::UserMessage::new(codes::CHECKER_AUDIO_CORRECTION_FAILED)
                .param(
                    "itemFilePath",
                    user_message::transport_param(_msg_item_file_path.clone()),
                )
                .param(
                    "toolError",
                    user_message::transport_param(ffmpeg_error_message.clone()),
                )
                .with_detail(format!(
                    "Correction audio échouée pour {_msg_item_file_path} :\n{ffmpeg_error_message}",
                    ffmpeg_error_message = user_message::transport_detail(&ffmpeg_error_message),
                    _msg_item_file_path = user_message::transport_detail(&_msg_item_file_path),
                ))
                .into_transport()
        });
    }
    Ok(())
}

fn measure_output_preview(ffmpeg: &Path, input: &Path, filters: &[String]) -> Option<f64> {
    // Materialize the output chain without lossy encoding so that the analysis
    // can detect its actual edges (including fades affected by the limiter).
    let preview = super::unique_pack_workspace("audio_preview").with_extension("wav");
    let measured = (|| {
        let mut command = Command::new(ffmpeg);
        apply_no_window(&mut command);
        let output = command
            .args(["-y", "-i"])
            .arg(input)
            .args(["-vn", "-map", "0:a:0", "-af"])
            .arg(filters.join(","))
            .args(["-c:a", "pcm_f32le"])
            .arg(&preview)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        // Exactly the same measurement as reanalysis, without recursively
        // forecasting another correction or measuring clipping.
        probe_audio_signal(ffmpeg, &preview).ok()?.0.integrated_lufs
    })();
    let _ = std::fs::remove_file(preview);
    measured
}

fn probe_audio_signal(
    ffmpeg: &Path,
    input: &Path,
) -> Result<(AudioProbe, Vec<(f64, f64)>), String> {
    let mut probe = AudioProbe::default();
    let metadata = run_ffmpeg(ffmpeg, input, &["-hide_banner", "-i"])?;
    probe.duration_secs = parse_duration(&metadata);
    let (codec, sample_rate, channels) = parse_audio_stream(&metadata);
    probe.codec = codec;
    probe.sample_rate = sample_rate;
    probe.channels = channels;

    let envelope = measure_edge_envelope(ffmpeg, input).unwrap_or_default();
    match edges_from_envelope(&envelope) {
        EdgeMeasure::Measured { leading, trailing } => {
            probe.leading_silence_secs = Some(leading);
            probe.trailing_silence_secs = Some(trailing);
        }
        EdgeMeasure::AllSilence => {
            probe.audio_is_silent = true;
        }
        EdgeMeasure::Unreadable => {}
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
    Ok((probe, envelope))
}

fn probe_audio(ffmpeg: &Path, input: &Path) -> Result<AudioProbe, String> {
    let (mut probe, envelope) = probe_audio_signal(ffmpeg, input)?;
    if let (Some(lufs), Some(peak)) = (probe.integrated_lufs, probe.true_peak_db) {
        let changes_signal = audio_format_invalid(
            input,
            probe.codec.as_deref(),
            probe.sample_rate,
            probe.channels.as_deref(),
        ) || [probe.leading_silence_secs, probe.trailing_silence_secs]
            .into_iter()
            .any(|edge| classify_edge_silence(edge) == EdgeSilenceClassification::TooShort);
        if needs_loudness_fix(lufs, changes_signal) {
            let action = plan_loudness_fix(lufs, peak);
            let gain_db = match action {
                LoudnessAction::Gain { gain_db } | LoudnessAction::GainLimit { gain_db, .. } => {
                    gain_db
                }
                _ => 0.0,
            };
            if gain_db > 0.0 {
                if let EdgeMeasure::Measured { leading, trailing } =
                    edges_after_gain(&envelope, gain_db)
                {
                    probe.edges_after_gain = Some((leading, trailing));
                }
            }
            if action.is_correctable() {
                // Select the same edges and measure the same padding as correction:
                // EBU block alignment can change which shared plan branch applies.
                let short =
                    |edge| classify_edge_silence(edge) == EdgeSilenceClassification::TooShort;
                let (trim_start, trim_end) = probe.edges_after_gain.unwrap_or((
                    probe.leading_silence_secs.unwrap_or(0.0),
                    probe.trailing_silence_secs.unwrap_or(0.0),
                ));
                let edge_filters = build_selected_edge_silence_filters(
                    trim_start,
                    trim_end,
                    EDGE_SILENCE_SEC,
                    EdgeSilenceSelection {
                        leading: short(probe.leading_silence_secs)
                            || short(probe.edges_after_gain.map(|edges| edges.0)),
                        trailing: short(probe.trailing_silence_secs)
                            || short(probe.edges_after_gain.map(|edges| edges.1)),
                    },
                );
                let mut output_filters = edge_filters.pre_filters;
                output_filters.push("aformat=channel_layouts=mono".to_string());
                let mut correction_measure_filters = output_filters.clone();
                correction_measure_filters.extend(edge_filters.post_filters.iter().cloned());
                if let Ok(correction_measure) =
                    measure_loudness_ebur128(ffmpeg, input, &correction_measure_filters)
                {
                    let action = plan_loudness_fix(
                        correction_measure.integrated_lufs,
                        correction_measure.true_peak_db,
                    );
                    // Same chain as fix_audio_file: selected trim, mono, shared
                    // gain/limiter, then padding. No arithmetic fallback can
                    // predict limiting or the EBU block alignment faithfully.
                    output_filters.extend(build_loudness_filters(&action));
                    output_filters.extend(edge_filters.post_filters);
                    // fix_audio_file requests this output rate after its filters.
                    output_filters.push("aresample=44100".to_string());
                    probe.predicted_lufs = measure_output_preview(ffmpeg, input, &output_filters);
                    probe.loudness_stays_quiet = probe
                        .predicted_lufs
                        .is_some_and(|predicted| predicted < VALIDATION_WINDOW_LUFS.0);
                }
            }
        }
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
/// total. Peak count counts the FILE maximum, so Peak level must also be
/// at full scale. Renvoie `(écrêtés, total)`.
fn measure_clip_stats(ffmpeg: &Path, input: &Path) -> Option<(u64, u64)> {
    let filter = "aformat=sample_fmts=s16:channel_layouts=mono,\
astats=metadata=0:measure_perchannel=none:measure_overall=Peak_level+Peak_count+Number_of_samples";
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
    let peak = stderr
        .split("Peak level dB:")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()?;
    // s16 full scale is within 0.001 dB of zero. Lower file maxima (notably
    // quantized near-mute audio) are not samples clipped at full scale.
    let clipped = if peak >= -0.01 {
        parse_count_field(&stderr, "Peak count:")?
    } else {
        0
    };
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
    let out = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::CHECKER_FFMPEG_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer FFmpeg : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    Ok(String::from_utf8_lossy(&out.stderr).to_string())
}

fn parse_duration(stderr: &str) -> Option<f64> {
    let duration = stderr
        .lines()
        .find_map(|line| line.trim().strip_prefix("Duration: "))?;
    let ts = duration.split(',').next()?.trim();
    let mut parts = ts.splitn(3, ':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let s: f64 = parts.next()?.trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn parse_audio_stream(stderr: &str) -> (Option<String>, Option<u32>, Option<String>) {
    let Some(line) = stderr
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("Stream #"))
        .find_map(|line| line.split_once(": Audio: ").map(|(_, audio)| audio))
    else {
        return (None, None, None);
    };
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
    edge: AudioEdge,
    measured: Option<f64>,
) {
    let side = edge.label();
    match classify_edge_silence(measured) {
        EdgeSilenceClassification::Unreadable => {
            push_audio_issue(
                issues,
                PackValidationSeverity::Warning,
                target.with_code(match edge {
                    AudioEdge::Leading => codes::CHECKER_AUDIO_LEADING_UNMEASURABLE,
                    AudioEdge::Trailing => codes::CHECKER_AUDIO_TRAILING_UNMEASURABLE,
                }),
                {
                    let _msg_side = (side).to_string();
                    user_message::UserMessage::new(match edge {
                        AudioEdge::Leading => codes::CHECKER_AUDIO_LEADING_UNMEASURABLE,
                        AudioEdge::Trailing => codes::CHECKER_AUDIO_TRAILING_UNMEASURABLE,
                    })
                    .with_detail(format!(
                        "Le silence de {_msg_side} n'a pas pu être mesuré.",
                        _msg_side = user_message::transport_detail(&_msg_side)
                    ))
                    .into_transport()
                },
                None,
                false,
                None,
            );
            raise_status(status, PackValidationSeverity::Warning);
        }
        EdgeSilenceClassification::TooShort => {
            let measured = measured.unwrap_or_default();
            let mut entry = make_audio_issue(
                PackValidationSeverity::Warning,
                target,
                {
                    let _msg_side = (side).to_string();
                    user_message::UserMessage::new(edge.short_code())
                        .with_detail(format!(
                            "Le silence au {_msg_side} est trop court.",
                            _msg_side = user_message::transport_detail(&_msg_side)
                        ))
                        .into_transport()
                },
                Some({
                    let _msg_measured = format!("{:.2}", measured);
                    let _msg_edge_silence_sec = format!("{:.2}", EDGE_SILENCE_SEC);
                    let silence_measurement_tolerance =
                        format!("{:.2}", AUDIO_EDGE_SILENCE_MEASUREMENT_TOLERANCE_SECONDS);
                    let _msg_edge_silence_sec2 = format!("{:.2}", EDGE_SILENCE_SEC);
                    user_message::UserMessage::new(
                    codes::CHECKER_SILENCE_MINIMUM_MEASUREMENTS,
                )
                    .param(
                        "measured",
                        user_message::transport_param(_msg_measured.clone()),
                    )
                    .param(
                        "targetSilenceSeconds",
                        user_message::transport_param(_msg_edge_silence_sec.clone()),
                    )
                    .param(
                        "measurementToleranceSeconds",
                        user_message::transport_param(silence_measurement_tolerance.clone()),
                    )
                    .param(
                        "proposedSilenceSeconds",
                        user_message::transport_param(_msg_edge_silence_sec2.clone()),
                    )
                    .with_detail(format!(
                        "Détecté : {_msg_measured} s. Minimum attendu : {_msg_edge_silence_sec} s (tolérance de mesure : {silence_measurement_tolerance} s). Correction proposée : atteindre {_msg_edge_silence_sec2} s.",
                        _msg_edge_silence_sec = user_message::transport_detail(&_msg_edge_silence_sec),
                        _msg_edge_silence_sec2 = user_message::transport_detail(&_msg_edge_silence_sec2),
                        _msg_measured = user_message::transport_detail(&_msg_measured),
                        silence_measurement_tolerance = user_message::transport_detail(&silence_measurement_tolerance),
                    ))
                    .into_transport()
                }),
                true,
                Some({
                    let _msg_side = (side).to_string();
                    let _msg_edge_silence_sec = format!("{:.2}", EDGE_SILENCE_SEC);
                    user_message::UserMessage::new(
                    codes::CHECKER_SILENCE_PADDING_DESCRIPTION,
                )
                    .param("side", user_message::transport_param(_msg_side.clone()))
                    .param(
                        "targetSilenceSeconds",
                        user_message::transport_param(_msg_edge_silence_sec.clone()),
                    )
                    .with_detail(format!(
                        "Ajouter du silence au {_msg_side} pour atteindre {_msg_edge_silence_sec} s.",
                        _msg_edge_silence_sec = user_message::transport_detail(&_msg_edge_silence_sec),
                        _msg_side = user_message::transport_detail(&_msg_side),
                    ))
                    .into_transport()
                }),
            );
            entry.code = Some(edge.short_code().to_string());
            entry.fix_disposition = FixDisposition::Automatic;
            issues.push(entry);
            raise_status(status, PackValidationSeverity::Warning);
            fix_parts.push(codes::CHECKER_SILENCE_ADJUSTMENT_TITLE_TRANSPORT);
        }
        EdgeSilenceClassification::LongSuggestion => {
            let measured = measured.unwrap_or_default();
            let mut entry = make_audio_issue(
                PackValidationSeverity::Info,
                target,
                {
                    let _msg_side = (side).to_string();
                    user_message::UserMessage::new(edge.long_code())
                        .with_detail(format!(
                            "Le silence au {_msg_side} est long.",
                            _msg_side = user_message::transport_detail(&_msg_side)
                        ))
                        .into_transport()
                },
                Some({
                    let _msg_measured = format!("{:.2}", measured);
                    let edge_silence_limit_seconds =
                        format!("{:.2}", AUDIO_MAX_EDGE_SILENCE_SECONDS);
                    let _msg_edge_silence_sec = format!("{:.2}", EDGE_SILENCE_SEC);
                    user_message::UserMessage::new(
                    codes::CHECKER_SILENCE_EXCESS_MEASUREMENTS,
                )
                    .param(
                        "measured",
                        user_message::transport_param(_msg_measured.clone()),
                    )
                    .param(
                        "maxEdgeSilenceSeconds",
                        user_message::transport_param(edge_silence_limit_seconds.clone()),
                    )
                    .param(
                        "targetSilenceSeconds",
                        user_message::transport_param(_msg_edge_silence_sec.clone()),
                    )
                    .with_detail(format!(
                        "Détecté : {_msg_measured} s. Au-delà de {edge_silence_limit_seconds} s, Story Studio propose facultativement de ramener ce bord à {_msg_edge_silence_sec} s.",
                        edge_silence_limit_seconds = user_message::transport_detail(&edge_silence_limit_seconds),
                        _msg_edge_silence_sec = user_message::transport_detail(&_msg_edge_silence_sec),
                        _msg_measured = user_message::transport_detail(&_msg_measured),
                    ))
                    .into_transport()
                }),
                true,
                Some({
                    let _msg_side = (side).to_string();
                    let _msg_edge_silence_sec = format!("{:.2}", EDGE_SILENCE_SEC);
                    user_message::UserMessage::new(
                    codes::CHECKER_SILENCE_REDUCTION_DESCRIPTION,
                )
                    .param("side", user_message::transport_param(_msg_side.clone()))
                    .param(
                        "targetSilenceSeconds",
                        user_message::transport_param(_msg_edge_silence_sec.clone()),
                    )
                    .with_detail(format!(
                        "Ramener facultativement le silence au {_msg_side} à {_msg_edge_silence_sec} s.",
                        _msg_edge_silence_sec = user_message::transport_detail(&_msg_edge_silence_sec),
                        _msg_side = user_message::transport_detail(&_msg_side),
                    ))
                    .into_transport()
                }),
            );
            entry.code = Some(edge.long_code().to_string());
            entry.fix_disposition = FixDisposition::Optional;
            issues.push(entry);
            raise_status(status, PackValidationSeverity::Info);
            fix_parts.push(codes::CHECKER_SILENCE_ADJUSTMENT_TITLE_TRANSPORT);
        }
        EdgeSilenceClassification::Accepted => {}
    }
}

fn severity_rank(severity: PackValidationSeverity) -> u8 {
    match severity {
        PackValidationSeverity::Ok => 0,
        PackValidationSeverity::Info => 1,
        PackValidationSeverity::Warning => 2,
        PackValidationSeverity::Error => 3,
    }
}

fn raise_status(status: &mut PackValidationSeverity, severity: PackValidationSeverity) {
    if severity_rank(severity) > severity_rank(*status) {
        *status = severity;
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
    let entry = make_audio_issue(
        severity,
        target,
        message,
        technical_details,
        auto_fix_available,
        auto_fix_description,
    );
    issues.push(entry);
}

fn make_audio_issue(
    severity: PackValidationSeverity,
    target: AudioIssueTarget<'_>,
    message: impl Into<String>,
    technical_details: Option<String>,
    auto_fix_available: bool,
    auto_fix_description: Option<String>,
) -> PackValidationIssue {
    let mut entry = issue(severity, "audio", target.label, message);
    entry.code = target.code.map(str::to_string);
    entry.technical_details = technical_details;
    entry.file_path = Some(target.file_path.to_string());
    entry.item_type = Some(target.item_type.to_string());
    entry.auto_fix_available = auto_fix_available;
    if auto_fix_available {
        entry.fix_disposition = FixDisposition::Automatic;
    }
    entry.auto_fix_description = auto_fix_description;
    entry
}

fn unique_join(parts: &[&str]) -> String {
    let mut out = Vec::new();
    for part in parts {
        if !out.contains(part) {
            out.push(*part);
        }
    }
    crate::support::user_message::compose_messages(
        &out.iter().map(|part| part.to_string()).collect::<Vec<_>>(),
        ", ",
    )
}

fn compact_ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return user_message::UserMessage::new(codes::CHECKER_FFMPEG_ERROR_UNKNOWN)
            .with_detail("Erreur FFmpeg inconnue.".to_string())
            .into_transport();
    }
    let start = lines.len().saturating_sub(8);
    lines[start..].join("\n")
}

fn loudness_action_reason(action: &LoudnessAction) -> &str {
    match action {
        LoudnessAction::Uncorrectable { reason } => reason,
        _ => codes::CHECKER_CORRECTION_NOT_REQUIRED_TRANSPORT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_mp3_edge_below_minimum_rounds_to_minimum() {
        let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().unwrap();
        let dir = super::super::unique_pack_workspace("raw_edge_boundary");
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("boundary.mp3");
        let mut command = Command::new(&ffmpeg);
        apply_no_window(&mut command);
        let result = command
            .args(["-y", "-f", "lavfi", "-i"])
            .arg("aevalsrc=0.16*sin(2*PI*440*t)*between(t\\,0.36\\,4.5):s=44100:d=5")
            .args(["-ac", "1", "-c:a", "libmp3lame", "-q:a", "5"])
            .arg(&input)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let probe = probe_audio(&ffmpeg, &input).unwrap();
        let leading = probe.leading_silence_secs.unwrap();
        eprintln!(
            "MP3 boundary raw={leading:?} displayed={} lufs={:?}",
            round_secs(leading),
            probe.integrated_lufs
        );
        assert!((0.345..0.35).contains(&leading));
        assert!((-20.0..-19.5).contains(&probe.integrated_lufs.unwrap()));
        let (item, issues) = analyze_audio_probe(probe, "boundary.mp3", "Boundary", "story");
        let plan = automatic_fix_plan(&item, &issues);
        assert!(
            plan.fix_loudness && plan.rebuild_leading_silence,
            "{plan:?}"
        );
        let output = dir.join("fixed.mp3");
        fix_audio_file(&ffmpeg, &input, &output, &item, plan).unwrap();
        let (_, after) = analyze_audio_file(&ffmpeg, &output, "fixed.mp3", "Boundary", "story");
        assert!(
            !after
                .iter()
                .any(|issue| issue.fix_disposition == FixDisposition::Automatic),
            "{after:?}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn raw_edge_rounding_keeps_analysis_and_plan_in_agreement() {
        // Ordinary 44.1 kHz envelope: 15 windows = 0.348299 s, displayed 0.35.
        for leading in [true, false] {
            let short = 15.0 * 1024.0 / 44_100.0;
            assert!((0.345..0.35).contains(&short));
            assert_eq!(round_secs(short), 0.35);
            let (item, issues) = analyze_audio_probe(
                AudioProbe {
                    codec: Some("mp3".into()),
                    sample_rate: Some(44_100),
                    channels: Some("mono".into()),
                    duration_secs: Some(10.0),
                    leading_silence_secs: Some(if leading { short } else { 0.4 }),
                    trailing_silence_secs: Some(if leading { 0.4 } else { short }),
                    integrated_lufs: Some(-19.7),
                    true_peak_db: Some(-10.0),
                    ..Default::default()
                },
                "boundary.mp3",
                "Boundary",
                "story",
            );
            assert!(issues
                .iter()
                .filter_map(|issue| issue.auto_fix_description.as_deref())
                .any(|text| text.contains(codes::CHECKER_VOLUME_NORMALIZATION_DESCRIPTION)));
            let plan = automatic_fix_plan(&item, &issues);
            assert!(
                plan.fix_loudness,
                "announced normalization missing: {plan:?}"
            );
            assert_eq!(plan.rebuild_leading_silence, leading);
            assert_eq!(plan.rebuild_trailing_silence, !leading);
        }
    }

    #[test]
    fn near_mute_best_effort_description_has_no_normalization_fallback() {
        let (_, issues) = analyze_audio_probe(
            AudioProbe {
                codec: Some("mp3".into()),
                sample_rate: Some(44_100),
                channels: Some("mono".into()),
                duration_secs: Some(10.0),
                leading_silence_secs: Some(0.4),
                trailing_silence_secs: Some(0.4),
                integrated_lufs: Some(-55.0),
                true_peak_db: Some(-10.0),
                loudness_stays_quiet: true,
                ..Default::default()
            },
            "quiet.mp3",
            "Quiet",
            "story",
        );
        let description = issues
            .iter()
            .find(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_NEAR_MUTE))
            .unwrap()
            .auto_fix_description
            .as_ref()
            .unwrap();
        assert!(description.contains(codes::CHECKER_VOLUME_BEST_EFFORT));
        assert!(
            !description.contains("Amplifier et normaliser"),
            "{description}"
        );
    }

    #[test]
    fn analysis_and_plan_keep_raw_loudness_at_rounding_boundaries() {
        for (name, lufs) in [("boundary.wav", -19.54), ("boundary.mp3", -20.04)] {
            let probe = AudioProbe {
                codec: Some("mp3".into()),
                sample_rate: Some(44_100),
                channels: Some("mono".into()),
                duration_secs: Some(10.0),
                leading_silence_secs: Some(0.4),
                trailing_silence_secs: Some(0.4),
                integrated_lufs: Some(lufs),
                true_peak_db: Some(-10.04),
                ..Default::default()
            };
            let (item, issues) = analyze_audio_probe(probe, name, "Boundary", "story");
            assert_eq!(item.integrated_lufs, Some(lufs));
            assert_eq!(item.true_peak_db, Some(-10.04));
            assert!(issues
                .iter()
                .filter_map(|issue| issue.auto_fix_description.as_deref())
                .any(|text| text.contains(codes::CHECKER_VOLUME_NORMALIZATION_DESCRIPTION)));
            assert!(
                automatic_fix_plan(&item, &issues).fix_loudness,
                "{name} {lufs}"
            );
        }
    }

    #[test]
    fn real_long_fades_preview_matches_written_boundary() {
        let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().unwrap();
        let dir = super::super::unique_pack_workspace("long_fades_forecast");
        std::fs::create_dir_all(&dir).unwrap();
        // Four-second fades must remain in the output, including at -20.0:
        // the inclusive validation boundary must not produce an announcement.
        for (amplitude, expected) in [(0.121, -20.0), (0.123, -19.9)] {
            let input = dir.join("fade.wav");
            let mut command = Command::new(&ffmpeg);
            apply_no_window(&mut command);
            let result = command.args(["-y", "-f", "lavfi", "-i"])
                .arg(format!("aevalsrc=({amplitude}+0.9*lt(mod(t\\,0.5)\\,0.001))*sin(2*PI*1000*t):s=44100:d=10"))
                .args(["-af", "afade=t=in:d=4,afade=t=out:st=6:d=4", "-c:a", "pcm_f32le"])
                .arg(&input).output().unwrap();
            assert!(result.status.success());
            let probe = probe_audio(&ffmpeg, &input).unwrap();
            let (item, issues) = analyze_audio_file(&ffmpeg, &input, "fade.wav", "Fade", "story");
            let plan = automatic_fix_plan(&item, &issues);
            assert!(plan.fix_loudness);
            assert!(!plan.rebuild_leading_silence && !plan.rebuild_trailing_silence);
            let output = dir.join("fade.mp3");
            fix_audio_file(&ffmpeg, &input, &output, &item, plan).unwrap();
            let written = measure_loudness_ebur128(&ffmpeg, &output, &[])
                .unwrap()
                .integrated_lufs;
            let predicted = probe.predicted_lufs.unwrap();
            let checked = probe_audio(&ffmpeg, &output)
                .unwrap()
                .integrated_lufs
                .unwrap();
            eprintln!("FADE amplitude={amplitude} source={:?} plan={plan:?} predicted={predicted} written={written} checker={checked}", probe.integrated_lufs);
            assert_eq!(predicted, expected);
            assert_eq!(written, expected);
            assert_eq!(checked, expected);
            assert!((predicted - checked).abs() <= 0.1);
            assert_eq!(
                probe.loudness_stays_quiet,
                checked < VALIDATION_WINDOW_LUFS.0
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// External corpus, deliberately kept out of the repository. Outputs stay
    /// in a temporary directory; the original archives are only read.
    #[test]
    #[ignore = "requires SS_CHECK_PACKS (archive paths separated by |) and bundled FFmpeg"]
    fn real_pack_corrections_converge() {
        let packs = std::env::var("SS_CHECK_PACKS").expect("SS_CHECK_PACKS");
        let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().unwrap();
        let dir = super::super::unique_pack_workspace("audio_convergence");
        std::fs::create_dir_all(&dir).unwrap();
        for path in packs.split('|') {
            let source = Path::new(path);
            let before = super::super::analyze_pack(source);
            assert!(!before.audio_items.is_empty(), "no audio: {path}");
            let fixed =
                super::super::create_fixed_pack_with_log(source, Some(&dir), None, None, &|_| {})
                    .expect("correct real pack");
            let fixed_path = Path::new(&fixed.fixed_zip_path);
            let source_entries = super::super::audio_regression_tests::zip_entry_stems(source);
            let fixed_entries = super::super::audio_regression_tests::zip_entry_stems(fixed_path);
            assert_eq!(source_entries, fixed_entries, "ZIP entries changed: {path}");
            let after = super::super::analyze_pack(fixed_path);
            eprintln!(
                "{path}: {} audio files, automatic corrections {} -> {}",
                before.audio_items.len(),
                before.corrections_available,
                after.corrections_available
            );
            for (original, item) in before.audio_items.iter().zip(&after.audio_items) {
                let plan = automatic_fix_plan(original, &before.issues);
                // L76B-6 planned from display-rounded edges. Report every
                // changed decision, including files that need no operation.
                let mut rounded = original.clone();
                rounded.leading_silence_secs = rounded.leading_silence_secs.map(round_secs);
                rounded.trailing_silence_secs = rounded.trailing_silence_secs.map(round_secs);
                let previous_plan = automatic_fix_plan(&rounded, &before.issues);
                if plan != previous_plan {
                    eprintln!(
                        "EDGE_DECISION_CHANGED {path} {}: {previous_plan:?} -> {plan:?}",
                        original.file_path
                    );
                }
                let announced = before.issues.iter().any(|issue| {
                    issue.file_path.as_deref() == Some(&original.file_path)
                        && issue
                            .auto_fix_description
                            .as_deref()
                            .is_some_and(|text| text.contains(codes::CHECKER_VOLUME_BEST_EFFORT))
                });
                let remains_quiet = item
                    .integrated_lufs
                    .is_some_and(|lufs| lufs < VALIDATION_WINDOW_LUFS.0);
                if plan.has_operations() {
                    let input = dir.join(Path::new(&original.file_path).file_name().unwrap());
                    std::fs::write(
                        &input,
                        super::super::zip_doc::read_zip_entry_bytes(source, &original.file_path)
                            .unwrap(),
                    )
                    .unwrap();
                    let predicted = if plan.fix_loudness {
                        probe_audio(&ffmpeg, &input)
                            .unwrap()
                            .predicted_lufs
                            .expect("preview must be measurable on the corpus")
                    } else {
                        let edges = build_selected_edge_silence_filters(
                            original.leading_silence_secs.unwrap_or(0.0),
                            original.trailing_silence_secs.unwrap_or(0.0),
                            EDGE_SILENCE_SEC,
                            EdgeSilenceSelection {
                                leading: plan.rebuild_leading_silence,
                                trailing: plan.rebuild_trailing_silence,
                            },
                        );
                        let mut filters = edges.pre_filters;
                        filters.push("aformat=channel_layouts=mono".to_string());
                        filters.extend(edges.post_filters);
                        filters.push("aresample=44100".to_string());
                        measure_output_preview(&ffmpeg, &input, &filters).unwrap()
                    };
                    let output = dir.join("written.mp3");
                    std::fs::write(
                        &output,
                        super::super::zip_doc::read_zip_entry_bytes(fixed_path, &item.file_path)
                            .unwrap(),
                    )
                    .unwrap();
                    let written = measure_loudness_ebur128(&ffmpeg, &output, &[])
                        .unwrap()
                        .integrated_lufs;
                    assert!(
                        (predicted - item.integrated_lufs.unwrap()).abs() <= 0.100_001,
                        "preview/reanalysis mismatch: {path} {}: {predicted} -> {:?}",
                        original.file_path,
                        item.integrated_lufs
                    );
                    if plan.fix_loudness {
                        // The announcement must anticipate the verifier's measured
                        // reanalysis, including its measurement-only edge trim.
                        assert_eq!(
                            announced, remains_quiet,
                            "announcement/reanalysis mismatch: {path} {}",
                            original.file_path
                        );
                    }
                    let texts: Vec<_> = before
                        .issues
                        .iter()
                        .filter(|issue| issue.file_path.as_deref() == Some(&original.file_path))
                        .filter_map(|issue| issue.auto_fix_description.as_deref())
                        .collect();
                    eprintln!(
                        "CORRECTED {}",
                        serde_json::json!({
                            "pack": source.file_name().unwrap().to_string_lossy(),
                            "file": original.file_path, "before": original.integrated_lufs,
                            "after": item.integrated_lufs, "predicted": predicted, "written": written,
                            "delta": item.integrated_lufs.unwrap() - predicted, "fixLoudness": plan.fix_loudness,
                            "announced": announced, "texts": texts
                        })
                    );
                }
                for issue in after.issues.iter().filter(|issue| {
                    issue.file_path.as_deref() == Some(&item.file_path)
                        && issue.fix_disposition == FixDisposition::Automatic
                }) {
                    assert!(
                        announced
                            && remains_quiet
                            && issue.code.as_deref() == Some(codes::CHECKER_AUDIO_VOLUME),
                        "unexpected remaining correction: {path} {issue:?}"
                    );
                }
            }
            assert!(
                after
                    .issues
                    .iter()
                    .filter(|issue| issue.fix_disposition == FixDisposition::Automatic)
                    .all(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_VOLUME)),
                "remaining non-volume correction: {path}"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "requires SS_QUIET_PACK and bundled FFmpeg"]
    fn real_near_mute_source_is_not_clipped() {
        let path = std::env::var("SS_QUIET_PACK").expect("SS_QUIET_PACK");
        let report = super::super::analyze_pack(Path::new(&path));
        let quiet = report
            .audio_items
            .iter()
            .find(|item| {
                item.integrated_lufs
                    .is_some_and(|lufs| lufs < NEAR_MUTE_LUFS)
            })
            .expect("near-mute corpus audio");
        assert!(quiet.true_peak_db.unwrap() < -40.0);
        assert!(
            !report.issues.iter().any(|issue| {
                issue.file_path.as_deref() == Some(&quiet.file_path)
                    && issue.code.as_deref() == Some(codes::CHECKER_AUDIO_CLIPPED)
            }),
            "quiet source falsely reported as clipped"
        );
    }

    #[test]
    fn real_ffmpeg_distinguishes_quiet_maxima_from_full_scale_clipping() {
        let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().expect("real FFmpeg required");
        let dir = super::super::unique_pack_workspace("clip_full_scale");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, amplitude, expected) in [("quiet", 0.002, false), ("clipped", 2.0, true)] {
            let input = dir.join(format!("{name}.wav"));
            let mut command = Command::new(&ffmpeg);
            apply_no_window(&mut command);
            let output = command
                .args(["-y", "-f", "lavfi", "-i"])
                .arg(format!("aevalsrc={amplitude}*sin(2*PI*440*t):s=44100:d=3"))
                .args(["-c:a", "pcm_s16le"])
                .arg(&input)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let (clipped, total) = measure_clip_stats(&ffmpeg, &input).unwrap();
            assert_eq!(audio_is_clipped(clipped, total), expected, "{name}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn boundary_levels_need_margin_only_when_the_signal_changes() {
        assert!(!needs_loudness_fix(-20.0, false));
        assert!(!needs_loudness_fix(-10.0, false));
        assert!(needs_loudness_fix(-20.0, true));
        assert!(needs_loudness_fix(-10.0, true));
        assert!(!needs_loudness_fix(-14.0, true));
    }

    #[test]
    fn edge_silence_classification_respects_contract_boundaries() {
        assert_eq!(
            classify_edge_silence(Some(0.34)),
            EdgeSilenceClassification::TooShort
        );
        assert_eq!(
            classify_edge_silence(Some(0.35)),
            EdgeSilenceClassification::Accepted
        );
        assert_eq!(
            classify_edge_silence(Some(0.40)),
            EdgeSilenceClassification::Accepted
        );
        assert_eq!(
            classify_edge_silence(Some(1.00)),
            EdgeSilenceClassification::Accepted
        );
        assert_eq!(
            classify_edge_silence(Some(1.01)),
            EdgeSilenceClassification::LongSuggestion
        );
        assert_eq!(
            classify_edge_silence(None),
            EdgeSilenceClassification::Unreadable
        );
    }

    #[test]
    fn silence_issues_expose_edge_codes_and_fix_dispositions() {
        let target = AudioIssueTarget {
            code: None,
            label: "Audio",
            file_path: "assets/test.mp3",
            item_type: "story",
        };
        let mut issues = Vec::new();
        let mut status = PackValidationSeverity::Ok;
        let mut fixes = Vec::new();
        add_silence_issue(
            &mut issues,
            &mut status,
            &mut fixes,
            target,
            AudioEdge::Leading,
            Some(0.34),
        );
        add_silence_issue(
            &mut issues,
            &mut status,
            &mut fixes,
            target,
            AudioEdge::Trailing,
            Some(1.01),
        );

        assert_eq!(status, PackValidationSeverity::Warning);
        assert_eq!(
            issues[0].code.as_deref(),
            Some("audioLeadingSilenceTooShort")
        );
        assert_eq!(issues[0].fix_disposition, FixDisposition::Automatic);
        assert_eq!(issues[0].severity, PackValidationSeverity::Warning);
        assert_eq!(issues[1].code.as_deref(), Some("audioTrailingSilenceLong"));
        assert_eq!(issues[1].fix_disposition, FixDisposition::Optional);
        assert_eq!(issues[1].severity, PackValidationSeverity::Info);
    }

    #[test]
    fn audio_status_keeps_highest_severity() {
        let mut status = PackValidationSeverity::Ok;
        raise_status(&mut status, PackValidationSeverity::Info);
        raise_status(&mut status, PackValidationSeverity::Warning);
        raise_status(&mut status, PackValidationSeverity::Info);
        raise_status(&mut status, PackValidationSeverity::Error);
        raise_status(&mut status, PackValidationSeverity::Warning);
        assert_eq!(status, PackValidationSeverity::Error);
    }

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
        // Fichiers réellement écrêtés (mesurés : 8 000–24 000 échantillons,
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
        assert_eq!(
            parse_count_field(stderr, "Number of samples:"),
            Some(12_946_554)
        );
        assert_eq!(parse_count_field(stderr, "Absent:"), None);
    }

    /// Harnais manuel : passe le vrai `analyze_audio_file` sur des assets réels et
    /// imprime statut + alertes. No-op sauf si les variables d'env sont posées :
    ///   SS_CHECK_ASSETS = chemins MP3 séparés par `|`
    ///   SS_FFMPEG       = chemin de ffmpeg.exe
    #[test]
    #[ignore = "requires SS_CHECK_ASSETS and SS_FFMPEG"]
    fn check_assets_from_env() {
        let assets = std::env::var("SS_CHECK_ASSETS").expect("SS_CHECK_ASSETS");
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
