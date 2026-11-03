//! Pure field/language precedence. No disk access and no UI-language inference.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const FIELDS: &[&str] = &[
    "title",
    "subtitle",
    "description",
    "versionDeclared",
    "cover",
    "ageMin",
    "ageMax",
    "language",
    "author",
    "producer",
    "bonus",
    "keywords",
    "durationSeconds",
    "storyCount",
];
pub type Key = (String, String);
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Correction {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}
pub type References = BTreeMap<Key, (Value, String)>;
pub type Corrections = BTreeMap<Key, Correction>;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub field: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub language: String,
    pub effective: Value,
    pub correction: Correction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub invalid: Vec<Value>,
}
pub struct Resolution {
    pub fields: Vec<Field>,
    pub values: Map<String, Value>,
    pub corrections: BTreeMap<String, String>,
    pub age_from_name: Option<u8>,
    pub age_conflict: bool,
    pub title_conflict: bool,
    /// Provenance of the observed or saved file cover reference, kept for the
    /// thumbnail supplier order (see `card::cover_exemplars_from`).
    pub cover_provenance: Option<String>,
}
pub fn resolve_fields(
    reference: References,
    corrections: Corrections,
    names: &[String],
) -> Resolution {
    resolve_with_lunii(reference, corrections, names, Map::new(), None)
}
pub fn resolve_with_lunii(
    reference: References,
    corrections: Corrections,
    names: &[String],
    lunii: Map<String, Value>,
    locale: Option<String>,
) -> Resolution {
    let explicit = reference
        .keys()
        .any(|(f, _)| matches!(f.as_str(), "ageMin" | "ageMax"));
    let explicit = explicit || lunii.contains_key("ageMin");
    let titles: Vec<_> = names
        .iter()
        .map(|n| super::super::lunii_db::clean(n))
        .collect();
    let title_conflict = titles.iter().collect::<BTreeSet<_>>().len() > 1;
    let protected = corrections.iter().any(|((f, _), c)| {
        matches!(f.as_str(), "ageMin" | "ageMax")
            && matches!(c.state.as_str(), "defined" | "cleared")
    });
    let candidates: Vec<_> = names
        .iter()
        .filter_map(|n| {
            super::super::age_prefix::extract(n).map(|age| json!({"filename":n,"value":age}))
        })
        .collect();
    let ages = super::super::age_prefix::candidates(names.iter().map(String::as_str));
    let eligible = !explicit && !protected;
    let ranges: BTreeSet<_> = names
        .iter()
        .filter_map(|name| super::super::age_prefix::extract_bounds(name))
        .collect();
    let age_conflict = eligible && ranges.len() > 1;
    let max_from_name = if eligible && ranges.len() == 1 {
        ranges.first().and_then(|(_, max)| *max)
    } else {
        None
    };
    let age_from_name = if eligible && ages.len() == 1 && !age_conflict {
        ages.first().copied()
    } else {
        None
    };
    let keys: BTreeSet<Key> = FIELDS
        .iter()
        .map(|f| (f.to_string(), String::new()))
        .chain(reference.keys().cloned())
        .chain(corrections.keys().cloned())
        .collect();
    let mut fields = Vec::new();
    let mut states = BTreeMap::new();
    for (field, language) in keys {
        let key = (field.clone(), language.clone());
        let correction = corrections
            .get(&key)
            .filter(|c| matches!(c.state.as_str(), "defined" | "cleared"))
            .or_else(|| {
                language
                    .is_empty()
                    .then(|| {
                        corrections
                            .iter()
                            .find(|((name, _), c)| {
                                name == &field && matches!(c.state.as_str(), "defined" | "cleared")
                            })
                            .map(|(_, c)| c)
                    })
                    .flatten()
            })
            .or_else(|| corrections.get(&key))
            .cloned()
            .unwrap_or(Correction {
                state: "none".into(),
                value: None,
            });
        let reference_value = reference
            .get(&key)
            .map(|(value, p)| json!({"value":value,"provenanceId":p}));
        let (value, origin) = match correction.state.as_str() {
            "defined" => (
                correction.value.clone().unwrap_or(Value::Null),
                "correction",
            ),
            "cleared" => (Value::Null, "cleared"),
            _ if language.is_empty() && lunii.contains_key(&field) => {
                (lunii[&field].clone(), "lunii")
            }
            _ => match reference.get(&key) {
                Some((v, _)) => (v.clone(), "reference"),
                None if field == "title"
                    && language.is_empty()
                    && !titles.is_empty()
                    && !reference.keys().any(|(f, _)| f == &field) =>
                {
                    (json!(titles[0]), "filename")
                }
                None => (Value::Null, "none"),
            },
        };
        if matches!(correction.state.as_str(), "defined" | "cleared") {
            states
                .entry(field.clone())
                .or_insert(correction.state.clone());
        }
        let filename_value = if field == "ageMin" {
            age_from_name
        } else {
            max_from_name
        };
        let age_field =
            matches!(field.as_str(), "ageMin" | "ageMax") && language.is_empty() && eligible;
        let field_candidates = if field == "ageMax" {
            names
                .iter()
                .filter_map(|name| {
                    super::super::age_prefix::extract_bounds(name)?
                        .1
                        .map(|v| json!({"filename":name,"value":v}))
                })
                .collect::<Vec<_>>()
        } else {
            candidates.clone()
        };
        let mut derived = if age_field && !field_candidates.is_empty() {
            Some(
                json!({"value":filename_value,"origin":"filename","filename":field_candidates[0]["filename"],"conflict":if age_conflict{field_candidates.clone()}else{vec![]}}),
            )
        } else {
            None
        };
        if field == "title" && !titles.is_empty() {
            derived = Some(
                json!({"value":titles[0],"origin":"filename","filename":names[0],"conflict":if title_conflict {names.to_vec()} else {vec![]}}),
            );
        }
        let effective = if age_field && filename_value.is_some() {
            json!({"value":filename_value,"origin":"filename"})
        } else {
            json!({"value":value,"origin":origin,"language":if origin=="lunii" {locale.clone()} else {None},"provenanceId":if origin=="reference" {reference.get(&key).map(|(_, p)|p)} else {None}})
        };
        fields.push(Field {
            field,
            language,
            effective,
            correction,
            reference_value,
            derived,
            invalid: vec![],
        });
    }
    // Legacy list projection: personal corrections first (unqualified, content
    // language, stable language order), then source values in the same order.
    // Localized variants remain lossless in CardDetail; no UI-language input.
    let content_language = fields
        .iter()
        .find(|f| f.field == "language" && f.language.is_empty())
        .and_then(|f| f.effective["value"].as_str());
    let mut values = Map::new();
    for name in FIELDS {
        let candidates: Vec<_> = fields.iter().filter(|f| f.field == *name).collect();
        let personal = |f: &&Field| matches!(f.correction.state.as_str(), "defined" | "cleared");
        let selected = candidates
            .iter()
            .find(|f| f.language.is_empty() && personal(f))
            .or_else(|| {
                candidates
                    .iter()
                    .find(|f| Some(f.language.as_str()) == content_language && personal(f))
            })
            .or_else(|| candidates.iter().find(|f| personal(f)))
            .or_else(|| {
                candidates
                    .iter()
                    .find(|f| f.language.is_empty() && f.effective["origin"] != "none")
            })
            .or_else(|| {
                candidates.iter().find(|f| {
                    Some(f.language.as_str()) == content_language && f.effective["origin"] != "none"
                })
            })
            .or_else(|| candidates.iter().find(|f| f.effective["origin"] != "none"));
        if let Some(f) = selected {
            if !(f.effective["value"].is_null()
                || *name == "title" && f.effective["origin"] == "filename")
            {
                values.insert(name.to_string(), f.effective["value"].clone());
            }
        }
    }
    Resolution {
        fields,
        values,
        corrections: states,
        age_from_name,
        age_conflict,
        title_conflict,
        cover_provenance: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn c(f: &str, l: &str, state: &str, v: Value) -> Corrections {
        BTreeMap::from([(
            (f.into(), l.into()),
            Correction {
                state: state.into(),
                value: (!v.is_null()).then_some(v),
            },
        )])
    }
    #[test]
    fn precedence_clear_source_and_equal_correction() {
        let reference =
            BTreeMap::from([(("title".into(), "".into()), (json!("Source"), "p".into()))]);
        let defined = resolve_fields(
            reference.clone(),
            c("title", "", "defined", json!("Source")),
            &[],
        );
        assert_eq!(defined.values["title"], "Source");
        assert_eq!(defined.corrections["title"], "defined");
        assert!(!resolve_fields(
            reference.clone(),
            c("title", "", "cleared", Value::Null),
            &[]
        )
        .values
        .contains_key("title"));
        assert_eq!(
            resolve_fields(reference, c("title", "", "source", Value::Null), &[]).values["title"],
            "Source"
        );
    }
    #[test]
    fn prefixes_conflict_rename_partial_and_clear() {
        let names = vec!["3+Titre.zip".into(), "7+Titre.mbah".into()];
        assert!(resolve_fields(References::new(), Corrections::new(), &names).age_conflict);
        for state in ["defined", "cleared"] {
            let r = resolve_fields(References::new(), c("ageMax", "", state, json!(5)), &names);
            assert!(!r.values.contains_key("ageMin"));
            assert!(!r.age_conflict);
        }
        assert_eq!(
            resolve_fields(
                References::new(),
                Corrections::new(),
                &["8+Titre.zip".into()]
            )
            .age_from_name,
            Some(8)
        );
    }
    #[test]
    fn lunii_precedence_and_empty_source_fallback_are_unchanged() {
        for sources in [
            References::new(),
            BTreeMap::from([(
                ("description".into(), "".into()),
                (json!("Sibling"), "observed:sibling".into()),
            )]),
        ] {
            let r = resolve_with_lunii(
                sources,
                Corrections::new(),
                &[],
                Map::from_iter([("description".into(), json!("Lunii"))]),
                Some("fr".into()),
            );
            assert_eq!(r.values["description"], "Lunii");
            assert_eq!(
                r.fields
                    .iter()
                    .find(|f| f.field == "description")
                    .unwrap()
                    .effective["origin"],
                "lunii"
            );
        }
    }
    #[test]
    fn localized_values_never_overwrite_each_other() {
        let refs = BTreeMap::from([(
            ("description".into(), "it".into()),
            (json!("Italiano"), "p".into()),
        )]);
        let r = resolve_fields(
            refs,
            c("description", "fr", "defined", json!("Français")),
            &[],
        );
        assert_eq!(
            r.fields
                .iter()
                .find(|f| f.language == "it")
                .unwrap()
                .effective["value"],
            "Italiano"
        );
        assert_eq!(
            r.fields
                .iter()
                .find(|f| f.language == "fr")
                .unwrap()
                .effective["value"],
            "Français"
        );
        assert_eq!(r.corrections["description"], "defined");
    }
}
