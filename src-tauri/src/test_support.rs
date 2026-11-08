//! Scheduling safeguards for tests, never product timing assertions.
use std::{sync::OnceLock, thread::JoinHandle, time::Duration};

/// Positive waits exit as soon as their event arrives. Override only the
/// scheduling ceiling, not debounce, cancellation or inactivity contracts.
pub(crate) fn timeout() -> Duration {
    static TIMEOUT: OnceLock<Duration> = OnceLock::new();
    *TIMEOUT.get_or_init(|| {
        let seconds = match std::env::var("STORY_STUDIO_TEST_TIMEOUT_SECS") {
            Ok(value) => value
                .parse::<u64>()
                .ok()
                .filter(|seconds| *seconds > 0)
                .expect("STORY_STUDIO_TEST_TIMEOUT_SECS must be a positive integer"),
            Err(std::env::VarError::NotPresent) => 120,
            Err(error) => panic!("STORY_STUDIO_TEST_TIMEOUT_SECS: {error}"),
        };
        Duration::from_secs(seconds)
    })
}

/// Preserve the worker's original panic payload instead of an opaque Any error.
pub(crate) fn join<T>(worker: JoinHandle<T>) -> T {
    worker
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// Identify auxiliary HTTP panics even if the receiving test fails first.
pub(crate) fn spawn<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> JoinHandle<T> {
    std::thread::Builder::new()
        .name(format!(
            "{}::worker",
            std::thread::current().name().unwrap_or("test")
        ))
        .spawn(work)
        .expect("spawn test HTTP worker")
}

#[test]
fn auxiliary_panic_keeps_its_original_message() {
    let panic = std::panic::catch_unwind(|| {
        let worker = spawn(|| panic!("HTTP fixture: original failure"));
        join(worker);
    })
    .unwrap_err();
    assert_eq!(
        panic.downcast_ref::<&str>(),
        Some(&"HTTP fixture: original failure")
    );
}
