use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Source(PathBuf);
impl Source {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "audio-level-command-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::write(&path, b"source").unwrap();
        Self(path)
    }
    fn change(&self) {
        std::fs::write(&self.0, b"changed source with a different size").unwrap();
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn report() -> AudioLevelReport {
    AudioLevelReport {
        silent: false,
        integrated_lufs: Some(-14.0),
        true_peak_db: Some(-3.0),
        notice: None,
    }
}

fn session() -> Arc<AudioLevelSession> {
    Arc::new(AudioLevelSession::default())
}

#[test]
fn audio_command_refuses_relative_paths() {
    let error =
        tauri::async_runtime::block_on(measure_audio_level("relative.wav".into())).unwrap_err();
    assert!(error.contains(codes::FILES_ABSOLUTE_PATH_REQUIRED));
}

#[test]
fn audio_canonicalization_failure_keeps_a_readable_file() {
    let source = Source::new();
    let key = file_key_with(&source.0, |_| {
        Err(std::io::Error::other("volume does not canonicalize"))
    })
    .unwrap();
    assert_eq!(key.path, source.0);
    assert_eq!(key.size, 6);
}

#[test]
fn audio_cache_remeasures_a_changed_file() {
    tauri::async_runtime::block_on(async {
        let session = session();
        let source = Source::new();
        let calls = Arc::new(AtomicUsize::new(0));
        for step in 0..4 {
            if step == 2 {
                source.change();
            }
            if step == 3 {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&source.0)
                    .unwrap()
                    .set_modified(SystemTime::now() + Duration::from_secs(5))
                    .unwrap();
            }
            let count = calls.clone();
            assert_eq!(
                session
                    .measure(source.0.clone(), move |_| {
                        count.fetch_add(1, Ordering::SeqCst);
                        Ok(report())
                    })
                    .await
                    .unwrap(),
                Some(report())
            );
            assert_eq!(calls.load(Ordering::SeqCst), [1, 1, 2, 3][step]);
        }
    });
}

#[test]
fn audio_changed_during_measurement_never_returns_or_caches_old_verdict() {
    tauri::async_runtime::block_on(async {
        let session = session();
        let source = Arc::new(Source::new());
        let changed = source.clone();
        let result = session
            .measure(source.0.clone(), move |_| {
                changed.change();
                Ok(report())
            })
            .await
            .unwrap();
        assert_eq!(result, None);
        assert!(session.state.lock().unwrap().cache.is_empty());
        assert_eq!(
            session
                .measure(source.0.clone(), |_| Ok(report()))
                .await
                .unwrap(),
            Some(report())
        );
    });
}

async fn until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "async condition timed out"
        );
        tokio::task::yield_now().await;
    }
}

#[test]
fn audio_concurrency_is_two_and_duplicate_requests_share_one_measurement() {
    tauri::async_runtime::block_on(async {
        let session = session();
        let sources: Vec<_> = (0..6).map(|_| Source::new()).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for source in &sources {
            for alias in 0..2 {
                let path = if alias == 0 {
                    source.0.clone()
                } else {
                    source
                        .0
                        .parent()
                        .unwrap()
                        .join(".")
                        .join(source.0.file_name().unwrap())
                };
                let (session, active, peak, calls) =
                    (session.clone(), active.clone(), peak.clone(), calls.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    session
                        .measure(path, move |_| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(count, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(80));
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(report())
                        })
                        .await
                }));
            }
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap(), Some(report()));
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 6);
    });
}

#[test]
fn audio_queued_and_duplicate_requests_do_not_use_blocking_workers() {
    tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .build()
        .unwrap()
        .block_on(async {
            let session = session();
            // Hold admission, then enqueue hundreds of unique and duplicate requests.
            let permits = session
                .semaphore
                .clone()
                .acquire_many_owned(2)
                .await
                .unwrap();
            let sources: Vec<_> = (0..100).map(|_| Source::new()).collect();
            let calls = Arc::new(AtomicUsize::new(0));
            let mut tasks = Vec::new();
            for source in &sources {
                for _ in 0..3 {
                    let (session, path, calls) = (session.clone(), source.0.clone(), calls.clone());
                    tasks.push(tokio::spawn(async move {
                        session
                            .measure(path, move |_| {
                                calls.fetch_add(1, Ordering::SeqCst);
                                Ok(report())
                            })
                            .await
                    }));
                }
            }
            until(|| {
                let state = session.state.lock().unwrap();
                state.flights.len() == 100
                    && state.flights.values().all(|job| job.receiver_count() == 3)
            })
            .await;
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            // Every waiter is suspended; independent blocking work can still run.
            assert_eq!(tokio::task::spawn_blocking(|| 42).await.unwrap(), 42);
            // Changed queued source is discarded before the analyzer is called.
            sources[0].change();
            drop(permits);
            for (index, task) in tasks.into_iter().enumerate() {
                assert_eq!(
                    task.await.unwrap().unwrap(),
                    if index < 3 { None } else { Some(report()) }
                );
            }
            assert_eq!(calls.load(Ordering::SeqCst), 99);
        });
}

#[test]
fn audio_failed_inflight_measurement_is_shared_but_not_cached() {
    tauri::async_runtime::block_on(async {
        let session = session();
        let source = Source::new();
        let (started_tx, mut started_rx) = watch::channel(false);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (first_session, first_path) = (session.clone(), source.0.clone());
        let first = tauri::async_runtime::spawn(async move {
            first_session
                .measure(first_path, move |_| {
                    started_tx.send_replace(true);
                    release_rx.recv().unwrap();
                    Err(interrupted("fixture"))
                })
                .await
        });
        started_rx.changed().await.unwrap();
        let (second_session, second_path) = (session.clone(), source.0.clone());
        let second = tauri::async_runtime::spawn(async move {
            second_session
                .measure(second_path, |_| panic!("duplicate measurement"))
                .await
        });
        until(|| {
            session
                .state
                .lock()
                .unwrap()
                .flights
                .values()
                .any(|job| job.receiver_count() == 2)
        })
        .await;
        release_tx.send(()).unwrap();
        assert_eq!(first.await.unwrap(), second.await.unwrap());
        assert!(session.state.lock().unwrap().cache.is_empty());
        session
            .measure(source.0.clone(), |_| Ok(report()))
            .await
            .unwrap();
        assert_eq!(session.semaphore.available_permits(), 2);
    });
}

#[test]
fn audio_panicked_worker_releases_admission_and_flight() {
    tauri::async_runtime::block_on(async {
        let session = session();
        let source = Source::new();
        assert!(session
            .measure(source.0.clone(), |_| panic!("fixture"))
            .await
            .unwrap_err()
            .contains(codes::FILES_TASK_ABANDONED));
        assert!(session.state.lock().unwrap().flights.is_empty());
        assert_eq!(session.semaphore.available_permits(), 2);
        session
            .measure(source.0.clone(), |_| Ok(report()))
            .await
            .unwrap();
    });
}
