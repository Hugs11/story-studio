//! Bounded, deduplicated grouping of touched paths per source.
//!
//! The native debouncer already merges bursts on one path and pairs renames;
//! this second stage only decides *when* a path is handed to the catalogue:
//! after a quiet interval without new events on it, or at the latest after a
//! maximum delay for a path that keeps changing (that file is then checked for
//! stability, never read while still being written). Past its capacity a
//! source overflows: its pending paths are dropped and the whole source is
//! reconciled instead.
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub path: PathBuf,
    pub structural: bool,
    pub attempts: u32,
}

struct Entry {
    structural: bool,
    attempts: u32,
    first: Instant,
    last: Instant,
}

#[derive(Default)]
struct Queue {
    entries: HashMap<PathBuf, Entry>,
    overflowed: bool,
}

pub struct Grouper {
    quiet: Duration,
    max_delay: Duration,
    capacity: usize,
    sources: HashMap<String, Queue>,
}

impl Grouper {
    pub fn new(quiet: Duration, max_delay: Duration, capacity: usize) -> Self {
        Self {
            quiet,
            max_delay,
            capacity: capacity.max(1),
            sources: HashMap::new(),
        }
    }

    /// Adds or refreshes a path. Returns false once the source overflowed.
    pub fn push(&mut self, source: &str, path: PathBuf, structural: bool, now: Instant) -> bool {
        let capacity = self.capacity;
        let queue = self.sources.entry(source.to_owned()).or_default();
        if queue.overflowed {
            return false;
        }
        if let Some(entry) = queue.entries.get_mut(&path) {
            entry.last = now;
            entry.structural |= structural;
            return true;
        }
        if queue.entries.len() >= capacity {
            queue.entries.clear();
            queue.overflowed = true;
            return false;
        }
        queue.entries.insert(
            path,
            Entry {
                structural,
                attempts: 0,
                first: now,
                last: now,
            },
        );
        true
    }

    /// Puts a path back for a later attempt (deferred by an active own write,
    /// still changing, or the catalogue busy), with a fresh delay.
    pub fn retry(&mut self, source: &str, pending: Pending, now: Instant) -> bool {
        let attempts = pending.attempts;
        if !self.push(source, pending.path.clone(), pending.structural, now) {
            return false;
        }
        if let Some(entry) = self
            .sources
            .get_mut(source)
            .and_then(|queue| queue.entries.get_mut(&pending.path))
        {
            entry.attempts = entry.attempts.max(attempts);
            entry.first = now;
        }
        true
    }

    /// Takes every path whose events have settled, per source.
    pub fn take_ready(&mut self, now: Instant) -> Vec<(String, Vec<Pending>)> {
        let (quiet, max_delay) = (self.quiet, self.max_delay);
        let mut ready = Vec::new();
        for (source, queue) in &mut self.sources {
            let paths: Vec<PathBuf> = queue
                .entries
                .iter()
                .filter(|(_, e)| {
                    now.duration_since(e.last) >= quiet || now.duration_since(e.first) >= max_delay
                })
                .map(|(path, _)| path.clone())
                .collect();
            if paths.is_empty() {
                continue;
            }
            let mut taken: Vec<Pending> = paths
                .into_iter()
                .filter_map(|path| {
                    let entry = queue.entries.remove(&path)?;
                    Some(Pending {
                        path,
                        structural: entry.structural,
                        attempts: entry.attempts,
                    })
                })
                .collect();
            taken.sort_by(|a, b| a.path.cmp(&b.path));
            ready.push((source.clone(), taken));
        }
        ready.sort_by(|a, b| a.0.cmp(&b.0));
        ready
    }

    /// Sources that overflowed since the last call; their queues restart empty.
    pub fn take_overflowed(&mut self) -> Vec<String> {
        let mut sources = Vec::new();
        for (source, queue) in &mut self.sources {
            if queue.overflowed {
                queue.overflowed = false;
                sources.push(source.clone());
            }
        }
        sources.sort();
        sources
    }

    /// A reconciliation of the source covers everything pending for it.
    pub fn clear(&mut self, source: &str) {
        self.sources.remove(source);
    }

    pub fn pending(&self, source: &str) -> usize {
        self.sources.get(source).map_or(0, |q| q.entries.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_interval_deduplication_and_maximum_delay() {
        let quiet = Duration::from_millis(100);
        let mut grouper = Grouper::new(quiet, Duration::from_millis(500), 10);
        let start = Instant::now();
        let file = PathBuf::from("/s/a.mbah");
        for step in 0..4 {
            assert!(grouper.push(
                "s",
                file.clone(),
                step == 0,
                start + Duration::from_millis(step * 50)
            ));
        }
        assert_eq!(grouper.pending("s"), 1);
        assert!(grouper
            .take_ready(start + Duration::from_millis(200))
            .is_empty());
        let ready = grouper.take_ready(start + Duration::from_millis(250));
        assert_eq!(
            ready,
            vec![(
                "s".to_owned(),
                vec![Pending {
                    path: file.clone(),
                    structural: true,
                    attempts: 0
                }]
            )]
        );
        // A path that never settles is handed over at the maximum delay.
        for step in 0..12 {
            grouper.push(
                "s",
                file.clone(),
                false,
                start + Duration::from_millis(step * 50),
            );
        }
        assert_eq!(
            grouper.take_ready(start + Duration::from_millis(550)).len(),
            1
        );
    }

    #[test]
    fn overflow_drops_the_queue_and_requests_reconciliation() {
        let mut grouper = Grouper::new(Duration::from_millis(10), Duration::from_secs(1), 3);
        let now = Instant::now();
        for index in 0..3 {
            assert!(grouper.push("s", PathBuf::from(format!("/s/{index}.zip")), false, now));
        }
        assert!(!grouper.push("s", PathBuf::from("/s/3.zip"), false, now));
        assert!(!grouper.push("s", PathBuf::from("/s/4.zip"), false, now));
        assert!(grouper.push("t", PathBuf::from("/t/0.zip"), false, now));
        assert_eq!(grouper.pending("s"), 0);
        assert_eq!(grouper.take_overflowed(), vec!["s".to_owned()]);
        assert!(grouper.take_overflowed().is_empty());
        assert!(grouper.push("s", PathBuf::from("/s/5.zip"), false, now));
    }

    #[test]
    fn retry_keeps_attempts_and_waits_again() {
        let mut grouper = Grouper::new(Duration::from_millis(100), Duration::from_secs(1), 10);
        let now = Instant::now();
        let pending = Pending {
            path: PathBuf::from("/s/copie.zip"),
            structural: false,
            attempts: 3,
        };
        assert!(grouper.retry("s", pending.clone(), now));
        assert!(grouper.take_ready(now).is_empty());
        let ready = grouper.take_ready(now + Duration::from_millis(100));
        assert_eq!(ready[0].1, vec![pending]);
    }
}
