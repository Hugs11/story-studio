//! Validated official UUID index. Unknown properties are ignored.
use super::*;
use std::collections::BTreeMap;
pub(super) const PROJECTION_VERSION: u32 = 4;
pub type Index = BTreeMap<String, Value>;
pub fn parse(bytes: &[u8]) -> Result<Index> {
    if bytes.len() > MAX_BYTES {
        return Err(message(codes::CATALOG_LUNII_TOO_LARGE));
    }
    let root: Value =
        serde_json::from_slice(bytes).map_err(|_| message(codes::CATALOG_LUNII_INVALID))?;
    // Read authors directly from the input: Value's sorted maps would reorder
    // the keyed person objects returned by Lunii.
    let authors = ordered_authors(bytes, root.get("response").is_some());
    let root = root
        .get("response")
        .unwrap_or(&root)
        .as_object()
        .ok_or_else(|| message(codes::CATALOG_LUNII_INVALID))?;
    if root.is_empty() || root.len() > 20000 {
        return Err(message(codes::CATALOG_LUNII_INVALID));
    }
    let mut index = Index::new();
    for pack in root.values() {
        let Some(uuid) = pack["uuid"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
        else {
            continue;
        };
        let Some(infos) = pack["localized_infos"].as_object() else {
            continue;
        };
        let mut locales = serde_json::Map::new();
        for (locale, info) in infos {
            if locale.len() > 32 || !info.is_object() {
                continue;
            }
            let mut out = serde_json::Map::new();
            for field in ["title", "subtitle", "description"] {
                if let Some(text) = info[field].as_str().map(str::trim).filter(|s| {
                    !s.is_empty()
                        && s.chars().count() <= if field == "description" { 20000 } else { 2000 }
                }) {
                    out.insert(field.into(), json!(text));
                }
            }
            if let Some(path) = info["image"]["image_url"]
                .as_str()
                .filter(|p| image_path_valid(p))
            {
                out.insert("imagePath".into(), json!(path));
            }
            if !out.is_empty() {
                locales.insert(locale.clone(), Value::Object(out));
            }
        }
        if locales.is_empty() {
            continue;
        }
        let keywords: Vec<_> = match &pack["keywords"] {
            Value::String(s) => s
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= 200)
                .take(100)
                .map(str::to_owned)
                .collect(),
            Value::Array(a) => a
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= 200)
                .take(100)
                .map(str::to_owned)
                .collect(),
            _ => vec![],
        };
        let age = pack["age_min"].as_u64().filter(|n| *n <= 18);
        let mut data = json!({"localized_infos":locales,"ageMin":age,"keywords":keywords,"projectionVersion":PROJECTION_VERSION});
        if let Some(language) = content_language(&pack["locales_available"]) {
            data["language"] = json!(language);
        }
        if let Some(author) = authors.get(&uuid.to_string()) {
            data["author"] = json!(author);
        }
        if let std::collections::btree_map::Entry::Vacant(entry) = index.entry(uuid.to_string()) {
            entry.insert(data);
        } else {
            log::warn!(
                "Official metadata duplicate UUID ignored: {}",
                codes::CATALOG_LUNII_INVALID
            );
        }
    }
    if index.is_empty() {
        return Err(message(codes::CATALOG_LUNII_INVALID));
    }
    Ok(index)
}
pub fn localized(pack: &Value, locale: &str) -> Option<(String, Value)> {
    let infos: serde_json::Map<String, Value> = pack["localized_infos"]
        .as_object()?
        .iter()
        .filter(|(_, value)| value.is_object())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let preferred: &[&str] = match locale.split(['-', '_']).next().unwrap_or("en") {
        "en" => &["en_GB", "en_US"],
        "it" => &["it_IT"],
        "fr" => &["fr_FR"],
        _ => &["en_GB", "en_US"],
    };
    let exact = locale.replace('-', "_");
    let (key, value) = infos
        .get_key_value(&exact)
        .or_else(|| preferred.iter().find_map(|key| infos.get_key_value(*key)))
        .or_else(|| {
            infos
                .iter()
                .find(|(key, _)| key.split(['-', '_']).next() == locale.split(['-', '_']).next())
        })
        .or_else(|| (infos.len() == 1).then(|| infos.iter().next().unwrap()))
        .or_else(|| infos.get_key_value("en_GB"))
        .or_else(|| infos.get_key_value("en_US"))
        .or_else(|| infos.iter().find(|(key, _)| key.starts_with("en")))
        .or_else(|| infos.get_key_value("fr_FR"))
        .or_else(|| infos.iter().find(|(key, _)| key.starts_with("fr")))
        .or_else(|| infos.iter().next())?;
    let mut values = value.as_object()?.clone();
    values.remove("imagePath");
    for field in ["ageMin", "keywords", "author", "language"] {
        if !pack[field].is_null() && pack[field] != json!([]) {
            values.insert(field.into(), pack[field].clone());
        }
    }
    Some((key.clone(), Value::Object(values)))
}

// Content language uses the catalogue's short lowercase code, independently of
// the localized metadata slot. Lunii publishes a locale map (`{"fr_FR": true}`);
// a list of locale strings is also accepted. Only locales marked `true` count;
// ambiguous or malformed values carry no language.
fn content_language(value: &Value) -> Option<&str> {
    let locales: Vec<&str> = match value {
        Value::Object(map) => {
            let mut locales = Vec::new();
            for (locale, available) in map {
                match available {
                    Value::Bool(true) => locales.push(locale.as_str()),
                    Value::Bool(false) => {}
                    _ => return None,
                }
            }
            locales
        }
        Value::Array(items) => items
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    let [locale] = locales[..] else {
        return None;
    };
    let mut parts = locale.split('_');
    let language = parts.next()?;
    if !(2..=3).contains(&language.len()) || !language.bytes().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    if let Some(region) = parts.next() {
        if region.len() != 2 || !region.bytes().all(|c| c.is_ascii_uppercase()) {
            return None;
        }
    }
    parts.next().is_none().then_some(language)
}

pub(crate) fn image_path_valid(p: &str) -> bool {
    p.starts_with("/public/images/")
        && !p.contains(['\\', '?', '#', '%'])
        && !p.chars().any(char::is_control)
        && !p.split('/').any(|s| s == "..")
        && p.len() <= 2048
}

// Accept lists of names/person objects and the actual ID-keyed person map.
// Malformed elements are ignored without rejecting the pack.
#[derive(Default)]
struct Authors(Vec<String>);
impl<'de> serde::Deserialize<'de> for Authors {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Authors;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("authors")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Authors, A::Error> {
                let mut names = Vec::new();
                while let Some(v) = a.next_element::<Value>()? {
                    push_name(&mut names, v.as_str().or_else(|| v["name"].as_str()));
                }
                Ok(Authors(names))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Authors, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = a.next_entry::<String, Value>()? {
                    entries.push(entry);
                }
                let mut names = Vec::new();
                // A single person object: only its own name, never a nested one.
                if let Some((_, name)) = entries.iter().find(|(key, _)| key == "name") {
                    push_name(&mut names, name.as_str());
                } else {
                    for (_, person) in &entries {
                        push_name(&mut names, person.get("name").and_then(Value::as_str));
                    }
                }
                Ok(Authors(names))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Authors, E> {
                Ok(Authors::default())
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> std::result::Result<Authors, E> {
                Ok(Authors::default())
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> std::result::Result<Authors, E> {
                Ok(Authors::default())
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> std::result::Result<Authors, E> {
                Ok(Authors::default())
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> std::result::Result<Authors, E> {
                Ok(Authors::default())
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> std::result::Result<Authors, E> {
                Ok(Authors::default())
            }
        }
        d.deserialize_any(Visitor)
    }
}
fn push_name(names: &mut Vec<String>, name: Option<&str>) {
    if let Some(name) = name
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 2000)
    {
        names.push(name.to_owned());
    }
}
fn ordered_authors(bytes: &[u8], wrapped: bool) -> BTreeMap<String, String> {
    #[derive(serde::Deserialize)]
    struct Pack {
        #[serde(default)]
        uuid: Value,
        #[serde(default)]
        authors: Authors,
    }
    #[derive(serde::Deserialize)]
    struct Wrapper {
        response: BTreeMap<String, Box<serde_json::value::RawValue>>,
    }
    let packs = if wrapped {
        serde_json::from_slice::<Wrapper>(bytes).map(|w| w.response)
    } else {
        serde_json::from_slice::<BTreeMap<String, Box<serde_json::value::RawValue>>>(bytes)
    };
    packs
        .unwrap_or_default()
        .into_values()
        .filter_map(|raw| {
            let p: Pack = serde_json::from_str(raw.get()).ok()?;
            let uuid = uuid::Uuid::parse_str(p.uuid.as_str()?).ok()?;
            let author = p.authors.0.join(", ");
            (!author.is_empty() && author.chars().count() <= 2000)
                .then(|| (uuid.to_string(), author))
        })
        .fold(BTreeMap::new(), |mut authors, (uuid, name)| {
            authors.entry(uuid).or_insert(name);
            authors
        })
}
