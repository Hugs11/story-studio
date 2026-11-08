//! Headless bridge for device sidecars. No catalogue opening or network lookup.
use super::{data, store::Store};
use crate::services::storyteller_device::{
    cards::{reduced_cover, Card, CardCatalogue, CatalogueCard},
    Error, Result,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use uuid::Uuid;

const CARD_ID_SQL: &str = "SELECT COALESCE(g.target_id,p.fiche_id) FROM pack_identity p LEFT JOIN fiche_grouping g ON g.fiche_id=p.fiche_id WHERE p.pack_uuid=?1 AND NOT EXISTS(SELECT 1 FROM fiche_forgotten f WHERE f.fiche_id=COALESCE(g.target_id,p.fiche_id))";
fn card_id(c: &rusqlite::Connection, id: Uuid) -> rusqlite::Result<Option<String>> {
    c.query_row(CARD_ID_SQL, [id.to_string()], |r| r.get(0))
        .optional()
}
impl CardCatalogue for Store {
    fn official_title(&self, id: Uuid) -> Result<Option<String>> {
        self.read(|c| {
            let raw: Option<String> = c
                .query_row(
                    "SELECT document_json FROM lunii_pack WHERE uuid=?1",
                    [id.to_string()],
                    |r| r.get(0),
                )
                .optional()?;
            let locale: String =
                c.query_row("SELECT locale FROM lunii_context WHERE id=1", [], |r| {
                    r.get(0)
                })?;
            Ok(raw
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| super::lunii_db::parse::localized(&v, &locale))
                .and_then(|(_, v)| {
                    v["title"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_owned)
                }))
        })
        .map_err(|_| Error::Io)
    }
    fn card(&self, id: Uuid) -> Result<Option<CatalogueCard>> {
        let data = self
            .read_snapshot(|c| {
                let Some(fiche) = card_id(c, id)? else {
                    return Ok(None);
                };
                let Some(snapshot) = data::card::snapshot(c, &fiche)? else {
                    return Ok(None);
                };
                let signature = super::thumbnails::fiche_cover_keys(c, &fiche)?.signature;
                Ok(Some((fiche, snapshot, signature)))
            })
            .map_err(|_| Error::Io)?;
        let Some((fiche, snapshot, signature)) = data else {
            return Ok(None);
        };
        let field = |key: &str| {
            snapshot["fields"]
                .as_array()
                .and_then(|a| a.iter().find(|f| f["field"] == key))
                .map(|f| f["effective"]["value"].clone())
                .unwrap_or(Value::Null)
        };
        let Some(title) = field("title")
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
        else {
            return Ok(None);
        };
        let (cover_png, cover_pending) = cover(
            self.served_cover(&fiche, &signature)
                .map_err(|_| Error::Io)?,
        );
        Ok(Some(CatalogueCard {
            cover_pending,
            card: Card {
                title,
                description: field("description").as_str().unwrap_or("").into(),
                age_min: field("ageMin").as_u64().and_then(|n| u32::try_from(n).ok()),
                age_max: field("ageMax").as_u64().and_then(|n| u32::try_from(n).ok()),
                cover_png,
            },
        }))
    }
    fn save_name(&self, id: Uuid, title: &str) -> Result<()> {
        let snapshot = self
            .read_snapshot(|c| {
                let Some(fiche) = card_id(c, id)? else {
                    return Ok(None);
                };
                let revision: i64 =
                    c.query_row("SELECT revision FROM fiche WHERE id=?1", [&fiche], |r| {
                        r.get(0)
                    })?;
                let catalogue: i64 =
                    c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
                Ok(Some((fiche, revision, catalogue)))
            })
            .map_err(|_| Error::Io)?;
        let Some((fiche, revision, catalogue)) = snapshot else {
            return Ok(());
        };
        self.mutate(
            data::journal::Mutation::Metadata {
                request_key: Uuid::new_v4().to_string(),
                fiche_id: fiche,
                expected_fiche_revision: revision,
                change: data::mutate::metadata::Change {
                    field: "title".into(),
                    language: None,
                    state: "defined".into(),
                    value: Some(json!(title)),
                    cover_staging_id: None,
                },
            },
            catalogue,
        )
        .map_err(|_| Error::Io)?;
        Ok(())
    }
}

fn cover(served: super::cover_store::Served) -> (Option<Vec<u8>>, bool) {
    use super::cover_store::Served;
    match served {
        Served::Ready(bytes) => match reduced_cover(&bytes) {
            Ok(bytes) => (Some(bytes), false),
            Err(_) => (None, true),
        },
        Served::Absent => (None, false),
        _ => (None, true),
    }
}
/// Owns only the fixed child it created, never a pre-existing directory.
/// Held across reconstruction so failure/cancellation also cleans an empty child.
pub(crate) struct RepatriationTarget {
    pub directory: std::path::PathBuf,
    created: bool,
}
impl Drop for RepatriationTarget {
    fn drop(&mut self) {
        if self.created {
            let _ = std::fs::remove_dir(&self.directory);
        }
    }
}
impl RepatriationTarget {
    pub(crate) fn prepare(workspace: &std::path::Path) -> super::Result<Self> {
        let owned = workspace.to_owned();
        super::probe::bounded(workspace, super::probe::PROBE_TIMEOUT, move || {
            Self::prepare_on_disk(&owned)
        })
        .unwrap_or_else(|| {
            Err(crate::support::user_message::UserMessage::new(
                crate::support::user_message::codes::STORYTELLER_WORKSPACE_UNAVAILABLE,
            ))
        })
    }

    fn prepare_on_disk(workspace: &std::path::Path) -> super::Result<Self> {
        let unavailable = |_| {
            crate::support::user_message::UserMessage::new(
                crate::support::user_message::codes::STORYTELLER_WORKSPACE_UNAVAILABLE,
            )
        };
        if !workspace.is_absolute() || !workspace.is_dir() {
            return Err(unavailable(()));
        }
        let workspace = std::fs::canonicalize(workspace).map_err(|_| unavailable(()))?;
        let directory = workspace.join("packs-rapatries");
        let created = match std::fs::create_dir(&directory) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(_) => return Err(unavailable(())),
        };
        let target = Self { directory, created };
        // A fixed child must not redirect writes outside the workspace.
        let resolved = std::fs::canonicalize(&target.directory).map_err(|_| unavailable(()))?;
        if !resolved.is_dir() || resolved.parent() != Some(workspace.as_path()) {
            return Err(unavailable(()));
        }
        // Test real write access before the long reconstruction, on the target volume.
        let probe = crate::services::storyteller::Scratch::new(&target.directory)
            .map_err(|_| unavailable(()))?;
        std::fs::write(probe.0.join("probe"), b"1").map_err(|_| unavailable(()))?;
        drop(probe);
        Ok(target)
    }
}

// Keep room for collision suffixes and the extension, including on UTF-8 filesystems.
fn repatriated_stem(title: &str, id: Uuid) -> String {
    let cleaned = crate::native_pack::sanitized_project_name(title);
    let mut stem = String::new();
    if title.chars().any(char::is_alphanumeric) {
        for ch in cleaned.chars().take(100) {
            if stem.len() + ch.len_utf8() > 200 {
                break;
            }
            stem.push(ch);
        }
    }
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.chars().any(char::is_alphanumeric) {
        stem.to_owned()
    } else {
        format!("Pack-rapatrie-{}", &id.to_string()[..8])
    }
}

impl Store {
    /// Uses the ordinary scan observation and identity/grouping publication.
    /// This durable directory is outside the disposable catalogue/cache trees.
    pub(crate) fn publish_repatriated_story(
        &self,
        zip: &std::path::Path,
        id: Uuid,
        workspace: &std::path::Path,
        archive_name: &str,
    ) -> super::Result<(String, i64)> {
        let _heavy = self.scans.heavy.lock().map_err(super::store::error)?;
        if self.device_card_link(id)?.is_some() {
            return Err(crate::support::user_message::UserMessage::new(
                crate::support::user_message::codes::STORYTELLER_ALREADY_IN_CATALOGUE,
            ));
        }
        let target = RepatriationTarget::prepare(workspace)?;
        (|| {
            let directory =
                std::fs::canonicalize(&target.directory).map_err(super::store::error)?;
            // Copy and sync on the destination volume before exclusive publication.
            let scratch = crate::services::storyteller::Scratch::new(&directory)?;
            let temporary = scratch.0.join("pack.tmp");
            std::fs::copy(zip, &temporary).map_err(super::store::error)?;
            crate::support::file_sync::sync_file(&temporary).map_err(super::store::error)?;
            use sha2::{Digest, Sha256};
            let source = format!(
                "repatriated-{:x}",
                Sha256::digest(super::path_identity::key(&directory))
            );
            let stem = repatriated_stem(archive_name, id);
            let temporary_id = super::writes::file_id(&temporary);
            let mut index = 1u64;
            let (path, publication) = loop {
                if index > 1000 {
                    return Err(super::store::error(
                        "repatriation filename collision limit reached",
                    ));
                }
                let suffix = if index == 1 {
                    String::new()
                } else {
                    format!(" ({index})")
                };
                let path = directory.join(format!("{stem}{suffix}.zip"));
                if path.symlink_metadata().is_ok() {
                    index += 1;
                    continue;
                }
                let publication = super::files::publish::no_replace(&temporary, &path);
                if publication.is_err()
                    && temporary.exists()
                    && path.symlink_metadata().is_ok()
                    && super::writes::file_id(&path) != temporary_id
                {
                    index += 1;
                    continue;
                }
                break (path, publication);
            };
            if let Err(error) = publication {
                // A rename can succeed before its directory sync fails. Remove
                // only our own file, never a rival that exclusive rename refused.
                if temporary_id.is_some() && super::writes::file_id(&path) == temporary_id {
                    let _ = std::fs::remove_file(&path);
                }
                return Err(error);
            }
            let mut indexed = false;
            let result = (|| {
                let cancel = std::sync::atomic::AtomicBool::new(false);
                let items = super::scan::observe(
                    &source,
                    &path,
                    &super::scan::token(&path),
                    &cancel,
                    &self.activity,
                    true,
                );
                if items.len() != 1 || items[0].observation.state != "available" {
                    return Err(super::store::error(
                        "repatriated archive observation refused",
                    ));
                }
                let published = self.publish_repatriated_items(&directory, &source, &items)?;
                indexed = true;
                let fiche = self
                    .device_card_link(id)?
                    .ok_or_else(|| super::store::error("missing repatriated identity"))?
                    .0;
                Ok((fiche, published.revision))
            })();
            if result.is_err() && !indexed {
                let _ = std::fs::remove_file(path);
            }
            result
        })()
    }
    pub(crate) fn device_card_link(
        &self,
        id: Uuid,
    ) -> super::Result<Option<(String, Option<f64>, String)>> {
        self.read_snapshot(|c| {
            let Some(fiche) = card_id(c, id)? else {
                return Ok(None);
            };
            // Trash retains identity/metadata for restoration. That history is
            // not a catalogue copy and must not prevent device acquisition.
            // Offline, non-retired copies still count as present.
            let present: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM exemplar WHERE fiche_id=?1 AND retired=0)",
                [&fiche],
                |r| r.get(0),
            )?;
            if !present {
                return Ok(None);
            }
            let snapshot = data::card::snapshot(c, &fiche)?.unwrap_or(Value::Null);
            let duration = snapshot["fields"]
                .as_array()
                .and_then(|a| a.iter().find(|f| f["field"] == "durationSeconds"))
                .and_then(|f| f["effective"]["value"].as_f64());
            let signature = super::thumbnails::fiche_cover_keys(c, &fiche)?.signature;
            Ok(Some((fiche, duration, signature)))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_and_stale_are_not_absent_covers() {
        use super::super::cover_store::Served;
        assert_eq!(cover(Served::Busy), (None, true));
        assert_eq!(cover(Served::Stale), (None, true));
        assert_eq!(cover(Served::Absent), (None, false));
    }
    #[test]
    fn grouped_pack_resolves_target_and_uses_uuid_index() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE pack_identity(pack_uuid TEXT PRIMARY KEY,fiche_id TEXT); CREATE TABLE fiche_grouping(fiche_id TEXT PRIMARY KEY,target_id TEXT); CREATE TABLE fiche_forgotten(fiche_id TEXT); INSERT INTO pack_identity VALUES ('00000000-0000-0000-0000-000000000000','member'); INSERT INTO fiche_grouping VALUES ('member','target');").unwrap();
        assert_eq!(card_id(&c, Uuid::nil()).unwrap().as_deref(), Some("target"));
        let plan: String = c
            .query_row(
                &format!("EXPLAIN QUERY PLAN {CARD_ID_SQL}"),
                [Uuid::nil().to_string()],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("INDEX"));
        c.execute("INSERT INTO fiche_forgotten VALUES ('target')", [])
            .unwrap();
        assert_eq!(card_id(&c, Uuid::nil()).unwrap(), None);
    }
}

#[cfg(test)]
mod repatriated_source_tests {
    use super::*;
    use std::{fs, path::Path, sync::atomic::AtomicBool};
    fn fixture(parent: &Path, id: Uuid) -> std::path::PathBuf {
        let clear = parent.join(id.to_string());
        crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&clear);
        let zip = parent.join(format!("{id}.zip"));
        crate::support::fs_pack_reader::read_fs_pack_to_studio_zip(&clear, &zip, "Conte").unwrap();
        zip
    }
    fn technical(store: &Store) -> (String, i64) {
        store
            .read(|c| {
                c.query_row(
                    "SELECT id,revision FROM source WHERE origin='repatriated'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    }
    #[test]
    fn repatriated_source_is_unique_per_directory_visible_immutable_and_scannable() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store =
            std::sync::Arc::new(Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap());
        let first = Uuid::new_v4();
        store
            .publish_repatriated_story(&fixture(&root.0, first), first, &root.0, "Conte")
            .unwrap();
        let source = technical(&store);
        assert_eq!(store.list_sources().unwrap().items.len(), 1);
        assert_eq!(
            store.preview_remove_source(&source.0).err().unwrap().code,
            crate::support::user_message::codes::CATALOG_SOURCE_NOT_FOUND
        );
        assert!(store
            .remove_source_confirmed(
                &source.0,
                store.sources_revision().unwrap(),
                store.list_sources().unwrap().catalogue_revision
            )
            .is_err());
        let revision = store.sources_revision().unwrap();
        for declined in [false, true] {
            let duplicate = store
                .add_source(&root.0.join("packs-rapatries"), revision, declined)
                .unwrap();
            assert_eq!(duplicate.source_id, source.0);
            assert_eq!(duplicate.sources_revision, revision);
        }
        let second = Uuid::new_v4();
        store
            .publish_repatriated_story(&fixture(&root.0, second), second, &root.0, "Conte")
            .unwrap();
        assert_eq!(technical(&store), source);
        let sources = store.all_sources().unwrap();
        assert_eq!(sources.items.len(), 1);
        assert_eq!(sources.items[0].origin, "repatriated");
        assert_eq!(sources.items[0].status, "active");
        let receipt = store
            .start_scan(
                None,
                Uuid::new_v4().to_string(),
                store.sources_revision().unwrap(),
                root.0.join("cache"),
                root.0.join("data"),
                std::sync::Arc::new(|_, _| {}),
            )
            .unwrap();
        let start = std::time::Instant::now();
        loop {
            let progress = store.get_operation(&receipt.operation_id).unwrap();
            if !matches!(
                progress.status.as_str(),
                "queued" | "running" | "cancelling"
            ) {
                assert_eq!(progress.status, "success");
                assert_eq!(progress.candidates.processed, 2);
                break;
            }
            assert!(start.elapsed() < crate::test_support::timeout());
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(store.list_sources().unwrap().items.len(), 1);
    }
    #[test]
    fn repatriation_replaces_removed_manual_source_before_or_after_first_acquisition() {
        for acquired_before_removal in [false, true] {
            let root = crate::services::storyteller::Scratch::new(
                &crate::support::paths::canonical_temp_dir(),
            )
            .unwrap();
            let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
            let directory = root.0.join("packs-rapatries");
            fs::create_dir(&directory).unwrap();
            let manual = store.add_source(&directory, 0, false).unwrap();
            let id = Uuid::new_v4();
            let zip = fixture(&root.0, id);
            if acquired_before_removal {
                store
                    .publish_repatriated_story(&zip, id, &root.0, "Conte")
                    .unwrap();
            }
            store
                .remove_source(&manual.source_id, store.sources_revision().unwrap())
                .unwrap();
            store
                .read(|c| {
                    for table in ["cache.coverage", "cache.file_state", "source_health"] {
                        let count: i64 = c.query_row(
                            &format!("SELECT count(*) FROM {table} WHERE source_id=?1"),
                            [&manual.source_id],
                            |r| r.get(0),
                        )?;
                        assert_eq!(count, 0, "{table}");
                    }
                    Ok(())
                })
                .unwrap();
            assert!(store.device_card_link(id).unwrap().is_none());
            store
                .publish_repatriated_story(&zip, id, &root.0, "Conte")
                .unwrap();
            let entries = store.list_entries(100, None).unwrap();
            assert_eq!(entries.items.len(), 1);
            let link = store.device_card_link(id).unwrap().unwrap();
            assert_eq!(entries.items[0]["id"], link.0);
            let sources = store.list_sources().unwrap();
            assert_eq!(sources.items.len(), 1);
            assert_eq!(sources.items[0].origin, "repatriated");
            assert_eq!(sources.items[0].status, "active");
            assert_eq!(sources.items[0].exemplar_count, 1);
            assert_ne!(sources.items[0].id, manual.source_id);
        }
    }
    #[test]
    fn repatriated_publication_failures_leave_no_source_or_empty_directory() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        assert!(store
            .publish_repatriated_story(&root.0.join("missing.zip"), Uuid::new_v4(), &root.0, "")
            .is_err());
        assert!(!root.0.join("packs-rapatries").exists());
        let invalid = root.0.join("invalid.zip");
        fs::write(&invalid, b"invalid zip").unwrap();
        assert!(store
            .publish_repatriated_story(&invalid, Uuid::new_v4(), &root.0, "")
            .is_err());
        assert!(!root.0.join("packs-rapatries").exists());
        let id = Uuid::new_v4();
        let zip = fixture(&root.0, id);
        super::super::files::publish::FAIL_PUBLICATION.with(|v| v.set(true));
        let failed = store.publish_repatriated_story(&zip, id, &root.0, "Conte");
        super::super::files::publish::FAIL_PUBLICATION.with(|v| v.set(false));
        assert!(failed.is_err());
        assert!(!root.0.join("packs-rapatries").exists());
        assert!(store.all_sources().unwrap().items.is_empty());
        // Force failure inside the indexing transaction, after source insertion.
        store.write(|tx| { tx.execute_batch("CREATE TRIGGER refuse_repatriated BEFORE INSERT ON exemplar BEGIN SELECT RAISE(ABORT,'test publication failure'); END;").map_err(super::super::store::error)?; Ok(()) }).unwrap();
        let id = Uuid::new_v4();
        assert!(store
            .publish_repatriated_story(&fixture(&root.0, id), id, &root.0, "Conte")
            .is_err());
        assert!(!root.0.join("packs-rapatries").exists());
        assert!(store.all_sources().unwrap().items.is_empty());
        assert!(store.device_card_link(id).unwrap().is_none());
    }
    #[test]
    fn repatriated_destinations_names_collisions_and_workspace_changes() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        let first = root.0.join("work-one");
        let second = root.0.join("work-two");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let id = Uuid::new_v4();
        let zip = fixture(&root.0, id);
        let folder = first.join("packs-rapatries");
        fs::create_dir(&folder).unwrap();
        let manual = store
            .add_source(&folder, store.sources_revision().unwrap(), false)
            .unwrap();
        store
            .write(|tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO source_health(source_id,last_scan_at,last_scan_status,availability) VALUES (?1,42,'success','available')",
                    [&manual.source_id],
                )
                .map_err(super::super::store::error)?;
                Ok(())
            })
            .unwrap();
        let source_before = store.read(|c| c.query_row("SELECT json_array(id,hex(path),hex(path_key),origin,status,revision,hex(resolved_path)) FROM source WHERE id=?1", [&manual.source_id], |r| r.get::<_, String>(0))).unwrap();
        let revision_before = store.sources_revision().unwrap();
        fs::write(folder.join("5+]Le_Conte.zip"), b"rival").unwrap();
        fs::write(folder.join("5+]Le_Conte (2).zip"), b"rival two").unwrap();
        store
            .publish_repatriated_story(&zip, id, &first, "5+]Le Conte")
            .unwrap();
        assert_eq!(store.read(|c| c.query_row("SELECT json_array(id,hex(path),hex(path_key),origin,status,revision,hex(resolved_path)) FROM source WHERE id=?1", [&manual.source_id], |r| r.get::<_, String>(0))).unwrap(), source_before);
        assert_eq!(store.sources_revision().unwrap(), revision_before);
        assert!(folder.join("5+]Le_Conte (3).zip").is_file());
        assert_eq!(fs::read(folder.join("5+]Le_Conte.zip")).unwrap(), b"rival");
        assert_eq!(
            fs::read(folder.join("5+]Le_Conte (2).zip")).unwrap(),
            b"rival two"
        );
        assert_eq!(
            store
                .publish_repatriated_story(&zip, id, &second, "Conte")
                .unwrap_err()
                .code,
            crate::support::user_message::codes::STORYTELLER_ALREADY_IN_CATALOGUE
        );
        assert!(!second.join("packs-rapatries").exists());
        let id = Uuid::new_v4();
        store
            .publish_repatriated_story(&fixture(&root.0, id), id, &second, "")
            .unwrap();
        assert!(second
            .join("packs-rapatries")
            .join(format!("Pack-rapatrie-{}.zip", &id.to_string()[..8]))
            .is_file());
        let id = Uuid::new_v4();
        store
            .publish_repatriated_story(&fixture(&root.0, id), id, &second, "Conte:/?!")
            .unwrap();
        assert!(second.join("packs-rapatries/Conte.zip").is_file());
        let list = store.list_sources().unwrap();
        assert_eq!(list.items.len(), 2);
        assert_eq!(list.exemplar_count, 3);
        assert_ne!(list.items[0].id, list.items[1].id);
        assert!(list
            .items
            .iter()
            .any(|s| s.id == manual.source_id && s.origin == "manual"));
        assert_eq!(store.all_sources().unwrap().items.len(), 2);
        assert_eq!(
            list.items
                .iter()
                .find(|s| s.native_path == folder)
                .unwrap()
                .last_scan_at,
            Some(42)
        );
        assert_eq!(
            list.items
                .iter()
                .filter(|s| s.origin == "repatriated" && s.id.starts_with("repatriated-"))
                .count(),
            1
        );
    }
    #[test]
    fn repatriated_workspace_refused_without_writes_and_existing_child_survives_failure() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        for workspace in [
            std::path::PathBuf::from("relative-workspace"),
            root.0.join("absent"),
        ] {
            let error = store
                .publish_repatriated_story(
                    &root.0.join("missing.zip"),
                    Uuid::new_v4(),
                    &workspace,
                    "",
                )
                .unwrap_err();
            assert_eq!(
                error.code,
                crate::support::user_message::codes::STORYTELLER_WORKSPACE_UNAVAILABLE
            );
        }
        assert!(!root.0.join("absent").exists());
        let folder = root.0.join("packs-rapatries");
        fs::create_dir(&folder).unwrap();
        assert!(store
            .publish_repatriated_story(&root.0.join("missing.zip"), Uuid::new_v4(), &root.0, "")
            .is_err());
        assert!(folder.is_dir());
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);
        fs::remove_dir(&folder).unwrap();
        fs::write(&folder, b"preexisting blocker").unwrap();
        let error = store
            .publish_repatriated_story(&root.0.join("missing.zip"), Uuid::new_v4(), &root.0, "")
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::support::user_message::codes::STORYTELLER_WORKSPACE_UNAVAILABLE
        );
        assert_eq!(fs::read(&folder).unwrap(), b"preexisting blocker");
        assert!(store.all_sources().unwrap().items.is_empty());
    }
    #[test]
    fn repatriated_target_must_not_redirect_outside_workspace() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let outside = root.0.join("outside");
        let workspace = root.0.join("work");
        fs::create_dir(&outside).unwrap();
        fs::create_dir(&workspace).unwrap();
        let normal = RepatriationTarget::prepare(&workspace).unwrap();
        assert!(normal.directory.is_dir());
        drop(normal);
        if !super::super::tests::directory_link(&outside, &workspace.join("packs-rapatries")) {
            return;
        }
        assert!(RepatriationTarget::prepare(&workspace).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert!(workspace.join("packs-rapatries").symlink_metadata().is_ok());
    }
    #[test]
    fn repatriated_sources_hidden_only_when_empty() {
        for source in ["repatriated-stories", "repatriated-new-workspace"] {
            repatriated_source_visibility(source);
        }
    }
    fn repatriated_source_visibility(source: &str) {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        let directory = root.0.join(source);
        fs::create_dir(&directory).unwrap();
        store
            .publish_repatriated_items(&directory, source, &[])
            .unwrap();
        assert!(store.list_sources().unwrap().items.is_empty());
        assert_eq!(store.all_sources().unwrap().items.len(), 1);
        let id = Uuid::new_v4();
        let path = directory.join("legacy.zip");
        fs::copy(fixture(&root.0, id), &path).unwrap();
        let items = super::super::scan::observe(
            source,
            &path,
            &super::super::scan::token(&path),
            &AtomicBool::new(false),
            &store.activity,
            true,
        );
        store
            .publish_repatriated_items(&directory, source, &items)
            .unwrap();
        let list = store.list_sources().unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].origin, "repatriated");
        assert_eq!(list.items[0].exemplar_count, 1);
        assert!(store.preview_remove_source(source).is_err());
        assert!(path.is_file());
        fs::remove_file(&path).unwrap();
        store
            .publish_targeted(
                "legacy-removed",
                store.sources_revision().unwrap(),
                source,
                &[],
                &[super::super::path_identity::key(&path)],
            )
            .unwrap();
        assert!(store.list_sources().unwrap().items.is_empty());
        assert_eq!(store.all_sources().unwrap().items.len(), 1);
    }
    #[test]
    fn repatriated_names_clean_before_fallback_and_truncate_before_suffix() {
        let id = Uuid::nil();
        for title in ["", "..", "!!!", "🎵🌙", "[]()++", " /?! "] {
            assert_eq!(repatriated_stem(title, id), "Pack-rapatrie-00000000");
        }
        assert_eq!(repatriated_stem("story-studio", id), "story-studio");
        assert_eq!(repatriated_stem(&"é".repeat(150), id), "é".repeat(100));
        assert_eq!(
            repatriated_stem(&format!("{}..titre", "a".repeat(98)), id),
            "a".repeat(98)
        );
        assert!(repatriated_stem(&"界".repeat(150), id).len() <= 200);
    }

    #[test]
    fn repatriated_collisions_have_a_hard_limit_without_touching_rivals() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        let directory = root.0.join("packs-rapatries");
        fs::create_dir(&directory).unwrap();
        let title = "é".repeat(150);
        let stem = repatriated_stem(&title, Uuid::nil());
        for index in 1..=1000 {
            let suffix = if index == 1 {
                String::new()
            } else {
                format!(" ({index})")
            };
            fs::write(directory.join(format!("{stem}{suffix}.zip")), b"rival").unwrap();
        }
        let id = Uuid::new_v4();
        assert!(store
            .publish_repatriated_story(&fixture(&root.0, id), id, &root.0, &title)
            .is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1000);
        assert!(fs::read_dir(&directory)
            .unwrap()
            .all(|entry| fs::read(entry.unwrap().path()).unwrap() == b"rival"));
        assert!(store.all_sources().unwrap().items.is_empty());
    }

    #[test]
    fn repatriated_workspace_probe_timeout_refuses_without_waiting_for_mount() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let path = root.0.clone();
        let (entered, started) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            super::super::probe::bounded(&path, crate::test_support::timeout(), move || {
                entered.send(()).unwrap();
                held.recv().unwrap();
            })
        });
        started.recv().unwrap();
        let begin = std::time::Instant::now();
        let result = RepatriationTarget::prepare(&root.0);
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(
            result.err().unwrap().code,
            crate::support::user_message::codes::STORYTELLER_WORKSPACE_UNAVAILABLE
        );
        assert!(
            begin.elapsed()
                < super::super::probe::PROBE_TIMEOUT + std::time::Duration::from_secs(2)
        );
        assert!(!root.0.join("packs-rapatries").exists());
    }

    #[test]
    fn repatriated_indexing_uses_sources_revision_after_concurrent_source_change() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        let id = Uuid::new_v4();
        let zip = fixture(&root.0, id);
        let directory = root.0.join("repatriated-stories");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("story.zip");
        fs::copy(zip, &path).unwrap();
        let source = "repatriated-stories";
        let observed = super::super::scan::observe(
            source,
            &path,
            &super::super::scan::token(&path),
            &AtomicBool::new(false),
            &store.activity,
            true,
        );
        let before = store.sources_revision().unwrap();
        // A source command commits between acquisition/observation and indexing.
        std::thread::scope(|scope| {
            scope
                .spawn(|| store.add_source(&root.0, before, false).unwrap())
                .join()
                .unwrap();
        });
        store
            .publish_repatriated_items(&directory, source, &observed)
            .unwrap();
        assert!(store.device_card_link(id).unwrap().is_some());
        assert_eq!(store.list_sources().unwrap().items.len(), 2);
        assert_eq!(store.all_sources().unwrap().items.len(), 2);
    }
}
