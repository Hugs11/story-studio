use super::super::working_output_extension;
use super::*;

pub fn trim_audio(
    input_path: &str,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    if start_sec < 0.0 {
        return Err("Le point de départ ne peut pas être négatif.".to_string());
    }
    if end_sec <= start_sec {
        return Err("Le point de fin doit être après le point de départ.".to_string());
    }

    let input = Path::new(input_path);
    if !input.exists() {
        return Err(format!("Fichier audio introuvable : {}", input_path));
    }

    let input_ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();
    let ext = working_output_extension(&input_ext);
    // Copie sans perte uniquement si le format de travail ne change pas.
    let copy_stream = ext == input_ext;

    let ffmpeg = get_ffmpeg_path()?;

    // Édition en place réservée aux fichiers gérés dont le format ne change pas.
    // Une conversion (entrée lossy -> FLAC) produit un nouveau fichier de travail.
    let in_place = copy_stream && is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_trim_tmp_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_trim(
            &ffmpeg,
            input_path,
            &tmp_path.to_string_lossy(),
            start_sec,
            end_sec,
            &ext,
            copy_stream,
        )?;

        match fs::rename(&tmp_path, input) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }

        Ok(TrimAudioResult {
            output_path: path_for_frontend(input_path),
            path_changed: false,
            original_path: None,
        })
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour découper un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;

        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_trim_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_trim(
            &ffmpeg,
            input_path,
            &out_path.to_string_lossy(),
            start_sec,
            end_sec,
            &ext,
            copy_stream,
        )?;

        Ok(TrimAudioResult {
            output_path: path_for_frontend(&out_path.to_string_lossy()),
            path_changed: true,
            original_path: None,
        })
    }
}

pub fn cut_audio(
    input_path: &str,
    cut_start: f64,
    cut_end: f64,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    if cut_start < 0.001 {
        return Err("Le point d'entrée doit être après le début du fichier.".to_string());
    }
    if cut_end <= cut_start {
        return Err("Le point de sortie doit être après le point d'entrée.".to_string());
    }

    let input = Path::new(input_path);
    if !input.exists() {
        return Err(format!("Fichier audio introuvable : {}", input_path));
    }

    let input_ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();
    let ext = working_output_extension(&input_ext);
    let same_format = ext == input_ext;

    let ffmpeg = get_ffmpeg_path()?;

    let filter = format!(
        "[0:a]atrim=end={cs:.3},asetpts=PTS-STARTPTS[a1];\
         [0:a]atrim=start={ce:.3},asetpts=PTS-STARTPTS[a2];\
         [a1][a2]concat=n=2:v=0:a=1[out]",
        cs = cut_start,
        ce = cut_end,
    );

    // Édition en place uniquement si le format de travail ne change pas.
    let in_place =
        same_format && is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_cut_tmp_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_cut(
            &ffmpeg,
            input_path,
            &tmp_path.to_string_lossy(),
            &filter,
            &ext,
        )?;

        match fs::rename(&tmp_path, input) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }

        Ok(TrimAudioResult {
            output_path: path_for_frontend(input_path),
            path_changed: false,
            original_path: None,
        })
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour couper un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;

        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_cut_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_cut(
            &ffmpeg,
            input_path,
            &out_path.to_string_lossy(),
            &filter,
            &ext,
        )?;

        Ok(TrimAudioResult {
            output_path: path_for_frontend(&out_path.to_string_lossy()),
            path_changed: true,
            original_path: None,
        })
    }
}

pub fn audio_edit_info(
    input_path: &str,
    // save_path / workspace_dir : conserves pour la signature de la commande Tauri
    // (le frontend les envoie), mais inutiles ici. La lecture du sidecar d'edition
    // ne depend que de input_path ; l'ancienne garde is_in_trim_dir redondante a
    // ete retiree (validate_existing_file_path valide deja l'acces).
    _save_path: Option<&str>,
    _workspace_dir: Option<&str>,
) -> Result<AudioEditInfo, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    let sidecar = read_audio_edit_sidecar(&input);
    let original_path = sidecar
        .as_ref()
        .map(|value| PathBuf::from(&value.original_path))
        .filter(|path| path.is_file());

    Ok(AudioEditInfo {
        original_available: original_path.is_some(),
        original_path: original_path.map(|path| path_for_frontend(&path.to_string_lossy())),
        source_path: path_for_frontend(&input.to_string_lossy()),
        mode: None,
        start_sec: None,
        end_sec: None,
        fade_in_sec: 0.0,
        fade_out_sec: 0.0,
        cut_fade_sec: 0.0,
    })
}

pub fn restore_audio_original(
    input_path: &str,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    if !is_in_trim_dir(input_path, workspace_dir, save_path)? {
        return Err(
            "La restauration est réservée aux fichiers audio gérés par le projet.".to_string(),
        );
    }
    let sidecar = read_audio_edit_sidecar(&input)
        .ok_or_else(|| "Aucun original enregistré pour cet audio.".to_string())?;
    // L'original peut être soit en sibling visible (nouvelle convention),
    // soit dans `.story-studio-audio-edits/` (legacy). Les deux cas sont gérés
    // par `validate_existing_file_path` qui canonicalise et vérifie l'existence.
    let original = validate_existing_file_path(&sidecar.original_path, "Audio original")?;
    fs::copy(&original, &input)
        .map_err(|e| format!("Impossible de restaurer l'audio original : {}", e))?;
    let sidecar_parent = audio_edit_sidecar_path(&input)
        .ok()
        .and_then(|sidecar_path| {
            let parent = sidecar_path.parent().map(Path::to_path_buf);
            let _ = fs::remove_file(&sidecar_path);
            parent
        });
    // Nettoyage du fichier original désormais redondant (best-effort), uniquement
    // si le chemin correspond bien à une sauvegarde générée par Story Studio.
    if is_expected_audio_original_path(&input, &original) {
        let _ = fs::remove_file(&original);
    }
    if let Some(parent) = sidecar_parent {
        let _ = fs::remove_dir(parent); // best-effort si vide
    }
    Ok(TrimAudioResult {
        output_path: path_for_frontend(&input.to_string_lossy()),
        path_changed: false,
        original_path: Some(path_for_frontend(&original.to_string_lossy())),
    })
}

pub fn preview_audio_edit(request: AudioEditRequest<'_>) -> Result<String, String> {
    let input = validate_existing_file_path(request.input_path, "Fichier audio")?;
    let source = audio_edit_source_for(&input);
    let output =
        std::env::temp_dir().join(format!("story_studio_audio_preview_{}.wav", now_millis()));
    let ffmpeg = get_ffmpeg_path()?;
    run_ffmpeg_audio_edit(FfmpegAudioEditRequest {
        ffmpeg: &ffmpeg,
        input: &source.to_string_lossy(),
        output: &output.to_string_lossy(),
        params: request.params,
        ext: "wav",
    })?;
    Ok(path_for_frontend(&output.to_string_lossy()))
}

pub fn commit_audio_preview(
    input_path: &str,
    preview_path: &str,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    let preview = validate_existing_file_path(preview_path, "Aperçu audio")?;
    let input_ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();
    let ext = working_output_extension(&input_ext);
    let same_format = ext == input_ext;
    let ffmpeg = get_ffmpeg_path()?;

    let in_place =
        same_format && is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    let (output, final_path, path_changed) = if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_edit_tmp_{}.{}", stem, now_millis(), ext));
        (tmp_path, input.clone(), false)
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour éditer un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_edit_{}.{}", stem, now_millis(), ext));
        (out_path.clone(), out_path, true)
    };

    let existing_sidecar = read_audio_edit_sidecar(&final_path);
    let original_path = if let Some(sidecar) = existing_sidecar {
        PathBuf::from(sidecar.original_path)
    } else {
        let source_ext = input
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or(&input_ext);
        let original_path = audio_edit_original_path(&final_path, source_ext)?;
        if let Some(parent) = original_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier original audio : {}", e))?;
        }
        fs::copy(&input, &original_path)
            .map_err(|e| format!("Impossible de sauvegarder l'audio original : {}", e))?;
        original_path
    };

    run_ffmpeg_transcode(
        &ffmpeg,
        &preview.to_string_lossy(),
        &output.to_string_lossy(),
        &ext,
    )?;

    if !path_changed {
        match fs::rename(&output, &final_path) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&output);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }
    }

    write_audio_edit_sidecar(
        &final_path,
        &AudioEditSidecar {
            original_path: original_path.to_string_lossy().to_string(),
            mode: "chain".to_string(),
            start_sec: 0.0,
            end_sec: 0.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            cut_fade_sec: 0.0,
        },
    )?;

    Ok(TrimAudioResult {
        output_path: path_for_frontend(&final_path.to_string_lossy()),
        path_changed,
        original_path: Some(path_for_frontend(&original_path.to_string_lossy())),
    })
}

pub fn apply_audio_edit(request: AudioEditRequest<'_>) -> Result<TrimAudioResult, String> {
    let input = validate_existing_file_path(request.input_path, "Fichier audio")?;
    let input_ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();
    // Le résultat édité passe au format de travail (FLAC) ; l'original conserve
    // son format pour la restauration.
    let ext = working_output_extension(&input_ext);
    let same_format = ext == input_ext;
    let source = audio_edit_source_for(&input);
    let ffmpeg = get_ffmpeg_path()?;

    let in_place = same_format
        && is_in_trim_dir(request.input_path, request.workspace_dir, request.save_path)
            .unwrap_or(false);

    let (output, final_path, path_changed) = if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_edit_tmp_{}.{}", stem, now_millis(), ext));
        (tmp_path, input.clone(), false)
    } else {
        let importes_dir = match request.workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = request.save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour éditer un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_edit_{}.{}", stem, now_millis(), ext));
        (out_path.clone(), out_path, true)
    };

    let existing_sidecar = read_audio_edit_sidecar(&final_path);
    let original_path = if let Some(sidecar) = existing_sidecar {
        PathBuf::from(sidecar.original_path)
    } else {
        let source_ext = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or(&input_ext);
        let original_path = audio_edit_original_path(&final_path, source_ext)?;
        if let Some(parent) = original_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier original audio : {}", e))?;
        }
        fs::copy(&source, &original_path)
            .map_err(|e| format!("Impossible de sauvegarder l'audio original : {}", e))?;
        original_path
    };

    run_ffmpeg_audio_edit(FfmpegAudioEditRequest {
        ffmpeg: &ffmpeg,
        input: &source.to_string_lossy(),
        output: &output.to_string_lossy(),
        params: request.params,
        ext: &ext,
    })?;

    if !path_changed {
        match fs::rename(&output, &final_path) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&output);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }
    }

    write_audio_edit_sidecar(
        &final_path,
        &AudioEditSidecar {
            original_path: original_path.to_string_lossy().to_string(),
            mode: request.params.mode.to_string(),
            start_sec: request.params.start_sec,
            end_sec: request.params.end_sec,
            fade_in_sec: clamp_fade(
                request.params.fade_in_sec,
                request.params.end_sec - request.params.start_sec,
            ),
            fade_out_sec: clamp_fade(
                request.params.fade_out_sec,
                request.params.end_sec - request.params.start_sec,
            ),
            cut_fade_sec: clamp_fade(request.params.cut_fade_sec, 10.0),
        },
    )?;

    Ok(TrimAudioResult {
        output_path: path_for_frontend(&final_path.to_string_lossy()),
        path_changed,
        original_path: Some(path_for_frontend(&original_path.to_string_lossy())),
    })
}
