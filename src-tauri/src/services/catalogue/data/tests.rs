use super::*;
use crate::services::catalogue::{analyze, grouping::Scanned, store::Store};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Instant};
struct Fixture {
    root: PathBuf,
    store: Store,
    source: String,
    keep_root: bool,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("catalogue-data-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        let root: std::path::PathBuf =
            crate::support::paths::path_for_frontend(root.canonicalize().unwrap()).into();
        let store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
        store.add_source(&root.join("source"), 0, false).unwrap();
        let source = store.list_sources().unwrap().items[0].id.clone();
        Self {
            root,
            store,
            source,
            keep_root: false,
        }
    }
    fn item(&self, name: &str, title: Option<&str>, age: Option<u8>, modified: i64) -> Scanned {
        let path = self.root.join("source").join(name);
        let raw = json!({"uuid":"12345678-1234-4234-8234-123456789abc","title":title});
        std::fs::write(&path, raw.to_string()).unwrap();
        let mut observation = analyze::Observation::new("project");
        observation.identity = Some(analyze::Identity {
            raw: raw["uuid"].clone(),
            value: raw["uuid"].as_str().map(String::from),
            source: "/uuid".into(),
            reliable: true,
        });
        observation.title = title.map(String::from);
        observation.age_min = age;
        observation
            .fields
            .insert("/title".into(), analyze::observed(&raw, "/title", "string"));
        Scanned {
            source_id: self.source.clone(),
            path: path.to_string_lossy().into(),
            path_key: path.to_string_lossy().as_bytes().to_vec(),
            token: format!("{modified}:{title:?}:{age:?}"),
            modified,
            size: 20,
            file_id: None,
            save_prestate: None,
            observation,
        }
    }
    fn publish(&self, items: &[Scanned]) -> String {
        let originals: Vec<_> = items
            .iter()
            .map(|i| std::fs::read(&i.path).unwrap())
            .collect();
        self.store
            .publish_scan(
                &uuid::Uuid::new_v4().to_string(),
                1,
                items,
                &[(self.source.clone(), true)],
            )
            .unwrap();
        for (item, bytes) in items.iter().zip(originals) {
            assert_eq!(
                std::fs::read(&item.path).unwrap(),
                bytes,
                "source bytes unchanged"
            );
        }
        self.store.query_entries(200, None, true).unwrap().items[0]["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn pack_fingerprints(&self) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        std::fs::read_dir(self.root.join("source"))
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let bytes = std::fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect()
    }
    fn mutate(&self, id: &str, changes: Value) -> Value {
        let card = self.store.get_card(id).unwrap();
        let mutation = json!({"kind":"setMetadataBatch","requestKey":uuid::Uuid::new_v4().to_string(),"ficheId":id,"expectedFicheRevision":card["ficheRevision"],"changes":changes});
        let before = self.pack_fingerprints();
        let outcome = self
            .store
            .mutate(
                serde_json::from_value(mutation).unwrap(),
                card["catalogueRevision"].as_i64().unwrap(),
            )
            .unwrap();
        assert_eq!(
            self.pack_fingerprints(),
            before,
            "pack bytes unchanged by metadata mutation"
        );
        outcome
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.keep_root {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
fn field<'a>(card: &'a Value, name: &str) -> &'a Value {
    card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["field"] == name && f.get("language").is_none())
        .unwrap()
}

#[test]
fn rescan_purge_unavailable_return_preserve_personal_data_and_pack_bytes() {
    let f = Fixture::new();
    let mut item = f.item("3+Titre.mbah", Some("Source"), None, 1);
    let id = f.publish(&[item.clone()]);
    f.mutate(&id,json!([{"field":"title","state":"defined","value":"Perso"},{"field":"ageMin","state":"cleared"},{"field":"ageMax","state":"source"}]));
    item.observation.title = Some("Changed".into());
    item.modified = 2;
    item.token = "next".into();
    f.publish(&[item.clone()]);
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(field(&card, "title")["effective"]["value"], "Perso");
    assert_eq!(field(&card, "ageMin")["effective"]["origin"], "cleared");
    f.store
        .write(|tx| {
            tx.execute("DELETE FROM cache.extracted_value", []).unwrap();
            tx.execute("DELETE FROM cache.coverage", []).unwrap();
            tx.execute("DELETE FROM cache.observation", []).unwrap();
            Ok(())
        })
        .unwrap();
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(field(&card, "title")["effective"]["value"], "Perso");
    assert_eq!(card["exemplars"][0]["fields"], Value::Null);
    assert_eq!(card["exemplars"][0]["stale"], true);
    assert_ne!(card["reference"]["state"], "available");
    f.publish(&[item]);
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(card["reference"]["state"], "available");
    assert_eq!(field(&card, "title")["effective"]["value"], "Perso");
}
#[test]
fn stable_reference_replacement_removes_absent_fields_and_retains_corrections() {
    let f = Fixture::new();
    let old = f.item("old.mbah", Some("Old"), Some(3), 1);
    let recent = f.item("recent.mbah", Some("Recent"), None, 2);
    let id = f.publish(&[old.clone(), recent.clone()]);
    let first = f.store.get_card(&id).unwrap();
    assert_eq!(field(&first, "title")["effective"]["value"], "Recent");
    let newest = f.item("newest.mbah", Some("Newest"), Some(8), 3);
    f.publish(&[newest]);
    assert_eq!(
        f.store.get_card(&id).unwrap()["reference"],
        first["reference"]
    );
    f.mutate(
        &id,
        json!([{"field":"description","language":"fr","state":"defined","value":"Personnelle"}]),
    );
    let card = f.store.get_card(&id).unwrap();
    let exemplar = card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"].as_str().unwrap().ends_with("old.mbah"))
        .unwrap()["id"]
        .clone();
    let mutation = json!({"kind":"setReferenceExemplar","requestKey":"reference","ficheId":id,"expectedFicheRevision":card["ficheRevision"],"exemplarId":exemplar});
    f.store
        .mutate(
            serde_json::from_value(mutation).unwrap(),
            card["catalogueRevision"].as_i64().unwrap(),
        )
        .unwrap();
    let after = f.store.get_card(&id).unwrap();
    assert_eq!(field(&after, "ageMin")["effective"]["value"], 3);
    assert!(after["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["language"] == "fr" && v["effective"]["value"] == "Personnelle"));
    let back = json!({"kind":"setReferenceExemplar","requestKey":"back","ficheId":id,"expectedFicheRevision":after["ficheRevision"],"exemplarId":first["reference"]["exemplarId"]});
    f.store
        .mutate(
            serde_json::from_value(back).unwrap(),
            after["catalogueRevision"].as_i64().unwrap(),
        )
        .unwrap();
    // The selected reference has no age: the newest available sibling now supplies it.
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"],
        8
    );
}
#[test]
fn atomic_validation_revisions_replay_and_journal() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("card.mbah", Some("Source"), None, 1)]);
    let card = f.store.get_card(&id).unwrap();
    let value = json!({"kind":"setMetadata","requestKey":"same","ficheId":id,"expectedFicheRevision":card["ficheRevision"],"field":"title","state":"defined","value":"Personal"});
    let mutation = || serde_json::from_value(value.clone()).unwrap();
    let revision = card["catalogueRevision"].as_i64().unwrap();
    let out = f.store.mutate(mutation(), revision).unwrap();
    assert_eq!(f.store.mutate(mutation(), revision).unwrap(), out);
    assert!(f.store.mutate(serde_json::from_value(json!({"kind":"setMetadataBatch","requestKey":"conflict","ficheId":id,"expectedFicheRevision":0,"changes":[{"field":"title","state":"cleared"}]})).unwrap(),revision).is_err());
    let current = f.store.get_card(&id).unwrap();
    for changes in [
        json!([{"field":"ageMin","state":"defined","value":-1},{"field":"ageMax","state":"source"}]),
        json!([{"field":"ageMin","state":"defined","value":8},{"field":"ageMax","state":"defined","value":3}]),
        json!([{"field":"uuid","state":"defined","value":"x"}]),
    ] {
        let m = json!({"kind":"setMetadataBatch","requestKey":uuid::Uuid::new_v4().to_string(),"ficheId":id,"expectedFicheRevision":current["ficheRevision"],"changes":changes});
        assert!(f
            .store
            .mutate(
                serde_json::from_value(m).unwrap(),
                current["catalogueRevision"].as_i64().unwrap()
            )
            .is_err());
        assert_eq!(f.store.get_card(&id).unwrap(), current);
    }
    f.store
        .read(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM operation_change", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            let (before, after): (String, String) = c.query_row(
                "SELECT before_json,after_json FROM operation_change",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert!(before.contains("Source"));
            assert!(after.contains("Personal"));
            Ok(())
        })
        .unwrap();
}
#[test]
fn images_validation_publication_rollback_orphan_and_cleanup() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("card.mbah", Some("Source"), None, 1)]);
    let path = f.root.join("cover.png");
    image::RgbImage::new(2000, 100).save(&path).unwrap();
    let stage = f.store.stage_cover(&path).unwrap();
    assert_eq!(stage["width"], 1600);
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]),
    );
    let sha = stage["sha256"].as_str().unwrap();
    assert!(f.store.images_root().join(sha).is_file());
    assert_eq!(
        f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
        "ready"
    );
    f.store
        .read(|c| {
            let file: String =
                c.query_row("SELECT relative_path FROM image_asset", [], |r| r.get(0))?;
            assert!(f.root.join("data/catalogue").join(file).is_file());
            Ok(())
        })
        .unwrap();
    std::fs::write(&path, b"invalid").unwrap();
    assert!(f.store.stage_cover(&path).is_err());
    let oversized = f.root.join("huge");
    std::fs::File::create(&oversized)
        .unwrap()
        .set_len(10 * 1024 * 1024 + 1)
        .unwrap();
    assert!(f.store.stage_cover(&oversized).is_err());
    image::RgbImage::new(4001, 4000).save(&path).unwrap();
    assert!(f.store.stage_cover(&path).is_err());
    image::RgbImage::from_pixel(4, 4, image::Rgb([200, 0, 0]))
        .save(&path)
        .unwrap();
    let orphan = f.store.stage_cover(&path).unwrap();
    let current = f.store.get_card(&id).unwrap();
    let bad = json!({"kind":"setMetadataBatch","requestKey":"rollback","ficheId":id,"expectedFicheRevision":current["ficheRevision"],"changes":[{"field":"cover","state":"defined","coverStagingId":orphan["coverStagingId"]},{"field":"ageMin","state":"defined","value":8},{"field":"ageMax","state":"defined","value":2}]});
    assert!(f
        .store
        .mutate(
            serde_json::from_value(bad).unwrap(),
            current["catalogueRevision"].as_i64().unwrap()
        )
        .is_err());
    let orphan_path = f
        .store
        .images_root()
        .join(orphan["sha256"].as_str().unwrap());
    assert!(orphan_path.exists());
    f.store.clean_images().unwrap();
    assert!(!orphan_path.exists());
    assert!(f.store.images_root().join(sha).exists());
    assert_eq!(
        std::fs::read_dir(f.store.staging_root()).unwrap().count(),
        0
    );
}
#[test]
fn card_cost_with_ten_thousand_synthetic_cards_and_contract() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("card.mbah", Some("Source"), None, 1)]);
    f.store
        .write(|tx| {
            for i in 0..9999 {
                tx.execute(
                    "INSERT INTO fiche VALUES (?1,0,0,0)",
                    [format!("synthetic-{i}")],
                )
                .unwrap();
            }
            Ok(())
        })
        .unwrap();
    let start = Instant::now();
    let card = f.store.get_card(&id).unwrap();
    let read = start.elapsed();
    let start = Instant::now();
    let out = f.mutate(
        &id,
        json!([{"field":"language","state":"defined","value":"fr"}]),
    );
    let mutation = start.elapsed();
    eprintln!("04a 10000 cards: getCard={read:?}, mutate={mutation:?}");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/card-detail.json"
    ))
    .unwrap();
    for (key, value) in fixture.as_object().unwrap() {
        assert_eq!(
            std::mem::discriminant(&card[key]),
            std::mem::discriminant(value),
            "{key}"
        );
    }
    assert_eq!(out["affectedCardIds"], json!([id]));
    assert_eq!(
        card["fields"].as_array().unwrap().len(),
        resolver::FIELDS.len()
    );
}

#[test]
fn reference_missing_returns_without_switch_and_replaced_identity_leaves_old_values() {
    let f = Fixture::new();
    let mut item = f.item("reference.mbah", Some("Original"), None, 2);
    let other = f.item("other.mbah", Some("Other"), None, 1);
    let id = f.publish(&[other, item.clone()]);
    let before = f.store.get_card(&id).unwrap();
    let reference = before["reference"]["exemplarId"].as_str().unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE cache.observation SET state='missing' WHERE exemplar_id=?1",
                [reference],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let missing = f.store.get_card(&id).unwrap();
    assert_eq!(missing["reference"]["state"], "unavailable");
    assert_eq!(missing["reference"]["exemplarId"], reference);
    assert_eq!(field(&missing, "title")["effective"]["value"], "Original");
    item.token = "return".into();
    f.publish(&[item.clone()]);
    assert_eq!(
        f.store.get_card(&id).unwrap()["reference"]["state"],
        "available"
    );
    item.token = "replacement".into();
    item.observation.identity.as_mut().unwrap().value =
        Some("98765432-1234-4234-8234-123456789abc".into());
    item.observation.title = Some("New identity".into());
    f.publish(&[item]);
    let old = f.store.get_card(&id).unwrap();
    assert_eq!(old["reference"]["state"], "unavailable");
    assert_eq!(field(&old, "title")["effective"]["value"], "Original");
}
#[test]
fn cached_candidates_keep_absent_null_empty_invalid_and_localized_references() {
    let f = Fixture::new();
    let mut item = f.item("3+reference.mbah", None, None, 1);
    let raw = json!({"packMetadata":{"description":null,"author":"","producer":123}});
    for (name, kind) in [
        ("description", "string"),
        ("author", "string"),
        ("producer", "string"),
        ("bonus", "string"),
    ] {
        let pointer = format!("/packMetadata/{name}");
        item.observation
            .fields
            .insert(pointer.clone(), analyze::observed(&raw, &pointer, kind));
    }
    let id = f.publish(&[item]);
    let card = f.store.get_card(&id).unwrap();
    let fields = &card["exemplars"][0]["fields"];
    assert_eq!(fields["description"]["presence"], "null");
    assert_eq!(fields["author"]["validity"], "empty");
    assert_eq!(fields["producer"]["validity"], "invalid");
    assert_eq!(fields["bonus"]["presence"], "absent");
    assert!(!field(&card, "producer")["invalid"]
        .as_array()
        .unwrap()
        .is_empty());
    let exemplar = card["reference"]["exemplarId"].as_str().unwrap();
    f.store.write(|tx|{for lang in ["fr","it"] {tx.execute("INSERT INTO cache.extracted_value VALUES (?1,'description',?2,'@card','present','valid',NULL,?3,'{}')",rusqlite::params![exemplar,lang,json!(lang).to_string()]).unwrap();}mutate::reference::replace_values(tx,&id,exemplar)?;Ok(())}).unwrap();
    let card = f.store.get_card(&id).unwrap();
    for lang in ["fr", "it"] {
        assert!(card["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["language"] == lang && v["effective"]["value"] == lang));
    }
    f.store.write(|tx| {
        tx.execute("UPDATE cache.extracted_value SET presence='absent',validity='unknown',value_json=NULL WHERE exemplar_id=?1 AND field='description' AND language=''", [exemplar]).unwrap();
        tx.execute("INSERT INTO cache.extracted_value VALUES (?1,'description','de','@card','present','invalid','42',NULL,'{\"reason\":\"not-text\"}')", [exemplar]).unwrap();
        Ok(())
    }).unwrap();
    let multilingual = f.store.get_card(&id).unwrap();
    let fields = &multilingual["exemplars"][0]["fields"];
    assert_eq!(fields["description"]["presence"], "absent");
    for lang in ["fr", "it"] {
        let key = json!(["description", lang]).to_string();
        assert_eq!(fields[&key]["value"], lang);
        let localized = multilingual["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["field"] == "description" && v["language"] == lang)
            .unwrap();
        assert!(
            localized.get("invalid").is_none(),
            "valid language must have no diagnostic"
        );
    }
    let key = json!(["description", "de"]).to_string();
    assert_eq!(fields[&key]["validity"], "invalid");
    let invalid = multilingual["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["field"] == "description" && v["language"] == "de")
        .unwrap();
    assert_eq!(invalid["invalid"][0]["raw"], 42);
    assert_eq!(invalid["invalid"][0]["diagnostic"]["reason"], "not-text");
    f.store
        .write(|tx| {
            tx.execute(
                "DELETE FROM cache.extracted_value WHERE exemplar_id=?1",
                [exemplar],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let current = f.store.get_card(&id).unwrap();
    let m = json!({"kind":"setReferenceExemplar","requestKey":"not-ready","ficheId":id,"expectedFicheRevision":current["ficheRevision"],"exemplarId":exemplar});
    let err = f
        .store
        .mutate(
            serde_json::from_value(m).unwrap(),
            current["catalogueRevision"].as_i64().unwrap(),
        )
        .unwrap_err();
    assert_eq!(err.code, "CATALOG_REFERENCE_NOT_READY");
    assert_eq!(f.store.get_card(&id).unwrap(), current);
}

#[test]
fn localized_correction_is_effective_in_list_and_preserves_reference_languages() {
    let f = Fixture::new();
    let mut source = f.item("card.mbah", Some("Source"), None, 1);
    source.observation.fields.insert(
        "/description".into(),
        analyze::observed(
            &json!({"description":"Base description"}),
            "/description",
            "string",
        ),
    );
    let id = f.publish(&[source]);
    f.mutate(&id,json!([{"field":"description","language":"fr","state":"defined","value":"Française"},{"field":"language","state":"defined","value":"fr"},{"field":"durationSeconds","state":"defined","value":65},{"field":"storyCount","state":"defined","value":3}]));
    let page = f.store.query_entries(200, None, true).unwrap();
    let item = &page.items[0];
    assert_eq!(item["description"], "Française");
    assert_eq!(item["language"], "fr");
    assert_eq!(item["durationSeconds"], 65);
    assert_eq!(item["storyCount"], 3);
    assert_eq!(item["corrections"]["description"], "defined");
}

#[test]
fn old_raw_cache_is_read_without_scan_and_contract_nested_fields_are_serialized() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("card.mbah", Some("Source"), None, 1)]);
    f.store
        .write(|tx| {
            tx.execute(
                "DELETE FROM cache.extracted_value WHERE candidate_key='@card'",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(card["exemplars"][0]["stale"], false);
    assert_eq!(card["exemplars"][0]["fields"]["title"]["value"], "Source");
    for key in ["exemplarId", "selectedAt", "state"] {
        assert!(card["reference"].get(key).is_some());
    }
    let title = field(&card, "title");
    assert_eq!(title["effective"]["origin"], "reference");
    assert_eq!(title["correction"]["state"], "none");
    assert!(title["referenceValue"]["provenanceId"].is_string());
    let out = f.mutate(
        &id,
        json!([{"field":"storyCount","state":"defined","value":2}]),
    );
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/mutation-outcome.json"
    ))
    .unwrap();
    assert_eq!(
        out.as_object().unwrap().keys().collect::<Vec<_>>(),
        fixture.as_object().unwrap().keys().collect::<Vec<_>>()
    );
    assert!(out["catalogueRevision"].is_i64());
    assert!(out["affectedCardIds"].is_array());
}

// 4b: all organization scenarios fingerprint the synthetic packs, not real data.
fn organize(
    f: &Fixture,
    mut mutation: Value,
) -> Result<Value, crate::support::user_message::UserMessage> {
    mutation["requestKey"] = json!(uuid::Uuid::new_v4().to_string());
    let revision = f.store.list_tags().unwrap()["revision"].as_i64().unwrap();
    let before = f.pack_fingerprints();
    let result = f
        .store
        .mutate(serde_json::from_value(mutation.clone()).unwrap(), revision);
    if let Ok(outcome) = &result {
        assert_eq!(
            &f.store
                .mutate(serde_json::from_value(mutation).unwrap(), revision)
                .unwrap(),
            outcome,
            "all variants replay before checking old revisions"
        );
    }
    assert_eq!(
        f.pack_fingerprints(),
        before,
        "organization never writes source files"
    );
    result
}
fn tag(f: &Fixture, card: &str, label: &str) -> String {
    organize(f,json!({"kind":"changeTags","ficheIds":[card],"addLabels":[label],"addTagIds":[],"removeTagIds":[]})).unwrap()["report"]["createdTagIds"][0].as_str().unwrap().into()
}
#[test]
fn organization_favorite_selection_journal_replay_conflict_and_source_lifecycle() {
    let mut f = Fixture::new();
    let item = f.item("favorite.mbah", Some("Fav"), None, 1);
    let id = f.publish(std::slice::from_ref(&item));
    f.store
        .write(|tx| {
            tx.execute("INSERT INTO fiche VALUES ('unreferenced',0,0,0)", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let before = f.pack_fingerprints();
    let card = f.store.get_card(&id).unwrap();
    let payload = json!({"kind":"setFavorite","requestKey":"favorite-selection","ficheIds":[id,"unreferenced",id],"value":true,"expectedFicheRevisions":{&id:card["ficheRevision"],"unreferenced":0}});
    let expected = card["catalogueRevision"].as_i64().unwrap();
    let outcome = f
        .store
        .mutate(serde_json::from_value(payload.clone()).unwrap(), expected)
        .unwrap();
    assert_eq!(outcome["affectedCardIds"].as_array().unwrap().len(), 2);
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(payload.clone()).unwrap(), expected)
            .unwrap(),
        outcome
    );
    f.store
        .read_snapshot(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM operation WHERE request_key='favorite-selection'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM operation_change WHERE entity_type='fiche'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                2
            );
            Ok(())
        })
        .unwrap();
    let mut stale = payload.clone();
    stale["requestKey"] = json!("stale");
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(stale.clone()).unwrap(), expected)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    let current = f.store.list_tags().unwrap()["revision"].as_i64().unwrap();
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(stale).unwrap(), current)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    let mut changed = payload;
    changed["value"] = json!(false);
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(changed).unwrap(), current)
            .unwrap_err()
            .code,
        "CATALOG_MUTATION_INVALID"
    );
    let t = tag(&f, &id, "Persistante");
    f.publish(std::slice::from_ref(&item));
    f.store
        .write(|tx| {
            tx.execute("DELETE FROM cache.coverage", []).unwrap();
            tx.execute("DELETE FROM cache.extracted_value", []).unwrap();
            tx.execute("DELETE FROM cache.observation", []).unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store.list_tags().unwrap()["items"][0]["countUnreferenced"],
        0
    );
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(card["favorite"], true);
    assert_eq!(card["tagIds"], json!([t]));
    f.store
        .publish_scan("unavailable-4b", 1, &[], &[(f.source.clone(), false)])
        .unwrap();
    assert_eq!(f.store.get_card(&id).unwrap()["favorite"], true);
    f.publish(&[item]);
    assert_eq!(f.store.get_card(&id).unwrap()["tagIds"], json!([t]));
    assert_eq!(f.pack_fingerprints(), before);
    // Reopen the actual databases, not just a fresh connection in the Store.
    let root = f.root.clone();
    f.keep_root = true;
    drop(f);
    let reopened = Store::open(&root.join("data"), &root.join("cache")).unwrap();
    assert_eq!(reopened.get_card(&id).unwrap()["favorite"], true);
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}
/// A background writer (scan, Lunii sync, official cover retention) bumps the
/// catalogue revision between the list read and the user's gesture. Gestures on
/// their own entities still apply.
#[test]
fn organization_entity_gestures_survive_unrelated_catalogue_revision_bump() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("bump.mbah", Some("Bump"), None, 1)]);
    let label = tag(&f, &id, "Avant");
    let card = f.store.get_card(&id).unwrap();
    let read = card["catalogueRevision"].as_i64().unwrap();
    let bump = || {
        f.store
            .write(|tx| {
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .map_err(crate::services::catalogue::store::error)?;
                Ok(())
            })
            .unwrap()
    };
    bump();
    let favorite = json!({"kind":"setFavorite","requestKey":"after-bump","ficheIds":[&id],"value":true,"expectedFicheRevisions":{&id:card["ficheRevision"]}});
    let outcome = f
        .store
        .mutate(serde_json::from_value(favorite).unwrap(), read)
        .unwrap();
    assert_eq!(outcome["catalogueRevision"], read + 2);
    assert_eq!(f.store.get_card(&id).unwrap()["favorite"], true);
    // The fiche revision still guards the card itself.
    let stale = json!({"kind":"setFavorite","requestKey":"stale-fiche","ficheIds":[&id],"value":false,"expectedFicheRevisions":{&id:card["ficheRevision"]}});
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(stale).unwrap(), read)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    bump();
    let tags = json!({"kind":"changeTags","requestKey":"tags-after-bump","ficheIds":[&id],"addLabels":["Après"],"addTagIds":[],"removeTagIds":[&label]});
    f.store
        .mutate(serde_json::from_value(tags).unwrap(), read)
        .unwrap();
}
/// A card grouped into another or forgotten after the list was read keeps no
/// favorite and no tag: the hiding does not bump its fiche revision, so the
/// visibility itself is checked, for favorites and for tags.
#[test]
fn organization_gestures_refuse_cards_hidden_after_the_list_read() {
    let f = Fixture::new();
    let target = f.publish(&[f.item("target.mbah", Some("Cible"), None, 1)]);
    let label = tag(&f, &target, "Existante");
    f.store
        .write(|tx| {
            tx.execute_batch("INSERT INTO fiche VALUES ('grouped',0,0,0); INSERT INTO fiche VALUES ('forgotten',0,0,0);")
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    let read = f.store.get_card(&target).unwrap()["catalogueRevision"]
        .as_i64()
        .unwrap();
    // Hidden after the read, without any fiche revision change.
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO fiche_grouping VALUES ('grouped',?1)",
                [&target],
            )
            .map_err(crate::services::catalogue::store::error)?;
            tx.execute("INSERT INTO fiche_forgotten VALUES ('forgotten')", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    for hidden in ["grouped", "forgotten"] {
        let favorite = json!({"kind":"setFavorite","requestKey":format!("fav-{hidden}"),"ficheIds":[hidden],"value":true,"expectedFicheRevisions":{hidden:0}});
        let tags = json!({"kind":"changeTags","requestKey":format!("tags-{hidden}"),"ficheIds":[hidden],"addLabels":["Nouvelle"],"addTagIds":[&label],"removeTagIds":[]});
        for mutation in [favorite, tags] {
            assert_eq!(
                f.store
                    .mutate(serde_json::from_value(mutation).unwrap(), read)
                    .unwrap_err()
                    .code,
                "CATALOG_REVISION_CONFLICT",
                "{hidden}"
            );
        }
        f.store
            .read_snapshot(|c| {
                assert!(
                    !c.query_row("SELECT favorite FROM fiche WHERE id=?1", [hidden], |r| r
                        .get::<_, bool>(
                        0
                    ))?
                );
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM tag_member WHERE fiche_id=?1",
                        [hidden],
                        |r| r.get::<_, i64>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .unwrap();
    }
    // The refusal is atomic: a visible card in the same selection is untouched.
    let mixed = json!({"kind":"setFavorite","requestKey":"mixed","ficheIds":[&target,"grouped"],"value":true,"expectedFicheRevisions":{&target:f.store.get_card(&target).unwrap()["ficheRevision"],"grouped":0}});
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(mixed).unwrap(), read)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    assert_eq!(f.store.get_card(&target).unwrap()["favorite"], false);
}
/// Metadata edits from the fiche or the selection guard the fiche only: a
/// background writer bumping the catalogue revision between the read and the
/// pen stroke no longer fails it, while a stale fiche revision still does.
#[test]
fn metadata_gestures_survive_unrelated_catalogue_revision_bump() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("metadata-bump.mbah", Some("Bump"), None, 1)]);
    let card = f.store.get_card(&id).unwrap();
    let read = card["catalogueRevision"].as_i64().unwrap();
    let bump = || {
        f.store
            .write(|tx| {
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .map_err(crate::services::catalogue::store::error)?;
                Ok(())
            })
            .unwrap()
    };
    let conflict = |mutation: Value| {
        f.store
            .mutate(serde_json::from_value(mutation).unwrap(), read)
            .unwrap_err()
            .code
    };
    bump();
    let single = json!({"kind":"setMetadata","requestKey":"single-after-bump","ficheId":&id,"expectedFicheRevision":card["ficheRevision"],"field":"author","state":"defined","value":"Autrice"});
    f.store
        .mutate(serde_json::from_value(single).unwrap(), read)
        .unwrap();
    assert_eq!(field_value(&f.store, &id, "author"), "Autrice");
    // The fiche revision still guards the card itself.
    let stale = json!({"kind":"setMetadata","requestKey":"single-stale","ficheId":&id,"expectedFicheRevision":card["ficheRevision"],"field":"author","state":"cleared"});
    assert_eq!(conflict(stale), "CATALOG_REVISION_CONFLICT");
    assert_eq!(field_value(&f.store, &id, "author"), "Autrice");

    bump();
    let fresh = f.store.get_card(&id).unwrap();
    let batch = json!({"kind":"setMetadataBatch","requestKey":"batch-after-bump","ficheId":&id,"expectedFicheRevision":fresh["ficheRevision"],"changes":[{"field":"producer","state":"defined","value":"Studio"}]});
    f.store
        .mutate(serde_json::from_value(batch).unwrap(), read)
        .unwrap();
    assert_eq!(field_value(&f.store, &id, "producer"), "Studio");
    let stale = json!({"kind":"setMetadataBatch","requestKey":"batch-stale","ficheId":&id,"expectedFicheRevision":fresh["ficheRevision"],"changes":[{"field":"producer","state":"cleared"}]});
    assert_eq!(conflict(stale), "CATALOG_REVISION_CONFLICT");

    bump();
    let fresh = f.store.get_card(&id).unwrap();
    let reference = json!({"kind":"setReferenceExemplar","requestKey":"reference-after-bump","ficheId":&id,"expectedFicheRevision":fresh["ficheRevision"],"exemplarId":fresh["reference"]["exemplarId"]});
    f.store
        .mutate(serde_json::from_value(reference).unwrap(), read)
        .unwrap();
    let stale = json!({"kind":"setReferenceExemplar","requestKey":"reference-stale","ficheId":&id,"expectedFicheRevision":fresh["ficheRevision"],"exemplarId":fresh["reference"]["exemplarId"]});
    assert_eq!(conflict(stale), "CATALOG_REVISION_CONFLICT");

    bump();
    let fresh = f.store.get_card(&id).unwrap();
    let bulk = json!({"kind":"bulkSetMetadata","requestKey":"bulk-after-bump","ficheIds":[&id],"changes":{"language":{"state":"defined","value":"it"}},"expectedFicheRevisions":{&id:fresh["ficheRevision"]}});
    f.store
        .mutate(serde_json::from_value(bulk).unwrap(), read)
        .unwrap();
    assert_eq!(field_value(&f.store, &id, "language"), "it");
    let stale = json!({"kind":"bulkSetMetadata","requestKey":"bulk-stale","ficheIds":[&id],"changes":{"language":{"state":"defined","value":"fr"}},"expectedFicheRevisions":{&id:fresh["ficheRevision"]}});
    assert_eq!(conflict(stale), "CATALOG_REVISION_CONFLICT");
    assert_eq!(field_value(&f.store, &id, "language"), "it");
}
/// A fiche grouped into another or forgotten after the read is hidden without
/// a fiche revision change: metadata edits on it are refused as a stale read,
/// so that the client reads the list again.
#[test]
fn metadata_gestures_refuse_cards_hidden_after_the_list_read() {
    let f = Fixture::new();
    let target = f.publish(&[f.item("metadata-target.mbah", Some("Cible"), None, 1)]);
    f.store
        .write(|tx| {
            tx.execute_batch("INSERT INTO fiche VALUES ('grouped',0,0,0); INSERT INTO fiche VALUES ('forgotten',0,0,0);")
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    let read = f.store.get_card(&target).unwrap()["catalogueRevision"]
        .as_i64()
        .unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO fiche_grouping VALUES ('grouped',?1)",
                [&target],
            )
            .map_err(crate::services::catalogue::store::error)?;
            tx.execute("INSERT INTO fiche_forgotten VALUES ('forgotten')", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    for hidden in ["grouped", "forgotten"] {
        let mutations = [
            json!({"kind":"setMetadata","requestKey":format!("single-{hidden}"),"ficheId":hidden,"expectedFicheRevision":0,"field":"author","state":"defined","value":"Perdu"}),
            json!({"kind":"setMetadataBatch","requestKey":format!("batch-{hidden}"),"ficheId":hidden,"expectedFicheRevision":0,"changes":[{"field":"bonus","state":"defined","value":"Perdu"}]}),
            json!({"kind":"setReferenceExemplar","requestKey":format!("reference-{hidden}"),"ficheId":hidden,"expectedFicheRevision":0,"exemplarId":"none"}),
            json!({"kind":"bulkSetMetadata","requestKey":format!("bulk-{hidden}"),"ficheIds":[hidden],"changes":{"language":{"state":"defined","value":"it"}},"expectedFicheRevisions":{hidden:0}}),
        ];
        for mutation in mutations {
            assert_eq!(
                f.store
                    .mutate(serde_json::from_value(mutation).unwrap(), read)
                    .unwrap_err()
                    .code,
                "CATALOG_REVISION_CONFLICT",
                "{hidden}"
            );
        }
        f.store
            .read_snapshot(|c| {
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM correction WHERE fiche_id=?1",
                        [hidden],
                        |r| r.get::<_, i64>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .unwrap();
    }
    // The refusal is atomic: a visible card in the same selection is untouched.
    let mixed = json!({"kind":"bulkSetMetadata","requestKey":"bulk-mixed","ficheIds":[&target,"grouped"],"changes":{"language":{"state":"defined","value":"it"}},"expectedFicheRevisions":{&target:f.store.get_card(&target).unwrap()["ficheRevision"],"grouped":0}});
    assert_eq!(
        f.store
            .mutate(serde_json::from_value(mixed).unwrap(), read)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    assert!(field_value(&f.store, &target, "language").is_null());
}
/// Description, language, author, producer and bonus are catalogue
/// corrections like the title: set or intentionally emptied, they survive a
/// rescan of the pack and a new reading of its reference, and no pack is
/// rewritten (checked by `Fixture::mutate`).
#[test]
fn descriptive_field_corrections_survive_rescan_and_reference_reread() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("descriptive.mbah", Some("Source"), None, 1)]);
    f.mutate(
        &id,
        json!([
            {"field":"title","state":"defined","value":"Mon titre"},
            {"field":"description","state":"defined","value":"Ligne 1\nLigne 2"},
            {"field":"language","state":"defined","value":"it"},
            {"field":"author","state":"defined","value":"Autrice"},
            {"field":"producer","state":"defined","value":"Studio"},
            {"field":"bonus","state":"defined","value":"Livret"}
        ]),
    );
    f.mutate(&id, json!([{"field":"bonus","state":"cleared"}]));
    let expected = [
        ("title", json!("Mon titre")),
        ("description", json!("Ligne 1\nLigne 2")),
        ("language", json!("it")),
        ("author", json!("Autrice")),
        ("producer", json!("Studio")),
        ("bonus", Value::Null),
    ];
    let check = |step: &str| {
        for (name, value) in &expected {
            assert_eq!(&field_value(&f.store, &id, name), value, "{step}: {name}");
        }
    };
    check("edited");
    // A rescan with a changed pack refreshes the reference, never the corrections.
    assert_eq!(
        f.publish(&[f.item("descriptive.mbah", Some("Relu"), None, 2)]),
        id
    );
    check("rescan");
    let card = f.store.get_card(&id).unwrap();
    let reread = json!({"kind":"setReferenceExemplar","requestKey":"descriptive-reread","ficheId":&id,"expectedFicheRevision":card["ficheRevision"],"exemplarId":card["reference"]["exemplarId"]});
    f.store
        .mutate(
            serde_json::from_value(reread).unwrap(),
            card["catalogueRevision"].as_i64().unwrap(),
        )
        .unwrap();
    check("reference");
    // The original value stays available beneath the correction.
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "title")["referenceValue"]["value"],
        "Relu"
    );
}
#[test]
fn organization_tags_collision_atomicity_reuse_and_last_use_removal() {
    let f = Fixture::new();
    let item = f.item("tags.mbah", None, None, 1);
    let a = f.publish(&[item]);
    f.store
        .write(|tx| {
            for id in ["b", "c"] {
                tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)", [id])
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
    let source = tag(&f, &a, "  Éléphant  ");
    let target = tag(&f, "b", "Animaux");
    let err=organize(&f,json!({"kind":"changeTags","ficheIds":[a],"addLabels":["Nouveau","ELEPHANT"],"addTagIds":[],"removeTagIds":[]})).unwrap_err();
    assert_eq!(err.code, "CATALOG_NAME_DUPLICATE");
    let raw = serde_json::to_value(err).unwrap();
    assert_eq!(raw["params"]["existingId"], source);
    assert_eq!(
        f.store.list_tags().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "Nouveau rolled back too"
    );
    organize(&f,json!({"kind":"changeTags","ficheIds":[a,"b"],"addLabels":[],"addTagIds":[source,source,target],"removeTagIds":[]})).unwrap();
    organize(&f,json!({"kind":"changeTags","ficheIds":["c"],"addLabels":[],"addTagIds":[target],"removeTagIds":[]})).unwrap();
    organize(&f,json!({"kind":"changeTags","ficheIds":[a,"b","c"],"addLabels":[],"addTagIds":[],"removeTagIds":[target]})).unwrap();
    assert_eq!(
        f.store.list_tags().unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    organize(&f,json!({"kind":"changeTags","ficheIds":[a,"b"],"addLabels":[],"addTagIds":[],"removeTagIds":[source]})).unwrap();
    assert!(f.store.list_tags().unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    for id in [&a, "b", "c"] {
        assert_eq!(f.store.get_card(id).unwrap()["tagIds"], json!([]));
    }
}
#[test]
fn organization_volume_ten_thousand_members_and_lists() {
    let f = Fixture::new();
    f.store
        .write(|tx| {
            tx.execute("INSERT INTO tag VALUES ('t','Volume','volume',1)", [])
                .unwrap();
            for n in 0..10_000 {
                let id = format!("volume-{n}");
                tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)", [&id])
                    .unwrap();
                tx.execute("INSERT INTO tag_member VALUES ('t',?1)", [&id])
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
    let start = Instant::now();
    let tags = f.store.list_tags().unwrap();
    let lists = start.elapsed();
    assert_eq!(tags["items"][0]["countUnreferenced"], 10_000);
    let mutation=serde_json::from_value(json!({"kind":"setFavorite","requestKey":"volume-favorite","ficheIds":["volume-0"],"value":true,"expectedFicheRevisions":{"volume-0":0}})).unwrap();
    let fingerprints = f.pack_fingerprints();
    let start = Instant::now();
    f.store
        .mutate(mutation, tags["revision"].as_i64().unwrap())
        .unwrap();
    let mutation = start.elapsed();
    let start = Instant::now();
    let mut cursor = None;
    let mut total = 0;
    loop {
        let page = f.store.query_entries(200, cursor.as_deref(), true).unwrap();
        total += page.items.len();
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(total, 10_000);
    assert_eq!(f.pack_fingerprints(), fingerprints);
    eprintln!(
        "4b 10000 fiches: lists={lists:?}; mutation={mutation:?}; entries_reload={:?}",
        start.elapsed()
    );
}

#[test]
fn organization_handwritten_ipc_contract_variants_and_list_types() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/organization.json"
    ))
    .unwrap();
    for payload in fixture["mutations"].as_array().unwrap() {
        let mutation: journal::Mutation = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(serde_json::to_value(mutation).unwrap(), *payload);
    }
    let f = Fixture::new();
    f.store
        .write(|tx| {
            tx.execute("INSERT INTO fiche VALUES ('contract-card',0,0,0)", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let id = tag(&f, "contract-card", "Contrat");
    let list = f.store.list_tags().unwrap();
    let keys = |value: &Value| {
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(keys(&list), keys(&fixture["list"]));
    assert_eq!(keys(&list["items"][0]), keys(&fixture["list"]["items"][0]));
    assert_eq!(list["items"][0]["id"], id);
    assert!(list["revision"].is_i64());
    assert!(list["items"][0]["count"].is_i64());
}

fn execute(f: &Fixture, mutation: Value) -> crate::services::catalogue::Result<Value> {
    let revision = f
        .store
        .read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))
        .unwrap();
    let before = f.pack_fingerprints();
    let result = f
        .store
        .mutate(serde_json::from_value(mutation).unwrap(), revision);
    assert_eq!(before, f.pack_fingerprints());
    result
}
fn bulk_edit(f: &Fixture, id: &str, changes: Value) -> Value {
    let card = f.store.get_card(id).unwrap();
    execute(f,json!({"kind":"bulkSetMetadata","requestKey":uuid::Uuid::new_v4().to_string(),"ficheIds":[id],"changes":changes,"expectedFicheRevisions":{id:card["ficheRevision"]}})).unwrap()
}
fn undo(f: &Fixture, token: &Value) -> crate::services::catalogue::Result<Value> {
    execute(
        f,
        json!({"kind":"undoMutation","requestKey":uuid::Uuid::new_v4().to_string(),"undoToken":token}),
    )
}
#[test]
fn bulk_undo_is_atomic_field_sensitive_durable_and_latest_only() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), Some(3), 1)]);
    let before = f.store.get_card(&id).unwrap();
    let first = bulk_edit(
        &f,
        &id,
        json!({"ageMin":{"state":"defined","value":5},"language":{"state":"defined","value":"it"}}),
    );
    let card = f.store.get_card(&id).unwrap();
    assert_ne!(before["fields"], card["fields"]);
    // A title edit is compatible with undo of age/language.
    f.mutate(
        &id,
        json!([{"field":"title","state":"defined","value":"Later"}]),
    );
    f.store.mutate(serde_json::from_value(json!({"kind":"undoMutation","requestKey":"stale-but-compatible","undoToken":first["undoToken"]})).unwrap(),first["catalogueRevision"].as_i64().unwrap()).unwrap();
    let card = f.store.get_card(&id).unwrap();
    assert!(card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["field"] == "title" && v["effective"]["value"] == "Later"));
    assert_eq!(
        undo(&f, &first["undoToken"]).unwrap_err().code,
        "CATALOG_UNDO_EXPIRED"
    );
    let second = bulk_edit(
        &f,
        &id,
        json!({"language":{"state":"defined","value":"en"}}),
    );
    let third = bulk_edit(
        &f,
        &id,
        json!({"language":{"state":"defined","value":"it"}}),
    );
    assert_eq!(
        undo(&f, &second["undoToken"]).unwrap_err().code,
        "CATALOG_UNDO_EXPIRED"
    );
    f.mutate(
        &id,
        json!([{"field":"language","state":"defined","value":"fr"}]),
    );
    let state = f.store.get_card(&id).unwrap();
    assert_eq!(
        undo(&f, &third["undoToken"]).unwrap_err().code,
        "CATALOG_UNDO_CONFLICT"
    );
    assert_eq!(state, f.store.get_card(&id).unwrap());
}

#[test]
fn bulk_edits_author_producer_bonus_and_undoes_them() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), Some(3), 1)]);
    let before = f.store.get_card(&id).unwrap();
    let edit = bulk_edit(
        &f,
        &id,
        json!({"author":{"state":"defined","value":"Ana"},"producer":{"state":"defined","value":"Prod"},"bonus":{"state":"defined","value":"Extra"}}),
    );
    let effective = |card: &Value, field: &str| {
        card["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["field"] == field && v["language"].as_str().unwrap_or("").is_empty())
            .map(|v| v["effective"]["value"].clone())
    };
    let card = f.store.get_card(&id).unwrap();
    for (field, value) in [("author", "Ana"), ("producer", "Prod"), ("bonus", "Extra")] {
        assert_eq!(effective(&card, field), Some(json!(value)), "{field}");
    }
    undo(&f, &edit["undoToken"]).unwrap();
    let card = f.store.get_card(&id).unwrap();
    for field in ["author", "producer", "bonus"] {
        assert_eq!(
            effective(&card, field),
            effective(&before, field),
            "{field}"
        );
    }
}

fn unidentified_pair(f: &Fixture) -> Vec<String> {
    let mut a = f.item("a.mbah", Some("Same"), None, 1);
    a.observation.identity = None;
    let mut b = f.item("b.mbah", Some("Same"), None, 1);
    b.observation.identity = None;
    f.publish(&[a, b]);
    f.store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .iter()
        .map(|v| v["id"].as_str().unwrap().into())
        .collect()
}
#[test]
fn bulk_undo_survives_reopen_and_validates_whole_selection() {
    let mut f = Fixture::new();
    let ids = unidentified_pair(&f);
    f.mutate(&ids[0],json!([{"field":"ageMin","state":"defined","value":2},{"field":"ageMax","state":"defined","value":4}]));
    let revisions: serde_json::Map<_, _> = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                f.store.get_card(id).unwrap()["ficheRevision"].clone(),
            )
        })
        .collect();
    let outcome=execute(&f,json!({"kind":"bulkSetMetadata","requestKey":"invalid-batch","ficheIds":ids,"changes":{"ageMin":{"state":"defined","value":7}},"expectedFicheRevisions":revisions})).unwrap();
    assert!(outcome.get("undoToken").is_none());
    assert_eq!(outcome["report"]["rejected"].as_array().unwrap().len(), 1);
    let outcome = bulk_edit(
        &f,
        &ids[1],
        json!({"language":{"state":"defined","value":"it"}}),
    );
    let replacement = Store::open(&f.root.join("other-data"), &f.root.join("other-cache")).unwrap();
    drop(std::mem::replace(&mut f.store, replacement));
    f.store = Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap();
    assert_eq!(
        f.store.last_undo().unwrap()["undoToken"],
        outcome["undoToken"]
    );
    undo(&f, &outcome["undoToken"]).unwrap();
}
#[test]
fn unreferenced_is_not_unavailable_forget_revalidates_and_purges_undo() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), None, 1)]);
    tag(&f, &id, "À oublier");
    let bulk = bulk_edit(
        &f,
        &id,
        json!({"language":{"state":"defined","value":"it"}}),
    );
    assert!(f
        .store
        .list_unreferenced(200, None)
        .unwrap()
        .items
        .is_empty());
    f.store
        .write(|tx| {
            tx.execute("UPDATE cache.observation SET state='unavailable'", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    assert!(f
        .store
        .list_unreferenced(200, None)
        .unwrap()
        .items
        .is_empty());
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"covered","ficheIds":[id],"expectedFicheRevisions":{&id:card["ficheRevision"]}})).unwrap_err().code,"CATALOG_FORGET_REFUSED");
    f.store
        .write(|tx| {
            tx.execute("UPDATE source SET status='removed'", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(f.store.list_unreferenced(200, None).unwrap().items.len(), 1);
    assert_eq!(
        f.store.preview_forget(std::slice::from_ref(&id)).unwrap()["items"][0]["counts"]
            ["corrections"],
        1
    );
    let recovery = f.root.join("recovery.json");
    std::fs::write(&recovery, b"existing recovery").unwrap();
    execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"forget","ficheIds":[id],"expectedFicheRevisions":{&id:card["ficheRevision"]}})).unwrap();
    assert!(f
        .store
        .list_unreferenced(200, None)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        undo(&f, &bulk["undoToken"]).unwrap_err().code,
        "CATALOG_UNDO_EXPIRED"
    );
    assert_eq!(std::fs::read(recovery).unwrap(), b"existing recovery");
    assert_eq!(
        f.store
            .read(|c| c.query_row("SELECT count(*) FROM correction", [], |r| r
                .get::<_, i64>(0)))
            .unwrap(),
        0
    );
    assert!(f.store.list_tags().unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn bulk_thousand_cards_cost() {
    let f = Fixture::new();
    let ids: Vec<String> = (0..1000).map(|n| format!("bulk-{n:04}")).collect();
    f.store
        .write(|tx| {
            for id in &ids {
                tx.execute("INSERT INTO fiche VALUES (?1,0,0,1)", [id])
                    .map_err(crate::services::catalogue::store::error)?;
            }
            Ok(())
        })
        .unwrap();
    let revisions: serde_json::Map<_, _> = ids.iter().map(|id| (id.clone(), json!(1))).collect();
    let start = Instant::now();
    let outcome=execute(&f,json!({"kind":"bulkSetMetadata","requestKey":"thousand","ficheIds":ids,"changes":{"language":{"state":"defined","value":"fr"}},"expectedFicheRevisions":revisions})).unwrap();
    eprintln!("bulk 1000 cards: {:?}", start.elapsed());
    assert_eq!(outcome["affectedCardIds"].as_array().unwrap().len(), 1000);
    undo(&f, &outcome["undoToken"]).unwrap();
}

#[test]
fn bulk_multi_card_undo_conflict_rolls_back_every_card_and_tag_removal_is_compatible() {
    let f = Fixture::new();
    let ids = unidentified_pair(&f);
    let revisions: serde_json::Map<_, _> = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                f.store.get_card(id).unwrap()["ficheRevision"].clone(),
            )
        })
        .collect();
    let batch=execute(&f,json!({"kind":"bulkSetMetadata","requestKey":"multi","ficheIds":ids,"changes":{"language":{"state":"defined","value":"it"}},"expectedFicheRevisions":revisions})).unwrap();
    organize(&f,json!({"kind":"changeTags","ficheIds":ids,"addLabels":["A","B"],"addTagIds":[],"removeTagIds":[]})).unwrap();
    let tags = f.store.list_tags().unwrap();
    let tags = tags["items"].as_array().unwrap();
    organize(&f,json!({"kind":"changeTags","ficheIds":ids,"addLabels":[],"addTagIds":[],"removeTagIds":[tags[0]["id"]]})).unwrap();
    undo(&f, &batch["undoToken"]).unwrap();
    for id in &ids {
        assert_eq!(
            f.store.get_card(id).unwrap()["tagIds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let revisions: serde_json::Map<_, _> = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                f.store.get_card(id).unwrap()["ficheRevision"].clone(),
            )
        })
        .collect();
    let batch=execute(&f,json!({"kind":"bulkSetMetadata","requestKey":"multi-conflict","ficheIds":ids,"changes":{"language":{"state":"defined","value":"en"}},"expectedFicheRevisions":revisions})).unwrap();
    f.mutate(
        &ids[1],
        json!([{"field":"language","state":"defined","value":"fr"}]),
    );
    let before: Vec<_> = ids.iter().map(|id| f.store.get_card(id).unwrap()).collect();
    let error = undo(&f, &batch["undoToken"]).unwrap_err();
    assert_eq!(error.code, "CATALOG_UNDO_CONFLICT");
    assert_eq!(error.params["conflicts"][0]["ficheId"], ids[1]);
    assert_eq!(
        before,
        ids.iter()
            .map(|id| f.store.get_card(id).unwrap())
            .collect::<Vec<_>>()
    );
}

#[test]
fn removal_cleans_images_preserves_other_staging_and_readding_uuid_starts_fresh() {
    let f = Fixture::new();
    let item = f.item("one.mbah", Some("One"), None, 1);
    let id = f.publish(std::slice::from_ref(&item));
    let path = f.root.join("cover.png");
    image::RgbImage::new(20, 20).save(&path).unwrap();
    let staged = f.store.stage_cover(&path).unwrap();
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":staged["coverStagingId"]}]),
    );
    let other_stage = f.store.stage_cover(&path).unwrap();
    f.store.remove_source(&f.source, 1).unwrap();
    assert!(f
        .store
        .list_unreferenced(200, None)
        .unwrap()
        .items
        .is_empty());
    assert!(f.store.get_card(&id).is_err());
    f.store
        .add_source(&f.root.join("source"), 2, false)
        .unwrap();
    f.store
        .publish_scan(
            "readd",
            3,
            std::slice::from_ref(&item),
            &[(f.source.clone(), true)],
        )
        .unwrap();
    let cards = f.store.query_entries(200, None, true).unwrap();
    assert_eq!(cards.items.len(), 1);
    let new_id = cards.items[0]["id"].as_str().unwrap();
    assert_ne!(new_id, id);
    let fresh = f.store.get_card(new_id).unwrap();
    assert_eq!(field(&fresh, "cover")["correction"]["state"], "none");
    f.store.remove_source(&f.source, 3).unwrap();
    assert!(!f
        .store
        .images_root()
        .join(staged["sha256"].as_str().unwrap())
        .exists());
    // Preparing an unrelated edit is independent of orphan-image cleanup.
    assert!(std::fs::read_dir(f.store.staging_root())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(other_stage["coverStagingId"].as_str().unwrap())));
    assert_eq!(
        f.store
            .read(|c| c.query_row(
                "SELECT count(*) FROM operation_change WHERE entity_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
}

#[test]
fn lot_4c_handwritten_mutation_contract_roundtrips() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/mutations-4c.json"
    ))
    .unwrap();
    for value in fixture {
        let mutation: journal::Mutation = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(mutation).unwrap(), value);
    }
}

#[test]
fn undo_revalidates_final_age_interval_and_rolls_back_all_cards() {
    let f = Fixture::new();
    let ids = unidentified_pair(&f);
    f.mutate(
        &ids[0],
        json!([
            {"field":"ageMin","state":"defined","value":8},
            {"field":"ageMax","state":"defined","value":10}
        ]),
    );
    let revisions: serde_json::Map<_, _> = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                f.store.get_card(id).unwrap()["ficheRevision"].clone(),
            )
        })
        .collect();
    let batch = execute(&f, json!({"kind":"bulkSetMetadata","requestKey":"age-undo-batch","ficheIds":ids,"changes":{"ageMin":{"state":"defined","value":5},"language":{"state":"defined","value":"it"}},"expectedFicheRevisions":revisions})).unwrap();
    f.mutate(
        &ids[0],
        json!([
            {"field":"ageMin","state":"defined","value":5},
            {"field":"ageMax","state":"defined","value":6}
        ]),
    );
    let before: Vec<_> = ids.iter().map(|id| f.store.get_card(id).unwrap()).collect();
    let error = undo(&f, &batch["undoToken"]).unwrap_err();
    assert_eq!(error.code, "CATALOG_UNDO_CONFLICT");
    for field in ["ageMin", "ageMax"] {
        assert!(error.params["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["ficheId"] == ids[0]
                && item["field"] == field
                && item["rule"] == "interval"));
    }
    assert_eq!(
        before,
        ids.iter()
            .map(|id| f.store.get_card(id).unwrap())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        f.store.last_undo().unwrap()["undoToken"],
        batch["undoToken"],
        "a refused undo consumes neither its token nor its receipt"
    );
    // Repairing the other bound makes that same operation undoable again.
    f.mutate(
        &ids[0],
        json!([
            {"field":"ageMin","state":"defined","value":5},
            {"field":"ageMax","state":"defined","value":10}
        ]),
    );
    undo(&f, &batch["undoToken"]).unwrap();
}

#[test]
fn review34_reference_change_rejects_final_invalid_age_atomically() {
    let f = Fixture::new();
    let id = f.publish(&[
        f.item("low.mbah", Some("Low"), Some(3), 2),
        f.item("high.mbah", Some("High"), Some(8), 1),
    ]);
    f.mutate(
        &id,
        json!([{"field":"ageMin","state":"source"},{"field":"ageMax","state":"defined","value":6}]),
    );
    let before = f.store.get_card(&id).unwrap();
    let exemplar = before["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"].as_str().unwrap().ends_with("high.mbah"))
        .unwrap()["id"]
        .clone();
    let error = execute(&f, json!({"kind":"setReferenceExemplar","requestKey":"invalid-reference","ficheId":id,"expectedFicheRevision":before["ficheRevision"],"exemplarId":exemplar})).unwrap_err();
    assert_eq!(error.code, "CATALOG_VALUE_INVALID");
    assert_eq!(f.store.get_card(&id).unwrap(), before);
}

#[test]
fn review34_rescan_retains_last_valid_value_and_diagnostic() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("Accepted"), None, 1)]);
    let mut invalid = f.item("one.mbah", None, None, 2);
    invalid.observation.fields.insert(
        "/title".into(),
        analyze::observed(&json!({"title":42}), "/title", "string"),
    );
    f.publish(&[invalid]);
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(field(&card, "title")["effective"]["value"], "Accepted");
    assert_eq!(field(&card, "title")["invalid"][0]["raw"], 42);
    f.publish(&[f.item("one.mbah", Some("New accepted"), None, 3)]);
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(field(&card, "title")["effective"]["value"], "New accepted");
    assert!(field(&card, "title").get("invalid").is_none());
}

#[test]
fn forget_waits_for_pending_file_operations() {
    let f = Fixture::new();
    let ids = unidentified_pair(&f);
    f.store
        .write(|tx| {
            tx.execute("UPDATE source SET status='removed'", [])
                .unwrap();
            tx.execute(
                "INSERT INTO file_journal VALUES ('pending',?1)",
                [json!({"stage":"prepared","target":{"ficheId":ids[0]}}).to_string()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let card = f.store.get_card(&ids[0]).unwrap();
    let failure=execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"forget-busy","ficheIds":[ids[0]],"expectedFicheRevisions":{&ids[0]:card["ficheRevision"]}})).unwrap_err();
    assert_eq!(failure.code, "CATALOG_FILE_RECOVERY_REQUIRED");
    assert_eq!(f.store.get_card(&ids[0]).unwrap(), card);
}

#[test]
fn forget_purges_exact_nested_identifiers_and_pending_convergences() {
    let f = Fixture::new();
    let ids = unidentified_pair(&f);
    f.store.write(|tx|{
        tx.execute("UPDATE source SET status='removed'",[]).unwrap();
        let eid:String=tx.query_row("SELECT id FROM exemplar WHERE fiche_id=?1",[&ids[1]],|r|r.get(0)).unwrap();
        tx.execute("INSERT INTO identity_convergence VALUES (?1,?2,'12345678-1234-4234-8234-123456789abc','{}')",rusqlite::params![eid,ids[0]]).unwrap();
        for (op,value) in [("exact",json!({"nested":json!(["favorite",ids[0]]).to_string()})),("substring",json!({"note":format!("prefix{}suffix",ids[0])}))] {
            tx.execute("INSERT INTO operation(id,request_key,kind,status,expected_revision,created_at,recovery_json) VALUES (?1,?1,'test','committed',0,0,?2)",rusqlite::params![op,value.to_string()]).unwrap();
        }
        Ok(())
    }).unwrap();
    let card = f.store.get_card(&ids[0]).unwrap();
    execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"forget","ficheIds":[ids[0]],"expectedFicheRevisions":{&ids[0]:card["ficheRevision"]}})).unwrap();
    f.store
        .read(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM operation WHERE id='exact'", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM operation WHERE id='substring'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM identity_convergence", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

fn official_lunii(f: &Fixture) {
    f.store.set_lunii_permission(true).unwrap();
    f.store.lunii_locale("fr").unwrap();
    let path = f.root.join("official.json");
    std::fs::write(&path, json!({"pack":{"uuid":"12345678-1234-4234-8234-123456789abc","localized_infos":{"fr_FR":{"title":"Official","image":{"image_url":"/public/images/test.png"}}}}}).to_string()).unwrap();
    f.store.load_lunii_fixture(&path).unwrap();
}
fn field_value(store: &Store, id: &str, name: &str) -> Value {
    store.get_card(id).unwrap()["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["field"] == name && v["language"].is_null())
        .unwrap()["effective"]["value"]
        .clone()
}
#[test]
fn lunii_forget_then_reappearance_refills_and_resets_failures() {
    let f = Fixture::new();
    let item = f.item("pack.mbah", Some("Pack"), None, 1);
    let id = f.publish(std::slice::from_ref(&item));
    official_lunii(&f);
    f.store
        .write(|tx| {
            tx.execute_batch("UPDATE source SET status='removed';")
                .map_err(crate::services::catalogue::store::error)?;
            tx.execute("INSERT INTO lunii_image_attempt VALUES (?1,3)", [&id])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store.preview_forget(std::slice::from_ref(&id)).unwrap()["items"][0]["title"],
        "Official"
    );
    let revision = f.store.get_card(&id).unwrap()["ficheRevision"].clone();
    execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"forget-official","ficheIds":[id],"expectedFicheRevisions":{&id:revision}})).unwrap();
    assert_eq!(
        f.store
            .read(
                |c| c.query_row("SELECT count(*) FROM lunii_image_attempt", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        0
    );
    f.store
        .write(|tx| {
            tx.execute("UPDATE source SET status='active'", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    let fresh_id = f.publish(&[item]);
    assert_ne!(fresh_id, id);
    assert!(f.store.get_card(&id).is_err());
    assert_eq!(field_value(&f.store, &fresh_id, "title"), "Official");
}

fn cross_review_official_pair() -> (Fixture, String, String) {
    let f = Fixture::new();
    let official = f.item("official.mbah", Some("Pack"), None, 1);
    let mut other = f.item("other.mbah", Some("Other"), None, 1);
    other.observation.identity = None;
    f.publish(&[official, other]);
    official_lunii(&f);
    let official: String = f
        .store
        .read(|c| c.query_row("SELECT fiche_id FROM pack_identity", [], |r| r.get(0)))
        .unwrap();
    let other = f
        .store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .into_iter()
        .find(|v| v["id"] != official)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (f, official, other)
}

#[test]
fn luh_group_for_file_after_restart_keeps_local_official_cover() {
    let (mut f, official, other) = cross_review_official_pair();
    let label = tag(&f, &official, "À transférer");
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(24, 24)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    f.store.lunii_cover_test_response(png.into_inner());
    let key = field_value(&f.store, &official, "cover")["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = f.store.lunii_cover_bytes(&official, &key).unwrap();
    f.store.retain_lunii_cover(&official, &key, &bytes).unwrap();
    let before = field_value(&f.store, &official, "cover");
    let placeholder =
        Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap();
    drop(std::mem::replace(&mut f.store, placeholder));
    f.store = Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap();
    f.store
        .write(|tx| {
            mutate::association::group_for_file(
                tx,
                &[official.clone(), other.clone()],
                &other,
                &[],
                true,
            )
        })
        .unwrap();
    assert_eq!(field_value(&f.store, &other, "cover"), before);
    assert_eq!(f.store.lunii_cover_bytes(&other, &key).unwrap(), bytes);
    assert_eq!(f.store.lunii_cover_test_requests(), 0);
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["id"], label);
    assert_eq!(f.store.get_card(&other).unwrap()["tagIds"], json!([label]));
}

#[test]
fn m1_source_removal_counts_shared_cards_and_erases_only_last_copy() {
    let f = Fixture::new();
    let first = f.item("one.mbah", Some("One"), None, 1);
    let id = f.publish(std::slice::from_ref(&first));
    f.mutate(
        &id,
        json!([{"field":"title","state":"defined","value":"Personal"}]),
    );
    f.store
        .write(|tx| {
            tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1", [&id])
                .unwrap();
            tx.execute_batch("INSERT INTO tag VALUES ('tag','Tag','tag',0); ")
                .unwrap();
            tx.execute("INSERT INTO tag_member VALUES ('tag',?1)", [&id])
                .unwrap();

            Ok(())
        })
        .unwrap();
    let other = f.root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let added = f.store.add_source(&other, 1, false).unwrap();
    let mut copy = f.item("two.mbah", Some("One"), None, 2);
    copy.source_id = added.source_id.clone();
    copy.path = other.join("two.zip").to_string_lossy().into();
    copy.path_key = copy.path.as_bytes().to_vec();
    std::fs::write(&copy.path, b"untouched pack").unwrap();
    f.store
        .publish_scan(
            "copy",
            2,
            &[first.clone(), copy.clone()],
            &[(f.source.clone(), true), (added.source_id.clone(), true)],
        )
        .unwrap();
    let reference = f.store.get_card(&id).unwrap()["reference"]["exemplarId"].clone();
    let preview = f.store.preview_remove_source(&f.source).unwrap();
    assert_eq!((preview.count, preview.remaining), (0, 1));
    f.store
        .remove_source_confirmed(
            &f.source,
            preview.sources_revision,
            preview.catalogue_revision,
        )
        .unwrap();
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "title")["effective"]["value"],
        "Personal"
    );
    let retained = f.store.get_card(&id).unwrap();
    assert_eq!(retained["reference"]["exemplarId"], reference);
    assert_eq!(retained["reference"]["state"], "unavailable");
    assert_eq!(retained["favorite"], true);
    assert_eq!(retained["tagIds"], json!(["tag"]));
    let preview = f.store.preview_remove_source(&added.source_id).unwrap();
    assert_eq!((preview.count, preview.remaining), (1, 0));
    f.store
        .remove_source_confirmed(
            &added.source_id,
            preview.sources_revision,
            preview.catalogue_revision,
        )
        .unwrap();
    for table in [
        "fiche",
        "exemplar",
        "pack_identity",
        "correction",
        "provenance",
        "reference_source",
        "reference_value",
        "fiche_forgotten",
        "tag_member",
        "tag",
        "suggestion_decision",
        "identity_convergence",
        "import_reference",
    ] {
        assert_eq!(
            f.store
                .read(
                    |c| c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                )
                .unwrap(),
            0,
            "{table}"
        );
    }
    assert_eq!(std::fs::read(&copy.path).unwrap(), b"untouched pack");
    assert!(std::path::Path::new(&first.path).exists());
}

#[test]
fn m1_stale_preview_cannot_erase_new_personal_data() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), None, 1)]);
    let preview = f.store.preview_remove_source(&f.source).unwrap();
    f.mutate(
        &id,
        json!([{"field":"title","state":"defined","value":"New"}]),
    );
    assert_eq!(
        f.store
            .remove_source_confirmed(
                &f.source,
                preview.sources_revision,
                preview.catalogue_revision
            )
            .err()
            .unwrap()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "title")["effective"]["value"],
        "New"
    );
}

#[test]
fn m1_incomplete_scan_missing_and_unavailable_never_erase_and_move_rejoins_uuid() {
    let f = Fixture::new();
    let first = f.item("one.mbah", Some("One"), None, 1);
    let id = f.publish(std::slice::from_ref(&first));
    f.mutate(
        &id,
        json!([{"field":"title","state":"defined","value":"Keep"}]),
    );
    std::fs::remove_file(&first.path).unwrap();
    f.store
        .finalize_scan("cut", 1, &[(f.source.clone(), false)])
        .unwrap();
    assert_eq!(
        f.store.get_card(&id).unwrap()["offlineReason"],
        "unavailable"
    );
    f.store
        .finalize_scan("complete", 1, &[(f.source.clone(), true)])
        .unwrap();
    assert_eq!(f.store.get_card(&id).unwrap()["offlineReason"], "missing");
    f.store
        .finalize_scan("unreachable", 1, &[(f.source.clone(), false)])
        .unwrap();
    assert_eq!(
        f.store.get_card(&id).unwrap()["offlineReason"],
        "unavailable"
    );
    let other = f.root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let added = f.store.add_source(&other, 1, false).unwrap();
    let mut moved = first;
    moved.source_id = added.source_id.clone();
    moved.path = other.join("moved.mbah").to_string_lossy().into();
    moved.path_key = moved.path.as_bytes().to_vec();
    std::fs::write(&moved.path, b"moved").unwrap();
    f.store
        .publish_scan(
            "moved",
            2,
            &[moved],
            &[(f.source.clone(), true), (added.source_id, true)],
        )
        .unwrap();
    let cards = f.store.query_entries(200, None, true).unwrap();
    assert_eq!(cards.items.len(), 1);
    assert_eq!(cards.items[0]["id"], id);
    assert!(cards.items[0]["offlineReason"].is_null());
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "title")["effective"]["value"],
        "Keep"
    );
}

#[test]
fn m1_explicit_card_removal_has_revision_guard_and_no_pack_write() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), None, 1)]);
    tag(&f, &id, "Dernière");
    let bytes = f.pack_fingerprints();
    let p = f
        .store
        .preview_remove_cards(std::slice::from_ref(&id))
        .unwrap();
    assert_eq!(
        f.store
            .remove_cards_confirmed(std::slice::from_ref(&id), p.catalogue_revision - 1)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    f.store
        .remove_cards_confirmed(&[id], p.catalogue_revision)
        .unwrap();
    assert!(f
        .store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(f.pack_fingerprints(), bytes);
    assert!(f.store.list_tags().unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn m1b_nonfinal_evidence_blocks_every_erasure_and_preview() {
    for (table, insert, finish) in [
        (
            "file_removal",
            "INSERT INTO file_removal VALUES ('busy',?1,'uncertain')",
            "UPDATE file_removal SET state='complete'",
        ),
        (
            "file_removal",
            "INSERT INTO file_removal VALUES ('busy',?1,'pending')",
            "UPDATE file_removal SET state='complete'",
        ),
        (
            "file_operation",
            "INSERT INTO file_operation VALUES ('busy','request','{}','running',?1)",
            "UPDATE file_operation SET state='success'",
        ),
        (
            "file_journal",
            "INSERT INTO file_journal VALUES ('busy',?1)",
            "UPDATE file_journal SET evidence_json=json_set(evidence_json,'$.stage','complete')",
        ),
    ] {
        for by_exemplar in [false, true] {
            let f = Fixture::new();
            let id = f.publish(&[f.item("one.mbah", Some("Personal"), None, 1)]);
            let card = f.store.get_card(&id).unwrap();
            let exemplar = card["exemplars"][0]["id"].as_str().unwrap();
            let evidence =
                json!({"stage":"publishing","source":{"id":if by_exemplar {exemplar} else {&id}}})
                    .to_string();
            let p = f.store.preview_remove_source(&f.source).unwrap();
            f.store
                .write(|tx| {
                    tx.execute(insert, [&evidence]).unwrap();
                    Ok(())
                })
                .unwrap();
            let blocked = |err: crate::support::user_message::UserMessage| {
                assert_eq!(
                    err.code, "CATALOG_FILE_RECOVERY_REQUIRED",
                    "{table}, exemplar={by_exemplar}"
                )
            };
            blocked(f.store.preview_remove_source(&f.source).err().unwrap());
            blocked(
                f.store
                    .remove_source_confirmed(&f.source, p.sources_revision, p.catalogue_revision)
                    .err()
                    .unwrap(),
            );
            blocked(
                f.store
                    .preview_remove_cards(std::slice::from_ref(&id))
                    .err()
                    .unwrap(),
            );
            blocked(
                f.store
                    .remove_cards_confirmed(std::slice::from_ref(&id), p.catalogue_revision)
                    .unwrap_err(),
            );
            blocked(
                f.store
                    .preview_forget(std::slice::from_ref(&id))
                    .unwrap_err(),
            );
            f.store
                .write(|tx| {
                    tx.execute("UPDATE source SET status='removed'", [])
                        .unwrap();
                    Ok(())
                })
                .unwrap();
            blocked(execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"forget-busy","ficheIds":[id],"expectedFicheRevisions":{&id:card["ficheRevision"]}})).unwrap_err());
            assert_eq!(
                field(&f.store.get_card(&id).unwrap(), "title")["effective"]["value"],
                "Personal"
            );
            assert_eq!(
                f.store
                    .read(
                        |c| c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                            .get::<_, i64>(0))
                    )
                    .unwrap(),
                1
            );
            f.store
                .write(|tx| {
                    tx.execute(finish, []).unwrap();
                    Ok(())
                })
                .unwrap();
            f.store
                .remove_cards_confirmed(std::slice::from_ref(&id), p.catalogue_revision)
                .unwrap();
            assert_eq!(
                f.store
                    .read(
                        |c| c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                            .get::<_, i64>(0))
                    )
                    .unwrap(),
                0
            );
        }
    }
}

#[test]
fn m1b_preview_validates_cards_counts_available_and_receipts_contain_no_ids() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), None, 1)]);
    for ids in [vec![], vec!["absent".into()], vec![id.clone(), id.clone()]] {
        assert_eq!(
            f.store.preview_remove_cards(&ids).err().unwrap().code,
            "CATALOG_MUTATION_INVALID"
        );
    }
    let p = f
        .store
        .preview_remove_cards(std::slice::from_ref(&id))
        .unwrap();
    assert_eq!((p.count, p.remaining, p.available), (1, 0, 1));
    f.store
        .remove_cards_confirmed(std::slice::from_ref(&id), p.catalogue_revision)
        .unwrap();
    let raw = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT recovery_json FROM operation WHERE kind='removeCards'",
                [],
                |r| r.get::<_, String>(0),
            )
        })
        .unwrap();
    assert!(!raw.contains(&id));
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["mutation"],
        json!({"count":1})
    );
}

#[test]
fn m1b_removed_source_is_not_found() {
    let f = Fixture::new();
    let p = f.store.preview_remove_source(&f.source).unwrap();
    f.store
        .remove_source_confirmed(&f.source, p.sources_revision, p.catalogue_revision)
        .unwrap();
    assert_eq!(
        f.store.preview_remove_source(&f.source).err().unwrap().code,
        "CATALOG_SOURCE_NOT_FOUND"
    );
    assert_eq!(
        f.store
            .remove_source_confirmed(&f.source, p.sources_revision + 1, p.catalogue_revision + 1)
            .err()
            .unwrap()
            .code,
        "CATALOG_SOURCE_NOT_FOUND"
    );
}

#[test]
fn m1b_empty_source_is_missing_for_full_scan_and_reconciliation() {
    let f = Fixture::new();
    let item = f.item("one.mbah", Some("One"), None, 1);
    let id = f.publish(std::slice::from_ref(&item));
    std::fs::remove_file(&item.path).unwrap();
    let check = || assert_eq!(f.store.get_card(&id).unwrap()["offlineReason"], "missing");
    f.store
        .finalize_scan("empty", 1, &[(f.source.clone(), true)])
        .unwrap();
    check();
    let root = crate::services::catalogue::refresh::Root {
        source_id: f.source.clone(),
        path: f.root.join("source"),
    };
    f.store
        .reconcile_source(
            &root,
            &f.store
                .exclusions(&f.root.join("cache"), &f.root.join("data"))
                .unwrap(),
            std::time::Duration::ZERO,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| false,
            &crate::services::catalogue::writes::Registry::default(),
        )
        .unwrap();
    check();
    // A reachable, nonempty source can still prove an individual file missing.
    std::fs::write(f.root.join("source/keep.txt"), b"mounted").unwrap();
    f.store
        .reconcile_source(
            &root,
            &f.store
                .exclusions(&f.root.join("cache"), &f.root.join("data"))
                .unwrap(),
            std::time::Duration::ZERO,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| false,
            &crate::services::catalogue::writes::Registry::default(),
        )
        .unwrap();
    assert_eq!(f.store.get_card(&id).unwrap()["offlineReason"], "missing");
}

#[test]
fn m1b_forget_receipt_keeps_only_count_and_replay_still_refreshes() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), None, 1)]);
    let card = f.store.get_card(&id).unwrap();
    f.store
        .write(|tx| {
            tx.execute("UPDATE source SET status='removed'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let mutation = json!({"kind":"forgetUnreferencedCards","requestKey":"forget","ficheIds":[id],"expectedFicheRevisions":{&id:card["ficheRevision"]}});
    let result = execute(&f, mutation.clone()).unwrap();
    let raw = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT recovery_json FROM operation WHERE kind='forgetUnreferencedCards'",
                [],
                |r| r.get::<_, String>(0),
            )
        })
        .unwrap();
    assert!(!raw.contains(&id));
    let receipt: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        receipt,
        json!({"mutation":{"count":1},"outcome":{"count":1}})
    );
    let replay = execute(&f, mutation).unwrap();
    assert_eq!(replay["catalogueRevision"], result["catalogueRevision"]);
    assert_eq!(replay["affectedCardIds"], json!([]));
}

#[test]
fn m1b_identity_receipt_cannot_be_purged_before_its_journal_finishes() {
    let f = Fixture::new();
    let id = f.publish(&[f.item("one.mbah", Some("One"), None, 1)]);
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_journal VALUES ('identity','{\"stage\":\"publishing\"}')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO file_identity_receipt VALUES ('identity',?1)",
                [json!({"ficheId":id}).to_string()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store
            .preview_remove_cards(std::slice::from_ref(&id))
            .err()
            .unwrap()
            .code,
        "CATALOG_FILE_RECOVERY_REQUIRED"
    );
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE file_journal SET evidence_json='{\"stage\":\"complete\"}'",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let p = f
        .store
        .preview_remove_cards(std::slice::from_ref(&id))
        .unwrap();
    f.store
        .remove_cards_confirmed(&[id], p.catalogue_revision)
        .unwrap();
    assert_eq!(
        f.store
            .read(
                |c| c.query_row("SELECT count(*) FROM file_identity_receipt", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        0
    );
}

#[test]
fn retained_project_metadata_history_is_purged_without_touching_other_receipts_or_packs() {
    for state in ["complete", "aborted"] {
        for by_exemplar in [false, true] {
            for in_receipt in [false, true] {
                let f = Fixture::new();
                let id = f.publish(&[f.item("one.mbah", Some("Personal"), None, 1)]);
                let bytes = f.pack_fingerprints();
                let card = f.store.get_card(&id).unwrap();
                let mentioned = if by_exemplar {
                    card["exemplars"][0]["id"].as_str().unwrap()
                } else {
                    &id
                };
                let evidence = json!({"source":{"id":mentioned}}).to_string();
                f.store.write(|tx| {
                    tx.execute("INSERT INTO project_metadata_operation VALUES ('owned','owned-request',?1,?2,?3)",
                        rusqlite::params![state, if in_receipt { "{}" } else { &evidence }, if in_receipt { &evidence } else { "{}" }]).unwrap();
                    tx.execute("INSERT INTO project_metadata_operation VALUES ('unrelated','other-request',?1,'{}','{}')", [state]).unwrap();
                    Ok(())
                }).unwrap();
                let preview = f
                    .store
                    .preview_remove_cards(std::slice::from_ref(&id))
                    .unwrap();
                f.store
                    .remove_cards_confirmed(&[id], preview.catalogue_revision)
                    .unwrap();
                let remaining: Vec<String> = f
                    .store
                    .read(|c| {
                        c.prepare("SELECT id FROM project_metadata_operation")?
                            .query_map([], |r| r.get(0))?
                            .collect()
                    })
                    .unwrap();
                assert_eq!(
                    remaining,
                    ["unrelated"],
                    "{state}/{by_exemplar}/{in_receipt}"
                );
                assert_eq!(f.pack_fingerprints(), bytes);
            }
        }
    }
}

#[test]
fn completed_fields_follow_newest_available_sibling_without_changing_reference() {
    let f = Fixture::new();
    let reference = f.item("reference.mbah", Some("Reference"), None, 10);
    let id = f.publish(std::slice::from_ref(&reference));
    let original = f.store.get_card(&id).unwrap()["reference"].clone();
    let old = f.item("old.mbah", Some("Old"), Some(3), 1);
    let recent = f.item("recent.mbah", Some("Recent"), Some(7), 2);
    f.publish(&[reference.clone(), old.clone(), recent.clone()]);
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(card["reference"], original);
    assert_eq!(field(&card, "title")["effective"]["value"], "Reference");
    assert_eq!(field(&card, "ageMin")["effective"]["value"], 7);
    let provider = card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"].as_str().unwrap().ends_with("recent.mbah"))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        field(&card, "ageMin")["referenceValue"]["provenanceId"],
        format!("observed:{provider}")
    );
    assert!(card["provenance"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == format!("observed:{provider}") && p["exemplarId"] == provider));
    // Localized slots are independent, and ties use the exemplar identifier.
    f.store.write(|tx| {
        for e in card["exemplars"].as_array().unwrap().iter().filter(|e| e["id"] != original["exemplarId"]) {
            let eid = e["id"].as_str().unwrap();
            tx.execute("UPDATE cache.observation SET modified_at=5 WHERE exemplar_id=?1", [eid]).unwrap();
            tx.execute("INSERT INTO cache.extracted_value VALUES (?1,'description','it','@card','present','valid',NULL,?2,'{}')",rusqlite::params![eid,json!(eid).to_string()]).unwrap();
        }
        Ok(())
    }).unwrap();
    let tied = f.store.get_card(&id).unwrap();
    let expected = card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["id"] != original["exemplarId"])
        .map(|e| e["id"].as_str().unwrap())
        .min()
        .unwrap();
    assert_eq!(
        tied["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["field"] == "description" && v["language"] == "it")
            .unwrap()["effective"]["value"],
        expected
    );
    f.mutate(
        &id,
        json!([{"field":"ageMin","state":"defined","value":12},{"field":"ageMax","state":"source"}]),
    );
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"],
        12
    );
    f.mutate(
        &id,
        json!([{"field":"ageMin","state":"source"},{"field":"ageMax","state":"source"}]),
    );
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE cache.observation SET state='unavailable' WHERE exemplar_id=?1",
                [&provider],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"],
        3
    );
    f.store.write(|tx| {
        tx.execute("INSERT OR REPLACE INTO source_health(source_id,availability) VALUES (?1,'unavailable')", [&f.source]).unwrap();
        Ok(())
    }).unwrap();
    assert!(field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"].is_null());
    f.store
        .write(|tx| {
            tx.execute("DELETE FROM source_health WHERE source_id=?1", [&f.source])
                .unwrap();
            Ok(())
        })
        .unwrap();
    // A changed provider is picked up by the next accepted scan.
    let changed = f.item("recent.mbah", Some("Recent"), Some(9), 20);
    f.publish(&[reference, old, changed]);
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"],
        9
    );
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE exemplar SET retired=1 WHERE fiche_id=?1 AND id!=?2",
                rusqlite::params![id, original["exemplarId"].as_str().unwrap()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"].is_null());
    // No derived source is ever written to either portable personal-data table.
    f.store.read_snapshot(|c| {
        assert_eq!(c.query_row("SELECT count(*) FROM reference_value WHERE fiche_id=?1 AND field='ageMin'", [&id], |r| r.get::<_,i64>(0))?, 0);
        assert_eq!(c.query_row("SELECT count(*) FROM correction WHERE fiche_id=?1 AND field='ageMin' AND state='defined'", [&id], |r| r.get::<_,i64>(0))?, 0);
        Ok(())
    }).unwrap();
}

#[test]
fn completed_cover_uses_readable_sibling_for_absent_missing_and_undecodable_reference() {
    for bad in ["absent", "missing", "undecodable"] {
        let f = Fixture::new();
        let mut reference = f.item("reference.mbah", Some("Reference"), None, 10);
        let missing = f.root.join("missing.png");
        if bad == "undecodable" {
            std::fs::write(&missing, b"broken image").unwrap();
        }
        if bad != "absent" {
            reference.observation.cover = Some(json!({"kind":"file","path":missing}));
        }
        let id = f.publish(std::slice::from_ref(&reference));
        let original = f.store.get_card(&id).unwrap()["reference"].clone();
        let image = f.root.join("good.png");
        image::RgbImage::new(16, 16).save(&image).unwrap();
        let mut sibling = f.item("sibling.mbah", Some("Sibling"), None, 1);
        sibling.observation.cover = Some(json!({"kind":"file","path":image}));
        f.publish(&[reference.clone(), sibling.clone()]);
        assert_eq!(
            f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
            "ready",
            "{bad}"
        );
        let card = f.store.get_card(&id).unwrap();
        assert_eq!(card["reference"], original);
        assert_eq!(
            field(&card, "cover")["effective"]["value"]["path"],
            json!(image)
        );
        assert_eq!(
            f.store.query_entries(200, None, true).unwrap().items[0]["values"]["cover"]["path"],
            json!(image)
        );
        f.store
            .publish_targeted(
                "remove-cover-provider",
                1,
                &f.source,
                &[],
                &[sibling.path_key.clone()],
            )
            .unwrap();
        f.publish(&[reference]);
        // The supplying exemplar is now missing: a completed value is not retained.
        let _ = f.store.get_thumbnail(None, Some(&id), None).unwrap();
        assert!(field(&f.store.get_card(&id).unwrap(), "cover")["effective"]["value"].is_null());
        // A new observation clears the negative readability evidence.
        let mut repaired = f.item("reference.mbah", Some("Reference"), None, 30);
        repaired.observation.cover = Some(json!({"kind":"file","path":image}));
        f.publish(&[repaired]);
        assert_eq!(
            f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
            "ready"
        );
        assert_eq!(
            field(&f.store.get_card(&id).unwrap(), "cover")["effective"]["value"]["path"],
            json!(image)
        );
    }
}

#[test]
fn compl2_offline_reference_keeps_known_values_but_cannot_supply_missing_slots() {
    let f = Fixture::new();
    let reference = f.item("reference.mbah", Some("Known"), None, 10);
    let id = f.publish(std::slice::from_ref(&reference));
    let sibling = f.item("sibling.mbah", Some("Sibling"), Some(4), 1);
    f.publish(&[reference, sibling]);
    let card = f.store.get_card(&id).unwrap();
    let reference_id = card["reference"]["exemplarId"].as_str().unwrap();
    f.store.write(|tx| {
        tx.execute("UPDATE cache.observation SET state='unavailable' WHERE exemplar_id=?1",[reference_id]).unwrap();
        tx.execute("UPDATE cache.extracted_value SET value_json='8',validity='valid' WHERE exemplar_id=?1 AND field='ageMin' AND candidate_key='@card'",[reference_id]).unwrap();
        Ok(())
    }).unwrap();
    let card = f.store.get_card(&id).unwrap();
    assert_eq!(field(&card, "title")["effective"]["value"], "Known");
    assert_eq!(field(&card, "ageMin")["effective"]["value"], 4);
}

#[test]
fn compl2_unreadable_cover_survives_unchanged_rescan_without_publication() {
    let f = Fixture::new();
    let mut reference = f.item("reference.mbah", Some("Reference"), None, 10);
    reference.observation.cover = Some(json!({"kind":"file","path":f.root.join("missing.png")}));
    let id = f.publish(std::slice::from_ref(&reference));
    let image = f.root.join("good.png");
    image::RgbImage::new(16, 16).save(&image).unwrap();
    let mut sibling = f.item("sibling.mbah", Some("Sibling"), None, 1);
    sibling.observation.cover = Some(json!({"kind":"file","path":image}));
    f.publish(&[reference.clone(), sibling.clone()]);
    assert_eq!(
        f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
        "ready"
    );
    let before = f.store.get_card(&id).unwrap();
    let publication = f
        .store
        .publish_scan(
            "compl2-unchanged",
            1,
            &[reference, sibling],
            &[(f.source.clone(), true)],
        )
        .unwrap();
    assert!(
        !publication.changed,
        "no catalogue-changed after a no-op rescan"
    );
    assert_eq!(
        publication.revision,
        before["catalogueRevision"].as_i64().unwrap()
    );
    assert_eq!(
        f.store
            .finalize_scan("compl2-unchanged", 1, &[(f.source.clone(), true)])
            .unwrap(),
        publication.revision
    );
    assert_eq!(f.store.get_card(&id).unwrap(), before);
    assert_eq!(
        f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
        "ready"
    );
    assert_eq!(f.store.get_card(&id).unwrap(), before);
}

#[test]
fn compl2_offline_or_unhealthy_source_never_marks_cover_unreadable() {
    for state in [
        "unavailable",
        "unknown",
        "observation-unavailable",
        "removed",
        "volume-offline",
        "transient-read",
    ] {
        let f = Fixture::new();
        let mut reference = f.item("reference.mbah", Some("Reference"), None, 1);
        let missing = f.root.join("source/missing.png");
        if state == "transient-read" {
            std::fs::create_dir(&missing).unwrap();
        }
        reference.observation.cover = Some(json!({"kind":"file","path":missing}));
        let id = f.publish(&[reference]);
        let card = f.store.get_card(&id).unwrap();
        let eid = card["reference"]["exemplarId"].as_str().unwrap();
        f.store.write(|tx| {
            match state {
                "unavailable" | "unknown" => {tx.execute("INSERT OR REPLACE INTO source_health(source_id,availability) VALUES (?1,?2)",rusqlite::params![f.source,state]).unwrap();},
                "observation-unavailable" => {tx.execute("UPDATE cache.observation SET state='unavailable' WHERE exemplar_id=?1",[eid]).unwrap();},
                "removed" => {tx.execute("UPDATE source SET status='removed' WHERE id=?1",[&f.source]).unwrap();},
                _ => {}
            }
            Ok(())
        }).unwrap();
        if state == "volume-offline" {
            std::fs::rename(f.root.join("source"), f.root.join("offline")).unwrap();
        }
        let before = f.store.get_card(&id).unwrap();
        assert_eq!(
            f.store.get_thumbnail(Some(eid), None, None).unwrap().state,
            "unreadable",
            "{state}"
        );
        assert_eq!(f.store.get_card(&id).unwrap(), before, "{state}");
        f.store.read_snapshot(|c| {
            assert_eq!(c.query_row("SELECT count(*) FROM cache.extracted_value WHERE candidate_key LIKE '@unreadable:%'",[],|r|r.get::<_,i64>(0))?,0,"{state}");
            Ok(())
        }).unwrap();
    }
}

#[test]
fn menage_same_uuid_joins_but_homonyms_and_unidentified_files_stay_independent() {
    let f = Fixture::new();
    let a = f.item("a.mbah", Some("Même titre"), None, 1);
    let b = f.item("b.mbah", Some("Même titre"), None, 1);
    let mut c = f.item("c.mbah", Some("Même titre"), None, 1);
    let identity = c.observation.identity.as_mut().unwrap();
    identity.value = Some("bda17862-0d71-41f6-974a-222222222222".into());
    identity.raw = json!(identity.value);
    let mut d = f.item("d.mbah", Some("Même titre"), None, 1);
    d.observation.identity = None;
    let mut e = f.item("e.mbah", Some("Même titre"), None, 1);
    e.observation.identity = None;
    f.publish(&[a, b, c, d, e]);
    let page = f.store.query_entries(200, None, true).unwrap();
    assert_eq!(page.items.len(), 4);
    let mut sizes = page
        .items
        .iter()
        .map(|c| c["exemplars"].as_array().unwrap().len())
        .collect::<Vec<_>>();
    sizes.sort();
    assert_eq!(sizes, [1, 1, 1, 2]);
    assert_eq!(
        f.store
            .read(|c| c.query_row(
                "SELECT count(*) FROM cache.sqlite_master WHERE name='suggestion'",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
    for kind in ["groupCards", "splitCard", "resolveSuggestion"] {
        assert!(serde_json::from_value::<journal::Mutation>(
            json!({"kind":kind,"requestKey":"retired"})
        )
        .is_err());
    }
}

#[test]
fn compl2_sibling_minimum_cannot_exceed_effective_maximum() {
    let f = Fixture::new();
    let reference = f.item("reference.mbah", Some("Reference"), None, 10);
    let id = f.publish(std::slice::from_ref(&reference));
    f.mutate(
        &id,
        json!([{"field":"ageMin","state":"source"},{"field":"ageMax","state":"defined","value":5}]),
    );
    let sibling = f.item("older.mbah", Some("Older"), Some(8), 1);
    f.publish(&[reference, sibling]);
    let card = f.store.get_card(&id).unwrap();
    assert!(field(&card, "ageMin")["effective"]["value"].is_null());
    assert_eq!(field(&card, "ageMax")["effective"]["value"], 5);
    // The retained edits and import share the same interval guard.
    assert!(f
        .store
        .read_snapshot(|c| mutate::metadata::age_interval_valid(c, &id))
        .unwrap());
    execute(&f,json!({"kind":"setReferenceExemplar","requestKey":"compl2-reference","ficheId":id,"expectedFicheRevision":card["ficheRevision"],"exemplarId":card["reference"]["exemplarId"]})).unwrap();
    f.mutate(
        &id,
        json!([{"field":"description","state":"defined","value":"Accepted"}]),
    );
    bulk_edit(
        &f,
        &id,
        json!({"language":{"state":"defined","value":"fr"}}),
    );
    assert!(field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"].is_null());
    let bulk = bulk_edit(
        &f,
        &id,
        json!({"language":{"state":"defined","value":"it"}}),
    );
    undo(&f, &bulk["undoToken"]).unwrap();
    // Valid older candidates remain eligible after skipping an invalid newer one.
    let valid = f.item("valid.mbah", Some("Valid"), Some(4), 0);
    f.publish(&[valid]);
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "ageMin")["effective"]["value"],
        4
    );
}

fn review1_retained_cover(f: &Fixture, id: &str) -> (Value, Vec<u8>) {
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(24, 24)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    f.store.lunii_cover_test_response(png.into_inner());
    let key = field_value(&f.store, id, "cover")["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = f.store.lunii_cover_bytes(id, &key).unwrap();
    f.store.retain_lunii_cover(id, &key, &bytes).unwrap();
    (field_value(&f.store, id, "cover"), bytes)
}

#[test]
fn luh_review1_forget_removes_pending_cover_and_releases_its_asset() {
    let (f, official, other) = cross_review_official_pair();
    let (cover, _) = review1_retained_cover(&f, &official);
    f.store.set_lunii_permission(false).unwrap();
    f.store
        .write(|tx| mutate::association::group(tx, &[other.clone(), official], &other, &[], false))
        .unwrap();
    f.store
        .write(|tx| {
            tx.execute("UPDATE source SET status='removed'", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    let preview = f
        .store
        .preview_forget(std::slice::from_ref(&other))
        .unwrap();
    assert_eq!(preview["items"][0]["counts"]["images"], 1);
    let detail = f.store.get_card(&other).unwrap();
    execute(&f, json!({"kind":"forgetUnreferencedCards","requestKey":"review1-forget","ficheIds":[other],"expectedFicheRevisions":{&other:detail["ficheRevision"]}})).unwrap();
    assert_eq!(
        f.store
            .read(
                |c| c.query_row("SELECT count(*) FROM lunii_pending_cover", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        0
    );
    f.store.clean_orphan_images().unwrap();
    assert!(!f
        .store
        .images_root()
        .join(cover["sha256"].as_str().unwrap())
        .exists());
}

#[test]
fn luh_review1_pending_cover_changed_path_does_not_restore_stale_images() {
    {
        let (f, official, other) = cross_review_official_pair();
        let (cover, _) = review1_retained_cover(&f, &official);
        f.store.set_lunii_permission(false).unwrap();
        f.store
            .write(|tx| {
                mutate::association::group(
                    tx,
                    &[other.clone(), official.clone()],
                    &other,
                    &[],
                    false,
                )
            })
            .unwrap();
        assert_eq!(
            f.store
                .read(
                    |c| c.query_row("SELECT count(*) FROM lunii_pending_cover", [], |r| r
                        .get::<_, i64>(0))
                )
                .unwrap(),
            1
        );
        {
            f.store.write(|tx| {
                tx.execute("UPDATE lunii_pack SET document_json=json_set(document_json,'$.localized_infos.fr_FR.imagePath','/public/images/new.png')", []).map_err(crate::services::catalogue::store::error)?;
                Ok(())
            }).unwrap();
            f.store.set_lunii_permission(true).unwrap();
            f.store
                .write(|tx| {
                    crate::services::catalogue::lunii_db::fill_missing(tx)?;
                    Ok(())
                })
                .unwrap();
            let after = field_value(&f.store, &other, "cover");
            assert_ne!(after["key"], cover["key"]);
            assert!(after["sha256"].is_null());
            assert_eq!(
                f.store
                    .read(
                        |c| c.query_row("SELECT count(*) FROM lunii_pending_cover", [], |r| r
                            .get::<_, i64>(0))
                    )
                    .unwrap(),
                0
            );
        }
        assert_eq!(f.store.lunii_cover_test_requests(), 1);
    }
}

#[test]
fn missing_exemplar_removal_preserves_other_copies_and_guards_state() {
    let f = Fixture::new();
    let id = f.publish(&[
        f.item("one.mbah", Some("One"), None, 1),
        f.item("two.mbah", Some("Two"), None, 2),
    ]);
    let card = f.store.get_card(&id).unwrap();
    let revision = card["catalogueRevision"].as_i64().unwrap();
    let entry = f
        .store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .remove(0);
    let exemplar = entry["exemplars"][0]["id"].as_str().unwrap().to_owned();
    let other = entry["exemplars"][1].clone();
    let before = f.pack_fingerprints();
    assert_eq!(
        f.store
            .remove_missing_exemplar(&exemplar, revision)
            .unwrap_err()
            .code,
        "CATALOG_EXEMPLAR_NOT_MISSING"
    );
    f.store.write(|tx| {
        tx.execute("UPDATE cache.observation SET state='missing' WHERE exemplar_id=?1", [&exemplar]).unwrap();
        tx.execute("INSERT OR REPLACE INTO source_health(source_id,availability) VALUES (?1,'unavailable')", [&f.source]).unwrap();
        Ok(())
    }).unwrap();
    // Even a cached missing observation is insufficient on a disconnected disk.
    assert_eq!(
        f.store
            .remove_missing_exemplar(&exemplar, revision)
            .unwrap_err()
            .code,
        "CATALOG_EXEMPLAR_NOT_MISSING"
    );
    f.store
        .write(|tx| {
            tx.execute("DELETE FROM source_health", []).unwrap();
            tx.execute(
                "UPDATE cache.observation SET state='unavailable' WHERE exemplar_id=?1",
                [&exemplar],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store
            .remove_missing_exemplar(&exemplar, revision)
            .unwrap_err()
            .code,
        "CATALOG_EXEMPLAR_NOT_MISSING"
    );
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE cache.observation SET state='missing' WHERE exemplar_id=?1",
                [&exemplar],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store
            .remove_missing_exemplar(&exemplar, revision - 1)
            .unwrap_err()
            .code,
        "CATALOG_REVISION_CONFLICT"
    );
    let result = f
        .store
        .remove_missing_exemplar(&exemplar, revision)
        .unwrap();
    assert_eq!(result["catalogueRevision"], revision + 1);
    let entry = f
        .store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .remove(0);
    assert_eq!(entry["exemplars"], json!([other]));
    assert_eq!(f.pack_fingerprints(), before);
    assert_eq!(
        f.store
            .remove_missing_exemplar(&exemplar, revision + 1)
            .unwrap_err()
            .code,
        "CATALOG_EXEMPLAR_NOT_MISSING"
    );
}

#[test]
fn missing_exemplar_removal_last_live_copy_uses_card_erasure() {
    let f = Fixture::new();
    let id = f.publish(&[
        f.item("one.mbah", Some("One"), None, 1),
        f.item("retired.mbah", Some("Retired"), None, 2),
    ]);
    tag(&f, &id, "Dernière");
    let card = f.store.get_card(&id).unwrap();
    let revision = card["catalogueRevision"].as_i64().unwrap();
    let entry = f
        .store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .remove(0);
    let exemplar = entry["exemplars"][0]["id"].as_str().unwrap();
    let before = f.pack_fingerprints();
    f.store
        .write(|tx| {
            tx.execute("UPDATE exemplar SET retired=1 WHERE id!=?1", [exemplar])
                .unwrap();
            tx.execute("UPDATE cache.observation SET state='missing'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    f.store.remove_missing_exemplar(exemplar, revision).unwrap();
    assert!(f
        .store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .is_empty());
    let count = f
        .store
        .read_snapshot(|c| {
            c.query_row(
                "SELECT count(*) FROM operation WHERE kind='removeCards'",
                [],
                |r| r.get::<_, i64>(0),
            )
        })
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(f.pack_fingerprints(), before);
    assert!(f.store.list_tags().unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn retired_cover_reference_uses_surviving_covers_without_changing_metadata() {
    for remaining_cover in [true, false] {
        let f = Fixture::new();
        let image = f.root.join("cover.png");
        image::RgbImage::new(16, 16).save(&image).unwrap();
        let mut reference = f.item("reference.mbah", Some("Reference"), None, 10);
        reference.observation.cover = Some(json!({"kind":"file","path":image}));
        let id = f.publish(std::slice::from_ref(&reference));
        let original = f.store.get_card(&id).unwrap()["reference"].clone();
        let reference_id = original["exemplarId"].as_str().unwrap();
        let mut siblings = Vec::new();
        for (name, modified) in [("newer.mbah", 8), ("older.mbah", 6)] {
            let mut sibling = f.item(name, Some("Sibling"), None, modified);
            if remaining_cover {
                sibling.observation.cover = Some(json!({"kind":"file","path":image}));
            }
            siblings.push(sibling);
        }
        f.publish(&[reference, siblings[0].clone(), siblings[1].clone()]);
        assert_eq!(
            f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
            "ready"
        );
        // Same catalogue retirement as a completed file removal; metadata is retained.
        f.store
            .write(|tx| {
                tx.execute("UPDATE exemplar SET retired=1 WHERE id=?1", [reference_id])
                    .unwrap();
                tx.execute(
                    crate::services::catalogue::grouping::RETIRE_OBSERVATION,
                    [reference_id],
                )
                .unwrap();
                tx.execute(
                    "DELETE FROM cache.coverage WHERE exemplar_id=?1",
                    [reference_id],
                )
                .unwrap();
                tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [&id])
                    .unwrap();
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .unwrap();
                Ok(())
            })
            .unwrap();
        let candidates = f
            .store
            .read_snapshot(|c| super::card::cover_exemplars(c, &id))
            .unwrap();
        assert!(!candidates.iter().any(|candidate| candidate == reference_id));
        assert_eq!(candidates.len(), if remaining_cover { 2 } else { 0 });
        for candidate in &candidates {
            assert_eq!(
                f.store
                    .get_thumbnail(Some(candidate), None, None)
                    .unwrap()
                    .state,
                "ready"
            );
        }
        assert_eq!(
            f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
            if remaining_cover { "ready" } else { "absent" }
        );
        let after = f.store.get_card(&id).unwrap();
        assert_eq!(after["reference"]["exemplarId"], original["exemplarId"]);
        assert_eq!(field(&after, "title")["effective"]["value"], "Reference");
        // An intentional cover removal still wins over all file covers.
        f.mutate(&id, json!([{"field":"cover","state":"cleared"}]));
        assert_eq!(
            f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
            "absent"
        );
    }
}

#[test]
fn absent_thumbnail_candidate_does_not_hide_readable_sibling() {
    let f = Fixture::new();
    let image = f.root.join("cover.png");
    image::RgbImage::new(16, 16).save(&image).unwrap();
    let mut reference = f.item("reference.mbah", Some("Reference"), None, 10);
    reference.observation.cover = Some(json!({"kind":"file","path":image}));
    let id = f.publish(std::slice::from_ref(&reference));
    let reference_id = f.store.get_card(&id).unwrap()["reference"]["exemplarId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut sibling = f.item("sibling.mbah", Some("Sibling"), None, 8);
    sibling.observation.cover = Some(json!({"kind":"file","path":image}));
    f.publish(&[reference, sibling]);
    // The candidate projection still knows a cover, but its byte source is absent.
    f.store.write(|tx| {
        tx.execute("UPDATE cache.observation SET raw_observation_json=json_set(raw_observation_json,'$.cover',NULL) WHERE exemplar_id=?1", [&reference_id]).unwrap();
        Ok(())
    }).unwrap();
    assert_eq!(
        f.store
            .get_thumbnail(Some(&reference_id), None, None)
            .unwrap()
            .state,
        "absent"
    );
    assert_eq!(
        f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
        "ready"
    );
}

fn listed_cover_signatures(f: &Fixture) -> std::collections::BTreeMap<String, String> {
    f.store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .into_iter()
        .map(|entry| {
            (
                entry["id"].as_str().unwrap().to_owned(),
                entry["coverSignature"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

/// The fiche thumbnail must carry exactly the signature the list publishes
/// for the same state: the front keys its cache with the listed one.
fn served_thumbnail(f: &Fixture, id: &str) -> crate::services::catalogue::thumbnails::Thumbnail {
    let thumbnail = f.store.get_thumbnail(None, Some(id), None).unwrap();
    assert_eq!(
        thumbnail.signature.as_deref(),
        Some(listed_cover_signatures(f)[id].as_str()),
        "served and listed signatures agree"
    );
    thumbnail
}

fn coloured_png(path: &std::path::Path, colour: [u8; 3]) {
    image::RgbImage::from_pixel(16, 16, image::Rgb(colour))
        .save(path)
        .unwrap();
}

fn exemplar_ids(f: &Fixture, card: &str) -> Vec<String> {
    f.store
        .read(|c| {
            c.prepare("SELECT id FROM exemplar WHERE fiche_id=?1 AND retired=0 ORDER BY id")?
                .query_map([card], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

#[test]
fn thumbnail_signature_tracks_cover_inputs_without_catalogue_metadata() {
    let f = Fixture::new();
    let (red, blue) = (f.root.join("red.png"), f.root.join("blue.png"));
    coloured_png(&red, [255, 0, 0]);
    coloured_png(&blue, [0, 0, 255]);
    let mut reference = f.item("reference.mbah", Some("Reference"), None, 10);
    reference.observation.cover = Some(json!({"kind":"file","path":red}));
    let id = f.publish(std::slice::from_ref(&reference));
    let mut sibling = f.item("sibling.mbah", Some("Sibling"), None, 8);
    sibling.observation.cover = Some(json!({"kind":"file","path":blue}));
    let mut other = f.item("other.mbah", Some("Other"), None, 6);
    other.observation.identity.as_mut().unwrap().value =
        Some("22345678-1234-4234-8234-123456789abc".into());
    f.publish(&[reference.clone(), sibling.clone(), other]);
    let original = listed_cover_signatures(&f);
    assert_eq!(original.len(), 2);
    assert!(original.values().all(|s| s.len() == 64));
    let served = served_thumbnail(&f, &id);
    // Fiche answer shape shared with the front adapter fixture.
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/thumbnail-fiche.json"
    ))
    .unwrap();
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(
        keys(&serde_json::to_value(&served).unwrap()),
        keys(&fixture)
    );
    let red_bytes = served.bytes.unwrap();

    organize(
        &f,
        json!({"kind":"setFavorite","ficheIds":[id],"value":true,"expectedFicheRevisions":{&id:f.store.get_card(&id).unwrap()["ficheRevision"]}}),
    )
    .unwrap();
    assert_eq!(listed_cover_signatures(&f), original, "favorite");
    tag(&f, &id, "Étiquette");
    assert_eq!(listed_cover_signatures(&f), original, "tags");

    // Same durable retirement as a completed trash operation.
    let other_id = original.keys().find(|key| *key != &id).unwrap().clone();
    for exemplar in exemplar_ids(&f, &other_id) {
        f.store.retire_exemplar(&other_id, &exemplar).unwrap();
    }
    assert_eq!(
        listed_cover_signatures(&f)[&id],
        original[&id],
        "another fiche trashed"
    );

    sibling.token = "changed-secondary-content".into();
    sibling.modified = 9;
    f.publish(&[reference, sibling.clone()]);
    assert_eq!(
        listed_cover_signatures(&f)[&id],
        original[&id],
        "a secondary cover cannot invalidate the current supplier"
    );
    assert_eq!(served_thumbnail(&f, &id).bytes.unwrap(), red_bytes);

    let ref_id = f.store.get_card(&id).unwrap()["reference"]["exemplarId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.store.retire_exemplar(&id, &ref_id).unwrap();
    let after_trash = listed_cover_signatures(&f);
    assert_ne!(after_trash[&id], original[&id], "trashing the supplier");
    let blue_bytes = served_thumbnail(&f, &id).bytes.unwrap();
    assert_ne!(blue_bytes, red_bytes, "the surviving supplier's image");

    sibling.token = "changed-content".into();
    sibling.modified = 20;
    f.publish(std::slice::from_ref(&sibling));
    let after_content = listed_cover_signatures(&f);
    assert_ne!(
        after_content[&id], after_trash[&id],
        "supplier content revision"
    );
    served_thumbnail(&f, &id);

    // An offline supplier answers a transient failure: its availability is
    // part of the key, so reconnecting requests the cover again.
    let health = |availability: Option<&str>| {
        f.store
            .write(|tx| {
                match availability {
                    Some(state) => tx.execute("INSERT OR REPLACE INTO source_health(source_id,availability) VALUES (?1,?2)", rusqlite::params![f.source, state]),
                    None => tx.execute("DELETE FROM source_health WHERE source_id=?1", [&f.source]),
                }
                .unwrap();
                tx.execute("UPDATE catalogue SET revision=revision+1", []).unwrap();
                Ok(())
            })
            .unwrap();
    };
    health(Some("unavailable"));
    let offline = listed_cover_signatures(&f);
    assert_ne!(offline[&id], after_content[&id], "supplier went offline");
    served_thumbnail(&f, &id);
    // Unknown health keeps the candidate but the engine does not read it.
    health(Some("unknown"));
    let unknown = listed_cover_signatures(&f);
    assert_ne!(
        unknown[&id], after_content[&id],
        "supplier not confirmed available"
    );
    assert_ne!(unknown[&id], offline[&id]);
    served_thumbnail(&f, &id);
    health(None);
    assert_eq!(
        listed_cover_signatures(&f)[&id],
        after_content[&id],
        "back online: the key of the available supplier again"
    );

    let stage = f.store.stage_cover(&red).unwrap();
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]),
    );
    let corrected = listed_cover_signatures(&f);
    assert_ne!(corrected[&id], after_content[&id], "cover correction");
    assert_eq!(served_thumbnail(&f, &id).state, "ready");
    f.mutate(
        &id,
        json!([{"field":"title","state":"defined","value":"New title"}]),
    );
    assert_eq!(listed_cover_signatures(&f), corrected, "title correction");
    f.mutate(&id, json!([{"field":"cover","state":"cleared"}]));
    assert_ne!(
        listed_cover_signatures(&f)[&id],
        corrected[&id],
        "cleared cover"
    );
    assert_eq!(served_thumbnail(&f, &id).state, "absent");
}

#[test]
fn thumbnail_signature_skips_a_supplier_found_unreadable() {
    let f = Fixture::new();
    let (corrupt, blue) = (f.root.join("corrupt.png"), f.root.join("blue.png"));
    std::fs::write(&corrupt, b"not an image").unwrap();
    coloured_png(&blue, [0, 0, 255]);
    let mut reference = f.item("reference.mbah", Some("Reference"), None, 10);
    reference.observation.cover = Some(json!({"kind":"file","path":corrupt}));
    let id = f.publish(std::slice::from_ref(&reference));
    let mut sibling = f.item("sibling.mbah", Some("Sibling"), None, 8);
    sibling.observation.cover = Some(json!({"kind":"file","path":blue}));
    f.publish(&[reference, sibling]);
    let before = listed_cover_signatures(&f)[&id].clone();
    // Reading records the conclusive failure, which changes the inputs during
    // the request: the answer is recomputed from the new state and carries
    // its signature, never `before`.
    let served = served_thumbnail(&f, &id);
    assert_eq!(served.state, "ready", "the sibling supplies the cover");
    let after = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(after, before, "the @unreadable marker skips the supplier");
    assert_eq!(served.signature.as_deref(), Some(after.as_str()));
}

#[test]
fn thumbnail_signature_follows_the_official_image() {
    let f = Fixture::new();
    let blue = f.root.join("blue.png");
    coloured_png(&blue, [0, 0, 255]);
    let mut pack = f.item("pack.mbah", Some("Pack"), None, 10);
    pack.observation.cover = Some(json!({"kind":"file","path":blue}));
    let id = f.publish(std::slice::from_ref(&pack));
    let file_only = listed_cover_signatures(&f)[&id].clone();
    official_lunii(&f);
    let pending = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(
        pending, file_only,
        "an official image is an input before retention"
    );
    review1_retained_cover(&f, &id);
    let retained = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(retained, pending, "retained official image");
    assert_eq!(served_thumbnail(&f, &id).state, "ready");
    pack.token = "changed-content".into();
    pack.modified = 20;
    f.publish(std::slice::from_ref(&pack));
    assert_eq!(
        listed_cover_signatures(&f)[&id],
        retained,
        "the file supplier no longer decides the displayed image"
    );
}

/// Paged list cost on a large synthetic catalogue, each fiche with a cover.
/// `CATALOGUE_LIST_BENCH_FICHES` (default 20 000).
#[test]
#[ignore = "explicit measure: cargo test list_entries_cover_signature_measure -- --ignored --nocapture"]
fn list_entries_cover_signature_measure() {
    let count: usize = std::env::var("CATALOGUE_LIST_BENCH_FICHES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    let f = Fixture::new();
    let template = f.item("template.mbah", Some("Template"), None, 1);
    let items: Vec<_> = (0..count)
        .map(|i| {
            let mut item = template.clone();
            let path = f.root.join("source").join(format!("bench-{i}.mbah"));
            item.path = path.to_string_lossy().into();
            item.path_key = item.path.as_bytes().to_vec();
            item.token = format!("bench-{i}");
            let uuid = format!("{:08x}-1234-4234-8234-123456789abc", i);
            let identity = item.observation.identity.as_mut().unwrap();
            identity.raw = json!(uuid);
            identity.value = Some(uuid);
            item.observation.cover = Some(json!({"kind":"file","path":path}));
            item
        })
        .collect();
    let started = Instant::now();
    f.store
        .publish_scan("bench", 1, &items, &[(f.source.clone(), true)])
        .unwrap();
    eprintln!("publish {count} fiches: {:?}", started.elapsed());
    for (label, skip) in [("without signature", true), ("with signature", false)]
        .into_iter()
        .cycle()
        .take(6)
    {
        crate::services::catalogue::grouping::SKIP_COVER_SIGNATURE.with(|s| s.set(skip));
        let started = Instant::now();
        let (mut cursor, mut total) = (None::<String>, 0);
        loop {
            let page = f.store.query_entries(200, cursor.as_deref(), true).unwrap();
            total += page.items.len();
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(total, count);
        eprintln!("list {label}: {count} entries in {:?}", started.elapsed());
    }
}

mod cover_store;

#[test]
fn storyteller_card_adapter_resolves_uuid_and_journals_device_rename() {
    use crate::services::storyteller_device::cards::CardCatalogue;
    let f = Fixture::new();
    let id = uuid::Uuid::parse_str("12345678-1234-4234-8234-123456789abc").unwrap();
    let card_id = f.publish(&[f.item("histoire.mbah", Some("Avant"), Some(4), 1)]);
    let before = f.pack_fingerprints();
    let card = CardCatalogue::card(&f.store, id).unwrap().unwrap().card;
    assert_eq!(card.title, "Avant");
    assert_eq!(card.age_min, Some(4));
    f.mutate(
        &card_id,
        json!([{"field":"description","state":"defined","value":"Corrigée"}]),
    );
    assert_eq!(
        CardCatalogue::card(&f.store, id)
            .unwrap()
            .unwrap()
            .card
            .description,
        "Corrigée"
    );
    // The UUID belongs to a grouped member: metadata and renames use its target.
    f.store
        .write(|tx| {
            tx.execute("INSERT INTO fiche VALUES ('device-member',1,0,1)", [])
                .map_err(super::super::store::error)?;
            tx.execute(
                "UPDATE pack_identity SET fiche_id='device-member' WHERE pack_uuid=?1",
                [id.to_string()],
            )
            .map_err(super::super::store::error)?;
            tx.execute(
                "INSERT INTO fiche_grouping VALUES ('device-member',?1)",
                [&card_id],
            )
            .map_err(super::super::store::error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        CardCatalogue::card(&f.store, id)
            .unwrap()
            .unwrap()
            .card
            .description,
        "Corrigée"
    );
    CardCatalogue::save_name(&f.store, id, "Depuis la conteuse").unwrap();
    assert_eq!(
        CardCatalogue::card(&f.store, id)
            .unwrap()
            .unwrap()
            .card
            .title,
        "Depuis la conteuse"
    );
    assert_eq!(before, f.pack_fingerprints());
    assert!(CardCatalogue::card(&f.store, uuid::Uuid::nil())
        .unwrap()
        .is_none());
    CardCatalogue::save_name(&f.store, uuid::Uuid::nil(), "Sans pack").unwrap();
    f.store.write(|tx| {
        tx.execute("INSERT INTO lunii_pack(uuid,document_json) VALUES (?1,?2)", rusqlite::params![id.to_string(),json!({"localized_infos":{"fr_FR":{"title":"Officielle FR"},"it_IT":{"title":"Ufficiale IT"}}}).to_string()]).map_err(super::super::store::error)?;
        tx.execute("UPDATE lunii_context SET locale='it_IT'",[]).map_err(super::super::store::error)?;
        Ok(())
    }).unwrap();
    assert_eq!(
        CardCatalogue::official_title(&f.store, id)
            .unwrap()
            .as_deref(),
        Some("Ufficiale IT")
    );
}

#[test]
fn chosen_project_cover_precedes_archive_and_keeps_supplier_for_assembly() {
    // These are real .mbah envelopes, analyzed through the production reader.
    for (fields, chosen) in [
        (json!({}), false),
        (json!({"thumbnailImage":"cover.png"}), true),
        (json!({"rootImage":"cover.png"}), false),
        (
            json!({"thumbnailImage":"cover.png","rootImage":"cover.png","sameImage":true}),
            false,
        ),
        (
            json!({"thumbnailImage":"cover.png","rootImage":"cover.png","sameImage":false}),
            true,
        ),
        (
            json!({"thumbnailImage":"missing.png","sameImage":false}),
            false,
        ),
    ] {
        let f = Fixture::new();
        let mut zip = f.item("reference.zip", Some("Archive"), None, 100);
        zip.observation.format = "zip".into();
        let archive_cover = json!({"path":f.root.join("archive.png"),"available":true});
        image::RgbImage::new(16, 16)
            .save(f.root.join("archive.png"))
            .unwrap();
        zip.observation.cover = Some(archive_cover.clone());
        let id = f.publish(std::slice::from_ref(&zip));
        assert_eq!(field_value(&f.store, &id, "cover"), archive_cover);
        let reference = f.store.get_card(&id).unwrap()["reference"].clone();
        let mut project = f.item("project.mbah", Some("Project"), None, 1);
        image::RgbImage::new(16, 16)
            .save(f.root.join("source/cover.png"))
            .unwrap();
        let mut raw = fields;
        raw["packMetadata"] = json!({"uuid":"12345678-1234-4234-8234-123456789abc"});
        std::fs::write(&project.path, raw.to_string()).unwrap();
        project.observation = analyze::project(std::path::Path::new(&project.path)).unwrap();
        if raw["thumbnailImage"] == "missing.png" {
            assert_eq!(
                project.observation.cover.as_ref().unwrap()["available"],
                false
            );
        }
        let project_cover = project.observation.cover.clone();
        f.publish(&[zip, project]);
        let expected = if chosen {
            project_cover.unwrap()
        } else {
            archive_cover
        };
        assert_eq!(field_value(&f.store, &id, "cover"), expected);
        assert_eq!(
            f.store.get_thumbnail(None, Some(&id), None).unwrap().state,
            "ready"
        );
        assert_eq!(field_value(&f.store, &id, "cover"), expected);
        assert_eq!(f.store.get_card(&id).unwrap()["reference"], reference);
        f.store
            .read_snapshot(|c| {
                let ids = card::cover_exemplars(c, &id)?;
                assert_eq!(Some(&ids[0]), card::cover_exemplar(c, &id)?.as_ref());
                let raw: String = c.query_row(
                    "SELECT raw_observation_json FROM cache.observation WHERE exemplar_id=?1",
                    [&ids[0]],
                    |r| r.get(0),
                )?;
                assert_eq!(
                    serde_json::from_str::<Value>(&raw).unwrap()["cover"],
                    expected,
                    "assembly compares the effective value with the supplying observation"
                );
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn chosen_project_covers_sort_by_recency_then_id_below_official_and_correction() {
    let f = Fixture::new();
    let mut zip = f.item("reference.zip", Some("Archive"), None, 100);
    zip.observation.format = "zip".into();
    zip.observation.cover = Some(json!("archive-cover"));
    let id = f.publish(std::slice::from_ref(&zip));
    let mut older = f.item("older.mbah", Some("Older"), None, 1);
    older.observation.raw = json!({"thumbnailImage":"older.png"});
    older.observation.cover = Some(json!("older-cover"));
    let mut newer = f.item("newer.mbah", Some("Newer"), None, 2);
    newer.observation.raw = json!({"thumbnailImage":"newer.png"});
    newer.observation.cover = Some(json!("newer-cover"));
    f.publish(&[zip.clone(), older.clone(), newer.clone()]);
    assert_eq!(field_value(&f.store, &id, "cover"), "newer-cover");
    f.store
        .read_snapshot(|c| {
            let ids = card::cover_exemplars(c, &id)?;
            let covers: Vec<_> = ids
                .iter()
                .map(|id| {
                    card::cached_candidates(c, id).unwrap().unwrap()
                        [&("cover".into(), String::new())]["value"]
                        .clone()
                })
                .collect();
            assert_eq!(
                covers,
                vec![
                    json!("newer-cover"),
                    json!("older-cover"),
                    json!("archive-cover")
                ]
            );
            Ok(())
        })
        .unwrap();
    older.modified = 2;
    older.token = "tie".into();
    f.publish(&[zip, older, newer]);
    f.store
        .read_snapshot(|c| {
            let ids = card::cover_exemplars(c, &id)?;
            assert!(ids[0] < ids[1], "equal dates use ascending stable ids");
            Ok(())
        })
        .unwrap();
    official_lunii(&f);
    assert_eq!(field_value(&f.store, &id, "cover")["kind"], "lunii");
    let image = f.root.join("personal.png");
    image::RgbImage::new(16, 16).save(&image).unwrap();
    let staged = f.store.stage_cover(&image).unwrap();
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":staged["coverStagingId"]}]),
    );
    assert_eq!(
        field(&f.store.get_card(&id).unwrap(), "cover")["effective"]["origin"],
        "correction"
    );
    assert_ne!(field_value(&f.store, &id, "cover")["kind"], "lunii");
}
