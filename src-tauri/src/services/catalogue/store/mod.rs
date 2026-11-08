//! Two independent stores: personal data never belongs to the disposable cache.
use super::Result;
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{Connection, OpenFlags, Transaction};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub struct Store {
    /// Installed before recovery starts; every committed revision invalidates readers.
    pub(super) change_sink: Option<super::watch::ChangeSink>,
    pub(crate) lunii: super::lunii_db::Runtime,
    pub(crate) backup_exports: Mutex<super::backup::Registry>,
    pub(crate) assemblies: Mutex<super::assembly::Registry>,
    pub(crate) identical_copies: Mutex<super::files::identical::Registry>,
    pub(crate) duplicate_results: Mutex<super::files::duplicates::Registry>,
    pub scans: super::scan::Manager,
    pub(crate) file_plans:
        Mutex<std::collections::HashMap<String, super::files::models::StoredPlan>>,
    /// Real pack counts of archive files shown in an opened fiche, keyed by
    /// path and file fingerprint. Display only: a trash plan always recounts.
    pub(crate) archive_pack_counts: super::files::trash::PackCounts,
    /// Analysis, inventory and publication counters (diagnostics and tests).
    pub activity: super::refresh::Activity,
    /// Packs whose stale or pending analysis was already retried by a
    /// reconciliation this session, with the content token retried. Cleared
    /// at restart; a different token (real content change) lifts the limit.
    pub(super) stale_retries: Mutex<std::collections::HashMap<Vec<u8>, String>>,
    _instance_lock: Option<std::fs::File>,
    writer: Mutex<Connection>,
    #[allow(dead_code)] // Connection retained for the upcoming scan writer.
    cache_writer: Mutex<Connection>,
    durable_path: PathBuf,
    #[allow(dead_code)] // Independent read connections for scans.
    cache_path: PathBuf,
    pub warnings: Vec<UserMessage>,
    pub(super) recovery_warnings: Mutex<Vec<UserMessage>>,
    pub(crate) project_accesses: super::files::project_access::ProjectAccesses,
    pub(super) recovery_running: std::sync::atomic::AtomicBool,
    /// Per-fiche display covers: prefabrication state and interactive priority.
    pub(crate) covers: super::cover_store::Runtime,
}

pub(crate) fn error(error: impl std::fmt::Display) -> UserMessage {
    UserMessage::new(codes::CATALOG_STORE_ERROR).with_detail(error.to_string())
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// On failed admission retain exclusion until process exit, including degraded editing.
struct AdmissionLock(Option<std::fs::File>);
impl Drop for AdmissionLock {
    fn drop(&mut self) {
        if let Some(lock) = self.0.take() {
            std::mem::forget(lock);
        }
    }
}

impl Store {
    pub(crate) fn images_root(&self) -> PathBuf {
        self.durable_path.parent().unwrap().join("images")
    }
    pub(crate) fn staging_root(&self) -> PathBuf {
        self.cache_path.parent().unwrap().join("staging")
    }
    pub(super) fn thumbnail_root(&self) -> PathBuf {
        self.cache_path.parent().unwrap().join("thumbnails")
    }
    /// One display cover per fiche (`cover_store`), never evicted by size.
    pub(super) fn cover_root(&self) -> PathBuf {
        self.cache_path.parent().unwrap().join("covers")
    }
    /// Synchronous opening used by maintenance and recovery tests.
    #[cfg(test)]
    pub fn open(data: &Path, cache: &Path) -> Result<Self> {
        Self::open_inner(data, cache, true)
    }
    pub(crate) fn admit(data: &Path, cache: &Path) -> Result<Self> {
        Self::open_inner(data, cache, false)
    }
    fn open_inner(data: &Path, cache: &Path, recover: bool) -> Result<Self> {
        let durable_path = data.join("catalogue/catalogue.sqlite");
        let cache_path = cache.join("catalogue/index.sqlite");
        if durable_path == cache_path {
            return Err(error("Stores must be separate"));
        }
        // Only the lock's parent may be created before writer admission.
        std::fs::create_dir_all(data.join("catalogue")).map_err(error)?;
        let instance_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data.join("catalogue/writer.lock"))
            .map_err(error)?;
        instance_lock.try_lock().map_err(|cause| match cause {
            std::fs::TryLockError::WouldBlock => UserMessage::new(codes::CATALOG_ALREADY_OPEN),
            std::fs::TryLockError::Error(cause) => error(cause),
        })?;
        let mut admission_lock = AdmissionLock(Some(instance_lock));
        for name in ["images", "recovery", "operations"] {
            std::fs::create_dir_all(data.join("catalogue").join(name)).map_err(error)?;
        }
        for name in ["thumbnails", "covers", "staging"] {
            std::fs::create_dir_all(cache.join("catalogue").join(name)).map_err(error)?;
        }
        let mut warnings = Vec::new();
        let writer = open_database(&durable_path, DURABLE_MIGRATIONS, &mut warnings)?;
        // Keep the last confirmed locale for durable identity recovery before the UI opens.
        let durable_warnings = warnings.len();
        let mut rebuilt = false;
        let cache_writer = match open_database(&cache_path, CACHE_MIGRATIONS, &mut warnings) {
            Ok(connection) => connection,
            Err(_) => {
                rebuilt = true;
                // Disposable indexes never impose a version gate on personal data.
                for suffix in ["", "-wal", "-shm", "-journal"] {
                    let path = PathBuf::from(format!("{}{suffix}", cache_path.display()));
                    if path.exists() {
                        std::fs::remove_file(path).map_err(error)?;
                    }
                }
                open_database(&cache_path, CACHE_MIGRATIONS, &mut warnings)?
            }
        };
        if warnings.len() > durable_warnings || rebuilt {
            warnings.truncate(durable_warnings);
            warnings.push(UserMessage::new(codes::CATALOG_CACHE_REBUILT));
        }
        let _ = std::fs::remove_dir_all(cache.join("catalogue/recovery"));
        prune_recovery(&data.join("catalogue/recovery"), 5)?;
        // The instance lock is held; no assistant from this process can own
        // preparations left by an earlier process.
        let orphan_assemblies = data.join("catalogue/assembly");
        if orphan_assemblies.exists() {
            if let Err(error) = std::fs::remove_dir_all(&orphan_assemblies) {
                log::warn!("Catalogue orphan assembly cleanup: {error}");
            }
        }
        writer
            .execute(
                "ATTACH DATABASE ?1 AS cache",
                [cache_path.to_string_lossy().as_ref()],
            )
            .map_err(error)?;
        let mut store = Self {
            change_sink: None,
            lunii: Default::default(),
            assemblies: Mutex::new(Default::default()),
            backup_exports: Mutex::new(Default::default()),
            scans: super::scan::Manager::default(),
            identical_copies: Mutex::new(Default::default()),
            duplicate_results: Mutex::new(Default::default()),
            file_plans: Mutex::new(std::collections::HashMap::new()),
            archive_pack_counts: Default::default(),
            activity: super::refresh::Activity::default(),
            stale_retries: Mutex::default(),
            _instance_lock: None,
            writer: Mutex::new(writer),
            cache_writer: Mutex::new(cache_writer),
            durable_path,
            cache_path,
            warnings,
            recovery_warnings: Mutex::new(Vec::new()),
            project_accesses: Default::default(),
            recovery_running: std::sync::atomic::AtomicBool::new(false),
            covers: Default::default(),
        };
        if recover {
            store.warnings.extend(store.recover_backup_publications()?);
            store.warnings.extend(store.recover_file_operations()?);
        }
        let orphan_backups = store.backup_root();
        if orphan_backups.exists() {
            std::fs::remove_dir_all(orphan_backups).map_err(error)?;
        }
        store.clean_images()?;
        store._instance_lock = admission_lock.0.take();
        Ok(store)
    }
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        self.read_connection(false, f)
    }
    pub fn read_snapshot<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T> {
        self.read_connection(true, f)
    }
    fn read_connection<T>(
        &self,
        snapshot: bool,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T> {
        let connection =
            Connection::open_with_flags(&self.durable_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(error)?;
        connection
            .execute(
                "ATTACH DATABASE ?1 AS cache",
                [self.cache_path.to_string_lossy().as_ref()],
            )
            .map_err(error)?;
        if !snapshot {
            return f(&connection).map_err(error);
        }
        // Pin both WAL snapshots while publications are excluded. SQLite pins
        // attached databases lazily, so BEGIN alone is insufficient.
        let publication = self.writer.lock().map_err(error)?;
        connection.execute_batch("BEGIN").map_err(error)?;
        connection
            .query_row("SELECT revision FROM catalogue", [], |r| r.get::<_, i64>(0))
            .map_err(error)?;
        connection
            .query_row("SELECT EXISTS(SELECT 1 FROM cache.scan)", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(error)?;
        drop(publication);
        let result = f(&connection).map_err(error)?;
        connection.execute_batch("COMMIT").map_err(error)?;
        Ok(result)
    }
    /// Quick writers never queue behind a catalogue publication.
    pub(crate) fn try_write<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut connection = self.writer.try_lock().map_err(error)?;
        connection
            .busy_timeout(Duration::from_millis(25))
            .map_err(error)?;
        let result: Result<(T, i64, i64)> = (|| {
            let tx = connection.transaction().map_err(error)?;
            let before = catalogue_revision(&tx)?;
            let value = f(&tx)?;
            prune_unused_tags(&tx)?;
            let after = catalogue_revision(&tx)?;
            tx.commit().map_err(error)?;
            Ok((value, before, after))
        })();
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(error)?;
        drop(connection);
        let (value, before, after) = result?;
        self.notify_revision(before, after);
        Ok(value)
    }
    pub fn write<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut connection = self.writer.lock().map_err(error)?;
        let transaction = connection.transaction().map_err(error)?;
        let before = catalogue_revision(&transaction)?;
        let result = f(&transaction)?;
        prune_unused_tags(&transaction)?;
        let after = catalogue_revision(&transaction)?;
        transaction.commit().map_err(error)?;
        drop(connection);
        self.notify_revision(before, after);
        Ok(result)
    }
    /// Keep the caller's cancellation boundary locked through the SQL commit.
    pub(crate) fn write_guarded<T, G>(
        &self,
        f: impl FnOnce(&Transaction<'_>) -> Result<T>,
        boundary: impl FnOnce() -> Result<G>,
    ) -> Result<(T, G)> {
        let mut connection = self.writer.lock().map_err(error)?;
        let transaction = connection.transaction().map_err(error)?;
        let before = catalogue_revision(&transaction)?;
        let result = f(&transaction)?;
        let guard = boundary()?;
        prune_unused_tags(&transaction)?;
        let after = catalogue_revision(&transaction)?;
        transaction.commit().map_err(error)?;
        drop(connection);
        self.notify_revision(before, after);
        Ok((result, guard))
    }
    fn notify_revision(&self, before: i64, after: i64) {
        if after != before {
            if let Some(sink) = &self.change_sink {
                sink(after);
            }
        }
    }
    #[allow(dead_code)] // Used by the scan writer.
    pub fn read_cache<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let connection =
            Connection::open_with_flags(&self.cache_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(error)?;
        f(&connection).map_err(error)
    }
    #[allow(dead_code)] // Used by the scan writer.
    pub fn write_cache<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let _publication = self.writer.lock().map_err(error)?;
        let mut connection = self.cache_writer.lock().map_err(error)?;
        let tx = connection.transaction().map_err(error)?;
        let result = f(&tx)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }
}

fn catalogue_revision(connection: &Connection) -> Result<i64> {
    connection
        .query_row("SELECT revision FROM catalogue", [], |row| row.get(0))
        .map_err(error)
}

#[cfg(test)]
mod revision_notification_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn every_writer_notifies_only_after_a_changed_revision_is_committed() {
        let root = std::env::temp_dir().join(format!("catalogue-notify-{}", uuid::Uuid::new_v4()));
        let mut store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let path = store.durable_path.clone();
        store.change_sink = Some(Arc::new(move |revision| {
            // A separate reader sees the committed value, and the writer lock
            // has been released before any application callback is invoked.
            let mut reader = Connection::open(&path).unwrap();
            let tx = reader.transaction().unwrap();
            assert_eq!(catalogue_revision(&tx).unwrap(), revision);
            tx.execute("UPDATE catalogue SET revision=revision", [])
                .unwrap();
            tx.commit().unwrap();
            captured.lock().unwrap().push(revision);
        }));
        let initial = store.list_sources().unwrap().catalogue_revision;
        let advance = |tx: &Transaction<'_>| {
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            Ok(())
        };
        store.write(advance).unwrap();
        store.try_write(advance).unwrap();
        store.write_guarded(advance, || Ok(())).unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            vec![initial + 1, initial + 2, initial + 3]
        );
        store.write(|_| Ok(())).unwrap();
        store.try_write(|_| Ok(())).unwrap();
        store.write_guarded(|_| Ok(()), || Ok(())).unwrap();
        for quick in [false, true] {
            let failed = |tx: &Transaction<'_>| -> Result<()> {
                advance(tx)?;
                Err(error("rollback"))
            };
            assert!(if quick {
                store.try_write(failed)
            } else {
                store.write(failed)
            }
            .is_err());
        }
        assert!(store
            .write_guarded(advance, || Err::<(), _>(error("cancelled")))
            .is_err());
        assert_eq!(events.lock().unwrap().len(), 3);
        assert_eq!(
            store.list_sources().unwrap().catalogue_revision,
            initial + 3
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Memberships, including those of offline or retired fiches, alone own tags.
/// Run after all transfers in a durable transaction, never between delete/insert.
pub(crate) fn prune_unused_tags(c: &Connection) -> Result<()> {
    c.execute(
        "DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM tag_member WHERE tag_id=tag.id)",
        [],
    )
    .map_err(error)?;
    Ok(())
}

/// Ordered schema steps: step `i` brings a database to version `i + 1`. A
/// step already applied somewhere is never edited (its checksum is verified at
/// every opening); a schema change is a new step.
/// Exception: the unpublished MENAGE v3 was corrected in place (V3FIX).
const DURABLE_MIGRATIONS: &[&str] = &[
    include_str!("durable_v1.sql"),
    include_str!("durable_v2.sql"),
    include_str!("durable_v3.sql"),
    include_str!("durable_v4.sql"),
    include_str!("durable_v5.sql"),
    include_str!("durable_v6.sql"),
    include_str!("durable_v7.sql"),
    include_str!("durable_v8.sql"),
    include_str!("durable_v9.sql"),
    include_str!("durable_v10.sql"),
];
const CACHE_MIGRATIONS: &[&str] = &[include_str!("cache_v1.sql"), include_str!("cache_v2.sql")];
const UNPUBLISHED_DURABLE_V3_CHECKSUM: &str =
    "e3587350398b084e8eba4bd7f9ae8d2c8da55d0234faf95db387e298fbab8c80";

fn checksum(schema: &str) -> String {
    format!("{:x}", Sha256::digest(schema.as_bytes()))
}

fn open_database(
    path: &Path,
    migrations: &[&str],
    warnings: &mut Vec<UserMessage>,
) -> Result<Connection> {
    let latest = migrations.len() as i64;
    let mut connection = Connection::open(path).map_err(error)?;
    if let Ok(version) = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
    {
        if version > latest {
            return Err(UserMessage::new(codes::CATALOG_STORE_VERSION_UNSUPPORTED)
                .param("version", version));
        }
    }
    let integrity = connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0));
    match integrity {
        Ok(ref value) if value == "ok" => {}
        Ok(_) => {
            drop(connection);
            preserve_corrupt(path, warnings)?;
            connection = Connection::open(path).map_err(error)?;
        }
        Err(rusqlite::Error::SqliteFailure(ref e, _))
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            ) =>
        {
            drop(connection);
            preserve_corrupt(path, warnings)?;
            connection = Connection::open(path).map_err(error)?;
        }
        Err(e) => return Err(error(e)),
    }
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(error)?;
    if version > latest {
        return Err(
            UserMessage::new(codes::CATALOG_STORE_VERSION_UNSUPPORTED).param("version", version)
        );
    }
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(error)?;
    // Validate applied steps before running new ones: acknowledging the old
    // v3 checksum replays v3, which must never run after a later repair.
    for (index, schema) in migrations.iter().enumerate().take(version as usize) {
        let stored: String = connection
            .query_row(
                "SELECT checksum FROM migration WHERE version=?1",
                [index as i64 + 1],
                |r| r.get(0),
            )
            .map_err(error)?;
        if stored != checksum(schema) {
            // Only the known, unpublished v3 may be acknowledged in place,
            // and only if replaying its correction writes no durable row.
            // Otherwise rollback and retain the usual checksum refusal.
            if version == 3
                && index == 2
                && *schema == DURABLE_MIGRATIONS[2]
                && stored == UNPUBLISHED_DURABLE_V3_CHECKSUM
            {
                let tx = connection.transaction().map_err(error)?;
                let before = tx.total_changes();
                tx.execute_batch(schema).map_err(error)?;
                if tx.total_changes() != before {
                    return Err(error("Migration checksum mismatch"));
                }
                tx.execute(
                    "UPDATE migration SET checksum=?1 WHERE version=3",
                    [checksum(schema)],
                )
                .map_err(error)?;
                tx.commit().map_err(error)?;
                continue;
            }
            return Err(error("Migration checksum mismatch"));
        }
    }
    if version < latest {
        // Any existing content is copied before the first step; a failed step
        // rolls back and leaves the original untouched.
        let has_user_tables: bool = connection.query_row(
            "SELECT count(*) > 0 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r| r.get(0)).map_err(error)?;
        if has_user_tables {
            let recovery = path.parent().unwrap().join("recovery");
            std::fs::create_dir_all(&recovery).map_err(error)?;
            let backup_path = recovery.join(format!(
                "{}-v{version}-{}.sqlite",
                path.file_stem().unwrap().to_string_lossy(),
                uuid::Uuid::new_v4()
            ));
            let mut backup_connection = Connection::open(backup_path).map_err(error)?;
            rusqlite::backup::Backup::new(&connection, &mut backup_connection)
                .map_err(error)?
                .run_to_completion(128, Duration::from_millis(5), None)
                .map_err(error)?;
        }
        let tx = connection.transaction().map_err(error)?;
        for (index, schema) in migrations.iter().enumerate().skip(version as usize) {
            tx.execute_batch(schema).map_err(error)?;
            tx.execute(
                "INSERT INTO migration VALUES (?1, ?2, ?3)",
                rusqlite::params![index as i64 + 1, checksum(schema), now()],
            )
            .map_err(error)?;
            if index == 0 && schema.contains("CREATE TABLE catalogue") {
                tx.execute(
                    "INSERT INTO catalogue (id, revision) VALUES (?1, 0)",
                    [uuid::Uuid::new_v4().to_string()],
                )
                .map_err(error)?;
            }
        }
        let violations: i64 = tx
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .map_err(error)?;
        if violations != 0 {
            return Err(error("Migration foreign key violation"));
        }
        tx.commit().map_err(error)?;
    }
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(error)?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .map_err(error)?;
    Ok(connection)
}
fn preserve_corrupt(path: &Path, warnings: &mut Vec<UserMessage>) -> Result<()> {
    let target = path
        .parent()
        .unwrap()
        .join("recovery")
        .join(format!("corrupt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&target).map_err(error)?;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut source = path.as_os_str().to_os_string();
        source.push(suffix);
        let source = PathBuf::from(source);
        if source.exists() {
            std::fs::rename(&source, target.join(source.file_name().unwrap())).map_err(error)?;
        }
    }
    warnings.push(
        UserMessage::new(codes::CATALOG_STORE_CORRUPT)
            .param("path", crate::support::paths::path_for_frontend(target)),
    );
    Ok(())
}

fn prune_recovery(root: &Path, keep: usize) -> Result<()> {
    let mut entries = std::fs::read_dir(root)
        .map_err(error)?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(error)?;
    entries.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH),
        )
    });
    for entry in entries.into_iter().skip(keep) {
        if entry.file_type().map_err(error)?.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(error)?;
        } else {
            std::fs::remove_file(entry.path()).map_err(error)?;
        }
    }
    Ok(())
}

mod startup;
pub(crate) use startup::paths_overlap as startup_paths_overlap;

#[cfg(test)]
mod collection_removal_tests {
    use super::*;

    #[test]
    fn durable_v2_removes_populated_collections_and_preserves_tags() {
        let root = std::env::temp_dir().join(format!("catalogue-v2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("data/catalogue/catalogue.sqlite");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut warnings = vec![];
        let old = open_database(&path, &DURABLE_MIGRATIONS[..1], &mut warnings).unwrap();
        old.execute_batch(
            r#"INSERT INTO fiche VALUES ('card',1,1,2);
            INSERT INTO collection VALUES ('collection','Old','old',1);
            INSERT INTO collection_member VALUES ('collection','card');
            INSERT INTO fiche VALUES ('other',1,0,0);
            INSERT INTO collection_member VALUES ('collection','other');
            INSERT INTO operation VALUES ('group','groupCards','committed','v1-group',0,1,'{"outcome":{"undoToken":"v1-undo"}}');
            INSERT INTO association_event VALUES ('event','group','groupCards','{}',json_object(json_array('collection_member',json_array('collection','other')),json_array('collection','other')),'{}');
            INSERT INTO fiche_grouping VALUES ('other','card');
            DELETE FROM collection_member WHERE fiche_id='other';
            INSERT INTO undo_head VALUES (1,'group');
            INSERT INTO import_identity VALUES ('origin','collection','old','collection','{}');
            INSERT INTO import_identity VALUES ('origin','tag','old','tag','{}');
            INSERT INTO pending_import VALUES ('origin','digest','{"collections":[],"collectionMembers":[],"tags":[{"id":"tag"}]}');
            INSERT INTO tag VALUES ('tag','Kept','kept',1);
            INSERT INTO tag_member VALUES ('tag','card');"#,
        )
        .unwrap();
        let before: String = old
            .query_row("SELECT before_json FROM association_event", [], |r| {
                r.get(0)
            })
            .unwrap();
        let before: super::super::data::mutate::association::Snapshot =
            serde_json::from_str(&before).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(
            old.query_row("SELECT count(*) FROM undo_head", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(old);
        let current = open_database(&path, &DURABLE_MIGRATIONS[..2], &mut warnings).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(
            current
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(current.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('collection','collection_member','collection_member_fiche')", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(
            current
                .query_row(
                    "SELECT count(*) FROM tag_member WHERE tag_id='tag' AND fiche_id='card'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(current
            .query_row("SELECT favorite FROM fiche WHERE id='card'", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert_eq!(
            current
                .query_row(
                    "SELECT count(*) FROM import_identity WHERE entity_type='collection'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            current
                .query_row(
                    "SELECT count(*) FROM import_identity WHERE entity_type='tag'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let document: String = current
            .query_row("SELECT document_json FROM pending_import", [], |r| r.get(0))
            .unwrap();
        let document: serde_json::Value = serde_json::from_str(&document).unwrap();
        assert!(document.get("collections").is_none());
        assert!(document.get("collectionMembers").is_none());
        assert_eq!(document["tags"][0]["id"], "tag");
        drop(current);
        let store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
        assert!(store.last_undo().unwrap()["undoToken"].is_null());
        store
            .write(|tx| {
                tx.execute("UPDATE fiche SET favorite=0 WHERE id='card'", [])
                    .map_err(error)?;
                Ok(())
            })
            .unwrap();
        drop(store);
        // Reopening checks the unchanged v1 checksum and the new step as well.
        drop(open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap());
        let backup = std::fs::read_dir(path.parent().unwrap().join("recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                Connection::open(path)
                    .unwrap()
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap()
                    == 1
            })
            .expect("the v1 backup survives subsequent migration backups");
        let previous = Connection::open(backup).unwrap();
        assert_eq!(
            previous
                .query_row("SELECT count(*) FROM collection_member", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(previous);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod uuid_only_migration_tests {
    use super::*;

    // Compare every durable row, including receipts and revisions. Only the
    // migration ledger is allowed to change when upgrading a healthy database.
    fn contents(c: &Connection) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
        let tables = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'migration' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        tables
            .into_iter()
            .map(|table| {
                let mut statement = c
                    .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
                    .unwrap();
                let columns = statement.column_count();
                let rows = statement
                    .query_map([], |r| (0..columns).map(|i| r.get(i)).collect())
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                (table, rows)
            })
            .collect()
    }

    fn v4_fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(DURABLE_MIGRATIONS[0]).unwrap();
        c.execute_batch(DURABLE_MIGRATIONS[1]).unwrap();
        c.execute_batch(r#"
            INSERT INTO catalogue(id,revision) VALUES ('catalogue',0);
            INSERT INTO fiche VALUES ('source',1,1,7);
            INSERT INTO exemplar VALUES
              ('a','source',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,2),
              ('b','source',NULL,'{}','bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,3),
              ('copy','source',NULL,'{}',NULL,'{}',1,0,4),
              ('manual','source',NULL,'{}',NULL,'{}',1,0,5);
            INSERT INTO file_publication VALUES ('copy-path','token','source','copy','copy');
            INSERT INTO provenance(id,kind,exemplar_id) VALUES ('reference','file','copy'),('personal','manual',NULL);
            INSERT INTO image_asset VALUES ('image','image/png',12,'image.png');
            INSERT INTO reference_source VALUES ('source','copy',42,5);
            INSERT INTO reference_value VALUES
              ('source','title','','"Titre"','reference',NULL),
              ('source','cover','','"image"','reference','image');
            INSERT INTO correction VALUES ('source','title','','defined','"Retouche"','personal',NULL,1);
            INSERT INTO tag VALUES ('tag','Conservée','conservee',1);
            INSERT INTO tag_member VALUES ('tag','source');
        "#).unwrap();
        c
    }

    #[test]
    fn v4_repairs_v2_and_existing_v3_publications_preserving_data() {
        for existing_v3 in [false, true] {
            let root = std::env::temp_dir().join(format!("catalogue-v4-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("catalogue.sqlite");
            let c = v4_fixture();
            let before = contents(&c);
            let retained = |c: &Connection| {
                contents(c)
                    .into_iter()
                    .filter(|(table, _)| {
                        matches!(
                            table.as_str(),
                            "provenance"
                                | "image_asset"
                                | "correction"
                                | "tag"
                                | "tag_member"
                                | "file_publication"
                        )
                    })
                    .collect::<Vec<_>>()
            };
            let personal = retained(&c);
            // Exercise the actual opening path both from v2 and from an already
            // migrated v3 database, with the corresponding migration ledger.
            c.execute(
                "INSERT INTO migration VALUES (1,?1,1)",
                [checksum(DURABLE_MIGRATIONS[0])],
            )
            .unwrap();
            c.execute(
                "INSERT INTO migration VALUES (2,?1,1)",
                [checksum(DURABLE_MIGRATIONS[1])],
            )
            .unwrap();
            if existing_v3 {
                c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
                c.execute(
                    "INSERT INTO migration VALUES (3,?1,1)",
                    [checksum(DURABLE_MIGRATIONS[2])],
                )
                .unwrap();
                assert_ne!(
                    c.query_row("SELECT fiche_id FROM exemplar WHERE id='copy'", [], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap(),
                    "source"
                );
            }
            let mut disk = Connection::open(&path).unwrap();
            rusqlite::backup::Backup::new(&c, &mut disk)
                .unwrap()
                .run_to_completion(128, Duration::from_millis(5), None)
                .unwrap();
            drop(disk);
            let c = open_database(&path, DURABLE_MIGRATIONS, &mut vec![]).unwrap();
            assert_eq!(
                c.query_row("SELECT fiche_id FROM exemplar WHERE id='copy'", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                "source"
            );
            assert_ne!(
                c.query_row("SELECT fiche_id FROM exemplar WHERE id='manual'", [], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                "source"
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM fiche", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                3
            );
            assert_eq!(retained(&c), personal);
            for table in ["reference_source", "reference_value"] {
                assert_eq!(
                    contents(&c).into_iter().find(|(name, _)| name == table),
                    before.iter().find(|(name, _)| name == table).cloned()
                );
            }
            assert_eq!(
                c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                0
            );
            let repaired = contents(&c);
            let changes = c.total_changes();
            c.execute_batch(DURABLE_MIGRATIONS[3]).unwrap();
            assert_eq!(contents(&c), repaired);
            assert_eq!(c.total_changes(), changes);
            drop(c);
            // Replaying v4 rewinds user_version to 4: reopen at that version
            // instead of replaying later steps over their own columns.
            let reopened = open_database(&path, &DURABLE_MIGRATIONS[..4], &mut vec![]).unwrap();
            assert_eq!(contents(&reopened), repaired);
            drop(reopened);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn v4_preserves_cards_with_personal_values_or_additional_exemplars() {
        for edit in [
            "UPDATE fiche SET favorite=1 WHERE id=(SELECT fiche_id FROM exemplar WHERE id='copy')",
            "UPDATE fiche SET revision=1 WHERE id=(SELECT fiche_id FROM exemplar WHERE id='copy')",
            "INSERT INTO tag_member SELECT 'tag',fiche_id FROM exemplar WHERE id='copy'",
            "INSERT INTO correction SELECT fiche_id,'description','','cleared',NULL,'personal',NULL,1 FROM exemplar WHERE id='copy'",
            "INSERT INTO exemplar SELECT 'extra',fiche_id,NULL,'{}',NULL,'{}',1,0,6 FROM exemplar WHERE id='copy'",
        ] {
            let c = v4_fixture();
            c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
            c.execute_batch(edit).unwrap();
            let before = contents(&c);
            let changes = c.total_changes();
            c.execute_batch(DURABLE_MIGRATIONS[3]).unwrap();
            assert_eq!(contents(&c), before, "{edit}");
            assert_eq!(c.total_changes(), changes, "{edit}");
        }
    }

    #[test]
    fn v4_cleans_dependencies_without_reference_values() {
        let c = v4_fixture();
        c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
        let detached: String = c
            .query_row("SELECT fiche_id FROM exemplar WHERE id='copy'", [], |r| {
                r.get(0)
            })
            .unwrap();
        c.execute("DELETE FROM reference_value WHERE fiche_id=?1", [&detached])
            .unwrap();
        c.execute(
            "DELETE FROM reference_source WHERE fiche_id=?1",
            [&detached],
        )
        .unwrap();
        c.execute(
            "INSERT INTO pack_identity VALUES ('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',?1,'{}')",
            [&detached],
        )
        .unwrap();
        c.execute("INSERT INTO saved_pack_identity VALUES ('dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',?1,'{}')", [&detached]).unwrap();
        c.execute(
            "INSERT INTO fiche_grouping VALUES ('source',?1)",
            [&detached],
        )
        .unwrap();
        c.execute("INSERT INTO identity_convergence VALUES ('manual',?1,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}')", [&detached]).unwrap();
        c.execute(
            "INSERT INTO import_identity VALUES ('origin','card','remote',?1,'{}')",
            [&detached],
        )
        .unwrap();
        c.execute(
            "INSERT INTO lunii_filled(fiche_id) VALUES (?1)",
            [&detached],
        )
        .unwrap();
        c.execute_batch(DURABLE_MIGRATIONS[3]).unwrap();
        assert_eq!(
            c.query_row("SELECT fiche_id FROM exemplar WHERE id='copy'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "source"
        );
        for table in [
            "pack_identity",
            "saved_pack_identity",
            "fiche_grouping",
            "import_identity",
            "lunii_filled",
        ] {
            assert_eq!(
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table}"
            );
        }
        assert_eq!(
            c.query_row("SELECT known_fiche_id FROM identity_convergence", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "source"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[test]
    fn v4_preserves_conflicting_reference_receipts_and_publications() {
        for edit in [
            "INSERT INTO reference_value VALUES ('source','title','','\"Autre titre\"','reference',NULL)",
            "INSERT INTO reference_source VALUES ('source','a',99,1)",
            "INSERT INTO file_publication VALUES ('ambiguous','token',(SELECT fiche_id FROM exemplar WHERE id='b'),'copy','copy')",
        ] {
            let c = v4_fixture();
            c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
            c.execute_batch(edit).unwrap();
            let before = contents(&c);
            let changes = c.total_changes();
            c.execute_batch(DURABLE_MIGRATIONS[3]).unwrap();
            assert_eq!(contents(&c), before, "{edit}");
            assert_eq!(c.total_changes(), changes, "{edit}");
        }
    }

    #[test]
    fn v4_leaves_empty_and_healthy_databases_without_writes() {
        let c = Connection::open_in_memory().unwrap();
        for schema in &DURABLE_MIGRATIONS[..3] {
            c.execute_batch(schema).unwrap();
        }
        for populated in [false, true] {
            if populated {
                c.execute_batch(
                    r#"
                    INSERT INTO fiche VALUES ('healthy',1,0,0),('manual',1,0,0);
                    INSERT INTO exemplar VALUES
                      ('healthy','healthy',NULL,'{}',NULL,'{}',1,0,2),
                      ('manual','manual',NULL,'{}',NULL,'{}',1,0,3);
                    INSERT INTO file_publication VALUES ('path','token','healthy','healthy','copy');
                "#,
                )
                .unwrap();
            }
            let before = contents(&c);
            let changes = c.total_changes();
            c.execute_batch(DURABLE_MIGRATIONS[3]).unwrap();
            assert_eq!(contents(&c), before);
            assert_eq!(c.total_changes(), changes);
        }
    }

    #[test]
    fn v3_keeps_detached_reference_values_without_a_cache() {
        let root =
            std::env::temp_dir().join(format!("catalogue-v3-reference-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("catalogue.sqlite");
        let mut warnings = vec![];
        let old = open_database(&path, &DURABLE_MIGRATIONS[..2], &mut warnings).unwrap();
        old.execute_batch(r#"
            INSERT INTO fiche VALUES ('original',1,1,7);
            INSERT INTO exemplar VALUES
              ('a','original',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,2),
              ('b','original',NULL,'{}','bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,3),
              ('unknown','original',NULL,'{}',NULL,'{}',1,0,1);
            INSERT INTO pack_identity VALUES
              ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','original','{}'),
              ('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','original','{}');
            INSERT INTO provenance(id,kind,exemplar_id) VALUES ('reference','file','b'),('manual','manual',NULL);
            INSERT INTO reference_source VALUES ('original','b',42,5);
            INSERT INTO image_asset VALUES ('image','image/png',12,'image.png');
            INSERT INTO reference_value VALUES
              ('original','title','','"Titre B"','reference',NULL),
              ('original','description','fr','"Description B"','reference',NULL),
              ('original','description','it','"Descrizione B"','reference',NULL),
              ('original','cover','','"image"','reference','image');
            INSERT INTO correction VALUES ('original','title','','defined','"Retouche A"','manual',NULL,1);
            INSERT INTO tag VALUES ('tag','Conservée','conservee',1);
            INSERT INTO tag_member VALUES ('tag','original');
        "#).unwrap();
        let values = |c: &Connection| {
            c.prepare("SELECT field,language,value_json,provenance_id,image_sha256 FROM reference_value ORDER BY field,language")
                .unwrap()
                .query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?,r.get::<_, String>(3)?,r.get::<_, Option<String>>(4)?)))
                .unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let before = values(&old);
        drop(old);
        let c = open_database(&path, &DURABLE_MIGRATIONS[..3], &mut warnings).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(
            c.query_row("SELECT count(*) FROM fiche", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            c.query_row("SELECT fiche_id FROM exemplar WHERE id='a'", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "original"
        );
        assert_eq!(
            c.query_row("SELECT count(DISTINCT fiche_id) FROM exemplar", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            3
        );
        assert_eq!(values(&c), before);
        assert_eq!(c.query_row("SELECT count(*) FROM reference_value v JOIN exemplar e ON e.fiche_id=v.fiche_id WHERE e.id='b'", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
        assert_eq!(c.query_row("SELECT r.selected_at,r.revision FROM reference_source r JOIN exemplar e ON e.id=r.exemplar_id AND e.fiche_id=r.fiche_id WHERE e.id='b'", [], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, i64>(1)?))).unwrap(), (42,5));
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM fiche WHERE favorite=1 AND id='original'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(c.query_row("SELECT count(*) FROM correction WHERE fiche_id='original' AND value_json='\"Retouche A\"'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM tag_member WHERE fiche_id='original'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT sum(favorite) FROM fiche WHERE id<>'original'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        let migrated = contents(&c);
        // Rerun the SQL itself: reopening alone only validates the checksum.
        c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
        assert_eq!(contents(&c), migrated);
        drop(c);
        let reopened = open_database(&path, &DURABLE_MIGRATIONS[..3], &mut warnings).unwrap();
        assert_eq!(contents(&reopened), migrated);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v3_leaves_healthy_and_empty_databases_unchanged() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(DURABLE_MIGRATIONS[0]).unwrap();
        c.execute_batch(DURABLE_MIGRATIONS[1]).unwrap();
        c.execute_batch("INSERT INTO catalogue(id,revision) VALUES ('catalogue',17)")
            .unwrap();
        let empty = contents(&c);
        c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
        assert_eq!(contents(&c), empty);
        c.execute_batch(r#"
            INSERT INTO fiche VALUES ('single',1,1,7),('unknown',2,0,3),('alias',3,0,0);
            INSERT INTO exemplar VALUES
              ('a','single',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,2),
              ('same','single',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,3),
              ('unknown','unknown',NULL,'{}',NULL,'{}',1,0,NULL);
            INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','single','{}');
            INSERT INTO saved_pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','single','{}');
            INSERT INTO provenance(id,kind) VALUES ('manual','manual');
            INSERT INTO reference_source VALUES ('single','a',1,1);
            INSERT INTO reference_value VALUES ('single','title','','"Titre"','manual',NULL);
            INSERT INTO correction VALUES ('single','title','','defined','"Retouche"','manual',NULL,1);
            INSERT INTO tag VALUES ('tag','Conservée','conservee',1);
            INSERT INTO tag_member VALUES ('tag','single');
            INSERT INTO fiche_grouping VALUES ('alias','single');
            INSERT INTO operation VALUES ('group','groupCards','committed','group',0,1,'{}');
            INSERT INTO undo_head VALUES (1,'group');
            INSERT INTO suggestion_decision VALUES ('decision','[]','{}','refused','group');
            PRAGMA user_version=2;
        "#).unwrap();
        let healthy = contents(&c);
        let changes = c.total_changes();
        c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
        assert_eq!(contents(&c), healthy);
        assert_eq!(c.total_changes(), changes);
        c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
        assert_eq!(contents(&c), healthy);
        assert_eq!(c.total_changes(), changes);
    }

    #[test]
    fn v4_recognizes_unpublished_v3_before_repairing_publication() {
        let root = std::env::temp_dir().join(format!(
            "catalogue-v4-old-checksum-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("catalogue.sqlite");
        let c = v4_fixture();
        c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
        for (index, schema) in DURABLE_MIGRATIONS[..3].iter().enumerate() {
            let stored = if index == 2 {
                UNPUBLISHED_DURABLE_V3_CHECKSUM.to_string()
            } else {
                checksum(schema)
            };
            c.execute(
                "INSERT INTO migration VALUES (?1,?2,42)",
                rusqlite::params![index as i64 + 1, stored],
            )
            .unwrap();
        }
        assert_ne!(
            c.query_row("SELECT fiche_id FROM exemplar WHERE id='copy'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "source"
        );
        let mut disk = Connection::open(&path).unwrap();
        rusqlite::backup::Backup::new(&c, &mut disk)
            .unwrap()
            .run_to_completion(128, Duration::from_millis(5), None)
            .unwrap();
        drop(disk);
        let mut warnings = vec![];
        let c = open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap();
        assert_eq!(
            c.query_row("SELECT fiche_id FROM exemplar WHERE id='copy'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "source"
        );
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            c.query_row(
                "SELECT checksum,applied_at FROM migration WHERE version=3",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
            (checksum(DURABLE_MIGRATIONS[2]), 42)
        );
        let repaired = contents(&c);
        drop(c);
        let reopened = open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap();
        assert_eq!(reopened.total_changes(), 0);
        assert_eq!(contents(&reopened), repaired);
        assert_eq!(
            reopened
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert!(warnings.is_empty());
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v3_acknowledges_only_the_known_unpublished_checksum_with_no_rows_to_change() {
        // Fingerprint from the original source, not the corrected migration:
        // git show 5e41db14:src-tauri/src/services/catalogue/store/durable_v3.sql
        let original_checksum = "e3587350398b084e8eba4bd7f9ae8d2c8da55d0234faf95db387e298fbab8c80";
        for (stored, mixed) in [
            (original_checksum, false),
            ("unknown", false),
            (original_checksum, true),
        ] {
            let root = std::env::temp_dir()
                .join(format!("catalogue-v3-checksum-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("catalogue.sqlite");
            let mut warnings = vec![];
            let old = open_database(&path, &DURABLE_MIGRATIONS[..2], &mut warnings).unwrap();
            old.execute_batch(r#"
                INSERT INTO fiche VALUES ('single',1,1,7);
                INSERT INTO exemplar VALUES ('a','single',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,2);
                PRAGMA user_version=3;
            "#).unwrap();
            old.execute("INSERT INTO migration VALUES (3,?1,42)", [stored])
                .unwrap();
            if mixed {
                old.execute_batch("INSERT INTO exemplar VALUES ('b','single',NULL,'{}','bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,3)").unwrap();
            }
            let before = contents(&old);
            drop(old);
            let opened = open_database(&path, &DURABLE_MIGRATIONS[..3], &mut warnings);
            let expected_checksum = if stored == original_checksum && !mixed {
                drop(opened.unwrap());
                checksum(DURABLE_MIGRATIONS[2])
            } else {
                assert!(opened.is_err());
                stored.to_string()
            };
            let c = Connection::open(&path).unwrap();
            assert_eq!(contents(&c), before);
            assert_eq!(
                c.query_row(
                    "SELECT checksum,applied_at FROM migration WHERE version=3",
                    [],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                )
                .unwrap(),
                (expected_checksum, 42)
            );
            drop(c);
            if stored == original_checksum && !mixed {
                drop(open_database(&path, &DURABLE_MIGRATIONS[..3], &mut warnings).unwrap());
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn v3_breaks_uuid_age_ties_deterministically_and_handles_missing_dates() {
        for reverse in [false, true] {
            let c = Connection::open_in_memory().unwrap();
            c.execute_batch(DURABLE_MIGRATIONS[0]).unwrap();
            c.execute_batch(DURABLE_MIGRATIONS[1]).unwrap();
            c.execute_batch("INSERT INTO fiche VALUES ('tie',2,1,0),('fallback',2,1,0)")
                .unwrap();
            let mut entries = [
                ("b", "tie", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", Some(2)),
                ("a", "tie", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", Some(2)),
                (
                    "null",
                    "fallback",
                    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    None,
                ),
                (
                    "dated",
                    "fallback",
                    "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    Some(3),
                ),
            ];
            if reverse {
                entries.reverse();
            }
            for (id, card, uuid, date) in entries {
                c.execute(
                    "INSERT INTO exemplar VALUES (?1,?2,NULL,'{}',?3,'{}',1,0,?4)",
                    rusqlite::params![id, card, uuid, date],
                )
                .unwrap();
            }
            c.execute_batch(DURABLE_MIGRATIONS[2]).unwrap();
            for (id, expected) in [("a", "tie"), ("null", "fallback")] {
                assert_eq!(
                    c.query_row("SELECT fiche_id FROM exemplar WHERE id=?1", [id], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap(),
                    expected
                );
            }
        }
    }

    #[test]
    fn v3_splits_legacy_cards_preserves_personal_data_and_reopens_idempotently() {
        let root = std::env::temp_dir().join(format!("catalogue-menage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("catalogue.sqlite");
        let mut warnings = vec![];
        let old = open_database(&path, &DURABLE_MIGRATIONS[..2], &mut warnings).unwrap();
        old.execute_batch(r#"
            INSERT INTO fiche VALUES ('original',1,1,7),('legacy',1,1,3),('single',1,0,0),('archived',1,1,0);
            INSERT INTO provenance(id,kind) VALUES ('personal','manual');
            INSERT INTO correction VALUES ('original','title','','defined','"Retouche"','personal',NULL,1);
            INSERT INTO tag VALUES ('tag','Conservée','conservee',1);
            INSERT INTO tag_member VALUES ('tag','original');
            INSERT INTO exemplar VALUES
              ('oldest','original',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,2),
              ('same','original',NULL,'{}','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,5),
              ('other','original',NULL,'{}','bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','{}',1,0,3),
              ('unknown','original',NULL,'{}',NULL,'{}',1,0,1),
              ('legacy-a','legacy',NULL,'{}',NULL,'{}',1,0,2),
              ('legacy-b','legacy',NULL,'{}',NULL,'{}',1,0,3),
              ('single','single',NULL,'{}',NULL,'{}',1,0,4);
            INSERT INTO pack_identity VALUES
              ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','original','{}'),
              ('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','original','{}');
            INSERT INTO saved_pack_identity VALUES
              ('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee','archived','{}'),
              ('dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee','archived','{}');
            INSERT INTO reference_source VALUES ('original','other',1,1);
            INSERT INTO operation VALUES ('bulk','bulkSetMetadata','committed','bulk',0,1,'{}');
            INSERT INTO undo_head VALUES (1,'bulk');
        "#).unwrap();
        drop(old);
        let current = open_database(&path, &DURABLE_MIGRATIONS[..3], &mut warnings).unwrap();
        let owner = |id: &str| {
            current
                .query_row("SELECT fiche_id FROM exemplar WHERE id=?1", [id], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap()
        };
        assert_eq!(owner("oldest"), "original");
        assert_eq!(owner("same"), "original");
        assert_ne!(owner("other"), "original");
        assert_ne!(owner("unknown"), "original");
        assert_ne!(owner("unknown"), owner("other"));
        assert_eq!(owner("legacy-a"), "legacy");
        assert_ne!(owner("legacy-b"), "legacy");
        assert_eq!(owner("single"), "single");
        assert_eq!(
            current
                .query_row(
                    "SELECT fiche_id FROM pack_identity WHERE pack_uuid LIKE 'bbbb%'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            owner("other")
        );
        assert_eq!(
            current
                .query_row(
                    "SELECT count(*) FROM correction WHERE fiche_id='original'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            current
                .query_row(
                    "SELECT count(*) FROM tag_member WHERE fiche_id='original'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(current
            .query_row("SELECT favorite FROM fiche WHERE id='original'", [], |r| {
                r.get::<_, bool>(0)
            })
            .unwrap());
        assert_eq!(
            current
                .query_row("SELECT count(*) FROM fiche WHERE favorite=1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            current
                .query_row("SELECT count(*) FROM reference_source", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            current
                .query_row("SELECT operation_id FROM undo_head", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "bulk"
        );
        assert_eq!(
            current
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        assert_eq!(
            current
                .query_row(
                    "SELECT count(DISTINCT fiche_id) FROM saved_pack_identity",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        let count: i64 = current
            .query_row("SELECT count(*) FROM fiche", [], |r| r.get(0))
            .unwrap();
        drop(current);
        let reopened = open_database(&path, &DURABLE_MIGRATIONS[..3], &mut warnings).unwrap();
        assert_eq!(
            reopened
                .query_row("SELECT count(*) FROM fiche", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            count
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod tag_lifetime_tests {
    use super::*;

    #[test]
    fn opening_repairs_unused_tags_once_and_ignores_unknown_operation_kinds() {
        let root = std::env::temp_dir().join(format!("catalogue-tags-{}", uuid::Uuid::new_v4()));
        let path = root.join("data/catalogue/catalogue.sqlite");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let old = open_database(&path, &DURABLE_MIGRATIONS[..9], &mut vec![]).unwrap();
        old.execute_batch("INSERT INTO fiche VALUES ('kept',0,0,0); INSERT INTO tag VALUES ('used','Used','used',1),('unused','Unused','unused',1); INSERT INTO tag_member VALUES ('used','kept'); INSERT INTO operation VALUES ('unknown','futureMutation','committed','unknown',0,0,'{}');").unwrap();
        drop(old);
        let c = open_database(&path, DURABLE_MIGRATIONS, &mut vec![]).unwrap();
        assert_eq!(
            c.query_row("SELECT id FROM tag", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "used"
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM operation WHERE kind='futureMutation'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(c);
        let c = open_database(&path, DURABLE_MIGRATIONS, &mut vec![]).unwrap();
        assert_eq!(c.total_changes(), 0, "no repair is replayed at reopening");
        drop(c);
        let store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
        assert!(
            store.warnings.is_empty(),
            "unknown journal kinds do not block recovery"
        );
        assert_eq!(store.list_tags().unwrap()["items"][0]["id"], "used");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_durable_writer_prunes_after_transfers_and_rolls_back_on_failure() {
        for writer in ["write", "try_write", "write_guarded"] {
            let root =
                std::env::temp_dir().join(format!("catalogue-tags-{}", uuid::Uuid::new_v4()));
            let store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
            store.write(|tx| {
                tx.execute_batch("INSERT INTO fiche VALUES ('a',0,0,0),('b',0,0,0); INSERT INTO tag VALUES ('tag','Tag','tag',1); INSERT INTO tag_member VALUES ('tag','a');").map_err(error)
            }).unwrap();
            let transfer = |tx: &Transaction<'_>| {
                tx.execute_batch(
                    "DELETE FROM tag_member; INSERT INTO tag_member VALUES ('tag','b');",
                )
                .map_err(error)
            };
            match writer {
                "write" => store.write(transfer).unwrap(),
                "try_write" => store.try_write(transfer).unwrap(),
                _ => {
                    store.write_guarded(transfer, || Ok(())).unwrap();
                }
            }
            assert_eq!(store.list_tags().unwrap()["items"][0]["count"], 1);
            // A failure after removal never commits either the removal or its cleanup.
            assert!(store
                .write(|tx| -> Result<()> {
                    tx.execute("DELETE FROM tag_member", []).map_err(error)?;
                    Err(error("forced rollback"))
                })
                .is_err());
            assert_eq!(store.list_tags().unwrap()["items"][0]["count"], 1);
            store.write(|tx| tx.execute_batch("CREATE TRIGGER reject_tag_cleanup BEFORE DELETE ON tag BEGIN SELECT RAISE(ABORT,'cleanup failure'); END;").map_err(error)).unwrap();
            let fail_cleanup =
                |tx: &Transaction<'_>| tx.execute_batch("DELETE FROM tag_member").map_err(error);
            let result = match writer {
                "write" => store.write(fail_cleanup),
                "try_write" => store.try_write(fail_cleanup),
                _ => store.write_guarded(fail_cleanup, || Ok(())).map(|_| ()),
            };
            assert!(result.is_err());
            assert_eq!(
                store.list_tags().unwrap()["items"][0]["count"],
                1,
                "failed cleanup rolls back membership removal too"
            );
            store
                .write(|tx| {
                    tx.execute_batch("DROP TRIGGER reject_tag_cleanup")
                        .map_err(error)
                })
                .unwrap();
            let remove = |tx: &Transaction<'_>| {
                tx.execute_batch(
                    "DELETE FROM tag_member WHERE fiche_id='b'; DELETE FROM fiche WHERE id='b'",
                )
                .map_err(error)
            };
            match writer {
                "write" => store.write(remove).unwrap(),
                "try_write" => store.try_write(remove).unwrap(),
                _ => {
                    store.write_guarded(remove, || Ok(())).unwrap();
                }
            }
            assert!(store.list_tags().unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty());
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(test)]
mod author_migration_tests {
    use super::*;
    #[test]
    fn catalogue_v5_opens_v4_without_losing_official_values_or_consent() {
        let dir = std::env::temp_dir().join(format!("catalogue-v5-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("catalogue.sqlite");
        let mut warnings = vec![];
        let c = open_database(&path, &DURABLE_MIGRATIONS[..4], &mut warnings).unwrap();
        c.execute_batch("INSERT INTO fiche VALUES ('kept',1,1,7); INSERT INTO lunii_filled VALUES ('kept'); INSERT INTO lunii_state VALUES (1,123,'network'); INSERT INTO lunii_pack VALUES ('known','{\"localized_infos\":{\"fr_FR\":{\"title\":\"Test\"}}}'); UPDATE lunii_permission SET allowed=0; INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR'); INSERT INTO reference_value VALUES ('kept','title','@lunii:fr_FR','\"Test\"','official',NULL);").unwrap();
        let checksums: Vec<String> = c
            .prepare("SELECT checksum FROM migration ORDER BY version")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        drop(c);
        let c = open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT author_checked FROM lunii_filled WHERE fiche_id='kept'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT projection_version FROM lunii_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!c
            .query_row("SELECT allowed FROM lunii_permission", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert_eq!(
            c.query_row(
                "SELECT value_json FROM reference_value WHERE fiche_id='kept'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "\"Test\""
        );
        assert_eq!(
            c.query_row("SELECT revision FROM fiche WHERE id='kept'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        let current: Vec<String> = c
            .prepare("SELECT checksum FROM migration WHERE version<=4 ORDER BY version")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(checksums, current);
        drop(c);
        drop(open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap());
        assert!(warnings.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod language_migration_tests {
    use super::*;

    #[test]
    fn catalogue_v6_opens_v5_preserving_markers_values_and_checksums() {
        let dir = std::env::temp_dir().join(format!("catalogue-v6-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("catalogue.sqlite");
        let mut warnings = vec![];
        let c = open_database(&path, &DURABLE_MIGRATIONS[..5], &mut warnings).unwrap();
        c.execute_batch("INSERT INTO fiche VALUES ('kept',1,1,7),('pending',0,0,3); INSERT INTO lunii_filled VALUES ('kept',1),('pending',0); INSERT INTO lunii_state VALUES (1,123,'network',2); UPDATE lunii_permission SET allowed=0; INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR'); INSERT INTO reference_value VALUES ('kept','author','@lunii:fr_FR','\"Author\"','official',NULL);").unwrap();
        let rows = |c: &Connection| -> Vec<(i64, String)> {
            c.prepare("SELECT version,checksum FROM migration WHERE version<=5 ORDER BY version")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let checksums = rows(&c);
        drop(c);
        let c = open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap();
        assert_eq!(rows(&c), checksums);
        let markers: Vec<(String, i64, String)> = c
            .prepare(
                "SELECT fiche_id,author_checked,checked_fields FROM lunii_filled ORDER BY fiche_id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            markers,
            vec![
                ("kept".into(), 1, "[]".into()),
                ("pending".into(), 0, "[]".into())
            ]
        );
        assert_eq!(
            c.query_row("SELECT projection_version FROM lunii_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(!c
            .query_row("SELECT allowed FROM lunii_permission", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert_eq!(
            c.query_row(
                "SELECT value_json FROM reference_value WHERE fiche_id='kept'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "\"Author\""
        );
        assert_eq!(
            c.query_row("SELECT revision FROM fiche WHERE id='kept'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        drop(c);
        drop(open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap());
        assert!(warnings.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn catalogue_v7_drops_only_void_language_markers() {
        let dir = std::env::temp_dir().join(format!("catalogue-v7-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("catalogue.sqlite");
        let mut warnings = vec![];
        let c = open_database(&path, &DURABLE_MIGRATIONS[..6], &mut warnings).unwrap();
        c.execute_batch(r#"INSERT INTO fiche VALUES ('marked',0,0,4),('other',0,0,5),('empty',0,0,6); INSERT INTO lunii_filled VALUES ('marked',1,'["language"]'),('other',0,'["future","language",{"k":1}]'),('empty',1,'[]'); INSERT INTO lunii_state VALUES (1,123,'network',3); INSERT INTO provenance(id,kind) VALUES ('local','file'); INSERT INTO correction(fiche_id,field,state,value_json,provenance_id,revision) VALUES ('marked','language','defined','"de"','local',1); INSERT INTO reference_value VALUES ('marked','author','','"Author"','local',NULL);"#).unwrap();
        let rows = |c: &Connection| -> Vec<(i64, String)> {
            c.prepare("SELECT version,checksum FROM migration WHERE version<=6 ORDER BY version")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let checksums = rows(&c);
        drop(c);
        let c = open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap();
        assert_eq!(rows(&c), checksums);
        let markers: Vec<(String, i64, String)> = c
            .prepare(
                "SELECT fiche_id,author_checked,checked_fields FROM lunii_filled ORDER BY fiche_id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            markers,
            vec![
                ("empty".into(), 1, "[]".into()),
                ("marked".into(), 1, "[]".into()),
                ("other".into(), 0, r#"["future",{"k":1}]"#.into())
            ]
        );
        for (table, expected) in [("correction", "\"de\""), ("reference_value", "\"Author\"")] {
            assert_eq!(
                c.query_row(
                    &format!("SELECT value_json FROM {table} WHERE fiche_id='marked'"),
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                expected
            );
        }
        assert_eq!(
            c.query_row("SELECT projection_version FROM lunii_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        drop(c);
        let reopened = open_database(&path, DURABLE_MIGRATIONS, &mut warnings).unwrap();
        assert_eq!(reopened.total_changes(), 0);
        drop(reopened);
        assert!(warnings.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod repatriated_migration_tests {
    use super::*;
    #[test]
    fn repatriated_v9_preserves_existing_source_health_and_foreign_keys() {
        let root = std::env::temp_dir().join(format!("catalogue-v9-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("durable.sqlite");
        let old = open_database(&path, &DURABLE_MIGRATIONS[..8], &mut vec![]).unwrap();
        old.execute_batch("INSERT INTO source VALUES ('s',x'2f',x'2f','manual','removed',7,NULL); INSERT INTO source_health(source_id,availability) VALUES ('s','unavailable');").unwrap();
        drop(old);
        let current = open_database(&path, DURABLE_MIGRATIONS, &mut vec![]).unwrap();
        assert_eq!(
            current
                .query_row(
                    "SELECT origin,status,revision FROM source WHERE id='s'",
                    [],
                    |r| Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?
                    ))
                )
                .unwrap(),
            ("manual".into(), "removed".into(), 7)
        );
        assert_eq!(
            current
                .query_row(
                    "SELECT availability FROM source_health WHERE source_id='s'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "unavailable"
        );
        assert!(current
            .execute(
                "INSERT INTO source_health(source_id,availability) VALUES ('missing','unknown')",
                []
            )
            .is_err());
        current.execute("INSERT INTO source VALUES ('internal',x'2f61',x'2f61','repatriated','active',8,NULL)", []).unwrap();
        drop(current);
        let reopened = open_database(&path, DURABLE_MIGRATIONS, &mut vec![]).unwrap();
        assert_eq!(
            reopened
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
