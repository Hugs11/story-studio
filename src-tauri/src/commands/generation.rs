use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use crate::domain::project::Project;
use crate::domain::project_limits::validate_project_menu_depth;
use crate::domain::validation::validate_project_for_generation;
use crate::native_pack::{NativeGenerationWarning, NativePackGenerationResult};
use crate::support::lunii_zip_validator::validate_lunii_zip;

const MAX_PROJECT_JSON_NESTING: usize = 192;

fn ensure_bounded_json_nesting(input: &str) -> Result<(), String> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for byte in input.bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > MAX_PROJECT_JSON_NESTING {
                    return Err(format!(
                        "JSON invalide : imbrication technique supérieure à {MAX_PROJECT_JSON_NESTING}."
                    ));
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

fn parse_project_json(project_json: &str) -> Result<Project, String> {
    ensure_bounded_json_nesting(project_json)?;
    let mut deserializer = serde_json::Deserializer::from_str(project_json);
    deserializer.disable_recursion_limit();
    let project = serde::Deserialize::deserialize(&mut deserializer).map_err(|error| {
        log::error!(target: "generation", "generate_pack: JSON invalide : {}", error);
        format!("JSON invalide : {error}")
    })?;
    deserializer
        .end()
        .map_err(|error| format!("JSON invalide : {error}"))?;
    validate_project_menu_depth(&project)?;
    Ok(project)
}

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
) -> Result<NativePackGenerationResult, String> {
    let project = parse_project_json(&project_json)?;
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
) -> Result<NativePackGenerationResult, String> {
    let started = Instant::now();
    let emit = |msg: &str| {
        let _ = app.emit("generate-log", msg.to_string());
    };
    let should_cancel = || cancel_state.cancelled.load(Ordering::SeqCst);
    let result = match crate::native_pack::generate_native_pack_v1_with_cancel(
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
    let zip_size = std::fs::metadata(&result.zip_path)
        .map(|m| m.len())
        .unwrap_or(0);
    log::info!(target: "generation",
        "generate_pack done in {} ms: zip='{}' size={} bytes",
        started.elapsed().as_millis(), result.zip_path, zip_size,
    );
    if should_cancel() {
        return Err("Génération annulée.".to_string());
    }
    validate_zip_and_emit(&result.zip_path, &emit);
    emit_audio_warnings(&result.warnings, &emit);
    Ok(result)
}

fn emit_audio_warnings(warnings: &[NativeGenerationWarning], emit: &dyn Fn(&str)) {
    if warnings.is_empty() {
        return;
    }
    emit(&format!(
        "⚠️  Pack généré avec {} avertissement(s) audio :",
        warnings.len()
    ));
    for warning in warnings {
        emit(&format!("  ⚠️  {}", warning.message));
        log::warn!(target: "generation_audio",
            "{} role='{}' initial={:.1} LUFS final={} gain={:.1} dB limiting={:.1} dB",
            warning.code,
            warning.role,
            warning.initial_integrated_lufs,
            warning
                .final_integrated_lufs
                .map(|value| format!("{value:.1} LUFS"))
                .unwrap_or_else(|| "non mesuré".to_string()),
            warning.gain_db,
            warning.expected_limiting_db,
        );
    }
    emit("   Le ZIP est utilisable ; vérifiez de préférence ces passages sur la Lunii.");
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::project_limits::{max_menu_depth, project_menu_depth_error};

    fn nested_project_json(depth: usize) -> String {
        let mut entry = r#"{
            "id":"story","type":"story","name":"Histoire complète",
            "audio":"story.mp3","image":"story.png",
            "itemAudio":"title.mp3","itemImage":"title.png",
            "controlSettings":{"autoplay":false,"wheel":false,"pause":true,"ok":true,"home":true},
            "titleControlSettings":{"autoplay":false,"wheel":true,"pause":false,"ok":true,"home":true},
            "returnAfterPlay":"root","returnOnHome":"root","titleReturnOnHome":"root",
            "afterPlaybackPromptAudio":"prompt.mp3",
            "afterPlaybackPromptControlSettings":{"autoplay":true,"wheel":false,"pause":false,"ok":true,"home":true},
            "afterPlaybackPromptOkTarget":"root","afterPlaybackPromptHomeTarget":"root",
            "afterPlaybackSequence":[{
                "id":"step","name":"Étape","audio":"step.mp3","image":"step.png",
                "controlSettings":{"autoplay":true,"wheel":false,"pause":false,"ok":true,"home":true},
                "okTarget":"root","okChoiceTargets":["root"],"homeTarget":"root",
                "homeFollowsOk":false,"homeNone":false
            }],
            "afterPlaybackHomeStep":{
                "id":"home-step","name":"Retour","audio":"home.mp3","image":"home.png",
                "controlSettings":{"autoplay":true,"wheel":false,"pause":false,"ok":true,"home":true},
                "okTarget":"root","okChoiceTargets":[],"homeTarget":"root",
                "homeFollowsOk":false,"homeNone":false
            }
        }"#.to_string();
        for level in (1..=depth).rev() {
            entry = format!(
                r#"{{"id":"folder-{level}","type":"menu","name":"Dossier {level}","children":[{entry}]}}"#
            );
        }
        format!(
            r#"{{"name":"Profondeur","projectType":"pack","rootEntries":[{entry}],"globalOptions":{{"autoNext":false,"nightMode":false}}}}"#
        )
    }

    #[test]
    fn project_parser_accepts_the_complete_sixty_one_level_shape() {
        let project = parse_project_json(&nested_project_json(max_menu_depth()))
            .expect("la profondeur fonctionnelle maximale doit être parsable");
        assert_eq!(project.root_entries.len(), 1);
    }

    #[test]
    fn project_parser_reports_the_functional_limit_before_generation() {
        let observed = max_menu_depth() + 1;
        let error = match parse_project_json(&nested_project_json(observed)) {
            Ok(_) => panic!("la profondeur fonctionnelle doit être refusée"),
            Err(error) => error,
        };
        assert_eq!(error, project_menu_depth_error(observed));
    }

    #[test]
    fn project_parser_keeps_an_independent_technical_json_bound() {
        let excessive = format!(
            "{}0{}",
            "[".repeat(MAX_PROJECT_JSON_NESTING + 1),
            "]".repeat(MAX_PROJECT_JSON_NESTING + 1)
        );
        let error = ensure_bounded_json_nesting(&excessive)
            .expect_err("une structure JSON arbitrairement profonde doit être refusée");
        assert!(error.contains("imbrication technique"));
    }

    #[test]
    fn project_parser_accepts_the_exact_technical_json_bound() {
        let nested_unknown = format!(
            "{}0{}",
            "[".repeat(MAX_PROJECT_JSON_NESTING - 1),
            "]".repeat(MAX_PROJECT_JSON_NESTING - 1)
        );
        let project_json = format!(
            r#"{{"name":"Borne technique","projectType":"pack","rootEntries":[],"globalOptions":{{"autoNext":false,"nightMode":false}},"unknown":{nested_unknown}}}"#
        );
        ensure_bounded_json_nesting(&project_json).expect("la borne exacte doit être acceptée");
        parse_project_json(&project_json)
            .expect("le parseur doit supporter toute sa borne déclarée");
    }
}
