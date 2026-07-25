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
    use super::{generate_audio_sync, get_status_sync, XttsGenerateRequest, XttsSettings};
    use std::fs;
    use std::path::PathBuf;

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

    #[test]
    #[ignore = "requires the private XTTS installation configured by STORY_STUDIO_XTTS_TEST_DIR"]
    fn live_cpu_status_and_generation_use_finetuned_reference_voice() {
        let xtts_dir = std::env::var("STORY_STUDIO_XTTS_TEST_DIR")
            .expect("STORY_STUDIO_XTTS_TEST_DIR must point to the XTTS installation");
        let settings = XttsSettings {
            enabled: true,
            server_url: "http://127.0.0.1:8020".to_string(),
            xtts_dir: xtts_dir.clone(),
            auto_start: true,
            force_cpu: true,
            language: "fr".to_string(),
        };
        let emit = |message: &str| eprintln!("{message}");

        let status = get_status_sync(
            XttsSettings {
                enabled: settings.enabled,
                server_url: settings.server_url.clone(),
                xtts_dir: settings.xtts_dir.clone(),
                auto_start: settings.auto_start,
                force_cpu: settings.force_cpu,
                language: settings.language.clone(),
            },
            &emit,
        )
        .expect("XTTS CPU status");

        assert_eq!(status.device.as_deref(), Some("cpu"));
        assert_eq!(
            status.model.as_deref(),
            Some("xtts-titre-energique-finetune")
        );
        assert!(status.voices.iter().any(|voice| voice == "titre_energique"));

        let workspace = std::env::temp_dir().join(format!(
            "story_studio_xtts_live_{}_{}",
            std::process::id(),
            crate::support::ffmpeg::now_millis()
        ));
        let generated = generate_audio_sync(
            settings,
            XttsGenerateRequest {
                text: "Les histoires de Toudou mon doudou.".to_string(),
                language: Some("fr".to_string()),
                speaker: None,
                voice: Some("titre_energique".to_string()),
                save_path: None,
                workspace_dir: Some(workspace.to_string_lossy().to_string()),
                filename_hint: Some("phase-3-xtts-cpu".to_string()),
            },
            &emit,
        )
        .expect("XTTS CPU generation");
        let generated = PathBuf::from(generated);
        assert!(generated.is_file());
        assert!(fs::metadata(&generated).expect("generated metadata").len() > 44);

        if let Some(file_name) = generated.file_name() {
            let _ = fs::remove_file(PathBuf::from(&xtts_dir).join("output").join(file_name));
        }
        fs::remove_dir_all(workspace).expect("cleanup live XTTS workspace");
    }
}
