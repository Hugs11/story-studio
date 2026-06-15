use serde::{Deserialize, Serialize};

pub(crate) const AUDIO_MIN_EDGE_SILENCE_SECONDS: f64 = 0.4;
pub(crate) const AUDIO_MAX_EDGE_SILENCE_SECONDS: f64 = 1.0;
pub(crate) const AUDIO_TARGET_EDGE_SILENCE_SECONDS: f64 = 0.5;
pub(crate) const AUDIO_TARGET_INTEGRATED_LUFS: f64 = -12.0;
pub(crate) const AUDIO_TARGET_TRUE_PEAK_DB: f64 = -1.5;
pub(crate) const AUDIO_TARGET_LRA: f64 = 11.0;
pub(crate) const AUDIO_MIN_RECOMMENDED_LUFS: f64 = -18.0;
pub(crate) const AUDIO_MAX_RECOMMENDED_LUFS: f64 = -10.0;
pub(crate) const IMAGE_TARGET_WIDTH: u32 = 320;
pub(crate) const IMAGE_TARGET_HEIGHT: u32 = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackValidationSeverity {
    Ok,
    Info,
    Warning,
    Error,
}

impl PackValidationSeverity {
    pub(crate) fn as_status(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackValidationVerdict {
    Valid,
    ValidWithWarnings,
    NeedsFix,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ValidationSummary {
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
    pub ok: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackValidationIssue {
    pub severity: PackValidationSeverity,
    pub category: String,
    pub label: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub technical_details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    pub auto_fix_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_fix_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CategorySummary {
    pub total: usize,
    pub ok: usize,
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
    pub auto_fixable: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StructureSummary {
    pub lunii_compatible: bool,
    pub story_studio_editable: bool,
    pub story_count: usize,
    pub stage_count: usize,
    pub action_count: usize,
    pub referenced_audio_count: usize,
    pub referenced_image_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NightModeSummary {
    pub detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioValidationItem {
    pub file_path: String,
    pub label: String,
    pub item_type: String,
    pub status: String,
    pub auto_fix_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leading_silence_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trailing_silence_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrated_lufs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub true_peak_db: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageValidationItem {
    pub file_path: String,
    pub label: String,
    pub status: String,
    pub auto_fix_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackValidationReport {
    pub pack_name: String,
    pub zip_path: String,
    pub verdict: PackValidationVerdict,
    pub summary: ValidationSummary,
    pub audio_summary: CategorySummary,
    pub image_summary: CategorySummary,
    pub title_summary: CategorySummary,
    pub structure_summary: StructureSummary,
    pub night_mode: NightModeSummary,
    pub corrections_available: usize,
    pub issues: Vec<PackValidationIssue>,
    pub audio_items: Vec<AudioValidationItem>,
    pub image_items: Vec<ImageValidationItem>,
    pub technical_log: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedPackResult {
    pub source_zip_path: String,
    pub fixed_zip_path: String,
    pub fixed_count: usize,
    pub audio_fixed: usize,
    pub image_fixed: usize,
}

pub(crate) fn issue(
    severity: PackValidationSeverity,
    category: &str,
    label: impl Into<String>,
    message: impl Into<String>,
) -> PackValidationIssue {
    PackValidationIssue {
        severity,
        category: category.to_string(),
        label: label.into(),
        message: message.into(),
        technical_details: None,
        file_path: None,
        item_type: None,
        auto_fix_available: false,
        auto_fix_description: None,
    }
}

pub(crate) fn round_secs(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
