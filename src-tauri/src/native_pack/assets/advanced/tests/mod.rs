//! Suite de la préparation des médias avancés.
//!
//! **Aucun média privé.** Toutes les fixtures sont synthétisées ici : les WAV
//! sont écrits octet par octet, les images sont encodées par la bibliothèque
//! déjà présente, et les MP3 sont produits à partir des WAV par l'outil embarqué
//! lui-même. Un corpus local n'est ni requis ni consulté.
//!
//! **Ce qui est doublé, et ce qui ne l'est pas.** Rien de ce que cette suite prétend
//! éprouver n'est remplacé par un double : ni le codec, ni la préparation, ni
//! l'exécuteur, ni l'oracle. Les tests qui exigent un transcodage réel
//! s'exécutent quand l'outil est résolu, et le disent quand il ne l'est pas —
//! ils ne se déclarent jamais verts sans avoir tourné.

mod calibration;
mod conversion;
mod inventory;
mod loudness_parity;
mod naming;
mod oracle;
mod throughput;

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::native_pack::persistence::{AdvancedMediaBinding, MediaBindingStatus};
use crate::native_pack::{decode_story_document, StoryDocument};
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};

pub(super) const ENTRY: &str = "1f0a5b6c-2d3e-4f50-8a9b-0c1d2e3f4a5b";
pub(super) const SECOND: &str = "2b7c8d9e-0f11-4223-8455-66778899aabb";
pub(super) const THIRD: &str = "3c8d9e0f-1122-4334-8566-778899aabbcc";

pub(super) const SAMPLE_RATE: u32 = 44_100;

/// Un dossier de travail propre, jeté par [`Scratch`] à la fin du test.
pub(super) struct Scratch {
    pub(super) root: PathBuf,
}

impl Scratch {
    pub(super) fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "story_studio_p2_04_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&root).expect("créer le dossier de test");
        Self { root }
    }

    pub(super) fn workspace(&self) -> PathBuf {
        self.root.join("workspace")
    }

    pub(super) fn sources(&self) -> PathBuf {
        let dir = self.root.join("sources");
        fs::create_dir_all(&dir).expect("créer le dossier de sources");
        dir
    }

    /// Écrit une source dans un sous-dossier nommé : deux homonymes de dossiers
    /// distincts sont ainsi exprimables.
    pub(super) fn write_source(&self, folder: &str, name: &str, bytes: &[u8]) -> PathBuf {
        let dir = self.sources().join(folder);
        fs::create_dir_all(&dir).expect("créer le sous-dossier de sources");
        let path = dir.join(name);
        fs::write(&path, bytes).expect("écrire la source");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// L'outil embarqué, s'il est résolu sur cette machine.
///
/// Quand il ne l'est pas, le test le **dit** et s'arrête : le compte rendu ne
/// doit jamais présenter comme exécuté ce qui ne l'a pas été.
pub(super) fn ffmpeg_or_skip(test: &str) -> Option<PathBuf> {
    match get_ffmpeg_path() {
        Ok(path) => Some(path),
        Err(error) => {
            eprintln!("[préparation] {test} non exécuté : FFmpeg non résolu ({error})");
            None
        }
    }
}

// ---------------------------------------------------------------- fixtures

/// Un WAV PCM 16 bits mono, écrit à la main : aucune dépendance, aucun média
/// privé, et un format que l'export doit convertir.
pub(super) fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

pub(super) fn silence(seconds: f64) -> Vec<i16> {
    vec![0; (SAMPLE_RATE as f64 * seconds) as usize]
}

/// Une sinusoïde, l'événement sonore le plus simple qui porte une énergie.
pub(super) fn tone(frequency: f64, seconds: f64, amplitude: f64) -> Vec<i16> {
    let count = (SAMPLE_RATE as f64 * seconds) as usize;
    (0..count)
        .map(|index| {
            let phase =
                2.0 * std::f64::consts::PI * frequency * index as f64 / f64::from(SAMPLE_RATE);
            (phase.sin() * amplitude * f64::from(i16::MAX)) as i16
        })
        .collect()
}

/// Un carré : c'est la forme qui démontre l'indistinguabilité de 441 Hz et
/// 220,5 Hz — même valeur absolue à chaque échantillon, donc mêmes énergies
/// segment par segment.
pub(super) fn square(frequency: f64, seconds: f64, amplitude: f64) -> Vec<i16> {
    let count = (SAMPLE_RATE as f64 * seconds) as usize;
    (0..count)
        .map(|index| {
            let phase = frequency * index as f64 / f64::from(SAMPLE_RATE);
            let sign = if phase.fract() < 0.5 { 1.0 } else { -1.0 };
            (sign * amplitude * f64::from(i16::MAX)) as i16
        })
        .collect()
}

/// Un événement placé dans le temps : c'est ce qui rend deux médias
/// distinguables par une empreinte d'énergie, là où deux carrés ne le sont pas.
pub(super) fn burst_at(offset_seconds: f64, total_seconds: f64) -> Vec<i16> {
    let mut samples = silence(total_seconds);
    let start = (SAMPLE_RATE as f64 * offset_seconds) as usize;
    let event = tone(660.0, 0.30, 0.7);
    for (index, sample) in event.iter().enumerate() {
        if start + index < samples.len() {
            samples[start + index] = *sample;
        }
    }
    samples
}

pub(super) fn png_bytes(width: u32, height: u32, seed: u8) -> Vec<u8> {
    encode_image(width, height, seed, image::ImageFormat::Png)
}

pub(super) fn gif_bytes(width: u32, height: u32, seed: u8) -> Vec<u8> {
    encode_image(width, height, seed, image::ImageFormat::Gif)
}

pub(super) fn bmp_bytes(width: u32, height: u32, seed: u8) -> Vec<u8> {
    encode_image(width, height, seed, image::ImageFormat::Bmp)
}

/// Une image reconnaissable : un dégradé dont la pente dépend de la graine, de
/// sorte que deux graines donnent deux répartitions de luminance distinctes.
fn encode_image(width: u32, height: u32, seed: u8, format: image::ImageFormat) -> Vec<u8> {
    let image = image::RgbImage::from_fn(width, height, |x, y| {
        let horizontal = (x * 255 / width.max(1)) as u8;
        let vertical = (y * 255 / height.max(1)) as u8;
        match seed % 3 {
            0 => image::Rgb([horizontal, 20, 20]),
            1 => image::Rgb([20, vertical, 20]),
            _ => image::Rgb([20, 20, horizontal.wrapping_add(vertical)]),
        }
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut out), format)
        .expect("encoder la fixture image");
    out
}

/// Encode un WAV en MP3 conforme par l'outil embarqué : le seul MP3 dont on
/// puisse affirmer qu'il est bien MPEG-1 Layer III mono 44,1 kHz est celui que
/// l'outil vient de produire.
pub(super) fn encode_conforming_mp3(ffmpeg: &Path, scratch: &Scratch, samples: &[i16]) -> Vec<u8> {
    let source = scratch.write_source("mp3-source", "source.wav", &wav_bytes(samples));
    let output = scratch
        .root
        .join(format!("conforming-{}.mp3", now_millis()));
    let status = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-v",
            "error",
            "-y",
            "-i",
            &source.to_string_lossy(),
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "5",
            "-map_metadata",
            "-1",
            "-id3v2_version",
            "0",
            &output.to_string_lossy(),
        ])
        .status()
        .expect("lancer FFmpeg pour la fixture MP3");
    assert!(status.success(), "la fixture MP3 doit être produite");
    fs::read(&output).expect("relire la fixture MP3")
}

// ------------------------------------------------------------- documents

/// Un document minimal : une entrée qui porte un son et une image.
pub(super) fn document_with(stages: &str, actions: &str) -> StoryDocument {
    let source = format!(
        r#"{{"format":"v1","version":1,"title":"Banc","stageNodes":[{stages}],"actionNodes":[{actions}]}}"#
    );
    decode_story_document(&source)
        .expect("le document de banc doit se décoder")
        .document
}

pub(super) fn stage(
    uuid: &str,
    square_one: bool,
    audio: Option<&str>,
    image: Option<&str>,
) -> String {
    let mut fields = vec![
        format!(r#""uuid":"{uuid}""#),
        format!(r#""squareOne":{square_one}"#),
    ];
    if let Some(audio) = audio {
        fields.push(format!(r#""audio":"{audio}""#));
    }
    if let Some(image) = image {
        fields.push(format!(r#""image":"{image}""#));
    }
    format!("{{{}}}", fields.join(","))
}

pub(super) fn binding(asset_ref: &str, path: &Path) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref: asset_ref.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        status: MediaBindingStatus::Resolved,
    }
}

pub(super) fn unbound(asset_ref: &str) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref: asset_ref.to_string(),
        path: None,
        status: MediaBindingStatus::Missing,
    }
}

pub(super) fn missing_at(asset_ref: &str, path: &Path) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref: asset_ref.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        status: MediaBindingStatus::Missing,
    }
}

/// Raccourci de banc : prépare avec les options par défaut.
pub(super) fn prepare(
    document: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    scratch: &Scratch,
    ffmpeg: &Path,
) -> Result<AdvancedAssetPreparation, AssetPreparationError> {
    prepare_advanced_assets(
        document,
        bindings,
        &scratch.workspace(),
        ffmpeg,
        &AdvancedAudioOptions::default(),
    )
}

/// Les causes d'un refus média, dans l'ordre où le refus les porte.
pub(super) fn causes(error: &AssetPreparationError) -> Vec<MediaCause> {
    match error {
        AssetPreparationError::MediaUnavailable(entries) => {
            entries.iter().map(|entry| entry.cause).collect()
        }
        other => panic!("refus média attendu, obtenu {other:?}"),
    }
}
