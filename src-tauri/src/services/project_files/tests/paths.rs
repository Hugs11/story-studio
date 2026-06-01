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
