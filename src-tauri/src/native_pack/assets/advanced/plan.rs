//! Descripteur immuable d'une conversion, et sa clé.
//!
//! La garantie 1 repose sur un point précis : une conversion est décrite par un
//! unique `ConversionTask { snapshotSha256, plan }`, construit une fois depuis
//! l'inventaire et **jamais modifié**, dont `taskKey = H(snapshotSha256, plan)`
//! est une fonction pure. Les champs sont donc privés et il n'existe aucun
//! mutateur : un descripteur ne se recompose pas après coup.
//!
//! **Le plan est arrêté avant l'exécution, paramètres compris.** C'est la raison
//! pour laquelle les mesures — bords et niveau — vivent ici, dans la
//! planification, et non dans l'exécuteur : ce qu'elles produisent entre dans la
//! clé. Deux transformations différentes ne peuvent donc pas partager une
//! adresse de sortie, y compris quand elles ne diffèrent que par une durée de
//! bord (T5b) ou par le seul limiteur (T4).

use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::domain::project::SilenceMode;
use crate::support::audio_norm::{
    build_edge_silence_filters_with_targets, ebur128_args, edge_envelope_args, edges_from_envelope,
    harmonization_notice, parse_ebur128_summary, parse_rms_envelope, plan_loudness_fix,
    EdgeMeasure, EdgeSilenceFilters, HarmonizationNotice, LoudnessAction, EDGE_SILENCE_SEC,
};

use super::super::audio::{audio_filter_chain_for, loudness_measure_filters};
use super::format::MpegFrameHeader;
use super::probe::{classify, run_tool, StdoutHandling, ToolOperation};
use super::MediaCause;

/// Options d'harmonisation et de silences, reçues en **paramètres d'appel**.
///
/// Le projet avancé ne porte pas les `globalOptions` du mode Libre : ces choix
/// appartiennent à l'auteur et l'export les reçoit. Sans paramètre, il ne transforme rien.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AdvancedAudioOptions {
    pub(crate) silence_mode: SilenceMode,
    pub(crate) harmonize_loudness: bool,
    pub(crate) leading_silence_sec: f64,
    pub(crate) trailing_silence_sec: f64,
}

impl Default for AdvancedAudioOptions {
    fn default() -> Self {
        Self {
            silence_mode: SilenceMode::Off,
            harmonize_loudness: false,
            leading_silence_sec: EDGE_SILENCE_SEC,
            trailing_silence_sec: EDGE_SILENCE_SEC,
        }
    }
}

impl AdvancedAudioOptions {
    /// Aucune option demandée : la condition de la copie verbatim.
    pub(crate) fn is_neutral(&self) -> bool {
        matches!(self.silence_mode, SilenceMode::Off) && !self.harmonize_loudness
    }
}

/// Les transformations réellement appliquées, dans l'ordre de la chaîne.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanStep {
    /// T1 — rognage des silences de bord mesurés.
    EdgeTrim,
    /// T2 — mixage descendant mono, non conservatif si les canaux diffèrent.
    MonoDownmix,
    /// T3 — gain scalaire.
    Gain,
    /// T4 — limiteur, non linéaire.
    Limiter,
    /// T5a — allongement aux extrémités.
    SilencePad,
    /// T5b — bords reposés à leur durée cible.
    EdgeRepad,
    /// T6 — encodage MP3, avec perte.
    Mp3Encode,
    Resize320x240,
    PngEncode,
}

impl PlanStep {
    pub(crate) fn label(self) -> &'static str {
        match self {
            PlanStep::EdgeTrim => "edge-trim",
            PlanStep::MonoDownmix => "mono-downmix",
            PlanStep::Gain => "gain",
            PlanStep::Limiter => "limiter",
            PlanStep::SilencePad => "silence-pad",
            PlanStep::EdgeRepad => "edge-repad",
            PlanStep::Mp3Encode => "mp3-encode",
            PlanStep::Resize320x240 => "resize-320x240",
            PlanStep::PngEncode => "png-encode",
        }
    }
}

/// Ce que l'exécuteur fera de l'instantané, entièrement arrêté.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ConversionPlan {
    /// Octets conservés : le média est déjà conforme et rien n'est demandé.
    AudioVerbatim,
    AudioEncode {
        filters: String,
        applied: Vec<PlanStep>,
        /// Ce que l'harmonisation a coûté, à dire à l'auteur. Il n'entre pas
        /// dans la clé de tâche : il se déduit de la mesure, que les filtres
        /// portent déjà.
        notice: Option<HarmonizationNotice>,
    },
    /// Octets conservés, dans un format de la liste fermée des extensions que
    /// STUdio sait lire.
    ImageVerbatim {
        extension: &'static str,
    },
    ImageResizePng,
}

impl ConversionPlan {
    /// Extension du format **réellement établi** dans les octets finaux.
    pub(crate) fn output_extension(&self) -> &'static str {
        match self {
            ConversionPlan::AudioVerbatim | ConversionPlan::AudioEncode { .. } => "mp3",
            ConversionPlan::ImageVerbatim { extension } => extension,
            ConversionPlan::ImageResizePng => "png",
        }
    }

    pub(crate) fn is_verbatim(&self) -> bool {
        matches!(
            self,
            ConversionPlan::AudioVerbatim | ConversionPlan::ImageVerbatim { .. }
        )
    }

    pub(crate) fn applied(&self) -> Vec<PlanStep> {
        match self {
            ConversionPlan::AudioVerbatim | ConversionPlan::ImageVerbatim { .. } => Vec::new(),
            ConversionPlan::AudioEncode { applied, .. } => applied.clone(),
            ConversionPlan::ImageResizePng => {
                vec![PlanStep::Resize320x240, PlanStep::PngEncode]
            }
        }
    }

    /// Encodage canonique du plan, tel qu'il entre dans la clé de tâche.
    ///
    /// Il porte les **arguments réels** de la transformation : pour un encodage
    /// audio, la chaîne de filtres entière, qui contient chaque durée, chaque
    /// gain et le limiteur s'il s'applique. Deux transformations distinctes ne
    /// peuvent donc pas produire le même encodage.
    fn encode(&self) -> String {
        match self {
            ConversionPlan::AudioVerbatim => "audio:verbatim".to_string(),
            ConversionPlan::AudioEncode { filters, .. } => {
                format!("audio:mp3-mono-44100-q5:af={filters}")
            }
            ConversionPlan::ImageVerbatim { extension } => {
                format!("image:verbatim:{extension}")
            }
            ConversionPlan::ImageResizePng => "image:resize-320x240-lanczos3:png".to_string(),
        }
    }
}

/// Descripteur immuable d'une conversion.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConversionTask {
    snapshot_sha256: String,
    plan: ConversionPlan,
}

impl ConversionTask {
    pub(crate) fn new(snapshot_sha256: String, plan: ConversionPlan) -> Self {
        Self {
            snapshot_sha256,
            plan,
        }
    }

    pub(crate) fn snapshot_sha256(&self) -> &str {
        &self.snapshot_sha256
    }

    pub(crate) fn plan(&self) -> &ConversionPlan {
        &self.plan
    }

    /// `taskKey = H(snapshotSha256, plan)`, fonction pure du descripteur.
    ///
    /// Elle est recalculée à chaque appel plutôt que mémorisée : une clé
    /// conservée pourrait diverger de ce qu'elle décrit, une clé dérivée non.
    pub(crate) fn task_key(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"story-studio/advanced-conversion/v1\0");
        hasher.update(self.snapshot_sha256.as_bytes());
        hasher.update(b"\0");
        hasher.update(self.plan.encode().as_bytes());
        format!("{:x}", hasher.finalize())
    }
}

/// Ce qui empêche d'arrêter un plan : toujours une cause typée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlanFailure {
    pub(crate) cause: MediaCause,
    pub(crate) detail: String,
}

/// Arrête le plan audio d'un instantané **déjà validé**.
///
/// Les mesures sont des invocations de conversion : l'instantané a
/// passé la validation, une panne d'outil ici ne peut donc plus conclure
/// `undecodable`.
pub(crate) fn plan_audio(
    ffmpeg: &Path,
    snapshot: &Path,
    header: Option<MpegFrameHeader>,
    options: &AdvancedAudioOptions,
    deadline: Duration,
) -> Result<ConversionPlan, PlanFailure> {
    if options.is_neutral() && header.is_some_and(|header| header.is_studio_conform()) {
        // Aucune option, format réel conforme : rien à mesurer, rien à faire.
        // Les bords ne sont même pas regardés — un silence voulu par l'auteur
        // n'a pas à devenir un refus.
        return Ok(ConversionPlan::AudioVerbatim);
    }

    // Les bords servent à la sortie en mode `Normalize`, et à la mesure de
    // volume dès que l'harmonisation est demandée, quel que soit le mode : la
    // décision de gain ne doit pas dépendre des silences de bord (même règle
    // que l'éditeur par menus, par la même fonction).
    let measured_edges =
        if matches!(options.silence_mode, SilenceMode::Normalize) || options.harmonize_loudness {
            measure_edges(ffmpeg, snapshot, deadline)?
        } else {
            None
        };

    let output_filters: Option<EdgeSilenceFilters> =
        if matches!(options.silence_mode, SilenceMode::Normalize) {
            let (leading, trailing) = measured_edges.unwrap_or((0.0, 0.0));
            Some(build_edge_silence_filters_with_targets(
                leading,
                trailing,
                options.leading_silence_sec,
                options.trailing_silence_sec,
            ))
        } else {
            None
        };

    let (action, notice) = if options.harmonize_loudness {
        let measure_filters = loudness_measure_filters(
            measured_edges,
            options.leading_silence_sec,
            options.trailing_silence_sec,
        );
        measure_loudness(ffmpeg, snapshot, &measure_filters, deadline)?
    } else {
        (LoudnessAction::None, None)
    };

    let filters = audio_filter_chain_for(
        options.silence_mode,
        options.leading_silence_sec,
        options.trailing_silence_sec,
        &action,
        output_filters.as_ref(),
    );
    let applied =
        applied_audio_transformations(options, &action, output_filters.as_ref(), &filters);

    Ok(ConversionPlan::AudioEncode {
        filters,
        applied,
        notice,
    })
}

/// Arrête le plan image d'un instantané déjà décodé.
///
/// La conformité exige **les deux** conditions : 320×240 **et** un format de la
/// liste fermée des extensions que STUdio sait lire. `ensure_image_320x240`
/// n'en teste que la première, ce qui laisse passer un `.webp` de 320×240 que
/// STUdio perdra en silence : le chemin avancé n'hérite pas de ce trou.
pub(crate) fn plan_image(
    width: u32,
    height: u32,
    extension: Option<&'static str>,
) -> ConversionPlan {
    match extension {
        Some(extension) if width == 320 && height == 240 => {
            ConversionPlan::ImageVerbatim { extension }
        }
        _ => ConversionPlan::ImageResizePng,
    }
}

fn measure_edges(
    ffmpeg: &Path,
    snapshot: &Path,
    deadline: Duration,
) -> Result<Option<(f64, f64)>, PlanFailure> {
    let run = run_tool(
        ffmpeg,
        &edge_envelope_args(snapshot),
        deadline,
        StdoutHandling::Discard,
    );
    if let Some(cause) = classify(ToolOperation::Conversion, &run.outcome, run.produced_data()) {
        return Err(PlanFailure {
            cause,
            detail: run.detail(),
        });
    }
    match edges_from_envelope(&parse_rms_envelope(&run.stderr)) {
        EdgeMeasure::Measured { leading, trailing } => Ok(Some((leading, trailing))),
        // Un média entièrement silencieux n'est jamais un refus : il n'y a
        // rien à rogner, et les bords seront simplement reposés à leur cible.
        // C'est exactement ce que le mode Libre refuse, et pourquoi son
        // orchestration n'est pas réutilisable ici.
        EdgeMeasure::AllSilence | EdgeMeasure::Unreadable => Ok(None),
    }
}

fn measure_loudness(
    ffmpeg: &Path,
    snapshot: &Path,
    pre_filters: &[String],
    deadline: Duration,
) -> Result<(LoudnessAction, Option<HarmonizationNotice>), PlanFailure> {
    let run = run_tool(
        ffmpeg,
        &ebur128_args(snapshot, pre_filters),
        deadline,
        StdoutHandling::Discard,
    );
    if let Some(cause) = classify(ToolOperation::Conversion, &run.outcome, run.produced_data()) {
        return Err(PlanFailure {
            cause,
            detail: run.detail(),
        });
    }
    // Niveau inétablissable — silence intégral, résumé incomplet : on ne corrige
    // pas. Inventer un gain changerait le son livré sur une mesure qu'on n'a pas.
    let Some(measure) = parse_ebur128_summary(&run.stderr) else {
        return Ok((LoudnessAction::None, None));
    };
    let action = plan_loudness_fix(measure.integrated_lufs, measure.true_peak_db);
    if action.is_correctable() {
        let notice = harmonization_notice(measure.integrated_lufs, &action);
        Ok((action, notice))
    } else {
        Ok((LoudnessAction::None, None))
    }
}

fn applied_audio_transformations(
    options: &AdvancedAudioOptions,
    action: &LoudnessAction,
    output_filters: Option<&EdgeSilenceFilters>,
    filters: &str,
) -> Vec<PlanStep> {
    let mut applied = Vec::new();
    if matches!(options.silence_mode, SilenceMode::Normalize)
        && output_filters.is_some_and(|edges| !edges.pre_filters.is_empty())
    {
        applied.push(PlanStep::EdgeTrim);
    }
    applied.push(PlanStep::MonoDownmix);
    match action {
        LoudnessAction::Gain { .. } => applied.push(PlanStep::Gain),
        LoudnessAction::GainLimit { .. } => {
            applied.push(PlanStep::Gain);
            applied.push(PlanStep::Limiter);
        }
        LoudnessAction::None | LoudnessAction::Uncorrectable { .. } => {}
    }
    if matches!(options.silence_mode, SilenceMode::Add)
        && (filters.contains("adelay=") || filters.contains("apad="))
    {
        applied.push(PlanStep::SilencePad);
    }
    if matches!(options.silence_mode, SilenceMode::Normalize)
        && output_filters.is_some_and(|edges| !edges.post_filters.is_empty())
    {
        applied.push(PlanStep::EdgeRepad);
    }
    applied.push(PlanStep::Mp3Encode);
    applied
}
