use crate::support::ffmpeg::now_millis;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── Structures ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct XttsSettings {
    pub enabled: bool,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "xttsDir")]
    pub xtts_dir: String,
    #[serde(rename = "autoStart")]
    pub auto_start: bool,
    #[serde(rename = "forceCpu", default)]
    pub force_cpu: bool,
    pub language: String,
}

#[derive(Deserialize)]
pub struct XttsGenerateRequest {
    pub text: String,
    pub language: Option<String>,
    pub speaker: Option<String>,
    pub voice: Option<String>,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
    #[serde(rename = "workspaceDir", default)]
    pub workspace_dir: Option<String>,
    #[serde(rename = "filenameHint")]
    pub filename_hint: Option<String>,
}

#[derive(Deserialize)]
struct XttsHealthResponse {
    device: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct XttsGenerateResponse {
    path: Option<String>,
    file: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct XttsStatus {
    pub device: Option<String>,
    pub model: Option<String>,
    pub voices: Vec<String>,
}

// ── Utilitaires internes ─────────────────────────────────────────────────────

use crate::support::network::require_local_url;

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            c => c,
        })
        .collect()
}

fn join_url(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Impossible de creer le client XTTS : {}", e))
}

fn health_request(
    settings: &XttsSettings,
    timeout: Duration,
    emit: &dyn Fn(&str),
) -> Result<XttsHealthResponse, String> {
    emit(&format!(
        "GET {}/health (timeout {}s)",
        settings.server_url.trim_end_matches('/'),
        timeout.as_secs()
    ));
    let client = http_client(timeout)?;
    let response = client
        .get(join_url(&settings.server_url, "/health"))
        .send()
        .map_err(|e| {
            format!(
                "Serveur XTTS indisponible sur {} : {}",
                settings.server_url, e
            )
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "Le serveur XTTS a retourne HTTP {}",
            response.status()
        ));
    }

    response
        .json::<XttsHealthResponse>()
        .map_err(|e| format!("Reponse /health invalide : {}", e))
}

fn start_server(settings: &XttsSettings) -> Result<(), String> {
    let xtts_dir = PathBuf::from(&settings.xtts_dir);
    let python_path = xtts_dir.join("venv").join("Scripts").join("python.exe");
    let server_path = xtts_dir.join("server.py");
    let models_dir = xtts_dir.join("models");

    if !python_path.exists() {
        return Err(format!(
            "Python XTTS introuvable : {}",
            python_path.display()
        ));
    }
    if !server_path.exists() {
        return Err(format!("server.py introuvable dans {}", xtts_dir.display()));
    }

    let mut cmd = Command::new(&python_path);
    cmd.arg("server.py");
    if settings.force_cpu {
        cmd.arg("--cpu");
    }
    cmd.current_dir(&xtts_dir)
        .env("TTS_HOME", &models_dir)
        .env("COQUI_TTS_HOME", &models_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Impossible de demarrer XTTS : {}", e))
}

fn ensure_server_with_log(
    settings: &XttsSettings,
    emit: &dyn Fn(&str),
) -> Result<XttsHealthResponse, String> {
    emit(&format!("Validation URL XTTS : {}", settings.server_url));
    require_local_url(&settings.server_url, "XTTS")?;
    match health_request(settings, Duration::from_secs(3), emit) {
        Ok(health) => {
            emit("XTTS repond deja sur /health.");
            return Ok(health);
        }
        Err(err) => {
            emit(&format!("XTTS ne repond pas encore : {}", err));
        }
    }

    if !settings.auto_start {
        emit("Demarrage automatique XTTS desactive.");
        return Err(format!(
            "Serveur XTTS indisponible sur {}. Lance XTTS ou active le demarrage automatique dans les Preferences.",
            settings.server_url
        ));
    }

    emit(&format!(
        "Demarrage XTTS depuis {}{}.",
        settings.xtts_dir,
        if settings.force_cpu {
            " avec --cpu"
        } else {
            ""
        }
    ));
    start_server(settings)?;
    emit("Processus XTTS lance, attente de /health...");

    let mut last_error = String::from("XTTS demarre mais ne repond pas encore.");
    for attempt in 1..=45 {
        std::thread::sleep(Duration::from_secs(1));
        match health_request(settings, Duration::from_secs(3), emit) {
            Ok(health) => {
                emit(&format!("XTTS pret apres {} tentative(s).", attempt));
                return Ok(health);
            }
            Err(err) => {
                last_error = err;
                if attempt == 1 || attempt % 5 == 0 {
                    emit(&format!(
                        "XTTS pas encore pret ({}/45) : {}",
                        attempt, last_error
                    ));
                }
            }
        }
    }

    Err(format!(
        "XTTS ne repond toujours pas apres demarrage automatique. {}",
        last_error
    ))
}

fn generated_dir(request: &XttsGenerateRequest) -> Result<PathBuf, String> {
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

fn server_output_dir(settings: &XttsSettings) -> PathBuf {
    PathBuf::from(&settings.xtts_dir).join("output")
}

fn reference_voice_exists(settings: &XttsSettings, voice: &str) -> bool {
    if voice.contains('/') || voice.contains('\\') || voice.trim().is_empty() {
        return false;
    }
    PathBuf::from(&settings.xtts_dir)
        .join("voices")
        .join(format!("{}.wav", voice))
        .is_file()
}

fn output_filename(filename_hint: Option<&str>) -> String {
    let base = filename_hint
        .map(sanitize_filename)
        .filter(|value| !value.trim_matches('_').is_empty())
        .unwrap_or_else(|| "tts".to_string());
    format!("{}--{}.wav", base.trim_matches('_'), now_millis())
}

fn normalize_voice_list(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut voices: Vec<String> = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    voices.sort_by_key(|value| value.to_lowercase());
    voices.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    voices
}

fn parse_string_list_response(body: &str, field: &str, path: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Reponse {} invalide : {}", path, e))?;
    let list = value
        .get(field)
        .or_else(|| if value.is_array() { Some(&value) } else { None })
        .and_then(|value| value.as_array())
        .ok_or_else(|| format!("Reponse {} invalide : champ '{}' absent", path, field))?;

    Ok(normalize_voice_list(list.iter().filter_map(|value| {
        value.as_str().map(|value| value.to_string())
    })))
}

fn fetch_string_list(
    client: &reqwest::blocking::Client,
    settings: &XttsSettings,
    paths: &[&str],
    field: &str,
    label: &str,
    emit: &dyn Fn(&str),
) -> Result<Vec<String>, String> {
    let mut last_error = None;
    for path in paths {
        emit(&format!(
            "GET {}{} (timeout 10s)",
            settings.server_url.trim_end_matches('/'),
            path
        ));
        match client.get(join_url(&settings.server_url, path)).send() {
            Ok(response) if response.status().is_success() => {
                let body = response
                    .text()
                    .map_err(|e| format!("Impossible de lire {} : {}", path, e))?;
                return parse_string_list_response(&body, field, path);
            }
            Ok(response) => {
                last_error = Some(format!("HTTP {} sur {}", response.status(), path));
            }
            Err(err) => {
                last_error = Some(format!("{} : {}", path, err));
            }
        }
    }

    Err(format!(
        "Impossible de recuperer {} ({})",
        label,
        last_error.unwrap_or_else(|| "aucun endpoint teste".to_string())
    ))
}

// ── Logique métier ───────────────────────────────────────────────────────────

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
    let requested_output_file = output_filename(request.filename_hint.as_deref());
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
            .unwrap_or_else(|| output_filename(request.filename_hint.as_deref())),
    );

    fs::copy(&src, &dest)
        .map_err(|e| format!("Impossible de copier l'audio XTTS vers le projet : {}", e))?;
    emit(&format!("Audio XTTS copie vers {}", dest.display()));

    Ok(dest.to_string_lossy().to_string())
}
