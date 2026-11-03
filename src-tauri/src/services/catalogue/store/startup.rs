//! Admission touches only the application stores. Recovery may access dead
//! network volumes and must never prevent the editor from starting.
use super::*;
use std::sync::{atomic::Ordering, mpsc, Arc};

/// Immutable process-start inventory. Native IO starts only after this snapshot
/// has been captured, so subsequent user operations can never join recovery.
pub(crate) struct InheritedRecovery {
    pub backup_publications: Vec<(String, String)>,
    pub file_journals: Vec<String>,
    pub removals: Vec<(String, String)>,
    pub file_operations: Vec<String>,
}

const RECOVERY_WAIT: Duration = Duration::from_millis(50);

impl Store {
    pub(crate) fn all_warnings(&self) -> Vec<UserMessage> {
        self.warnings.clone()
    }

    pub(crate) fn inherited_recovery(&self) -> Result<InheritedRecovery> {
        self.read_snapshot(|c| {
            Ok(InheritedRecovery {
                backup_publications: c.prepare("SELECT id,evidence_json FROM backup_publication")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?,
                removals: c.prepare("SELECT id,evidence_json FROM file_removal WHERE state NOT IN ('complete','purgePending')")?.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?,
                file_journals: c.prepare("SELECT evidence_json FROM file_journal WHERE CASE WHEN json_valid(evidence_json) THEN COALESCE(json_extract(evidence_json,'$.stage'),'') NOT IN ('complete','rolledBack','failed') ELSE 1 END")?
                    .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?,
                file_operations: c.prepare("SELECT id FROM file_operation WHERE state='running'")?
                    .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?,
            })
        })
    }

    pub(crate) fn recover_inherited(&self, inherited: InheritedRecovery) -> Vec<UserMessage> {
        let mut warnings = Vec::new();
        for result in [
            self.recover_backup_publications_from(inherited.backup_publications),
            self.recover_removals_from(inherited.removals),
            self.recover_file_operations_from(inherited.file_journals, inherited.file_operations),
        ] {
            match result {
                Ok(recovered) => warnings.extend(recovered),
                Err(warning) => warnings.push(warning),
            }
        }
        if let Err(warning) = self.reconcile_trash_retention() {
            warnings.push(warning);
        }
        self.retry_removal_purges();
        warnings
    }

    pub(crate) fn start_recovery(self: &Arc<Self>) -> Result<()> {
        self.start_recovery_with(Self::recover_inherited)
    }

    pub(crate) fn start_recovery_with(
        self: &Arc<Self>,
        recover: impl FnOnce(&Store, InheritedRecovery) -> Vec<UserMessage> + Send + 'static,
    ) -> Result<()> {
        if self.recovery_running.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let inherited = match self.inherited_recovery() {
            Ok(inherited) => inherited,
            Err(reason) => {
                self.recovery_running.store(false, Ordering::Release);
                return Err(reason);
            }
        };
        let store = Arc::clone(self);
        let (done, wait) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("catalogue-recovery".into())
            .spawn(move || {
                let warnings = recover(&store, inherited);
                for warning in &warnings {
                    log::warn!("Catalogue recovery: {warning}");
                }
                if let Ok(mut slot) = store.recovery_warnings.lock() {
                    slot.extend(warnings);
                }
                store.recovery_running.store(false, Ordering::Release);
                let _ = done.send(());
            });
        if let Err(reason) = worker {
            self.recovery_running.store(false, Ordering::Release);
            return Err(error(reason));
        }
        // A timeout does not cancel or retry a native operation: it keeps its
        // store (and exclusive instance lock), and durable path guards remain.
        let _ = wait.recv_timeout(RECOVERY_WAIT);
        Ok(())
    }
}

/// Durable intents already contain absolute paths. Compare without touching a
/// filesystem: even canonicalizing a parent can hang on an unavailable mount.
pub(crate) fn paths_overlap(a: &Path, b: &Path) -> bool {
    fn key(path: &Path) -> String {
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        crate::support::paths::path_key(&crate::support::paths::path_for_frontend(normalized))
            .trim_end_matches('/')
            .to_owned()
    }
    let a = key(a);
    let b = key(b);
    let within = |child: &str, root: &str| {
        child == root || child.strip_prefix(root).is_some_and(|s| s.starts_with('/'))
    };
    within(&a, &b) || within(&b, &a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    struct RecoveryLog(std::sync::Mutex<Vec<String>>);
    static RECOVERY_LOG: RecoveryLog = RecoveryLog(std::sync::Mutex::new(Vec::new()));
    impl log::Log for RecoveryLog {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            if record.level() == log::Level::Warn {
                self.0.lock().unwrap().push(record.args().to_string());
            }
        }
        fn flush(&self) {}
    }

    #[test]
    fn hung_remote_recovery_does_not_block_admission_or_release_guards() {
        log::set_logger(&RECOVERY_LOG).unwrap();
        log::set_max_level(log::LevelFilter::Warn);
        let root =
            std::env::temp_dir().join(format!("catalogue-admission-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let cache = root.join("cache");
        let store = Arc::new(Store::admit(&data, &cache).unwrap());
        let destination = root.join("unresponsive-mount/catalogue.zip");
        let previous = root.join("unresponsive-mount/.catalogue.previous");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        // Written by hand: the guard must need only durable evidence, including
        // when none of the paths on the destination volume can be read.
        let intent = serde_json::json!({
            "destination": destination, "recovery": previous, "parent_id": "parent",
            "previous": {"byteSize": 1, "sha256": "old"}, "previous_id": "old-file",
            "prepared": {"byteSize": 1, "sha256": "new"}, "prepared_id": "new-file"
        });
        store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO backup_publication VALUES ('pending',?1)",
                    [intent.to_string()],
                )
                .map_err(error)?;
                Ok(())
            })
            .unwrap();
        let (entered, started) = mpsc::channel();
        let (release, hold) = mpsc::channel::<()>();
        let (finished, end) = mpsc::channel();
        let begin = Instant::now();
        store
            .start_recovery_with(move |store, inherited| {
                entered.send(()).unwrap();
                // Simulates an IO call that does not answer. The timeout below is
                // only a test cleanup safeguard, never a successful IO response.
                let _ = hold.recv_timeout(Duration::from_secs(3));
                let warnings = store.recover_inherited(inherited);
                finished.send(()).unwrap();
                warnings
            })
            .unwrap();
        let elapsed = begin.elapsed();
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            elapsed < Duration::from_millis(500),
            "admission waited for remote IO: {elapsed:?}"
        );
        assert!(end.try_recv().is_err());
        assert!(
            Store::admit(&data, &cache).is_err(),
            "instance lock remains held"
        );
        assert!(!store
            .all_warnings()
            .iter()
            .any(|w| w.code == codes::CATALOG_FILE_RECOVERY_REQUIRED));
        for path in [&destination, &previous] {
            assert!(store.file_recovery_pending(path).unwrap());
            let begin = Instant::now();
            assert_eq!(
                store
                    .plan_catalogue_export(path.clone(), 0)
                    .unwrap_err()
                    .code,
                codes::CATALOG_BACKUP_DESTINATION_CONFLICT
            );
            assert!(begin.elapsed() < Duration::from_millis(500));
            assert_eq!(
                store
                    .project_access("save", Some(path.to_string_lossy().into()), None, None)
                    .unwrap_err()
                    .code,
                codes::CATALOG_FILE_RECOVERY_REQUIRED
            );
        }
        assert!(!store
            .file_recovery_pending(&root.join("unrelated.mbah"))
            .unwrap());
        store
            .project_access(
                "open",
                Some(root.join("unrelated.mbah").to_string_lossy().into()),
                None,
                None,
            )
            .unwrap();
        // A timeout must never discard the journal or start destructive retries.
        let count: i64 = store
            .read(|c| c.query_row("SELECT count(*) FROM backup_publication", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1);
        release.send(()).unwrap();
        end.recv_timeout(Duration::from_secs(2)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while store.recovery_running.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(store
            .recovery_warnings
            .lock()
            .unwrap()
            .iter()
            .any(|w| w.code == codes::CATALOG_BACKUP_DESTINATION_CONFLICT));
        assert!(!store
            .all_warnings()
            .iter()
            .any(|w| w.code == codes::CATALOG_BACKUP_DESTINATION_CONFLICT));
        assert!(RECOVERY_LOG
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("Catalogue recovery:")
                && line.contains(root.file_name().unwrap().to_str().unwrap())));
        assert!(
            store.file_recovery_pending(&destination).unwrap(),
            "a failed recovery retains its durable guard"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn path_guards_normalize_segments_without_probing_the_filesystem() {
        assert!(paths_overlap(
            Path::new("/absent/share/pack.zip"),
            Path::new("/absent/share/a/../pack.zip")
        ));
        assert!(paths_overlap(
            Path::new("/absent/share"),
            Path::new("/absent/share/pack.zip")
        ));
        assert!(!paths_overlap(
            Path::new("/absent/share/pack.zip"),
            Path::new("/absent/share/Pack.zip")
        ));
        assert!(!paths_overlap(
            Path::new("/absent/share"),
            Path::new("/absent/share-other")
        ));
    }
}
