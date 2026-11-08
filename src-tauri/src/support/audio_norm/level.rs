//! Read-only analysis of the current source. Clipping detection can extend this
//! report later, independently of the harmonization decision.
use std::path::Path;

use crate::support::user_message::{codes, UserMessage};
use serde::Serialize;

use super::{
    build_edge_silence_filters_with_targets, harmonization_notice, plan_loudness_fix, EdgeMeasure,
    LoudnessAction,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioLevelReport {
    // Same unmeasurable-loudness decision as generation's AUDIO_SILENT_KEPT notice.
    pub silent: bool,
    // JSON has no infinity: null means that this level cannot be established.
    pub integrated_lufs: Option<f64>,
    pub true_peak_db: Option<f64>,
    pub notice: Option<&'static str>,
}

/// Same pre-filters as native_pack/assets/audio::loudness_measure_filters.
/// That module is private: reuse its underlying shared builder, with zero
/// output targets (targets affect only post_filters, never this measurement).
fn loudness_measure_filters(edges: Option<(f64, f64)>) -> Vec<String> {
    let mut filters = edges
        .map(|(leading, trailing)| {
            build_edge_silence_filters_with_targets(leading, trailing, 0.0, 0.0).pre_filters
        })
        .unwrap_or_default();
    filters.push("aformat=channel_layouts=mono".to_string());
    filters
}

pub(crate) fn measure_audio_level(ffmpeg: &Path, path: &Path) -> Result<AudioLevelReport, String> {
    // One generous 15-minute budget for both passes, including long audiobook
    // sources and slow machines; no duration probe can itself hang beforehand.
    measure_audio_level_until(
        ffmpeg,
        path,
        std::time::Instant::now() + std::time::Duration::from_secs(900),
    )
}

fn measure_audio_level_until(
    ffmpeg: &Path,
    path: &Path,
    deadline: std::time::Instant,
) -> Result<AudioLevelReport, String> {
    let stderr = run_level_tool(ffmpeg, &super::edge_envelope_args(path), deadline)?;
    let edges = super::edges_from_envelope(&super::parse_rms_envelope(&stderr));
    let filters = loudness_measure_filters(match edges {
        EdgeMeasure::Measured { leading, trailing } => Some((leading, trailing)),
        EdgeMeasure::AllSilence | EdgeMeasure::Unreadable => None,
    });
    let measure = super::loudness::measure_loudness_for_level(ffmpeg, path, &filters, deadline)?;
    let silent = measure.is_silent();
    let action = plan_loudness_fix(measure.integrated_lufs, measure.true_peak_db);
    let notice = harmonization_notice(measure.integrated_lufs, &action);
    match action {
        LoudnessAction::Uncorrectable { reason } if !silent => return Err(reason),
        _ => {}
    }
    Ok(AudioLevelReport {
        silent,
        integrated_lufs: measure
            .integrated_lufs
            .is_finite()
            .then_some(measure.integrated_lufs),
        true_peak_db: measure
            .true_peak_db
            .is_finite()
            .then_some(measure.true_peak_db),
        notice: if silent {
            None
        } else {
            notice.map(|notice| notice.code)
        },
    })
}

/// Bounded process runner confined to add-time analysis. The existing advanced
/// runner is behind native_pack's private assets module. Generation is untouched.
pub(super) fn run_level_tool(
    tool: &Path,
    args: &[String],
    deadline: std::time::Instant,
) -> Result<String, String> {
    let mut command = std::process::Command::new(tool);
    command.args(args);
    run_level_command(command, deadline)
}

fn run_level_command(
    mut command: std::process::Command,
    deadline: std::time::Instant,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    let failure = |reason: &str| {
        UserMessage::new(codes::FILES_TASK_ABANDONED)
            .param("error", reason)
            .into_transport()
    };
    if Instant::now() >= deadline {
        return Err(failure("audio measurement deadline exceeded"));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::support::ffmpeg::apply_no_window(&mut command);
    let mut child = command.spawn().map_err(|error| {
        UserMessage::new(codes::AUDIO_ASSEMBLY_FFMPEG_START_FAILED)
            .param("error", error.to_string())
            .into_transport()
    })?;
    let mut stderr = child.stderr.take().unwrap();
    let overflow = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            // Drain continuously, with bounded memory even for corrupt media.
            // The edge envelope writes ~25 MB per hour of sound: 256 MB covers
            // ~10 h, beyond real podcasts and audiobooks.
            const LIMIT: usize = 256 * 1024 * 1024;
            let mut bytes = Vec::new();
            let mut buffer = [0; 16384];
            loop {
                let count = stderr.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                if bytes.len() + count > LIMIT {
                    overflow.store(true, Ordering::Relaxed);
                } else {
                    bytes.extend_from_slice(&buffer[..count]);
                }
            }
            Ok::<_, std::io::Error>(bytes)
        });
        let status = loop {
            if Instant::now() >= deadline || overflow.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                break Err(failure(
                    "audio measurement deadline or output limit exceeded",
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(failure(&error.to_string()));
                }
            }
        };
        let bytes = reader
            .join()
            .map_err(|_| failure("audio measurement reader panicked"))?
            .map_err(|error| failure(&error.to_string()))?;
        let status = status?;
        if !status.success() {
            return Err(
                UserMessage::new(codes::FILES_EBUR128_AUDIO_MEASUREMENT_FAILED)
                    .param("toolError", super::loudness::compact_ffmpeg_error(&bytes))
                    .into_transport(),
            );
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
}

#[cfg(test)]
mod tests;
