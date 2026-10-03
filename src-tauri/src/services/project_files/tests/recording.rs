use super::*;

#[test]
fn save_recording_requires_a_workspace() {
    let err = save_recording(None, "recording.webm", b"audio").unwrap_err();
    assert!(err.contains("emplacement de travail"));
}

#[test]
fn save_recording_rejects_unsafe_filename() {
    let err = validate_recording_filename("../recording.webm").unwrap_err();
    assert!(err.contains("invalide"));

    for filename in [
        r"folder/recording.webm",
        r"folder\recording.webm",
        "recording?.wav",
    ] {
        let err = validate_recording_filename(filename).unwrap_err();
        assert!(
            err.contains("invalide") || err.contains("interdits"),
            "{filename:?} should be rejected with a filename error"
        );
    }

    let err = validate_recording_filename("recording.mp3").unwrap_err();
    assert!(err.contains("Extension"));

    let err = validate_recording_filename("recording.exe").unwrap_err();
    assert!(err.contains("Extension"));

    let long_name = format!("{}.wav", "a".repeat(300));
    let err = validate_recording_filename(&long_name).unwrap_err();
    assert!(err.contains("trop long"));
}

#[test]
fn save_recording_rejects_empty_or_oversized_data() {
    let err = save_recording(Some("C:/projet"), "recording.webm", &[]).unwrap_err();
    assert!(err.contains("vide"));

    let data = vec![0_u8; MAX_RECORDING_BYTES + 1];
    let err = save_recording(Some("C:/projet"), "recording.webm", &data).unwrap_err();
    assert!(err.contains("trop volumineux"));
}

#[test]
fn save_recording_writes_inside_recordings_dir() {
    let workspace_dir = temp_project_dir("writes_inside");
    fs::create_dir_all(&workspace_dir).expect("create temp workspace dir");

    let written = save_recording(
        Some(workspace_dir.to_str().expect("workspace path utf8")),
        "recording.webm",
        b"audio",
    )
    .expect("save recording");
    let written_path = PathBuf::from(&written);
    let expected_recordings_dir = workspace_dir.join("enregistrements");

    assert!(
        !written.starts_with(r"\\?\"),
        "path must not have UNC prefix"
    );
    assert_eq!(
        written_path.parent(),
        Some(expected_recordings_dir.as_path())
    );
    assert_eq!(fs::read(&written_path).expect("read recording"), b"audio");

    fs::remove_dir_all(workspace_dir).expect("cleanup temp workspace dir");
}

#[test]
fn save_recording_accepts_wav() {
    let workspace_dir = temp_project_dir("writes_wav");
    fs::create_dir_all(&workspace_dir).expect("create temp workspace dir");

    let written = save_recording(
        Some(workspace_dir.to_str().expect("workspace path utf8")),
        "enregistrement-2026-05-24.wav",
        b"audio",
    )
    .expect("save wav recording");
    let written_path = PathBuf::from(&written);

    assert_eq!(
        written_path.file_name().and_then(OsStr::to_str),
        Some("enregistrement-2026-05-24.wav")
    );
    assert_eq!(
        written_path.parent(),
        Some(workspace_dir.join("enregistrements").as_path())
    );
    assert_eq!(
        fs::read(&written_path).expect("read wav recording"),
        b"audio"
    );

    fs::remove_dir_all(workspace_dir).expect("cleanup temp workspace dir");
}

#[test]
fn save_recording_accepts_session_workspace() {
    let root = temp_project_dir("session_recording_root");
    let session =
        crate::support::temp::create_session_workspace(&root).expect("create session workspace");

    let written = save_recording(Some(&session), "session-recording.webm", b"audio")
        .expect("save recording in session workspace");
    let written_path = PathBuf::from(&written);
    let expected_recordings_dir = PathBuf::from(&session).join("enregistrements");

    assert_eq!(
        written_path.parent(),
        Some(expected_recordings_dir.as_path())
    );
    assert_eq!(fs::read(&written_path).expect("read recording"), b"audio");

    crate::support::temp::cleanup_session_workspace(&root, &session).expect("cleanup session");
    fs::remove_dir(root).expect("cleanup session root");
}

/// Deux prises sous le même nom : la seconde ne remplace jamais la première.
/// Elle reçoit un nom libre, et le chemin rendu est celui réellement écrit.
fn assert_second_take_keeps_the_first(workspace_dir: Option<&str>, recordings_dir: &Path) {
    let first = save_recording(workspace_dir, "prise.wav", b"premiere").expect("first take");
    let second = save_recording(workspace_dir, "prise.wav", b"seconde").expect("second take");

    assert_ne!(first, second, "la seconde prise doit avoir son propre nom");
    assert_eq!(
        fs::read(&first).expect("read first take"),
        b"premiere",
        "la première prise est intacte"
    );
    assert_eq!(fs::read(&second).expect("read second take"), b"seconde");
    let second_path = PathBuf::from(&second);
    assert_eq!(second_path.parent(), Some(recordings_dir));
    assert_eq!(second_path.extension().and_then(OsStr::to_str), Some("wav"));
}

#[test]
fn save_recording_never_overwrites_an_existing_take_in_a_workspace() {
    let workspace_dir = temp_project_dir("no_overwrite_saved");
    fs::create_dir_all(&workspace_dir).expect("create temp workspace dir");

    assert_second_take_keeps_the_first(
        Some(workspace_dir.to_str().expect("workspace path utf8")),
        &workspace_dir.join("enregistrements"),
    );

    fs::remove_dir_all(workspace_dir).expect("cleanup temp workspace dir");
}

#[test]
fn save_recording_never_overwrites_an_existing_take_in_a_session_workspace() {
    let root = temp_project_dir("no_overwrite_session_root");
    let session =
        crate::support::temp::create_session_workspace(&root).expect("create session workspace");

    assert_second_take_keeps_the_first(
        Some(&session),
        &PathBuf::from(&session).join("enregistrements"),
    );

    crate::support::temp::cleanup_session_workspace(&root, &session).expect("cleanup session");
    fs::remove_dir(root).expect("cleanup session root");
}
