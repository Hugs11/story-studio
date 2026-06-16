use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use crate::domain::project::Project;
use crate::domain::validation::validate_project_for_generation;
use crate::support::lunii_zip_validator::validate_lunii_zip;

#[derive(Default)]
pub struct GenerationCancelState {
    cancelled: AtomicBool,
}

#[tauri::command]
pub async fn generate_pack(
    app: AppHandle,
    cancel_state: State<'_, Arc<GenerationCancelState>>,
    project_json: String,
    output_folder: String,
) -> Result<String, String> {
    let project: Project = serde_json::from_str(&project_json).map_err(|e| {
        log::error!(target: "generation", "generate_pack: JSON invalide : {}", e);
        format!("JSON invalide : {}", e)
    })?;
    validate_project_for_generation(&project).map_err(|e| {
        log::error!(target: "generation", "generate_pack: validation refusee : {}", e);
        e
    })?;
    log::info!(target: "generation",
        "generate_pack start: name='{}' rootEntries={} outputFolder='{}'",
        project.name, project.root_entries.len(), output_folder,
    );

    cancel_state.cancelled.store(false, Ordering::SeqCst);
    let cancel_state = cancel_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_generate_pack_sync(app, cancel_state, project, output_folder)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_generate_pack(
    app: AppHandle,
    cancel_state: State<'_, Arc<GenerationCancelState>>,
) -> Result<(), String> {
    cancel_state.cancelled.store(true, Ordering::SeqCst);
    let _ = app.emit("generate-log", "⏹ Annulation demandée…".to_string());
    log::warn!(target: "generation", "generate_pack cancellation requested");
    Ok(())
}

fn run_generate_pack_sync(
    app: AppHandle,
    cancel_state: Arc<GenerationCancelState>,
    project: Project,
    output_folder: String,
) -> Result<String, String> {
    let started = Instant::now();
    let emit = |msg: &str| {
        let _ = app.emit("generate-log", msg.to_string());
    };
    let should_cancel = || cancel_state.cancelled.load(Ordering::SeqCst);
    let zip_path = match crate::native_pack::generate_native_pack_v1_with_cancel(
        &project,
        &output_folder,
        &emit,
        &should_cancel,
    ) {
        Ok(path) => path,
        Err(err) => {
            log::error!(target: "generation",
                "generate_pack failed after {} ms: {}",
                started.elapsed().as_millis(), err,
            );
            return Err(err);
        }
    };
    let zip_size = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    log::info!(target: "generation",
        "generate_pack done in {} ms: zip='{}' size={} bytes",
        started.elapsed().as_millis(), zip_path, zip_size,
    );
    if should_cancel() {
        return Err("Génération annulée.".to_string());
    }
    validate_zip_and_emit(&zip_path, &emit);
    Ok(zip_path)
}

fn validate_zip_and_emit(zip_path: &str, emit: &dyn Fn(&str)) {
    emit("🔍 Validation format Lunii (contrôle non bloquant)...");
    let report = validate_lunii_zip(zip_path);
    let warn_count = report
        .issues
        .iter()
        .filter(|i| i.severity == "warning")
        .count();
    let err_count = report
        .issues
        .iter()
        .filter(|i| i.severity == "error")
        .count();
    if report.valid {
        if warn_count > 0 {
            emit(&format!("✅ ZIP valide ({} avertissement(s))", warn_count));
            for issue in &report.issues {
                emit(&format!("  ⚠️  {} : {}", issue.code, issue.message));
                log::warn!(target: "lunii_validator",
                    "post-gen warn [{}]: {}", issue.code, issue.message);
            }
        } else {
            emit("✅ ZIP valide — aucune erreur détectée.");
        }
        log::info!(target: "lunii_validator",
            "post-gen ok: warnings={} errors={}", warn_count, err_count);
    } else {
        emit(&format!(
            "⚠️  ZIP généré avec {} erreur(s) de validation non bloquante.",
            err_count
        ));
        emit("   Le fichier a été créé, mais il est conseillé de tester le pack sur l'appareil ou dans le simulateur.");
        for issue in &report.issues {
            let icon = if issue.severity == "error" {
                "❌"
            } else {
                "⚠️ "
            };
            emit(&format!("  {} {} : {}", icon, issue.code, issue.message));
            log::warn!(target: "lunii_validator",
                "post-gen issue [{}/{}]: {}", issue.severity, issue.code, issue.message);
        }
        log::warn!(target: "lunii_validator",
            "post-gen finished with non-blocking errors: errors={} warnings={}", err_count, warn_count);
    }
}
