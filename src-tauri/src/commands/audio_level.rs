//! Session-only, coalesced read-only analysis. Admission and duplicate waits
//! are asynchronous; blocking workers only inspect files or run admitted tools.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;
use tokio::sync::{watch, Semaphore};

use crate::support::audio_norm::{self, AudioLevelReport};
use crate::support::ffmpeg::get_ffmpeg_path;
use crate::support::user_message::{codes, UserMessage};

// null is an obsolete source, to be silently discarded by the JS boundary.
type Measurement = Result<Option<AudioLevelReport>, String>;
type Analysis = Result<AudioLevelReport, String>;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct FileKey {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

fn file_key(path: &Path) -> Result<FileKey, String> {
    file_key_with(path, Path::canonicalize)
}

fn file_key_with(
    path: &Path,
    canonicalize: impl FnOnce(&Path) -> std::io::Result<PathBuf>,
) -> Result<FileKey, String> {
    if !path.is_absolute() {
        return Err(UserMessage::new(codes::FILES_ABSOLUTE_PATH_REQUIRED)
            .param(
                "label",
                crate::support::user_message::transport_param(
                    codes::AUDIO_FILE_LABEL_TRANSPORT.to_string(),
                ),
            )
            .into_transport());
    }
    let read = || -> std::io::Result<FileKey> {
        let metadata = path.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::other("expected a regular file"));
        }
        Ok(FileKey {
            path: canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
            size: metadata.len(),
            modified: metadata.modified()?,
        })
    };
    read().map_err(|error| {
        UserMessage::new(codes::FILES_NOT_FOUND_OR_INACCESSIBLE)
            .param(
                "label",
                crate::support::user_message::transport_param(
                    codes::AUDIO_FILE_LABEL_TRANSPORT.to_string(),
                ),
            )
            .param("error", error.to_string())
            .into_transport()
    })
}

#[derive(Default)]
struct Session {
    cache: HashMap<PathBuf, (FileKey, AudioLevelReport)>,
    flights: HashMap<FileKey, watch::Sender<Option<Measurement>>>,
}

struct AudioLevelSession {
    state: Mutex<Session>,
    semaphore: Arc<Semaphore>,
}

impl Default for AudioLevelSession {
    fn default() -> Self {
        Self {
            state: Mutex::new(Session::default()),
            semaphore: Arc::new(Semaphore::new(2)),
        }
    }
}

fn interrupted(reason: &str) -> String {
    UserMessage::new(codes::FILES_TASK_ABANDONED)
        .param("error", reason)
        .into_transport()
}

async fn inspect(path: PathBuf) -> Result<FileKey, String> {
    tokio::task::spawn_blocking(move || file_key(&path))
        .await
        .map_err(|error| interrupted(&error.to_string()))?
}

impl AudioLevelSession {
    async fn measure(
        self: &Arc<Self>,
        path: PathBuf,
        measure: impl FnOnce(&Path) -> Analysis + Send + 'static,
    ) -> Measurement {
        let key = inspect(path.clone()).await?;
        let mut receiver = {
            let mut state = self.state.lock().unwrap();
            if let Some((cached_key, report)) = state.cache.get(&key.path) {
                if *cached_key == key {
                    return Ok(Some(report.clone()));
                }
            }
            state.cache.remove(&key.path);
            if let Some(sender) = state.flights.get(&key) {
                sender.subscribe()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.flights.insert(key.clone(), sender.clone());
                let session = Arc::clone(self);
                let key = key.clone();
                // This task owns completion even if the invoking future is dropped.
                tokio::spawn(async move {
                    let permit = session.semaphore.clone().acquire_owned().await.unwrap();
                    let worker_key = key.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        if file_key(&path).ok().as_ref() != Some(&worker_key) {
                            return Ok(None);
                        }
                        let result = measure(&path);
                        // A replaced, removed or inaccessible source is obsolete too.
                        if file_key(&path).ok().as_ref() != Some(&worker_key) {
                            return Ok(None);
                        }
                        result.map(Some)
                    })
                    .await
                    .unwrap_or_else(|error| Err(interrupted(&error.to_string())));
                    let mut state = session.state.lock().unwrap();
                    if let Ok(Some(report)) = &result {
                        state
                            .cache
                            .insert(key.path.clone(), (key.clone(), report.clone()));
                    }
                    sender.send_replace(Some(result));
                    state.flights.remove(&key);
                });
                receiver
            }
        };
        let result = loop {
            if let Some(result) = receiver.borrow().clone() {
                break result;
            }
            receiver
                .changed()
                .await
                .map_err(|error| interrupted(&error.to_string()))?;
        };
        // Followers also revalidate after resuming.
        if inspect(key.path.clone()).await.ok().as_ref() != Some(&key) {
            return Ok(None);
        }
        result
    }
}

#[tauri::command]
pub(crate) async fn measure_audio_level(path: String) -> Measurement {
    static SESSION: OnceLock<Arc<AudioLevelSession>> = OnceLock::new();
    SESSION
        .get_or_init(|| Arc::new(AudioLevelSession::default()))
        .measure(PathBuf::from(path), |path| {
            audio_norm::measure_audio_level(&get_ffmpeg_path()?, path)
        })
        .await
}

#[cfg(test)]
mod tests;
