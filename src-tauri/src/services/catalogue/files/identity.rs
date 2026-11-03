//! Identity of a file as seen by the duplicate checks, and conversion provenance recorded for it.
use super::Result;
use crate::services::catalogue::{store::Store, writes};
use serde_json::Value;
use std::path::{Path, PathBuf};

impl Store {
    /// Explicitly created files outside a root remain part of its lineage.
    pub(crate) fn explicit_output_paths(&self, source: &str) -> Result<Vec<PathBuf>> {
        self.read(|c| c.prepare("SELECT json_extract(provenance_json,'$.outputPath') FROM file_conversion WHERE json_extract(provenance_json,'$.sourceId')=?1")?.query_map([source], |r|r.get::<_,String>(0))?.map(|r|r.map(PathBuf::from)).collect())
    }
}

fn conversion_provenance(store: &Store, path: &Path) -> Option<Value> {
    let (token, provenance): (String, String) = store
        .read(|c| {
            c.query_row(
                "SELECT source_token,provenance_json FROM file_conversion WHERE path_key=?1",
                [writes::comparison_key(path)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .ok()?;
    super::publication_matches(path, &token)
        .then(|| serde_json::from_str(&provenance).ok())
        .flatten()
}

/// Filesystem conversions keep a projection UUID, not a verified identity.
pub(super) fn source_identity(store: &Store, path: &Path, story: &Value) -> Option<String> {
    if conversion_provenance(store, path).is_some_and(|p| p["format"] == "fsDirectory") {
        None
    } else {
        crate::native_pack::pack_identity_from_story(story)
    }
}
