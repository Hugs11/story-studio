//! Catalogue figé des voix Piper proposées par Story Studio. Le runtime natif
//! 1.6 est embarqué séparément ; seuls les modèles et leurs configurations sont
//! téléchargés, depuis des révisions immuables et avec contrôle SHA-256.

/// Identifiant de la langue et de la voix utilisés par défaut.
pub(super) const DEFAULT_LANGUAGE: &str = "fr_FR";
pub(super) const DEFAULT_VOICE: &str = "fr_FR-siwis-medium";

/// Une voix du catalogue. `id` sert aussi de nom de fichier local
/// (`<id>.onnx` + `<id>.onnx.json`), indépendamment du nom à la source.
pub(super) struct VoiceEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub language: &'static str,
    pub quality: &'static str,
    pub is_default: bool,
    onnx_url: &'static str,
    json_url: &'static str,
    pub onnx_sha256: &'static str,
    pub json_sha256: &'static str,
}

impl VoiceEntry {
    pub fn onnx_url(&self) -> &'static str {
        self.onnx_url
    }

    pub fn json_url(&self) -> &'static str {
        self.json_url
    }
}

/// Les voix standard sont placées en premier pour chaque langue. Toutes sont
/// mono-locuteur : aucun argument `--speaker` n'est nécessaire.
pub(super) const VOICES: &[VoiceEntry] = &[
    VoiceEntry {
        id: "fr_FR-siwis-medium",
        label: "Siwis",
        language: "fr_FR",
        quality: "medium",
        is_default: true,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json?download=true",
        onnx_sha256: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
        json_sha256: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959",
    },
    VoiceEntry {
        id: "fr_FR-beatrice-medium",
        label: "Béatrice",
        language: "fr_FR",
        quality: "medium",
        is_default: false,
        onnx_url: "https://github.com/Hugs11/story-studio-voice-assets/releases/download/piper-beatrice-v1.0.0/fr_FR-beatrice-medium.onnx",
        json_url: "https://github.com/Hugs11/story-studio-voice-assets/releases/download/piper-beatrice-v1.0.0/fr_FR-beatrice-medium.onnx.json",
        onnx_sha256: "a4162bde9379eff87007e915b718e2755944a9ccd4f217a830fe4e8fae6859a3",
        json_sha256: "49a751158836163146ef90aff5485a594d282dcf5e3864363420b45782703550",
    },
    VoiceEntry {
        id: "fr_FR-tom-medium",
        label: "Tom",
        language: "fr_FR",
        quality: "medium",
        is_default: false,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx.json?download=true",
        onnx_sha256: "bf65074ccdeeeeaa832e75edb1c0a513c01c9a972bdf085ff8a6e71ea234fd41",
        json_sha256: "2f7f885ad5a0aad802e3cc24e4f57239febdcb142b4876de5d238094674361cc",
    },
    VoiceEntry {
        id: "en_GB-jenny_dioco-medium",
        label: "Jenny (Dioco)",
        language: "en_GB",
        quality: "medium",
        is_default: true,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx.json?download=true",
        onnx_sha256: "469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01",
        json_sha256: "a9a7a93a317c9a3cb6563e37eb057df9ef09c06188a8a4341b0fcb58cba54dd4",
    },
    VoiceEntry {
        id: "en_GB-alba-medium",
        label: "Alba",
        language: "en_GB",
        quality: "medium",
        is_default: false,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alba/medium/en_GB-alba-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json?download=true",
        onnx_sha256: "401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b",
        json_sha256: "aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4",
    },
    VoiceEntry {
        id: "en_US-kristin-medium",
        label: "Kristin",
        language: "en_US",
        quality: "medium",
        is_default: true,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/kristin/medium/en_US-kristin-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/kristin/medium/en_US-kristin-medium.onnx.json?download=true",
        onnx_sha256: "5849957f929cbf720c258f8458692d6103fff2f0e3d3b19c8259474bb06a18d4",
        json_sha256: "5681426d4aead22195de70531eeeeddb46493cfaffc5764b2ea3db73428b651c",
    },
    VoiceEntry {
        id: "en_US-ljspeech-medium",
        label: "LJSpeech",
        language: "en_US",
        quality: "medium",
        is_default: false,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json?download=true",
        onnx_sha256: "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
        json_sha256: "141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860",
    },
    VoiceEntry {
        id: "it_IT-serena-medium",
        label: "Serena",
        language: "it_IT",
        quality: "medium",
        is_default: true,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/ea046e8458f6acd997706d6e6066a022b42f6fb1/it/it_IT/serena/medium/it_IT-serena-medium.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/ea046e8458f6acd997706d6e6066a022b42f6fb1/it/it_IT/serena/medium/it_IT-serena-medium.onnx.json?download=true",
        onnx_sha256: "3f1493311db17fec0e95cdf3c92f82b5006159b7743e057a749187469dfa7cf0",
        json_sha256: "0c5ecb9a9f574f1363993df8f641dd3ed433cd940045e137809e25651057c550",
    },
    VoiceEntry {
        id: "it_IT-serena-high",
        label: "Serena HQ",
        language: "it_IT",
        quality: "high",
        is_default: false,
        onnx_url: "https://huggingface.co/rhasspy/piper-voices/resolve/ea046e8458f6acd997706d6e6066a022b42f6fb1/it/it_IT/serena/high/it_IT-serena-high.onnx?download=true",
        json_url: "https://huggingface.co/rhasspy/piper-voices/resolve/ea046e8458f6acd997706d6e6066a022b42f6fb1/it/it_IT/serena/high/it_IT-serena-high.onnx.json?download=true",
        onnx_sha256: "743240dae6ecab12cdc3eee9260cbf688a04e066775d0ce28b8007dad12f42d0",
        json_sha256: "ce7e3319aee3b687ab6e8be8d49eae350e5ef942eaf95189dec80fb89110d4ee",
    },
];

pub(super) fn find_voice(id: &str) -> Option<&'static VoiceEntry> {
    VOICES.iter().find(|voice| voice.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn voice_catalog_pins_model_and_configuration_hashes() {
        for voice in VOICES {
            assert_eq!(voice.onnx_sha256.len(), 64);
            assert_eq!(voice.json_sha256.len(), 64);
            assert!(voice.onnx_url().starts_with("https://"));
            assert!(voice.json_url().starts_with("https://"));
        }
    }

    #[test]
    fn each_supported_language_has_exactly_one_default_voice() {
        let expected = HashMap::from([
            ("fr_FR", "fr_FR-siwis-medium"),
            ("en_GB", "en_GB-jenny_dioco-medium"),
            ("en_US", "en_US-kristin-medium"),
            ("it_IT", "it_IT-serena-medium"),
        ]);
        let languages: HashSet<_> = VOICES.iter().map(|voice| voice.language).collect();
        assert_eq!(languages, expected.keys().copied().collect());
        for (language, default_voice) in expected {
            let defaults: Vec<_> = VOICES
                .iter()
                .filter(|voice| voice.language == language && voice.is_default)
                .collect();
            assert_eq!(defaults.len(), 1, "{language} must have one default voice");
            assert_eq!(defaults[0].id, default_voice);
        }
        assert_eq!(
            find_voice(DEFAULT_VOICE).unwrap().language,
            DEFAULT_LANGUAGE
        );
    }

    #[test]
    fn beatrice_uses_the_story_studio_versioned_mirror() {
        let voice = find_voice("fr_FR-beatrice-medium").unwrap();
        let release = "https://github.com/Hugs11/story-studio-voice-assets/releases/download/piper-beatrice-v1.0.0/";
        assert!(voice.onnx_url().starts_with(release));
        assert!(voice.json_url().starts_with(release));
        assert!(!voice.onnx_url().contains("DantSu/Telmi-Sync"));
        assert!(!voice.json_url().contains("DantSu/Telmi-Sync"));
    }
}
