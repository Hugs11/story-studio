pub(crate) const TARGET_LUFS: f64 = -14.0;
pub(crate) const LIMITER_SAMPLE_PEAK_DBFS: f64 = -2.0;
pub(crate) const LIMITER_SAMPLE_PEAK_LINEAR: f64 = 0.794_328;
pub(crate) const EXPECTED_FINAL_TRUE_PEAK_DBTP: f64 = -0.5;
pub(crate) const MAX_LIMITING_DB: f64 = 6.0;
pub(crate) const VALIDATION_WINDOW_LUFS: (f64, f64) = (-20.0, -10.0);
pub(crate) const DEADBAND_LUFS: (f64, f64) = (-15.5, -12.5);
pub(crate) const NEAR_MUTE_LUFS: f64 = -45.0;
pub(crate) const EDGE_SILENCE_SEC: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LoudnessMeasure {
    pub integrated_lufs: f64,
    pub true_peak_db: f64,
    pub loudness_range_lu: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LoudnessAction {
    None,
    Gain {
        gain_db: f64,
    },
    GainLimit {
        gain_db: f64,
        expected_limiting_db: f64,
    },
    Uncorrectable {
        reason: String,
    },
}

impl LoudnessAction {
    pub(crate) fn is_correctable(&self) -> bool {
        !matches!(self, Self::Uncorrectable { .. })
    }
}
