use super::*;

#[test]
fn save_recording_requires_saved_project() {
    let err = save_recording(None, None, "recording.webm", b"audio").unwrap_err();
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
    let err =
        save_recording(Some("C:/projet/story.mbah"), None, "recording.webm", &[]).unwrap_err();
    assert!(err.contains("vide"));

    let data = vec![0_u8; MAX_RECORDING_BYTES + 1];
    let err =
        save_recording(Some("C:/projet/story.mbah"), None, "recording.webm", &data).unwrap_err();
    assert!(err.contains("trop volumineux"));
}

#[test]
fn save_recording_writes_inside_recordings_dir() {
    let project_dir = temp_project_dir("writes_inside");
    fs::create_dir_all(&project_dir).expect("create temp project dir");
    let save_path = project_dir.join("story.lunii");

    let written = save_recording(
        Some(save_path.to_str().expect("save path utf8")),
        None,
        "recording.webm",
        b"audio",
    )
    .expect("save recording");
    let written_path = PathBuf::from(&written);
    let expected_recordings_dir = project_dir.join("enregistrements");

    assert!(
        !written.starts_with(r"\\?\"),
        "path must not have UNC prefix"
    );
    assert_eq!(
        written_path.parent(),
        Some(expected_recordings_dir.as_path())
    );
    assert_eq!(fs::read(&written_path).expect("read recording"), b"audio");

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn save_recording_accepts_wav_with_save_path() {
    let project_dir = temp_project_dir("writes_wav");
    fs::create_dir_all(&project_dir).expect("create temp project dir");
    let save_path = project_dir.join("story.mbah");

    let written = save_recording(
        Some(save_path.to_str().expect("save path utf8")),
        None,
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
        Some(project_dir.join("enregistrements").as_path())
    );
    assert_eq!(
        fs::read(&written_path).expect("read wav recording"),
        b"audio"
    );

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn save_recording_prefers_workspace_dir() {
    let project_dir = temp_project_dir("workspace_recording");
    let workspace_dir = project_dir.join("workspace");
    fs::create_dir_all(&workspace_dir).expect("create workspace dir");
    let save_dir = project_dir.join("saved");
    fs::create_dir_all(&save_dir).expect("create save dir");
    let save_path = save_dir.join("story.mbah");

    let written = save_recording(
        Some(save_path.to_str().expect("save path utf8")),
        Some(workspace_dir.to_str().expect("workspace path utf8")),
        "recording.webm",
        b"audio",
    )
    .expect("save workspace recording");
    let written_path = PathBuf::from(&written);

    assert_eq!(
        written_path.parent(),
        Some(workspace_dir.join("enregistrements").as_path())
    );
    assert_eq!(fs::read(&written_path).expect("read recording"), b"audio");

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn save_recording_accepts_session_workspace_without_save_path() {
    let session =
        crate::support::temp::create_session_workspace().expect("create session workspace");

    let written = save_recording(None, Some(&session), "session-recording.webm", b"audio")
        .expect("save recording in session workspace");
    let written_path = PathBuf::from(&written);
    let expected_recordings_dir = PathBuf::from(&session).join("enregistrements");

    assert_eq!(
        written_path.parent(),
        Some(expected_recordings_dir.as_path())
    );
    assert_eq!(fs::read(&written_path).expect("read recording"), b"audio");

    crate::support::temp::cleanup_session_workspace(&session).expect("cleanup session");
}
