#[tauri::command]
pub fn create_session_workspace() -> Result<String, String> {
    crate::support::temp::create_session_workspace()
}

#[tauri::command]
pub fn cleanup_session_workspace(path: String) -> Result<(), String> {
    crate::support::temp::cleanup_session_workspace(&path)
}

#[tauri::command]
pub fn list_session_recoveries() -> Vec<crate::support::temp::SessionRecovery> {
    crate::support::temp::list_session_recoveries()
}
