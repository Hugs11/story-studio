//! Shared bounded format verification, without extracting archive paths.
use super::{failed, format::*, image_missing, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::File, io::Read, path::Path};
pub fn hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn payload(bytes: &[u8]) -> Payload {
    Payload {
        byte_size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    }
}
pub fn image(path: &Path, sha: &str, size: u64) -> Result<Vec<u8>> {
    let read = (|| -> std::io::Result<Vec<u8>> {
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_file() || size > MAX_IMAGE || meta.len() != size {
            return Err(std::io::Error::other("Invalid retained image size or type"));
        }
        let mut bytes = Vec::new();
        File::open(path)?
            .take(MAX_IMAGE + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })();
    let bytes = read.map_err(|e| image_missing(sha).with_detail(e.to_string()))?;
    if bytes.len() as u64 != size || payload(&bytes).sha256 != sha {
        return Err(image_missing(sha));
    }
    Ok(bytes)
}
fn depth(value: &Value, level: usize) -> Result<()> {
    if level > MAX_DEPTH {
        return Err(failed());
    }
    match value {
        Value::Array(a) => {
            for v in a {
                depth(v, level + 1)?;
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                depth(v, level + 1)?;
            }
        }
        _ => (),
    }
    Ok(())
}
pub const ARRAYS: &[&str] = &[
    "cards",
    "forgottenCards",
    "associations",
    "identities",
    "exemplarHints",
    "provenances",
    "references",
    "referenceValues",
    "corrections",
    "tags",
    "tagMembers",
    "suggestionDecisions",
    "pendingAssociations",
    "rootHints",
];
/// Discard obsolete organization data before planning, retaining or re-exporting.
pub fn ignore_collections(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("collections");
        object.remove("collectionMembers");
        if let Some(retained) = object
            .get_mut("retainedImports")
            .and_then(Value::as_array_mut)
        {
            for document in retained {
                ignore_collections(document);
            }
        }
    }
}
pub fn document(value: &Value) -> Result<()> {
    depth(value, 0)?;
    let o = value.as_object().ok_or_else(failed)?;
    let extra = ["retainedImports", "collections", "collectionMembers"]
        .iter()
        .filter(|key| o.contains_key(**key))
        .count();
    if o.len() != ARRAYS.len() + 2 + extra
        || value["originCatalogueId"]
            .as_str()
            .is_none_or(str::is_empty)
        || value["catalogueRevision"].as_i64().is_none_or(|n| n < 0)
    {
        return Err(failed());
    }
    let mut total = 0;
    for key in ARRAYS {
        total += value[*key].as_array().ok_or_else(failed)?.len();
    }
    if let Some(retained) = o.get("retainedImports") {
        for doc in retained.as_array().ok_or_else(failed)? {
            if doc.get("retainedImports").is_some() {
                return Err(failed());
            }
            document(doc)?;
            total += ARRAYS
                .iter()
                .map(|key| doc[*key].as_array().unwrap().len())
                .sum::<usize>();
        }
    }
    if total > MAX_ROWS {
        return Err(super::row_limit());
    }
    for correction in value["corrections"].as_array().unwrap() {
        match correction["state"].as_str() {
            Some("defined") if !correction["value"].is_null() => (),
            Some("cleared" | "source")
                if correction["value"].is_null() && correction["imageSha256"].is_null() => {}
            _ => return Err(failed()),
        }
    }
    Ok(())
}
fn read_member<R: Read>(reader: R, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(super::io_error)?;
    if bytes.len() as u64 > max {
        return Err(failed());
    }
    Ok(bytes)
}
pub fn archive(path: &Path) -> Result<Manifest> {
    archive_cancel(path, &std::sync::atomic::AtomicBool::new(false))
}
pub(super) fn archive_cancel(
    path: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Manifest> {
    super::export::check(cancel)?;
    let file = File::open(path).map_err(super::io_error)?;
    if file.metadata().map_err(super::io_error)?.len() > MAX_TOTAL + MAX_JSON {
        return Err(failed());
    }
    let mut zip = zip::ZipArchive::new(file).map_err(|_| failed())?;
    if zip.len() > MAX_IMAGES + 2 || zip.len() < 2 {
        return Err(failed());
    }
    let bytes = read_member(
        zip.by_name("manifest.json").map_err(|_| failed())?,
        MAX_JSON,
    )?;
    let manifest: Manifest = serde_json::from_value(strict_json(&bytes)?).map_err(|_| failed())?;
    if manifest.format != FORMAT
        || manifest.format_version != VERSION
        || manifest.schema != SCHEMA
        || uuid::Uuid::parse_str(&manifest.backup_id).is_err()
        || manifest.catalogue_revision < 0
        || manifest.entries.len() + 1 != zip.len()
        || !manifest.entries.contains_key("catalogue.json")
    {
        return Err(failed());
    }
    let mut seen = BTreeSet::new();
    let mut total: u64 = 0;
    let mut image_refs = BTreeSet::new();
    for i in 0..zip.len() {
        super::export::check(cancel)?;
        let entry = zip.by_index(i).map_err(|_| failed())?;
        let name = entry.name().to_string();
        if !seen.insert(name.clone())
            || entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|m| !matches!(m & 0o170000, 0 | 0o100000))
        {
            return Err(failed());
        }
        if name == "manifest.json" {
            continue;
        }
        let expected = manifest.entries.get(&name).ok_or_else(failed)?;
        let max = if name == "catalogue.json" {
            MAX_JSON
        } else {
            if !name.strip_prefix("images/").is_some_and(hash) {
                return Err(failed());
            }
            MAX_IMAGE
        };
        total = total.checked_add(expected.byte_size).ok_or_else(failed)?;
        if total > MAX_TOTAL
            || expected.byte_size > max
            || entry.size() != expected.byte_size
            || !hash(&expected.sha256)
        {
            return Err(failed());
        }
        let bytes = read_member(entry, max)?;
        if payload(&bytes) != *expected
            || (name.starts_with("images/") && name[7..] != expected.sha256)
        {
            return Err(failed());
        }
        if name == "catalogue.json" {
            let value = strict_json(&bytes)?;
            document(&value)?;
            if value["originCatalogueId"] != manifest.origin_catalogue_id
                || value["catalogueRevision"] != manifest.catalogue_revision
                || value["cards"].as_array().unwrap().len() != manifest.counts.cards
                || value["tags"].as_array().unwrap().len() != manifest.counts.tags
            {
                return Err(failed());
            }
            let retained = value
                .get("retainedImports")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            for document in std::iter::once(&value).chain(retained) {
                for key in ["corrections", "referenceValues"] {
                    for row in document[key].as_array().unwrap() {
                        if let Some(sha) = row["imageSha256"].as_str() {
                            image_refs.insert(format!("images/{sha}"));
                        }
                    }
                }
            }
        }
    }
    let actual: BTreeSet<_> = manifest
        .entries
        .keys()
        .filter(|k| k.starts_with("images/"))
        .cloned()
        .collect();
    if actual != image_refs || actual.len() != manifest.counts.images {
        return Err(failed());
    }
    Ok(manifest)
}

// serde_json::Value normally accepts duplicate object keys. Portable inputs
// reject them at every depth rather than silently retaining the last value.
pub(super) fn strict_json(bytes: &[u8]) -> Result<Value> {
    use serde::{
        de::{self, MapAccess, SeqAccess, Visitor},
        Deserialize, Deserializer,
    };
    struct Unique(Value);
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D: Deserializer<'de>>(
            deserializer: D,
        ) -> std::result::Result<Self, D::Error> {
            struct JsonVisitor;
            impl<'de> Visitor<'de> for JsonVisitor {
                type Value = Unique;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("unique JSON object keys")
                }
                fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Bool(v)))
                }
                fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Unique, E> {
                    Ok(Unique(v.into()))
                }
                fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Unique, E> {
                    Ok(Unique(v.into()))
                }
                fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Unique, E> {
                    serde_json::Number::from_f64(v)
                        .map(|n| Unique(Value::Number(n)))
                        .ok_or_else(|| E::custom("invalid number"))
                }
                fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::String(v.into())))
                }
                fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::String(v)))
                }
                fn visit_unit<E: de::Error>(self) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
                fn visit_none<E: de::Error>(self) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
                fn visit_seq<A: SeqAccess<'de>>(
                    self,
                    mut seq: A,
                ) -> std::result::Result<Unique, A::Error> {
                    let mut out = Vec::new();
                    while let Some(Unique(v)) = seq.next_element()? {
                        out.push(v);
                    }
                    Ok(Unique(Value::Array(out)))
                }
                fn visit_map<A: MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> std::result::Result<Unique, A::Error> {
                    let mut out = serde_json::Map::new();
                    while let Some(key) = map.next_key::<String>()? {
                        if out.contains_key(&key) {
                            return Err(de::Error::custom("duplicate key"));
                        }
                        let Unique(v) = map.next_value()?;
                        out.insert(key, v);
                    }
                    Ok(Unique(Value::Object(out)))
                }
            }
            deserializer.deserialize_any(JsonVisitor)
        }
    }
    let Unique(value) = serde_json::from_slice(bytes).map_err(|_| failed())?;
    depth(&value, 0)?;
    Ok(value)
}
