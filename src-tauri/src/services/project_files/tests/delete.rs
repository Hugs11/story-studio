use super::*;
use crate::support::user_message::codes;
#[cfg(test)]
use crate::support::user_message::MessageTransportAssertions as _;

#[test]
fn delete_workspace_media_file_accepts_images_generees() {
    let workspace = temp_workspace_with_dirs("delete_images");
    let target = workspace.join("images-generees").join("img.png");
    write_temp_file(&target, b"png");

    delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");
    assert!(!target.exists());

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_removes_only_the_target_image_sidecar() {
    let workspace = temp_workspace_with_dirs("delete_image_sidecars");
    let images = workspace.join("images-generees");
    let source = workspace.join("fichiers-importes").join("source.png");
    let first = images.join("first-edited.png");
    let second = images.join("second-edited.png");
    let dot_folder = images.join(IMAGE_EDIT_DIR);
    let first_sidecar = dot_folder.join("first-edited.png.edit.json");
    let second_sidecar = dot_folder.join("second-edited.png.edit.json");
    write_temp_file(&source, b"source");
    write_temp_file(&first, b"first");
    write_temp_file(&second, b"second");
    write_temp_file(
        &first_sidecar,
        format!(r#"{{"sourcePath":"{}"}}"#, source.display()).as_bytes(),
    );
    write_temp_file(&second_sidecar, b"{}");

    delete_workspace_media_file(first.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("first delete should succeed");

    assert!(!first_sidecar.exists(), "target sidecar removed");
    assert!(second_sidecar.exists(), "unrelated sidecar preserved");
    assert!(dot_folder.exists(), "non-empty dot folder preserved");
    assert!(
        source.exists(),
        "source image must never be cascade-deleted"
    );

    delete_workspace_media_file(second.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("second delete should succeed");
    assert!(
        !dot_folder.exists(),
        "empty image sidecar folder cleaned up"
    );
    assert!(
        source.exists(),
        "source image remains after every derived deletion"
    );

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_accepts_fichiers_importes() {
    let workspace = temp_workspace_with_dirs("delete_imports");
    let target = workspace.join("fichiers-importes").join("audio.mp3");
    write_temp_file(&target, b"mp3");

    delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");
    assert!(!target.exists());

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_removes_only_the_requested_hidden_archive() {
    let workspace = temp_workspace_with_dirs("delete_hidden_archive");
    let target = workspace.join("fichiers-importes/.Histoire été.zip");
    let sibling = workspace.join("fichiers-importes/.Autre histoire.zip");
    let outside = workspace.join(".Histoire été.zip");
    let originals = [
        workspace.join("fichiers-importes/.Histoire été.original.zip"),
        workspace.join("fichiers-importes/.Histoire été.original-2.zip"),
        workspace.join("fichiers-importes/.story-studio-audio-edits/.Histoire été.zip.edit.json"),
        workspace
            .join("fichiers-importes/.story-studio-audio-edits/.Histoire été.zip.original-legacy"),
        workspace.join("fichiers-importes/.story-studio-image-edits/.Histoire été.zip.edit.json"),
    ];
    for path in [&target, &sibling, &outside] {
        write_temp_file(path, b"archive");
    }
    for path in &originals {
        write_temp_file(path, b"preexisting");
    }

    crate::commands::files::delete_workspace_media_file(
        target.to_str().unwrap().into(),
        workspace.to_str().unwrap().into(),
        None,
        Some(false),
    )
    .expect("a hidden archive uses the native workspace guard, not plugin-fs scopes");
    assert!(!target.exists());
    assert_eq!(fs::read(&sibling).unwrap(), b"archive");
    for path in &originals {
        assert_eq!(
            fs::read(path).unwrap(),
            b"preexisting",
            "{}",
            path.display()
        );
    }
    assert!(crate::commands::files::delete_workspace_media_file(
        outside.to_str().unwrap().into(),
        workspace.to_str().unwrap().into(),
        None,
        Some(false),
    )
    .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"archive");
    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_default_and_explicit_cascade_keep_the_library_contract() {
    for cascade in [None, Some(true)] {
        let workspace = temp_workspace_with_dirs(if cascade.is_none() {
            "cascade_default"
        } else {
            "cascade_true"
        });
        let target = workspace.join("fichiers-importes/.Histoire.zip");
        let original = workspace.join("fichiers-importes/.Histoire.original.zip");
        write_temp_file(&target, b"created");
        write_temp_file(&original, b"original");
        crate::commands::files::delete_workspace_media_file(
            target.to_str().unwrap().into(),
            workspace.to_str().unwrap().into(),
            None,
            cascade,
        )
        .unwrap();
        assert!(!target.exists());
        assert!(
            !original.exists(),
            "the library still requests its historical cascade"
        );
        fs::remove_dir_all(workspace).unwrap();
    }
}

#[test]
fn folder_pack_cleanup_js_uses_the_real_native_file_only_deletion() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let workspace = temp_workspace_with_dirs("folder_cleanup_transport");
    let target = workspace.join("fichiers-importes/.Histoire.zip");
    let preserved = [
        workspace.join("fichiers-importes/.Histoire.original.zip"),
        workspace.join("fichiers-importes/.Histoire.original-2.zip"),
        workspace.join("fichiers-importes/.Autre.zip"),
        workspace.join("fichiers-importes/.story-studio-audio-edits/.Histoire.zip.edit.json"),
        workspace.join("fichiers-importes/.story-studio-image-edits/.Histoire.zip.edit.json"),
    ];
    for path in &preserved {
        write_temp_file(path, b"preexisting");
    }
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/packFolderCleanupTransport.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start the JS regression with the native cleanup transport");
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        input,
        "{}",
        serde_json::json!({"root": workspace, "target": target, "preserved": preserved})
    )
    .unwrap();
    input.flush().unwrap();
    let mut calls = 0;
    loop {
        let mut line = String::new();
        assert!(
            output.read_line(&mut line).unwrap() > 0,
            "JS transport interrupted"
        );
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        if request["kind"] == "done" {
            break;
        }
        assert_eq!(request["command"], "delete_workspace_media_file");
        let args = &request["args"];
        assert_eq!(Path::new(args["path"].as_str().unwrap()), target.as_path());
        assert_eq!(
            Path::new(args["workspaceDir"].as_str().unwrap()),
            workspace.as_path()
        );
        let result = crate::commands::files::delete_workspace_media_file(
            args["path"].as_str().unwrap().into(),
            args["workspaceDir"].as_str().unwrap().into(),
            args.get("preservePaths")
                .map(|value| serde_json::from_value(value.clone()).unwrap()),
            args["cascade"].as_bool(),
        );
        calls += 1;
        let response = match result {
            Ok(()) => serde_json::json!({"result": null}),
            Err(error) => serde_json::json!({"error": error}),
        };
        writeln!(input, "{response}").unwrap();
        input.flush().unwrap();
    }
    drop(input);
    assert!(child.wait().unwrap().success());
    assert_eq!(calls, 1);
    assert!(!target.exists());
    for path in &preserved {
        assert_eq!(
            fs::read(path).unwrap(),
            b"preexisting",
            "{}",
            path.display()
        );
    }
    fs::remove_dir_all(workspace).unwrap();
}

#[test]
fn delete_workspace_media_file_accepts_enregistrements() {
    let workspace = temp_workspace_with_dirs("delete_recordings");
    let target = workspace.join("enregistrements").join("rec.webm");
    write_temp_file(&target, b"rec");

    delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");
    assert!(!target.exists());

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_accepts_voix_generees() {
    let workspace = temp_workspace_with_dirs("delete_voices");
    let target = workspace.join("voix-generees").join("voice.wav");
    write_temp_file(&target, b"wav");

    delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");
    assert!(!target.exists());

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_rejects_external_path() {
    let workspace = temp_workspace_with_dirs("delete_external_ws");
    let outside = temp_project_dir("delete_external_target");
    fs::create_dir_all(&outside).expect("create outside dir");
    let target = outside.join("external.mp3");
    write_temp_file(&target, b"data");

    let err =
        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
            .unwrap_err();
    assert!(err.contains_any_code(&[codes::FILES_DELETE_PATH_OUTSIDE]));
    assert!(target.exists(), "external file must not be deleted");

    fs::remove_dir_all(workspace).expect("cleanup workspace");
    fs::remove_dir_all(outside).expect("cleanup outside");
}

#[test]
fn delete_workspace_media_file_rejects_zips_extraits() {
    let workspace = temp_workspace_with_dirs("delete_zips");
    let target = workspace.join("zips-extraits").join("pack.json");
    write_temp_file(&target, b"{}");

    let err =
        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
            .unwrap_err();
    assert!(err.contains_any_code(&[codes::FILES_DELETE_PATH_OUTSIDE]));
    assert!(target.exists(), "zips-extraits file must not be deleted");

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_rejects_directory() {
    let workspace = temp_workspace_with_dirs("delete_dir");
    let target = workspace.join("images-generees").join("subdir");
    fs::create_dir_all(&target).expect("create subdir");

    let err =
        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
            .unwrap_err();
    assert!(err.contains_any_code(&[codes::FILES_DELETE_TARGET_IRREGULAR]));
    assert!(target.exists(), "directory must not be deleted");

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_rejects_empty_workspace() {
    let workspace = temp_workspace_with_dirs("delete_empty_ws");
    let target = workspace.join("images-generees").join("img.png");
    write_temp_file(&target, b"png");

    let err = delete_workspace_media_file(target.to_str().unwrap(), "   ", &[]).unwrap_err();
    assert!(err.contains_any_code(&[codes::FILES_DELETE_WORKSPACE_REQUIRED]));
    assert!(
        target.exists(),
        "file must not be deleted when workspace empty"
    );

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_rejects_missing_file() {
    let workspace = temp_workspace_with_dirs("delete_missing");
    let missing = workspace.join("images-generees").join("missing.png");

    let err =
        delete_workspace_media_file(missing.to_str().unwrap(), workspace.to_str().unwrap(), &[])
            .unwrap_err();
    assert!(err.contains_any_code(&[codes::FILES_DELETE_TARGET_MISSING]));

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_cascade_removes_sibling_backup_and_sidecar() {
    let workspace = temp_workspace_with_dirs("delete_cascade");
    let imports = workspace.join("fichiers-importes");
    let edited = imports.join("song.mp3");
    let backup = imports.join("song.original.mp3");
    let dot_folder = imports.join(AUDIO_EDIT_DIR);
    fs::create_dir_all(&dot_folder).expect("create dot folder");
    let sidecar = dot_folder.join("song.mp3.edit.json");
    write_temp_file(&edited, b"edited");
    write_temp_file(&backup, b"original");
    fs::write(&sidecar, b"{}").expect("write sidecar");

    delete_workspace_media_file(edited.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");

    assert!(!edited.exists(), "main file removed");
    assert!(!backup.exists(), "sibling backup cascade-removed");
    assert!(!sidecar.exists(), "sidecar cascade-removed");
    assert!(!dot_folder.exists(), "empty dot folder cleaned up");

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_cascade_removes_legacy_hidden_backup() {
    let workspace = temp_workspace_with_dirs("delete_cascade_legacy");
    let imports = workspace.join("fichiers-importes");
    let edited = imports.join("song.mp3");
    let dot_folder = imports.join(AUDIO_EDIT_DIR);
    fs::create_dir_all(&dot_folder).expect("create dot folder");
    let legacy_backup = dot_folder.join("song.mp3.original.mp3");
    let sidecar = dot_folder.join("song.mp3.edit.json");
    write_temp_file(&edited, b"edited");
    write_temp_file(&legacy_backup, b"legacy original");
    fs::write(&sidecar, b"{}").expect("write sidecar");

    delete_workspace_media_file(edited.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");

    assert!(!edited.exists());
    assert!(
        !legacy_backup.exists(),
        "legacy hidden backup cascade-removed"
    );
    assert!(!sidecar.exists());
    assert!(!dot_folder.exists());

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_does_not_touch_unrelated_originals() {
    let workspace = temp_workspace_with_dirs("delete_isolation");
    let imports = workspace.join("fichiers-importes");
    let edited = imports.join("song.mp3");
    let unrelated_backup = imports.join("other.original.mp3");
    write_temp_file(&edited, b"edited");
    write_temp_file(&unrelated_backup, b"unrelated");

    delete_workspace_media_file(edited.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .expect("delete should succeed");

    assert!(!edited.exists());
    assert!(
        unrelated_backup.exists(),
        "backup of an unrelated file must NOT be touched"
    );

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn delete_workspace_media_file_preserves_visible_original_backup() {
    let workspace = temp_workspace_with_dirs("delete_preserve_original");
    let imports = workspace.join("fichiers-importes");
    let edited = imports.join("song.mp3");
    let backup = imports.join("song.original.mp3");
    let dot_folder = imports.join(AUDIO_EDIT_DIR);
    fs::create_dir_all(&dot_folder).expect("create dot folder");
    let sidecar = dot_folder.join("song.mp3.edit.json");
    write_temp_file(&edited, b"edited");
    write_temp_file(&backup, b"original");
    fs::write(&sidecar, b"{}").expect("write sidecar");

    delete_workspace_media_file(
        edited.to_str().unwrap(),
        workspace.to_str().unwrap(),
        &[backup.to_string_lossy().into_owned()],
    )
    .expect("delete should succeed");

    assert!(!edited.exists(), "main file removed");
    assert!(backup.exists(), "visible original is preserved");
    assert!(!sidecar.exists(), "sidecar cascade-removed");

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn scan_unused_files_skips_original_backups() {
    let dir = temp_project_dir("scan_unused");
    fs::create_dir_all(dir.join("fichiers-importes")).expect("create imports");
    let save_path = dir.join("story.mbah");
    fs::write(&save_path, b"{}").expect("create mbah");

    let used = dir.join("fichiers-importes").join("song.mp3");
    let backup = dir.join("fichiers-importes").join("song.original.mp3");
    let unused = dir.join("fichiers-importes").join("orphan.mp3");
    write_temp_file(&used, b"a");
    write_temp_file(&backup, b"b");
    write_temp_file(&unused, b"c");

    let result = scan_unused_files(
        save_path.to_str().unwrap(),
        &[used.to_string_lossy().into()],
    )
    .expect("scan");

    let names: Vec<&str> = result
        .unused_files
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert!(names.contains(&"orphan.mp3"), "orphan must be flagged");
    assert!(
        !names.contains(&"song.original.mp3"),
        "backup must not be flagged as unused"
    );

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn nested_project_media_keep_existing_delete_and_audio_edit_permissions() {
    let workspace = temp_workspace_with_dirs("nested_project_media");
    let target = workspace.join("voix-generees/Azuro/audio.mp3");
    write_temp_file(&target, b"mp3");
    assert!(is_in_managed_media_dir(
        &target,
        Some(workspace.to_str().unwrap()),
        None
    ));
    delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap(), &[])
        .unwrap();
    assert!(!target.exists());
    let extraction = workspace.join("zips-extraits/Azuro/Pack/audio.mp3");
    write_temp_file(&extraction, b"mp3");
    assert!(is_in_trim_dir(
        extraction.to_str().unwrap(),
        Some(workspace.to_str().unwrap()),
        None
    )
    .unwrap());
    assert!(delete_workspace_media_file(
        extraction.to_str().unwrap(),
        workspace.to_str().unwrap(),
        &[]
    )
    .is_err());
    assert!(extraction.is_file());
    fs::remove_dir_all(workspace).unwrap();
}
