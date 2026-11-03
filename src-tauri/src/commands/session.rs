use crate::support::user_message::UserMessage;
#[tauri::command]
pub fn create_session_workspace(app: tauri::AppHandle) -> Result<String, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        let root = crate::support::temp::app_cache_subdir(
            &app,
            crate::support::temp::SESSION_WORKSPACES_DIR,
        )?;
        crate::support::temp::create_session_workspace(&root)
    })
}

#[tauri::command]
pub fn cleanup_session_workspace(app: tauri::AppHandle, path: String) -> Result<(), UserMessage> {
    crate::support::user_message::user_message_result(|| {
        let root = crate::support::temp::app_cache_subdir(
            &app,
            crate::support::temp::SESSION_WORKSPACES_DIR,
        )?;
        crate::support::temp::cleanup_session_workspace(&root, &path)
    })
}

#[tauri::command]
pub fn list_session_recoveries(
    app: tauri::AppHandle,
) -> Vec<crate::support::temp::SessionRecovery> {
    crate::support::temp::app_cache_subdir(&app, crate::support::temp::SESSION_WORKSPACES_DIR)
        .map(|root| crate::support::temp::list_session_recoveries(&root))
        .unwrap_or_default()
}
