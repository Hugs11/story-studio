//! Pack généré par menus avec « Enchaîner les histoires » : il doit se rouvrir
//! dans l'éditeur par menus, avec l'option et la même navigation. Le juge de
//! fidélité reste strict ; c'est la reconstruction qui doit retrouver l'option.

use super::*;
use crate::native_pack::observed_gates::{observe_document_gates, refusal_from_gates, GatePolicy};
use crate::services::pack_reader::{classify_pack_editability, unpack_zip_to_entries_unchecked};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "story_studio_auto_next_reopen_{}_{}_{}",
        name,
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn staged_asset(base: &Path, role: &str, name: &str) -> PreparedAsset {
    let staged_path = base.join("stage").join(name);
    fs::create_dir_all(staged_path.parent().expect("parent")).expect("stage dir");
    fs::write(&staged_path, name.as_bytes()).expect("write staged asset");
    PreparedAsset {
        role: role.to_string(),
        source_path: staged_path.to_string_lossy().to_string(),
        source_kind: "test".to_string(),
        staged_asset_name: name.to_string(),
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed: false,
        deduplicated: false,
    }
}

fn story(id: &str) -> CanonicalStory {
    CanonicalStory {
        id: id.to_string(),
        name: format!("Histoire {id}"),
        audio: Some(format!("{id}.mp3")),
        item_audio: Some(format!("{id}-titre.mp3")),
        item_image: Some(format!("{id}-titre.png")),
        autoplay: true,
        home: true,
        ..Default::default()
    }
}

fn story_assets(base: &Path, id: &str) -> Vec<PreparedAsset> {
    let prefix = scoped_label_id("root", id, &format!("Histoire {id}"));
    vec![
        staged_asset(base, &format!("{prefix}/storyAudio"), &format!("{id}.mp3")),
        staged_asset(
            base,
            &format!("{prefix}/itemAudio"),
            &format!("{id}-titre.mp3"),
        ),
        staged_asset(
            base,
            &format!("{prefix}/itemImage"),
            &format!("{id}-titre.png"),
        ),
    ]
}

fn auto_next_pack(base: &Path) -> (std::path::PathBuf, StoryDocument) {
    let cover = base.join("source-cover.png");
    write_test_png(&cover);
    let project = CanonicalProject {
        name: "Enchaînement".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some(cover.to_string_lossy().to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        options: CanonicalOptions {
            silence_mode: crate::domain::project::SilenceMode::Off,
            harmonize_loudness: false,
            auto_next: true,
            night_mode: false,
            end_message_autoplay: true,
        },
        entries: vec![
            CanonicalEntry::Story(story("a")),
            CanonicalEntry::Story(story("b")),
        ],
        shared_entries: Vec::new(),
    };
    let mut assets = vec![
        staged_asset(base, "rootAudio", "root.mp3"),
        staged_asset(base, "rootImage", "root.png"),
    ];
    assets.extend(story_assets(base, "a"));
    assets.extend(story_assets(base, "b"));
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build auto-next document");
    let written =
        write_native_pack_archive(&report, &document, &base.join("out")).expect("write zip");
    let observations = observe_document_gates(
        &written.story_json,
        Some(report.pack_uuid.as_str()),
        GatePolicy::ENFORCED,
    );
    assert_eq!(refusal_from_gates(&observations), None, "{observations:#?}");
    (written.zip_path, document)
}

#[test]
fn auto_next_menus_pack_reopens_in_the_menus_editor() {
    let base = temp_dir("classify");
    let (zip_path, _) = auto_next_pack(&base);
    let zip = zip_path.to_str().expect("utf8 zip path");

    let editability = classify_pack_editability(zip).expect("classify auto-next pack");
    assert!(
        editability.authoring_editable,
        "le pack par menus avec enchaînement doit rester modifiable : {} / {:?}",
        editability.reason, editability.fidelity
    );
    assert!(!editability.read_only_inspectable);
    let fidelity = editability.fidelity.as_ref().expect("rapport de fidélité");
    assert_eq!(
        fidelity.generated_stage_count, fidelity.oracle_stage_count,
        "aucun Écran en plus"
    );

    let imported = unpack_zip_to_entries_unchecked(
        zip,
        base.join("imported").to_str().expect("utf8 import dir"),
    )
    .expect("reimport auto-next pack");
    assert_eq!(imported["autoNext"], serde_json::Value::Bool(true));
    let entries = imported["entries"].as_array().expect("entries");
    let stories = entries
        .iter()
        .filter(|entry| entry["type"] == "story")
        .collect::<Vec<_>>();
    assert_eq!(stories.len(), 2, "deux histoires : {entries:#?}");
    for story in stories {
        assert!(
            story
                .get("returnAfterPlay")
                .is_none_or(|value| value.is_null()),
            "l'enchaînement est porté par l'option, pas par un retour explicite : {story:#?}"
        );
    }
    let _ = fs::remove_dir_all(base);
}
