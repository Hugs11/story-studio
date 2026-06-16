use super::*;

#[test]
fn audio_assembly_filename_forces_mp3_and_rejects_paths() {
    assert_eq!(
        validate_audio_assembly_filename("histoire_complete").unwrap(),
        "histoire_complete.mp3"
    );
    assert_eq!(
        validate_audio_assembly_filename("histoire_complete.wav").unwrap(),
        "histoire_complete.mp3"
    );
    let err = validate_audio_assembly_filename("../histoire.mp3").unwrap_err();
    assert!(err.contains("invalide"));
    let err = validate_audio_assembly_filename("histoire:complete.mp3").unwrap_err();
    assert!(err.contains("interdits"));
}

#[test]
fn audio_assembly_unique_path_never_overwrites() {
    let project_dir = temp_project_dir("assembly_unique");
    fs::create_dir_all(&project_dir).expect("create temp project dir");
    let existing = project_dir.join("histoire.mp3");
    fs::write(&existing, b"audio").expect("write existing file");

    let next = unique_audio_assembly_path(&project_dir, "histoire.mp3").unwrap();
    assert_ne!(next, existing);
    assert_eq!(
        next.file_name()
            .and_then(OsStr::to_str)
            .unwrap()
            .split('.')
            .next()
            .unwrap(),
        next.file_stem().and_then(OsStr::to_str).unwrap()
    );
    assert!(next
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap()
        .starts_with("histoire--"));

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn concat_audio_files_requires_two_inputs_before_ffmpeg() {
    let err = concat_audio_files("C:/projet/test.mbah", &[], "sortie.mp3", 0.0, None).unwrap_err();
    assert!(err.contains("au moins deux"));
}

#[test]
fn concat_audio_files_smoke_with_ffmpeg_when_available() {
    let Ok(ffmpeg) = get_ffmpeg_path() else {
        return;
    };
    let project_dir = temp_project_dir("assembly_smoke");
    fs::create_dir_all(&project_dir).expect("create temp project dir");
    let input_a = project_dir.join("partie_1.wav");
    let input_b = project_dir.join("partie_2.wav");
    run_ffmpeg_make_silence(&ffmpeg, 0.05, &input_a).expect("create first wav");
    run_ffmpeg_make_silence(&ffmpeg, 0.05, &input_b).expect("create second wav");
    let save_path = project_dir.join("story.mbah");

    let output = concat_audio_files(
        save_path.to_str().unwrap(),
        &[
            input_a.to_string_lossy().to_string(),
            input_b.to_string_lossy().to_string(),
        ],
        "histoire_complete.wav",
        0.05,
        None,
    )
    .expect("concat audio files");
    let output_path = PathBuf::from(output);
    assert!(output_path.is_file());
    let expected_dir =
        fs::canonicalize(project_dir.join("fichiers-importes")).expect("canonical output dir");
    let actual_dir = output_path.parent().expect("output parent");
    assert_eq!(
        path_without_windows_extended_prefix(actual_dir),
        path_without_windows_extended_prefix(&expected_dir),
    );
    assert_eq!(
        output_path.file_name().and_then(OsStr::to_str),
        Some("histoire_complete.mp3")
    );

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn audio_edit_filter_builds_trim_with_fades() {
    let (filter, map) = audio_edit_filter("trim", 1.0, 6.0, 0.5, 0.75, 0.0).expect("trim filter");
    assert_eq!(map, "out");
    assert_eq!(
        filter,
        "[0:a]atrim=start=1.000:end=6.000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.500,afade=t=out:st=4.250:d=0.750[out]"
    );
}

#[test]
fn audio_edit_filter_builds_cut_with_crossfade() {
    let (filter, map) = audio_edit_filter("cut", 2.0, 4.0, 0.0, 0.0, 0.25).expect("cut filter");
    assert_eq!(map, "out");
    assert_eq!(
        filter,
        "[0:a]atrim=end=2.000,asetpts=PTS-STARTPTS[a1];[0:a]atrim=start=4.000,asetpts=PTS-STARTPTS[a2];[a1][a2]acrossfade=d=0.250:c1=tri:c2=tri[body];[body]anull[out]"
    );
}

#[test]
fn audio_edit_filter_builds_cut_to_end() {
    let (filter, map) =
        audio_edit_filter("cut", 2.0, 1_000_000.0, 0.0, 0.0, 0.0).expect("cut to end filter");
    assert_eq!(map, "out");
    assert_eq!(filter, "[0:a]atrim=end=2.000,asetpts=PTS-STARTPTS[out]");
}

#[test]
fn audio_edit_filter_builds_cut_from_start() {
    let (filter, map) =
        audio_edit_filter("cut", 0.0, 2.0, 0.0, 0.0, 0.0).expect("cut from start filter");
    assert_eq!(map, "out");
    assert_eq!(filter, "[0:a]atrim=start=2.000,asetpts=PTS-STARTPTS[out]");
}

#[test]
fn is_original_backup_matches_convention() {
    assert!(is_original_backup("song.original.mp3"));
    assert!(is_original_backup("song.original-2.mp3"));
    assert!(is_original_backup("song.original-42.flac"));
    assert!(is_original_backup(r"C:\path\to\song.original.mp3"));

    assert!(!is_original_backup("song.mp3"));
    assert!(!is_original_backup("song.originals.mp3"));
    assert!(!is_original_backup("song.original-.mp3"));
    assert!(!is_original_backup("song.original-a.mp3"));
    assert!(!is_original_backup("original.mp3"));
    assert!(!is_original_backup(""));
}

#[test]
fn audio_edit_original_path_returns_visible_sibling() {
    let dir = temp_project_dir("orig_sibling");
    fs::create_dir_all(&dir).expect("create dir");
    let edited = dir.join("song.mp3");
    write_temp_file(&edited, b"edited");

    let path = audio_edit_original_path(&edited, "mp3").expect("compute original path");
    assert_eq!(path, dir.join("song.original.mp3"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn audio_edit_original_path_handles_collision() {
    let dir = temp_project_dir("orig_collision");
    fs::create_dir_all(&dir).expect("create dir");
    let edited = dir.join("song.mp3");
    write_temp_file(&edited, b"edited");
    // Simule un original déjà présent.
    write_temp_file(&dir.join("song.original.mp3"), b"existing");

    let path = audio_edit_original_path(&edited, "mp3").expect("compute original path");
    assert_eq!(path, dir.join("song.original-2.mp3"));

    // Et avec deux collisions :
    write_temp_file(&dir.join("song.original-2.mp3"), b"existing-2");
    let path = audio_edit_original_path(&edited, "mp3").expect("compute original path");
    assert_eq!(path, dir.join("song.original-3.mp3"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn audio_edit_info_reopens_current_file_after_saved_edit() {
    let workspace = temp_workspace_with_dirs("audio_info_current_file");
    let imports = workspace.join("fichiers-importes");
    let edited = imports.join("song.mp3");
    let original = imports.join("song.original.mp3");
    write_temp_file(&edited, b"edited");
    write_temp_file(&original, b"original");
    write_audio_edit_sidecar(
        &edited,
        &AudioEditSidecar {
            original_path: original.to_string_lossy().to_string(),
            mode: "trim".to_string(),
            start_sec: 1.0,
            end_sec: 4.0,
            fade_in_sec: 0.5,
            fade_out_sec: 0.25,
            cut_fade_sec: 0.0,
        },
    )
    .expect("write sidecar");

    let info = audio_edit_info(
        edited.to_str().unwrap(),
        None,
        Some(workspace.to_str().unwrap()),
    )
    .expect("read audio edit info");

    assert!(info.original_available);
    let original_path = PathBuf::from(info.original_path.as_deref().expect("original path"));
    assert_eq!(fs::read(original_path).expect("read original"), b"original");
    let source_path = PathBuf::from(&info.source_path);
    assert_eq!(fs::read(&source_path).expect("read source"), b"edited");
    assert_eq!(
        source_path.file_name().and_then(OsStr::to_str),
        Some("song.mp3")
    );
    assert_eq!(info.mode, None);
    assert_eq!(info.start_sec, None);
    assert_eq!(info.end_sec, None);
    assert_eq!(info.fade_in_sec, 0.0);
    assert_eq!(info.fade_out_sec, 0.0);
    assert_eq!(info.cut_fade_sec, 0.0);
    assert_eq!(audio_edit_source_for(&edited), edited);

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn restore_audio_original_supports_legacy_hidden_backup() {
    let workspace = temp_workspace_with_dirs("restore_legacy");
    let imports = workspace.join("fichiers-importes");
    let edited = imports.join("song.mp3");
    let legacy_backup = imports.join(AUDIO_EDIT_DIR).join("song.mp3.original.mp3");
    write_temp_file(&edited, b"edited");
    write_temp_file(&legacy_backup, b"original");
    write_audio_edit_sidecar(
        &edited,
        &AudioEditSidecar {
            original_path: legacy_backup.to_string_lossy().to_string(),
            mode: "trim".to_string(),
            start_sec: 0.0,
            end_sec: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            cut_fade_sec: 0.0,
        },
    )
    .expect("write sidecar");
    let sidecar = audio_edit_sidecar_path(&edited).expect("sidecar path");

    restore_audio_original(
        edited.to_str().unwrap(),
        None,
        Some(workspace.to_str().unwrap()),
    )
    .expect("restore original");

    assert_eq!(fs::read(&edited).expect("read restored"), b"original");
    assert!(!legacy_backup.exists(), "legacy backup should be consumed");
    assert!(!sidecar.exists(), "sidecar should be removed");
    assert!(
        !imports.join(AUDIO_EDIT_DIR).exists(),
        "empty legacy dot folder should be cleaned"
    );

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn restore_audio_original_does_not_delete_unexpected_external_original() {
    let workspace = temp_workspace_with_dirs("restore_external_guard");
    let imports = workspace.join("fichiers-importes");
    let outside = temp_project_dir("restore_external_source");
    let edited = imports.join("song.mp3");
    let external_original = outside.join("external.mp3");
    write_temp_file(&edited, b"edited");
    write_temp_file(&external_original, b"external original");
    write_audio_edit_sidecar(
        &edited,
        &AudioEditSidecar {
            original_path: external_original.to_string_lossy().to_string(),
            mode: "trim".to_string(),
            start_sec: 0.0,
            end_sec: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            cut_fade_sec: 0.0,
        },
    )
    .expect("write sidecar");

    restore_audio_original(
        edited.to_str().unwrap(),
        None,
        Some(workspace.to_str().unwrap()),
    )
    .expect("restore original");

    assert_eq!(
        fs::read(&edited).expect("read restored"),
        b"external original"
    );
    assert!(
        external_original.exists(),
        "restore must not delete a sidecar path outside expected backup locations"
    );

    fs::remove_dir_all(workspace).expect("cleanup workspace");
    fs::remove_dir_all(outside).expect("cleanup outside");
}
