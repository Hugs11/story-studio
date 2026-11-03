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
impl Store {
    /// Uses the ordinary scan observation and identity/grouping publication.
    /// This durable directory is outside the disposable catalogue/cache trees.
    pub(crate) fn publish_repatriated_story(
        &self,
        zip: &std::path::Path,
        id: Uuid,
    ) -> super::Result<(String, i64)> {
        let _heavy = self.scans.heavy.lock().map_err(super::store::error)?;
        if self.device_card_link(id)?.is_some() {
            return Err(crate::support::user_message::UserMessage::new(
                crate::support::user_message::codes::STORYTELLER_ALREADY_IN_CATALOGUE,
            ));
        }
        let directory = self.repatriated_root()?;
        let result = (|| {
            std::fs::create_dir_all(&directory).map_err(super::store::error)?;
            let directory = std::fs::canonicalize(&directory).map_err(super::store::error)?;
            // Copy and sync on the destination volume before exclusive publication.
            let scratch = crate::services::storyteller::Scratch::new(&directory)?;
            let temporary = scratch.0.join("pack.tmp");
            std::fs::copy(zip, &temporary).map_err(super::store::error)?;
            crate::support::file_sync::sync_file(&temporary).map_err(super::store::error)?;
            let source = "repatriated-stories";
            let path = directory.join(format!("{id}-{}.zip", Uuid::new_v4()));
            let temporary_id = super::writes::file_id(&temporary);
            if let Err(error) = super::files::publish::no_replace(&temporary, &path) {
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
                    source,
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
                let published = self.publish_repatriated_items(&directory, source, &items)?;
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
        })();
        if result.is_err() {
            // remove_dir only removes an empty directory, never prior stories.
            let _ = std::fs::remove_dir(&directory);
        }
        result
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
    fn repatriated_source_is_unique_hidden_immutable_and_scannable() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store =
            std::sync::Arc::new(Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap());
        let first = Uuid::new_v4();
        store
            .publish_repatriated_story(&fixture(&root.0, first), first)
            .unwrap();
        let source = technical(&store);
        assert!(store.list_sources().unwrap().items.is_empty());
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
        assert!(store
            .add_source(
                &store.repatriated_root().unwrap(),
                store.sources_revision().unwrap(),
                false
            )
            .is_err());
        assert!(store
            .add_source(
                &store.repatriated_root().unwrap(),
                store.sources_revision().unwrap(),
                true
            )
            .is_err());
        let second = Uuid::new_v4();
        store
            .publish_repatriated_story(&fixture(&root.0, second), second)
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
            assert!(start.elapsed() < std::time::Duration::from_secs(20));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(store.list_sources().unwrap().items.is_empty());
    }
    #[test]
    fn repatriated_publication_failures_leave_no_source_or_empty_directory() {
        let root = crate::services::storyteller::Scratch::new(
            &crate::support::paths::canonical_temp_dir(),
        )
        .unwrap();
        let store = Store::open(&root.0.join("data"), &root.0.join("cache")).unwrap();
        assert!(store
            .publish_repatriated_story(&root.0.join("missing.zip"), Uuid::new_v4())
            .is_err());
        assert!(!store.repatriated_root().unwrap().exists());
        let invalid = root.0.join("invalid.zip");
        fs::write(&invalid, b"invalid zip").unwrap();
        assert!(store
            .publish_repatriated_story(&invalid, Uuid::new_v4())
            .is_err());
        assert!(!store.repatriated_root().unwrap().exists());
        let id = Uuid::new_v4();
        let zip = fixture(&root.0, id);
        super::super::files::publish::FAIL_PUBLICATION.with(|v| v.set(true));
        let failed = store.publish_repatriated_story(&zip, id);
        super::super::files::publish::FAIL_PUBLICATION.with(|v| v.set(false));
        assert!(failed.is_err());
        assert!(!store.repatriated_root().unwrap().exists());
        assert!(store.all_sources().unwrap().items.is_empty());
        // Force failure inside the indexing transaction, after source insertion.
        store.write(|tx| { tx.execute_batch("CREATE TRIGGER refuse_repatriated BEFORE INSERT ON exemplar BEGIN SELECT RAISE(ABORT,'test publication failure'); END;").map_err(super::super::store::error)?; Ok(()) }).unwrap();
        let id = Uuid::new_v4();
        assert!(store
            .publish_repatriated_story(&fixture(&root.0, id), id)
            .is_err());
        assert!(!store.repatriated_root().unwrap().exists());
        assert!(store.all_sources().unwrap().items.is_empty());
        assert!(store.device_card_link(id).unwrap().is_none());
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
        let directory = store.repatriated_root().unwrap();
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
        assert_eq!(store.list_sources().unwrap().items.len(), 1);
        assert_eq!(store.all_sources().unwrap().items.len(), 2);
    }
}
