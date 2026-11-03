use super::client::{
    fetch_string_list, http_client, join_url, normalize_voice_list, XttsGenerateResponse,
};
use super::lifecycle::ensure_server_with_log;
use super::output::{generated_dir, output_filename, reference_voice_exists, server_output_dir};
use super::{XttsGenerateRequest, XttsSettings, XttsStatus};
use crate::support::paths::path_for_frontend;
use crate::support::user_message;
use crate::support::user_message::codes;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

pub fn get_status_sync(settings: XttsSettings, emit: &dyn Fn(&str)) -> Result<XttsStatus, String> {
    emit(codes::XTTS_TEST_STARTED_TRANSPORT);
    let health = ensure_server_with_log(&settings, emit)?;
    let client = http_client(Duration::from_secs(10))?;

    let speakers = fetch_string_list(
        &client,
        &settings,
        &["/speakers", "/api/speakers"],
        "speakers",
        codes::XTTS_BUILT_IN_VOICES_TRANSPORT,
        emit,
    )
    .inspect_err(|err| {
        emit(&{
            let _msg_error = (err).to_string();
            user_message::UserMessage::new(codes::XTTS_BUILT_IN_VOICES_UNAVAILABLE)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Voix integrees indisponibles : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        });
    })
    .unwrap_or_default();

    let reference_voices = fetch_string_list(
        &client,
        &settings,
        &["/voices", "/api/voices"],
        "voices",
        codes::XTTS_REFERENCE_VOICES_TRANSPORT,
        emit,
    )
    .inspect_err(|err| {
        emit(&{
            let _msg_error = (err).to_string();
            user_message::UserMessage::new(codes::XTTS_REFERENCE_VOICES_UNAVAILABLE)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Voix de reference indisponibles : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        });
    })
    .unwrap_or_default();

    let voices = normalize_voice_list(speakers.iter().chain(reference_voices.iter()).cloned());
    emit(&{
        let _msg_voices = (voices.len()).to_string();
        let _msg_speakers = (speakers.len()).to_string();
        let _msg_reference_voices = (reference_voices.len()).to_string();
        user_message::UserMessage::new(
            codes::XTTS_VOICES_DETECTION_SUMMARY,
        )
            .param("voices", user_message::transport_param(_msg_voices.clone()))
            .param("speakers", user_message::transport_param(_msg_speakers.clone()))
            .param(
                "referenceVoices",
                user_message::transport_param(_msg_reference_voices.clone()),
            )
            .with_detail(format!(
                "{_msg_voices} voix XTTS detectee(s) ({_msg_speakers} integree(s), {_msg_reference_voices} reference(s)).",
                _msg_reference_voices = user_message::transport_detail(&_msg_reference_voices),
                _msg_speakers = user_message::transport_detail(&_msg_speakers),
                _msg_voices = user_message::transport_detail(&_msg_voices),
            ))
            .into_transport()
    });

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
        return Err(
            user_message::UserMessage::new(codes::XTTS_GENERATION_DISABLED_PREFERENCES)
                .with_detail("La generation XTTS est desactivee dans les Preferences.".to_string())
                .into_transport(),
        );
    }

    if request.text.trim().is_empty() {
        return Err(
            user_message::UserMessage::new(codes::XTTS_GENERATION_TEXT_EMPTY)
                .with_detail("Le texte a generer est vide.".to_string())
                .into_transport(),
        );
    }

    emit(codes::XTTS_GENERATION_REQUESTED_TRANSPORT);
    ensure_server_with_log(&settings, emit)?;

    let output_dir = generated_dir(&request)?;
    fs::create_dir_all(&output_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_VOICES_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de creer le dossier des voix generees : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

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
    emit(&{
        let server_base_url = (settings.server_url.trim_end_matches('/')).to_string();
        user_message::UserMessage::new(codes::XTTS_POST_TTS_TIMEOUT_300S)
            .param(
                "serverUrl",
                user_message::transport_param(server_base_url.clone()),
            )
            .with_detail(format!(
                "POST {server_base_url}/tts (timeout 300s)",
                server_base_url = user_message::transport_detail(&server_base_url)
            ))
            .into_transport()
    });
    let response = client
        .post(join_url(&settings.server_url, "/tts"))
        .json(&payload)
        .send()
        .map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::XTTS_GENERATION_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Echec de la generation XTTS : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
    let status = response.status();
    let body = response.text().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_TTS_RESPONSE_READ_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lire la reponse XTTS : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    if !status.is_success() {
        if let Ok(parsed) = serde_json::from_str::<XttsGenerateResponse>(&body) {
            if let Some(error) = parsed.error {
                return Err({
                    let _msg_error = (error).to_string();
                    user_message::UserMessage::new(codes::XTTS_TTS_SERVER_ERROR)
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "XTTS a retourne une erreur : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error)
                        ))
                        .into_transport()
                });
            }
        }
        return Err({
            let _msg_status = (status).to_string();
            let _msg_body = (body).to_string();
            user_message::UserMessage::new(codes::XTTS_TTS_HTTP_ERROR)
                .param("status", user_message::transport_param(_msg_status.clone()))
                .param("body", user_message::transport_param(_msg_body.clone()))
                .with_detail(format!(
                    "XTTS a retourne HTTP {_msg_status} : {_msg_body}",
                    _msg_body = user_message::transport_detail(&_msg_body),
                    _msg_status = user_message::transport_detail(&_msg_status)
                ))
                .into_transport()
        });
    }

    let parsed: XttsGenerateResponse = serde_json::from_str(&body).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_INVALID_TTS_RESPONSE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Reponse /tts invalide : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    if let Some(file) = parsed
        .file
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        let returned = PathBuf::from(file);
        let file_name = returned
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| {
                user_message::UserMessage::new(codes::XTTS_RESPONSE_INVALID_FILE_NAME)
                    .with_detail("XTTS a retourne un nom de fichier invalide.".to_string())
                    .into_transport()
            })?;
        if returned.components().count() != 1 || file_name != requested_output_file {
            return Err({
                let _msg_file = (file).to_string();
                user_message::UserMessage::new(codes::XTTS_RESPONSE_UNEXPECTED_FILE_NAME)
                    .param("file", user_message::transport_param(_msg_file.clone()))
                    .with_detail(format!(
                        "XTTS a retourne un nom de fichier inattendu : {_msg_file}",
                        _msg_file = user_message::transport_detail(&_msg_file)
                    ))
                    .into_transport()
            });
        }
    }

    if let Some(path) = parsed
        .path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        let returned = fs::canonicalize(path).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::XTTS_OUTPUT_PATH_MISSING)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "XTTS a retourne un chemin introuvable : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        let output_dir_canonical = fs::canonicalize(server_output_dir(&settings)).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::XTTS_OUTPUT_FOLDER_INACCESSIBLE)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Dossier XTTS output inaccessible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        let file_name = returned
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| {
                user_message::UserMessage::new(codes::XTTS_RESPONSE_INVALID_FILE_PATH)
                    .with_detail("XTTS a retourne un chemin de fichier invalide.".to_string())
                    .into_transport()
            })?;
        if !returned.starts_with(&output_dir_canonical) || file_name != requested_output_file {
            return Err({
                let _msg_path = (path).to_string();
                user_message::UserMessage::new(codes::XTTS_RESPONSE_EXTERNAL_UNEXPECTED_PATH)
                    .param("path", user_message::transport_param(_msg_path.clone()))
                    .with_detail(format!(
                        "XTTS a retourne un chemin externe ou inattendu : {_msg_path}",
                        _msg_path = user_message::transport_detail(&_msg_path),
                    ))
                    .into_transport()
            });
        }
    }

    let src = server_output_dir(&settings).join(&requested_output_file);
    if !src.exists() {
        return Err({
            let _msg_server_output_dir_settings =
                (server_output_dir(&settings).display()).to_string();
            let _msg_requested_output_file = (requested_output_file).to_string();
            user_message::UserMessage::new(
                codes::XTTS_OUTPUT_FILE_MISSING,
            )
                .param(
                    "serverOutputDirectory",
                    user_message::transport_param(_msg_server_output_dir_settings.clone()),
                )
                .param(
                    "requestedOutputFile",
                    user_message::transport_param(_msg_requested_output_file.clone()),
                )
                .with_detail(format!(
                    "Le fichier XTTS attendu est introuvable dans {_msg_server_output_dir_settings} : {_msg_requested_output_file}",
                    _msg_requested_output_file = user_message::transport_detail(&_msg_requested_output_file),
                    _msg_server_output_dir_settings = user_message::transport_detail(&_msg_server_output_dir_settings),
                ))
                .into_transport()
        });
    }

    let dest = output_dir.join(
        src.file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| requested_output_file.clone()),
    );

    fs::copy(&src, &dest).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_AUDIO_PROJECT_COPY_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de copier l'audio XTTS vers le projet : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    emit(&{
        let _msg_dest = (dest.display()).to_string();
        user_message::UserMessage::new(codes::XTTS_AUDIO_COPY_COMPLETED)
            .param("dest", user_message::transport_param(_msg_dest.clone()))
            .with_detail(format!(
                "Audio XTTS copie vers {_msg_dest}",
                _msg_dest = user_message::transport_detail(&_msg_dest)
            ))
            .into_transport()
    });

    Ok(path_for_frontend(&dest))
}
