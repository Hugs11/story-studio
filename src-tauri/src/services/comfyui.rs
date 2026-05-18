use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::Manager;

// ── Structures publiques ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ComfyUiSettings {
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "autoStart", default)]
    pub auto_start: bool,
    #[serde(rename = "batPath", default)]
    pub bat_path: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WorkflowSlot {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "inputKey")]
    pub input_key: String,
    // Clés supplémentaires sur le même nœud qui reçoivent la même valeur
    #[serde(rename = "extraInputKeys", default)]
    pub extra_input_keys: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WorkflowManifest {
    pub id: String,
    #[serde(rename = "apiFile")]
    pub api_file: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "requiresReferenceImage", default)]
    pub requires_reference_image: bool,
    #[serde(rename = "isCustom", default)]
    pub is_custom: bool,
    pub slots: HashMap<String, WorkflowSlot>,
    // Valeurs lues depuis l'api.json au chargement — non stockées dans le config
    #[serde(rename = "defaultValues", default)]
    pub default_values: HashMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SdGenerateRequest {
    #[serde(rename = "workflowId")]
    pub workflow_id: String,
    #[serde(rename = "positivePrompt")]
    pub positive_prompt: String,
    #[serde(rename = "negativePrompt")]
    pub negative_prompt: Option<String>,
    pub seed: i64,
    pub steps: u32,
    pub cfg: f64,
    #[serde(rename = "loraStrength")]
    pub lora_strength: f64,
    #[serde(rename = "referenceImagePath")]
    pub reference_image_path: Option<String>,
    #[serde(rename = "clientId")]
    pub client_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct OutputFile {
    pub filename: String,
    pub subfolder: String,
}

#[derive(Debug, Serialize)]
pub struct SdPollResult {
    pub status: String,
    #[serde(rename = "outputFiles")]
    pub output_files: Vec<OutputFile>,
    pub error: Option<String>,
    pub progress: Option<f64>,
    #[serde(rename = "progressLabel")]
    pub progress_label: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ComfyProgressEvent {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub progress: Option<f64>,
    #[serde(rename = "progressLabel")]
    pub progress_label: Option<String>,
    pub error: Option<String>,
}

// ── Utilitaires internes ─────────────────────────────────────────────────────

use crate::support::network::require_local_url;
use crate::support::temp::TEMP_IMAGES_DIR;

fn validate_reference_image_extension(path: &str) -> Result<(), String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp")
    ) {
        return Err(format!(
            "Extension d'image de référence non autorisée (attendu : png, jpg, jpeg, webp, bmp) : {}",
            path
        ));
    }
    Ok(())
}

fn image_mime_from_path(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    }
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
        .map_err(|e| format!("Impossible de créer le client HTTP : {}", e))
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn read_ws_frame(stream: &mut TcpStream) -> Result<Option<String>, String> {
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .map_err(|e| format!("Lecture WebSocket ComfyUI impossible : {}", e))?;

    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut len = (header[1] & 0x7f) as u64;
    if len == 126 {
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
        len = u16::from_be_bytes(buf) as u64;
    } else if len == 127 {
        let mut buf = [0u8; 8];
        stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
        len = u64::from_be_bytes(buf);
    }

    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask).map_err(|e| e.to_string())?;
    }

    if len > 10 * 1024 * 1024 {
        return Err("Message WebSocket ComfyUI trop volumineux.".to_string());
    }
    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|e| format!("Payload WebSocket ComfyUI illisible : {}", e))?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }

    match opcode {
        1 => String::from_utf8(payload)
            .map(Some)
            .map_err(|e| format!("Message texte WebSocket ComfyUI invalide : {}", e)),
        8 => Ok(None),
        _ => Ok(Some(String::new())),
    }
}

fn ws_path_for_client(base_url: &reqwest::Url, client_id: &str) -> String {
    let base_path = base_url.path().trim_end_matches('/');
    let path = if base_path.is_empty() {
        "/ws".to_string()
    } else {
        format!("{}/ws", base_path)
    };
    format!("{}?clientId={}", path, client_id)
}

fn custom_workflows_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("luniipack-workflows")
}

fn safe_comfyui_output_filename(filename: &str) -> Result<String, String> {
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.chars().any(char::is_control)
    {
        return Err(format!("Nom de sortie ComfyUI invalide : {}", filename));
    }
    let file_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Nom de sortie ComfyUI invalide : {}", filename))?;
    if file_name != filename {
        return Err(format!("Nom de sortie ComfyUI invalide : {}", filename));
    }
    Ok(file_name.to_string())
}

fn load_manifests_from_dir(dir: &Path, is_custom: bool, manifests: &mut Vec<WorkflowManifest>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !name.ends_with(".config.json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(mut manifest) = serde_json::from_str::<WorkflowManifest>(&content) {
                manifest.is_custom = is_custom;
                // Lire les valeurs actuelles des slots depuis l'api.json
                let api_path = path.with_file_name(&manifest.api_file);
                if let Ok(api_content) = fs::read_to_string(&api_path) {
                    if let Ok(api) = serde_json::from_str::<serde_json::Value>(&api_content) {
                        for (slot_name, slot) in &manifest.slots {
                            if let Some(val) = api
                                .get(&slot.node_id)
                                .and_then(|n| n.get("inputs"))
                                .and_then(|i| i.get(&slot.input_key))
                            {
                                let s = match val {
                                    serde_json::Value::String(s) => s.clone(),
                                    other => other.to_string(),
                                };
                                manifest.default_values.insert(slot_name.clone(), s);
                            }
                        }
                    }
                }
                manifests.push(manifest);
            }
        }
    }
}

struct WorkflowLocation {
    manifest: WorkflowManifest,
    dir: PathBuf,
}

fn find_workflow_by_id(
    resource_dir: &Path,
    app_data_dir: &Path,
    workflow_id: &str,
) -> Result<WorkflowLocation, String> {
    let bundled_dir = resource_dir.join("workflows");
    let custom_dir = custom_workflows_dir(app_data_dir);

    for (dir, is_custom) in [(&bundled_dir, false), (&custom_dir, true)] {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if !name.ends_with(".config.json") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(mut manifest) = serde_json::from_str::<WorkflowManifest>(&content) {
                    if manifest.id == workflow_id {
                        manifest.is_custom = is_custom;
                        return Ok(WorkflowLocation {
                            manifest,
                            dir: dir.to_path_buf(),
                        });
                    }
                }
            }
        }
    }
    Err(format!("Workflow '{}' introuvable", workflow_id))
}

// ── Logique métier ───────────────────────────────────────────────────────────

fn start_comfyui(bat_path: &str) -> Result<(), String> {
    if bat_path.trim().is_empty() {
        return Err(
            "Chemin du fichier .bat ComfyUI non configuré dans les Preferences.".to_string(),
        );
    }
    let path = PathBuf::from(bat_path);
    if !path.exists() {
        return Err(format!("Fichier .bat introuvable : {}", bat_path));
    }
    let parent = path.parent().unwrap_or(Path::new("."));

    // bat_path est passé comme argument direct à cmd — aucune interpolation dans un script.
    // CREATE_NEW_CONSOLE ouvre ComfyUI dans sa propre fenêtre et retourne immédiatement.
    #[cfg(target_os = "windows")]
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;

    let mut cmd = Command::new("cmd");
    cmd.args(["/c", bat_path])
        .current_dir(parent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Impossible de lancer ComfyUI : {}", e))
}

pub fn ensure_comfyui_sync(settings: &ComfyUiSettings) -> Result<(), String> {
    require_local_url(&settings.server_url, "ComfyUI")?;
    if check_health_sync(&settings.server_url).unwrap_or(false) {
        return Ok(());
    }
    if !settings.auto_start {
        return Err(format!(
            "ComfyUI inaccessible sur {}. Lance ComfyUI ou active le démarrage automatique dans les Preferences.",
            settings.server_url
        ));
    }
    start_comfyui(&settings.bat_path)?;
    // Flux prend 2-3 minutes à charger — on attend jusqu'à 180s.
    let mut last_err = "ComfyUI démarré mais ne répond pas encore.".to_string();
    for _ in 0..180 {
        std::thread::sleep(Duration::from_secs(1));
        match check_health_sync(&settings.server_url) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "ComfyUI ne répond toujours pas après 3 minutes. {}",
        last_err
    ))
}

pub fn check_health_sync(server_url: &str) -> Result<bool, String> {
    let client = http_client(Duration::from_secs(5))?;
    let response = client
        .get(join_url(server_url, "/"))
        .send()
        .map_err(|e| format!("ComfyUI inaccessible sur {} : {}", server_url, e))?;
    Ok(response.status().is_success())
}

pub fn list_workflows_sync(
    resource_dir: PathBuf,
    app_data_dir: PathBuf,
) -> Result<Vec<WorkflowManifest>, String> {
    let mut manifests = vec![];
    load_manifests_from_dir(&resource_dir.join("workflows"), false, &mut manifests);
    load_manifests_from_dir(&custom_workflows_dir(&app_data_dir), true, &mut manifests);
    Ok(manifests)
}

pub fn import_workflow_sync(
    app_data_dir: PathBuf,
    api_json_path: String,
    config_json_path: String,
) -> Result<WorkflowManifest, String> {
    let config_content = fs::read_to_string(&config_json_path)
        .map_err(|e| format!("Impossible de lire le config : {}", e))?;
    let mut manifest: WorkflowManifest = serde_json::from_str(&config_content)
        .map_err(|e| format!("Config JSON invalide : {}", e))?;

    if manifest.id.contains('/') || manifest.id.contains('\\') || manifest.id.contains('.') {
        return Err(format!(
            "L'ID du workflow contient des caractères invalides : {}",
            manifest.id
        ));
    }

    let api_filename = Path::new(&manifest.api_file)
        .file_name()
        .ok_or("api_file invalide dans le config")?
        .to_string_lossy()
        .to_string();

    if api_filename.contains('/') || api_filename.contains('\\') {
        return Err("api_file contient un chemin invalide".to_string());
    }

    let custom_dir = custom_workflows_dir(&app_data_dir);
    fs::create_dir_all(&custom_dir)
        .map_err(|e| format!("Impossible de créer le dossier workflows : {}", e))?;

    fs::copy(&api_json_path, custom_dir.join(&api_filename))
        .map_err(|e| format!("Impossible de copier le workflow : {}", e))?;

    manifest.api_file = api_filename;
    manifest.is_custom = true;
    let config_dest = custom_dir.join(format!("{}.config.json", manifest.id));
    fs::write(
        &config_dest,
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Impossible de serialiser le config : {}", e))?,
    )
    .map_err(|e| format!("Impossible de sauvegarder le config : {}", e))?;

    Ok(manifest)
}

pub fn delete_custom_workflow_sync(
    app_data_dir: PathBuf,
    workflow_id: String,
) -> Result<(), String> {
    if workflow_id.contains('/') || workflow_id.contains('\\') || workflow_id.contains('.') {
        return Err("ID workflow invalide".to_string());
    }

    let custom_dir = custom_workflows_dir(&app_data_dir);
    let config_path = custom_dir.join(format!("{}.config.json", workflow_id));

    if !config_path.exists() {
        return Err(format!("Workflow '{}' introuvable", workflow_id));
    }

    let config_content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Impossible de lire le config : {}", e))?;
    let manifest: WorkflowManifest =
        serde_json::from_str(&config_content).map_err(|e| format!("Config invalide : {}", e))?;

    let api_path = custom_dir.join(&manifest.api_file);
    if api_path.exists() {
        let canonical_api =
            fs::canonicalize(&api_path).map_err(|e| format!("Chemin api invalide : {}", e))?;
        let canonical_dir = fs::canonicalize(&custom_dir)
            .map_err(|e| format!("Chemin dossier invalide : {}", e))?;
        if !canonical_api.starts_with(&canonical_dir) {
            return Err("Chemin hors du dossier workflows".to_string());
        }
        fs::remove_file(&api_path)
            .map_err(|e| format!("Impossible de supprimer le workflow : {}", e))?;
    }

    fs::remove_file(&config_path)
        .map_err(|e| format!("Impossible de supprimer le config : {}", e))?;

    Ok(())
}

fn upload_reference_image_sync(server_url: &str, image_path: &str) -> Result<String, String> {
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

fn patch_workflow(
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

    loop {
        let Some(text) = read_ws_frame(&mut stream)? else {
            break;
        };
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

fn fetch_progress_sync(
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

// Résolution des chemins depuis AppHandle — utilisé par les commandes
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_comfyui_output_filename_accepts_plain_filename() {
        let filename = safe_comfyui_output_filename("ComfyUI_00001_.png").unwrap();
        assert_eq!(filename, "ComfyUI_00001_.png");
    }

    #[test]
    fn safe_comfyui_output_filename_rejects_path_segments() {
        assert!(safe_comfyui_output_filename("../ComfyUI_00001_.png").is_err());
        assert!(safe_comfyui_output_filename("nested/ComfyUI_00001_.png").is_err());
        assert!(safe_comfyui_output_filename("..\\ComfyUI_00001_.png").is_err());
        assert!(safe_comfyui_output_filename("ComfyUI_..\u{0}.png").is_err());
    }
}
