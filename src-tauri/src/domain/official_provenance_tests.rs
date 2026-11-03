use super::official_provenance::*;
use crate::native_pack::editing::{
    apply_advanced_gesture, metadata::check_identity_update, AdvancedGesture,
};
use crate::native_pack::persistence::{
    decode_authoring_payload, encode_authoring_payload, initialize_advanced_document,
    initialize_advanced_payload,
};
use crate::native_pack::{decode_story_document, PackIdentityOrigin, Presence};
use crate::services::catalogue::CatalogueState;
use crate::support::user_message::codes;
use serde_json::json;
use std::io::Write;

const A: &str = "00000000-0000-4000-8000-00000000000a";
const B: &str = "00000000-0000-4000-8000-00000000000b";

struct Fixture {
    root: std::path::PathBuf,
    catalogue: CatalogueState,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("l2-provenance-{}", uuid::Uuid::new_v4()));
        let catalogue = CatalogueState::default();
        let store = catalogue
            .store(&root.join("data"), &root.join("cache"))
            .unwrap();
        store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO lunii_pack(uuid,document_json) VALUES (?1,'{}')",
                    [A],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();
        Self { root, catalogue }
    }
    fn story(&self) -> serde_json::Value {
        json!({"format":"v1", "version":1, "title":"Synthetic",
            "stageNodes":[{"uuid":A,"squareOne":true,"controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false}}], "actionNodes":[]})
    }
    fn editable_story(&self) -> serde_json::Value {
        json!({"format":"v1", "version":1, "title":"Synthetic", "description":"", "nightModeAvailable":false,
            "stageNodes":[
                {"uuid":A,"name":"Cover","type":"stage","squareOne":true,"audio":"root.mp3","image":"cover.png","controlSettings":{"wheel":true,"ok":true,"home":false,"pause":false,"autoplay":false},"okTransition":{"actionNode":"root-action","optionIndex":0},"homeTransition":null},
                {"uuid":"title","name":"Title","type":"stage","squareOne":false,"audio":"item.mp3","image":"item.png","controlSettings":{"wheel":true,"ok":true,"home":true,"pause":false,"autoplay":false},"okTransition":{"actionNode":"play-action","optionIndex":0},"homeTransition":null},
                {"uuid":"play","name":"Play","type":"stage","squareOne":false,"audio":"story.mp3","image":null,"controlSettings":{"wheel":false,"ok":false,"home":true,"pause":true,"autoplay":false},"okTransition":null,"homeTransition":{"actionNode":"root-action","optionIndex":0}}
            ], "actionNodes":[{"id":"root-action","options":["title"]},{"id":"play-action","options":["play"]}]})
    }
    fn write_editable_zip(&self, uuid: &str) {
        self.write_story_zip(uuid, self.editable_story());
    }
    fn write_story_zip(&self, uuid: &str, mut story: serde_json::Value) {
        let path = self.root.join("source.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        zip.start_file("story.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        story["stageNodes"][0]["uuid"] = json!(uuid);
        zip.write_all(story.to_string().as_bytes()).unwrap();
        for asset in ["root.mp3", "cover.png", "item.mp3", "item.png", "story.mp3"] {
            zip.start_file(
                format!("assets/{asset}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(b"synthetic asset").unwrap();
        }
        zip.finish().unwrap();
    }
    fn import(&self) -> crate::native_pack::persistence::AdvancedAcquisition {
        self.import_uuid(A)
    }
    fn import_uuid(&self, uuid: &str) -> crate::native_pack::persistence::AdvancedAcquisition {
        self.write_story_zip(uuid, self.story());
        crate::services::pack_reader::import_pack_as_advanced_document_with_catalogue(
            self.root.join("source.zip").to_str().unwrap(),
            self.root
                .join(format!("media-{}", uuid::Uuid::new_v4()))
                .to_str()
                .unwrap(),
            Some(&self.catalogue),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(std::mem::take(&mut self.catalogue));
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn gesture() -> AdvancedGesture {
    serde_json::from_value(json!({"gesture":"set-document-metadata","update":{"packIdentity":B,"uuid":{"form":"set","value":B}}})).unwrap()
}

#[test]
fn official_import_persists_through_disk_and_reopening() {
    let fixture = Fixture::new();
    let acquired = fixture.import();
    assert_eq!(acquired.official_provenance, OfficialProvenance::Official);
    assert_eq!(acquired.official_origin_uuid.as_deref(), Some(A));
    let path = fixture.root.join("project-payload.json");
    std::fs::write(&path, acquired.payload).unwrap();
    let reopened = decode_authoring_payload(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        reopened.context.official_provenance,
        OfficialProvenance::Official
    );
    assert_eq!(reopened.context.pack_identity.value.as_deref(), Some(A));
    assert_eq!(reopened.context.official_origin_uuid.as_deref(), Some(A));
    assert_eq!(
        decode_authoring_payload(&encode_authoring_payload(&reopened).unwrap())
            .unwrap()
            .context
            .official_provenance,
        OfficialProvenance::Official
    );
}

#[test]
fn official_provenance_refuses_identity_gesture_with_typed_code() {
    let fixture = Fixture::new();
    let acquired = fixture.import();
    let error = apply_advanced_gesture(&acquired.payload, vec![], &gesture()).unwrap_err();
    assert_eq!(error.code, codes::OFFICIAL_IDENTITY_LOCKED);
    assert!(crate::support::user_message::contains_code(
        &serde_json::to_string(&error).unwrap(),
        codes::OFFICIAL_IDENTITY_LOCKED
    ));
}

#[test]
fn current_official_uuid_is_locked_without_recovering_historical_provenance() {
    let fixture = Fixture::new();
    let decoded = decode_story_document(&fixture.story().to_string()).unwrap();
    assert_eq!(
        decoded.context.official_provenance,
        OfficialProvenance::Unknown
    );
    let AdvancedGesture::SetDocumentMetadata { update } = gesture() else {
        panic!()
    };
    assert_eq!(
        check_identity_update(&decoded, &update, Some(&fixture.catalogue))
            .unwrap_err()
            .code,
        codes::OFFICIAL_IDENTITY_LOCKED
    );
    assert_eq!(
        decoded.context.official_provenance,
        OfficialProvenance::Unknown
    );
    assert!(!is_official_origin(OfficialProvenance::Unknown, B, Some(&fixture.catalogue)).unwrap());
}

#[test]
fn automatic_generation_never_replaces_an_official_origin() {
    let fixture = Fixture::new();
    let mut decoded = decode_authoring_payload(&fixture.import().payload).unwrap();
    // Even a historical pending-generation marker must not trigger a new identity.
    decoded.context.pack_identity.origin = PackIdentityOrigin::RequiresGeneration;
    decoded.context.pack_identity.value = Some(A.to_string());
    let payload =
        initialize_advanced_document(decoded, &mut || panic!("must not generate")).unwrap();
    let again = initialize_advanced_payload(&payload, &mut || panic!("must not renew")).unwrap();
    assert_eq!(
        decode_authoring_payload(&again)
            .unwrap()
            .context
            .pack_identity
            .value
            .as_deref(),
        Some(A)
    );
}

#[test]
fn old_project_is_unknown_and_non_official_identity_remains_editable() {
    let fixture = Fixture::new();
    let mut story = fixture.story();
    story["stageNodes"][0]["uuid"] = json!(B);
    let decoded = decode_story_document(&story.to_string()).unwrap();
    let payload =
        initialize_advanced_document(decoded, &mut || panic!("identity already present")).unwrap();
    let mut raw: serde_json::Value = serde_json::from_str(&payload).unwrap();
    raw["context"]
        .as_object_mut()
        .unwrap()
        .remove("officialProvenance");
    let reopened = decode_authoring_payload(&raw.to_string()).unwrap();
    assert_eq!(
        reopened.context.official_provenance,
        OfficialProvenance::Unknown
    );
    assert_eq!(
        crate::native_pack::preparation::pack_identity_for_export(&reopened.context.pack_identity)
            .unwrap(),
        B
    );
    assert!(check_identity_change(
        OfficialProvenance::NotOfficial,
        B,
        A,
        Some(&fixture.catalogue)
    )
    .is_ok());
    let changed: AdvancedGesture = serde_json::from_value(
        json!({"gesture":"set-document-metadata","update":{"packIdentity":A}}),
    )
    .unwrap();
    let result = apply_advanced_gesture(&raw.to_string(), vec![], &changed).unwrap();
    assert_eq!(
        decode_authoring_payload(&result.payload)
            .unwrap()
            .document
            .uuid,
        Presence::Value(A.to_string())
    );
}

#[test]
fn graph_copy_carries_official_provenance() {
    let project = serde_json::from_value(json!({"name":"Synthetic", "projectType":"pack", "packUuid":A,"officialProvenance":"official","officialOriginUuid":A,
        "rootAudio":"/synthetic/root.mp3","rootImage":"/synthetic/root.png", "rootEntries":[{"id":"s","type":"story","name":"Synthetic","audio":"/synthetic/story.mp3","itemAudio":"/synthetic/title.mp3","itemImage":"/synthetic/title.png"}], "globalOptions":{"autoNext":false,"nightMode":false,"harmonizeLoudness":false}})).unwrap();
    let copied = crate::native_pack::graph_copy::graph_copy_of_project(&project).unwrap();
    if project.official_provenance == OfficialProvenance::Official {
        assert_eq!(
            decode_authoring_payload(&copied.payload)
                .unwrap()
                .context
                .official_origin_uuid
                .as_deref(),
            Some(A)
        );
    }
    assert_eq!(
        decode_authoring_payload(&copied.payload)
            .unwrap()
            .context
            .official_provenance,
        OfficialProvenance::Official
    );
}

#[test]
fn ipc_identity_commands_and_view_use_the_same_catalogue_lock() {
    let mut fixture = Fixture::new();
    let mut decoded = decode_story_document(&fixture.story().to_string()).unwrap();
    // An old document keeps unknown provenance, including after a read-only view.
    decoded.context.official_provenance = OfficialProvenance::Unknown;
    let payload = encode_authoring_payload(&decoded).unwrap();
    let app = tauri::test::mock_builder()
        .manage(std::mem::take(&mut fixture.catalogue))
        .invoke_handler(tauri::generate_handler![
            crate::commands::pack::check_pack_identity,
            crate::commands::pack::read_pack_identity_lock,
            crate::commands::project_codec::ipc::apply_advanced_gesture,
            crate::commands::project_codec::ipc::read_advanced_graph_view
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, args| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    assert_eq!(
        invoke(
            "read_pack_identity_lock",
            json!({"uuid":A,"officialProvenance":"unknown"})
        )
        .unwrap(),
        true
    );
    let view = invoke("read_advanced_graph_view", json!({"payload":payload})).unwrap();
    assert_eq!(view["identityLocked"], true);
    assert_eq!(view["officialProvenance"], "unknown");
    assert_eq!(
        invoke(
            "check_pack_identity",
            json!({"value":B,"currentUuid":A,"officialProvenance":"unknown"})
        )
        .unwrap_err()["code"],
        codes::OFFICIAL_IDENTITY_LOCKED
    );
    assert!(invoke(
        "check_pack_identity",
        json!({"value":A,"currentUuid":A,"officialProvenance":"unknown"})
    )
    .is_ok());
    assert!(invoke(
        "check_pack_identity",
        json!({"value":A,"currentUuid":B,"officialProvenance":"notOfficial"})
    )
    .is_ok());
    assert_eq!(invoke("apply_advanced_gesture", json!({"payload":payload,"mediaBindings":[],"gesture":{"gesture":"set-document-metadata","update":{"packIdentity":B}}})).unwrap_err()["code"], codes::OFFICIAL_IDENTITY_LOCKED);
    drop(webview);
    drop(app);
}

#[test]
fn non_official_import_remains_editable_and_official_root_uuid_cannot_be_replaced() {
    let fixture = Fixture::new();
    let acquired = fixture.import_uuid(B);
    assert_eq!(
        acquired.official_provenance,
        OfficialProvenance::NotOfficial
    );
    let change: AdvancedGesture = serde_json::from_value(
        json!({"gesture":"set-document-metadata","update":{"packIdentity":A}}),
    )
    .unwrap();
    apply_advanced_gesture(&acquired.payload, vec![], &change).unwrap();
    let official = fixture.import();
    let root_only: AdvancedGesture = serde_json::from_value(
        json!({"gesture":"set-document-metadata","update":{"uuid":{"form":"set","value":B}}}),
    )
    .unwrap();
    assert_eq!(
        apply_advanced_gesture(&official.payload, vec![], &root_only)
            .unwrap_err()
            .code,
        codes::OFFICIAL_IDENTITY_LOCKED
    );
    let title_only: AdvancedGesture = serde_json::from_value(json!({"gesture":"set-document-metadata","update":{"title":{"form":"set","value":"Edited locally"}}})).unwrap();
    assert!(apply_advanced_gesture(&official.payload, vec![], &title_only).is_ok());
}

#[test]
fn catalogue_query_failure_falls_back_to_embedded_recognition() {
    let fixture = Fixture::new();
    let store = fixture
        .catalogue
        .store(&fixture.root.join("data"), &fixture.root.join("cache"))
        .unwrap();
    store
        .write(|tx| {
            tx.execute("DROP TABLE lunii_pack", []).unwrap();
            Ok(())
        })
        .unwrap();
    let decoded = decode_story_document(&fixture.story().to_string()).unwrap();
    let AdvancedGesture::SetDocumentMetadata { update } = gesture() else {
        panic!()
    };
    assert!(check_identity_update(&decoded, &update, Some(&fixture.catalogue)).is_ok());
}

fn with_ipc(
    fixture: &mut Fixture,
    test: impl FnOnce(&dyn Fn(&str, serde_json::Value) -> Result<serde_json::Value, serde_json::Value>),
) {
    let app = tauri::test::mock_builder()
        .manage(std::mem::take(&mut fixture.catalogue))
        .invoke_handler(tauri::generate_handler![
            crate::commands::pack::load_pack_zip,
            crate::commands::pack::unpack_zip_to_entries,
            crate::commands::pack::create_fixed_community_pack,
            crate::commands::pack::check_pack_identity,
            crate::commands::pack::read_pack_identity_lock,
            crate::commands::project_codec::ipc::read_advanced_graph_view
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    test(&|cmd, args| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    });
}

#[test]
fn official_zip_commands_record_provenance_and_original_identity_and_checker_refuses_change() {
    let mut fixture = Fixture::new();
    fixture.write_editable_zip(A);
    let zip = fixture.root.join("source.zip");
    let workspace = fixture.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut story = fixture.story();
    let patch = serde_json::from_value(json!({"uuid": B})).unwrap();
    let error = crate::services::community_pack_checker::apply_metadata_patch_with_catalogue(
        &mut story,
        &patch,
        Some(&fixture.catalogue),
    )
    .unwrap_err();
    assert!(crate::support::user_message::contains_code(
        &error,
        codes::OFFICIAL_IDENTITY_LOCKED
    ));
    assert_eq!(story, fixture.story());
    with_ipc(&mut fixture, |invoke| {
        for simulation in [false, true] {
            let loaded = invoke(
                "load_pack_zip",
                json!({"zipPath": zip, "forSimulation": simulation}),
            )
            .unwrap();
            let loaded: serde_json::Value = serde_json::from_str(loaded.as_str().unwrap()).unwrap();
            assert_eq!(loaded["officialProvenance"], "official");
            assert_eq!(loaded["officialOriginUuid"], A);
        }
        let unpacked = invoke(
            "unpack_zip_to_entries",
            json!({"zipPath":zip,"destDir":"pack","workspaceDir":workspace}),
        )
        .unwrap();
        assert_eq!(unpacked["officialProvenance"], "official");
        assert_eq!(unpacked["officialOriginUuid"], A);
        let error = invoke(
            "create_fixed_community_pack",
            json!({"zipPath":zip,"metadataPatch":{"uuid":B}}),
        )
        .unwrap_err();
        assert_eq!(error["code"], codes::OFFICIAL_IDENTITY_LOCKED);
    });
}

#[test]
fn latched_catalogue_failure_keeps_import_simulation_graph_and_free_identity_editable() {
    let mut fixture = Fixture::new();
    fixture.catalogue = CatalogueState::default();
    let bad_data = fixture.root.join("not-a-directory");
    std::fs::write(&bad_data, "corrupt").unwrap();
    assert!(fixture
        .catalogue
        .store(&bad_data, &fixture.root.join("bad-cache"))
        .is_err());
    // The failure stays memorized even when valid directories are supplied next.
    assert!(fixture
        .catalogue
        .store(
            &fixture.root.join("other-data"),
            &fixture.root.join("other-cache")
        )
        .is_err());
    let acquired = fixture.import_uuid(B);
    assert_eq!(acquired.official_provenance, OfficialProvenance::Unknown);
    assert_eq!(acquired.official_origin_uuid, None);
    fixture.write_editable_zip(B);
    let zip = fixture.root.join("source.zip");
    let workspace = fixture.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    with_ipc(&mut fixture, |invoke| {
        for simulation in [false, true] {
            let loaded = invoke(
                "load_pack_zip",
                json!({"zipPath":zip,"forSimulation":simulation}),
            )
            .unwrap();
            let loaded: serde_json::Value = serde_json::from_str(loaded.as_str().unwrap()).unwrap();
            assert_eq!(loaded["officialProvenance"], "unknown");
        }
        let unpacked = invoke(
            "unpack_zip_to_entries",
            json!({"zipPath":zip,"destDir":"pack","workspaceDir":workspace}),
        )
        .unwrap();
        assert_eq!(unpacked["officialProvenance"], "unknown");
        let view = invoke(
            "read_advanced_graph_view",
            json!({"payload":acquired.payload}),
        )
        .unwrap();
        assert_eq!(view["identityLocked"], false);
        let error = invoke("read_advanced_graph_view", json!({"payload":"invalid"})).unwrap_err();
        for field in ["code", "path", "found", "expected"] {
            assert!(error[field].is_string());
        }
        assert!(
            error.get("params").is_none(),
            "codec error contract remains unchanged"
        );
        assert!(invoke(
            "check_pack_identity",
            json!({"value":A,"currentUuid":B,"officialProvenance":"notOfficial"})
        )
        .is_ok());
        assert_eq!(
            invoke(
                "read_pack_identity_lock",
                json!({"uuid":B,"officialProvenance":"unknown"})
            )
            .unwrap(),
            false
        );
    });
}

#[test]
fn graph_copy_keeps_containment_separate_from_origin_and_identity_editable() {
    let project = serde_json::from_value(json!({"name":"Synthetic", "projectType":"pack", "packUuid":B,"officialProvenance":"notOfficial","containsOfficialContent":false,
        "rootAudio":"/synthetic/root.mp3","rootImage":"/synthetic/root.png", "rootEntries":[{"id":"s","type":"story","officialProvenance":"official","officialOriginUuid":A,"name":"Synthetic","audio":"/synthetic/story.mp3","itemAudio":"/synthetic/title.mp3","itemImage":"/synthetic/title.png"}], "globalOptions":{"autoNext":false,"nightMode":false,"harmonizeLoudness":false}})).unwrap();
    let copied = crate::native_pack::graph_copy::graph_copy_of_project(&project).unwrap();
    if project.official_provenance == OfficialProvenance::Official {
        assert_eq!(
            decode_authoring_payload(&copied.payload)
                .unwrap()
                .context
                .official_origin_uuid
                .as_deref(),
            Some(A)
        );
    }
    let document = decode_authoring_payload(&copied.payload).unwrap();
    assert!(document.context.contains_official_content);
    assert_eq!(
        document.context.official_provenance,
        OfficialProvenance::NotOfficial
    );
    assert_eq!(document.context.official_origin_uuid, None);
    assert!(apply_advanced_gesture(
        &copied.payload,
        vec![],
        &serde_json::from_value(
            json!({"gesture":"set-document-metadata","update":{"packIdentity":A}})
        )
        .unwrap()
    )
    .is_ok());
    let reopened = decode_authoring_payload(&encode_authoring_payload(&document).unwrap()).unwrap();
    assert!(reopened.context.contains_official_content);
}

#[test]
fn libre_containment_ignores_project_flag_and_tracks_nested_and_shared_entries() {
    let mut value = json!({"name":"Synthetic","containsOfficialContent":true,"officialProvenance":"official","rootEntries":[],"globalOptions":{"autoNext":false,"nightMode":false}});
    let contains = |value: &serde_json::Value| {
        contains_official_content(&serde_json::from_value(value.clone()).unwrap())
    };
    assert!(!contains(&value));
    for field in ["rootEntries", "sharedEntries"] {
        for entry in [
            json!({"id":"zip","type":"zip","officialProvenance":"official","officialOriginUuid":A}),
            json!({"id":"menu","type":"menu","children":[{"id":"story","type":"story","officialProvenance":"official","officialOriginUuid":A}]}),
        ] {
            value[field] = json!([entry]);
            assert!(contains(&value));
            let mut reopened: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
            assert!(contains(&reopened));
            reopened[field] = json!([]);
            assert!(!contains(&reopened));
            value[field] = json!([]);
        }
    }
}

#[test]
fn embedded_only_negative_import_is_unknown() {
    assert_eq!(
        recognizes_official::<CatalogueState>(B, None),
        (false, true)
    );
    assert_eq!(
        imported_provenance(B, None).unwrap(),
        OfficialProvenance::Unknown
    );
    let fixture = Fixture::new();
    assert_eq!(
        imported_provenance(B, Some(&fixture.catalogue)).unwrap(),
        OfficialProvenance::NotOfficial
    );
}
