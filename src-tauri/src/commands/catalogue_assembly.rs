//! Aggregation preparation IPC; business rules live in the catalogue service.
use crate::services::catalogue::{
    self,
    assembly::{Request, Selection},
};
use serde_json::Value;
use std::collections::BTreeMap;
#[tauri::command]
pub async fn catalogue_prepare_assembly(
    app: tauri::AppHandle,
    ordered_selection: Vec<Selection>,
    exemplar_choices: BTreeMap<String, String>,
    request_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.prepare_assembly(
            Request {
                ordered_selection,
                exemplar_choices,
                request_id,
            },
            catalogue::operation_sink(app),
        )
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_release_assembly(
    app: tauri::AppHandle,
    preparation_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.release_assembly(&preparation_id)
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_retain_assembly_task(
    app: tauri::AppHandle,
    preparation_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = catalogue::open_store(&app)?;
        let token = store.retain_assembly_task(&preparation_id)?;
        Ok(serde_json::json!({"leaseId":token}))
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_finish_assembly_task(
    app: tauri::AppHandle,
    lease_id: String,
) -> catalogue::Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.finish_assembly_task(&lease_id)
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_transfer_assembly(
    app: tauri::AppHandle,
    preparation_id: String,
    work_session_id: String,
    request_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::support::temp::app_cache_subdir(
            &app,
            crate::support::temp::SESSION_WORKSPACES_DIR,
        )
        .map_err(catalogue::store::error)?;
        catalogue::open_store(&app)?.transfer_assembly(
            &root,
            &preparation_id,
            &work_session_id,
            &request_id,
        )
    })
    .await
    .map_err(catalogue::store::error)?
}
