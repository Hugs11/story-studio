//! Format **réellement** porté par des octets, établi sans aucun outil externe.
//!
//! Deux constats distincts sont imposés sur chaque média : quel format ces
//! octets portent, et si l'outil sait les décoder jusqu'au bout. Ce fichier ne
//! répond qu'au premier, en mémoire et sans processus. Le second appartient à
//! `probe.rs`.
//!
//! **Pourquoi une lecture d'en-tête et pas `ffprobe`.** Aucun `ffprobe` n'est
//! résolu ni embarqué par l'application, et on s'interdit d'ajouter un outil
//! aux bundles. Lire le texte que FFmpeg écrit sur `stderr` pour en déduire un
//! format serait une faute : une décision prise sur une chaîne non garantie.
//! Les octets, eux, sont la source.
//!
//! **Ce que ce module corrige de `mp3_header_is_native_compatible`.** Le
//! prédicat historique cherche un sync MPEG puis teste la version, la fréquence
//! et le mode de canaux — jamais les **bits de couche** (`assets/audio.rs`). Un
//! en-tête Layer II le satisfait. Il reste utilisable comme présélection ; la
//! conformité de format, elle, se lit ici, couche comprise.

/// Conteneur audio reconnu aux octets d'en-tête.
///
/// La liste n'est pas une politique d'acceptation : un conteneur `Unknown` est
/// converti comme les autres si FFmpeg le décode. Elle sert au rapport de
/// conversion, qui doit dire de quoi il est parti.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioContainer {
    Mpeg,
    Wav,
    Ogg,
    Flac,
    Aiff,
    Mp4,
    Unknown,
}

impl AudioContainer {
    /// Nom porté par `detectedSourceFormat` dans le rapport.
    pub(crate) fn label(self) -> &'static str {
        match self {
            AudioContainer::Mpeg => "mpeg",
            AudioContainer::Wav => "wav",
            AudioContainer::Ogg => "ogg",
            AudioContainer::Flac => "flac",
            AudioContainer::Aiff => "aiff",
            AudioContainer::Mp4 => "mp4",
            AudioContainer::Unknown => "unknown",
        }
    }
}

/// En-tête de trame MPEG audio, lu champ par champ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MpegFrameHeader {
    /// 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = réservé.
    pub(crate) version: u8,
    /// 1 = Layer III, 2 = Layer II, 3 = Layer I, 0 = réservé.
    pub(crate) layer: u8,
    pub(crate) sample_rate_hz: Option<u32>,
    /// 3 = mono ; 0, 1 et 2 sont des formes à deux canaux.
    pub(crate) channel_mode: u8,
}

impl MpegFrameHeader {
    /// La seule forme que les deux passerelles consomment sans transcoder :
    /// MPEG-1 **Layer III**, 44,1 kHz, mono.
    pub(crate) fn is_studio_conform(&self) -> bool {
        self.version == 3
            && self.layer == 1
            && self.sample_rate_hz == Some(44_100)
            && self.channel_mode == 3
    }

    pub(crate) fn label(&self) -> String {
        let version = match self.version {
            3 => "mpeg1",
            2 => "mpeg2",
            0 => "mpeg2.5",
            _ => "mpeg-reserved",
        };
        let layer = match self.layer {
            1 => "layer3",
            2 => "layer2",
            3 => "layer1",
            _ => "layer-reserved",
        };
        let channels = if self.channel_mode == 3 {
            "mono"
        } else {
            "multichannel"
        };
        match self.sample_rate_hz {
            Some(rate) => format!("{version}-{layer}-{channels}-{rate}"),
            None => format!("{version}-{layer}-{channels}-unknown-rate"),
        }
    }
}

const MPEG1_RATES: [u32; 3] = [44_100, 48_000, 32_000];
const MPEG2_RATES: [u32; 3] = [22_050, 24_000, 16_000];
const MPEG25_RATES: [u32; 3] = [11_025, 12_000, 8_000];

/// Lit l'en-tête de la première trame MPEG, **couche comprise**.
///
/// Rend `None` quand aucun sync n'est trouvé ou que les quatre octets d'en-tête
/// ne sont pas tous présents : ce n'est pas un refus, seulement l'absence de
/// preuve qu'il s'agit d'un MPEG audio.
pub(crate) fn parse_mpeg_frame_header(bytes: &[u8]) -> Option<MpegFrameHeader> {
    let offset = super::super::audio::find_mpeg_sync(bytes)?;
    let header = bytes.get(offset..offset + 4)?;
    let version = (header[1] >> 3) & 0x03;
    let layer = (header[1] >> 1) & 0x03;
    let sample_rate_index = ((header[2] >> 2) & 0x03) as usize;
    let channel_mode = (header[3] >> 6) & 0x03;
    let sample_rate_hz = match version {
        3 => MPEG1_RATES.get(sample_rate_index).copied(),
        2 => MPEG2_RATES.get(sample_rate_index).copied(),
        0 => MPEG25_RATES.get(sample_rate_index).copied(),
        _ => None,
    };
    Some(MpegFrameHeader {
        version,
        layer,
        sample_rate_hz,
        channel_mode,
    })
}

/// Conteneur audio des octets, aux seules signatures d'en-tête.
pub(crate) fn detect_audio_container(bytes: &[u8]) -> AudioContainer {
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        return AudioContainer::Wav;
    }
    if bytes.starts_with(b"OggS") {
        return AudioContainer::Ogg;
    }
    if bytes.starts_with(b"fLaC") {
        return AudioContainer::Flac;
    }
    if bytes.starts_with(b"FORM") && matches!(bytes.get(8..12), Some(b"AIFF") | Some(b"AIFC")) {
        return AudioContainer::Aiff;
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return AudioContainer::Mp4;
    }
    // Un MPEG audio n'a pas de signature de conteneur : c'est la trame qui le
    // désigne, éventuellement précédée d'un tag ID3.
    if bytes.starts_with(b"ID3") || parse_mpeg_frame_header(bytes).is_some() {
        return AudioContainer::Mpeg;
    }
    AudioContainer::Unknown
}

/// Extension d'archive d'une image, dérivée du format **réel** de ses octets.
///
/// `None` pour tout format hors de la liste fermée des extensions que STUdio
/// sait lire : STUdio dérive le type d'un asset de son extension, et une
/// extension hors liste fait disparaître le média **en silence**. Un format
/// hors liste n'est donc jamais copié verbatim, il est réencodé en PNG.
pub(crate) fn studio_image_extension(format: image::ImageFormat) -> Option<&'static str> {
    match format {
        image::ImageFormat::Png => Some("png"),
        image::ImageFormat::Jpeg => Some("jpg"),
        image::ImageFormat::Bmp => Some("bmp"),
        _ => None,
    }
}

/// Nom du format image détecté, pour le rapport.
pub(crate) fn image_format_label(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpeg",
        image::ImageFormat::Bmp => "bmp",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Tiff => "tiff",
        image::ImageFormat::Ico => "ico",
        _ => "other",
    }
}
