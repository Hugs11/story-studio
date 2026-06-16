use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn file_ext(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("bin")
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(target_os = "windows")]
pub(crate) fn apply_no_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_no_window(_cmd: &mut Command) {}

pub(crate) fn get_ffmpeg_path() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("tools").join("ffmpeg.exe");
            if bundled.exists() {
                return Ok(bundled);
            }
            let sibling = dir.join("ffmpeg.exe");
            if sibling.exists() {
                return Ok(sibling);
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for base in cwd.ancestors() {
        let candidate = base.join("tools").join("ffmpeg.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("ffmpeg introuvable.\n\
         En production, placez ffmpeg.exe dans tools/ à côté de l'application.\n\
         En développement, placez ffmpeg.exe dans le dossier tools/ du dépôt."
        .to_string())
}
