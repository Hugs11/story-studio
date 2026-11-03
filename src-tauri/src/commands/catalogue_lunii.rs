//! Official database boundary. Only catalogue opening is exposed to the interface.
use crate::services::catalogue::{self, store::Store};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager};
async fn run(
    app: tauri::AppHandle,
    f: impl FnOnce(&tauri::AppHandle, Arc<Store>) -> catalogue::Result<Value> + Send + 'static,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = catalogue::open_store(&app)?;
        f(&app, store)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_lunii_open(app: tauri::AppHandle, locale: String) -> catalogue::Result<()> {
    run(app, move |app, s| {
        let before = s.list_sources()?.catalogue_revision;
        s.lunii_locale(&locale)?;
        s.discover_legacy_lunii(
            app.path().home_dir().ok(),
            app.path().config_dir().ok(),
            app.path().data_dir().ok(),
        )?;
        let result = s.open_lunii(&locale, catalogue::operation_sink(app.clone()))?;
        if s.list_sources()?.catalogue_revision != before {
            changed(app, &s);
        }
        Ok(result)
    })
    .await
    .map(|_| ())
}

fn changed(app: &tauri::AppHandle, s: &Store) {
    if let Ok(list) = s.list_sources() {
        if let Err(reason) = app.emit(
            "catalogue-changed",
            serde_json::json!({"catalogueRevision":list.catalogue_revision,"scope":"entries"}),
        ) {
            log::warn!("Catalogue event: {reason}");
        }
    }
}

#[tauri::command]
pub async fn catalogue_lunii_permission(app: tauri::AppHandle) -> catalogue::Result<Value> {
    run(app, |_, s| {
        s.lunii_permission().map(|v| serde_json::json!(v))
    })
    .await
}

#[tauri::command]
pub async fn catalogue_lunii_set_permission(
    app: tauri::AppHandle,
    allowed: bool,
    locale: String,
) -> catalogue::Result<()> {
    run(app, move |app, s| {
        s.set_lunii_permission(allowed)?;
        if allowed {
            s.lunii_locale(&locale)?;
            s.discover_legacy_lunii(
                app.path().home_dir().ok(),
                app.path().config_dir().ok(),
                app.path().data_dir().ok(),
            )?;
            s.open_lunii(&locale, catalogue::operation_sink(app.clone()))?;
            changed(app, &s);
        }
        Ok(Value::Null)
    })
    .await
    .map(|_| ())
}
