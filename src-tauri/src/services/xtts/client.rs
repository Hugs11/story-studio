use super::XttsSettings;
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
pub(super) struct XttsHealthResponse {
    pub device: Option<String>,
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct XttsGenerateResponse {
    pub path: Option<String>,
    pub file: Option<String>,
    pub error: Option<String>,
}

pub(super) fn join_url(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

pub(super) fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Impossible de creer le client XTTS : {}", e))
}

pub(super) fn health_request(
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

pub(super) fn normalize_voice_list(values: impl IntoIterator<Item = String>) -> Vec<String> {
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

pub(super) fn fetch_string_list(
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
