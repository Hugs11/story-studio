//! Portable catalogue backup, version 1.
//!
//! ZIP contains exactly manifest.json, catalogue.json and images/<lowercase SHA-256>.
//! Every payload is listed with its uncompressed size and SHA-256 in the manifest.
//! The manifest does not hash itself; the operation result hashes the entire ZIP.
//! UTF-8 JSON uses stable opaque IDs scoped by originCatalogueId. Table-like arrays
//! describe personal data, not a database dump. Reference values retain their last
//! known values even without a source. Locator and root hints are informational:
//! consumers must never activate roots, trust file proofs, or infer generation.
//! Optional cards[].importedReference preserves an unavailable selection, including
//! null when its original locator is unknown. It is never a local file attestation.
//! No absence in this document authorizes deletion during a merge.
//! Optional retainedImports contains flat original documents whose unassociated
//! evidence must survive another export. Their image payloads share the manifest.
//! Limits below apply to both archive verification and production. Unknown format,
//! version, schema, extra members, duplicate paths and inconsistent hashes fail.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const FORMAT: &str = "story-studio-catalogue";
pub const VERSION: u32 = 1;
pub const SCHEMA: &str = "catalogue-personal-v1";
pub const MAX_JSON: u64 = 512 * 1024 * 1024;
pub const MAX_IMAGE: u64 = 1024 * 1024;
pub const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
pub const MAX_IMAGES: usize = 4096;
pub const MAX_ROWS: usize = 2_000_000;
pub const MAX_DEPTH: usize = 32;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadableCounts {
    cards: usize,
    tags: usize,
    images: usize,
    #[serde(default, rename = "collections")]
    _collections: Option<serde::de::IgnoredAny>,
}
impl From<ReadableCounts> for Counts {
    fn from(value: ReadableCounts) -> Self {
        Self {
            cards: value.cards,
            tags: value.tags,
            images: value.images,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", from = "ReadableCounts")]
pub struct Counts {
    pub cards: usize,
    pub tags: usize,
    pub images: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payload {
    pub byte_size: u64,
    pub sha256: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub schema: String,
    pub backup_id: String,
    pub origin_catalogue_id: String,
    pub catalogue_revision: i64,
    pub counts: Counts,
    pub entries: BTreeMap<String, Payload>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPlan {
    pub plan_id: String,
    pub catalogue_revision: i64,
    pub destination_path: String,
    pub counts: Counts,
    pub estimated_bytes: u64,
    pub conflicts: Vec<String>,
    pub issues: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decisions {
    pub summary_validated: bool,
    #[serde(default)]
    pub replace_existing: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportResult {
    pub path: String,
    pub format_version: u32,
    pub catalogue_revision: i64,
    pub counts: Counts,
    pub byte_size: u64,
    pub digest: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub missing_lunii_images: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}
