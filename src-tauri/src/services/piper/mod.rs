//! Backend TTS Piper : moteur de voix **zéro-config** par défaut. Un simple
//! exécutable autonome (pas de serveur, pas de Python) provisionné au 1er usage.
//! Comparé à `services/xtts`, il n'y a **aucun cycle de vie serveur** : on
//! télécharge le binaire natif + la voix une fois, puis invoque Piper sans shell.

use serde::{Deserialize, Serialize};

// ── Structures publiques ─────────────────────────────────────────────────────

fn default_speed() -> f32 {
    1.0
}

fn default_sentence_silence() -> f32 {
    0.35
}

/// Réglages Piper, désérialisés depuis l'objet `xttsSettings` côté JS (les champs
/// non-Piper sont ignorés).
#[derive(Deserialize)]
pub struct PiperSettings {
    #[serde(rename = "piperVoice", default)]
    pub voice: String,
    #[serde(rename = "piperSpeed", default = "default_speed")]
    pub speed: f32,
    #[serde(rename = "piperSentenceSilence", default = "default_sentence_silence")]
    pub sentence_silence: f32,
}

#[derive(Deserialize)]
pub struct PiperGenerateRequest {
    pub text: String,
    pub voice: Option<String>,
    #[serde(default)]
    pub speed: f32,
    #[serde(rename = "sentenceSilence", default)]
    pub sentence_silence: Option<f32>,
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

pub use generation::{ensure_sync, generate_audio_sync, list_voices_sync};

#[cfg(test)]
mod tests {
    use super::catalog::{find_voice, DEFAULT_VOICE, VOICES};
    use super::generation::{
        length_scale_for_speed, sentence_silence_for_setting, validate_text_for_generation,
    };
    use super::output::output_filename;
    use super::provision::piper_exe;
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
    fn sentence_silence_clamps_to_supported_range() {
        assert!((sentence_silence_for_setting(0.35) - 0.35).abs() < f32::EPSILON);
        assert_eq!(sentence_silence_for_setting(-1.0), 0.0);
        assert_eq!(sentence_silence_for_setting(3.0), 1.5);
    }

    #[test]
    fn text_generation_rejects_empty_and_huge_inputs() {
        assert!(validate_text_for_generation("Bonjour").is_ok());
        assert!(validate_text_for_generation("   ").is_err());
        assert!(validate_text_for_generation(&"a".repeat(5001)).is_err());
    }

    #[test]
    #[ignore = "requires network access and the prepared native FFmpeg"]
    fn live_linux_provisions_once_and_generates_all_catalog_voices() {
        if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            return;
        }

        let root =
            std::env::temp_dir().join(format!("story_studio_piper_live_été_{}", Uuid::new_v4()));
        let home = root.join("données Piper");
        let workspace = root.join("espace de travail");
        std::fs::create_dir_all(&workspace).expect("create live Piper workspace");
        let emit = |message: &str| eprintln!("{message}");

        ensure_sync(&home, DEFAULT_VOICE, &emit).expect("initial Piper provision");
        let initial_mtime = std::fs::metadata(piper_exe(&home))
            .and_then(|metadata| metadata.modified())
            .expect("Piper executable mtime");
        ensure_sync(&home, DEFAULT_VOICE, &emit).expect("idempotent Piper provision");
        assert_eq!(
            initial_mtime,
            std::fs::metadata(piper_exe(&home))
                .and_then(|metadata| metadata.modified())
                .expect("Piper executable mtime after restart")
        );

        for voice in VOICES {
            let output = generate_audio_sync(
                &home,
                PiperSettings {
                    voice: voice.id.to_string(),
                    speed: 1.0,
                    sentence_silence: 0.35,
                },
                PiperGenerateRequest {
                    text: format!("Validation de la voix {} sous Linux.", voice.label),
                    voice: Some(voice.id.to_string()),
                    speed: 1.0,
                    sentence_silence: Some(0.35),
                    save_path: None,
                    workspace_dir: Some(workspace.to_string_lossy().to_string()),
                    filename_hint: Some(voice.id.to_string()),
                },
                &emit,
            )
            .unwrap_or_else(|error| panic!("generate {}: {error}", voice.id));
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
