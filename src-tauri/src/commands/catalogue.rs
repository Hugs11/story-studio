//! Thin IPC facade; workspaceDir is passed just like existing file commands.
//! Store access touches the disk (SQLite, path resolution on possibly slow
//! volumes): every command runs off the main thread, like the pack commands.
use crate::{
    services::catalogue::{
        self,
        sources::{Exclusions, SourceList, SourceOutcome},
        store::Store,
        writes::{self, Declaration},
    },
    support::user_message::UserMessage,
};
use std::{path::Path, sync::Arc, time::Duration};
use tauri::{Emitter, Manager};
async fn run<T: Send + 'static>(
    app: tauri::AppHandle,
    task: impl FnOnce(&tauri::AppHandle, Arc<Store>) -> catalogue::Result<T> + Send + 'static,
) -> Result<T, UserMessage> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = catalogue::open_store(&app)?;
        task(&app, store)
    })
    .await
    .map_err(catalogue::store::error)?
}
#[tauri::command]
pub async fn catalogue_list_sources(
    app: tauri::AppHandle,
    workspace_dir: Option<String>,
) -> Result<SourceList, UserMessage> {
    run(app, move |app, store| {
        // The listing reads the database only; recording the workspace and
        // resolving the sources probe the disk, in the background.
        catalogue::maintain_sources(app, workspace_dir);
        let mut list = store.list_sources()?;
        list.items
            .retain(|source| matches!(source.status.as_str(), "active" | "hint"));
        list.total_matching = list.items.len();
        catalogue::sources_changed(app);
        Ok(list)
    })
    .await
}
#[tauri::command]
pub async fn catalogue_add_source(
    app: tauri::AppHandle,
    path: String,
    expected_sources_revision: i64,
    declined: Option<bool>,
) -> Result<SourceOutcome, UserMessage> {
    run(app, move |app, store| {
        let outcome = store.add_source(
            Path::new(&path),
            expected_sources_revision,
            declined.unwrap_or(false),
        )?;
        catalogue::sources_changed(app);
        Ok(outcome)
    })
    .await
}
#[tauri::command]
pub async fn catalogue_remove_source(
    app: tauri::AppHandle,
    source_id: String,
    expected_sources_revision: i64,
    expected_catalogue_revision: i64,
) -> Result<SourceOutcome, UserMessage> {
    run(app, move |app, store| {
        let outcome = store.remove_source_confirmed(
            &source_id,
            expected_sources_revision,
            expected_catalogue_revision,
        )?;
        catalogue::sources_changed(app);
        if let Err(reason) = app.emit(
            "catalogue-changed",
            serde_json::json!({"catalogueRevision":outcome.catalogue_revision,"scope":"entries"}),
        ) {
            log::warn!("Catalogue event: {reason}");
        }
        Ok(outcome)
    })
    .await
}
#[tauri::command]
pub async fn catalogue_preview_remove_source(
    app: tauri::AppHandle,
    source_id: String,
) -> Result<catalogue::removal::RemovalPreview, UserMessage> {
    run(app, move |_, store| store.preview_remove_source(&source_id)).await
}
#[tauri::command]
pub async fn catalogue_get_source_exclusions(
    app: tauri::AppHandle,
) -> Result<Exclusions, UserMessage> {
    run(app, |app, store| {
        store.exclusions_raw(
            &app.path()
                .app_cache_dir()
                .map_err(catalogue::store::error)?,
            &app.path().app_data_dir().map_err(catalogue::store::error)?,
        )
    })
    .await
}

#[tauri::command]
pub async fn catalogue_start_scan(
    app: tauri::AppHandle,
    source_ids: Option<Vec<String>>,
    paths: Option<Vec<String>>,
    request_id: String,
    expected_sources_revision: i64,
) -> Result<catalogue::scan::Receipt, UserMessage> {
    run(app, move |app, store| {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(catalogue::store::error)?;
        let data = app.path().app_data_dir().map_err(catalogue::store::error)?;
        store.start_scan_paths(
            source_ids,
            paths,
            request_id,
            expected_sources_revision,
            cache,
            data,
            catalogue::operation_sink(app.clone()),
        )
    })
    .await
}
#[tauri::command]
pub async fn catalogue_cancel_operation(
    app: tauri::AppHandle,
    operation_id: String,
) -> Result<catalogue::events::Progress, UserMessage> {
    run(app, move |_, store| store.cancel_operation(&operation_id)).await
}
#[tauri::command]
pub async fn catalogue_get_operation(
    app: tauri::AppHandle,
    operation_id: String,
    limit: Option<u32>,
    cursor: Option<String>,
    issues_only: Option<bool>,
) -> Result<catalogue::events::OperationPage, UserMessage> {
    run(app, move |_, store| {
        let page = if issues_only.unwrap_or(false) {
            Store::operation_issue_page
        } else {
            Store::operation_page
        };
        page(
            &store,
            &operation_id,
            limit.unwrap_or(100) as usize,
            cursor.as_deref(),
        )
    })
    .await
}
#[tauri::command]
pub async fn catalogue_list_entries(
    app: tauri::AppHandle,
    limit: Option<u32>,
    cursor: Option<String>,
    include_unavailable: Option<bool>,
) -> Result<catalogue::grouping::EntryPage, UserMessage> {
    run(app, move |_, store| {
        store.query_entries(
            limit.unwrap_or(100) as usize,
            cursor.as_deref(),
            include_unavailable.unwrap_or(false),
        )
    })
    .await
}

/// Completes an explicitly resolved personal-data conflict, if its file and
/// catalogue revision still match. False leaves the convergence pending.
#[tauri::command]
pub async fn catalogue_resolve_identity_convergence(
    app: tauri::AppHandle,
    exemplar_id: String,
    expected_catalogue_revision: i64,
) -> Result<bool, UserMessage> {
    run(app, move |app, store| {
        let resolved =
            store.resolve_identity_convergence(&exemplar_id, expected_catalogue_revision)?;
        if resolved {
            use tauri::Emitter;
            let changed = serde_json::json!({
                "catalogueRevision": expected_catalogue_revision + 1,
                "scope": "entries",
            });
            if let Err(error) = app.emit("catalogue-changed", changed) {
                log::warn!("Catalogue event: {error}");
            }
        }
        Ok(resolved)
    })
    .await
}

/// A project save by the interface is quick: an unconfirmed declaration is
/// released after this delay instead of masking its paths.
const INTERFACE_WRITE_EXPIRY: Duration = Duration::from_secs(5);

/// Declares a write the interface is about to perform (project saves through
/// the file-system plugin), before its first mutation. When available, the
/// identifier is passed back to `catalogue_finish_write`.
#[tauri::command]
pub async fn catalogue_begin_write(
    app: tauri::AppHandle,
    kind: String,
    paths: Vec<String>,
    temporaries: Option<Vec<String>>,
    subtrees: Option<Vec<String>>,
) -> Result<String, UserMessage> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<catalogue::CatalogueState>()
            .ensure_available()?;
        let declaration = Declaration::new(&kind).expiring_after(INTERFACE_WRITE_EXPIRY);
        let declaration = paths.into_iter().fold(declaration, Declaration::exact);
        let declaration = temporaries
            .unwrap_or_default()
            .into_iter()
            .fold(declaration, Declaration::temporary);
        let declaration = subtrees
            .unwrap_or_default()
            .into_iter()
            .fold(declaration, Declaration::subtree);
        Ok(writes::shared().begin(declaration))
    })
    .await
    .map_err(catalogue::store::error)?
}

/// Closes a declared write; success publishes the written files at once,
/// failure has them reconciled. Idempotent.
#[tauri::command]
pub async fn catalogue_finish_write(
    app: tauri::AppHandle,
    operation_id: String,
    succeeded: bool,
) -> Result<(), UserMessage> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<catalogue::CatalogueState>()
            .ensure_available()?;
        writes::shared().finish(&operation_id, succeeded, Vec::new());
        Ok(())
    })
    .await
    .map_err(catalogue::store::error)?
}

/// Watching mode of each source and activity counters (diagnostics);
/// `null` while the watcher is not running.
#[tauri::command]
pub fn catalogue_get_watch_status(
    app: tauri::AppHandle,
) -> Result<Option<catalogue::watch::WatchStatus>, UserMessage> {
    app.state::<catalogue::CatalogueState>()
        .ensure_available()?;
    Ok(catalogue::watch_status(&app))
}

#[tauri::command]
pub async fn catalogue_list_operations(
    app: tauri::AppHandle,
    limit: Option<u32>,
) -> Result<catalogue::scan::OperationList, UserMessage> {
    run(app, move |_, store| {
        store.list_operations(limit.unwrap_or(20) as usize)
    })
    .await
}
#[tauri::command]
pub async fn catalogue_explain_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<catalogue::path_explanation::PathExplanation, UserMessage> {
    run(app, move |app, store| {
        store.explain_path(
            Path::new(&path),
            &app.path()
                .app_cache_dir()
                .map_err(catalogue::store::error)?,
            &app.path().app_data_dir().map_err(catalogue::store::error)?,
        )
    })
    .await
}

/// Shows an exemplar in the file manager after revalidating it (an archive
/// child through its container); a vanished element opens its parent folder.
#[tauri::command]
pub async fn catalogue_reveal_exemplar(
    app: tauri::AppHandle,
    exemplar_id: String,
    expected_revision: i64,
) -> Result<catalogue::reveal::Revealed, UserMessage> {
    run(app, move |_, store| {
        store.reveal_exemplar(
            &exemplar_id,
            expected_revision,
            &catalogue::reveal::SystemRevealer,
        )
    })
    .await
}

/// Shows a scan-report path, only under an active source.
#[tauri::command]
pub async fn catalogue_reveal_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<catalogue::reveal::Revealed, UserMessage> {
    run(app, move |_, store| {
        store.reveal_path(Path::new(&path), &catalogue::reveal::SystemRevealer)
    })
    .await
}

// `exemplarId` et `expectedRevision` sont réservés aux clients ciblant un exemplaire
// et/ou une révision précise ; les appelants JS actuels ne les renseignent pas.
// Conserver leur résolution et leur validation pour ces usages du contrat.
#[tauri::command]
pub async fn catalogue_get_thumbnail(
    app: tauri::AppHandle,
    exemplar_id: Option<String>,
    fiche_id: Option<String>,
    expected_revision: Option<i64>,
) -> Result<catalogue::thumbnails::Thumbnail, UserMessage> {
    let admission = catalogue::thumbnails::Admission::acquire()?;
    run(app, move |app, store| {
        let _admission = admission;
        let before = store.read_snapshot(|c| {
            c.query_row("SELECT revision FROM catalogue", [], |r| r.get::<_, i64>(0))
        })?;
        let result = store.get_thumbnail(
            exemplar_id.as_deref(),
            fiche_id.as_deref(),
            expected_revision,
        );
        let after = store.read_snapshot(|c| {
            c.query_row("SELECT revision FROM catalogue", [], |r| r.get::<_, i64>(0))
        })?;
        if before != after {
            if let Err(reason) = app.emit(
                "catalogue-changed",
                serde_json::json!({"catalogueRevision":after,"scope":"entries"}),
            ) {
                log::warn!("Catalogue event: {reason}");
            }
        }
        result
    })
    .await
}
