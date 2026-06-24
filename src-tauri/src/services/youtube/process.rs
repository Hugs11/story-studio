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
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Impossible de lancer yt-dlp : {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sortie yt-dlp inaccessible.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Erreur yt-dlp inaccessible.".to_string())?;

    let stdout_handle = thread::spawn(move || read_pipe(stdout));
    let stderr_handle = thread::spawn(move || read_pipe(stderr));
    let start = Instant::now();

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Suivi du processus yt-dlp impossible : {}", e))?
        {
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
                format!(
                    "{} a dépassé le délai autorisé ({} s).",
                    label,
                    timeout.as_secs()
                )
            } else {
                format!(
                    "{} a dépassé le délai autorisé ({} s) : {}",
                    label,
                    timeout.as_secs(),
                    detail
                )
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
