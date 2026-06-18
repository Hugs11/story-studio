use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::super::{sanitize_stage_label, CanonicalOptions};
use crate::domain::project::SilenceMode;
use crate::services::project_files::validate_existing_file_path;
use crate::support::audio_norm::{
    build_edge_silence_filters, build_loudness_filters, measure_edge_silence,
    measure_loudness_ebur128, plan_loudness_fix, EdgeMeasure, EdgeSilenceFilters, LoudnessAction,
    EDGE_SILENCE_SEC,
};
use crate::support::ffmpeg::{apply_no_window, now_millis};

struct GenerationEdgePlan {
    measure_pre_filters: Vec<String>,
    output_filters: Option<EdgeSilenceFilters>,
    measured_edges: Option<(f64, f64)>,
}

/// Tolérance sur les silences de bord pour la copie verbatim : un MP3 dont les
/// bords sont déjà ≈ `EDGE_SILENCE_SEC` n'a pas besoin d'être re-traité en mode
/// `Normalize`.
const VERBATIM_EDGE_TOLERANCE_SEC: f64 = 0.05;

/// Taille max lue pour sonder l'en-tête MP3 lors de la décision de copie verbatim
/// (l'en-tête de trame se trouve au tout début, après un éventuel tag ID3).
const MP3_HEADER_SCAN_BYTES: u64 = 1024 * 1024;

/// Résultat de la préparation d'un asset audio pour le pack natif.
pub(crate) enum AudioPreparation {
    /// Asset déjà parfait (MP3 natif mono 44.1, niveau en bande morte, silences
    /// conformes) : copié verbatim, sans ré-encodage lossy.
    Verbatim { source: PathBuf },
    /// Asset ré-encodé en MP3 dans `processed_audio_dir`.
    Encoded { output: PathBuf },
}

pub(crate) fn mp3_header_is_native_compatible(bytes: &[u8]) -> bool {
    let Some(offset) = find_mpeg_sync(bytes) else {
        return false;
    };
    if offset + 4 > bytes.len() {
        return false;
    }

    let h = &bytes[offset..offset + 4];
    let mpeg_version = (h[1] >> 3) & 0x03;
    let sample_rate_index = (h[2] >> 2) & 0x03;
    let channel_mode = (h[3] >> 6) & 0x03;

    mpeg_version == 3 && sample_rate_index == 0 && channel_mode == 3
}

pub(crate) fn find_mpeg_sync(bytes: &[u8]) -> Option<usize> {
    let start = if bytes.starts_with(b"ID3") && bytes.len() >= 10 {
        let size = ((bytes[6] as usize) << 21)
            | ((bytes[7] as usize) << 14)
            | ((bytes[8] as usize) << 7)
            | (bytes[9] as usize);
        10 + size
    } else {
        0
    };

    let search = bytes.get(start..)?;
    for i in 0..search.len().saturating_sub(1) {
        if search[i] == 0xFF && (search[i + 1] & 0xE0) == 0xE0 {
            return Some(start + i);
        }
    }
    None
}

/// Prépare un asset audio : mesure (niveau + silences), décide entre **copie
/// verbatim** (asset déjà parfait) et **ré-encodage MP3**, et n'encode que si
/// nécessaire. La mesure sert aussi bien à la décision qu'à l'encodage : un seul
/// passage ffmpeg d'analyse.
pub(crate) fn prepare_audio_asset(
    source_path: &str,
    ffmpeg: &Path,
    processed_audio_dir: &Path,
    options: &CanonicalOptions,
    silence_duration_sec: f64,
    skip_silence: bool,
    role: &str,
) -> Result<AudioPreparation, String> {
    let source = validate_existing_file_path(source_path, role)?;
    let edge_plan = edge_plan_for_generation(
        ffmpeg,
        &source,
        options,
        silence_duration_sec,
        skip_silence,
        role,
    )?;
    let mut measure_filters = edge_plan.measure_pre_filters.clone();
    measure_filters.push("aformat=channel_layouts=mono".to_string());

    let action = loudness_action_for_generation(
        ffmpeg,
        &source,
        &measure_filters,
        options.harmonize_loudness,
        role,
    )?;

    if audio_can_copy_verbatim(
        &source,
        &action,
        edge_plan.measured_edges,
        options,
        skip_silence,
    )? {
        return Ok(AudioPreparation::Verbatim { source });
    }

    let output = encode_audio_asset(
        &source,
        ffmpeg,
        processed_audio_dir,
        options,
        silence_duration_sec,
        skip_silence,
        &action,
        edge_plan.output_filters.as_ref(),
        role,
    )?;
    Ok(AudioPreparation::Encoded { output })
}

/// Décide si l'asset peut être copié verbatim (aucun ré-encodage) : MP3 natif
/// mono 44.1 kHz, niveau dans la bande morte (`LoudnessAction::None`) et
/// silences déjà conformes au `silence_mode` demandé.
fn audio_can_copy_verbatim(
    source: &Path,
    action: &LoudnessAction,
    measured_edges: Option<(f64, f64)>,
    options: &CanonicalOptions,
    skip_silence: bool,
) -> Result<bool, String> {
    if !matches!(action, LoudnessAction::None) {
        return Ok(false);
    }
    if !silence_is_already_conform(measured_edges, options.silence_mode, skip_silence) {
        return Ok(false);
    }
    let bytes = read_leading_bytes(source, MP3_HEADER_SCAN_BYTES)
        .map_err(|e| format!("Lecture audio pour copie verbatim échouée : {}", e))?;
    Ok(mp3_header_is_native_compatible(&bytes))
}

/// Lit au plus `max` octets du début d'un fichier : la détection d'en-tête MP3
/// n'a besoin que du début, inutile de charger une grosse histoire entière.
fn read_leading_bytes(path: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(max).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Silences conformes au mode demandé, sans aucune opération de silence requise :
/// - `skip_silence` ou `Off` → rien à poser, conforme ;
/// - `Add` → on ajoute toujours du silence, donc jamais verbatim ;
/// - `Normalize` → conforme uniquement si les bords mesurés sont déjà ≈ 0.5 s.
fn silence_is_already_conform(
    measured_edges: Option<(f64, f64)>,
    silence_mode: SilenceMode,
    skip_silence: bool,
) -> bool {
    if skip_silence {
        return true;
    }
    match silence_mode {
        SilenceMode::Off => true,
        SilenceMode::Add => false,
        SilenceMode::Normalize => match measured_edges {
            Some((leading, trailing)) => {
                (leading - EDGE_SILENCE_SEC).abs() <= VERBATIM_EDGE_TOLERANCE_SEC
                    && (trailing - EDGE_SILENCE_SEC).abs() <= VERBATIM_EDGE_TOLERANCE_SEC
            }
            None => false,
        },
    }
}

/// Ré-encode l'asset en MP3 (mono, 44.1 kHz, q5) en appliquant la correction de
/// niveau planifiée et la normalisation de silence.
#[allow(clippy::too_many_arguments)]
fn encode_audio_asset(
    source: &Path,
    ffmpeg: &Path,
    processed_audio_dir: &Path,
    options: &CanonicalOptions,
    silence_duration_sec: f64,
    skip_silence: bool,
    action: &LoudnessAction,
    output_filters: Option<&EdgeSilenceFilters>,
    role: &str,
) -> Result<PathBuf, String> {
    let output_name = processed_audio_output_name(role);
    let output = processed_audio_dir.join(output_name);
    let filters = audio_filter_chain(
        options,
        skip_silence,
        silence_duration_sec,
        action,
        output_filters,
    );

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-i",
        source.to_string_lossy().as_ref(),
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
        "-map",
        "0:a",
        "-af",
        &filters,
        output.to_string_lossy().as_ref(),
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let output_result = cmd
        .output()
        .map_err(|e| format!("ffmpeg introuvable pour {} : {}", role, e))?;
    if !output_result.status.success() {
        let stderr = String::from_utf8_lossy(&output_result.stderr);
        let summary = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Erreur ffmpeg inconnue");
        return Err(format!(
            "Preparation audio native echouee pour {} : {}",
            role, summary
        ));
    }
    Ok(output)
}

#[cfg(test)]
pub(crate) fn audio_filters(options: &CanonicalOptions, skip_silence: bool) -> String {
    audio_filters_with_duration(options, skip_silence, EDGE_SILENCE_SEC)
}

#[cfg(test)]
pub(crate) fn audio_filters_with_duration(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
) -> String {
    audio_filters_with_action(
        options,
        skip_silence,
        silence_duration_sec,
        &LoudnessAction::None,
    )
}

#[cfg(test)]
pub(crate) fn audio_filters_with_action(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
    action: &LoudnessAction,
) -> String {
    audio_filter_chain(options, skip_silence, silence_duration_sec, action, None)
}

/// Construit la chaîne de filtres audio natifs : mono, correction de niveau
/// planifiée par `audio_norm`, puis silence final si l'option le demande.
fn audio_filter_chain(
    options: &CanonicalOptions,
    skip_silence: bool,
    silence_duration_sec: f64,
    action: &LoudnessAction,
    edge_filters: Option<&EdgeSilenceFilters>,
) -> String {
    let mut filters = Vec::new();
    if matches!(options.silence_mode, SilenceMode::Normalize) && !skip_silence {
        if let Some(edge_filters) = edge_filters {
            filters.extend(edge_filters.pre_filters.clone());
        }
    }
    filters.push("aformat=channel_layouts=mono".to_string());
    filters.extend(build_loudness_filters(action));
    match options.silence_mode {
        SilenceMode::Off => {}
        SilenceMode::Add if !skip_silence => {
            let silence_duration_sec = normalized_silence_duration_sec(silence_duration_sec);
            filters.push(format!(
                "adelay={}",
                (silence_duration_sec * 1000.0).round()
            ));
            filters.push(format!(
                "apad=pad_dur={}",
                format_ffmpeg_seconds(silence_duration_sec)
            ));
        }
        SilenceMode::Normalize if !skip_silence => {
            if let Some(edge_filters) = edge_filters {
                filters.extend(edge_filters.post_filters.clone());
            } else {
                filters.extend(
                    build_edge_silence_filters(0.0, 0.0, silence_duration_sec).post_filters,
                );
            }
        }
        _ => {}
    }
    filters.join(",")
}

fn edge_plan_for_generation(
    ffmpeg: &Path,
    source: &Path,
    options: &CanonicalOptions,
    silence_duration_sec: f64,
    skip_silence: bool,
    role: &str,
) -> Result<GenerationEdgePlan, String> {
    let measured_edges = match measure_edge_silence(ffmpeg, source)
        .map_err(|e| format!("Mesure des silences native échouée pour {} : {}", role, e))?
    {
        EdgeMeasure::Measured { leading, trailing } => Some((leading, trailing)),
        EdgeMeasure::AllSilence => {
            return Err(format!(
                "Preparation audio native impossible pour {} : audio silencieux",
                role
            ))
        }
        EdgeMeasure::Unreadable => None,
    };

    let measure_pre_filters = measured_edges
        .map(|(leading, trailing)| {
            build_edge_silence_filters(leading, trailing, EDGE_SILENCE_SEC).pre_filters
        })
        .unwrap_or_default();

    let output_filters = if matches!(options.silence_mode, SilenceMode::Normalize) && !skip_silence
    {
        let (leading, trailing) = measured_edges.unwrap_or((0.0, 0.0));
        Some(build_edge_silence_filters(
            leading,
            trailing,
            silence_duration_sec,
        ))
    } else {
        None
    };

    Ok(GenerationEdgePlan {
        measure_pre_filters,
        output_filters,
        measured_edges,
    })
}

/// Niveau planifié pour la génération.
///
/// - Harmonisation désactivée → aucune mesure ni correction (`None`) : le volume
///   d'origine est conservé et un audio quasi-muet/incorrigible ne bloque pas la
///   génération.
/// - Harmonisation activée → mesure EBU R128 + plan de correction ; un niveau
///   incorrigible fait échouer la préparation (comportement historique).
fn loudness_action_for_generation(
    ffmpeg: &Path,
    source: &Path,
    measure_filters: &[String],
    harmonize: bool,
    role: &str,
) -> Result<LoudnessAction, String> {
    if !harmonize {
        return Ok(LoudnessAction::None);
    }
    let measure = measure_loudness_ebur128(ffmpeg, source, measure_filters)
        .map_err(|e| format!("Mesure audio native échouée pour {} : {}", role, e))?;
    let action = plan_loudness_fix(measure.integrated_lufs, measure.true_peak_db);
    if matches!(action, LoudnessAction::Uncorrectable { .. }) {
        return Err(format!(
            "Preparation audio native impossible pour {} : {}",
            role,
            loudness_action_reason(&action)
        ));
    }
    Ok(action)
}

fn loudness_action_reason(action: &LoudnessAction) -> &str {
    match action {
        LoudnessAction::Uncorrectable { reason } => reason,
        _ => "correction non requise",
    }
}

fn normalized_silence_duration_sec(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        EDGE_SILENCE_SEC
    }
}

fn format_ffmpeg_seconds(value: f64) -> String {
    let formatted = format!("{:.3}", value);
    let trimmed = formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string();
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed
    }
}

pub(crate) fn hashed_asset_name(bytes: &[u8], extension: &str) -> String {
    format!("{:x}.{}", Sha1::digest(bytes), extension)
}

pub(crate) fn processed_audio_output_name(role: &str) -> String {
    let sanitized = sanitize_stage_label(role);
    let prefix: String = sanitized.chars().take(48).collect();
    let prefix = if prefix.is_empty() {
        "audio".to_string()
    } else {
        prefix
    };
    format!(
        "{}_{:x}_{}.mp3",
        prefix,
        Sha1::digest(role.as_bytes()),
        now_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_silence_conform_when_no_silence_work_needed() {
        // skip_silence : aucune opération de silence, quel que soit le mode.
        assert!(silence_is_already_conform(
            Some((1.0, 1.0)),
            SilenceMode::Normalize,
            true,
        ));
        // Off : on ne touche pas aux silences -> conforme.
        assert!(silence_is_already_conform(None, SilenceMode::Off, false));
    }

    #[test]
    fn verbatim_silence_never_conform_in_add_mode() {
        // Add ajoute toujours du silence -> jamais de copie verbatim.
        assert!(!silence_is_already_conform(
            Some((0.5, 0.5)),
            SilenceMode::Add,
            false,
        ));
    }

    #[test]
    fn verbatim_silence_conform_in_normalize_only_when_edges_are_half_second() {
        // Bords déjà ≈ 0.5 s (dans la tolérance) -> conforme.
        assert!(silence_is_already_conform(
            Some((0.5, 0.48)),
            SilenceMode::Normalize,
            false,
        ));
        // Bords trop longs -> traitement requis.
        assert!(!silence_is_already_conform(
            Some((1.0, 0.5)),
            SilenceMode::Normalize,
            false,
        ));
        // Bords absents (pas de silence du tout) -> traitement requis.
        assert!(!silence_is_already_conform(
            Some((0.0, 0.0)),
            SilenceMode::Normalize,
            false,
        ));
        // Mesure illisible -> on traite par sécurité.
        assert!(!silence_is_already_conform(
            None,
            SilenceMode::Normalize,
            false,
        ));
    }

    fn options_with_silence(mode: SilenceMode) -> CanonicalOptions {
        CanonicalOptions {
            silence_mode: mode,
            ..Default::default()
        }
    }

    #[test]
    fn harmonize_off_skips_loudness_action() {
        // Harmonisation désactivée : aucune mesure ffmpeg, aucune correction,
        // même pour ce qui serait sinon un niveau incorrigible.
        let action = loudness_action_for_generation(
            Path::new("ffmpeg"),
            Path::new("inexistant.mp3"),
            &Vec::<String>::new(),
            false,
            "test",
        )
        .expect("aucune erreur quand l'harmonisation est désactivée");
        assert_eq!(action, LoudnessAction::None);
    }

    #[test]
    fn filter_chain_applies_volume_only_for_a_gain_action() {
        let options = options_with_silence(SilenceMode::Off);
        // Volume conforme / harmonisation off -> action None -> pas de filtre volume.
        let none =
            audio_filters_with_action(&options, false, EDGE_SILENCE_SEC, &LoudnessAction::None);
        assert!(
            !none.contains("volume="),
            "pas de filtre volume attendu : {none}"
        );
        // Volume à corriger -> filtre volume présent.
        let gain = audio_filters_with_action(
            &options,
            false,
            EDGE_SILENCE_SEC,
            &LoudnessAction::Gain { gain_db: 4.0 },
        );
        assert!(gain.contains("volume="), "filtre volume attendu : {gain}");
    }

    #[test]
    fn silence_filters_are_independent_of_loudness_action() {
        // Orthogonalité : pour un même mode de silence, les filtres de silence
        // sont identiques que le volume soit corrigé ou non.
        let strip_volume = |chain: &str| {
            chain
                .split(',')
                .filter(|f| !f.starts_with("volume="))
                .collect::<Vec<_>>()
                .join(",")
        };
        for mode in [SilenceMode::Off, SilenceMode::Add, SilenceMode::Normalize] {
            let options = options_with_silence(mode);
            let none =
                audio_filters_with_action(&options, false, EDGE_SILENCE_SEC, &LoudnessAction::None);
            let gain = audio_filters_with_action(
                &options,
                false,
                EDGE_SILENCE_SEC,
                &LoudnessAction::Gain { gain_db: 3.0 },
            );
            assert_eq!(strip_volume(&none), strip_volume(&gain), "mode {mode:?}");
        }
    }

    #[test]
    fn silence_modes_emit_expected_silence_filters() {
        let none = &LoudnessAction::None;
        let off = audio_filters_with_action(
            &options_with_silence(SilenceMode::Off),
            false,
            EDGE_SILENCE_SEC,
            none,
        );
        assert!(
            !off.contains("adelay") && !off.contains("apad") && !off.contains("atrim"),
            "Off ne touche pas aux silences : {off}"
        );

        let add = audio_filters_with_action(
            &options_with_silence(SilenceMode::Add),
            false,
            EDGE_SILENCE_SEC,
            none,
        );
        assert!(
            add.contains("adelay") && add.contains("apad"),
            "Add ajoute du silence : {add}"
        );

        let normalize = audio_filters_with_action(
            &options_with_silence(SilenceMode::Normalize),
            false,
            EDGE_SILENCE_SEC,
            none,
        );
        assert!(
            normalize.contains("apad") || normalize.contains("atrim"),
            "Normalize cale les bords : {normalize}"
        );
    }

    /// Harnais manuel : ré-encode des fichiers source via le vrai pipeline
    /// (mesure → plan_loudness_fix → chaîne de filtres → MP3), en mode Normalize +
    /// harmonisation. No-op sauf si les variables d'env sont posées :
    ///   SS_REENCODE_INPUTS = chemins source séparés par `|`
    ///   SS_REENCODE_OUTDIR = dossier de sortie (new_<i>.mp3)
    ///   SS_FFMPEG          = chemin de ffmpeg.exe
    #[test]
    fn reencode_sample_from_env() {
        let Ok(inputs) = std::env::var("SS_REENCODE_INPUTS") else {
            return;
        };
        let outdir = std::env::var("SS_REENCODE_OUTDIR").expect("SS_REENCODE_OUTDIR");
        let ffmpeg = std::env::var("SS_FFMPEG").expect("SS_FFMPEG");
        let ffmpeg = PathBuf::from(ffmpeg);
        let outdir = PathBuf::from(outdir);
        let processed = outdir.join("_processed");
        fs::create_dir_all(&processed).unwrap();
        let options = CanonicalOptions {
            silence_mode: SilenceMode::Normalize,
            harmonize_loudness: true,
            ..Default::default()
        };
        for (i, path) in inputs.split('|').enumerate() {
            let path = path.trim();
            if path.is_empty() {
                continue;
            }
            let role = format!("sample{i}");
            let prep =
                prepare_audio_asset(path, &ffmpeg, &processed, &options, EDGE_SILENCE_SEC, false, &role)
                    .unwrap_or_else(|e| panic!("prepare {path} failed: {e}"));
            let dest = outdir.join(format!("new_{i}.mp3"));
            let src = match prep {
                AudioPreparation::Encoded { output } => output,
                AudioPreparation::Verbatim { source } => source,
            };
            fs::copy(&src, &dest).unwrap();
            eprintln!("OK {path} -> {}", dest.display());
        }
    }
}
