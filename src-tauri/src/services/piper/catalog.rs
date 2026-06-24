//! Catalogue figé des artefacts Piper téléchargeables : binaire Windows + voix
//! françaises par défaut (D45/D46). Toutes les URL sont des sources officielles
//! HTTPS, épinglées par version pour la reproductibilité. Aucun binaire n'est
//! embarqué dans le dépôt ; tout est provisionné au 1er usage.

/// Version du binaire Piper (release `rhasspy/piper`). Épinglée pour garantir un
/// archive stable (le zip top-level contient un dossier `piper/`).
pub(super) const BINARY_VERSION: &str = "2023.11.14-2";

/// Archive autonome Windows amd64 (piper.exe + onnxruntime + espeak-ng-data).
pub(super) const BINARY_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";

/// Base HuggingFace pour les voix `rhasspy/piper-voices`, épinglée au tag v1.0.0.
const VOICES_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";

/// Identifiant de la voix par défaut (D46) — voix FR féminine claire, mono-locuteur.
pub(super) const DEFAULT_VOICE: &str = "fr_FR-siwis-medium";

/// Une voix du catalogue. `id` est la clé canonique Piper (`fr_FR-siwis-medium`)
/// qui sert aussi de nom de fichier (`<id>.onnx` + `<id>.onnx.json`).
pub(super) struct VoiceEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub quality: &'static str,
    /// Chemin relatif sous `VOICES_BASE`, sans l'extension finale.
    rel_path: &'static str,
}

impl VoiceEntry {
    pub fn onnx_url(&self) -> String {
        format!("{}/{}.onnx?download=true", VOICES_BASE, self.rel_path)
    }

    pub fn json_url(&self) -> String {
        format!("{}/{}.onnx.json?download=true", VOICES_BASE, self.rel_path)
    }
}

/// Voix FR par défaut (D46). Toutes mono-locuteur : pas besoin de `--speaker`.
pub(super) const VOICES: &[VoiceEntry] = &[
    VoiceEntry {
        id: "fr_FR-siwis-medium",
        label: "Siwis (féminine, médium)",
        quality: "medium",
        rel_path: "fr/fr_FR/siwis/medium/fr_FR-siwis-medium",
    },
    VoiceEntry {
        id: "fr_FR-tom-medium",
        label: "Tom (masculine, médium)",
        quality: "medium",
        rel_path: "fr/fr_FR/tom/medium/fr_FR-tom-medium",
    },
    VoiceEntry {
        id: "fr_FR-gilles-low",
        label: "Gilles (masculine, légère)",
        quality: "low",
        rel_path: "fr/fr_FR/gilles/low/fr_FR-gilles-low",
    },
];

pub(super) fn find_voice(id: &str) -> Option<&'static VoiceEntry> {
    VOICES.iter().find(|voice| voice.id == id)
}
