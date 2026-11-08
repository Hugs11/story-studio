//! Optional catalogue enrichment at the pack → project boundary only.
//! Temporary ZIPs retain their source locator; they never match by pack UUID.
use crate::services::catalogue::{self, data::card, path_identity, store::Store, Result};
use crate::support::{imported_pack, paths::path_for_frontend};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Debug)]
pub struct Source {
    pub path: PathBuf,
    /// `catalogue:<member key>` or the ordinary bundle inventory's child ID.
    pub child_id: Option<String>,
    pub fingerprint: Option<String>,
}
impl Source {
    pub fn direct(path: &str) -> Self {
        Self {
            path: path.into(),
            child_id: None,
            fingerprint: None,
        }
    }
}

/// Process-local provenance of converter outputs, not catalogue identities.
/// The conversion sidecar only records StudioDirectory/FsProjection identity,
/// not the original path or archive member, and copies have no sidecar. Keep
/// those locators here, capped at 256 outputs, evicting the oldest registration.
/// Values hold only locators, never covers or project metadata.
#[derive(Default)]
pub struct Sources(std::sync::Mutex<std::collections::VecDeque<(PathBuf, String, Source)>>);
impl Sources {
    fn remember(&self, output: &Path, source: Source) {
        if let (Ok(path), Ok((token, _, _))) =
            (output.canonicalize(), catalogue::scan::token(output))
        {
            let mut sources = self.0.lock().unwrap_or_else(|p| p.into_inner());
            sources.retain(|(existing, _, _)| existing != &path);
            if sources.len() == 256 {
                sources.pop_front();
            }
            sources.push_back((path, token, source));
        }
    }
    fn copied(&self, input: &str, output: &str) {
        if !Path::new(input).extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("zip") || extension.eq_ignore_ascii_case("7z")
        }) {
            return;
        }
        let source = self
            .find(Path::new(input))
            .unwrap_or_else(|| Source::direct(input));
        self.remember(Path::new(output), source);
    }
    fn find(&self, output: &Path) -> Option<Source> {
        let path = output.canonicalize().ok()?;
        let (_, token, source) = self
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|(existing, _, _)| existing == &path)?
            .clone();
        (catalogue::scan::token(&path).ok()?.0 == token).then_some(source)
    }
}

pub struct Metadata {
    pub values: Value,
    pub cover: Option<Vec<u8>>,
}

impl Store {
    fn imported_card(&self, source: &Source) -> Result<Option<(String, Value)>> {
        // This whole operation runs in the bounded optional worker, including
        // path resolution and fingerprint reads on potentially remote volumes.
        let canonical = match source.path.canonicalize() {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };
        if canonical
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("mbah"))
        {
            return Ok(None);
        }
        if source.fingerprint.as_ref().is_some_and(|expected| {
            imported_pack::bundle_container_fingerprint(&path_for_frontend(&canonical))
                .ok()
                .as_ref()
                != Some(expected)
        }) {
            return Ok(None);
        }
        let token = match catalogue::scan::token(&canonical) {
            Ok((token, _, _)) => token,
            Err(_) => return Ok(None),
        };
        let path_key = json!(path_identity::key(&canonical)).to_string();
        self.read_snapshot(|c| {
            let mut statement = c.prepare(
                "SELECT e.fiche_id,e.anchor_json,o.raw_observation_json FROM exemplar e
                 JOIN cache.observation o ON o.exemplar_id=e.id
                 WHERE e.retired=0 AND o.state='available' AND o.format!='project'
                 AND o.content_token=?2 AND json_extract(e.anchor_json,'$.pathKey')=json(?1)
                 AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id
                 WHERE v.exemplar_id=e.id AND s.status='active')",
            )?;
            let rows = statement.query_map(rusqlite::params![path_key, token], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            let mut selected = None;
            for row in rows {
                let (id, anchor, raw) = row?;
                let anchor: Value = serde_json::from_str(&anchor).unwrap_or_default();
                let raw: Value = serde_json::from_str(&raw).unwrap_or_default();
                let matches = match source.child_id.as_deref() {
                    None => {
                        anchor["memberKey"].is_null()
                            || raw["chain"].as_array().is_some_and(|chain| {
                                chain.iter().all(|part| part["kind"] == "pack-root")
                            })
                    }
                    Some(child) if child.starts_with("catalogue:") => {
                        anchor["memberKey"].as_str() == child.strip_prefix("catalogue:")
                    }
                    Some(child) => raw["chain"]
                        .as_array()
                        .and_then(|chain| chain.first())
                        .filter(|part| part["kind"] == "archive-entry")
                        .and_then(|part| part["path"].as_str())
                        .is_some_and(|path| imported_pack::bundle_child_identity(path) == child),
                };
                if matches {
                    // An ordinary bundle child can contain another envelope.
                    // Ambiguity must never enrich it from an arbitrary sibling.
                    if selected.is_some() {
                        return Ok(None);
                    }
                    selected = Some(id);
                }
            }
            let Some(id) = selected else {
                return Ok(None);
            };
            let Some(entry) = catalogue::grouping::entry_for_card(c, &id)? else {
                return Ok(None);
            };
            let names = catalogue::lunii_db::ordered_names(entry["exemplars"].as_array().unwrap());
            let resolved = card::resolution(c, &id, &names)?;
            let mut values = Map::new();
            for (from, to) in [
                ("title", "title"),
                ("ageMin", "minAge"),
                ("author", "author"),
                ("description", "description"),
            ] {
                if let Some(value) = resolved.values.get(from) {
                    values.insert(to.into(), value.clone());
                }
            }
            Ok(Some((id, Value::Object(values))))
        })
    }

    #[cfg(test)]
    pub fn imported_metadata(&self, source: &Source, cover: bool) -> Result<Option<Metadata>> {
        let Some((id, values)) = self.imported_card(source)? else {
            return Ok(None);
        };
        let cover = if cover {
            self.import_local_cover(&id).ok().flatten()
        } else {
            None
        };
        Ok(Some(Metadata { values, cover }))
    }
}

/// One optional worker per lane (values / cover), each waiting at most 250 ms. A slow
/// catalogue never queues workers or delays the next import. Timed-out work
/// cannot write into a project: only the caller copies returned cover bytes.
pub fn optional<R: Runtime>(app: &AppHandle<R>, path: &str, cover: bool) -> Option<Metadata> {
    let app = app.clone();
    let path = path.to_owned();
    static VALUES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static COVER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let (store, id, values) = bounded(&VALUES, move || {
        let state = app.try_state::<catalogue::CatalogueState>()?;
        // Optional read: skip initialization and a busy store rather than block.
        let store = state
            .store
            .try_lock()
            .ok()?
            .as_ref()?
            .as_ref()
            .ok()?
            .clone();
        let source = state
            .import_sources
            .find(Path::new(&path))
            .unwrap_or_else(|| Source::direct(&path));
        let (id, values) = store.imported_card(&source).ok().flatten()?;
        Some((store, id, values))
    })
    .flatten()?;
    Some(with_optional_cover(values, cover, move || {
        bounded(&COVER, move || store.import_local_cover(&id).ok().flatten()).flatten()
    }))
}

fn with_optional_cover(
    values: Value,
    cover: bool,
    read: impl FnOnce() -> Option<Vec<u8>>,
) -> Metadata {
    Metadata {
        values,
        cover: if cover { read() } else { None },
    }
}

fn bounded<T: Send + 'static>(
    active: &'static std::sync::atomic::AtomicBool,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    use std::sync::atomic::Ordering;
    if active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return None;
    }
    struct Active(&'static std::sync::atomic::AtomicBool);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let active = Active(active);
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("catalogue-import-metadata".into())
        .spawn(move || {
            let _active = active;
            let _ = send.send(work());
        })
        .ok()?;
    receive.recv_timeout(Duration::from_millis(250)).ok()
}

/// Register only outputs produced by the existing converters/extractors.
pub fn remember<R: Runtime>(app: &AppHandle<R>, output: &str, source: Source) {
    if let Some(state) = app.try_state::<catalogue::CatalogueState>() {
        state.import_sources.remember(Path::new(output), source);
    }
}

/// Archive imports may be copied into a session before ZIP promotion. Preserve
/// converter provenance through that common copy path, without enriching nodes.
pub fn remember_copy<R: Runtime>(app: &AppHandle<R>, input: &str, output: &str) {
    if let Some(state) = app.try_state::<catalogue::CatalogueState>() {
        state.import_sources.copied(input, output);
    }
}

impl Metadata {
    /// Optional bytes are copied on the acquisition thread, never by a late worker.
    pub fn apply(self, dest: &Path, value: &mut Value) {
        value["catalogueMetadata"] = self.values;
        if value["thumbnailImage"].as_str().is_none_or(str::is_empty) {
            if let Some(bytes) = self.cover {
                if let Ok(path) = crate::services::pack_reader::write_project_thumbnail(
                    dest,
                    "catalogue.jpg",
                    &mut bytes.as_slice(),
                ) {
                    value["thumbnailImage"] = json!(path_for_frontend(&path));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_optional_read_has_a_deadline_and_no_worker_queue() {
        static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let (release, hold) = std::sync::mpsc::channel::<()>();
        let (done, finished) = std::sync::mpsc::channel();
        let start = std::time::Instant::now();
        assert_eq!(
            bounded(&ACTIVE, move || {
                let _ = hold.recv();
                let _ = done.send(());
                42
            }),
            None
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(
            bounded(&ACTIVE, || panic!("must not queue a second worker")),
            None::<()>
        );
        release.send(()).unwrap();
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    #[test]
    fn catalogue_slow_or_missing_cover_preserves_values() {
        static COVER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let values = json!({"title":"Titre", "minAge":6, "author":"Auteur", "description":"Texte"});
        let absent = with_optional_cover(values.clone(), true, || None);
        assert_eq!(absent.values, values);
        assert!(absent.cover.is_none());
        let (release, hold) = std::sync::mpsc::channel::<()>();
        let slow = with_optional_cover(values.clone(), true, || {
            bounded(&COVER, move || {
                let _ = hold.recv();
                Some(vec![1])
            })
            .flatten()
        });
        assert_eq!(slow.values, values);
        assert!(slow.cover.is_none());
        release.send(()).unwrap();
    }

    #[test]
    fn catalogue_source_registry_evicts_oldest_registration() {
        let root =
            std::env::temp_dir().join(format!("catalogue-eviction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sources = Sources::default();
        for n in 0..257 {
            let output = root.join(format!("{n}.zip"));
            std::fs::write(&output, b"zip").unwrap();
            sources.remember(&output, Source::direct("original"));
        }
        assert_eq!(sources.0.lock().unwrap().len(), 256);
        assert!(sources.find(&root.join("0.zip")).is_none());
        assert!(sources.find(&root.join("256.zip")).is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn catalogue_temporary_input_keeps_source_and_rejects_replaced_output() {
        let root = std::env::temp_dir().join(format!("catalogue-input-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let output = root.join("converted.zip");
        std::fs::write(&output, b"temporary").unwrap();
        let sources = Sources::default();
        sources.remember(&output, Source::direct("/original/folder"));
        assert_eq!(
            sources.find(&output).unwrap().path,
            PathBuf::from("/original/folder")
        );
        let copied = root.join("project-copy.zip");
        std::fs::copy(&output, &copied).unwrap();
        sources.copied(&output.to_string_lossy(), &copied.to_string_lossy());
        assert_eq!(
            sources.find(&copied).unwrap().path,
            PathBuf::from("/original/folder")
        );
        let imported = root.join("import.zip");
        std::fs::write(&imported, b"original imported zip").unwrap();
        let promoted = root.join("promoted.zip");
        std::fs::copy(&imported, &promoted).unwrap();
        sources.copied(&imported.to_string_lossy(), &promoted.to_string_lossy());
        assert_eq!(sources.find(&promoted).unwrap().path, imported);
        std::fs::write(&output, b"replaced temporary archive").unwrap();
        assert!(sources.find(&output).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
