use crate::support::user_message;
use crate::support::user_message::codes;
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(super) struct TimedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(super) fn run_command_with_timeout(
    mut cmd: Command,
    timeout: Duration,
    label: &str,
) -> Result<TimedOutput, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer yt-dlp : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_OUTPUT_INACCESSIBLE)
            .with_detail("Sortie yt-dlp inaccessible.".to_string())
            .into_transport()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_ERROR_INACCESSIBLE)
            .with_detail("Erreur yt-dlp inaccessible.".to_string())
            .into_transport()
    })?;

    let stdout_handle = thread::spawn(move || read_pipe(stdout));
    let stderr_handle = thread::spawn(move || read_pipe(stderr));
    let start = Instant::now();

    loop {
        if let Some(status) = child.try_wait().map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_MONITOR_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Suivi du processus yt-dlp impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })? {
            return Ok(TimedOutput {
                status,
                stdout: stdout_handle.join().unwrap_or_default(),
                stderr: stderr_handle.join().unwrap_or_default(),
            });
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_handle.join().unwrap_or_default();
            let stderr = stderr_handle.join().unwrap_or_default();
            let tail = String::from_utf8_lossy(&stderr);
            let detail = tail.trim().lines().last().unwrap_or("");
            return Err(if detail.is_empty() {
                {
                    let _msg_label = (label).to_string();
                    let _msg_timeout_as_secs = (timeout.as_secs()).to_string();
                    user_message::UserMessage::new(codes::YOUTUBE_METADATA_REQUEST_TIMEOUT)
                        .param("label", user_message::transport_param(_msg_label.clone()))
                        .param(
                            "timeoutSeconds",
                            user_message::transport_param(_msg_timeout_as_secs.clone()),
                        )
                        .with_detail(format!(
                            "{_msg_label} a dépassé le délai autorisé ({_msg_timeout_as_secs} s).",
                            _msg_label = user_message::transport_detail(&_msg_label),
                            _msg_timeout_as_secs =
                                user_message::transport_detail(&_msg_timeout_as_secs)
                        ))
                        .into_transport()
                }
            } else {
                {
                    let _msg_label = (label).to_string();
                    let _msg_timeout_as_secs = (timeout.as_secs()).to_string();
                    let _msg_detail = (detail).to_string();
                    user_message::UserMessage::new(
                        codes::YOUTUBE_AUDIO_REQUEST_TIMEOUT,
                    )
                        .param("label", user_message::transport_param(_msg_label.clone()))
                        .param(
                            "timeoutSeconds",
                            user_message::transport_param(_msg_timeout_as_secs.clone()),
                        )
                        .param("detail", user_message::transport_param(_msg_detail.clone()))
                        .with_detail(format!(
                            "{_msg_label} a dépassé le délai autorisé ({_msg_timeout_as_secs} s) : {_msg_detail}",
                            _msg_detail = user_message::transport_detail(&_msg_detail),
                            _msg_label = user_message::transport_detail(&_msg_label),
                            _msg_timeout_as_secs = user_message::transport_detail(&_msg_timeout_as_secs),
                        ))
                        .into_transport()
                }
            });
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn read_pipe(mut pipe: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = pipe.read_to_end(&mut bytes);
    bytes
}
