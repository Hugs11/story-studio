use super::{XttsGenerateRequest, XttsSettings};
use crate::support::ffmpeg::now_millis;
use std::path::{Path, PathBuf};

// Remplace les caracteres typiquement problematiques pour un nom de fichier
// Windows par `_`. Pas un controle de securite : juste un nettoyage cosmetique
// du hint utilisateur. Le filtrage securite est fait par `safe_output_filename`.
fn slugify_filename_hint(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            c => c,
        })
        .collect()
}

// Valide qu'un nom est un fichier seul, sans separateur, sans `..`, sans
// caractere de controle. Aligne sur `safe_comfyui_output_filename`.
fn safe_output_filename(filename: &str) -> Result<String, String> {
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.chars().any(char::is_control)
    {
        return Err(format!("Nom de sortie XTTS invalide : {}", filename));
    }
    let file_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Nom de sortie XTTS invalide : {}", filename))?;
    if file_name != filename {
        return Err(format!("Nom de sortie XTTS invalide : {}", filename));
    }
    Ok(file_name.to_string())
}

pub(super) fn output_filename(filename_hint: Option<&str>) -> Result<String, String> {
    // Pre-validation du hint utilisateur AVANT slugify : on rejette les
    // segments de chemin et `..` ici, sinon `slugify_filename_hint` les
    // transformerait silencieusement (`../voice` → `__voice`) et le nom
    // final passerait `safe_output_filename`.
    if let Some(raw_hint) = filename_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        reject_unsafe_hint(raw_hint)?;
    }
    let base = filename_hint
        .map(slugify_filename_hint)
        .filter(|value| !value.trim_matches('_').is_empty())
        .unwrap_or_else(|| "tts".to_string());
    // safe_output_filename revalide le nom final assemble (base + timestamp + ext).
    safe_output_filename(&format!("{}--{}.wav", base.trim_matches('_'), now_millis()))
}

fn reject_unsafe_hint(raw_hint: &str) -> Result<(), String> {
    if raw_hint.contains('/')
        || raw_hint.contains('\\')
        || raw_hint.contains("..")
        || raw_hint.chars().any(char::is_control)
    {
        return Err(format!("Nom de sortie XTTS invalide : {}", raw_hint));
    }
    Ok(())
}

pub(super) fn generated_dir(request: &XttsGenerateRequest) -> Result<PathBuf, String> {
    if let Some(workspace_dir) = request
        .workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(workspace_dir).join("voix-generees"));
    }

    let save_path = request
        .save_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Definissez un emplacement de travail ou sauvegardez le projet avant de generer une voix."
                .to_string()
        })?;
    let project_path = PathBuf::from(save_path);
    let parent = project_path.parent().ok_or_else(|| {
        format!(
            "Impossible de determiner le dossier du projet depuis {}",
            save_path
        )
    })?;
    Ok(parent.join("voix-generees"))
}

pub(super) fn server_output_dir(settings: &XttsSettings) -> PathBuf {
    PathBuf::from(&settings.xtts_dir).join("output")
}

pub(super) fn reference_voice_exists(settings: &XttsSettings, voice: &str) -> bool {
    if voice.contains('/') || voice.contains('\\') || voice.trim().is_empty() {
        return false;
    }
    PathBuf::from(&settings.xtts_dir)
        .join("voices")
        .join(format!("{}.wav", voice))
        .is_file()
}
