//! Thin data IPC boundary; mutations never write to source packs.
use crate::{
    services::catalogue::{self, data::journal::Mutation, store::Store},
    support::user_message::{codes, UserMessage},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::Emitter;
async fn run<T: Send + 'static>(
    app: tauri::AppHandle,
    task: impl FnOnce(tauri::AppHandle, Arc<Store>) -> catalogue::Result<T> + Send + 'static,
) -> catalogue::Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = catalogue::open_store(&app)?;
        task(app, store)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_get_card(
    app: tauri::AppHandle,
    fiche_id: String,
    inspect_archives: Option<bool>,
) -> catalogue::Result<Value> {
    run(app, move |_, s| {
        let mut card = s.get_card(&fiche_id)?;
        // Only an opened fiche reads its archives, to show the real pack count.
        if inspect_archives == Some(true) {
            s.inspect_archive_removals(&mut card)?;
        }
        Ok(card)
    })
    .await
}
#[tauri::command]
pub async fn catalogue_mutate(
    app: tauri::AppHandle,
    mutation: Value,
    expected_catalogue_revision: i64,
) -> catalogue::Result<Value> {
    let mutation: Mutation = serde_json::from_value(mutation)
        .map_err(|_| UserMessage::new(codes::CATALOG_MUTATION_INVALID))?;
    run(app, move |app, s| {
        let outcome = s.mutate(mutation, expected_catalogue_revision)?;
        if let Err(e) = app.emit(
            "catalogue-changed",
            serde_json::json!({"catalogueRevision":outcome["catalogueRevision"],"scope":"entries"}),
        ) {
            log::warn!("Catalogue event: {e}");
        }
        Ok(outcome)
    })
    .await
}
#[tauri::command]
pub async fn catalogue_stage_cover(
    app: tauri::AppHandle,
    path: String,
) -> catalogue::Result<Value> {
    run(app, move |_, s| s.stage_cover(std::path::Path::new(&path))).await
}
#[tauri::command]
pub async fn catalogue_discard_covers(
    app: tauri::AppHandle,
    cover_staging_ids: Vec<String>,
) -> catalogue::Result<()> {
    run(app, move |_, s| s.discard_covers(&cover_staging_ids)).await
}

#[tauri::command]
pub async fn catalogue_list_tags(app: tauri::AppHandle) -> catalogue::Result<Value> {
    run(app, move |_, s| s.list_tags()).await
}

#[tauri::command]
pub async fn catalogue_last_undo(app: tauri::AppHandle) -> catalogue::Result<Value> {
    run(app, move |_, s| s.last_undo()).await
}

#[tauri::command]
pub async fn catalogue_list_unreferenced(
    app: tauri::AppHandle,
    limit: usize,
    cursor: Option<String>,
) -> catalogue::Result<catalogue::grouping::EntryPage> {
    run(app, move |_, s| {
        s.list_unreferenced(limit, cursor.as_deref())
    })
    .await
}
#[tauri::command]
pub async fn catalogue_preview_forget(
    app: tauri::AppHandle,
    fiche_ids: Vec<String>,
) -> catalogue::Result<Value> {
    run(app, move |_, s| s.preview_forget(&fiche_ids)).await
}

#[tauri::command]
pub async fn catalogue_preview_remove_cards(
    app: tauri::AppHandle,
    fiche_ids: Vec<String>,
) -> catalogue::Result<catalogue::removal::RemovalPreview> {
    run(app, move |_, s| s.preview_remove_cards(&fiche_ids)).await
}
#[tauri::command]
pub async fn catalogue_remove_cards(
    app: tauri::AppHandle,
    fiche_ids: Vec<String>,
    expected_catalogue_revision: i64,
) -> catalogue::Result<Value> {
    run(app, move |app, s| {
        let result = s.remove_cards_confirmed(&fiche_ids, expected_catalogue_revision)?;
        if let Err(reason) = app.emit(
            "catalogue-changed",
            serde_json::json!({"catalogueRevision":result["catalogueRevision"],"scope":"entries"}),
        ) {
            log::warn!("Catalogue event: {reason}");
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn catalogue_remove_missing_exemplar(
    app: tauri::AppHandle,
    exemplar_id: String,
    expected_catalogue_revision: i64,
) -> catalogue::Result<Value> {
    run(app, move |app, s| {
        let result = s.remove_missing_exemplar(&exemplar_id, expected_catalogue_revision)?;
        if let Err(reason) = app.emit(
            "catalogue-changed",
            serde_json::json!({"catalogueRevision":result["catalogueRevision"],"scope":"entries"}),
        ) {
            log::warn!("Catalogue event: {reason}");
        }
        Ok(result)
    })
    .await
}
