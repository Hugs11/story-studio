//! Portable backup IPC; planning and publication belong to the service.
use crate::services::catalogue::{
    self,
    backup::format::{Decisions, ExportPlan},
};
use serde_json::Value;
#[tauri::command]
pub async fn catalogue_plan_export(
    app: tauri::AppHandle,
    destination_path: String,
    expected_catalogue_revision: i64,
) -> catalogue::Result<ExportPlan> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?
            .plan_catalogue_export(destination_path.into(), expected_catalogue_revision)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_start_export(
    app: tauri::AppHandle,
    plan_id: String,
    decisions: Decisions,
    request_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.start_catalogue_export(
            plan_id,
            decisions,
            request_id,
            catalogue::operation_sink(app),
        )
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_preview_import(
    app: tauri::AppHandle,
    path: String,
    request_id: String,
    associations: Option<std::collections::BTreeMap<String, String>>,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.preview_catalogue_import(
            path.into(),
            request_id,
            associations.unwrap_or_default(),
            catalogue::operation_sink(app),
        )
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_apply_import(
    app: tauri::AppHandle,
    preview_id: String,
    choices: std::collections::BTreeMap<String, String>,
    associations: std::collections::BTreeMap<String, String>,
    expected_catalogue_revision: i64,
    request_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.apply_catalogue_import(
            catalogue::backup::import::ApplyImport {
                preview_id,
                choices,
                associations,
                expected_catalogue_revision,
                request_id,
            },
            catalogue::operation_sink(app),
        )
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_get_import_preview(
    app: tauri::AppHandle,
    preview_id: String,
    offset: usize,
    limit: usize,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.import_preview_page(&preview_id, offset, limit)
    })
    .await
    .map_err(catalogue::store::error)?
}
