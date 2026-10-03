//! Téléchargement de l'audio d'une vidéo : `yt-dlp -x --audio-format mp3` avec le
//! ffmpeg embarqué. Sortie bornée au cache privé de l'application (le frontend
//! la copie ensuite dans le projet/session, comme pour le podcast).

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use super::error::{classify_failure, YoutubeError, YoutubeErrorCode};
use super::info_cache;
use super::metadata::validate_youtube_url;
use super::process::run_command_with_timeout;
use super::tool::{pace_analysis, Ytdlp, SLEEP_REQUESTS};
use crate::support::ffmpeg::get_ffmpeg_path;
use crate::support::paths::path_for_frontend;

/// Garde-fou de taille par vidéo (cohérent avec le plafond média podcast).
const MAX_FILESIZE: &str = "300M";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub fn download_audio(
    home: &Path,
    output_dir: &Path,
    custom: Option<&str>,
    video_url: &str,
    file_name: &str,
    audio_language: Option<&str>,
    emit: &dyn Fn(&str),
) -> Result<String, YoutubeError> {
    validate_youtube_url(video_url)?;
    let ytdlp = Ytdlp::prepare(home, custom, emit)?;

    let ffmpeg = get_ffmpeg_path()?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "Dossier ffmpeg introuvable.".to_string())?;

    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("Création du dossier temporaire impossible : {}", e))?;
    let stem = unique_stem(output_dir, file_name);
    let dest = output_dir.join(format!("{}.mp3", stem));
    // yt-dlp remplace `%(ext)s` ; après extraction MP3 le fichier est `<stem>.mp3`.
    let out_template = output_dir.join(format!("{}.%(ext)s", stem));
    let format_selector = audio_format_selector(audio_language);

    // Une analyse récente évite de réinterroger l'API de lecture ; sinon, cette
    // vidéo est analysée ici et l'appel est espacé des précédents.
    let info_dir = info_cache::info_dir(output_dir);
    let video_id = info_cache::video_id_from_url(video_url);
    let cached_info = video_id
        .as_deref()
        .and_then(|id| info_cache::fresh(&info_dir, id));
    let source: Vec<OsString> = match &cached_info {
        Some(path) => vec!["--load-info-json".into(), path.into()],
        None => {
            pace_analysis();
            vec!["--".into(), video_url.into()]
        }
    };

    emit("Téléchargement de l'audio…");
    let mut cmd = ytdlp.command();
    cmd.args([
        "--no-playlist".as_ref(),
        "--sleep-requests".as_ref(),
        SLEEP_REQUESTS.as_ref(),
        "--max-filesize".as_ref(),
        MAX_FILESIZE.as_ref(),
        "-f".as_ref(),
        format_selector.as_ref(),
        "-x".as_ref(),
        "--audio-format".as_ref(),
        "mp3".as_ref(),
        "--ffmpeg-location".as_ref(),
        ffmpeg_dir.as_os_str(),
        "-o".as_ref(),
        out_template.as_os_str(),
    ]);
    cmd.args(&source);

    let result = run_command_with_timeout(cmd, DOWNLOAD_TIMEOUT, "Téléchargement YouTube");
    // Une analyse sert à un seul téléchargement : réussi, il est inutile de la
    // garder ; échoué, elle est suspecte.
    if let Some(id) = video_id.as_deref().filter(|_| cached_info.is_some()) {
        info_cache::remove(&info_dir, id);
    }
    let output = match result {
        Ok(output) => output,
        Err(err) => {
            cleanup_stem_files(output_dir, &stem);
            return Err(err.into());
        }
    };
    if !output.status.success() {
        cleanup_stem_files(output_dir, &stem);
        return Err(classify_failure(
            &String::from_utf8_lossy(&output.stderr),
            "Téléchargement impossible",
        ));
    }
    if !dest.is_file() || std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == 0 {
        cleanup_stem_files(output_dir, &stem);
        // yt-dlp sort sans erreur lorsqu'il saute un fichier trop volumineux.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let failure = classify_failure(&stdout, "Téléchargement impossible");
        if failure.code == YoutubeErrorCode::TooLarge {
            return Err(failure);
        }
        return Err("yt-dlp n'a produit aucun fichier audio.".to_string().into());
    }
    Ok(path_for_frontend(&dest))
}

/// Une langue explicitement choisie est préférée, puis le contrat historique
/// reprend la main si YouTube ne l'expose plus au moment du téléchargement.
/// La validation protège la syntaxe du sélecteur yt-dlp, même si la valeur vient
/// normalement des métadonnées produites par ce même outil.
fn audio_format_selector(language: Option<&str>) -> String {
    let language = language.map(str::trim).filter(|value| {
        !value.is_empty()
            && value.len() <= 35
            && value
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    });
    language
        .map(|value| format!("bestaudio[language={}]/bestaudio/best", value))
        .unwrap_or_else(|| "bestaudio/best".to_string())
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
    use super::{audio_format_selector, cleanup_stem_files, unique_stem};
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
    fn selects_requested_language_with_historical_fallback() {
        assert_eq!(
            audio_format_selector(Some("fr-CA")),
            "bestaudio[language=fr-CA]/bestaudio/best"
        );
        assert_eq!(audio_format_selector(None), "bestaudio/best");
        assert_eq!(audio_format_selector(Some("fr]/best")), "bestaudio/best");
        assert_eq!(audio_format_selector(Some("-fr")), "bestaudio/best");
        assert_eq!(audio_format_selector(Some("  ")), "bestaudio/best");
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
