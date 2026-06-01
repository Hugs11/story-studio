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
        other => Err(format!("niveau de log inconnu : {}", other)),
    }
}

#[tauri::command]
pub fn set_log_level(level: String) -> Result<String, String> {
    let parsed = parse_level(&level)?;
    log::set_max_level(parsed);
    log::info!(target: "diagnostics", "log level set to {}", parsed);
    Ok(parsed.to_string())
}

#[tauri::command]
pub fn get_current_log_file(app: tauri::AppHandle) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .app_log_dir()
        .map_err(|err| format!("Impossible de localiser le dossier de logs : {}", err))?;
    let candidate = dir.join("story-studio.log");
    Ok(candidate.to_string_lossy().to_string())
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
