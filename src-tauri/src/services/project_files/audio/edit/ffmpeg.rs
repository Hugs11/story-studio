use super::*;

pub(crate) fn run_ffmpeg_cut(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    filter: &str,
    ext: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.args([
        "-y",
        "-i",
        input,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
    ]);

    match ext {
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        "wav" => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
        "ogg" => {
            cmd.args(["-c:a", "libvorbis", "-q:a", "4"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Suppression audio échouée :\n{}", stderr.trim()));
    }

    Ok(())
}

pub(crate) fn audio_edit_filter(
    mode: &str,
    start: f64,
    end: f64,
    fade_in: f64,
    fade_out: f64,
    cut_fade: f64,
) -> Result<(String, String), String> {
    if start < 0.0 || !start.is_finite() || !end.is_finite() || end <= start {
        return Err("La sélection audio est invalide.".to_string());
    }

    let body_duration = (end - start).max(0.001);
    let fade_in = clamp_fade(fade_in, body_duration / 2.0);
    let fade_out = clamp_fade(fade_out, body_duration / 2.0);
    let mut post_filters = Vec::new();
    if fade_in > 0.0 {
        post_filters.push(format!("afade=t=in:st=0:d={}", filter_number(fade_in)));
    }
    if fade_out > 0.0 {
        let fade_start = (body_duration - fade_out).max(0.0);
        post_filters.push(format!(
            "afade=t=out:st={}:d={}",
            filter_number(fade_start),
            filter_number(fade_out)
        ));
    }
    let post = if post_filters.is_empty() {
        String::new()
    } else {
        format!(",{}", post_filters.join(","))
    };

    match mode {
        "trim" => Ok((
            format!(
                "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS{}[out]",
                filter_number(start),
                filter_number(end),
                post
            ),
            "out".to_string(),
        )),
        "cut" => {
            if start < 0.001 {
                if end >= 999_999.0 {
                    return Err("La suppression ne peut pas vider tout l'audio.".to_string());
                }
                let mut filters = vec![
                    format!("atrim=start={}", filter_number(end)),
                    "asetpts=PTS-STARTPTS".to_string(),
                ];
                if fade_in > 0.0 {
                    filters.push(format!("afade=t=in:st=0:d={}", filter_number(fade_in)));
                }
                return Ok((
                    format!("[0:a]{}[out]", filters.join(",")),
                    "out".to_string(),
                ));
            }
            if end >= 999_999.0 {
                return Ok((
                    format!(
                        "[0:a]atrim=end={},asetpts=PTS-STARTPTS{}[out]",
                        filter_number(start),
                        post
                    ),
                    "out".to_string(),
                ));
            }
            let cut_fade = clamp_fade(cut_fade, start.min(10.0));
            let join = if cut_fade > 0.0 {
                format!(
                    "[a1][a2]acrossfade=d={}:c1=tri:c2=tri[body];",
                    filter_number(cut_fade)
                )
            } else {
                "[a1][a2]concat=n=2:v=0:a=1[body];".to_string()
            };
            let tail = if post.is_empty() {
                "[body]anull[out]".to_string()
            } else {
                format!("[body]{}[out]", post.trim_start_matches(','))
            };
            Ok((
                format!(
                    "[0:a]atrim=end={},asetpts=PTS-STARTPTS[a1];\
                     [0:a]atrim=start={},asetpts=PTS-STARTPTS[a2];\
                     {}{}",
                    filter_number(start),
                    filter_number(end),
                    join,
                    tail
                ),
                "out".to_string(),
            ))
        }
        _ => Err("Mode d'édition audio inconnu.".to_string()),
    }
}

pub(crate) fn run_ffmpeg_audio_edit(request: FfmpegAudioEditRequest<'_>) -> Result<(), String> {
    let (filter, map_label) = audio_edit_filter(
        request.params.mode,
        request.params.start_sec,
        request.params.end_sec,
        request.params.fade_in_sec,
        request.params.fade_out_sec,
        request.params.cut_fade_sec,
    )?;
    let mut cmd = Command::new(request.ffmpeg);
    apply_no_window(&mut cmd);

    cmd.args([
        "-y",
        "-i",
        request.input,
        "-filter_complex",
        &filter,
        "-map",
    ]);
    cmd.arg(format!("[{}]", map_label));

    match request.ext {
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        "wav" => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
        "ogg" => {
            cmd.args(["-c:a", "libvorbis", "-q:a", "4"]);
        }
        "m4a" | "aac" => {
            cmd.args(["-c:a", "aac", "-b:a", "160k"]);
        }
        _ => {}
    }

    cmd.arg(request.output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(request.output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Édition audio échouée :\n{}", stderr.trim()));
    }

    Ok(())
}

pub(crate) fn run_ffmpeg_transcode(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    ext: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.args(["-y", "-i", input, "-vn"]);

    match ext {
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        "wav" => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
        "ogg" => {
            cmd.args(["-c:a", "libvorbis", "-q:a", "4"]);
        }
        "m4a" | "aac" => {
            cmd.args(["-c:a", "aac", "-b:a", "160k"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Validation audio échouée :\n{}", stderr.trim()));
    }

    Ok(())
}

pub(crate) fn is_in_trim_dir(
    file_path: &str,
    workspace_dir: Option<&str>,
    save_path: Option<&str>,
) -> Result<bool, String> {
    let target =
        fs::canonicalize(file_path).map_err(|e| format!("Fichier inaccessible : {}", e))?;

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(ws) = workspace_dir.filter(|s| !s.trim().is_empty()) {
        bases.push(PathBuf::from(ws));
    }
    if let Some(sp) = save_path.filter(|s| !s.trim().is_empty()) {
        if let Ok(dir) = project_dir_from_save_path(sp) {
            bases.push(dir);
        }
    }

    for base in bases {
        for dir_name in TRIM_IN_PLACE_DIRS {
            let dir = base.join(dir_name);
            if !dir.exists() {
                continue;
            }
            if let Ok(canonical) = fs::canonicalize(&dir) {
                if target.starts_with(&canonical) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

pub(crate) fn run_ffmpeg_trim(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    start: f64,
    end: f64,
    ext: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-ss")
        .arg(format!("{:.3}", start))
        .arg("-to")
        .arg(format!("{:.3}", end));

    match ext {
        "wav" | "flac" => {
            cmd.args(["-c", "copy"]);
        }
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Découpage audio échoué :\n{}", stderr.trim()));
    }

    Ok(())
}
