use crate::support::user_message;
use crate::support::user_message::codes;
use crate::support::user_message::UserMessage;
use std::fs;
use std::path::PathBuf;

use tauri::Manager;

fn parse_level(level: &str) -> Result<log::LevelFilter, String> {
    match level.trim().to_lowercase().as_str() {
        "off" => Ok(log::LevelFilter::Off),
        "error" => Ok(log::LevelFilter::Error),
        "warn" => Ok(log::LevelFilter::Warn),
        "info" => Ok(log::LevelFilter::Info),
        "debug" => Ok(log::LevelFilter::Debug),
        "trace" => Ok(log::LevelFilter::Trace),
        other => Err({
            let _msg_other = (other).to_string();
            UserMessage::new(codes::FILES_LOG_LEVEL_UNKNOWN)
                .param("level", user_message::transport_param(_msg_other.clone()))
                .with_detail(format!(
                    "niveau de log inconnu : {_msg_other}",
                    _msg_other = user_message::transport_detail(&_msg_other)
                ))
                .into_transport()
        }),
    }
}

#[tauri::command]
pub fn set_log_level(level: String) -> Result<String, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        let parsed = parse_level(&level)?;
        log::set_max_level(parsed);
        log::info!(target: "diagnostics", "log level set to {}", parsed);
        Ok(parsed.to_string())
    })
}

#[tauri::command]
pub fn get_current_log_file(app: tauri::AppHandle) -> Result<String, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        let dir: PathBuf = app.path().app_log_dir().map_err(|err| {
            let _msg_error = (err).to_string();
            UserMessage::new(codes::FILES_LOG_FOLDER_MISSING)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de localiser le dossier de logs : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        let candidate = dir.join("story-studio.log");
        Ok(crate::support::paths::path_for_frontend(&candidate))
    })
}

/// Garde au plus `keep` fichiers `.log` (le courant + rotations).
/// Les plus anciens sont supprimés. Appelé une fois au boot.
pub fn prune_old_log_files(dir: &std::path::Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("log"))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    let drop_count = files.len() - keep;
    for entry in files.into_iter().take(drop_count) {
        let _ = fs::remove_file(entry.path());
    }
}

/// Read-only boot gate, before frontend migrations or editor mounting.
#[tauri::command]
pub fn startup_blocked(app: tauri::AppHandle) -> bool {
    crate::services::catalogue::open_store(&app)
        .is_err_and(|e| e.code == codes::CATALOG_ALREADY_OPEN)
}

#[tauri::command]
pub fn exit_secondary_instance(app: tauri::AppHandle) {
    if startup_blocked(app.clone()) {
        exit_without_plugin_cleanup();
    }
}

fn exit_without_plugin_cleanup() -> ! {
    // single-instance 2.4.5 removes the shared macOS socket on RunEvent::Exit,
    // even when this process never owned it. Bypass all exit hooks on rejection.
    std::process::exit(0);
}

#[cfg(test)]
mod secondary_exit_tests {
    #[test]
    fn secondary_exit_preserves_primary_socket_and_skips_exit_hooks() {
        const CHILD: &str = "STORY_STUDIO_SECONDARY_EXIT_TEST";
        if let Some(socket) = std::env::var_os(CHILD) {
            struct PluginExit(std::path::PathBuf);
            impl Drop for PluginExit {
                fn drop(&mut self) {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
            let _plugin_exit = PluginExit(socket.into());
            super::exit_without_plugin_cleanup();
        }
        let socket = std::env::temp_dir().join(format!("secondary-exit-{}", uuid::Uuid::new_v4()));
        std::fs::write(&socket, b"primary socket sentinel").unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "commands::diagnostics::secondary_exit_tests::secondary_exit_preserves_primary_socket_and_skips_exit_hooks", "--nocapture"])
            .env(CHILD, &socket).status().unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read(&socket).unwrap(), b"primary socket sentinel");
        std::fs::remove_file(socket).unwrap();
    }
}
