//! Minimal metadata observations: no import normalization or media conversion.
#[cfg(test)]
mod device_pack_tests;
pub(super) mod fs_archive;
mod images;
mod listening;
mod member;
pub(super) mod pack_count;
mod project;
mod seven_zip;
mod seven_zip_listening;
#[cfg(test)]
pub(crate) use images::is_damaged as image_is_damaged;
pub(super) use listening::LISTENING_VERSION;
pub(super) use seven_zip_listening::{enrich as enrich_7z, ListeningFailure};
mod stream_zip;
mod studio;
mod temporary;
pub use project::project;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, path::Path};

pub const JSON_LIMIT: u64 = 16 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub raw: Value,
    pub value: Option<String>,
    pub source: String,
    pub reliable: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedField {
    pub presence: String,
    pub raw_value: Option<Value>,
    pub validity: String,
    pub source: String,
}
/// Catalogue ages accept the editor's integer strings without changing raw values.
pub(super) fn age(value: &Value) -> Option<u8> {
    let number = value.as_u64().or_else(|| {
        let text = value.as_str()?.trim();
        (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| text.parse::<u64>().ok())
            .flatten()
    })?;
    (number <= 18).then_some(number as u8)
}
pub fn observed(root: &Value, pointer: &str, kind: &str) -> ObservedField {
    let raw = root.pointer(pointer);
    let presence = match raw {
        None => "absent",
        Some(Value::Null) => "null",
        Some(_) => "present",
    };
    let validity = match raw {
        None | Some(Value::Null) => "unknown",
        Some(Value::String(value)) if value.trim().is_empty() => "empty",
        Some(value) => {
            if match kind {
                "string" => value.is_string(),
                "keywords" => value
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string)),
                "age" => age(value).is_some(),
                "integer" => value.as_i64().is_some(),
                _ => true,
            } {
                "valid"
            } else {
                "invalid"
            }
        }
    };
    ObservedField {
        presence: presence.into(),
        raw_value: raw.cloned(),
        validity: validity.into(),
        source: pointer.into(),
    }
}
/// Only metadata reading is attempted by a scan; deeper capabilities stay
/// unknown until a dedicated analysis.
fn capabilities(read_metadata: Value) -> Value {
    serde_json::json!({
        "readMetadata": read_metadata,
        "readCover": {"state": "unknown"},
        "assessEditors": {"state": "unknown"},
        "openSimulation": {"state": "unknown"},
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    #[serde(default)]
    pub listening_version: u8,
    /// A measurement interrupted or raced by a changing sound: its values
    /// are dropped before publication and measured again next time.
    #[serde(skip)]
    pub listening_incomplete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listening_token: Option<String>,
    #[serde(default)]
    pub listening_pending: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub listening_dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversion_provenance: Option<Value>,
    pub fields: std::collections::BTreeMap<String, ObservedField>,
    pub capabilities: Value,
    pub format: String,
    pub state: String,
    pub title: Option<String>,
    pub identity: Option<Identity>,
    pub age_min: Option<u8>,
    pub age_from_name: Option<u8>,
    pub cover: Option<Value>,
    pub raw: Value,
    pub diagnostics: Vec<String>,
    pub member: Option<String>,
    pub chain: Vec<member::Segment>,
}
impl Observation {
    pub fn new(format: &str) -> Self {
        Self {
            conversion_provenance: None,
            listening_version: LISTENING_VERSION,
            listening_incomplete: false,
            listening_token: None,
            listening_pending: false,
            listening_dependencies: Vec::new(),
            fields: Default::default(),
            capabilities: capabilities(
                serde_json::json!({"state": "available", "verificationScope": "metadata"}),
            ),
            format: format.into(),
            state: "available".into(),
            title: None,
            identity: None,
            age_min: None,
            age_from_name: None,
            cover: None,
            raw: Value::Null,
            diagnostics: Vec::new(),
            member: None,
            chain: Vec::new(),
        }
    }
    pub fn failure(format: &str, reason: String, member: Option<String>) -> Self {
        let mut value = Self::new(format);
        value.state = public_reason(&reason).into();
        value.capabilities =
            capabilities(serde_json::json!({"state": "unavailable", "reason": value.state}));
        value.diagnostics.push(reason);
        value.member = member;
        value
    }
    pub fn prepend_member(&mut self, kind: &str, path: &str) {
        self.chain.insert(
            0,
            member::Segment {
                kind: kind.into(),
                path: path.into(),
            },
        );
    }
    pub fn member_key(&self) -> Option<String> {
        member::key(&self.chain)
    }
    /// First valid value among the observed `pointers`, in order. Only a
    /// field the reader recorded as present and valid is used.
    pub fn valid_field(&self, pointers: &[&str]) -> Option<&Value> {
        pointers.iter().find_map(|pointer| {
            self.fields
                .get(*pointer)
                .filter(|field| field.validity == "valid")
                .and_then(|field| field.raw_value.as_ref())
        })
    }
    pub fn text(&self, pointers: &[&str]) -> Option<&str> {
        self.valid_field(pointers).and_then(Value::as_str)
    }
    pub fn uuid(&self) -> Option<&str> {
        self.identity
            .as_ref()
            .filter(|i| i.reliable)
            .and_then(|i| i.value.as_deref())
    }
}
/// Exclusive public motif of a failed read; the reader's own reason stays in
/// the diagnostics. A generic failure is never reported as a corruption.
pub fn public_reason(reason: &str) -> &'static str {
    let code = crate::support::user_message::UserMessage::from(reason.to_owned()).code;
    if code == crate::support::user_message::codes::IMPORT_UNSUPPORTED_COMPRESSION {
        return "unsupportedFormat";
    }
    if code == crate::support::user_message::codes::IMPORT_FS_ENCRYPTED_UNKNOWN_KEY {
        return "encryptedUnknownKey";
    }
    match reason {
        "archiveCorrupt" => "corruptArchive",
        "archiveProtected" => "protectedArchive",
        "invalidArchivePath"
        | "invalidPackStructure"
        | "invalidProjectEnvelope"
        | "invalidProjectPayload" => "invalidStructure",
        "projectSchemaUnsupported" | "formatUnsupported" => "unsupportedFormat",
        "readLimitExceeded" => "readLimitExceeded",
        "fileUnstable" => "fileUnstable",
        "fileDisappeared" => "fileDisappeared",
        "accessDenied" => "accessDenied",
        "cancelled" => "cancelled",
        _ => "unreadableUnknown",
    }
}
/// The device-pack variant recorded by the preview of a device pack
/// (`fs_pack_preview_with`). A STUdio observation of a 7z keeps its
/// `story.json` as `raw` instead, recognised by its `stageNodes`.
pub(crate) fn device_pack_variant(
    observation: &Value,
) -> Option<crate::support::fs_pack_reader::FsPackVariant> {
    let raw = &observation["raw"];
    if raw.get("stageNodes").is_some() {
        return None;
    }
    raw["variant"]
        .as_str()
        .and_then(crate::support::fs_pack_reader::FsPackVariant::from_preview_name)
}

/// Whether an observation is a device pack: its `raw` is a reader preview,
/// not a STUdio story, and any other representation is a conversion. A
/// device pack read from a 7z keeps the `7z` container format.
pub(crate) fn is_device_pack(format: &str, observation: &Value) -> bool {
    matches!(format, "fsDirectory" | "fsZip")
        || (format == "7z" && device_pack_variant(observation).is_some())
}

pub fn identity(raw: &Value, source: &str) -> Identity {
    let value = raw
        .as_str()
        .and_then(|s| uuid::Uuid::parse_str(s.trim()).ok())
        .filter(|id| !id.is_nil())
        .map(|id| id.to_string());
    Identity {
        reliable: value.is_some(),
        raw: raw.clone(),
        value,
        source: source.into(),
    }
}
pub fn json(reader: impl Read) -> Result<Value, String> {
    let mut bytes = Vec::new();
    reader
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > JSON_LIMIT {
        return Err("readLimitExceeded".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
/// The listening values an observation may carry.
pub const LISTENING_FIELDS: [&str; 3] = [
    "/packMetadata/storyCount",
    "/packMetadata/durationSeconds",
    images::DAMAGED_MEDIA,
];
pub fn clear_listening(observation: &mut Observation) {
    for pointer in LISTENING_FIELDS {
        observation.fields.remove(pointer);
    }
}
/// Metadata only, as every reader outside the catalogue scan needs it.
pub fn analyze(
    path: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Vec<Observation>, String> {
    analyze_with(path, cancel, false)
}
/// `measure` adds listening values (story count, duration) to the metadata;
/// solid archives only get scheduled for their separate pass.
pub fn analyze_with(
    path: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    measure: bool,
) -> Result<Vec<Observation>, String> {
    let mut values = if path.is_dir() {
        vec![studio::directory(path, cancel, measure)?]
    } else {
        match path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "mbah" if measure => vec![project::project_for_scan(path, cancel)?],
            "mbah" => vec![project(path)?],
            "zip" => studio::zip_at(
                std::fs::File::open(path).map_err(|e| e.to_string())?,
                0,
                cancel,
                path,
                measure,
            )?,
            "7z" => seven_zip::analyze(path, cancel)?,
            _ => return Err("formatUnsupported".into()),
        }
    };
    for value in &mut values {
        // Only a readable solid-archive pack waits for its one-off listening
        // pass; a failure has nothing to measure.
        value.listening_pending = measure && value.format == "7z" && value.state == "available";
        let name = value
            .member
            .as_deref()
            .and_then(|m| Path::new(m).file_name())
            .or_else(|| path.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        value.age_from_name = super::age_prefix::extract(name);
    }
    Ok(values)
}

mod cover;
pub use cover::{read_cover, CoverReadError};
pub(crate) use member::validate_names as validate_member_names;
pub(crate) use pack_count::archive_pack_count;
pub(crate) use seven_zip::{
    extract_folder as extract_7z_folder, parse_listing as parse_7z_listing,
    spool_member_cancellable as spool_7z_member,
};

#[cfg(test)]
pub(crate) use seven_zip::execute as run_archive_tool;
pub(crate) use seven_zip::run_with_binary as read_archive_tool;

/// Test-only timing of archive directory listings, separate from metadata reads.
#[cfg(test)]
pub(super) mod inventory_profile {
    use std::sync::atomic::{AtomicU64, Ordering};
    pub static NANOS: AtomicU64 = AtomicU64::new(0);
    pub struct Timer(std::time::Instant);
    impl Timer {
        pub fn start() -> Self {
            Self(std::time::Instant::now())
        }
    }
    impl Drop for Timer {
        fn drop(&mut self) {
            NANOS.fetch_add(self.0.elapsed().as_nanos() as u64, Ordering::Relaxed);
        }
    }
}
