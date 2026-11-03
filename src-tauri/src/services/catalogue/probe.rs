//! Bounded filesystem probes.
//!
//! A metadata call on a dead network mount (NFS, SMB) can block without
//! limit. Each probe runs on its own thread; the caller stops waiting after a
//! delay and the thread is abandoned, never holding a lock of the catalogue.
//! At most one probe per target is in flight: a hung mount costs one thread
//! per probed path, not one per call, and later probes of the same target wait
//! within their own delay, then give up.
use std::{
    collections::HashSet,
    ffi::OsString,
    path::Path,
    sync::{mpsc, Condvar, Mutex},
    time::{Duration, Instant},
};

/// Delay after which a probe is abandoned. Initial, unmeasured value: long
/// enough for a slow but live network volume, short enough for an interface.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

static IN_FLIGHT: Mutex<Option<HashSet<OsString>>> = Mutex::new(None);
static RELEASED: Condvar = Condvar::new();

fn release(target: &OsString) {
    if let Ok(mut slot) = IN_FLIGHT.lock() {
        if let Some(set) = slot.as_mut() {
            set.remove(target);
        }
    }
    RELEASED.notify_all();
}

/// Runs `probe` on a dedicated thread and returns its result, or `None` when
/// it did not answer within `timeout` (or could not be started).
pub(crate) fn bounded<T: Send + 'static>(
    target: &Path,
    timeout: Duration,
    probe: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let deadline = Instant::now() + timeout;
    let key = target.as_os_str().to_owned();
    {
        let mut slot = IN_FLIGHT.lock().ok()?;
        while slot.get_or_insert_with(HashSet::new).contains(&key) {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            slot = RELEASED.wait_timeout(slot, remaining).ok()?.0;
        }
        slot.get_or_insert_with(HashSet::new).insert(key.clone());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let owned = key.clone();
    let spawned = std::thread::Builder::new()
        .name("catalogue-probe".into())
        .spawn(move || {
            let value = probe();
            release(&owned);
            let _ = sender.send(value);
        });
    if spawned.is_err() {
        release(&key);
        return None;
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    receiver.recv_timeout(remaining).ok()
}

/// Whether `path` is a reachable directory; `None` when the probe hung.
pub(crate) fn is_dir(path: &Path) -> Option<bool> {
    let owned = path.to_owned();
    bounded(path, PROBE_TIMEOUT, move || owned.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_probe_that_never_answers_is_abandoned_after_its_delay() {
        let target = std::env::temp_dir().join(format!("probe-hung-{}", uuid::Uuid::new_v4()));
        let (entered, started) = mpsc::channel();
        let (release_probe, hold) = mpsc::channel::<()>();
        let begin = Instant::now();
        let result = bounded(&target, Duration::from_millis(150), move || {
            entered.send(()).unwrap();
            let _ = hold.recv();
            true
        });
        let elapsed = begin.elapsed();
        assert_eq!(result, None);
        started.recv().unwrap();
        assert!(elapsed >= Duration::from_millis(150), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
        // The same target is still hung: a second probe waits within its own
        // delay without starting another thread, then gives up.
        let begin = Instant::now();
        assert_eq!(
            bounded(&target, Duration::from_millis(100), || unreachable!()),
            None::<bool>
        );
        assert!(begin.elapsed() < Duration::from_secs(2));
        // Once the hung probe returns, the target can be probed again.
        release_probe.send(()).unwrap();
        let mut answered = None;
        for _ in 0..50 {
            answered = bounded(&target, Duration::from_millis(100), || 7);
            if answered.is_some() {
                break;
            }
        }
        assert_eq!(answered, Some(7));
    }

    #[test]
    fn a_quick_probe_answers() {
        let root = std::env::temp_dir();
        assert_eq!(is_dir(&root), Some(true));
        assert_eq!(
            is_dir(&root.join(uuid::Uuid::new_v4().to_string())),
            Some(false)
        );
    }
}
