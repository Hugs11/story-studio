use super::*;
use crate::support::user_message;
use crate::support::user_message::codes;
#[cfg(test)]
use crate::support::user_message::MessageTransportAssertions as _;

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
    let message: user_message::UserMessage = serde_json::from_str(&err).expect("coded file error");
    assert_eq!(message.code, codes::FILES_NOT_FOUND_OR_INACCESSIBLE);
    assert_eq!(message.params["label"], "Fichier test");

    let err = validate_existing_file_path(project_dir.to_str().expect("dir utf8"), "Fichier test")
        .unwrap_err();
    assert!(err.contains_any_code(&[codes::LABEL_VALUE_INVALID]));

    fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
}

#[test]
fn unpack_destination_requires_an_absolute_workspace_and_never_reuses_a_folder() {
    assert!(validate_unpack_dest_dir("pack", "", None).is_err());
    assert!(validate_unpack_dest_dir("pack", "relative-workspace", None).is_err());

    let workspace = temp_project_dir("unpack_destination");
    fs::create_dir_all(&workspace).expect("create workspace");
    let first =
        validate_unpack_dest_dir("ignored/Pack Été", workspace.to_str().expect("utf8"), None)
            .expect("reserve first extraction");
    let second =
        validate_unpack_dest_dir("ignored/Pack Été", workspace.to_str().expect("utf8"), None)
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
fn media_output_root_requires_an_absolute_workspace() {
    let missing = "Choisissez un emplacement.";
    assert_eq!(media_output_root(None, missing).unwrap_err(), missing);
    assert_eq!(media_output_root(Some("  "), missing).unwrap_err(), missing);
    assert!(media_output_root(Some("relative-workspace"), missing).is_err());

    let root = temp_project_dir("absolute_output_roots");
    let workspace = root.join("workspace");
    assert_eq!(
        media_output_root(Some(workspace.to_str().expect("workspace utf8")), missing)
            .expect("absolute workspace"),
        workspace
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

#[test]
fn project_extractions_stay_isolated_under_the_owned_folder() {
    let workspace = temp_project_dir("project_unpack");
    fs::create_dir_all(&workspace).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let folder = resolve_project_folder(workspace.to_str().unwrap(), "Azuro", &id, true).unwrap();
    let destination = ProjectMediaDestination {
        folder,
        work_id: id,
    };
    let first =
        validate_unpack_dest_dir("Pack", workspace.to_str().unwrap(), Some(&destination)).unwrap();
    let second =
        validate_unpack_dest_dir("Pack", workspace.to_str().unwrap(), Some(&destination)).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        first.parent(),
        Some(
            fs::canonicalize(workspace.join("zips-extraits/Azuro"))
                .unwrap()
                .as_path()
        )
    );
    fs::remove_dir_all(workspace).unwrap();
}

#[test]
fn translated_path_labels_keep_their_message_value_and_original_detail() {
    use crate::support::user_message::{codes, MessageLabel, UserMessage};
    let context = MessageLabel::new(
        "Histoire / Loup",
        UserMessage::new(codes::LABEL_PROJECT_PATH)
            .param(
                "context",
                MessageLabel::literal("Histoire", codes::LABEL_PROJECT_STORY).value(),
            )
            .param("name", "Loup"),
    );
    let label = MessageLabel::new(
        "Histoire / Loup : audio",
        UserMessage::new(codes::LABEL_PROJECT_AUDIO).param("context", context.value()),
    );
    let missing = temp_project_dir("coded_label").join("missing.wav");
    for error in [
        validate_existing_file_path_with_label(missing.to_str().unwrap(), &label).unwrap_err(),
        validate_existing_dir_path_with_label(missing.to_str().unwrap(), &label).unwrap_err(),
    ] {
        let message: UserMessage = serde_json::from_str(&error).unwrap();
        assert_eq!(message.code, codes::FILES_NOT_FOUND_OR_INACCESSIBLE);
        assert_eq!(message.params["label"], label.value());
        assert!(message
            .detail
            .unwrap()
            .starts_with("Histoire / Loup : audio introuvable ou inaccessible : "));
    }
    let error = absolute_path_with_label("", &label).unwrap_err();
    let message: UserMessage = serde_json::from_str(&error).unwrap();
    assert_eq!(message.code, codes::LABEL_VALUE_EMPTY);
    assert_eq!(message.params["label"], label.value());
    assert_eq!(
        message.detail.as_deref(),
        Some("Histoire / Loup : audio vide.")
    );
}
