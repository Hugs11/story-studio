use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::super::{project_dir_from_save_path, validate_existing_file_path};
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};
use crate::support::paths::path_for_frontend;
pub(crate) const AUDIO_ASSEMBLY_EXTENSIONS: &[&str] =
    &["mp3", "ogg", "wav", "m4a", "webm", "flac", "aac"];

pub(crate) fn validate_audio_assembly_filename(output_file_name: &str) -> Result<String, String> {
    let trimmed = output_file_name.trim();
    let path = Path::new(trimmed);
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom du fichier final invalide.".to_string())?;
    if file_name != trimmed || file_name.is_empty() || file_name == "." || file_name == ".." {
        return Err("Nom du fichier final invalide.".to_string());
    }
    if file_name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("Nom du fichier final contient des caractères interdits.".to_string());
    }

    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Nom du fichier final invalide.".to_string())?;
    Ok(format!("{}.mp3", stem))
}

pub(crate) fn unique_audio_assembly_path(
    target_dir: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("audio_assemble");
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("mp3");

    let first = target_dir.join(file_name);
    if !first.exists() {
        return Ok(first);
    }

    let stamp = now_millis();
    for index in 0..1000 {
        let suffix = if index == 0 {
            format!("--{}", stamp)
        } else {
            format!("--{}-{}", stamp, index)
        };
        let candidate = target_dir.join(format!("{}{}.{}", stem, suffix, ext));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Impossible de trouver un nom de fichier disponible.".to_string())
}

pub(crate) fn validate_audio_assembly_input(path: &str) -> Result<PathBuf, String> {
    let input = validate_existing_file_path(path, "Fichier audio")?;
    let ext = input
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !AUDIO_ASSEMBLY_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Format audio non pris en charge pour l'assemblage : {}",
            input.display()
        ));
    }
    Ok(input)
}

pub(crate) fn compact_ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "Erreur FFmpeg inconnue.".to_string();
    }
    let start = lines.len().saturating_sub(10);
    lines[start..].join("\n")
}

pub(crate) fn run_ffmpeg_normalize_audio(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-ar")
        .arg("44100")
        .arg("-ac")
        .arg("2")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Préparation audio échouée :\n{}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

pub(crate) fn run_ffmpeg_make_silence(
    ffmpeg: &Path,
    duration_sec: f64,
    output: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("anullsrc=r=44100:cl=stereo")
        .arg("-t")
        .arg(format!("{:.3}", duration_sec))
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Création du silence échouée :\n{}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

pub(crate) fn concat_list_line(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    format!("file '{}'\n", escaped)
}

pub(crate) fn run_ffmpeg_concat_audio(
    ffmpeg: &Path,
    list_path: &Path,
    output: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(list_path)
        .arg("-vn")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-q:a")
        .arg("4")
        .arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Assemblage audio échoué :\n{}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

pub fn concat_audio_files(
    save_path: &str,
    input_paths: &[String],
    output_file_name: &str,
    silence_between_sec: f64,
    workspace_dir: Option<&str>,
) -> Result<String, String> {
    let has_workspace = workspace_dir.map(|s| !s.trim().is_empty()).unwrap_or(false);
    if save_path.trim().is_empty() && !has_workspace {
        return Err("Enregistrez le projet avant de créer un fichier assemblé.".to_string());
    }
    if input_paths.len() < 2 {
        return Err("Sélectionnez au moins deux audios à assembler.".to_string());
    }
    if !silence_between_sec.is_finite() || !(0.0..=30.0).contains(&silence_between_sec) {
        return Err("La durée du silence doit être comprise entre 0 et 30 secondes.".to_string());
    }

    let inputs: Vec<PathBuf> = input_paths
        .iter()
        .map(|path| validate_audio_assembly_input(path))
        .collect::<Result<Vec<_>, _>>()?;
    let output_name = validate_audio_assembly_filename(output_file_name)?;
    let target_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
        Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
        None => project_dir_from_save_path(save_path)?.join("fichiers-importes"),
    };
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
    let target_dir = fs::canonicalize(&target_dir)
        .map_err(|e| format!("Dossier fichiers-importes inaccessible : {}", e))?;
    let output_path = unique_audio_assembly_path(&target_dir, &output_name)?;

    let ffmpeg = get_ffmpeg_path()?;
    let temp_dir = std::env::temp_dir().join(format!(
        "story_studio_audio_assembly_{}_{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Impossible de créer le dossier temporaire audio : {}", e))?;

    let result = (|| {
        let silence_enabled = silence_between_sec > 0.001;
        let mut concat_entries: Vec<PathBuf> = Vec::new();
        for (index, input) in inputs.iter().enumerate() {
            let wav_path = temp_dir.join(format!("part_{:03}.wav", index));
            run_ffmpeg_normalize_audio(&ffmpeg, input, &wav_path)?;
            concat_entries.push(wav_path);

            if silence_enabled && index + 1 < inputs.len() {
                let silence_path = temp_dir.join(format!("silence_{:03}.wav", index));
                run_ffmpeg_make_silence(&ffmpeg, silence_between_sec, &silence_path)?;
                concat_entries.push(silence_path);
            }
        }

        let list_path = temp_dir.join("concat.txt");
        let list_content: String = concat_entries
            .iter()
            .map(|path| concat_list_line(path))
            .collect();
        fs::write(&list_path, list_content)
            .map_err(|e| format!("Impossible de préparer la liste d'assemblage : {}", e))?;

        run_ffmpeg_concat_audio(&ffmpeg, &list_path, &output_path)?;
        Ok(path_for_frontend(&output_path.to_string_lossy()))
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    if result.is_err() {
        let _ = fs::remove_file(&output_path);
    }
    result
}
