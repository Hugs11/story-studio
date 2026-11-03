//! Showing an exemplar in the system file manager.
//!
//! The target is revalidated at the click: the exemplar must still be in the
//! index at exactly the revision displayed by the interface. An archive child is
//! shown through its real container; a pack is selected in its folder, never
//! opened (an archive is never launched). When the element is gone, its parent
//! folder is opened instead and the caller is told so.
//!
//! The file manager itself is reached through `Revealer`; the application
//! passes the opener plugin, which already hides the per-platform mechanics
//! (Explorer selection, Finder reveal, FileManager1 or a folder opening).
use super::{sources::native, store::Store, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::OptionalExtension;
use serde::Serialize;
#[cfg(test)]
use serde_json::Value;
use std::{
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// Access to the system file manager.
pub trait Revealer {
    /// Shows `path` selected in its folder, without opening it.
    fn reveal(&self, path: &Path) -> std::result::Result<(), String>;
    /// Opens the folder `path` itself.
    fn open_folder(&self, path: &Path) -> std::result::Result<(), String>;
}

/// The opener plugin: the only native file-manager access of the catalogue.
pub struct SystemRevealer;

impl Revealer for SystemRevealer {
    fn reveal(&self, path: &Path) -> std::result::Result<(), String> {
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| error.to_string())
    }
    fn open_folder(&self, path: &Path) -> std::result::Result<(), String> {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Revealed {
    pub revealed: bool,
    pub fallback_parent_opened: bool,
}

/// What the disk says about the target, read by one bounded probe.
#[derive(Debug, PartialEq, Eq)]
enum Presence {
    Present,
    /// Gone, but its parent folder is reachable.
    ParentOnly(PathBuf),
    Gone,
}

fn probe_presence(path: &Path, timeout: Duration) -> Option<Presence> {
    let owned = path.to_owned();
    super::probe::bounded(path, timeout, move || {
        if std::fs::symlink_metadata(&owned).is_ok() {
            return Presence::Present;
        }
        match owned.parent().filter(|parent| parent.is_dir()) {
            Some(parent) => Presence::ParentOnly(parent.to_owned()),
            None => Presence::Gone,
        }
    })
}

fn disappeared(path: &Path) -> UserMessage {
    UserMessage::new(codes::CATALOG_FILE_DISAPPEARED)
        .param("path", crate::support::paths::path_for_frontend(path))
}

/// A fallback must open a reachable directory, never a replacement file.
/// Keep both metadata and access checks inside the bounded filesystem probe.
fn probe_folder(path: &Path, timeout: Duration) -> bool {
    let owned = path.to_owned();
    super::probe::bounded(path, timeout, move || {
        owned.is_dir() && std::fs::read_dir(&owned).is_ok()
    }) == Some(true)
}

/// Reveals `path`, or opens its parent folder when it is gone or when the
/// file manager cannot select it. A volume that does not answer is treated as
/// an element that cannot be reached.
fn show(path: &Path, revealer: &dyn Revealer, timeout: Duration) -> Result<Revealed> {
    let parent = match probe_presence(path, timeout) {
        Some(Presence::Present) => match revealer.reveal(path) {
            Ok(()) => {
                return Ok(Revealed {
                    revealed: true,
                    fallback_parent_opened: false,
                })
            }
            Err(error) => {
                log::warn!("Catalogue reveal: {error}");
                path.parent().map(Path::to_owned)
            }
        },
        Some(Presence::ParentOnly(parent)) => Some(parent),
        Some(Presence::Gone) | None => None,
    };
    let Some(parent) = parent else {
        return Err(disappeared(path));
    };
    if !probe_folder(&parent, timeout) {
        return Err(disappeared(path));
    }
    revealer
        .open_folder(&parent)
        .map_err(|detail| disappeared(path).with_detail(detail))?;
    Ok(Revealed {
        revealed: false,
        fallback_parent_opened: true,
    })
}

impl Store {
    /// Location on disk that shows `exemplar`: its own path, or its container
    /// for an archive child (the locator path is then the archive's). The
    /// revalidation is shared with every other exemplar action.
    fn reveal_target(&self, exemplar: &str, expected_revision: i64) -> Result<PathBuf> {
        self.resolve_target(exemplar, expected_revision)
            .map(|target| target.path)
    }

    /// Shows an indexed exemplar in the file manager (see the module notes).
    pub fn reveal_exemplar(
        &self,
        exemplar: &str,
        expected_revision: i64,
        revealer: &dyn Revealer,
    ) -> Result<Revealed> {
        self.reveal_exemplar_with(
            exemplar,
            expected_revision,
            revealer,
            super::probe::PROBE_TIMEOUT,
        )
    }

    pub(crate) fn reveal_exemplar_with(
        &self,
        exemplar: &str,
        expected_revision: i64,
        revealer: &dyn Revealer,
        timeout: Duration,
    ) -> Result<Revealed> {
        let path = self.reveal_target(exemplar, expected_revision)?;
        self.require_active_source(&path)?;
        show(&path, revealer, timeout)
    }

    /// Refuses any location outside the active sources: the file manager is
    /// never opened elsewhere, even for an exemplar still in the index.
    pub(crate) fn require_active_source(&self, path: &Path) -> Result<()> {
        let roots = self.read(|c| {
            let roots = c
                .prepare("SELECT path,resolved_path FROM source WHERE status='active'")?
                .query_map([], |r| {
                    Ok((
                        native(r.get(0)?),
                        r.get::<_, Option<Vec<u8>>>(1)?.map(native),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(roots)
        })?;
        // Containment is lexical first, then a bounded native comparison for
        // plausible aliases. Keep those probes outside the read transaction.
        let covered = roots.iter().any(|(root, resolved)| {
            super::path_identity::contains(root, path)
                || resolved
                    .as_ref()
                    .is_some_and(|r| super::path_identity::contains(r, path))
        });
        if covered {
            Ok(())
        } else {
            Err(UserMessage::new(codes::CATALOG_SOURCE_UNAVAILABLE))
        }
    }

    /// Shows a path of a scan report (indexed or refused) in the file manager.
    /// Only paths under an active source are accepted: the command never
    /// becomes a way to open arbitrary locations.
    pub fn reveal_path(&self, path: &Path, revealer: &dyn Revealer) -> Result<Revealed> {
        self.reveal_path_with(path, revealer, super::probe::PROBE_TIMEOUT)
    }

    pub(crate) fn reveal_path_with(
        &self,
        path: &Path,
        revealer: &dyn Revealer,
        timeout: Duration,
    ) -> Result<Revealed> {
        // A relative path or a `..` component could leave every source while
        // still matching its prefix component by component.
        let plain = path.is_absolute()
            && path
                .components()
                .all(|part| !matches!(part, Component::ParentDir | Component::CurDir));
        if !plain {
            return Err(UserMessage::new(codes::CATALOG_SOURCE_UNAVAILABLE));
        }
        self.require_active_source(path)?;
        let indexed = self.read_snapshot(|c| {
            let revision: i64 = c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
            let id = c.query_row(
                "SELECT id FROM exemplar WHERE retired=0 AND json_extract(anchor_json,'$.path')=?1 ORDER BY id LIMIT 1",
                [crate::support::paths::path_for_frontend(path)], |r| r.get::<_, String>(0),
            ).optional()?;
            Ok((revision, id))
        })?;
        if let (revision, Some(id)) = indexed {
            return self.reveal_exemplar_with(&id, revision, revealer, timeout);
        }
        let parent = path.parent().ok_or_else(|| disappeared(path))?;
        if !probe_folder(parent, timeout) {
            return Err(disappeared(path));
        }
        revealer
            .open_folder(parent)
            .map_err(|detail| disappeared(path).with_detail(detail))?;
        Ok(Revealed {
            revealed: false,
            fallback_parent_opened: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, sync::Arc};

    #[derive(Default)]
    struct Recorder {
        calls: RefCell<Vec<(&'static str, PathBuf)>>,
        refuse_reveal: bool,
    }
    impl Revealer for Recorder {
        fn reveal(&self, path: &Path) -> std::result::Result<(), String> {
            self.calls.borrow_mut().push(("reveal", path.to_owned()));
            if self.refuse_reveal {
                Err("no file manager".into())
            } else {
                Ok(())
            }
        }
        fn open_folder(&self, path: &Path) -> std::result::Result<(), String> {
            self.calls.borrow_mut().push(("open", path.to_owned()));
            Ok(())
        }
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("catalogue-reveal-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("source/packs")).unwrap();
            Self(root)
        }
        fn source(&self) -> PathBuf {
            self.0.join("source")
        }
        fn open(&self) -> Arc<Store> {
            Arc::new(Store::open(&self.0.join("data"), &self.0.join("cache")).unwrap())
        }
        /// A store whose fixture folder is an active source.
        fn open_with_source(&self) -> Arc<Store> {
            let store = self.open();
            store.add_source(&self.source(), 0, false).unwrap();
            store
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Inserts an exemplar row directly: the reveal reads the locator only.
    fn insert(store: &Store, id: &str, anchor: Value, retired: bool) {
        store
            .write(|tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO fiche(id,created_at,favorite,revision) VALUES ('card',0,0,0)",
                    [],
                )
                .map_err(super::super::store::error)?;
                tx.execute(
                    "INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,retired)
                     VALUES (?1,'card',?2,'{}',0,?3)",
                    rusqlite::params![id, anchor.to_string(), retired],
                )
                .map_err(super::super::store::error)?;
                Ok(())
            })
            .unwrap();
    }

    fn revision(store: &Store) -> i64 {
        store
            .read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))
            .unwrap()
    }

    fn bump(store: &Store) {
        store
            .write(|tx| {
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .map_err(super::super::store::error)?;
                Ok(())
            })
            .unwrap();
    }

    const TIMEOUT: Duration = Duration::from_secs(2);

    #[test]
    fn a_present_pack_is_selected_and_an_archive_child_shows_its_container() {
        let f = Fixture::new();
        let store = f.open_with_source();
        let zip = f.source().join("packs/compilation.zip");
        std::fs::write(&zip, b"zip").unwrap();
        let text = zip.to_string_lossy().into_owned();
        insert(&store, "file", serde_json::json!({"path": text}), false);
        insert(
            &store,
            "child",
            serde_json::json!({"path": text, "member": "ours"}),
            false,
        );
        let current = revision(&store);
        for id in ["file", "child"] {
            let recorder = Recorder::default();
            let result = store
                .reveal_exemplar_with(id, current, &recorder, TIMEOUT)
                .unwrap();
            assert_eq!(
                result,
                Revealed {
                    revealed: true,
                    fallback_parent_opened: false
                }
            );
            assert_eq!(*recorder.calls.borrow(), vec![("reveal", zip.clone())]);
        }
        assert_eq!(
            std::fs::read(&zip).unwrap(),
            b"zip",
            "the archive is never touched"
        );
    }

    #[test]
    fn a_vanished_file_opens_its_parent_and_nothing_reachable_is_an_error() {
        let f = Fixture::new();
        let store = f.open_with_source();
        let gone = f.source().join("packs/gone.zip");
        insert(
            &store,
            "gone",
            serde_json::json!({"path": gone.to_string_lossy()}),
            false,
        );
        let lost = f.source().join("missing-folder/lost.zip");
        insert(
            &store,
            "lost",
            serde_json::json!({"path": lost.to_string_lossy()}),
            false,
        );
        let current = revision(&store);
        let recorder = Recorder::default();
        let result = store
            .reveal_exemplar_with("gone", current, &recorder, TIMEOUT)
            .unwrap();
        assert_eq!(
            result,
            Revealed {
                revealed: false,
                fallback_parent_opened: true
            }
        );
        assert_eq!(
            *recorder.calls.borrow(),
            vec![("open", f.source().join("packs"))]
        );
        let error = store
            .reveal_exemplar_with("lost", current, &Recorder::default(), TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_FILE_DISAPPEARED);
        assert!(error.params["path"].as_str().unwrap().ends_with("lost.zip"));
    }

    #[test]
    fn a_file_manager_that_cannot_select_falls_back_to_the_parent() {
        let f = Fixture::new();
        let store = f.open_with_source();
        let folder = f.source().join("packs/Lune");
        std::fs::create_dir(&folder).unwrap();
        insert(
            &store,
            "folder",
            serde_json::json!({"path": folder.to_string_lossy()}),
            false,
        );
        let recorder = Recorder {
            refuse_reveal: true,
            ..Recorder::default()
        };
        let result = store
            .reveal_exemplar_with("folder", revision(&store), &recorder, TIMEOUT)
            .unwrap();
        assert!(result.fallback_parent_opened);
        assert_eq!(
            *recorder.calls.borrow(),
            vec![
                ("reveal", folder.clone()),
                ("open", f.source().join("packs"))
            ]
        );
    }

    #[test]
    fn the_target_is_revalidated_against_the_displayed_revision_and_location() {
        let f = Fixture::new();
        let store = f.open_with_source();
        let zip = f.source().join("packs/a.zip");
        std::fs::write(&zip, b"zip").unwrap();
        let text = zip.to_string_lossy().into_owned();
        insert(&store, "kept", serde_json::json!({"path": text}), false);
        insert(&store, "retired", serde_json::json!({"path": text}), true);
        let seen = revision(&store);
        bump(&store);
        // Even an unchanged path must be refreshed after a revision change.
        for id in ["kept", "retired", "unknown"] {
            let recorder = Recorder::default();
            let error = store
                .reveal_exemplar_with(id, seen, &recorder, TIMEOUT)
                .unwrap_err();
            assert_eq!(
                error.code,
                if id == "unknown" {
                    codes::CATALOG_TARGET_REVISION_STALE
                } else {
                    codes::CATALOG_TARGET_REVISION_CHANGED
                },
                "{id}"
            );
            assert!(recorder.calls.borrow().is_empty());
        }
        assert!(
            store
                .reveal_exemplar_with("kept", revision(&store), &Recorder::default(), TIMEOUT)
                .unwrap()
                .revealed
        );
    }

    /// The hand-written fixture read by the interface adapter test.
    #[test]
    fn the_result_matches_the_hand_written_contract_fixture() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/catalogue/reveal.json");
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let actual = serde_json::to_value(Revealed {
            revealed: false,
            fallback_parent_opened: true,
        })
        .unwrap();
        assert_eq!(expected, actual);
    }

    #[test]
    fn a_report_parent_replaced_by_a_file_is_never_opened() {
        let f = Fixture::new();
        let store = f.open();
        store.add_source(&f.source(), 0, false).unwrap();
        let parent = f.source().join("packs");
        let target = parent.join("broken.7z");
        std::fs::remove_dir(&parent).unwrap();
        std::fs::write(&parent, b"replacement archive").unwrap();
        let recorder = Recorder::default();
        let error = store
            .reveal_path_with(&target, &recorder, TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_FILE_DISAPPEARED);
        assert!(recorder.calls.borrow().is_empty());
        insert(
            &store,
            "gone",
            serde_json::json!({"path": target.to_string_lossy()}),
            false,
        );
        let error = store
            .reveal_exemplar_with("gone", revision(&store), &recorder, TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_FILE_DISAPPEARED);
        assert!(recorder.calls.borrow().is_empty());
    }

    #[test]
    fn report_paths_are_revealed_only_under_an_active_source() {
        let f = Fixture::new();
        let store = f.open();
        store.add_source(&f.source(), 0, false).unwrap();
        let refused = f.source().join("packs/broken.7z");
        std::fs::write(&refused, b"7z").unwrap();
        let recorder = Recorder::default();
        assert!(
            store
                .reveal_path_with(&refused, &recorder, TIMEOUT)
                .unwrap()
                .fallback_parent_opened
        );
        assert_eq!(
            *recorder.calls.borrow(),
            vec![("open", f.source().join("packs"))]
        );
        insert(
            &store,
            "indexed",
            serde_json::json!({"path": refused.to_string_lossy()}),
            false,
        );
        let recorder = Recorder::default();
        assert!(
            store
                .reveal_path_with(&refused, &recorder, TIMEOUT)
                .unwrap()
                .revealed
        );
        assert_eq!(*recorder.calls.borrow(), vec![("reveal", refused.clone())]);
        let outside = f.0.join("elsewhere.zip");
        std::fs::write(&outside, b"zip").unwrap();
        let recorder = Recorder::default();
        let error = store
            .reveal_path_with(&outside, &recorder, TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_SOURCE_UNAVAILABLE);
        assert!(recorder.calls.borrow().is_empty());
        // `..` keeps the source prefix component by component but leaves it.
        let escaping = f.source().join("packs/../../elsewhere.zip");
        let error = store
            .reveal_path_with(&escaping, &recorder, TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_SOURCE_UNAVAILABLE);
        assert!(recorder.calls.borrow().is_empty());
    }

    #[test]
    fn an_indexed_exemplar_outside_the_active_sources_is_never_shown() {
        let f = Fixture::new();
        let store = f.open();
        let zip = f.source().join("packs/a.zip");
        std::fs::write(&zip, b"zip").unwrap();
        insert(
            &store,
            "kept",
            serde_json::json!({"path": zip.to_string_lossy()}),
            false,
        );
        let recorder = Recorder::default();
        let error = store
            .reveal_exemplar_with("kept", revision(&store), &recorder, TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_SOURCE_UNAVAILABLE);
        assert!(recorder.calls.borrow().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn report_paths_in_a_distinct_unicode_fold_collision_are_never_shown() {
        let f = Fixture::new();
        let source = f.0.join("Packs-K");
        let sibling = f.0.join("Packs-\u{212a}");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let inside = source.join("story.zip");
        let outside = sibling.join("story.zip");
        std::fs::write(&inside, b"zip").unwrap();
        std::fs::write(&outside, b"zip").unwrap();
        let store = f.open();
        store.add_source(&source, 0, false).unwrap();
        let recorder = Recorder::default();
        let error = store
            .reveal_path_with(&outside, &recorder, TIMEOUT)
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_SOURCE_UNAVAILABLE);
        assert!(recorder.calls.borrow().is_empty());
        assert!(
            store
                .reveal_path_with(&inside, &recorder, TIMEOUT)
                .unwrap()
                .fallback_parent_opened
        );
        assert_eq!(*recorder.calls.borrow(), vec![("open", source)]);
    }
}
