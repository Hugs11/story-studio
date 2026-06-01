use super::client::{
    fetch_string_list, http_client, join_url, normalize_voice_list, XttsGenerateResponse,
};
use super::lifecycle::ensure_server_with_log;
use super::output::{generated_dir, output_filename, reference_voice_exists, server_output_dir};
use super::{XttsGenerateRequest, XttsSettings, XttsStatus};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

pub fn get_status_sync(settings: XttsSettings, emit: &dyn Fn(&str)) -> Result<XttsStatus, String> {
    emit("Test XTTS demarre.");
    let health = ensure_server_with_log(&settings, emit)?;
    let client = http_client(Duration::from_secs(10))?;

    let speakers = fetch_string_list(
        &client,
        &settings,
        &["/speakers", "/api/speakers"],
        "speakers",
        "les voix integrees XTTS",
        emit,
    )
    .map_err(|err| {
        emit(&format!("Voix integrees indisponibles : {}", err));
        err
    })
    .unwrap_or_default();

    let reference_voices = fetch_string_list(
        &client,
        &settings,
        &["/voices", "/api/voices"],
        "voices",
        "les voix de reference XTTS",
        emit,
    )
    .map_err(|err| {
        emit(&format!("Voix de reference indisponibles : {}", err));
        err
    })
    .unwrap_or_default();

    let voices = normalize_voice_list(speakers.iter().chain(reference_voices.iter()).cloned());
    emit(&format!(
        "{} voix XTTS detectee(s) ({} integree(s), {} reference(s)).",
        voices.len(),
        speakers.len(),
        reference_voices.len()
    ));

    Ok(XttsStatus {
        device: health.device,
        model: health.model,
        voices,
    })
}

pub fn generate_audio_sync(
    settings: XttsSettings,
    request: XttsGenerateRequest,
    emit: &dyn Fn(&str),
) -> Result<String, String> {
    if !settings.enabled {
        return Err("La generation XTTS est desactivee dans les Preferences.".to_string());
    }

    if request.text.trim().is_empty() {
        return Err("Le texte a generer est vide.".to_string());
    }

    emit("Generation XTTS demandee.");
    ensure_server_with_log(&settings, emit)?;

    let output_dir = generated_dir(&request)?;
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Impossible de creer le dossier des voix generees : {}", e))?;

    let language = request
        .language
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.language.clone());
    let requested_output_file = output_filename(request.filename_hint.as_deref())?;
    let mut payload = serde_json::json!({
        "text": request.text,
        "language": language,
        "output_file": requested_output_file.clone(),
    });

    if let Some(speaker) = request
        .speaker
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        payload["speaker"] = serde_json::Value::String(speaker.clone());
    }
    if let Some(voice) = request
        .voice
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        if reference_voice_exists(&settings, voice) {
            payload["voice"] = serde_json::Value::String(voice.clone());
        } else if request
            .speaker
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            payload["speaker"] = serde_json::Value::String(voice.clone());
        }
    }

    let client = http_client(Duration::from_secs(300))?;
    emit(&format!(
        "POST {}/tts (timeout 300s)",
        settings.server_url.trim_end_matches('/')
    ));
    let response = client
        .post(join_url(&settings.server_url, "/tts"))
        .json(&payload)
        .send()
        .map_err(|e| format!("Echec de la generation XTTS : {}", e))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Impossible de lire la reponse XTTS : {}", e))?;

    if !status.is_success() {
        if let Ok(parsed) = serde_json::from_str::<XttsGenerateResponse>(&body) {
            if let Some(error) = parsed.error {
                return Err(format!("XTTS a retourne une erreur : {}", error));
            }
        }
        return Err(format!("XTTS a retourne HTTP {} : {}", status, body));
    }

    let parsed: XttsGenerateResponse =
        serde_json::from_str(&body).map_err(|e| format!("Reponse /tts invalide : {}", e))?;

    if let Some(file) = parsed
        .file
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        let returned = PathBuf::from(file);
        let file_name = returned
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| "XTTS a retourne un nom de fichier invalide.".to_string())?;
        if returned.components().count() != 1 || file_name != requested_output_file {
            return Err(format!(
                "XTTS a retourne un nom de fichier inattendu : {}",
                file
            ));
        }
    }

    if let Some(path) = parsed
        .path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        let returned = fs::canonicalize(path)
            .map_err(|e| format!("XTTS a retourne un chemin introuvable : {}", e))?;
        let output_dir_canonical = fs::canonicalize(server_output_dir(&settings))
            .map_err(|e| format!("Dossier XTTS output inaccessible : {}", e))?;
        let file_name = returned
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| "XTTS a retourne un chemin de fichier invalide.".to_string())?;
        if !returned.starts_with(&output_dir_canonical) || file_name != requested_output_file {
            return Err(format!(
                "XTTS a retourne un chemin externe ou inattendu : {}",
                path
            ));
        }
    }

    let src = server_output_dir(&settings).join(&requested_output_file);
    if !src.exists() {
        return Err(format!(
            "Le fichier XTTS attendu est introuvable dans {} : {}",
            server_output_dir(&settings).display(),
            requested_output_file
        ));
    }

    let dest = output_dir.join(
        src.file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| requested_output_file.clone()),
    );

    fs::copy(&src, &dest)
        .map_err(|e| format!("Impossible de copier l'audio XTTS vers le projet : {}", e))?;
    emit(&format!("Audio XTTS copie vers {}", dest.display()));

    Ok(dest.to_string_lossy().to_string())
}
