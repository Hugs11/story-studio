use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{cmp::Reverse, io::ErrorKind};

use crate::support::paths::path_for_frontend;

pub const TEMP_IMAGES_DIR: &str = "story_studio_images";
pub const LEGACY_TEMP_IMAGES_DIR: &str = "luniipack_images";
pub const AUDIO_PREVIEWS_DIR: &str = "audio-previews";
pub const PODCAST_MEDIA_DIR: &str = "podcast-media";
pub const YOUTUBE_MEDIA_DIR: &str = "youtube-media";
pub const SESSION_WORKSPACES_DIR: &str = "sessions";
pub const SESSION_WORKSPACE_PREFIX: &str = "story_studio_session_";
pub const SESSION_RECOVERY_FILE: &str = ".session-recovery.mbah";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecovery {
    pub session_dir: String,
    pub snapshot_path: String,
    pub modified_at_ms: u128,
}

const SESSION_WORKSPACE_DIRS: [&str; 7] = [
    "fichiers-importes",
    "enregistrements",
    "voix-generees",
    "images-generees",
    "zips-extraits",
    "exports",
    "sauvegardes",
];

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

pub fn app_cache_subdir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    use tauri::Manager;

    app.path()
        .app_cache_dir()
        .map(|path| path.join(name))
        .map_err(|error| format!("Dossier cache de Story Studio inaccessible : {error}"))
}

fn canonical_session_root(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root)
        .map_err(|e| format!("Dossier temporaire de Story Studio inaccessible : {}", e))?;
    fs::canonicalize(root)
        .map_err(|e| format!("Dossier temporaire de Story Studio inaccessible : {}", e))
}

fn canonical_existing(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("Chemin temporaire inaccessible : {}", e))
}

pub fn is_session_workspace_dir(root: &Path, path: &Path) -> Result<bool, String> {
    let root = canonical_session_root(root)?;
    let target = canonical_existing(path)?;
    let Some(name) = target.file_name().and_then(|value| value.to_str()) else {
        return Ok(false);
    };
    Ok(name.starts_with(SESSION_WORKSPACE_PREFIX) && target.starts_with(root))
}

pub fn create_session_workspace(root: &Path) -> Result<String, String> {
    let root = canonical_session_root(root)?;
    let mut session_dir = None;
    for attempt in 0..100_u8 {
        let candidate = root.join(format!(
            "{}{}_{}_{}",
            SESSION_WORKSPACE_PREFIX,
            std::process::id(),
            now_nanos(),
            attempt
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => {
                session_dir = Some(candidate);
                break;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Impossible de creer le dossier de session : {}",
                    error
                ));
            }
        }
    }
    let session_dir = session_dir
        .ok_or_else(|| "Impossible de creer un dossier de session unique.".to_string())?;
    for dir_name in SESSION_WORKSPACE_DIRS {
        fs::create_dir_all(session_dir.join(dir_name)).map_err(|e| {
            format!(
                "Impossible de creer le sous-dossier de session {} : {}",
                dir_name, e
            )
        })?;
    }

    if !is_session_workspace_dir(&root, &session_dir)? {
        return Err("Dossier de session hors du cache de Story Studio.".to_string());
    }

    let session_dir = canonical_existing(&session_dir)?;
    Ok(path_for_frontend(&session_dir.to_string_lossy()))
}

pub fn cleanup_session_workspace(root: &Path, path: &str) -> Result<(), String> {
    let session_dir = PathBuf::from(path);
    if !session_dir.exists() {
        return Ok(());
    }
    if !is_session_workspace_dir(root, &session_dir)? {
        return Err("Refus de supprimer un dossier hors session Story Studio.".to_string());
    }
    fs::remove_dir_all(&session_dir)
        .map_err(|e| format!("Impossible de nettoyer le dossier de session : {}", e))
}

pub fn cleanup_orphan_session_workspaces(root: &Path, max_age: std::time::Duration) {
    let Ok(root) = canonical_session_root(root) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(max_age).unwrap_or(UNIX_EPOCH);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(SESSION_WORKSPACE_PREFIX) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = cleanup_session_workspace(&root, &path.to_string_lossy());
        }
    }
}

pub fn list_session_recoveries(root: &Path) -> Vec<SessionRecovery> {
    let Ok(root) = canonical_session_root(root) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut recoveries = Vec::new();
    for entry in entries.flatten() {
        let session_dir = entry.path();
        if !session_dir.is_dir() {
            continue;
        }
        let Some(name) = session_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(SESSION_WORKSPACE_PREFIX) {
            continue;
        }
        if !matches!(is_session_workspace_dir(&root, &session_dir), Ok(true)) {
            continue;
        }
        let snapshot = session_dir.join(SESSION_RECOVERY_FILE);
        if !snapshot.is_file() {
            continue;
        }
        let modified_at_ms = fs::metadata(&snapshot)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        recoveries.push(SessionRecovery {
            session_dir: path_for_frontend(&session_dir.to_string_lossy()),
            snapshot_path: path_for_frontend(&snapshot.to_string_lossy()),
            modified_at_ms,
        });
    }

    recoveries.sort_by_key(|entry| Reverse(entry.modified_at_ms));
    recoveries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "story_studio_session_tests_{}_{}_{}",
            label,
            std::process::id(),
            now_nanos()
        ))
    }

    #[test]
    fn create_session_workspace_stays_under_root_and_creates_dirs() {
        let root = test_session_root("create");
        let session = create_session_workspace(&root).expect("create session workspace");
        let session_path = PathBuf::from(&session);
        assert!(is_session_workspace_dir(&root, &session_path).expect("validate session"));
        for dir_name in SESSION_WORKSPACE_DIRS {
            assert!(
                session_path.join(dir_name).is_dir(),
                "{dir_name} should exist"
            );
        }
        cleanup_session_workspace(&root, &session).expect("cleanup session");
        fs::remove_dir(root).expect("cleanup test root");
    }

    #[test]
    fn list_session_recoveries_returns_snapshots_newest_first() {
        let root = test_session_root("recoveries");
        let older = create_session_workspace(&root).expect("create older session");
        let newer = create_session_workspace(&root).expect("create newer session");
        let older_snapshot = PathBuf::from(&older).join(SESSION_RECOVERY_FILE);
        let newer_snapshot = PathBuf::from(&newer).join(SESSION_RECOVERY_FILE);
        fs::write(&older_snapshot, b"{}").expect("write older snapshot");
        // Windows CI can coalesce very close filesystem timestamps, so keep the
        // gap comfortably above millisecond rounding before testing sort order.
        std::thread::sleep(std::time::Duration::from_millis(100));
        fs::write(&newer_snapshot, b"{}").expect("write newer snapshot");

        let recoveries = list_session_recoveries(&root);
        let older_index = recoveries
            .iter()
            .position(|entry| {
                entry.snapshot_path == path_for_frontend(&older_snapshot.to_string_lossy())
            })
            .expect("older recovery listed");
        let newer_index = recoveries
            .iter()
            .position(|entry| {
                entry.snapshot_path == path_for_frontend(&newer_snapshot.to_string_lossy())
            })
            .expect("newer recovery listed");
        assert!(newer_index < older_index);

        cleanup_session_workspace(&root, &older).expect("cleanup older session");
        cleanup_session_workspace(&root, &newer).expect("cleanup newer session");
        fs::remove_dir(root).expect("cleanup test root");
    }

    #[test]
    fn cleanup_session_workspace_rejects_non_session_dir() {
        let root = test_session_root("reject");
        let dir = root.join("story_studio_not_a_session");
        fs::create_dir_all(&dir).expect("create temp dir");
        let err = cleanup_session_workspace(&root, &dir.to_string_lossy()).unwrap_err();
        assert!(err.contains("Refus"));
        fs::remove_dir_all(root).expect("manual cleanup");
    }
}
