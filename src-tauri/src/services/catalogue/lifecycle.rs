//! Application lifecycle: the watcher starts with the application, follows
//! source changes and stops with the main window. Called from the existing
//! initialization point and from the catalogue commands.
use super::{
    store::{error, Store},
    watch, writes, CatalogueState, Result,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Writer contention rejects startup; other failures permit degraded editing.
pub fn initialize<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<()> {
    open_store(app).map(|_| ())
}

/// The shared store, admitted at startup before editing is available.
pub fn open_store<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Arc<Store>> {
    app.state::<CatalogueState>().admit_once(|| {
        let data = app.path().app_data_dir().map_err(error)?;
        let cache = app.path().app_cache_dir().map_err(error)?;
        let emitter = app.clone();
        let sink: watch::ChangeSink = Arc::new(move |revision| {
            if let Err(error) = emitter.emit(
                "catalogue-changed",
                serde_json::json!({"catalogueRevision": revision, "scope": "entries"}),
            ) {
                log::warn!("Catalogue event: {error}");
            }
        });
        admit_store(&data, &cache, Some(sink))
    })
}

/// Admits the writer and starts recovery. A failed recovery start keeps the
/// instance lock for the life of the process (the leaked store holds it), so a
/// half-admitted catalogue never lets a second process become the writer.
pub(super) fn admit_store(
    data: &std::path::Path,
    cache: &std::path::Path,
    change_sink: Option<watch::ChangeSink>,
) -> Result<Arc<Store>> {
    let mut store = Store::admit(data, cache)?;
    store.change_sink = change_sink;
    let admitted = Arc::new(store);
    if let Err(cause) = admitted.start_recovery() {
        std::mem::forget(admitted);
        return Err(cause);
    }
    Ok(admitted)
}

/// Starts source reconciliation and watching in the background, so admission
/// never probes a slow or absent source volume.
pub fn start_watching(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("catalogue-start".into())
        .spawn(move || {
            let (Ok(data), Ok(cache)) = (app.path().app_data_dir(), app.path().app_cache_dir())
            else {
                return;
            };
            let store = match open_store(&app) {
                Ok(store) => store,
                Err(reason) => {
                    log::warn!(target: "catalogue_watch", "catalogue unavailable: {reason}");
                    return;
                }
            };
            let before_legacy=store.list_sources().map(|s|s.catalogue_revision).ok();
            if let Err(reason) = store.discover_legacy_lunii(
                app.path().home_dir().ok(),
                app.path().config_dir().ok(),
                app.path().data_dir().ok(),
            ) {
                log::warn!("Existing official metadata unavailable: {}", reason.code);
            }
            if let Ok(list)=store.list_sources() {if Some(list.catalogue_revision)!=before_legacy {let _=app.emit("catalogue-changed",serde_json::json!({"catalogueRevision":list.catalogue_revision,"scope":"entries"}));}}
            let emitter = app.clone();
            let sink: watch::ChangeSink = Arc::new(move |revision| {
                let changed = serde_json::json!({
                    "catalogueRevision": revision,
                    "scope": "entries",
                });
                let request = emitter.clone();
                std::thread::spawn(move || {
                    if let Ok(store) = open_store(&request) {
                        store.download_lunii_covers(operation_sink(request));
                        store.request_cover_prefabrication();
                    }
                });
                if let Err(error) = emitter.emit("catalogue-changed", changed) {
                    log::warn!("Catalogue event: {error}");
                }
            });
            // Background repair of the source keys and resolved paths, each
            // probe bounded, before the watcher inventories active sources.
            if let Err(reason) = store.reconcile_sources() {
                log::warn!(target: "catalogue_watch", "sources not reconciled: {reason}");
            }
            // Covers missing from the store (first start, cache cleared) are
            // prepared in the background; a scan finishing later asks again.
            store.request_cover_prefabrication();
            // The watcher's initial reconciliation inventories paths and stats,
            // opening only changed packs. Register reporting before it starts:
            // no operation for an unchanged source, ordinary reports otherwise.
            if let Err(reason) = store.set_operation_sink(operation_sink(app.clone())) {
                log::warn!(target: "catalogue_watch", "operation reporting unavailable: {reason}");
            }
            let config = watch::Config::default();
            match watch::Service::start(store, writes::shared(), cache, data, config, sink) {
                Ok(service) => {
                    if let Ok(mut slot) = app.state::<CatalogueState>().watch.lock() {
                        *slot = Some(service);
                    }
                }
                Err(reason) => {
                    log::warn!(target: "catalogue_watch", "watcher not started: {reason}");
                    return;
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let app = app.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        stop_watching(&app);
                    }
                });
            }
        });
    if let Err(reason) = spawned {
        log::warn!(target: "catalogue_watch", "watcher thread not started: {reason}");
    }
}

/// Stops the watchers; the worker finishes its current refresh off the
/// event-loop thread.
fn stop_watching(app: &AppHandle) {
    let service = app
        .state::<CatalogueState>()
        .watch
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    if let Ok(store) = open_store(app) {
        store.cancel_cover_prefabrication();
    }
    if let Some(service) = service {
        std::thread::spawn(move || service.stop());
    }
}

/// Records the workspace and reconciles the sources off the caller's thread:
/// every probe is bounded and no lock is held while probing. A change
/// re-installs the watchers and notifies the interface. Requests arriving
/// during a pass are merged into one more pass.
pub fn maintain_sources(app: &AppHandle, workspace: Option<String>) {
    let state = app.state::<CatalogueState>();
    let Ok(mut slot) = state.maintenance.lock() else {
        return;
    };
    slot.1 = Some(workspace);
    if slot.0 {
        return;
    }
    slot.0 = true;
    drop(slot);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("catalogue-sources".into())
        .spawn({
            let app = app.clone();
            move || loop {
                let state = app.state::<CatalogueState>();
                let next = match state.maintenance.lock() {
                    Ok(mut slot) => match slot.1.take() {
                        Some(workspace) => workspace,
                        None => {
                            slot.0 = false;
                            return;
                        }
                    },
                    Err(_) => return,
                };
                let changed = open_store(&app).and_then(|store| {
                    let remembered = store.remember_workspace(next.as_deref())?;
                    let reconciled = store.reconcile_sources()?.changed();
                    if !(remembered || reconciled) {
                        return Ok(None::<i64>);
                    }
                    store
                        .read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))
                        .map(Some)
                });
                match changed {
                    Ok(Some(revision)) => {
                        sources_changed(&app);
                        let changed = serde_json::json!({
                            "catalogueRevision": revision,
                            "scope": "sources",
                        });
                        if let Err(error) = app.emit("catalogue-changed", changed) {
                            log::warn!("Catalogue event: {error}");
                        }
                    }
                    Ok(None) => {}
                    Err(reason) => {
                        log::warn!(target: "catalogue_watch", "sources maintenance: {reason}");
                    }
                }
            }
        });
    if let Err(reason) = spawned {
        if let Ok(mut slot) = app.state::<CatalogueState>().maintenance.lock() {
            slot.0 = false;
        }
        log::warn!(target: "catalogue_watch", "sources maintenance not started: {reason}");
    }
}

/// Installs or drops watchers after the source list changed.
pub fn sources_changed(app: &AppHandle) {
    if let Ok(slot) = app.state::<CatalogueState>().watch.lock() {
        if let Some(service) = slot.as_ref() {
            service.sources_changed();
        }
    }
}

pub fn watch_status(app: &AppHandle) -> Option<watch::WatchStatus> {
    app.state::<CatalogueState>()
        .watch
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(watch::Service::status))
}

/// Forwards operation snapshots; a terminal snapshot that changed the index
/// (cancelled scans included) also invalidates the entry views.
pub fn operation_sink(handle: tauri::AppHandle) -> super::scan::Sink {
    use tauri::Emitter;
    Arc::new(move |event, progress| {
        if !progress.request_id.starts_with("lunii-auto-") {
            if let Err(error) = handle.emit(event, progress) {
                log::warn!("Catalogue event: {error}");
            }
        }

        if event == "catalogue-operation-finished" && progress.catalogue_changed {
            // After a scan, prepare the covers the grid will show;
            // interactive requests keep priority. A retained official image
            // (`lunii-auto-*`) only changes one fiche: made on demand.
            if !progress.request_id.starts_with("lunii-auto-") {
                if let Ok(store) = open_store(&handle) {
                    store.request_cover_prefabrication();
                }
            }
            let changed = serde_json::json!({
                "catalogueRevision": progress.catalogue_revision,
                "scope": "entries",
            });
            if let Err(error) = handle.emit("catalogue-changed", changed) {
                log::warn!("Catalogue event: {error}");
            }
        }
    })
}
