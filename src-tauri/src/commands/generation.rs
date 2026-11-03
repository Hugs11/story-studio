use crate::support::user_message::{codes, UserMessage};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::domain::project::Project;
use crate::domain::project_limits::{
    validate_project_has_no_legacy_link, validate_project_menu_depth,
};
use crate::domain::validation::validate_project_for_generation;
use crate::native_pack::graph_copy::{graph_copy_of_project, verify_graph_copy, GraphCopy};
use crate::native_pack::simulation::{project_story_for_simulation, SimulationProjection};
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
                    return Err(UserMessage::new(codes::IMPORT_DOCUMENT_JSON_DEPTH_LIMIT)
                        .param(
                            "max_project_json_nesting",
                            (MAX_PROJECT_JSON_NESTING).to_string(),
                        )
                        .into_transport());
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn parse_project_json(project_json: &str) -> Result<Project, String> {
    ensure_bounded_json_nesting(project_json)?;
    let mut deserializer = serde_json::Deserializer::from_str(project_json);
    deserializer.disable_recursion_limit();
    let project = serde::Deserialize::deserialize(&mut deserializer).map_err(|error| {
        log::error!(target: "generation", "generate_pack: JSON invalide : {}", error);
        UserMessage::new(codes::IMPORT_DOCUMENT_JSON_INVALID)
            .param("reason", (error).to_string())
            .with_detail((error).to_string())
            .into_transport()
    })?;
    deserializer.end().map_err(|error| {
        UserMessage::new(codes::IMPORT_DOCUMENT_JSON_INVALID)
            .param("reason", (error).to_string())
            .with_detail((error).to_string())
            .into_transport()
    })?;
    validate_project_menu_depth(&project)?;
    validate_project_has_no_legacy_link(&project)?;
    Ok(project)
}

/// Drapeau d'annulation **partagé** par la génération Libre et l'export avancé.
///
/// Un seul geste d'annulation existe côté produit ; les deux writers le lisent.
#[derive(Default)]
pub struct GenerationCancelState {
    cancelled: AtomicBool,
}

impl GenerationCancelState {
    pub(crate) fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub async fn generate_pack(
    app: AppHandle,
    cancel_state: State<'_, Arc<GenerationCancelState>>,
    project_json: String,
    output_folder: String,
) -> Result<
    crate::services::catalogue::open::generation::Published<NativePackGenerationResult>,
    UserMessage,
> {
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
        // Declared to the catalogue watcher before the engine writes: the
        // archive name is only known at the end, so the folder is declared.
        let write = crate::services::catalogue::writes::OwnWrite::begin(
            crate::services::catalogue::writes::Declaration::new("generation")
                .subtree(&output_folder),
        );
        let result = run_generate_pack_sync(app, cancel_state, project, output_folder);
        write.finish(&result, |done| vec![done.zip_path.clone().into()]);
        result.map(|done| {
            let path = std::path::PathBuf::from(&done.zip_path);
            crate::services::catalogue::open::generation::Published::capture(done, &path)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(UserMessage::from)
}

/// Projette un projet hiérarchique dans le graphe à plat que le simulateur joue,
/// **sans produire d'archive**.
///
/// C'est ce qui permet à Story Studio de n'avoir qu'un seul simulateur : le
/// lecteur de graphe joue aussi bien un pack produit, un document d'auteur
/// avancé, que l'arbre du mode Libre — parce que le générateur, ici, lui donne
/// le même graphe des trois côtés.
///
/// Aucun média n'est préparé : ni FFmpeg, ni redimensionnement, ni dossier
/// temporaire. Le simulateur ouvre les fichiers d'origine, comme il le faisait
/// déjà côté Libre. La validation de production n'est **pas** appliquée : un
/// projet en cours d'écriture doit rester écoutable, et c'est précisément ce
/// que la porte « éléments à corriger » interdit de produire.
#[tauri::command]
pub async fn project_pack_for_simulation(
    project_json: String,
) -> Result<SimulationProjection, String> {
    let project = parse_project_json(&project_json)?;
    tauri::async_runtime::spawn_blocking(move || project_story_for_simulation(&project))
        .await
        .map_err(|error| {
            UserMessage::new(codes::GRAPH_PROJECTION_TASK_INTERRUPTED)
                .param("reason", (error).to_string())
                .with_detail((error).to_string())
                .into_transport()
        })?
}

/// Copie graphe d'un projet par menus : payload d'auteur et liaisons, tirés de
/// la projection que l'écoute emploie déjà. Rien n'est écrit sur le disque.
#[tauri::command]
pub async fn copy_project_to_graph(project_json: String) -> Result<GraphCopy, String> {
    let project = parse_project_json(&project_json)?;
    tauri::async_runtime::spawn_blocking(move || graph_copy_of_project(&project))
        .await
        .map_err(|error| {
            UserMessage::new(codes::EXPORT_COPY_TASK_INTERRUPTED)
                .param("reason", (error).to_string())
                .with_detail((error).to_string())
                .into_transport()
        })?
}

/// Garde de fidélité de la copie graphe, appelée sur le payload final, juste
/// avant l'écriture du fichier.
#[tauri::command]
pub async fn verify_project_graph_copy(
    project_json: String,
    payload: String,
) -> Result<(), String> {
    let project = parse_project_json(&project_json)?;
    tauri::async_runtime::spawn_blocking(move || verify_graph_copy(&project, &payload))
        .await
        .map_err(|error| {
            UserMessage::new(codes::EXPORT_VERIFY_TASK_INTERRUPTED)
                .param("reason", (error).to_string())
                .with_detail((error).to_string())
                .into_transport()
        })?
}

#[tauri::command]
pub fn cancel_generate_pack(
    app: AppHandle,
    cancel_state: State<'_, Arc<GenerationCancelState>>,
) -> Result<(), String> {
    cancel_state.cancelled.store(true, Ordering::SeqCst);
    let _ = app.emit(
        "generate-log",
        UserMessage::new(codes::GENERATION_CANCEL_REQUESTED),
    );
    log::warn!(target: "generation", "generate_pack cancellation requested");
    Ok(())
}

fn run_generate_pack_sync(
    app: AppHandle,
    cancel_state: Arc<GenerationCancelState>,
    project: Project,
    output_folder: String,
) -> Result<NativePackGenerationResult, String> {
    let emit = |msg: &str| {
        let _ = app.emit("generate-log", UserMessage::from(msg.to_string()));
    };
    let should_cancel = || cancel_state.cancelled.load(Ordering::SeqCst);
    let identity = crate::native_pack::output_identity::for_project(
        &project,
        Some(&*app.state::<crate::services::catalogue::CatalogueState>()),
    )?;
    run_generation(&emit, &should_cancel, |emit, should_cancel| {
        crate::native_pack::generate_with_identity(
            &project,
            &output_folder,
            emit,
            should_cancel,
            &identity,
        )
    })
}

/// Le déroulé d'une génération Libre autour du moteur, sans runtime Tauri.
///
/// L'annulation n'est relue que **par le moteur**, jusqu'à la publication :
/// une fois le ZIP publié, une demande arrivée trop tard ne le déclasse plus.
/// Le fichier existe ; le rapporter comme annulé cacherait son chemin, comme
/// le fait déjà l'export du graphe dans la même file.
fn run_generation(
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
    generate: impl FnOnce(
        &dyn Fn(&str),
        &(dyn Fn() -> bool + Sync),
    ) -> Result<NativePackGenerationResult, String>,
) -> Result<NativePackGenerationResult, String> {
    let started = Instant::now();
    let result = match generate(emit, should_cancel) {
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
        log::warn!(target: "generation",
            "generate_pack: annulation arrivée après la publication, ZIP conservé : '{}'",
            result.zip_path,
        );
    }
    validate_zip_and_emit(&result.zip_path, emit);
    emit_audio_warnings(&result.warnings, emit);
    Ok(result)
}

fn emit_audio_warnings(warnings: &[NativeGenerationWarning], emit: &dyn Fn(&str)) {
    if warnings.is_empty() {
        return;
    }
    emit(
        &UserMessage::new(codes::GENERATION_PACK_AUDIO_WARNINGS)
            .param("warnings", (warnings.len()).to_string())
            .into_transport(),
    );
    for warning in warnings {
        emit(
            &UserMessage::new(codes::GENERATION_LOG_AUDIO_WARNING)
                .param("warning_message", (warning.message).to_string())
                .into_transport(),
        );
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
    emit(&UserMessage::new(codes::GENERATION_ZIP_DEVICE_CHECK_ADVISED).into_transport());
}

fn validate_zip_and_emit(zip_path: &str, emit: &dyn Fn(&str)) {
    emit(&UserMessage::new(codes::GENERATION_LUNII_VALIDATION_OBSERVED).into_transport());
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
            emit(
                &UserMessage::new(codes::GENERATION_ZIP_VALIDATION_WARNINGS)
                    .param("warn_count", (warn_count).to_string())
                    .into_transport(),
            );
            for issue in &report.issues {
                emit(
                    &UserMessage::new(codes::GENERATION_LOG_ARCHIVE_WARNING)
                        .param("issue_code", (issue.code).to_string())
                        .param("issue_message", (issue.message).to_string())
                        .into_transport(),
                );
                log::warn!(target: "lunii_validator",
                    "post-gen warn [{}]: {}", issue.code, issue.message);
            }
        } else {
            emit(&UserMessage::new(codes::GENERATION_ZIP_VALIDATION_SUCCESS).into_transport());
        }
        log::info!(target: "lunii_validator",
            "post-gen ok: warnings={} errors={}", warn_count, err_count);
    } else {
        emit(
            &UserMessage::new(codes::GENERATION_ZIP_VALIDATION_ERRORS)
                .param("err_count", (err_count).to_string())
                .into_transport(),
        );
        emit(&UserMessage::new(codes::GENERATION_PACK_DEVICE_TEST_ADVISED).into_transport());
        for issue in &report.issues {
            let icon = if issue.severity == "error" {
                "❌"
            } else {
                "⚠️ "
            };
            emit(
                &UserMessage::new(codes::GENERATION_LOG_ARCHIVE_ISSUE)
                    .param("icon", (icon).to_string())
                    .param("issue_code", (issue.code).to_string())
                    .param("issue_message", (issue.message).to_string())
                    .into_transport(),
            );
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

    /// Annulation demandée pendant que le moteur publie : le ZIP existe, son
    /// chemin est rendu, et l'issue n'est pas « annulée ».
    #[test]
    fn a_cancellation_arriving_after_publication_keeps_the_published_zip() {
        let dir = std::env::temp_dir().join(format!(
            "story_studio_late_cancel_{}_{}",
            std::process::id(),
            crate::support::ffmpeg::now_millis()
        ));
        std::fs::create_dir_all(&dir).expect("create output dir");
        let zip_path = dir.join("pack.zip");
        let cancelled = AtomicBool::new(false);
        let should_cancel = || cancelled.load(Ordering::SeqCst);

        let outcome = run_generation(&|_| {}, &should_cancel, |_, _| {
            std::fs::write(&zip_path, b"zip publie").expect("publish zip");
            cancelled.store(true, Ordering::SeqCst);
            Ok(NativePackGenerationResult {
                zip_path: zip_path.to_string_lossy().to_string(),
                warnings: Vec::new(),
                gate_observations: Vec::new(),
            })
        });

        let result = outcome.expect("un ZIP publié n'est pas une annulation");
        assert_eq!(result.zip_path, zip_path.to_string_lossy());
        assert!(zip_path.exists());
        std::fs::remove_dir_all(dir).expect("cleanup output dir");
    }

    /// Une annulation rapportée par le moteur (rien de publié) reste une
    /// annulation.
    #[test]
    fn a_cancellation_reported_by_the_engine_stays_a_cancellation() {
        let should_cancel = || true;
        let outcome = run_generation(&|_| {}, &should_cancel, |_, _| {
            Err(crate::support::user_message::generation_cancelled().into_transport())
        });
        let error: UserMessage = serde_json::from_str(&outcome.unwrap_err()).unwrap();
        assert_eq!(error.code, codes::GENERATION_CANCELLED);
    }

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
        assert!(crate::support::user_message::contains_code(
            &error,
            "IMPORT_DOCUMENT_JSON_DEPTH_LIMIT"
        ));
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

#[cfg(test)]
#[path = "generation_ui_projects_tests.rs"]
pub(crate) mod ui_projects_tests;
