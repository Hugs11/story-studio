//! Catalogue figé des voix françaises Piper. Le runtime natif 1.6 est embarqué
//! séparément ; seuls les modèles et leurs configurations sont téléchargés.

/// Base HuggingFace pour les voix `rhasspy/piper-voices`, épinglée au tag v1.0.0.
const VOICES_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";

/// Identifiant de la voix par défaut — voix FR féminine claire, mono-locuteur.
pub(super) const DEFAULT_VOICE: &str = "fr_FR-siwis-medium";

/// Une voix du catalogue. `id` est la clé canonique Piper (`fr_FR-siwis-medium`)
/// qui sert aussi de nom de fichier (`<id>.onnx` + `<id>.onnx.json`).
pub(super) struct VoiceEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub quality: &'static str,
    /// Chemin relatif sous `VOICES_BASE`, sans l'extension finale.
    rel_path: &'static str,
    pub onnx_sha256: &'static str,
    pub json_sha256: &'static str,
}

impl VoiceEntry {
    pub fn onnx_url(&self) -> String {
        format!("{}/{}.onnx?download=true", VOICES_BASE, self.rel_path)
    }

    pub fn json_url(&self) -> String {
        format!("{}/{}.onnx.json?download=true", VOICES_BASE, self.rel_path)
    }
}

/// Voix FR par défaut. Toutes mono-locuteur : pas besoin de `--speaker`.
pub(super) const VOICES: &[VoiceEntry] = &[
    VoiceEntry {
        id: "fr_FR-siwis-medium",
        label: "Siwis (féminine, médium)",
        quality: "medium",
        rel_path: "fr/fr_FR/siwis/medium/fr_FR-siwis-medium",
        onnx_sha256: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
        json_sha256: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959",
    },
    VoiceEntry {
        id: "fr_FR-tom-medium",
        label: "Tom (masculine, médium)",
        quality: "medium",
        rel_path: "fr/fr_FR/tom/medium/fr_FR-tom-medium",
        onnx_sha256: "bf65074ccdeeeeaa832e75edb1c0a513c01c9a972bdf085ff8a6e71ea234fd41",
        json_sha256: "2f7f885ad5a0aad802e3cc24e4f57239febdcb142b4876de5d238094674361cc",
    },
    VoiceEntry {
        id: "fr_FR-gilles-low",
        label: "Gilles (masculine, légère)",
        quality: "low",
        rel_path: "fr/fr_FR/gilles/low/fr_FR-gilles-low",
        onnx_sha256: "5cd711846720e261c2a176f6924c198a7424d0a75dd4b0a5357a5fb9cb739285",
        json_sha256: "5a47cc0789e91267d17666bbec842dd92950669271a09023eb6970ee364cf88a",
    },
];

pub(super) fn find_voice(id: &str) -> Option<&'static VoiceEntry> {
    VOICES.iter().find(|voice| voice.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_catalog_pins_model_and_configuration_hashes() {
        for voice in VOICES {
            assert_eq!(voice.onnx_sha256.len(), 64);
            assert_eq!(voice.json_sha256.len(), 64);
            assert!(voice.onnx_url().starts_with("https://huggingface.co/"));
            assert!(voice.json_url().ends_with(".onnx.json?download=true"));
        }
    }
}
