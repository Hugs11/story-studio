//! Backend TTS Piper : moteur de voix **zéro-config** par défaut. Le runtime
//! natif 1.6 est embarqué ; les voix seules sont téléchargées au premier usage.

use serde::{Deserialize, Serialize};

// ── Structures publiques ─────────────────────────────────────────────────────

fn default_speed() -> f32 {
    1.0
}

/// Réglages Piper, désérialisés depuis l'objet `xttsSettings` côté JS (les champs
/// non-Piper et l'ancien `piperSentenceSilence` sont ignorés).
#[derive(Deserialize)]
pub struct PiperSettings {
    #[serde(rename = "piperVoice", default)]
    pub voice: String,
    #[serde(rename = "piperSpeed", default = "default_speed")]
    pub speed: f32,
}

#[derive(Deserialize)]
pub struct PiperGenerateRequest {
    pub text: String,
    pub voice: Option<String>,
    #[serde(default)]
    pub speed: f32,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
    #[serde(rename = "workspaceDir", default)]
    pub workspace_dir: Option<String>,
    #[serde(rename = "filenameHint")]
    pub filename_hint: Option<String>,
}

#[derive(Serialize)]
pub struct PiperVoiceInfo {
    pub id: String,
    pub label: String,
    pub quality: String,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiperStatus {
    pub default_voice: String,
    pub binary_installed: bool,
    pub voices: Vec<PiperVoiceInfo>,
}

// ── Sous-modules ─────────────────────────────────────────────────────────────

mod catalog;
mod generation;
mod output;
mod provision;
mod runtime;

pub use generation::{ensure_sync, generate_audio_sync, list_voices_sync};

#[cfg(test)]
mod tests {
    use super::catalog::{find_voice, DEFAULT_VOICE, VOICES};
    use super::generation::{length_scale_for_speed, validate_text_for_generation};
    use super::output::{generated_dir, output_filename};
    use super::runtime::resolve_piper_runtime;
    use super::{ensure_sync, generate_audio_sync, PiperGenerateRequest, PiperSettings};
    use std::path::Path;
    use std::process::Command;
    use uuid::Uuid;

    #[test]
    fn default_voice_is_in_catalog() {
        assert!(find_voice(DEFAULT_VOICE).is_some());
    }

    #[test]
    fn catalog_voice_urls_are_official_https() {
        for voice in VOICES {
            assert!(voice.onnx_url().starts_with("https://huggingface.co/"));
            assert!(voice.json_url().ends_with(".onnx.json?download=true"));
        }
    }

    #[test]
    fn output_filename_accepts_plain_hint() {
        let generated = output_filename(Some("Narration finale"), "mp3").unwrap();
        assert!(generated.starts_with("Narration_finale--"));
        assert!(generated.ends_with(".mp3"));
    }

    #[test]
    fn output_filename_rejects_path_segments() {
        for name in ["../voice", r"folder\voice", "voice..wav", "voice\u{0}"] {
            assert!(
                output_filename(Some(name), "mp3").is_err(),
                "{name:?} should be rejected"
            );
        }
    }

    #[test]
    fn generated_dir_prefers_active_workspace_and_falls_back_to_saved_project() {
        let mut request = PiperGenerateRequest {
            text: "Bonjour".to_string(),
            voice: None,
            speed: 1.0,
            save_path: Some("/projets/sauvegarde.mbah".to_string()),
            workspace_dir: Some("/cache/session-active".to_string()),
            filename_hint: None,
        };
        assert_eq!(
            generated_dir(&request).unwrap(),
            Path::new("/cache/session-active/voix-generees")
        );

        request.workspace_dir = None;
        assert_eq!(
            generated_dir(&request).unwrap(),
            Path::new("/projets/voix-generees")
        );
    }

    #[test]
    fn length_scale_inverts_and_clamps_speed() {
        assert!((length_scale_for_speed(1.0) - 1.0).abs() < f32::EPSILON);
        // Vitesse plus rapide → audio plus court (length_scale < 1).
        assert!(length_scale_for_speed(2.0) < 1.0);
        // Vitesse plus lente → audio plus long (length_scale > 1).
        assert!(length_scale_for_speed(0.5) > 1.0);
        // Hors bornes : clampé.
        assert!(length_scale_for_speed(10.0) >= 0.5);
        assert!(length_scale_for_speed(0.01) <= 2.0);
    }

    #[test]
    fn text_generation_rejects_empty_and_huge_inputs() {
        assert!(validate_text_for_generation("Bonjour").is_ok());
        assert!(validate_text_for_generation("   ").is_err());
        assert!(validate_text_for_generation(&"a".repeat(5001)).is_err());
    }

    #[test]
    #[ignore = "requires network access and the prepared native FFmpeg"]
    fn live_linux_uses_embedded_runtime_and_generates_all_catalog_voices() {
        if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            return;
        }

        let root =
            std::env::temp_dir().join(format!("story_studio_piper_live_été_{}", Uuid::new_v4()));
        let home = root.join("données Piper");
        let workspace = root.join("espace de travail");
        std::fs::create_dir_all(&workspace).expect("create live Piper workspace");
        let emit = |message: &str| eprintln!("{message}");

        let runtime = resolve_piper_runtime().expect("resolve embedded Piper runtime");
        let initial_mtime = std::fs::metadata(&runtime.executable)
            .and_then(|metadata| metadata.modified())
            .expect("Piper executable mtime");
        ensure_sync(&home, DEFAULT_VOICE, &emit).expect("initial Piper voice provision");
        ensure_sync(&home, DEFAULT_VOICE, &emit).expect("idempotent Piper provision");
        assert_eq!(
            initial_mtime,
            std::fs::metadata(&runtime.executable)
                .and_then(|metadata| metadata.modified())
                .expect("Piper executable mtime after restart")
        );

        let cases = VOICES.iter().map(|voice| (voice, 1.0)).chain(
            [0.5, 1.5]
                .into_iter()
                .map(|speed| (find_voice(DEFAULT_VOICE).unwrap(), speed)),
        );
        for (voice, speed) in cases {
            let output = generate_audio_sync(
                &home,
                PiperSettings {
                    voice: voice.id.to_string(),
                    speed,
                },
                PiperGenerateRequest {
                    text: format!(
                        "Validation de la voix {} sous Linux à la vitesse {speed}.",
                        voice.label
                    ),
                    voice: Some(voice.id.to_string()),
                    speed,
                    save_path: None,
                    workspace_dir: Some(workspace.to_string_lossy().to_string()),
                    filename_hint: Some(format!("{}-{speed}", voice.id)),
                },
                &emit,
            )
            .unwrap_or_else(|error| panic!("generate {} at {speed}: {error}", voice.id));
            let output = Path::new(&output);
            assert!(output.is_file());
            assert!(std::fs::metadata(output).unwrap().len() > 0);
            let ffmpeg =
                crate::support::ffmpeg::get_ffmpeg_path().expect("resolve prepared native FFmpeg");
            let status = Command::new(ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(output)
                .args(["-f", "null", "-"])
                .status()
                .expect("validate generated MP3");
            assert!(
                status.success(),
                "{} is not a readable MP3",
                output.display()
            );
        }

        std::fs::remove_dir_all(root).expect("clean live Piper fixture");
    }
}
