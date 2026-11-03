//! Mandatory identity decision before pack serialization or exact transfer.
//! Source `official` is deliberately never evidence of official origin.
use crate::domain::official_provenance::{is_official_origin, OfficialProvenance};
use crate::domain::project::{Project, ProjectEntry};
use crate::services::official_packs::OfficialCatalogue;
use crate::support::user_message::{codes, UserMessage};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputForm {
    Rewritten,
    ExactCopy,
    Storyteller,
}

pub(crate) struct ContentIdentity<'a> {
    pub(crate) provenance: OfficialProvenance,
    pub(crate) uuid: &'a str,
    pub(crate) origin_uuid: Option<&'a str>,
}

/// Fields are private: only `decide` can authorize an output.
#[derive(Debug, Clone)]
pub(crate) struct OutputIdentity {
    uuid: String,
    official: bool,
    form: OutputForm,
}
impl OutputIdentity {
    pub(crate) fn apply(&self, story: &mut Value) {
        if self.form == OutputForm::ExactCopy {
            return;
        }
        if let Some(root) = story.as_object_mut() {
            if self.official && !self.uuid.is_empty() {
                root.insert("uuid".into(), self.uuid.clone().into());
            }
            root.remove("official");
            if self.official {
                root.insert("official".into(), true.into());
            }
        }
    }
    /// D3: even an unrecognized source must lose its untrusted `official` member.
    pub(crate) fn serialize(&self, text: &str) -> Result<AuthorizedStory, String> {
        let mut story: Value =
            serde_json::from_str(text).map_err(|e| invalid_story(e).into_transport())?;
        let before = story.clone();
        self.apply(&mut story);
        if story == before {
            Ok(AuthorizedStory(text.to_owned()))
        } else {
            serde_json::to_string_pretty(&story)
                .map(AuthorizedStory)
                .map_err(|e| invalid_story(e).into_transport())
        }
    }
}
pub(crate) fn same(a: &str, b: &str) -> bool {
    match (uuid::Uuid::parse_str(a), uuid::Uuid::parse_str(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The only business decision; no policy switch, environment or JS summary.
pub(crate) fn decide<C: OfficialCatalogue + ?Sized>(
    document: ContentIdentity<'_>,
    form: OutputForm,
    contents: &[ContentIdentity<'_>],
    flattened_official_content: bool,
    catalogue: Option<&C>,
) -> Result<OutputIdentity, UserMessage> {
    // Writers trim user-entered identity; recognition must inspect that emitted value.
    let current = document.uuid.trim();
    let official = is_official_origin(document.provenance, current, catalogue)?;
    if form == OutputForm::Storyteller {
        let mut blocked = official || flattened_official_content;
        for content in contents {
            blocked |= is_official_origin(content.provenance, content.uuid.trim(), catalogue)?;
        }
        if blocked {
            return Err(UserMessage::new(codes::STORYTELLER_OFFICIAL_REFUSED));
        }
    }
    if official
        && ((document.provenance == OfficialProvenance::Official && document.origin_uuid.is_none())
            || document
                .origin_uuid
                .is_some_and(|origin| !same(origin.trim(), current)))
    {
        return Err(UserMessage::new(codes::OFFICIAL_IDENTITY_LOCKED));
    }
    for content in contents {
        let recognized_uuid =
            is_official_origin(OfficialProvenance::Unknown, content.uuid.trim(), catalogue)?;
        let official_content =
            content.provenance == OfficialProvenance::Official || recognized_uuid;
        // A contradictory stored origin must never hide a currently recognized child UUID.
        if (official_content && !same(content.origin_uuid.unwrap_or(content.uuid).trim(), current))
            || (recognized_uuid && !same(content.uuid.trim(), current))
        {
            return Err(UserMessage::new(codes::OFFICIAL_CONTENT_OUTPUT_REFUSED));
        }
    }
    // A flattened graph retains containment but no individual child identities.
    // This marker contains only foreign origins, including for an official document.
    if flattened_official_content {
        return Err(UserMessage::new(codes::OFFICIAL_CONTENT_OUTPUT_REFUSED));
    }
    Ok(OutputIdentity {
        uuid: current.to_owned(),
        official,
        form,
    })
}

/// Capability tied to an immutable document, never reusable for a different story.
#[derive(Debug)]
pub(crate) struct StorytellerAuthorization {
    document: super::StoryDocument,
    uuid: uuid::Uuid,
}
impl StorytellerAuthorization {
    pub(crate) fn document(&self) -> &super::StoryDocument {
        &self.document
    }
    pub(crate) fn uuid(&self) -> uuid::Uuid {
        self.uuid
    }
}

/// Decode the source and its own envelope here. There is deliberately no
/// document/context pair in this API: an empty caller context cannot erase
/// provenance stored in the source.
pub(crate) fn authorize_storyteller(
    source: &str,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<StorytellerAuthorization, UserMessage> {
    let value: Value = serde_json::from_str(source).map_err(invalid_story)?;
    let decoded = if value.get("payloadVersion").is_some() {
        super::persistence::decode_authoring_payload(source).map_err(invalid_story)?
    } else {
        super::decode_story_document(source).map_err(invalid_story)?
    };
    // Imported extensions may retain provenance and nested identities even
    // when they are opaque to the graph dialect. Inspect the source itself.
    fn inspect(
        value: &Value,
        catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    ) -> Result<(), UserMessage> {
        match value {
            Value::Object(object) => {
                if object.get("officialProvenance").and_then(Value::as_str) == Some("official")
                    || object
                        .get("containsOfficialContent")
                        .and_then(Value::as_bool)
                        == Some(true)
                {
                    return Err(UserMessage::new(codes::STORYTELLER_OFFICIAL_REFUSED));
                }
                for key in ["uuid", "packUuid"] {
                    if let Some(uuid) = object.get(key).and_then(Value::as_str) {
                        if is_official_origin(OfficialProvenance::Unknown, uuid, catalogue)? {
                            return Err(UserMessage::new(codes::STORYTELLER_OFFICIAL_REFUSED));
                        }
                    }
                }
                for child in object.values() {
                    inspect(child, catalogue)?;
                }
            }
            Value::Array(children) => {
                for child in children {
                    inspect(child, catalogue)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    inspect(&value, catalogue)?;
    authorize_decoded_storyteller(&decoded.document, &decoded.context, catalogue)
}

/// Archive provenance is reread from its conversion sidecar by the existing
/// importer, never accepted as an independent caller parameter.
pub(crate) fn authorize_storyteller_path(
    path: &std::path::Path,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<StorytellerAuthorization, UserMessage> {
    let imported = crate::support::imported_pack::ensure_studio_pack_zip(&path.to_string_lossy())
        .map_err(UserMessage::from)?;
    let source = read_story_text(&imported.zip_path)?;
    // First gate extensions retained by the archive, then its conversion context.
    authorize_storyteller(&source, catalogue)?;
    let decoded = super::decode_story_document(&source).map_err(invalid_story)?;
    let context = imported.conversion_context(&decoded.document);
    let decoded = decoded.with_conversion_context(context);
    authorize_decoded_storyteller(&decoded.document, &decoded.context, catalogue)
}

fn authorize_decoded_storyteller(
    document: &super::StoryDocument,
    context: &super::StoryDocumentContext,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<StorytellerAuthorization, UserMessage> {
    let document_uuid = super::dialect::pack_identity_from_story(
        &serde_json::to_value(document).map_err(invalid_story)?,
    );
    let uuid = context
        .pack_identity
        .value
        .as_deref()
        .or(document_uuid.as_deref())
        .ok_or_else(|| invalid_story("missing pack UUID"))?;
    // Also inspect the actual document identity: a contradictory context must
    // never conceal a currently recognized entry-stage UUID.
    let contents: Vec<_> = context
        .foreign_pack_uuids
        .iter()
        .map(String::as_str)
        .chain(document_uuid.as_deref())
        .map(|uuid| ContentIdentity {
            provenance: OfficialProvenance::Unknown,
            uuid,
            origin_uuid: None,
        })
        .collect();
    let identity = decide(
        ContentIdentity {
            provenance: context.official_provenance,
            uuid,
            origin_uuid: context.official_origin_uuid.as_deref(),
        },
        OutputForm::Storyteller,
        &contents,
        context.contains_official_content,
        catalogue,
    )?;
    let uuid = uuid::Uuid::parse_str(&identity.uuid).map_err(invalid_story)?;
    Ok(StorytellerAuthorization {
        document: document.clone(),
        uuid,
    })
}

pub(crate) fn for_story(
    story: &Value,
    form: OutputForm,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<OutputIdentity, UserMessage> {
    let uuid = super::dialect::pack_identity_from_story(story).unwrap_or_default();
    decide(
        ContentIdentity {
            provenance: OfficialProvenance::Unknown,
            uuid: &uuid,
            origin_uuid: None,
        },
        form,
        &[],
        false,
        catalogue,
    )
}

pub(crate) fn for_project(
    project: &Project,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<OutputIdentity, String> {
    fn collect<'a>(entries: &'a [ProjectEntry], out: &mut Vec<ContentIdentity<'a>>) {
        for entry in entries {
            out.push(ContentIdentity {
                provenance: entry.official_provenance,
                uuid: &entry.pack_uuid,
                origin_uuid: entry.official_origin_uuid.as_deref(),
            });
            collect(&entry.children, out);
        }
    }
    let mut contents = Vec::new();
    collect(&project.root_entries, &mut contents);
    collect(&project.shared_entries, &mut contents);
    fn zip_decisions(
        entries: &[ProjectEntry],
        catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
        out: &mut Vec<OutputIdentity>,
    ) -> Result<(), String> {
        for entry in entries {
            if let Some(path) = entry
                .zip_path
                .as_deref()
                .filter(|_| entry.entry_type == "zip")
            {
                let path = crate::services::project_files::validate_existing_file_path(
                    path,
                    codes::FILES_IMPORTED_ARCHIVE_TRANSPORT,
                )?;
                let decision = if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
                {
                    match for_path(&path, OutputForm::Rewritten, catalogue) {
                        Ok(identity) => identity,
                        Err(error) if error.code == codes::IMPORT_STORY_FILE_MISSING => {
                            // Native FS ZIPs still use the existing converter. If no pack
                            // is found, preserve the Studio reader's missing-story error.
                            let imported = crate::support::imported_pack::ensure_studio_pack_zip(
                                &path.to_string_lossy(),
                            )
                            .map_err(|_| error.into_transport())?;
                            for_path(&imported.zip_path, OutputForm::Rewritten, catalogue)
                                .map_err(UserMessage::into_transport)?
                        }
                        Err(error) => return Err(error.into_transport()),
                    }
                } else {
                    let imported = crate::support::imported_pack::ensure_studio_pack_zip(
                        &path.to_string_lossy(),
                    )?;
                    for_path(&imported.zip_path, OutputForm::Rewritten, catalogue)
                        .map_err(UserMessage::into_transport)?
                };
                out.push(decision);
            }
            zip_decisions(&entry.children, catalogue, out)?;
        }
        Ok(())
    }
    let mut nested = Vec::new();
    zip_decisions(&project.root_entries, catalogue, &mut nested)?;
    zip_decisions(&project.shared_entries, catalogue, &mut nested)?;
    contents.extend(nested.iter().map(|identity| ContentIdentity {
        provenance: if identity.official {
            OfficialProvenance::Official
        } else {
            OfficialProvenance::Unknown
        },
        uuid: &identity.uuid,
        origin_uuid: None,
    }));
    decide(
        ContentIdentity {
            provenance: project.official_provenance,
            uuid: &project.pack_uuid,
            origin_uuid: project.official_origin_uuid.as_deref(),
        },
        OutputForm::Rewritten,
        &contents,
        false,
        catalogue,
    )
    .map_err(UserMessage::into_transport)
}

pub(crate) fn for_context(
    context: &super::dialect::StoryDocumentContext,
    uuid: &str,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<OutputIdentity, UserMessage> {
    let contents: Vec<_> = context
        .foreign_pack_uuids
        .iter()
        .map(|uuid| ContentIdentity {
            provenance: OfficialProvenance::Unknown,
            uuid,
            origin_uuid: None,
        })
        .collect();
    decide(
        ContentIdentity {
            provenance: context.official_provenance,
            uuid,
            origin_uuid: context.official_origin_uuid.as_deref(),
        },
        OutputForm::Rewritten,
        &contents,
        context.contains_official_content,
        catalogue,
    )
}

pub(crate) fn for_path(
    path: &std::path::Path,
    form: OutputForm,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
) -> Result<OutputIdentity, UserMessage> {
    // Exact transfer cannot refuse or rewrite an identity. Opaque containers (7z,
    // native FS) need no conversion or archive tool just to copy their bytes.
    if form == OutputForm::ExactCopy {
        return for_story(&serde_json::json!({}), form, catalogue);
    }
    let text = read_story_text(path)?;
    let value = serde_json::from_str(&text).map_err(invalid_story)?;
    for_story(&value, form, catalogue)
}

/// Serialized story bytes can only be obtained after an identity decision.
#[derive(Debug)]
pub(crate) struct AuthorizedStory(String);
impl std::ops::Deref for AuthorizedStory {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}
impl AuthorizedStory {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
    pub(crate) fn copy_to<W: std::io::Write>(
        &self,
        writer: &mut W,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> std::io::Result<u64> {
        crate::support::imported_pack::cancellation::copy(
            &mut std::io::Cursor::new(self.as_bytes()),
            writer,
            cancel,
        )
    }
    pub(crate) fn write_file(&self, path: &std::path::Path) -> std::io::Result<()> {
        std::fs::write(path, self.as_bytes())
    }
}
impl PartialEq<&str> for AuthorizedStory {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}
impl AsRef<[u8]> for AuthorizedStory {
    fn as_ref(&self) -> &[u8] {
        self.0.as_bytes()
    }
}
impl PartialEq<String> for AuthorizedStory {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}
pub(crate) fn invalid_story(error: impl std::fmt::Display) -> UserMessage {
    UserMessage::new(codes::IMPORT_STORY_DOCUMENT_INVALID).param("reason", error.to_string())
}

// Identity inspection needs JSON only, never the 500 MiB media-member allowance.
use crate::services::pack_reader::MAX_STORY_JSON_BYTES;
pub(crate) fn read_story_text(path: &std::path::Path) -> Result<String, UserMessage> {
    use crate::support::archive_limits::ARCHIVE_MAX_ENTRIES;
    use std::io::Read;
    let read_error = |e: std::io::Error| {
        UserMessage::new(codes::IMPORT_STORY_JSON_READ_FAILED).param("reason", e.to_string())
    };
    let mut archive;
    let input: Box<dyn Read>;
    if path.is_dir() {
        input = Box::new(std::fs::File::open(path.join("story.json")).map_err(read_error)?);
    } else {
        let file = std::fs::File::open(path).map_err(|e| {
            UserMessage::new(codes::IMPORT_ZIP_OPEN_FAILED).param("reason", e.to_string())
        })?;
        // Matches ensure_studio_pack_zip's validation before zip_bundle opens a child.
        archive = zip::ZipArchive::new(file).map_err(|e| {
            UserMessage::from(crate::support::imported_pack::archive_zip_error(
                &e,
                UserMessage::new(codes::IMPORT_ARCHIVE_ZIP_INVALID)
                    .param("path", path.display().to_string())
                    .param("error", e.to_string())
                    .into_transport(),
            ))
        })?;
        if archive.len() > ARCHIVE_MAX_ENTRIES {
            return Err(UserMessage::new(codes::IMPORT_ARCHIVE_ENTRIES_LIMIT)
                .param("count", archive.len().to_string())
                .param("source", path.display().to_string())
                .param("maxEntries", ARCHIVE_MAX_ENTRIES.to_string()));
        }
        input = Box::new(archive.by_name("story.json").map_err(|_| {
            UserMessage::new(codes::IMPORT_STORY_FILE_MISSING)
                .param("zip_path_buf", path.display().to_string())
        })?);
    }
    let mut bytes = Vec::new();
    input
        .take(MAX_STORY_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() as u64 > MAX_STORY_JSON_BYTES {
        return Err(UserMessage::new(codes::IMPORT_ARCHIVE_MEMBER_SIZE_LIMIT)
            .param("name", "story.json")
            .param("sizeMb", (bytes.len() as u64 / (1024 * 1024)).to_string())
            .param(
                "maxFileMb",
                (MAX_STORY_JSON_BYTES / (1024 * 1024)).to_string(),
            ));
    }
    String::from_utf8(bytes).map_err(|e| {
        UserMessage::new(codes::IMPORT_STORY_JSON_READ_FAILED).param("reason", e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";
    struct Fake;
    impl OfficialCatalogue for Fake {
        type Error = UserMessage;
        fn contains_official(&self, uuid: &str) -> Result<bool, UserMessage> {
            Ok(uuid == A)
        }
    }
    fn content(uuid: &str) -> ContentIdentity<'_> {
        ContentIdentity {
            provenance: OfficialProvenance::Unknown,
            uuid,
            origin_uuid: None,
        }
    }
    #[test]
    fn official_origin_and_its_marked_roots_export_alone_but_not_under_another_identity() {
        let source = ContentIdentity {
            provenance: OfficialProvenance::Official,
            uuid: A,
            origin_uuid: Some(A),
        };
        let child = ContentIdentity {
            provenance: OfficialProvenance::Official,
            uuid: "",
            origin_uuid: Some(A),
        };
        let decision = decide(source, OutputForm::Rewritten, &[child], false, Some(&Fake)).unwrap();
        let mut story = serde_json::json!({"uuid": A,"title":"Modified"});
        decision.apply(&mut story);
        assert_eq!(story["uuid"], A);
        assert_eq!(story["official"], true);
        let error = decide(
            ContentIdentity {
                provenance: OfficialProvenance::Official,
                uuid: B,
                origin_uuid: Some(A),
            },
            OutputForm::Rewritten,
            &[],
            false,
            Some(&Fake),
        )
        .unwrap_err();
        assert_eq!(error.code, codes::OFFICIAL_IDENTITY_LOCKED);
    }
    #[test]
    fn aggregation_and_assembly_refuse_provenance_and_recognized_child_uuid() {
        for child in [
            ContentIdentity {
                provenance: OfficialProvenance::Official,
                uuid: A,
                origin_uuid: Some(B),
            },
            content(A),
            ContentIdentity {
                provenance: OfficialProvenance::Official,
                uuid: "",
                origin_uuid: Some(A),
            },
        ] {
            let error = decide(
                content(B),
                OutputForm::Rewritten,
                &[child],
                false,
                Some(&Fake),
            )
            .unwrap_err();
            assert_eq!(error.code, codes::OFFICIAL_CONTENT_OUTPUT_REFUSED);
        }
    }
    #[test]
    fn legacy_unknown_uses_current_uuid_only_and_source_official_is_not_evidence() {
        let decision = decide(content(B), OutputForm::Rewritten, &[], false, Some(&Fake)).unwrap();
        let mut story = serde_json::json!({"uuid":B,"originalUuid":A,"official":true});
        decision.apply(&mut story);
        assert_eq!(story["uuid"], B);
        assert!(story.get("official").is_none());
    }
    #[test]
    fn libre_assembly_and_aggregation_refuse_before_writing_and_ignore_js_summary() {
        for roots in [
            serde_json::json!([{"type":"story","officialProvenance":"official","officialOriginUuid":A}]),
            serde_json::json!([{"type":"menu","children":[{"type":"story","officialProvenance":"official","officialOriginUuid":A}]}]),
        ] {
            let project: Project = serde_json::from_value(serde_json::json!({"packUuid":B,"containsOfficialContent":false,"globalOptions":{"autoNext":false,"nightMode":false},"rootEntries":roots})).unwrap();
            let output =
                std::env::temp_dir().join(format!("refused-official-{}", uuid::Uuid::new_v4()));
            let error = crate::native_pack::generate_native_pack_v1_with_cancel(
                &project,
                &output.to_string_lossy(),
                &|_| {},
                &|| false,
            )
            .unwrap_err();
            assert_eq!(
                UserMessage::from(error).code,
                codes::OFFICIAL_CONTENT_OUTPUT_REFUSED
            );
            assert!(!output.exists());
        }
        let legacy: Project = serde_json::from_value(serde_json::json!({"packUuid":B,"containsOfficialContent":true,"globalOptions":{"autoNext":false,"nightMode":false},"rootEntries":[]})).unwrap();
        assert!(
            for_project(&legacy, Some(&Fake)).is_ok(),
            "untrusted document summary is ignored"
        );
    }

    #[test]
    fn aggregation_reads_child_zip_even_when_js_omits_all_provenance() {
        use std::io::Write;
        let folder = std::env::temp_dir().join(format!("output-child-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("child.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        writer
            .start_file("story.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(serde_json::json!({"uuid":A}).to_string().as_bytes())
            .unwrap();
        writer.finish().unwrap();
        let project: Project = serde_json::from_value(serde_json::json!({"packUuid":B,"globalOptions":{"autoNext":false,"nightMode":false},"rootEntries":[{"type":"zip","zipPath":path}]})).unwrap();
        assert_eq!(
            UserMessage::from(for_project(&project, Some(&Fake)).unwrap_err()).code,
            codes::OFFICIAL_CONTENT_OUTPUT_REFUSED
        );
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn child_zip_failures_keep_import_codes_and_bound_identity_reads() {
        use std::io::{Read, Write};
        let base = std::env::temp_dir().join(format!("child-errors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let child = base.join("child.zip");
        let project: Project = serde_json::from_value(serde_json::json!({
            "packUuid":B,"globalOptions":{"autoNext":false,"nightMode":false},
            "rootEntries":[{"type":"zip","zipPath":child}]
        }))
        .unwrap();
        std::fs::write(&child, b"corrupt ZIP").unwrap();
        assert_eq!(
            UserMessage::from(for_project(&project, Some(&Fake)).unwrap_err()).code,
            codes::IMPORT_INVALID_ARCHIVE
        );
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&child).unwrap());
        zip.start_file("other.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"other").unwrap();
        zip.finish().unwrap();
        assert_eq!(
            for_path(&child, OutputForm::Rewritten, Some(&Fake))
                .unwrap_err()
                .code,
            codes::IMPORT_STORY_FILE_MISSING
        );
        assert_eq!(
            UserMessage::from(for_project(&project, Some(&Fake)).unwrap_err()).code,
            codes::IMPORT_STORY_FILE_MISSING
        );

        let mut zip = zip::ZipWriter::new(std::fs::File::create(&child).unwrap());
        zip.start_file(
            "story.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        std::io::copy(
            &mut std::io::repeat(b' ').take(MAX_STORY_JSON_BYTES + 1),
            &mut zip,
        )
        .unwrap();
        zip.finish().unwrap();
        assert_eq!(
            UserMessage::from(for_project(&project, Some(&Fake)).unwrap_err()).code,
            codes::IMPORT_ARCHIVE_MEMBER_SIZE_LIMIT
        );
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&child).unwrap());
        for index in 0..=crate::support::archive_limits::ARCHIVE_MAX_ENTRIES {
            zip.start_file(
                format!("{index}.txt"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        }
        zip.finish().unwrap();
        assert_eq!(
            for_path(&child, OutputForm::Rewritten, Some(&Fake))
                .unwrap_err()
                .code,
            codes::IMPORT_ARCHIVE_ENTRIES_LIMIT
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn exact_copy_is_byte_for_byte_even_when_official_member_is_absent() {
        let raw = format!("{{ \"uuid\" : \"{A}\" }}\n");
        let decision = decide(content(A), OutputForm::ExactCopy, &[], false, Some(&Fake)).unwrap();
        assert_eq!(decision.serialize(&raw).unwrap().as_bytes(), raw.as_bytes());
        let with_official = format!("{{ \"uuid\" : \"{A}\", \"official\": true }}\n");
        assert_eq!(
            decision.serialize(&with_official).unwrap().as_bytes(),
            with_official.as_bytes()
        );
    }
}
