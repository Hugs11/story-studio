//! Téléchargement de l'audio d'une vidéo : `yt-dlp -x --audio-format mp3` avec le
//! ffmpeg embarqué. Sortie bornée à un dossier temp système (le frontend la copie
//! ensuite dans le projet/session, comme pour le podcast).

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use super::metadata::validate_youtube_url;
use super::process::run_command_with_timeout;
use super::provision::ensure_ytdlp;
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path};

const TEMP_DIR: &str = "story_studio_youtube";
/// Garde-fou de taille par vidéo (cohérent avec le plafond média podcast).
const MAX_FILESIZE: &str = "300M";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub fn download_audio(
    home: &Path,
    custom: Option<&str>,
    video_url: &str,
    file_name: &str,
    emit: &dyn Fn(&str),
) -> Result<String, String> {
    validate_youtube_url(video_url)?;
    let exe = ensure_ytdlp(home, custom, emit)?;

    let ffmpeg = get_ffmpeg_path()?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "Dossier ffmpeg introuvable.".to_string())?;

    let dir = std::env::temp_dir().join(TEMP_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Création du dossier temporaire impossible : {}", e))?;
    let stem = unique_stem(&dir, file_name);
    let dest = dir.join(format!("{}.mp3", stem));
    // yt-dlp remplace `%(ext)s` ; après extraction MP3 le fichier est `<stem>.mp3`.
    let out_template = dir.join(format!("{}.%(ext)s", stem));

    emit("Téléchargement de l'audio…");
    let mut cmd = Command::new(&exe);
    apply_no_window(&mut cmd);
    cmd.args([
        "--no-playlist".as_ref(),
        "--no-warnings".as_ref(),
        "--ignore-config".as_ref(),
        "--max-filesize".as_ref(),
        MAX_FILESIZE.as_ref(),
        "-f".as_ref(),
        "bestaudio/best".as_ref(),
        "-x".as_ref(),
        "--audio-format".as_ref(),
        "mp3".as_ref(),
        "--ffmpeg-location".as_ref(),
        ffmpeg_dir.as_os_str(),
        "-o".as_ref(),
        out_template.as_os_str(),
        video_url.as_ref(),
    ]);

    let output = match run_command_with_timeout(cmd, DOWNLOAD_TIMEOUT, "Téléchargement YouTube") {
        Ok(output) => output,
        Err(err) => {
            cleanup_stem_files(&dir, &stem);
            return Err(err);
        }
    };
    if !output.status.success() {
        cleanup_stem_files(&dir, &stem);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Téléchargement impossible : {}",
            stderr.trim().lines().last().unwrap_or("erreur inconnue")
        ));
    }
    if !dest.is_file() || std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err("yt-dlp n'a produit aucun fichier audio.".to_string());
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Radical de fichier sûr et unique dans `dir` (mêmes règles que le podcast :
/// alphanum + `-_ `, borné à 80 caractères, défaut `video`).
fn unique_stem(dir: &Path, name: &str) -> String {
    let mut base: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    base = base.trim().to_string();
    if base.chars().count() > 80 {
        base = base.chars().take(80).collect::<String>().trim().to_string();
    }
    if base.is_empty() {
        base = "video".to_string();
    }
    let mut candidate = base.clone();
    let mut counter = 1;
    while stem_has_files(dir, &candidate) {
        candidate = format!("{}-{}", base, counter);
        counter += 1;
    }
    candidate
}

fn stem_has_files(dir: &Path, stem: &str) -> bool {
    if dir.join(format!("{}.mp3", stem)).exists() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let prefix = format!("{}.", stem);
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .map(|name| name.starts_with(&prefix))
            .unwrap_or(false)
    })
}

fn cleanup_stem_files(dir: &Path, stem: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{}.", stem);
    for entry in entries.flatten() {
        let path = entry.path();
        let should_remove = entry
            .file_name()
            .to_str()
            .map(|name| name == stem || name.starts_with(&prefix))
            .unwrap_or(false);
        if should_remove && path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cleanup_stem_files, unique_stem};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("story_studio_yt_dl_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitizes_and_deduplicates() {
        let dir = temp_dir();
        assert_eq!(unique_stem(&dir, "a/b:c?"), "a_b_c_");
        assert_eq!(unique_stem(&dir, "   "), "video");

        std::fs::write(dir.join("clip.mp3"), b"x").unwrap();
        assert_eq!(unique_stem(&dir, "clip"), "clip-1");
        std::fs::write(dir.join("partial.webm.part"), b"x").unwrap();
        assert_eq!(unique_stem(&dir, "partial"), "partial-1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleans_partial_files_for_stem() {
        let dir = temp_dir();
        std::fs::write(dir.join("clip.webm.part"), b"x").unwrap();
        std::fs::write(dir.join("clip.m4a"), b"x").unwrap();
        std::fs::write(dir.join("clip-1.mp3"), b"x").unwrap();

        cleanup_stem_files(&dir, "clip");

        assert!(!dir.join("clip.webm.part").exists());
        assert!(!dir.join("clip.m4a").exists());
        assert!(dir.join("clip-1.mp3").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
