use super::XttsSettings;
use crate::support::user_message;
use crate::support::user_message::codes;
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
        .map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::XTTS_HTTP_CLIENT_CREATE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de creer le client XTTS : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })
}

pub(super) fn health_request(
    settings: &XttsSettings,
    timeout: Duration,
    emit: &dyn Fn(&str),
) -> Result<XttsHealthResponse, String> {
    emit(&{
        let server_base_url = (settings.server_url.trim_end_matches('/')).to_string();
        let _msg_timeout_as_secs = (timeout.as_secs()).to_string();
        user_message::UserMessage::new(codes::XTTS_GET_HEALTH_TIMEOUT_S)
            .param(
                "serverUrl",
                user_message::transport_param(server_base_url.clone()),
            )
            .param(
                "timeoutSeconds",
                user_message::transport_param(_msg_timeout_as_secs.clone()),
            )
            .with_detail(format!(
                "GET {server_base_url}/health (timeout {_msg_timeout_as_secs}s)",
                _msg_timeout_as_secs = user_message::transport_detail(&_msg_timeout_as_secs),
                server_base_url = user_message::transport_detail(&server_base_url)
            ))
            .into_transport()
    });
    let client = http_client(timeout)?;
    let response = client
        .get(join_url(&settings.server_url, "/health"))
        .send()
        .map_err(|e| {
            let _msg_settings_server_url = (settings.server_url).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::XTTS_HEALTH_SERVER_UNAVAILABLE)
                .param(
                    "serverUrl",
                    user_message::transport_param(_msg_settings_server_url.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Serveur XTTS indisponible sur {_msg_settings_server_url} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_settings_server_url =
                        user_message::transport_detail(&_msg_settings_server_url)
                ))
                .into_transport()
        })?;

    if !response.status().is_success() {
        return Err({
            let _msg_response = (response.status()).to_string();
            user_message::UserMessage::new(codes::XTTS_HEALTH_HTTP_ERROR)
                .param(
                    "response",
                    user_message::transport_param(_msg_response.clone()),
                )
                .with_detail(format!(
                    "Le serveur XTTS a retourne HTTP {_msg_response}",
                    _msg_response = user_message::transport_detail(&_msg_response)
                ))
                .into_transport()
        });
    }

    response.json::<XttsHealthResponse>().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_INVALID_HEALTH_RESPONSE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Reponse /health invalide : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
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
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| {
        let _msg_path = (path).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_INVALID_RESPONSE)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Reponse {_msg_path} invalide : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    let list = value
        .get(field)
        .or_else(|| if value.is_array() { Some(&value) } else { None })
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            let _msg_path = (path).to_string();
            let _msg_field = (field).to_string();
            user_message::UserMessage::new(codes::XTTS_INVALID_RESPONSE_FIELD_MISSING)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .param("field", user_message::transport_param(_msg_field.clone()))
                .with_detail(format!(
                    "Reponse {_msg_path} invalide : champ '{_msg_field}' absent",
                    _msg_field = user_message::transport_detail(&_msg_field),
                    _msg_path = user_message::transport_detail(&_msg_path)
                ))
                .into_transport()
        })?;

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
        emit(&{
            let server_base_url = (settings.server_url.trim_end_matches('/')).to_string();
            let _msg_path = (path).to_string();
            user_message::UserMessage::new(codes::XTTS_GET_TIMEOUT_10S)
                .param(
                    "serverUrl",
                    user_message::transport_param(server_base_url.clone()),
                )
                .param("path", user_message::transport_param(_msg_path.clone()))
                .with_detail(format!(
                    "GET {server_base_url}{_msg_path} (timeout 10s)",
                    _msg_path = user_message::transport_detail(&_msg_path),
                    server_base_url = user_message::transport_detail(&server_base_url)
                ))
                .into_transport()
        });
        match client.get(join_url(&settings.server_url, path)).send() {
            Ok(response) if response.status().is_success() => {
                let body = response.text().map_err(|e| {
                    let _msg_path = (path).to_string();
                    let _msg_error = (e).to_string();
                    user_message::UserMessage::new(codes::XTTS_RESPONSE_READ_FAILED)
                        .param("path", user_message::transport_param(_msg_path.clone()))
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Impossible de lire {_msg_path} : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error),
                            _msg_path = user_message::transport_detail(&_msg_path)
                        ))
                        .into_transport()
                })?;
                return parse_string_list_response(&body, field, path);
            }
            Ok(response) => {
                last_error = Some({
                    let _msg_response = (response.status()).to_string();
                    let _msg_path = (path).to_string();
                    user_message::UserMessage::new(codes::XTTS_ENDPOINT_HTTP_ERROR)
                        .param(
                            "response",
                            user_message::transport_param(_msg_response.clone()),
                        )
                        .param("path", user_message::transport_param(_msg_path.clone()))
                        .with_detail(format!(
                            "HTTP {_msg_response} sur {_msg_path}",
                            _msg_path = user_message::transport_detail(&_msg_path),
                            _msg_response = user_message::transport_detail(&_msg_response)
                        ))
                        .into_transport()
                });
            }
            Err(err) => {
                last_error = Some(crate::support::user_message::compose_messages(
                    &[path.to_string(), err.to_string()],
                    " : ",
                ));
            }
        }
    }

    Err({
        let _msg_label = (label).to_string();
        let endpoint_error_message = (last_error.unwrap_or_else(|| {
            user_message::UserMessage::new(codes::XTTS_NO_ENDPOINT_TESTED)
                .with_detail("aucun endpoint teste".to_string())
                .into_transport()
        }))
        .to_string();
        user_message::UserMessage::new(codes::XTTS_ENDPOINT_FETCH_FAILED)
            .param("label", user_message::transport_param(_msg_label.clone()))
            .param(
                "error",
                user_message::transport_param(endpoint_error_message.clone()),
            )
            .with_detail(format!(
                "Impossible de recuperer {_msg_label} ({endpoint_error_message})",
                _msg_label = user_message::transport_detail(&_msg_label),
                endpoint_error_message = user_message::transport_detail(&endpoint_error_message)
            ))
            .into_transport()
    })
}
