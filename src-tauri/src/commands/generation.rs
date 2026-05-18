use tauri::{AppHandle, Emitter};

use crate::domain::project::Project;
use crate::domain::validation::validate_project_for_generation;
use crate::support::lunii_zip_validator::validate_lunii_zip;

#[tauri::command]
pub async fn generate_pack(
    app: AppHandle,
    project_json: String,
    output_folder: String,
) -> Result<String, String> {
    let project: Project =
        serde_json::from_str(&project_json).map_err(|e| format!("JSON invalide : {}", e))?;
    validate_project_for_generation(&project)?;

    tauri::async_runtime::spawn_blocking(move || {
        run_generate_pack_sync(app, project, output_folder)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn generate_pack_native_dry_run(
    app: AppHandle,
    project_json: String,
) -> Result<String, String> {
    let project: Project =
        serde_json::from_str(&project_json).map_err(|e| format!("JSON invalide : {}", e))?;
    validate_project_for_generation(&project)?;

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = app.emit("generate-log", msg.to_string());
        };
        crate::native_pack::dry_run_native_generation(&project, &emit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn generate_pack_native_v1(
    app: AppHandle,
    project_json: String,
    output_folder: String,
) -> Result<String, String> {
    let project: Project =
        serde_json::from_str(&project_json).map_err(|e| format!("JSON invalide : {}", e))?;
    validate_project_for_generation(&project)?;

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = app.emit("generate-log", msg.to_string());
        };
        let zip_path =
            crate::native_pack::generate_native_pack_v1(&project, &output_folder, &emit)?;
        validate_zip_and_emit(&zip_path, &emit);
        Ok(zip_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_generate_pack_sync(
    app: AppHandle,
    project: Project,
    output_folder: String,
) -> Result<String, String> {
    let emit = |msg: &str| {
        let _ = app.emit("generate-log", msg.to_string());
    };
    let zip_path = crate::native_pack::generate_native_pack_v1(&project, &output_folder, &emit)?;
    validate_zip_and_emit(&zip_path, &emit);
    Ok(zip_path)
}

fn validate_zip_and_emit(zip_path: &str, emit: &dyn Fn(&str)) {
    emit("🔍 Validation format Lunii (contrôle non bloquant)...");
    let report = validate_lunii_zip(zip_path);
    if report.valid {
        let warn_count = report
            .issues
            .iter()
            .filter(|i| i.severity == "warning")
            .count();
        if warn_count > 0 {
            emit(&format!("✅ ZIP valide ({} avertissement(s))", warn_count));
            for issue in &report.issues {
                emit(&format!("  ⚠️  {} : {}", issue.code, issue.message));
            }
        } else {
            emit("✅ ZIP valide — aucune erreur détectée.");
        }
    } else {
        let err_count = report
            .issues
            .iter()
            .filter(|i| i.severity == "error")
            .count();
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
        }
    }
}
