//! Backend TTS Piper (D44) : moteur de voix **zéro-config** par défaut. Un simple
//! exécutable autonome (pas de serveur, pas de Python) provisionné au 1er usage.
//! Comparé à `services/xtts`, il n'y a **aucun cycle de vie serveur** : on
//! télécharge le binaire + la voix une fois, puis on invoque `piper.exe`.

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
}
