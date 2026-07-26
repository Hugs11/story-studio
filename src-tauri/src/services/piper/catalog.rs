//! Catalogue figé des artefacts Piper téléchargeables par plateforme et voix
//! françaises par défaut. Toutes les URL sont des sources officielles
//! HTTPS, épinglées par version pour la reproductibilité. Aucun binaire n'est
//! embarqué dans le dépôt ; tout est provisionné au 1er usage.

/// Version du binaire Piper (release `rhasspy/piper`). Épinglée pour garantir un
/// archive stable (chaque archive contient un dossier racine `piper/`).
pub(super) const BINARY_VERSION: &str = "2023.11.14-2";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ArchiveKind {
    Zip,
    TarGz,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct BinaryEntry {
    pub os: &'static str,
    pub arch: &'static str,
    pub archive_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub archive_kind: ArchiveKind,
    pub executable_name: &'static str,
}

/// Le catalogue conserve strictement la release Windows historique et ajoute
/// les deux assets officiellement nommés pour les cibles POSIX. L'architecture
/// du binaire extrait est contrôlée avant activation : l'asset macOS amont est
/// donc refusé s'il ne contient pas réellement du code ARM64.
pub(super) const BINARIES: &[BinaryEntry] = &[
    BinaryEntry {
        os: "windows",
        arch: "x86_64",
        archive_name: "piper_windows_amd64.zip",
        url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
        sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
        archive_kind: ArchiveKind::Zip,
        executable_name: "piper.exe",
    },
    BinaryEntry {
        os: "linux",
        arch: "x86_64",
        archive_name: "piper_linux_x86_64.tar.gz",
        url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
        sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
        archive_kind: ArchiveKind::TarGz,
        executable_name: "piper",
    },
    BinaryEntry {
        os: "macos",
        arch: "aarch64",
        archive_name: "piper_macos_aarch64.tar.gz",
        url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_aarch64.tar.gz",
        sha256: "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
        archive_kind: ArchiveKind::TarGz,
        executable_name: "piper",
    },
];

pub(super) fn binary_for(os: &str, arch: &str) -> Option<&'static BinaryEntry> {
    BINARIES
        .iter()
        .find(|entry| entry.os == os && entry.arch == arch)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_covers_the_three_supported_desktop_targets() {
        let windows = binary_for("windows", "x86_64").expect("Windows Piper");
        let linux = binary_for("linux", "x86_64").expect("Linux Piper");
        let macos = binary_for("macos", "aarch64").expect("macOS Piper");

        assert_eq!(windows.archive_name, "piper_windows_amd64.zip");
        assert_eq!(windows.executable_name, "piper.exe");
        assert_eq!(windows.archive_kind, ArchiveKind::Zip);
        assert_eq!(linux.archive_name, "piper_linux_x86_64.tar.gz");
        assert_eq!(linux.executable_name, "piper");
        assert_eq!(macos.archive_name, "piper_macos_aarch64.tar.gz");
        assert_eq!(macos.executable_name, "piper");
        assert!(BINARIES.iter().all(|entry| {
            entry
                .url
                .starts_with("https://github.com/rhasspy/piper/releases/download/")
                && entry.sha256.len() == 64
        }));
    }

    #[test]
    fn catalog_rejects_unsupported_pairs() {
        assert!(binary_for("linux", "aarch64").is_none());
        assert!(binary_for("macos", "x86_64").is_none());
        assert!(binary_for("windows", "aarch64").is_none());
    }
}
