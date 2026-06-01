use serde::{Deserialize, Serialize};

// ── Structures publiques ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct XttsSettings {
    pub enabled: bool,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "xttsDir")]
    pub xtts_dir: String,
    #[serde(rename = "autoStart")]
    pub auto_start: bool,
    #[serde(rename = "forceCpu", default)]
    pub force_cpu: bool,
    pub language: String,
}

#[derive(Deserialize)]
pub struct XttsGenerateRequest {
    pub text: String,
    pub language: Option<String>,
    pub speaker: Option<String>,
    pub voice: Option<String>,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
    #[serde(rename = "workspaceDir", default)]
    pub workspace_dir: Option<String>,
    #[serde(rename = "filenameHint")]
    pub filename_hint: Option<String>,
}

#[derive(Serialize)]
pub struct XttsStatus {
    pub device: Option<String>,
    pub model: Option<String>,
    pub voices: Vec<String>,
}

// ── Sous-modules ─────────────────────────────────────────────────────────────

mod client;
mod generation;
mod lifecycle;
mod output;

pub use generation::{generate_audio_sync, get_status_sync};

#[cfg(test)]
mod tests {
    use super::output::output_filename;

    #[test]
    fn output_filename_accepts_plain_filename() {
        let generated = output_filename(Some("Narration finale")).unwrap();
        assert!(generated.starts_with("Narration_finale--"));
        assert!(generated.ends_with(".wav"));
    }

    #[test]
    fn output_filename_rejects_path_segments() {
        for name in ["../voice", r"folder\voice", "voice..wav", "voice\u{0}"] {
            assert!(
                output_filename(Some(name)).is_err(),
                "{name:?} should be rejected"
            );
        }
    }
}
