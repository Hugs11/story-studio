use super::*;

#[test]
fn validate_existing_file_path_documents_current_canonicalization() {
    let project_dir = temp_project_dir("validate_existing");
    fs::create_dir_all(project_dir.join("nested")).expect("create nested dir");
    let target = project_dir.join("target.txt");
    fs::write(&target, b"ok").expect("write target file");

    let canonical = validate_existing_file_path(
        project_dir
            .join("nested")
            .join("..")
            .join("target.txt")
            .to_str()
            .expect("path utf8"),
        "Fichier test",
    )
    .expect("validate existing path");
    assert_eq!(
        canonical,
        fs::canonicalize(&target).expect("canonical target")
    );

    let err = validate_existing_file_path(
        project_dir
            .join("missing.txt")
            .to_str()
            .expect("missing utf8"),
        "Fichier test",
    )
    .unwrap_err();
    assert!(err.contains("Fichier test"));
    assert!(err.contains("introuvable") || err.contains("inaccessible"));

    let err = validate_existing_file_path(project_dir.to_str().expect("dir utf8"), "Fichier test")
        .unwrap_err();
    assert!(err.contains("invalide"));

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn unpack_destination_requires_an_absolute_workspace_and_never_reuses_a_folder() {
    assert!(validate_unpack_dest_dir("pack", "").is_err());
    assert!(validate_unpack_dest_dir("pack", "relative-workspace").is_err());

    let workspace = temp_project_dir("unpack_destination");
    fs::create_dir_all(&workspace).expect("create workspace");
    let first = validate_unpack_dest_dir("ignored/Pack Été", workspace.to_str().expect("utf8"))
        .expect("reserve first extraction");
    let second = validate_unpack_dest_dir("ignored/Pack Été", workspace.to_str().expect("utf8"))
        .expect("reserve second extraction");
    let base = fs::canonicalize(workspace.join("zips-extraits")).expect("canonical base");

    assert_eq!(first.parent(), Some(base.as_path()));
    assert_eq!(second.parent(), Some(base.as_path()));
    assert_ne!(first, second);
    assert_eq!(
        first.file_name().and_then(|name| name.to_str()),
        Some("Pack Été")
    );
    assert_eq!(
        second.file_name().and_then(|name| name.to_str()),
        Some("Pack Été-2")
    );

    fs::remove_dir_all(workspace).expect("cleanup workspace");
}

#[test]
fn output_roots_require_absolute_workspace_or_project_paths() {
    let missing = "Choisissez un emplacement.";
    assert_eq!(
        workspace_or_project_dir(None, None, missing).unwrap_err(),
        missing
    );
    assert!(workspace_or_project_dir(Some("relative-workspace"), None, missing).is_err());
    assert!(workspace_or_project_dir(None, Some("relative/project.mbah"), missing).is_err());

    let root = temp_project_dir("absolute_output_roots");
    let workspace = root.join("workspace");
    let save_path = root.join("project.mbah");
    assert_eq!(
        workspace_or_project_dir(
            Some(workspace.to_str().expect("workspace utf8")),
            Some(save_path.to_str().expect("save path utf8")),
            missing,
        )
        .expect("absolute workspace"),
        workspace
    );
    assert_eq!(
        workspace_or_project_dir(
            None,
            Some(save_path.to_str().expect("save path utf8")),
            missing,
        )
        .expect("absolute save path"),
        root
    );
}

#[cfg(windows)]
#[test]
fn validate_existing_file_path_accepts_windows_extended_prefix() {
    let project_dir = temp_project_dir("validate_existing_unc");
    fs::create_dir_all(&project_dir).expect("create temp dir");
    let target = project_dir.join("target.txt");
    fs::write(&target, b"ok").expect("write target file");
    let extended = format!(r"\\?\{}", target.display());

    let canonical =
        validate_existing_file_path(&extended, "Fichier test").expect("validate extended path");

    assert_eq!(
        canonical,
        fs::canonicalize(&target).expect("canonical target")
    );

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}
