use super::*;

pub(super) fn start_comfyui(bat_path: &str) -> Result<(), String> {
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
    // CREATE_NO_WINDOW évite la fenêtre cmd vide ; l'état serveur est suivi par HTTP.
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new("cmd");
    cmd.args(["/c", bat_path])
        .current_dir(parent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
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
