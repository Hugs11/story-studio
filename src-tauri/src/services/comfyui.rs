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

mod client;
mod jobs;
mod lifecycle;
mod workflows;

use client::*;
pub use jobs::{
    download_output_sync, poll_job_sync, resolve_paths, submit_job_sync, watch_progress_sync,
};
pub use lifecycle::ensure_comfyui_sync;
use workflows::*;
pub use workflows::{delete_custom_workflow_sync, import_workflow_sync, list_workflows_sync};

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
