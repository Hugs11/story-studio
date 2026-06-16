use super::types::{LoudnessAction, LIMITER_SAMPLE_PEAK_LINEAR};

pub(crate) fn build_loudness_filters(action: &LoudnessAction) -> Vec<String> {
    match action {
        LoudnessAction::None | LoudnessAction::Uncorrectable { .. } => Vec::new(),
        LoudnessAction::Gain { gain_db } => vec![volume_filter(*gain_db)],
        LoudnessAction::GainLimit { gain_db, .. } => vec![
            volume_filter(*gain_db),
            format!(
                "alimiter=limit={}:level=disabled",
                format_filter_num(LIMITER_SAMPLE_PEAK_LINEAR)
            ),
        ],
    }
}

fn volume_filter(gain_db: f64) -> String {
    format!("volume={}dB", format_filter_num(gain_db))
}

pub(crate) fn format_filter_num(value: f64) -> String {
    let formatted = format!("{:.6}", value);
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_gain_and_limiter_filters() {
        assert_eq!(
            build_loudness_filters(&LoudnessAction::Gain { gain_db: 2.25 }),
            vec!["volume=2.25dB"]
        );
        assert_eq!(
            build_loudness_filters(&LoudnessAction::GainLimit {
                gain_db: 4.0,
                expected_limiting_db: 2.0,
            }),
            vec![
                "volume=4dB".to_string(),
                "alimiter=limit=0.794328:level=disabled".to_string(),
            ]
        );
    }
}
