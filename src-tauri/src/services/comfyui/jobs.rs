use super::*;

pub(super) fn upload_reference_image_sync(
    server_url: &str,
    image_path: &str,
) -> Result<String, String> {
    validate_reference_image_extension(image_path)?;
    let client = http_client(Duration::from_secs(30))?;
    let file_bytes = fs::read(image_path)
        .map_err(|e| format!("Impossible de lire l'image de référence : {}", e))?;
    let file_name = Path::new(image_path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "reference.png".to_string());

    let part = reqwest::blocking::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str(image_mime_from_path(image_path))
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new().part("image", part);

    let response = client
        .post(join_url(server_url, "/upload/image"))
        .multipart(form)
        .send()
        .map_err(|e| format!("Impossible d'uploader l'image : {}", e))?;

    if !response.status().is_success() {
        return Err(format!("ComfyUI upload HTTP {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Réponse upload invalide : {}", e))?;

    json["name"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "ComfyUI n'a pas retourné le nom du fichier uploadé".to_string())
}

pub(super) fn patch_workflow(
    manifest: &WorkflowManifest,
    workflow_dir: &Path,
    request: &SdGenerateRequest,
    uploaded_filename: Option<&str>,
) -> Result<serde_json::Value, String> {
    let api_path = workflow_dir.join(&manifest.api_file);
    let json_str = fs::read_to_string(&api_path)
        .map_err(|e| format!("Workflow JSON introuvable ({}) : {}", api_path.display(), e))?;
    let mut prompt: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("Workflow JSON invalide : {}", e))?;

    for (slot_name, slot) in &manifest.slots {
        let value: Option<serde_json::Value> = match slot_name.as_str() {
            "positive_prompt" => Some(serde_json::Value::String(request.positive_prompt.clone())),
            "negative_prompt" => request
                .negative_prompt
                .as_ref()
                .map(|v| serde_json::Value::String(v.clone())),
            "seed" => Some(serde_json::json!(request.seed)),
            "steps" => Some(serde_json::json!(request.steps)),
            "cfg" => Some(serde_json::json!(request.cfg)),
            "lora_strength_model" | "lora_strength_clip" => {
                Some(serde_json::json!(request.lora_strength))
            }
            "reference_image" => {
                uploaded_filename.map(|f| serde_json::Value::String(f.to_string()))
            }
            _ => None,
        };
        if let Some(val) = value {
            prompt[&slot.node_id]["inputs"][&slot.input_key] = val.clone();
            for extra_key in &slot.extra_input_keys {
                prompt[&slot.node_id]["inputs"][extra_key] = val.clone();
            }
        }
    }
    Ok(prompt)
}

pub fn submit_job_sync(
    resource_dir: PathBuf,
    app_data_dir: PathBuf,
    settings: ComfyUiSettings,
    request: SdGenerateRequest,
) -> Result<String, String> {
    ensure_comfyui_sync(&settings)?;
    let location = find_workflow_by_id(&resource_dir, &app_data_dir, &request.workflow_id)?;

    let uploaded_filename = match &request.reference_image_path {
        Some(path) if !path.is_empty() => {
            Some(upload_reference_image_sync(&settings.server_url, path)?)
        }
        _ => None,
    };

    let prompt = patch_workflow(
        &location.manifest,
        &location.dir,
        &request,
        uploaded_filename.as_deref(),
    )?;

    let client_id = request
        .client_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let client = http_client(Duration::from_secs(30))?;
    let payload = serde_json::json!({ "prompt": prompt, "client_id": client_id });
    let response = client
        .post(join_url(&settings.server_url, "/prompt"))
        .json(&payload)
        .send()
        .map_err(|e| format!("Impossible de soumettre le workflow : {}", e))?;

    if !response.status().is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!("ComfyUI /prompt erreur : {}", body));
    }

    let json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Réponse /prompt invalide : {}", e))?;

    json["prompt_id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "ComfyUI n'a pas retourné de prompt_id".to_string())
}

pub fn poll_job_sync(settings: ComfyUiSettings, prompt_id: String) -> Result<SdPollResult, String> {
    require_local_url(&settings.server_url, "ComfyUI")?;
    let client = http_client(Duration::from_secs(10))?;
    let progress = fetch_progress_sync(&client, &settings.server_url, &prompt_id);
    let url = join_url(&settings.server_url, &format!("/history/{}", prompt_id));
    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Impossible de vérifier le statut ComfyUI : {}", e))?;

    if !response.status().is_success() {
        return Err(format!("ComfyUI /history HTTP {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Réponse /history invalide : {}", e))?;

    let entry = match json.get(&prompt_id) {
        None => {
            return Ok(SdPollResult {
                status: "pending".to_string(),
                output_files: vec![],
                error: None,
                progress: progress.as_ref().map(|(value, _)| *value),
                progress_label: progress.as_ref().map(|(_, label)| label.clone()),
            })
        }
        Some(e) => e,
    };

    let completed = entry["status"]["completed"].as_bool().unwrap_or(false);
    if !completed {
        return Ok(SdPollResult {
            status: "running".to_string(),
            output_files: vec![],
            error: None,
            progress: progress.as_ref().map(|(value, _)| *value),
            progress_label: progress.as_ref().map(|(_, label)| label.clone()),
        });
    }

    let status_str = entry["status"]["status_str"].as_str().unwrap_or("unknown");
    if status_str == "error" {
        let error_msg = entry["status"]["messages"]
            .as_array()
            .and_then(|msgs| msgs.last())
            .and_then(|m| m.as_array())
            .and_then(|m| m.get(1))
            .and_then(|m| m.as_str())
            .unwrap_or("Erreur inconnue ComfyUI")
            .to_string();
        return Ok(SdPollResult {
            status: "error".to_string(),
            output_files: vec![],
            error: Some(error_msg),
            progress: None,
            progress_label: None,
        });
    }

    let mut output_files = vec![];
    if let Some(outputs) = entry["outputs"].as_object() {
        for (_node_id, node_output) in outputs {
            if let Some(images) = node_output["images"].as_array() {
                for img in images {
                    if img["type"].as_str() == Some("output") {
                        if let (Some(filename), Some(subfolder)) =
                            (img["filename"].as_str(), img["subfolder"].as_str())
                        {
                            output_files.push(OutputFile {
                                filename: filename.to_string(),
                                subfolder: subfolder.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(SdPollResult {
        status: "done".to_string(),
        output_files,
        error: None,
        progress: Some(1.0),
        progress_label: Some("100%".to_string()),
    })
}

pub fn watch_progress_sync(
    settings: ComfyUiSettings,
    client_id: String,
    job_id: String,
    emit: &dyn Fn(ComfyProgressEvent),
) -> Result<(), String> {
    require_local_url(&settings.server_url, "ComfyUI")?;
    let url = reqwest::Url::parse(&settings.server_url)
        .map_err(|e| format!("URL ComfyUI invalide : {}", e))?;
    if url.scheme() != "http" {
        return Err("Le suivi de progression ComfyUI supporte seulement http local.".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL ComfyUI sans host.".to_string())?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let path = ws_path_for_client(&url, &client_id);
    let host_header = format!("{}:{}", host, port);

    let mut stream = TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("Connexion WebSocket ComfyUI impossible : {}", e))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(900)))
        .map_err(|e| format!("Timeout WebSocket ComfyUI impossible : {}", e))?;
    let key = base64_encode(uuid::Uuid::new_v4().as_bytes());
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        path, host_header, key
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("Handshake WebSocket ComfyUI impossible : {}", e))?;

    let mut headers = Vec::new();
    let mut byte = [0u8; 1];
    while !headers.ends_with(b"\r\n\r\n") {
        stream
            .read_exact(&mut byte)
            .map_err(|e| format!("Réponse WebSocket ComfyUI illisible : {}", e))?;
        headers.push(byte[0]);
        if headers.len() > 8192 {
            return Err("Réponse WebSocket ComfyUI trop volumineuse.".to_string());
        }
    }
    let headers = String::from_utf8_lossy(&headers);
    if !headers.starts_with("HTTP/1.1 101") && !headers.starts_with("HTTP/1.0 101") {
        return Err(format!(
            "Handshake WebSocket ComfyUI refusé : {}",
            headers.lines().next().unwrap_or("réponse inconnue")
        ));
    }

    while let Some(text) = read_ws_frame(&mut stream)? {
        if text.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        match message.get("type").and_then(|value| value.as_str()) {
            Some("progress") => {
                let data = &message["data"];
                let value = data.get("value").and_then(|value| value.as_f64());
                let max = data.get("max").and_then(|value| value.as_f64());
                if let (Some(value), Some(max)) = (value, max) {
                    if value.is_finite() && max.is_finite() && max > 0.0 {
                        emit(ComfyProgressEvent {
                            job_id: job_id.clone(),
                            progress: Some((value / max).clamp(0.0, 1.0)),
                            progress_label: Some(format!(
                                "{}/{}",
                                value.round() as u64,
                                max.round() as u64
                            )),
                            error: None,
                        });
                    }
                }
            }
            Some("executing") => {
                let data = &message["data"];
                if data.get("node").is_some_and(|value| value.is_null()) {
                    break;
                }
            }
            _ => {}
        }
    }

    Ok(())
}

pub(super) fn fetch_progress_sync(
    client: &reqwest::blocking::Client,
    server_url: &str,
    prompt_id: &str,
) -> Option<(f64, String)> {
    let response = client.get(join_url(server_url, "/progress")).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: serde_json::Value = response.json().ok()?;
    if let Some(current_prompt_id) = json.get("prompt_id").and_then(|value| value.as_str()) {
        if current_prompt_id != prompt_id {
            return None;
        }
    }

    let value = json.get("value").and_then(|value| value.as_f64())?;
    let max = json.get("max").and_then(|value| value.as_f64())?;
    if !value.is_finite() || !max.is_finite() || max <= 0.0 {
        return None;
    }

    let ratio = (value / max).clamp(0.0, 1.0);
    Some((
        ratio,
        format!("{}/{}", value.round() as u64, max.round() as u64),
    ))
}

pub fn download_output_sync(
    settings: ComfyUiSettings,
    filename: String,
    subfolder: String,
    prompt_id: String,
    workspace_dir: Option<String>,
) -> Result<String, String> {
    require_local_url(&settings.server_url, "ComfyUI")?;
    let client = http_client(Duration::from_secs(60))?;
    let safe_filename = safe_comfyui_output_filename(&filename)?;

    let base = join_url(&settings.server_url, "/view");
    let mut url =
        reqwest::Url::parse(&base).map_err(|e| format!("URL ComfyUI invalide : {}", e))?;
    url.query_pairs_mut()
        .append_pair("filename", &filename)
        .append_pair("subfolder", &subfolder)
        .append_pair("type", "output");

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Impossible de télécharger l'image ComfyUI : {}", e))?;

    if !response.status().is_success() {
        return Err(format!("ComfyUI /view HTTP {}", response.status()));
    }

    let dest_dir = workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| PathBuf::from(value).join("images-generees"))
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join(TEMP_IMAGES_DIR)
                .join(format!("sd_{}", &prompt_id[..prompt_id.len().min(8)]))
        });
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Impossible de créer le dossier de destination : {}", e))?;

    let dest_path = dest_dir.join(safe_filename);
    let bytes = response
        .bytes()
        .map_err(|e| format!("Impossible de lire les bytes de l'image : {}", e))?;
    fs::write(&dest_path, &bytes).map_err(|e| format!("Impossible d'écrire l'image : {}", e))?;

    Ok(dest_path.to_string_lossy().to_string())
}

pub fn resolve_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir inaccessible : {}", e))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir inaccessible : {}", e))?;
    Ok((resource_dir, app_data_dir))
}
