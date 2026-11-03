//! Versioned, unambiguous member keys (case-sensitive, length-delimited).
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Segment {
    pub kind: String,
    pub path: String,
}
pub fn key(chain: &[Segment]) -> Option<String> {
    if chain.is_empty() {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(b"catalogue-member-v1");
    for segment in chain {
        for value in [&segment.kind, &segment.path] {
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
    }
    Some(format!("{:x}", hash.finalize()))
}
pub fn validate_names<'a>(names: impl Iterator<Item = &'a str>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for name in names {
        let name = name.trim_end_matches('/');
        if name.is_empty()
            || name.starts_with('/')
            || name.contains(['\\', ':'])
            || name
                .split('/')
                .any(|s| s == "." || s == ".." || s.is_empty())
        {
            return Err("invalidArchivePath".into());
        }
        if !seen.insert(crate::support::imported_pack::archive_portable_key(name)) {
            return Err("archiveNameCollision".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn segmentation_and_case_are_distinct() {
        let make = |parts: Vec<&str>| {
            parts
                .into_iter()
                .map(|p| Segment {
                    kind: "archive-entry".into(),
                    path: p.into(),
                })
                .collect::<Vec<_>>()
        };
        assert_ne!(
            key(&make(vec!["a.zip/b.zip"])),
            key(&make(vec!["a.zip", "b.zip"]))
        );
        assert_ne!(key(&make(vec!["A.zip"])), key(&make(vec!["a.zip"])));
    }
}
