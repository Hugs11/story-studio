//! Saved project identity admission, before media preparation or device writes.
use super::*;
use catalogue::writes::{Declaration, OwnWrite};
use serde_json::Value;

pub(super) fn saved_uuid(raw: &Value) -> Option<&str> {
    ["/packMetadata/uuid", "/packMetadata/packUuid", "/packUuid"]
        .iter()
        .find_map(|pointer| {
            raw.pointer(pointer)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
}

pub(super) fn prepare(store: &Store, target: &mut Target) -> Result<Value> {
    prepare_with(
        store,
        target,
        crate::services::project_files::atomic_write_to,
    )
}

fn prepare_with(
    store: &Store,
    target: &mut Target,
    persist: impl FnOnce(&Path, &[u8], &Path) -> std::result::Result<(), String>,
) -> Result<Value> {
    prepare_with_token(store, target, persist, |path| {
        catalogue::open::target::current_token(path, std::time::Duration::from_secs(5))
    })
}

fn prepare_with_token(
    store: &Store,
    target: &mut Target,
    persist: impl FnOnce(&Path, &[u8], &Path) -> std::result::Result<(), String>,
    current_token: impl FnOnce(&Path) -> Option<String>,
) -> Result<Value> {
    let path = target.path.clone();
    store.with_project_send(&path, |open| {
        target.require_unchanged(std::time::Duration::from_secs(5))?;
        let mut raw = catalogue::analyze::project(&path)
            .map_err(|e| project_incomplete(UserMessage::from(e)))?
            .raw;
        if raw["authoringMode"] == "advanced" {
            return Ok(raw);
        }
        if open && saved_uuid(&raw).is_none() {
            return Err(UserMessage::new(
                codes::STORYTELLER_PROJECT_OPEN_ID_REQUIRED,
            ));
        }
        // Creating partial metadata would bypass the editor's legacy migration
        // and discard the title, author and naming mode when reopened.
        if raw.get("packMetadata").is_none_or(Value::is_null) {
            return Err(UserMessage::new(
                codes::STORYTELLER_PROJECT_LEGACY_SAVE_REQUIRED,
            ));
        }
        if saved_uuid(&raw).is_some() {
            return Ok(raw);
        }
        // Imported identity is an author decision. Never invent a replacement
        // for an imported pack, including old projects carrying its raw graph.
        if [
            "/packMetadata/originalUuid",
            "/nativeGraph/document/uuid",
            "/officialOriginUuid",
        ]
        .iter()
        .any(|p| {
            raw.pointer(p)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
        }) {
            return Err(UserMessage::new(codes::EXPORT_PACK_IDENTITY_REQUIRED));
        }
        if raw
            .get("packMetadata")
            .is_some_and(|m| !m.is_null() && !m.is_object())
        {
            return Err(UserMessage::new(codes::STORYTELLER_PROJECT_INVALID));
        }
        raw["packMetadata"]["uuid"] = uuid::Uuid::new_v4().to_string().into();
        let bytes = serde_json::to_vec_pretty(&raw).map_err(failure)?;
        let temporary =
            path.with_file_name(format!(".story-studio-write-{}", uuid::Uuid::new_v4()));
        let own = OwnWrite::begin(
            Declaration::new("projectSave")
                .exact(&path)
                .temporary(&temporary),
        );
        target.require_unchanged(std::time::Duration::from_secs(5))?;
        persist(&path, &bytes, &temporary).map_err(|e| {
            UserMessage::new(codes::STORYTELLER_PROJECT_IDENTITY_SAVE_FAILED).with_detail(e)
        })?;
        own.succeeded(vec![path.clone()]);
        // Later revalidation must recognize this precise, intentional save.
        let token = current_token(&path)
            .ok_or_else(|| UserMessage::new(codes::STORYTELLER_PROJECT_ID_RECHECK_FAILED))?;
        if let Some(observation) = &mut target.observation {
            observation.token = token;
        }
        Ok(raw)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::catalogue::open::target::Observed;

    fn identity_cases() -> Value {
        serde_json::from_str(include_str!("project-identity-cases.json")).unwrap()
    }

    #[test]
    fn saved_identity_matches_shared_js_fixtures() {
        for case in identity_cases()["cases"].as_array().unwrap() {
            assert_eq!(
                saved_uuid(&case["raw"]),
                case["uuid"].as_str(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn legacy_formats_are_refused_without_losing_metadata() {
        for case in identity_cases()["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["name"].as_str().unwrap().starts_with("legacy"))
        {
            let mut f = Fixture::new(case["raw"].clone());
            let before = f.bytes();
            assert_eq!(
                prepare(&f.store, &mut f.target).unwrap_err().code,
                codes::STORYTELLER_PROJECT_LEGACY_SAVE_REQUIRED
            );
            assert_eq!(f.bytes(), before);
        }
    }

    #[test]
    fn undecided_import_keeps_the_saved_original_uuid() {
        let id = "11111111-1111-4111-8111-111111111111";
        let mut f = Fixture::new(serde_json::json!({"packMetadata":{"uuid":id,"originalUuid":id}}));
        let before = f.bytes();
        assert_eq!(
            saved_uuid(&prepare(&f.store, &mut f.target).unwrap()),
            Some(id)
        );
        assert_eq!(f.bytes(), before);
    }

    #[test]
    fn clean_open_project_without_saved_identity_has_a_dedicated_message() {
        let mut f = Fixture::new(serde_json::json!({"packMetadata":{}}));
        let before = f.bytes();
        let token = f.open();
        f.store
            .project_access("saved", None, Some(token), None)
            .unwrap();
        assert_eq!(
            prepare(&f.store, &mut f.target).unwrap_err().code,
            codes::STORYTELLER_PROJECT_OPEN_ID_REQUIRED
        );
        assert_eq!(f.bytes(), before);
    }

    #[test]
    fn failed_recheck_reports_that_identity_was_saved_and_retry_keeps_it() {
        let mut f = Fixture::new(serde_json::json!({"packMetadata":{}}));
        let error = prepare_with_token(
            &f.store,
            &mut f.target,
            crate::services::project_files::atomic_write_to,
            |_| None,
        )
        .unwrap_err();
        assert_eq!(error.code, codes::STORYTELLER_PROJECT_ID_RECHECK_FAILED);
        let persisted = f.bytes();
        let raw: Value = serde_json::from_slice(&persisted).unwrap();
        uuid::Uuid::parse_str(saved_uuid(&raw).unwrap()).unwrap();
        f.target.observation.as_mut().unwrap().token = catalogue::open::target::current_token(
            &f.target.path,
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(prepare(&f.store, &mut f.target).unwrap(), raw);
        assert_eq!(f.bytes(), persisted);
    }

    struct Fixture {
        root: PathBuf,
        store: Store,
        target: Target,
    }
    impl Fixture {
        fn new(raw: Value) -> Self {
            let root = std::env::temp_dir().join(format!("send-project-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("sauvegardes")).unwrap();
            let path = root.join("sauvegardes/Never exported.mbah");
            fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
            let store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
            let target = Target {
                observation: Some(Observed {
                    format: "project".into(),
                    state: "available".into(),
                    token: catalogue::open::target::current_token(
                        &path,
                        std::time::Duration::from_secs(5),
                    )
                    .unwrap(),
                    raw: Value::Null,
                }),
                path,
            };
            Self {
                root,
                store,
                target,
            }
        }
        fn bytes(&self) -> Vec<u8> {
            fs::read(&self.target.path).unwrap()
        }
        fn open(&self) -> String {
            self.store
                .project_access("open", Some(self.target.display_path()), None, None)
                .unwrap()["token"]
                .as_str()
                .unwrap()
                .into()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn existing_identity_and_aliases_are_used_without_writing() {
        for pointer in ["uuid", "packUuid"] {
            let mut raw = serde_json::json!({"packMetadata":{}});
            let id = uuid::Uuid::new_v4().to_string();
            raw["packMetadata"][pointer] = id.clone().into();
            let mut f = Fixture::new(raw);
            let before = f.bytes();
            let sent = prepare(&f.store, &mut f.target).unwrap();
            assert_eq!(saved_uuid(&sent), Some(id.as_str()));
            assert_eq!(f.bytes(), before);
        }
    }

    #[test]
    fn missing_identity_is_saved_once_including_in_backups() {
        let raw = serde_json::json!({"schemaVersion":3,"authoringMode":"free",
            "packMetadata":{"title":"Un livre"},"mediaTags":{"relative.mp3":["tag"]},
            "storage":{"unknown":"preserved"},"futureField":[1,2]});
        let mut f = Fixture::new(raw.clone());
        let first = prepare(&f.store, &mut f.target).unwrap();
        uuid::Uuid::parse_str(saved_uuid(&first).unwrap()).unwrap();
        let persisted = f.bytes();
        assert_eq!(serde_json::from_slice::<Value>(&persisted).unwrap(), first);
        let second = prepare(&f.store, &mut f.target).unwrap();
        assert_eq!(saved_uuid(&first), saved_uuid(&second));
        assert_eq!(f.bytes(), persisted);
        let mut restored = second;
        restored["packMetadata"]
            .as_object_mut()
            .unwrap()
            .remove("uuid");
        assert_eq!(restored, raw);
        f.target
            .require_unchanged(std::time::Duration::from_secs(5))
            .unwrap();
    }

    #[test]
    fn modified_editor_refuses_even_an_existing_identity() {
        let mut f = Fixture::new(serde_json::json!({"packMetadata":{"uuid":uuid::Uuid::new_v4()}}));
        let before = f.bytes();
        let token = f.open();
        assert_eq!(
            prepare(&f.store, &mut f.target).unwrap_err().code,
            codes::STORYTELLER_PROJECT_SAVE_REQUIRED
        );
        assert_eq!(f.bytes(), before);
        f.store
            .project_access("saved", None, Some(token), None)
            .unwrap();
        prepare(&f.store, &mut f.target).unwrap();
        assert_eq!(f.bytes(), before);
    }

    #[test]
    fn cannot_persist_identity_refuses_without_changing_the_project() {
        let mut f = Fixture::new(serde_json::json!({"packMetadata":{}}));
        let before = f.bytes();
        let result = prepare_with(&f.store, &mut f.target, |_, _, _| {
            Err("permission denied".into())
        });
        assert_eq!(
            result.unwrap_err().code,
            codes::STORYTELLER_PROJECT_IDENTITY_SAVE_FAILED
        );
        assert_eq!(f.bytes(), before);
        assert_eq!(
            fs::read_dir(f.target.path.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn missing_imported_identity_is_never_replaced() {
        let mut f =
            Fixture::new(serde_json::json!({"packMetadata":{"originalUuid":uuid::Uuid::new_v4()}}));
        let before = f.bytes();
        assert_eq!(
            prepare(&f.store, &mut f.target).unwrap_err().code,
            codes::EXPORT_PACK_IDENTITY_REQUIRED
        );
        assert_eq!(f.bytes(), before);
    }
}
