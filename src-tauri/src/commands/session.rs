#[tauri::command]
pub fn create_session_workspace(app: tauri::AppHandle) -> Result<String, String> {
    let root =
        crate::support::temp::app_cache_subdir(&app, crate::support::temp::SESSION_WORKSPACES_DIR)?;
    crate::support::temp::create_session_workspace(&root)
}

#[tauri::command]
pub fn cleanup_session_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root =
        crate::support::temp::app_cache_subdir(&app, crate::support::temp::SESSION_WORKSPACES_DIR)?;
    crate::support::temp::cleanup_session_workspace(&root, &path)
}

#[tauri::command]
pub fn list_session_recoveries(
    app: tauri::AppHandle,
) -> Vec<crate::support::temp::SessionRecovery> {
    crate::support::temp::app_cache_subdir(&app, crate::support::temp::SESSION_WORKSPACES_DIR)
        .map(|root| crate::support::temp::list_session_recoveries(&root))
        .unwrap_or_default()
}
