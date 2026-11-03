//! File operation IPC: no paths supplied at launch.
use crate::services::catalogue::{
    self,
    files::models::{Decisions, FilePlan, Options, TargetRequest},
};
use serde_json::Value;
use tauri::Manager;
#[tauri::command]
pub async fn catalogue_plan_file_operation(
    app: tauri::AppHandle,
    action: String,
    targets: Vec<TargetRequest>,
    options: Options,
) -> catalogue::Result<FilePlan> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.plan_file_operation(action, targets, options)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_start_file_operation(
    app: tauri::AppHandle,
    plan_id: String,
    decisions: Decisions,
    request_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = app.path().app_data_dir().map_err(catalogue::store::error)?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(catalogue::store::error)?;
        catalogue::open_store(&app)?.start_file_operation(
            plan_id,
            decisions,
            request_id,
            catalogue::operation_sink(app),
            cache,
            data,
        )
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_project_access(
    app: tauri::AppHandle,
    action: String,
    path: Option<String>,
    token: Option<String>,
    work_id: Option<String>,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.project_access(&action, path, token, work_id)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_find_duplicates(
    app: tauri::AppHandle,
    scope: catalogue::files::duplicates::Scope,
    request_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.find_duplicates(
            scope,
            request_id,
            catalogue::operation_sink(app),
        )
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_get_duplicate_results(
    app: tauri::AppHandle,
    operation_id: String,
    offset: usize,
    limit: usize,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.duplicate_results(&operation_id, offset, limit)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_prepare_checker_entry(
    app: tauri::AppHandle,
    exemplar_id: String,
    expected_revision: i64,
) -> catalogue::Result<catalogue::files::checker::Entry> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.prepare_checker_entry(
            &catalogue::open::editor_extractions(&app)?,
            &exemplar_id,
            expected_revision,
        )
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_release_checker_entry(
    app: tauri::AppHandle,
    preparation_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?;
        catalogue::open::release_editor_extractions(&app, &preparation_id)?;
        Ok(serde_json::json!({"released":true}))
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_release_duplicate_results(
    app: tauri::AppHandle,
    operation_id: String,
) -> catalogue::Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.release_duplicate_results(&operation_id)
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_prepare_permanent_delete(
    app: tauri::AppHandle,
    trash_plan_id: String,
) -> catalogue::Result<FilePlan> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.prepare_permanent_delete(&trash_plan_id)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_confirm_file_removal(
    app: tauri::AppHandle,
    plan_id: String,
    stage: String,
    previous_token: Option<String>,
) -> catalogue::Result<catalogue::files::trash::RemovalConfirmation> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.confirm_file_removal(&plan_id, &stage, previous_token)
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_release_file_plan(
    app: tauri::AppHandle,
    plan_id: String,
) -> catalogue::Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.release_file_plan(&plan_id)
    })
    .await
    .map_err(catalogue::store::error)?
}

#[tauri::command]
pub async fn catalogue_identical_copies(
    app: tauri::AppHandle,
    fiche_id: String,
    request_id: String,
) -> catalogue::Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue::open_store(&app)?.identical_copies(&fiche_id, request_id)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub fn catalogue_cancel_identical_copies(
    app: tauri::AppHandle,
    request_id: String,
) -> catalogue::Result<()> {
    catalogue::open_store(&app)?.cancel_identical_copies(request_id)
}
