use super::*;

pub(super) fn custom_workflows_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("luniipack-workflows")
}

pub(super) fn load_manifests_from_dir(
    dir: &Path,
    is_custom: bool,
    manifests: &mut Vec<WorkflowManifest>,
) {
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

pub(super) struct WorkflowLocation {
    pub(super) manifest: WorkflowManifest,
    pub(super) dir: PathBuf,
}

pub(super) fn find_workflow_by_id(
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
