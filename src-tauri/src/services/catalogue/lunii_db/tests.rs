struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("lunii-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
use super::super::data::resolver::{resolve_with_lunii, Correction, Corrections, References};
use super::*;
fn fixture() -> Value {
    json!({"arbitrary-key":{"uuid":"AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE","age_min":5,"keywords":"aventure, lune","localized_infos":{"fr_FR":{"title":"Lune","subtitle":"Voyage","description":"Récit","image":{"image_url":"/public/images/packs/test.png"}},"en_US":{"title":"Moon"},"it_IT":{"title":"Luna"}}}})
}
fn store() -> (Temp, Arc<Store>) {
    let temp = Temp::new();
    let s = Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap();
    s.set_lunii_permission(true).unwrap();
    s.lunii_locale("fr").unwrap();
    (temp, Arc::new(s))
}
#[test]
fn parse_wrappers_normalized_uuid_and_locales() {
    let raw = fixture();
    let a = parse::parse(&serde_json::to_vec(&raw).unwrap()).unwrap();
    let b =
        parse::parse(&serde_json::to_vec(&json!({"code":"0.0","response":raw})).unwrap()).unwrap();
    assert_eq!(a, b);
    let pack = &a["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"];
    for (l, expected, title) in [
        ("fr", "fr_FR", "Lune"),
        ("en-GB", "en_US", "Moon"),
        ("it_IT", "it_IT", "Luna"),
        ("de", "en_US", "Moon"),
    ] {
        let (locale, values) = parse::localized(pack, l).unwrap();
        assert_eq!(locale, expected);
        assert_eq!(values["title"], title);
        assert_eq!(values["ageMin"], 5);
    }
    let mut bilingual = pack.clone();
    bilingual["localized_infos"]["en_GB"] = json!({"title":"Moon UK"});
    assert_eq!(
        parse::localized(&bilingual, "en_US").unwrap().1["title"],
        "Moon"
    );
    assert_eq!(
        parse::localized(&bilingual, "en-GB").unwrap().1["title"],
        "Moon UK"
    );
    let (l, _) =
        parse::localized(&json!({"localized_infos":{"es_ES":{"title":"Luna"}}}), "en").unwrap();
    assert_eq!(l, "es_ES");
    for bad in [
        json!({}),
        json!({"response":[]}),
        json!({"bad":{"uuid":"invalid"}}),
    ] {
        assert!(parse::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
}
#[test]
fn validated_database_is_atomic_and_survives_restart() {
    let (temp, s) = store();
    let path = temp.path().join("official.json");
    std::fs::write(&path, fixture().to_string()).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(s.load_lunii_fixture(&path).unwrap()["entryCount"], 1);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let old = s.lunii_status().unwrap();
    std::fs::write(&path, "invalid").unwrap();
    assert!(s.load_lunii_fixture(&path).is_err());
    assert_eq!(s.lunii_status().unwrap(), old);
    std::fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
    assert!(s.load_lunii_fixture(&path).is_err());
    assert_eq!(s.lunii_status().unwrap(), old);
    let index = parse::parse(&before).unwrap();
    let cancel = AtomicBool::new(true);
    assert!(s.publish_lunii(&index, "network", &cancel).is_err());
    assert_eq!(s.lunii_status().unwrap(), old);
    drop(s);
    let s = Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap();
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
}
#[test]
fn precedence_per_field_clears_and_derived_renames() {
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    let (_, v) = parse::localized(index.values().next().unwrap(), "fr").unwrap();
    let values = v.as_object().unwrap().clone();
    let names = vec!["3+] Fichier.zip".into(), "7+Autre.zip".into()];
    let resolve = |r, c| resolve_with_lunii(r, c, &names, values.clone(), Some("fr_FR".into()));
    let out = resolve(References::new(), Corrections::new());
    assert_eq!(out.values["title"], "Lune");
    assert_eq!(out.values["ageMin"], 5);
    assert!(!out.age_conflict);
    assert!(out.title_conflict);
    let refs = References::from([(("title".into(), "".into()), (json!("Pack"), "file".into()))]);
    assert_eq!(
        resolve(refs.clone(), Corrections::new()).values["title"],
        "Lune"
    );
    for (state, value) in [("defined", Some(json!("Manuel"))), ("cleared", None)] {
        let c = Corrections::from([(
            ("title".into(), "".into()),
            Correction {
                state: state.into(),
                value,
            },
        )]);
        let out = resolve(refs.clone(), c);
        if state == "cleared" {
            assert!(!out.values.contains_key("title"));
        } else {
            assert_eq!(out.values["title"], "Manuel");
        }
    }
    for (name, title, age) in [
        ("[FR] 3+] Titre - Titre_1234567890.mbah", "Titre", 3),
        ("8+Renommé.zip", "Renommé", 8),
    ] {
        let r = resolve_with_lunii(
            References::new(),
            Corrections::new(),
            &[name.into()],
            Default::default(),
            None,
        );
        assert!(!r.values.contains_key("title"));
        assert_eq!(
            r.fields
                .iter()
                .find(|f| f.field == "title")
                .unwrap()
                .effective["value"],
            title
        );
        assert_eq!(r.age_from_name, Some(age));
        assert!(r.corrections.is_empty());
    }
    assert_eq!(clean("Histoire - Sous-titre.zip"), "Histoire - Sous-titre");
}
#[test]
fn local_server_download_token_header_and_offline_preserves_cache() {
    let _network = bounded::test_network();
    use std::io::Write;
    use std::net::TcpListener;
    let (_temp, s) = store();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::spawn(move || {
        for i in 0..2 {
            let (mut socket, _) = accept_local(&listener);
            socket
                .set_read_timeout(Some(crate::test_support::timeout()))
                .unwrap();
            let headers = bounded::read_request(&mut socket).to_lowercase();
            if i == 1 {
                assert!(headers.contains("x-auth-token: secret"));
            }
            let body = if i == 0 {
                json!({"response":{"token":{"server":"secret"}}}).to_string()
            } else {
                fixture().to_string()
            };
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let sink: scan::Sink = Arc::new(|_, _| {});
    let opened = s
        .open_lunii_from(
            "fr",
            sink.clone(),
            format!("http://{addr}/auth"),
            format!("http://{addr}/packs"),
        )
        .unwrap();
    let receipt = opened["operation"].clone();
    assert!(!receipt.is_null());
    assert!(s
        .open_lunii_from(
            "fr",
            sink.clone(),
            format!("http://{addr}/auth"),
            format!("http://{addr}/packs")
        )
        .unwrap()["operation"]
        .is_null());
    let wait = |receipt: &Value| {
        let deadline = Instant::now() + crate::test_support::timeout();
        loop {
            let p = s
                .get_operation(receipt["operationId"].as_str().unwrap())
                .unwrap();
            if matches!(p.status.as_str(), "success" | "failed" | "cancelled") {
                break p;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    assert_eq!(wait(&receipt).status, "success");
    crate::test_support::join(server);
    assert_eq!(s.lunii_status().unwrap()["source"], "network");
    let old = s.lunii_status().unwrap();
    let receipt = s
        .refresh_lunii_from(
            "offline".into(),
            sink,
            format!("http://{addr}/auth"),
            format!("http://{addr}/packs"),
        )
        .unwrap();
    assert_eq!(wait(&receipt).status, "failed");
    assert_eq!(s.lunii_status().unwrap(), old);
}
#[test]
fn existing_database_open_never_downloads() {
    let (_temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let result = s.open_lunii("it", Arc::new(|_, _| {})).unwrap();
    assert!(result["operation"].is_null());
}
#[test]
fn incremental_scan_recalculates_names_and_card_matches_listing() {
    let (temp, s) = store();
    let root = temp.path().join("source");
    std::fs::create_dir_all(&root).unwrap();
    let first = root.join("3+] Premier.mbah");
    let raw = json!({"packMetadata":{"uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}}).to_string();
    std::fs::write(&first, &raw).unwrap();
    s.add_source(&root, 0, false).unwrap();
    let scan = || {
        let receipt = s
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                s.list_sources().unwrap().sources_revision,
                temp.path().join("cache"),
                temp.path().join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        let until = Instant::now() + crate::test_support::timeout();
        loop {
            let p = s.get_operation(&receipt.operation_id).unwrap();
            if !matches!(p.status.as_str(), "queued" | "running" | "cancelling") {
                assert_eq!(p.status, "success");
                break;
            }
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    scan();
    let page = s.query_entries(200, None, true).unwrap();
    assert_eq!(page.items.len(), 1);
    let id = page.items[0]["id"].as_str().unwrap().to_owned();
    assert!(page.items[0]["values"]["title"].is_null());
    assert_eq!(page.items[0]["displayTitle"], "Premier");
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    // Once filled in French, changing interface locale never rewrites the fiche.
    for (locale, title) in [
        ("fr", "Lune"),
        ("en", "Moon"),
        ("en-US", "Moon"),
        ("it", "Luna"),
    ] {
        s.set_lunii_permission(true).unwrap();
        s.lunii_locale(locale).unwrap();
        let entry = s.query_entries(200, None, true).unwrap().items.remove(0);
        assert_eq!(entry["values"]["title"], title);
        assert_eq!(entry["values"]["ageMin"], 5);
        let card = s.get_card(&id).unwrap();
        let title_field = card["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["field"] == "title")
            .unwrap();
        assert_eq!(title_field["effective"]["value"], title);
        assert_eq!(title_field["effective"]["origin"], "lunii");
        assert!(!card.to_string().contains("https://storage.googleapis.com"));
    }
    s.write(|tx| {
        tx.execute("DELETE FROM lunii_pack", []).map_err(error)?;
        Ok(())
    })
    .unwrap();
    let renamed = root.join("8+Renommé.mbah");
    std::fs::rename(&first, &renamed).unwrap();
    scan();
    let page = s.query_entries(200, None, true).unwrap();
    let entry = page.items.iter().find(|e| e["id"] == id).unwrap();
    assert_eq!(entry["values"]["title"], "Luna");
    assert_eq!(entry["values"]["ageMin"], 5);
    assert_eq!(std::fs::read_to_string(&renamed).unwrap(), raw);
    let variant = root.join("8+Autre.mbah");
    std::fs::write(&variant, &raw).unwrap();
    scan();
    let page = s.query_entries(200, None, true).unwrap();
    let entry = page.items.iter().find(|e| e["id"] == id).unwrap();
    assert_eq!(entry["titleConflict"], true);
    let card = s.get_card(&id).unwrap();
    let title = card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["field"] == "title")
        .unwrap();
    assert_eq!(title["effective"]["value"], entry["values"]["title"]);
    assert_eq!(title["derived"]["conflict"].as_array().unwrap().len(), 2);
    assert_eq!(
        s.read(|c| c.query_row("SELECT count(*) FROM correction", [], |r| r
            .get::<_, i64>(0)))
            .unwrap(),
        0
    );
}
#[test]
fn localized_lunii_values_outrank_pack_and_names() {
    let refs = References::from([(
        ("title".into(), "it".into()),
        (json!("Pack italiano"), "file".into()),
    )]);
    let r = resolve_with_lunii(
        refs,
        Corrections::new(),
        &["Fichier.zip".into()],
        serde_json::Map::from_iter([("title".into(), json!("Lunii"))]),
        Some("fr_FR".into()),
    );
    assert_eq!(r.values["title"], "Lunii");
}
#[test]
fn cover_cached_locally_and_manual_clear_suppresses_it() {
    let _network = bounded::test_network();
    let (_temp, mut s) = store();
    let uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    s.write(|tx| {
        tx.execute(
            "INSERT INTO fiche(id,created_at,revision) VALUES ('cover-card',0,0)",
            [],
        )
        .map_err(error)?;
        tx.execute(
            "INSERT INTO pack_identity VALUES (?1,'cover-card','{}')",
            [uuid],
        )
        .map_err(error)?;
        fill::missing(tx)?;

        Ok(())
    })
    .unwrap();
    let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = notifications.clone();
    Arc::get_mut(&mut s).unwrap().change_sink = Some(std::sync::Arc::new(move |revision| {
        captured.lock().unwrap().push(revision);
    }));
    let before = s.list_sources().unwrap().catalogue_revision;
    s.retain_lunii_cover(
        "cover-card",
        &image_key("/public/images/packs/test.png"),
        &super::super::thumbnails::encode_bounded(&png()).unwrap(),
    )
    .unwrap();
    assert_eq!(*notifications.lock().unwrap(), vec![before + 1]);
    let thumb = s.lunii_thumbnail("cover-card").unwrap().unwrap();
    assert_eq!(serde_json::to_value(thumb).unwrap()["state"], "ready");
    s.write(|tx| {
        tx.execute("DELETE FROM lunii_pack", []).map_err(error)?;

        Ok(())
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(s.lunii_thumbnail("cover-card").unwrap().unwrap()).unwrap()["state"],
        "ready"
    );
    s.write(|tx|{tx.execute("INSERT INTO provenance(id,kind) VALUES ('manual-cover','manual')",[]).map_err(error)?;tx.execute("INSERT INTO correction VALUES ('cover-card','cover','','cleared',NULL,'manual-cover',NULL,1)",[]).map_err(error)?;Ok(())}).unwrap();
    assert!(s.lunii_thumbnail("cover-card").unwrap().is_none());
}
#[test]
fn slow_on_demand_cover_download_is_bounded_decoded_and_cached() {
    let _network = bounded::test_network();
    use std::{
        io::{Cursor, Write},
        net::TcpListener,
    };
    let (_temp, s) = store();
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    s.write(|tx|{tx.execute("INSERT INTO fiche(id,created_at,revision) VALUES ('download-card',0,0)",[]).map_err(error)?;tx.execute("INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','download-card','{}')",[]).map_err(error)?;fill::missing(tx)?;Ok(())}).unwrap();
    let mut png = Cursor::new(Vec::new());
    image::RgbImage::new(64, 64)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::spawn(move || {
        let (mut socket, _) = accept_local(&listener);
        assert!(bounded::read_request(&mut socket).starts_with("GET "));
        std::thread::sleep(Duration::from_millis(3200));
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            png.len()
        )
        .unwrap();
        socket.write_all(&png).unwrap();
    });
    let first = serde_json::to_value(
        s.lunii_thumbnail_from("download-card", &format!("http://{addr}"))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    crate::test_support::join(server);
    assert_eq!(first["state"], "ready");
    assert_eq!(first["mime"], "image/jpeg");
    let cached =
        serde_json::to_value(s.lunii_thumbnail("download-card").unwrap().unwrap()).unwrap();
    assert_eq!(cached, first);
}
#[test]
fn internal_database_is_in_main_and_survives_cache_rebuild() {
    let (temp, s) = store();
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    drop(s);
    std::fs::remove_dir_all(temp.path().join("cache")).unwrap();
    let s = Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap();
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
    assert_eq!(
        s.read_cache(|c| c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='lunii_pack'",
            [],
            |r| r.get::<_, i64>(0)
        ))
        .unwrap(),
        0
    );
}
fn png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(32, 32)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
#[test]
fn every_official_field_outranks_pack_and_keeps_manual_precedence() {
    for (field, official, pack, manual) in [
        (
            "title",
            json!("Officiel"),
            json!("Pack"),
            json!("Personnel"),
        ),
        (
            "subtitle",
            json!("Officiel"),
            json!("Pack"),
            json!("Personnel"),
        ),
        (
            "description",
            json!("Officiel"),
            json!("Pack"),
            json!("Personnel"),
        ),
        ("ageMin", json!(5), json!(7), json!(9)),
        (
            "keywords",
            json!(["officiel"]),
            json!(["pack"]),
            json!(["personnel"]),
        ),
        (
            "cover",
            json!({"kind":"lunii","key":"official"}),
            json!({"kind":"file"}),
            json!({"sha256":"personal"}),
        ),
    ] {
        let lunii = serde_json::Map::from_iter([(field.into(), official.clone())]);
        let names = vec!["3+Nom.zip".into()];
        let resolve = |r, c| resolve_with_lunii(r, c, &names, lunii.clone(), Some("fr_FR".into()));
        assert_eq!(
            resolve(References::new(), Corrections::new()).values[field],
            official
        );
        let r = References::from([((field.into(), "".into()), (pack.clone(), "source".into()))]);
        assert_eq!(
            resolve(r.clone(), Corrections::new()).values[field],
            official
        );
        let c = Corrections::from([(
            (field.into(), "".into()),
            Correction {
                state: "defined".into(),
                value: Some(manual.clone()),
            },
        )]);
        assert_eq!(resolve(r.clone(), c).values[field], manual);
        let c = Corrections::from([(
            (field.into(), "".into()),
            Correction {
                state: "cleared".into(),
                value: None,
            },
        )]);
        assert!(!resolve(r, c).values.contains_key(field));
    }
}
#[test]
fn partial_updates_merge_without_mutating_filled_fiches_and_survive_restart() {
    let (temp, s) = store();
    s.write(|tx| {tx.execute("INSERT INTO fiche VALUES ('fixed',0,0,0)",[]).map_err(error)?;tx.execute("INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','fixed','{}')",[]).map_err(error)?;Ok(())}).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let original = s.get_card("fixed").unwrap()["fields"].clone();
    let mut other = fixture();
    other["arbitrary-key"]["uuid"] = json!("11111111-2222-4333-8444-555555555555");
    s.publish_lunii(
        &parse::parse(other.to_string().as_bytes()).unwrap(),
        "network",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 2);
    let mut changed = fixture();
    changed["arbitrary-key"]["localized_infos"]["fr_FR"]["title"] = json!("Updated title");
    s.publish_lunii(
        &parse::parse(changed.to_string().as_bytes()).unwrap(),
        "network",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(s.get_card("fixed").unwrap()["fields"], original);
    s.write(|tx| {
        tx.execute("DELETE FROM lunii_pack", []).map_err(error)?;
        Ok(())
    })
    .unwrap();
    drop(s);
    std::fs::remove_dir_all(temp.path().join("cache")).unwrap();
    let s = Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap();
    s.set_lunii_permission(true).unwrap();
    s.lunii_locale("fr").unwrap();
    assert_eq!(s.get_card("fixed").unwrap()["fields"], original);
}
#[test]
fn main_member_order_matches_the_displayed_principal_before_ids() {
    let entries = vec![
        json!({"id":"a","format":"zip","modifiedAt":100,"state":"available","locator":{"path":"/container.zip","member":"Zebra"}}),
        json!({"id":"z","format":"zip","modifiedAt":100,"state":"available","locator":{"path":"/container.zip","member":"Alpha"}}),
    ];
    assert_eq!(ordered_names(&entries), vec!["Alpha", "Zebra"]);
    let resolved = resolve_with_lunii(
        References::new(),
        Corrections::new(),
        &ordered_names(&entries),
        Default::default(),
        None,
    );
    assert!(!resolved.values.contains_key("title"));
    assert_eq!(
        resolved
            .fields
            .iter()
            .find(|f| f.field == "title")
            .unwrap()
            .effective["value"],
        "Alpha"
    );
    assert!(resolved.title_conflict);
}
#[test]
fn legacy_discovery_is_read_only_bounded_and_works_offline_at_home_and_app_data() {
    let (temp, s) = store();
    let home = temp.path().join("home");
    let config = temp.path().join("config");
    let data = temp.path().join("data-path");
    let paths = legacy::locations(Some(home.clone()), Some(config.clone()), Some(data.clone()));
    for root in [&home, &config, &data] {
        assert!(paths.contains(&root.join(".studio/db/official.json")));
        assert!(paths.contains(&root.join(".studio-perso/db/official.json")));
    }
    let path = home.join(".studio-perso/db/official.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes = fixture().to_string().into_bytes();
    std::fs::write(&path, &bytes).unwrap();
    let invalid = config.join(".studio/db/official.json");
    std::fs::create_dir_all(invalid.parent().unwrap()).unwrap();
    std::fs::write(&invalid, b"bad").unwrap();
    let oversized = data.join(".studio/db/official.json");
    std::fs::create_dir_all(oversized.parent().unwrap()).unwrap();
    std::fs::write(&oversized, vec![b' '; MAX_BYTES + 1]).unwrap();
    s.discover_legacy_lunii(Some(home.clone()), Some(config), Some(data))
        .unwrap();
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(invalid).unwrap(), b"bad");
    std::fs::write(&path, b"changed after adoption").unwrap();
    s.discover_legacy_lunii(Some(home), None, None).unwrap();
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
}
fn wait_lunii(s: &Store, receipt: &Value) -> super::super::events::Progress {
    let until = Instant::now() + crate::test_support::timeout();
    loop {
        let p = s
            .get_operation(receipt["operationId"].as_str().unwrap())
            .unwrap();
        if matches!(p.status.as_str(), "success" | "failed" | "cancelled") {
            return p;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn automatic_download_retries_next_launch_until_database_is_available() {
    use std::{io::Write, net::TcpListener};
    let _network = bounded::test_network();
    let (_temp, s) = store();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = crate::test_support::spawn(move || {
        for i in 0..5 {
            let (mut socket, _) = accept_local(&listener);
            bounded::read_request(&mut socket);
            let (status, body) = match i {
                0 => ("503 Unavailable", String::new()),
                1 | 3 => (
                    "200 OK",
                    json!({"response":{"token":{"server":"token"}}}).to_string(),
                ),
                _ => ("200 OK", fixture().to_string()),
            };
            write!(
                socket,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let open = || {
        s.open_lunii_from(
            "fr",
            Arc::new(|_, _| {}),
            format!("http://{addr}/auth"),
            format!("http://{addr}/packs"),
        )
        .unwrap()
    };
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('pending',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','pending','{}');").map_err(error)?; Ok(()) }).unwrap();
    let first = open();
    assert_eq!(wait_lunii(&s, &first["operation"]).status, "failed");
    assert!(open()["operation"].is_null());
    s.lunii.opened.store(false, Ordering::SeqCst);
    s.lunii.attempted.store(false, Ordering::SeqCst); // next application launch
    let second = open();
    assert_eq!(wait_lunii(&s, &second["operation"]).status, "success");
    assert!(!s.lunii_refresh_path().exists());
    assert!(open()["operation"].is_null());
    assert_eq!(s.read(|c| values(c, "pending")).unwrap().0["title"], "Lune");
    std::fs::write(s.lunii_refresh_path(), "").unwrap();
    s.lunii.opened.store(false, Ordering::SeqCst);
    s.lunii.attempted.store(false, Ordering::SeqCst);
    let forced = open();
    assert_eq!(wait_lunii(&s, &forced["operation"]).status, "success");
    assert!(!s.lunii_refresh_path().exists());
    crate::test_support::join(server);
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
}
#[test]
fn unknown_uuid_never_downloads_again_with_local_server() {
    let _network = bounded::test_network();
    use std::net::TcpListener;
    let (temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    s.open_lunii_from(
        "fr",
        Arc::new(|_, _| {}),
        format!("http://{addr}/auth"),
        format!("http://{addr}/packs"),
    )
    .unwrap();
    let root = temp.path().join("source");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("unknown.mbah"),
        json!({"packMetadata":{"uuid":"99999999-2222-4333-8444-555555555555"}}).to_string(),
    )
    .unwrap();
    s.add_source(&root, 0, false).unwrap();
    for _ in 0..2 {
        let receipt = s
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                s.list_sources().unwrap().sources_revision,
                temp.path().join("cache"),
                temp.path().join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        assert_eq!(
            wait_lunii(&s, &serde_json::to_value(receipt).unwrap()).status,
            "success"
        );
    }
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn saved_download_attempt_survives_restart_without_starting_a_download() {
    let _network = bounded::test_network();
    let (temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    s.write(|tx|{tx.execute("INSERT INTO fiche VALUES ('unknown',0,0,0)",[]).map_err(error)?;tx.execute("INSERT INTO pack_identity VALUES ('11111111-2222-4333-8444-555555555555','unknown','{}')",[]).map_err(error)?;tx.execute("UPDATE lunii_automatic SET attempted_at=?1 WHERE id=1",[now() as i64]).map_err(error)?;Ok(())}).unwrap();
    let open = |s: &Arc<Store>| {
        s.open_lunii_from(
            "fr",
            Arc::new(|_, _| panic!("completed download must not start a job")),
            "http://127.0.0.1:9/auth".into(),
            "http://127.0.0.1:9/packs".into(),
        )
        .unwrap()
    };
    assert!(open(&s)["operation"].is_null());
    drop(s);
    let s = Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
    assert!(open(&s)["operation"].is_null());
}
#[test]
fn durable_fill_preserves_pack_and_manual_fields_including_intentional_clears() {
    let (_temp, s) = store();
    s.write(|tx|{tx.execute_batch("INSERT INTO fiche VALUES ('protected',0,0,0);INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','protected','{}');INSERT INTO provenance(id,kind) VALUES ('file','file'),('manual','manual');INSERT INTO reference_value VALUES ('protected','title','','\"Pack title\"','file',NULL);INSERT INTO correction VALUES ('protected','description','','cleared',NULL,'manual',NULL,1);INSERT INTO correction VALUES ('protected','ageMin','','defined','9','manual',NULL,1);").map_err(error)?;Ok(())}).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let card = s.get_card("protected").unwrap();
    let fields = card["fields"].as_array().unwrap();
    let value =
        |field: &str| &fields.iter().find(|f| f["field"] == field).unwrap()["effective"]["value"];
    assert_eq!(value("title"), "Lune");
    assert!(value("description").is_null());
    assert_eq!(value("ageMin"), 9);
    assert_eq!(value("subtitle"), "Voyage");
    s.write(|tx| {
        tx.execute(
            "DELETE FROM correction WHERE fiche_id='protected' AND field='description'",
            [],
        )
        .map_err(error)?;
        assert_eq!(fill::missing(tx)?, 0);
        Ok(())
    })
    .unwrap();
    let values = s.read(|c| values(c, "protected")).unwrap().0;
    assert!(!values.contains_key("description"));
    assert_eq!(values["title"], "Lune");
    assert_eq!(values["ageMin"], 5);
}

#[test]
fn legacy_fill_waits_for_interface_locale_even_during_startup_scans() {
    for (locale, expected) in [("en", "Moon"), ("it", "Luna")] {
        let temp = Temp::new();
        let s =
            Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
        s.set_lunii_permission(true).unwrap();
        s.write(|tx| {
            tx.execute_batch("INSERT INTO fiche VALUES ('pending',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','pending','{}');").map_err(error)?;
            Ok(())
        }).unwrap();
        drop(s);
        let s =
            Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
        let path = temp.path().join("official.json");
        std::fs::write(&path, fixture().to_string()).unwrap();
        s.adopt_legacy_lunii(std::slice::from_ref(&path)).unwrap();
        s.write(|tx| {
            assert_eq!(fill::missing(tx)?, 0);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            s.read(
                |c| c.query_row("SELECT count(*) FROM lunii_filled", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
            0
        );
        s.open_lunii(locale, Arc::new(|_, _| {})).unwrap();
        let resolved = s
            .read(|c| super::super::data::card::resolution(c, "pending", &[]))
            .unwrap();
        assert_eq!(resolved.values["title"], expected);
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            fixture().to_string()
        );
    }
}

#[test]
fn fill_respects_effective_age_maximum() {
    for (maximum, correction, expected) in [
        (4, false, None),
        (6, false, Some(5)),
        (4, true, None),
        (6, true, Some(5)),
    ] {
        let (_temp, s) = store();
        s.write(|tx| {
            tx.execute_batch("INSERT INTO fiche VALUES ('age',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','age','{}'); INSERT INTO provenance(id,kind) VALUES ('pack','file'),('manual','manual');").map_err(error)?;
            if correction {
                tx.execute("INSERT INTO correction VALUES ('age','ageMax','','defined',?1,'manual',NULL,1)", [maximum.to_string()]).map_err(error)?;
            } else {
                tx.execute("INSERT INTO reference_value VALUES ('age','ageMax','',?1,'pack',NULL)", [maximum.to_string()]).map_err(error)?;
            }
            Ok(())
        }).unwrap();
        s.publish_lunii(
            &parse::parse(fixture().to_string().as_bytes()).unwrap(),
            "import",
            &AtomicBool::new(false),
        )
        .unwrap();
        let resolved = s
            .read(|c| super::super::data::card::resolution(c, "age", &[]))
            .unwrap();
        assert_eq!(
            resolved.values.get("ageMin").and_then(Value::as_u64),
            expected
        );
        assert_eq!(resolved.values["ageMax"], maximum);
    }
}

fn accept_local(listener: &std::net::TcpListener) -> (std::net::TcpStream, std::net::SocketAddr) {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + crate::test_support::timeout();
    loop {
        match listener.accept() {
            Ok(v) => return v,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "local HTTP request not received");
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("local server: {e}"),
        }
    }
}

#[test]
fn all_languages_are_copied_once_and_display_uses_the_saved_fiche() {
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('languages',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','languages','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let saved = s
        .read(|c| {
            c.query_row(
                "SELECT count(*) FROM reference_value WHERE fiche_id='languages' AND field='title'",
                [],
                |r| r.get::<_, i64>(0),
            )
        })
        .unwrap();
    assert_eq!(saved, 3);
    s.write(|tx| {
        tx.execute("DELETE FROM lunii_pack", []).map_err(error)?;
        Ok(())
    })
    .unwrap();
    for (locale, title) in [("en", "Moon"), ("it", "Luna"), ("fr", "Lune")] {
        s.set_lunii_permission(true).unwrap();
        s.lunii_locale(locale).unwrap();
        let card = s.get_card("languages").unwrap();
        let field = card["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["field"] == "title")
            .unwrap();
        assert_eq!(field["effective"]["value"], title);
        assert_eq!(field["referenceValue"]["value"], title);
    }
    s.write(|tx| { tx.execute_batch("INSERT INTO provenance(id,kind) VALUES ('personal','manual'); INSERT INTO correction VALUES ('languages','title','fr','defined','\"My title\"','personal',NULL,1);").map_err(error)?; Ok(()) }).unwrap();
    for locale in ["en", "fr", "it"] {
        s.set_lunii_permission(true).unwrap();
        s.lunii_locale(locale).unwrap();
        assert_eq!(
            s.read(|c| super::super::data::card::resolution(c, "languages", &[]))
                .unwrap()
                .values["title"],
            "My title"
        );
    }
}

#[test]
fn language_fallback_prefers_sole_then_english_then_french() {
    let values = json!({"localized_infos":{"it_IT":{"title":"Italiano"},"en_US":{"title":"English"},"fr_FR":{"title":"Français"}}});
    assert_eq!(
        parse::localized(&values, "de").unwrap().1["title"],
        "English"
    );
    for locale in ["", "unknown", "en", "it", "fr"] {
        let expected = match locale {
            "fr" => "Français",
            "it" => "Italiano",
            _ => "English",
        };
        assert_eq!(
            parse::localized(&values, locale).unwrap().1["title"],
            expected
        );
    }
    let values =
        json!({"localized_infos":{"it_IT":{"title":"Italiano"},"en_US":{"title":"English"}}});
    assert_eq!(
        parse::localized(&values, "de").unwrap().1["title"],
        "English"
    );
    let values = json!({"localized_infos":{"it_IT":{"title":"Italiano"}}});
    assert_eq!(
        parse::localized(&values, "en").unwrap().1["title"],
        "Italiano"
    );
}

#[test]
fn cover_failures_retry_only_next_launch_and_stop_after_three() {
    let _network = bounded::test_network();
    let (temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('retry-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','retry-cover','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    for expected in 1..=3 {
        s.lunii.cover_attempted.lock().unwrap().clear();
        for _ in 0..2 {
            let result = s
                .lunii_thumbnail_from("retry-cover", "http://127.0.0.1:9")
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::to_value(result).unwrap()["state"], "absent");
        }
        assert_eq!(
            s.read(|c| c.query_row(
                "SELECT failures FROM lunii_image_attempt WHERE fiche_id='retry-cover'",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
            expected
        );
    }
    drop(s);
    let s = Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap();
    s.lunii_thumbnail_from("retry-cover", "http://127.0.0.1:9")
        .unwrap();
    assert!(s.lunii.cover_attempted.lock().unwrap().is_empty());
    assert_eq!(
        s.read(|c| c.query_row(
            "SELECT failures FROM lunii_image_attempt WHERE fiche_id='retry-cover'",
            [],
            |r| r.get::<_, i64>(0)
        ))
        .unwrap(),
        3
    );
}

#[test]
fn multiple_exemplars_fill_from_selected_principal_only_once() {
    let (_temp, s) = store();
    let a = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let b = "11111111-2222-4333-8444-555555555555";
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('multiple',0,0,0);").map_err(error)?;
        for (exemplar, uuid) in [("first", a), ("principal", b)] {
            tx.execute("INSERT INTO pack_identity VALUES (?1,'multiple','{}')", [uuid]).map_err(error)?;
            tx.execute("INSERT INTO exemplar(id,fiche_id,anchor_json,verified_uuid,proof_json,content_revision) VALUES (?1,'multiple','{}',?2,'{}',1)", rusqlite::params![exemplar,uuid]).map_err(error)?;
        }
        tx.execute("INSERT INTO reference_source VALUES ('multiple','principal',0,1)", []).map_err(error)?;
        Ok(())
    }).unwrap();
    let mut raw = fixture();
    let mut other = raw["arbitrary-key"].clone();
    other["uuid"] = json!(b);
    other["localized_infos"]["fr_FR"]["title"] = json!("Principal");
    raw["other"] = other;
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        s.read(|c| values(c, "multiple")).unwrap().0["title"],
        "Principal"
    );
    s.write(|tx| {
        tx.execute("UPDATE reference_source SET exemplar_id='first'", [])
            .map_err(error)?;
        assert_eq!(fill::missing(tx)?, 0);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        s.read(|c| values(c, "multiple")).unwrap().0["title"],
        "Principal"
    );
}

#[test]
fn absent_base_attempt_is_session_scoped_and_failed_marker_is_retained() {
    let _network = bounded::test_network();
    let (_temp, s) = store();
    let open = || {
        s.open_lunii_from(
            "fr",
            Arc::new(|_, _| {}),
            "http://127.0.0.1:9/auth".into(),
            "http://127.0.0.1:9/packs".into(),
        )
        .unwrap()
    };
    let first = open();
    assert_eq!(wait_lunii(&s, &first["operation"]).status, "failed");
    assert!(open()["operation"].is_null());
    std::fs::write(s.lunii_refresh_path(), "").unwrap();
    s.lunii.opened.store(false, Ordering::SeqCst);
    s.lunii.attempted.store(false, Ordering::SeqCst);
    let forced = open();
    assert_eq!(wait_lunii(&s, &forced["operation"]).status, "failed");
    assert!(s.lunii_refresh_path().exists());
    assert!(open()["operation"].is_null());
}

#[test]
fn available_base_fills_at_import_and_unchanged_rescan_keeps_values_and_revision() {
    let (temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let root = temp.path().join("source");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("Fallback.mbah");
    let raw = json!({"packMetadata":{"uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","title":"Pack title"}}).to_string();
    std::fs::write(&path, &raw).unwrap();
    s.add_source(&root, 0, false).unwrap();
    let scan = || {
        let receipt = s
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                s.list_sources().unwrap().sources_revision,
                temp.path().join("cache"),
                temp.path().join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        assert_eq!(
            wait_lunii(&s, &serde_json::to_value(receipt).unwrap()).status,
            "success"
        );
    };
    scan();
    let entry = s.query_entries(200, None, true).unwrap().items.remove(0);
    assert_eq!(entry["values"]["title"], "Lune");
    let id = entry["id"].as_str().unwrap();
    let fields = s.get_card(id).unwrap()["fields"].clone();
    let revision = entry["ficheRevision"].clone();
    scan();
    assert_eq!(
        s.query_entries(200, None, true).unwrap().items[0]["ficheRevision"],
        revision
    );
    assert_eq!(s.get_card(id).unwrap()["fields"], fields);
    assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
}

#[test]
fn cleared_title_uses_filename_only_in_display_without_filling_the_field() {
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('cleared-title',0,0,0); INSERT INTO provenance(id,kind) VALUES ('clear','manual'); INSERT INTO correction VALUES ('cleared-title','title','','cleared',NULL,'clear',NULL,1); INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision) VALUES ('file','cleared-title','{\"path\":\"/stories/3+Filename.zip\"}','{}',1);").map_err(error)?;
        Ok(())
    }).unwrap();
    let entry = s.query_entries(200, None, true).unwrap().items.remove(0);
    assert_eq!(entry["displayTitle"], "Filename");
    assert!(entry["values"]["title"].is_null());
    let card = s.get_card("cleared-title").unwrap();
    assert!(card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["field"] == "title")
        .unwrap()["effective"]["value"]
        .is_null());
}

#[test]
fn first_cover_notifies_while_the_next_http_response_is_still_pending() {
    use std::{io::Write, net::TcpListener, sync::mpsc};
    let _network = bounded::test_network();
    let (_temp, s) = store();
    let second_uuid = "11111111-2222-4333-8444-555555555555";
    let mut raw = fixture();
    let mut second = raw["arbitrary-key"].clone();
    second["uuid"] = json!(second_uuid);
    second["localized_infos"]["fr_FR"]["image"]["image_url"] =
        json!("/public/images/packs/slow.png");
    raw["second"] = second;
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('first-cover',0,0,0),('second-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','first-cover','{}'),('11111111-2222-4333-8444-555555555555','second-cover','{}');").map_err(error)?;
        Ok(())
    }).unwrap();
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (pending_tx, pending_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let server = crate::test_support::spawn(move || {
        for path in [
            "/public/images/packs/test.png",
            "/public/images/packs/slow.png",
        ] {
            let (mut socket, _) = accept_local(&listener);
            assert!(bounded::read_request(&mut socket).starts_with(&format!("GET {path} ")));
            if path.ends_with("slow.png") {
                pending_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }
            let body = png();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    let (changed_tx, changed_rx) = mpsc::channel();
    s.download_lunii_covers_from(
        Arc::new(move |event, progress| {
            assert_eq!(event, "catalogue-operation-finished");
            assert!(progress.catalogue_changed);
            changed_tx.send(progress.catalogue_revision).unwrap();
        }),
        format!("http://{address}"),
    );
    pending_rx
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    let first_revision = changed_rx
        .recv_timeout(crate::test_support::timeout())
        .expect("first cover must notify before the second response is released");
    assert_eq!(
        serde_json::to_value(s.lunii_thumbnail("first-cover").unwrap().unwrap()).unwrap()["state"],
        "ready"
    );
    assert_eq!(
        serde_json::to_value(s.lunii_thumbnail("second-cover").unwrap().unwrap()).unwrap()["state"],
        "absent"
    );
    assert!(matches!(
        changed_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_tx.send(()).unwrap();
    let second_revision = changed_rx
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    assert!(second_revision > first_revision);
    assert_eq!(
        serde_json::to_value(s.lunii_thumbnail("second-cover").unwrap().unwrap()).unwrap()["state"],
        "ready"
    );
    crate::test_support::join(server);
}

#[test]
fn deferred_fill_keeps_all_languages_beneath_a_manual_correction() {
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('deferred',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','deferred','{}'); INSERT INTO provenance(id,kind) VALUES ('personal','manual'); INSERT INTO correction VALUES ('deferred','title','','defined','\"Personal\"','personal',NULL,1);").map_err(error)?;
        Ok(())
    }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let title = || {
        s.read(|c| super::super::data::card::resolution(c, "deferred", &[]))
            .unwrap()
            .values["title"]
            .clone()
    };
    assert_eq!(title(), "Personal");
    s.write(|tx| {
        tx.execute("DELETE FROM correction WHERE fiche_id='deferred'", [])
            .map_err(error)?;
        tx.execute("DELETE FROM lunii_pack", []).map_err(error)?;
        assert_eq!(fill::missing(tx)?, 0);
        Ok(())
    })
    .unwrap();
    for (locale, expected) in [("fr", "Lune"), ("en", "Moon"), ("it", "Luna")] {
        s.set_lunii_permission(true).unwrap();
        s.lunii_locale(locale).unwrap();
        assert_eq!(title(), expected);
    }
}

#[test]
fn automatic_cover_is_shared_with_waiting_preparation_consumers() {
    use std::sync::mpsc;
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('shared',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','shared','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let key = s.read(|c| values(c, "shared")).unwrap().0["cover"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let (ready, started) = mpsc::channel();
    let (release, finish) = mpsc::channel();
    let (notified, retained) = mpsc::channel();
    s.lunii_cover_test_response(png());
    s.lunii_cover_test_pause(ready, finish);
    s.download_lunii_covers(Arc::new(move |_, _| {
        let _ = notified.send(());
    }));
    started
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    let consumers = [false, true].map(|cancellable| {
        let s = Arc::clone(&s);
        let key = key.clone();
        crate::test_support::spawn(move || {
            if cancellable {
                s.lunii_cover_bytes_cancel("shared", &key, &AtomicBool::new(false))
            } else {
                s.lunii_cover_bytes("shared", &key)
            }
        })
    });
    s.lunii_cover_test_waiters(3);
    release.send(()).unwrap();
    let results = consumers.map(crate::test_support::join);
    retained
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    for result in results {
        image::load_from_memory(&result.unwrap()).unwrap();
    }
    assert_eq!(s.lunii_cover_test_requests(), 1);
    s.lunii_cover_bytes("shared", &key).unwrap();
    assert_eq!(s.lunii_cover_test_requests(), 1);
}

#[test]
fn cover_registry_wait_can_be_cancelled_without_stopping_its_owner() {
    use std::sync::mpsc;
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('waiting-lock',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','waiting-lock','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let key = s.read(|c| values(c, "waiting-lock")).unwrap().0["cover"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = s.lunii.cover.lock().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let (done, result) = mpsc::channel();
    let worker = {
        let s = Arc::clone(&s);
        let cancel = Arc::clone(&cancel);
        crate::test_support::spawn(move || {
            let _ = done.send(s.lunii_cover_bytes_cancel("waiting-lock", &key, &cancel));
        })
    };
    s.lunii_cover_test_waiters(1);
    cancel.store(true, Ordering::SeqCst);
    let cancelled = result.recv_timeout(Duration::from_millis(250));
    drop(owner);
    crate::test_support::join(worker);
    assert_eq!(
        cancelled.unwrap().unwrap_err().code,
        codes::GENERATION_CANCELLED
    );
    assert_eq!(s.lunii_cover_test_requests(), 0);
}

#[test]
fn duplicate_uuid_keeps_first_valid_pack() {
    let mut raw = fixture();
    raw["duplicate"] = raw["arbitrary-key"].clone();
    assert_eq!(parse::parse(raw.to_string().as_bytes()).unwrap().len(), 1);
}

#[test]
fn fill_languages_are_independent_and_malformed_language_is_ignored() {
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('languages',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','languages','{}');").map_err(error)?; Ok(()) }).unwrap();
    let mut index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    let pack = index.values_mut().next().unwrap();
    pack["localized_infos"]["de-DE"] = json!({"title":"Mond"});
    pack["localized_infos"]["broken"] = json!(false);
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    let texts = s.read(|c| c.prepare("SELECT p.language,v.value_json FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE fiche_id='languages' AND field='title'")?.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<std::collections::BTreeMap<_,_>>>()).unwrap();
    assert_eq!(texts["de-DE"], "\"Mond\"");
    assert_eq!(texts["fr_FR"], "\"Lune\"");
    assert!(!texts.contains_key("broken"));
}

#[test]
fn filename_title_is_display_only() {
    let r = resolve_with_lunii(
        References::new(),
        Corrections::new(),
        &["3+] Fichier.zip".into()],
        Default::default(),
        None,
    );
    assert!(!r.values.contains_key("title"));
    let title = r.fields.iter().find(|f| f.field == "title").unwrap();
    assert_eq!(title.effective["value"], "Fichier");
    assert_eq!(title.derived.as_ref().unwrap()["value"], "Fichier");
}

#[test]
fn unsafe_image_paths_and_imported_key_mismatch_are_refused() {
    for path in [
        "/public/images/../secret",
        "/public/images/x?y",
        "/public/images/x#y",
        "/public/images/%20",
        "/public/images/x\\y",
        "/public/images/x\n",
        "/other/x",
        "https://other.test/public/images/x",
    ] {
        assert!(!parse::image_path_valid(path), "{path:?}");
    }
    assert!(!parse::image_path_valid(&format!(
        "/public/images/{}",
        "x".repeat(2048)
    )));
    assert!(!valid_cover(
        &json!({"kind":"lunii","imagePath":"/public/images/x","key":"wrong"})
    ));
    assert!(!valid_cover(
        &json!({"kind":"lunii","imagePath":"/public/images/../x","key":image_key("/public/images/../x")})
    ));
}
#[test]
fn lunii_retains_large_cover_but_displays_a_thumbnail_and_retries_only_next_launch() {
    let _network = bounded::test_network();
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('large-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','large-cover','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2000, 1500)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    s.lunii_cover_test_response(png.into_inner());
    s.lunii_thumbnail_from("large-cover", "http://127.0.0.1:9")
        .unwrap();
    let key = s.read(|c| values(c, "large-cover")).unwrap().0["cover"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = s.lunii_cover_bytes("large-cover", &key).unwrap();
    assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 1600);
    let small = super::super::thumbnails::encode_bounded(&bytes).unwrap();
    assert_eq!(image::load_from_memory(&small).unwrap().width(), 768);
    assert_eq!(s.lunii_cover_test_requests(), 1);
    s.open_lunii("fr", Arc::new(|_, _| {})).unwrap();
    assert_eq!(s.lunii_cover_test_requests(), 1);
}

#[test]
fn lunii_download_allows_slow_regular_progress_but_stops_on_inactivity() {
    use std::{io::Write, net::TcpListener};
    let _network = bounded::test_network();
    for regular in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = crate::test_support::spawn(move || {
            let (mut socket, _) = accept_local(&listener);
            bounded::read_request(&mut socket);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(if regular { 60 } else { 400 }));
                if socket.write_all(b"x").is_err() {
                    break;
                }
            }
        });
        let result = download_idle(
            &format!("http://{addr}"),
            None,
            100,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(4),
            Duration::from_millis(250),
            |_| {},
        );
        if regular {
            assert_eq!(result.unwrap(), b"xxxxxx");
        } else {
            assert_eq!(result, Err(Failure::Timeout));
        }
        crate::test_support::join(server);
    }
}
#[test]
fn lunii_hostile_cover_responses_are_counted_without_retaining_files() {
    use std::{io::Write, net::TcpListener};
    let _network = bounded::test_network();
    let (_temp, s) = store();
    let mut huge = png();
    huge[16..20].copy_from_slice(&64000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&64000u32.to_be_bytes());
    for (n, body, declared) in [
        (0, b"not an image".to_vec(), 12),
        (1, huge.clone(), huge.len()),
        (2, Vec::new(), 10 * 1024 * 1024 + 1),
    ] {
        let id = format!("hostile-{n}");
        s.write(|tx| {
            tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)", [&id])
                .map_err(error)?;
            tx.execute("INSERT INTO provenance(id,kind) VALUES (?1,'lunii')", [&id])
                .map_err(error)?;
            let path = format!("/public/images/{n}");
            tx.execute(
                "INSERT INTO reference_value VALUES (?1,'cover','@lunii:fr_FR',?2,?1,NULL)",
                rusqlite::params![
                    id,
                    json!({"kind":"lunii","key":image_key(&path),"imagePath":path}).to_string()
                ],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = crate::test_support::spawn(move || {
            let (mut socket, _) = accept_local(&listener);
            bounded::read_request(&mut socket);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let _ = socket.write_all(&body);
        });
        let result = s
            .lunii_thumbnail_from(&id, &format!("http://{addr}"))
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(result).unwrap()["state"], "absent");
        crate::test_support::join(server);
        assert_eq!(
            s.read(|c| c.query_row(
                "SELECT failures FROM lunii_image_attempt WHERE fiche_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
            1
        );
        assert_eq!(std::fs::read_dir(s.images_root()).unwrap().count(), 0);
    }
}
#[test]
fn lunii_busy_transport_is_not_a_cover_failure() {
    use std::{io::Write, net::TcpListener, sync::mpsc};
    let _network = bounded::test_network();
    let (_temp, s) = store();
    s.write(|tx| {tx.execute_batch("INSERT INTO fiche VALUES ('busy-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','busy-cover','{}');").map_err(error)?;Ok(())}).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut jobs = Vec::new();
    for _ in 0..2 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (ready, started) = mpsc::channel();
        let (release, finish) = mpsc::channel();
        let server = crate::test_support::spawn(move || {
            let (mut socket, _) = accept_local(&listener);
            bounded::read_request(&mut socket);
            ready.send(()).unwrap();
            finish.recv().unwrap();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let client = crate::test_support::spawn(move || {
            bounded::get(
                &format!("http://{addr}"),
                None,
                10,
                &AtomicBool::new(false),
                Instant::now() + crate::test_support::timeout(),
                |_| {},
            )
        });
        started
            .recv_timeout(crate::test_support::timeout())
            .unwrap();
        jobs.push((release, server, client));
    }
    s.lunii_thumbnail_from("busy-cover", "http://127.0.0.1:9")
        .unwrap();
    assert!(!s
        .lunii
        .cover_attempted
        .lock()
        .unwrap()
        .contains("busy-cover"));
    assert_eq!(
        s.read(
            |c| c.query_row("SELECT count(*) FROM lunii_image_attempt", [], |r| r
                .get::<_, i64>(0))
        )
        .unwrap(),
        0
    );
    for (release, server, client) in jobs {
        release.send(()).unwrap();
        crate::test_support::join(server);
        crate::test_support::join(client).unwrap();
    }
    s.lunii_cover_test_response(png());
    assert_eq!(
        serde_json::to_value(
            s.lunii_thumbnail_from("busy-cover", "http://127.0.0.1:9")
                .unwrap()
                .unwrap()
        )
        .unwrap()["state"],
        "ready"
    );
}

#[test]
fn lunii_startup_scan_consumes_the_session_attempt_but_restart_can_retry() {
    let (temp, s) = store();
    s.prepare_lunii_scan(Arc::new(|_, _| {}));
    let op = s.lunii.job.lock().unwrap().clone().unwrap();
    let receipt = json!({"operationId":op.progress.lock().unwrap().operation_id});
    assert_eq!(wait_lunii(&s, &receipt).status, "failed");
    assert!(s.open_lunii("fr", Arc::new(|_, _| {})).unwrap()["operation"].is_null());
    drop(op);
    drop(s);
    let s = Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
    let second = s.open_lunii("fr", Arc::new(|_, _| {})).unwrap();
    assert!(!second["operation"].is_null());
    assert_eq!(wait_lunii(&s, &second["operation"]).status, "failed");
}
#[test]
fn lunii_force_marker_waits_for_next_launch_when_an_existing_job_is_running() {
    let _network = bounded::test_network();
    let (_temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let result = s
        .refresh_lunii_from(
            "explicit-test".into(),
            Arc::new(|_, _| {}),
            "http://127.0.0.1:9/auth".into(),
            "http://127.0.0.1:9/packs".into(),
        )
        .unwrap();
    wait_lunii(&s, &result);
    let job = s.lunii.job.lock().unwrap().clone().unwrap();
    job.progress.lock().unwrap().status = "running".into();
    std::fs::write(s.lunii_refresh_path(), "").unwrap();
    assert!(s.open_lunii("fr", Arc::new(|_, _| {})).unwrap()["operation"].is_null());
    job.progress.lock().unwrap().status = "failed".into();
    assert!(s.open_lunii("fr", Arc::new(|_, _| {})).unwrap()["operation"].is_null());
    assert!(s.lunii_refresh_path().exists());
    s.lunii.opened.store(false, Ordering::SeqCst);
    let forced = s.open_lunii("fr", Arc::new(|_, _| {})).unwrap();
    assert!(!forced["operation"].is_null());
    assert_eq!(wait_lunii(&s, &forced["operation"]).status, "failed");
    assert!(s.lunii_refresh_path().exists());
}

#[test]
fn device_zip_is_filled_from_lunii_by_directory_uuid() {
    let (temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let root = temp.path().join("source");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("Device.zip");
    let bytes = crate::services::catalogue::analyze::fs_archive::tests::fixture(
        &["nested/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"],
        None,
        false,
    );
    std::fs::write(&path, &bytes).unwrap();
    s.add_source(&root, 0, false).unwrap();
    let receipt = s
        .start_scan(
            None,
            uuid::Uuid::new_v4().to_string(),
            s.list_sources().unwrap().sources_revision,
            temp.path().join("cache"),
            temp.path().join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    assert_eq!(
        wait_lunii(&s, &serde_json::to_value(receipt).unwrap()).status,
        "success"
    );
    let entries = s.query_entries(200, None, true).unwrap().items;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["values"]["title"], "Lune");
    assert_eq!(entries[0]["values"]["ageMin"], 5);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn luh_permission_blocks_all_transports_and_refresh_until_yes_and_no_survives_restart() {
    let _network = bounded::test_network();
    let temp = Temp::new();
    let s = Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
    let sink: scan::Sink = Arc::new(|_, _| {});
    std::fs::write(s.lunii_refresh_path(), b"").unwrap();
    assert_eq!(s.lunii_permission().unwrap(), None);
    s.prepare_lunii_scan(sink.clone());
    assert!(s.open_lunii("fr", sink.clone()).unwrap()["operation"].is_null());
    s.set_lunii_permission(false).unwrap();
    drop(s);
    let s = Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
    assert_eq!(s.lunii_permission().unwrap(), Some(false));
    assert!(s.open_lunii("fr", sink.clone()).unwrap()["operation"].is_null());
    assert!(s.lunii_refresh_path().is_file());
    assert!(!s.lunii.opened.load(Ordering::SeqCst));
    assert!(!s.lunii.attempted.load(Ordering::SeqCst));
    // Existing official values may remain, but an uncached cover cannot reach transport.
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('consent-cover',0,0,0);")
            .map_err(error)?;
        Ok(())
    })
    .unwrap();
    assert!(s
        .fetch_lunii_cover(
            "consent-cover",
            "/public/images/test.png",
            "http://127.0.0.1:9",
            &AtomicBool::new(false)
        )
        .is_err());
    assert_eq!(s.lunii_cover_test_requests(), 0);
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 0);
    s.set_lunii_permission(true).unwrap();
    s.lunii.download_responses.lock().unwrap().extend([
        br#"{"response":{"token":{"server":"test-token"}}}"#.to_vec(),
        fixture().to_string().into_bytes(),
    ]);
    let opened = s.open_lunii("fr", sink.clone()).unwrap();
    assert_eq!(wait_lunii(&s, &opened["operation"]).status, "success");
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
    assert!(!s.lunii_refresh_path().exists());
    s.set_lunii_permission(false).unwrap();
    s.prepare_lunii_scan(sink.clone());
    s.open_lunii("fr", sink).unwrap();
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert_eq!(s.lunii_status().unwrap()["entryCount"], 1);
}

#[test]
fn luh_failed_cover_reopening_same_session_does_not_request_again() {
    let _network = bounded::test_network();
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('reopen-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','reopen-cover','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    s.lunii_cover_test_response(b"invalid image".to_vec());
    s.lunii_thumbnail_from("reopen-cover", "http://127.0.0.1:9")
        .unwrap();
    assert_eq!(s.lunii_cover_test_requests(), 1);
    s.open_lunii("fr", Arc::new(|_, _| {})).unwrap();
    s.lunii_thumbnail_from("reopen-cover", "http://127.0.0.1:9")
        .unwrap();
    assert_eq!(s.lunii_cover_test_requests(), 1);
}

#[test]
fn luh_disabling_permission_cancels_a_queued_cover_without_recording_a_failure() {
    let _network = bounded::test_network();
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('disabled-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','disabled-cover','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let (ready, started) = std::sync::mpsc::channel();
    let (release, finish) = std::sync::mpsc::channel();
    s.lunii_cover_test_response(png());
    s.lunii_cover_test_pause(ready, finish);
    let worker = Arc::clone(&s);
    let thread = crate::test_support::spawn(move || {
        worker.fetch_lunii_cover(
            "disabled-cover",
            "/public/images/packs/test.png",
            "http://127.0.0.1:9",
            &AtomicBool::new(false),
        )
    });
    started
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    s.set_lunii_permission(false).unwrap();
    release.send(()).unwrap();
    assert_eq!(
        crate::test_support::join(thread).unwrap_err().code,
        codes::GENERATION_CANCELLED
    );
    assert_eq!(
        s.read(
            |c| c.query_row("SELECT count(*) FROM lunii_image_attempt", [], |r| r
                .get::<_, i64>(0))
        )
        .unwrap(),
        0
    );
    s.set_lunii_permission(true).unwrap();
    s.lunii_cover_test_response(png());
    assert!(s
        .fetch_lunii_cover(
            "disabled-cover",
            "/public/images/packs/test.png",
            "http://127.0.0.1:9",
            &AtomicBool::new(false)
        )
        .is_ok());
}

#[test]
fn luh_disabling_preserves_copied_values_and_retained_cover() {
    let (_temp, s) = store();
    s.write(|tx| { tx.execute_batch("INSERT INTO fiche VALUES ('kept-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','kept-cover','{}');").map_err(error)?; Ok(()) }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let key = s.read(|c| values(c, "kept-cover")).unwrap().0["cover"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    s.lunii_cover_test_response(png());
    let bytes = s.lunii_cover_bytes("kept-cover", &key).unwrap();
    s.retain_lunii_cover("kept-cover", &key, &bytes).unwrap();
    let before = s.read(|c| values(c, "kept-cover")).unwrap();
    let requests = s.lunii_cover_test_requests();
    s.set_lunii_permission(false).unwrap();
    s.open_lunii("fr", Arc::new(|_, _| {})).unwrap();
    assert_eq!(s.read(|c| values(c, "kept-cover")).unwrap(), before);
    assert_eq!(s.lunii_cover_bytes("kept-cover", &key).unwrap(), bytes);
    assert_eq!(s.lunii_cover_test_requests(), requests);
}

#[test]
fn revd2_cover_notifications_advance_catalogue_without_changing_cards() {
    let _network = bounded::test_network();
    let (_temp, s) = store();
    let mut raw = fixture();
    let mut second = raw["arbitrary-key"].clone();
    second["uuid"] = json!("11111111-2222-4333-8444-555555555555");
    second["localized_infos"]["fr_FR"]["image"]["image_url"] =
        json!("/public/images/packs/second.png");
    raw["second"] = second;
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('first-cover',0,0,0),('second-cover',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','first-cover','{}'),('11111111-2222-4333-8444-555555555555','second-cover','{}');").map_err(error)?;
        Ok(())
    }).unwrap();
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let before = s.list_sources().unwrap().catalogue_revision;
    let cards: Vec<_> = ["first-cover", "second-cover"]
        .iter()
        .map(|id| s.get_card(id).unwrap()["ficheRevision"].clone())
        .collect();
    s.lunii_cover_test_response(png());
    let (sent, received) = std::sync::mpsc::channel();
    let store = Arc::clone(&s);
    s.download_lunii_covers(Arc::new(move |event, progress| {
        assert_eq!(event, "catalogue-operation-finished");
        assert!(progress.catalogue_changed);
        store.lunii_cover_test_response(png());
        sent.send(progress.catalogue_revision).unwrap();
    }));
    let first = received
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    let second = received
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    assert!(first > before);
    assert!(second > first);
    for (id, revision) in ["first-cover", "second-cover"].iter().zip(cards) {
        assert_eq!(s.get_card(id).unwrap()["ficheRevision"], revision);
        assert_eq!(
            serde_json::to_value(s.lunii_thumbnail(id).unwrap().unwrap()).unwrap()["state"],
            "ready"
        );
    }
    let revision = s.list_sources().unwrap().catalogue_revision;
    s.retain_lunii_cover(
        "first-cover",
        &image_key("/public/images/packs/test.png"),
        &png(),
    )
    .unwrap();
    assert_eq!(
        s.list_sources().unwrap().catalogue_revision,
        revision,
        "retaining the same image again must be idempotent"
    );
}

#[test]
fn author_projection_accepts_people_and_ignores_unexpected_shapes() {
    for (input, expected) in [
        (r#"[" Zoe ","Ada"]"#, Some("Zoe, Ada")),
        (r#"[{"name":"Zoe"},{"name":"Ada"}]"#, Some("Zoe, Ada")),
        (
            r#"{"z":{"name":"Zoe","avatar":"ignored"},"a":{"name":"Ada"}}"#,
            Some("Zoe, Ada"),
        ),
        (r#"{"name":"Ada"}"#, Some("Ada")),
        (
            r#"{"image":{"name":"cover.png"},"name":"Ada"}"#,
            Some("Ada"),
        ),
        (
            r#"[null,3,{}," ",{"name":false},{"name":"Ada"}]"#,
            Some("Ada"),
        ),
        ("[]", None),
        ("{}", None),
        ("null", None),
        ("false", None),
        ("42", None),
        (r#""unexpected""#, None),
    ] {
        // Construct raw JSON so keyed-person order is not sorted by Value.
        let raw = format!(
            r#"{{"response":{{"pack":{{"uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","authors":{input},"localized_infos":{{"fr_FR":{{"title":"Test"}}}}}}}}}}"#
        );
        let index = parse::parse(raw.as_bytes()).unwrap();
        let p = index.values().next().unwrap();
        assert_eq!(p["author"].as_str(), expected, "{input}");
        assert!(p.get("authors").is_none());
        assert!(p.get("avatar").is_none());
    }
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    assert!(index.values().next().unwrap().get("author").is_none());
}

#[test]
fn author_fill_is_once_only_and_preserves_corrections_and_other_fields() {
    let (_temp, s) = store();
    let uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('official',0,0,0),('community',0,0,0); INSERT INTO provenance(id,kind) VALUES ('local','file'); INSERT INTO reference_value VALUES ('official','author','','\"Local author\"','local',NULL);").map_err(error)?;
        tx.execute("INSERT INTO pack_identity VALUES (?1,'official','{}')", [uuid]).map_err(error)?;
        Ok(())
    }).unwrap();
    let mut raw = fixture();
    let old = parse::parse(raw.to_string().as_bytes()).unwrap();
    s.publish_lunii(&old, "import", &AtomicBool::new(false))
        .unwrap();
    // Simulate a fiche completed by the previous version, with an old projection.
    s.write(|tx| {
        tx.execute_batch("UPDATE lunii_filled SET author_checked=0; UPDATE lunii_pack SET document_json=json_remove(document_json,'$.projectionVersion'); UPDATE lunii_state SET projection_version=1;").map_err(error)?;
        assert_eq!(fill::missing(tx)?, 0);
        Ok(())
    }).unwrap();
    raw["arbitrary-key"]["authors"] = json!([{"name":"Official author"}]);
    raw["arbitrary-key"]["localized_infos"]["fr_FR"]["title"] = json!("Changed title");
    let index = parse::parse(raw.to_string().as_bytes()).unwrap();
    s.set_lunii_permission(false).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        s.read(|c| values(c, "official")).unwrap().0.get("author"),
        None
    );
    s.set_lunii_permission(true).unwrap();
    s.write(|tx| {
        assert_eq!(fill::missing(tx)?, 1);
        Ok(())
    })
    .unwrap();
    let resolved = s
        .read(|c| super::super::data::card::resolution(c, "official", &[]))
        .unwrap();
    assert_eq!(resolved.values["author"], "Official author");
    assert_eq!(resolved.values["title"], "Lune");
    let author = resolved
        .fields
        .iter()
        .find(|f| f.field == "author")
        .unwrap();
    assert_eq!(author.effective["origin"], "lunii");
    assert!(author.reference_value.is_some());
    assert!(s.read(|c| values(c, "community")).unwrap().0.is_empty());
    raw["arbitrary-key"]["authors"] = json!(["Later author"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        s.read(|c| values(c, "official")).unwrap().0["author"],
        "Official author"
    );

    // Both new and previously filled cards respect a manual value/clear.
    for existing in [false, true] {
        for state in ["defined", "cleared"] {
            let id = format!("{existing}-{state}");
            s.write(|tx| {
                tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)", [&id])
                    .map_err(error)?;
                // Identity UUIDs may belong to multiple fixtures only after reset.
                tx.execute("DELETE FROM pack_identity WHERE pack_uuid=?1", [uuid])
                    .map_err(error)?;
                tx.execute(
                    "INSERT INTO pack_identity VALUES (?1,?2,'{}')",
                    rusqlite::params![uuid, id],
                )
                .map_err(error)?;
                tx.execute(
                    "INSERT OR IGNORE INTO provenance(id,kind) VALUES ('manual','manual')",
                    [],
                )
                .map_err(error)?;
                tx.execute(
                    "INSERT INTO correction VALUES (?1,'author','',?2,?3,'manual',NULL,1)",
                    rusqlite::params![
                        id,
                        state,
                        if state == "defined" {
                            Some("\"Personal\"")
                        } else {
                            None
                        }
                    ],
                )
                .map_err(error)?;
                if existing {
                    tx.execute("INSERT INTO lunii_filled(fiche_id) VALUES (?1)", [&id])
                        .map_err(error)?;
                }
                fill::missing(tx)?;
                Ok(())
            })
            .unwrap();
            let resolved = s
                .read(|c| super::super::data::card::resolution(c, &id, &[]))
                .unwrap();
            if state == "defined" {
                assert_eq!(resolved.values["author"], "Personal");
            } else {
                assert!(!resolved.values.contains_key("author"));
            }
            // A new card stores the official author like any other official
            // field: only a clear blocks it, a defined value merely masks it.
            // The one-time pass of an existing card never adds it under a
            // correction.
            let stored = !existing && state == "defined";
            assert_eq!(
                s.read(|c| values(c, &id)).unwrap().0.contains_key("author"),
                stored
            );
            s.write(|tx| {
                tx.execute("DELETE FROM correction WHERE fiche_id=?1", [&id])
                    .map_err(error)?;
                assert_eq!(fill::missing(tx)?, 0);
                Ok(())
            })
            .unwrap();
            let resolved = s
                .read(|c| super::super::data::card::resolution(c, &id, &[]))
                .unwrap();
            if stored {
                assert_eq!(resolved.values["author"], "Later author");
            } else {
                assert!(!s.read(|c| values(c, &id)).unwrap().0.contains_key("author"));
                assert!(!resolved.values.contains_key("author"));
            }
        }
    }
}

#[test]
fn new_official_card_receives_author_in_every_locale() {
    let (_temp, s) = store();
    s.write(|tx|{tx.execute_batch("INSERT INTO fiche VALUES ('new',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','new','{}');").map_err(error)?;Ok(())}).unwrap();
    let mut raw = fixture();
    raw["arbitrary-key"]["authors"] = json!(["First", "Second"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    for locale in ["fr", "en", "it"] {
        s.lunii_locale(locale).unwrap();
        assert_eq!(
            s.read(|c| values(c, "new")).unwrap().0["author"],
            "First, Second"
        );
    }
}

#[test]
fn outdated_projection_refreshes_once_with_consent_and_survives_restart() {
    let (temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    s.write(|tx| {
        tx.execute("UPDATE lunii_state SET projection_version=1", [])
            .map_err(error)?;
        Ok(())
    })
    .unwrap();
    s.set_lunii_permission(false).unwrap();
    let sink: scan::Sink = Arc::new(|_, _| {});
    assert!(s.open_lunii("fr", sink.clone()).unwrap()["operation"].is_null());
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 0);
    s.set_lunii_permission(true).unwrap();
    s.lunii.download_responses.lock().unwrap().extend([
        br#"{"response":{"token":{"server":"test-token"}}}"#.to_vec(),
        fixture().to_string().into_bytes(),
    ]);
    let result = s.open_lunii("fr", sink.clone()).unwrap();
    assert_eq!(wait_lunii(&s, &result["operation"]).status, "success");
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert!(s.open_lunii("fr", sink.clone()).unwrap()["operation"].is_null());
    drop(s);
    let s = Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
    assert!(s.open_lunii("fr", sink).unwrap()["operation"].is_null());
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 0);
}

#[test]
fn missing_author_is_checked_once_and_old_association_snapshots_remain_readable() {
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('empty',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','empty','{}'); INSERT INTO lunii_filled(fiche_id) VALUES ('empty');").map_err(error)?;
        Ok(())
    }).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut raw = fixture();
    raw["arbitrary-key"]["authors"] = json!(["Later"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(!s
        .read(|c| values(c, "empty"))
        .unwrap()
        .0
        .contains_key("author"));
    s.write(|tx| {
        use super::super::data::mutate::association;
        let snapshot = association::snapshot(tx, &["empty".into()])?;
        association::restore(tx, &snapshot)?;
        assert_eq!(
            tx.query_row(
                "SELECT author_checked FROM lunii_filled WHERE fiche_id='empty'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .map_err(error)?,
            1
        );
        let old = std::collections::BTreeMap::from([(
            json!(["lunii_filled", ["empty"]]).to_string(),
            json!(["empty"]),
        )]);
        association::restore(tx, &old)?;
        assert_eq!(
            tx.query_row(
                "SELECT author_checked FROM lunii_filled WHERE fiche_id='empty'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .map_err(error)?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn author_pass_never_marks_official_values_without_fill_marker() {
    // Official values may exist without the fill marker (e.g. a portable
    // import); the deferred cover link of such a card must stay intact.
    let (_temp, s) = store();
    let uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let sha = "a".repeat(64);
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('waiting',0,0,0); INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR'); INSERT INTO reference_value VALUES ('waiting','title','@lunii:fr_FR','\"Lune\"','official',NULL);").map_err(error)?;
        tx.execute("INSERT INTO pack_identity VALUES (?1,'waiting','{}')", [uuid]).map_err(error)?;
        tx.execute("INSERT INTO image_asset VALUES (?1,'image/png',1,?2)", rusqlite::params![sha, format!("images/{sha}")]).map_err(error)?;
        tx.execute("INSERT INTO lunii_pending_cover VALUES ('waiting',?1,'deferred-key','/public/images/packs/deferred.png',?2)", rusqlite::params![uuid, sha]).map_err(error)?;
        Ok(())
    }).unwrap();
    let mut raw = fixture();
    raw["arbitrary-key"]["authors"] = json!(["Official author"]);
    raw["arbitrary-key"]["locales_available"] = json!(["fr_FR"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    s.read(|c| {
        let marked: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM lunii_filled WHERE fiche_id='waiting')",
            [],
            |r| r.get(0),
        )?;
        assert!(!marked);
        let pending: i64 = c.query_row(
            "SELECT count(*) FROM lunii_pending_cover WHERE fiche_id='waiting'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(pending, 1);
        Ok(())
    })
    .unwrap();
    assert!(!s
        .read(|c| values(c, "waiting"))
        .unwrap()
        .0
        .contains_key("language"));
    assert!(!s
        .read(|c| values(c, "waiting"))
        .unwrap()
        .0
        .contains_key("author"));
}

#[test]
fn failed_renewal_of_an_old_projection_keeps_data_and_markers() {
    let (_temp, s) = store();
    s.write(|tx|{tx.execute_batch("INSERT INTO fiche VALUES ('kept',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','kept','{}');").map_err(error)?;Ok(())}).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    // State left by the previous version: v1 projection, card filled once.
    s.write(|tx| {
        tx.execute_batch("UPDATE lunii_filled SET author_checked=0; UPDATE lunii_pack SET document_json=json_remove(document_json,'$.projectionVersion'); UPDATE lunii_state SET projection_version=1;").map_err(error)?;
        Ok(())
    })
    .unwrap();
    let state = |s: &Store| {
        s.read(|c| {
            let packs: Vec<(String, String)> = c
                .prepare("SELECT uuid,document_json FROM lunii_pack ORDER BY uuid")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let values: Vec<(String, String)> = c
                .prepare("SELECT field,value_json FROM reference_value WHERE fiche_id='kept' ORDER BY field,language")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let version: i64 =
                c.query_row("SELECT projection_version FROM lunii_state", [], |r| r.get(0))?;
            let checked: i64 = c.query_row(
                "SELECT author_checked FROM lunii_filled WHERE fiche_id='kept'",
                [],
                |r| r.get(0),
            )?;
            Ok((packs, values, version, checked))
        })
        .unwrap()
    };
    let before = state(&s);
    assert_eq!((before.2, before.3), (1, 0));
    // The token is accepted, then the database answer is unusable.
    s.lunii.download_responses.lock().unwrap().extend([
        br#"{"response":{"token":{"server":"test-token"}}}"#.to_vec(),
        b"not json".to_vec(),
    ]);
    let sink: scan::Sink = Arc::new(|_, _| {});
    let result = s.open_lunii("fr", sink.clone()).unwrap();
    assert_eq!(wait_lunii(&s, &result["operation"]).status, "failed");
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert_eq!(state(&s), before);
    // One automatic attempt per session.
    assert!(s.open_lunii("fr", sink).unwrap()["operation"].is_null());
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert_eq!(state(&s), before);
}

#[test]
fn language_fill_is_once_only_and_preserves_corrections_and_other_fields() {
    let (_temp, s) = store();
    let uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('official',0,0,0),('community',0,0,0); INSERT INTO provenance(id,kind) VALUES ('local','file'); INSERT INTO reference_value VALUES ('official','language','','\"Local language\"','local',NULL);").map_err(error)?;
        tx.execute("INSERT INTO pack_identity VALUES (?1,'official','{}')", [uuid]).map_err(error)?;
        Ok(())
    }).unwrap();
    let mut raw = fixture();
    let old = parse::parse(raw.to_string().as_bytes()).unwrap();
    s.publish_lunii(&old, "import", &AtomicBool::new(false))
        .unwrap();
    // Simulate a fiche completed by the previous version, with an old projection.
    s.write(|tx| {
        tx.execute_batch("UPDATE lunii_filled SET checked_fields='[]'; UPDATE lunii_pack SET document_json=json_set(document_json,'$.projectionVersion',2); UPDATE lunii_state SET projection_version=2;").map_err(error)?;
        assert_eq!(fill::missing(tx)?, 0);
        Ok(())
    }).unwrap();
    raw["arbitrary-key"]["locales_available"] = json!(["it_IT"]);
    raw["arbitrary-key"]["localized_infos"]["fr_FR"]["title"] = json!("Changed title");
    let index = parse::parse(raw.to_string().as_bytes()).unwrap();
    s.set_lunii_permission(false).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        s.read(|c| values(c, "official")).unwrap().0.get("language"),
        None
    );
    s.set_lunii_permission(true).unwrap();
    s.write(|tx| {
        assert_eq!(fill::missing(tx)?, 1);
        Ok(())
    })
    .unwrap();
    let resolved = s
        .read(|c| super::super::data::card::resolution(c, "official", &[]))
        .unwrap();
    assert_eq!(resolved.values["language"], "it");
    assert_eq!(resolved.values["title"], "Lune");
    let language = resolved
        .fields
        .iter()
        .find(|f| f.field == "language")
        .unwrap();
    assert_eq!(language.effective["origin"], "lunii");
    assert!(language.reference_value.is_some());
    assert!(s.read(|c| values(c, "community")).unwrap().0.is_empty());
    raw["arbitrary-key"]["locales_available"] = json!(["en_GB"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        s.read(|c| values(c, "official")).unwrap().0["language"],
        "it"
    );

    // Both new and previously filled cards respect a manual value/clear.
    for existing in [false, true] {
        for state in ["defined", "cleared"] {
            let id = format!("{existing}-{state}");
            s.write(|tx| {
                tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)", [&id])
                    .map_err(error)?;
                // Identity UUIDs may belong to multiple fixtures only after reset.
                tx.execute("DELETE FROM pack_identity WHERE pack_uuid=?1", [uuid])
                    .map_err(error)?;
                tx.execute(
                    "INSERT INTO pack_identity VALUES (?1,?2,'{}')",
                    rusqlite::params![uuid, id],
                )
                .map_err(error)?;
                tx.execute(
                    "INSERT OR IGNORE INTO provenance(id,kind) VALUES ('manual','manual')",
                    [],
                )
                .map_err(error)?;
                tx.execute(
                    "INSERT INTO correction VALUES (?1,'language','',?2,?3,'manual',NULL,1)",
                    rusqlite::params![
                        id,
                        state,
                        if state == "defined" {
                            Some("\"Personal\"")
                        } else {
                            None
                        }
                    ],
                )
                .map_err(error)?;
                if existing {
                    tx.execute("INSERT INTO lunii_filled(fiche_id) VALUES (?1)", [&id])
                        .map_err(error)?;
                }
                fill::missing(tx)?;
                Ok(())
            })
            .unwrap();
            let resolved = s
                .read(|c| super::super::data::card::resolution(c, &id, &[]))
                .unwrap();
            if state == "defined" {
                assert_eq!(resolved.values["language"], "Personal");
            } else {
                assert!(!resolved.values.contains_key("language"));
            }
            // A new card stores the official language like any other official
            // field: only a clear blocks it, a defined value merely masks it.
            // The one-time pass of an existing card never adds it under a
            // correction.
            let stored = !existing && state == "defined";
            assert_eq!(
                s.read(|c| values(c, &id))
                    .unwrap()
                    .0
                    .contains_key("language"),
                stored
            );
            s.write(|tx| {
                tx.execute("DELETE FROM correction WHERE fiche_id=?1", [&id])
                    .map_err(error)?;
                assert_eq!(fill::missing(tx)?, 0);
                Ok(())
            })
            .unwrap();
            let resolved = s
                .read(|c| super::super::data::card::resolution(c, &id, &[]))
                .unwrap();
            if stored {
                assert_eq!(resolved.values["language"], "en");
            } else {
                assert!(!s
                    .read(|c| values(c, &id))
                    .unwrap()
                    .0
                    .contains_key("language"));
                assert!(!resolved.values.contains_key("language"));
            }
        }
    }
}

#[test]
fn new_official_card_receives_language_in_every_locale() {
    let (_temp, s) = store();
    s.write(|tx|{tx.execute_batch("INSERT INTO fiche VALUES ('new',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','new','{}');").map_err(error)?;Ok(())}).unwrap();
    let mut raw = fixture();
    raw["arbitrary-key"]["locales_available"] = json!(["es_MX"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    for locale in ["fr", "en", "it"] {
        s.lunii_locale(locale).unwrap();
        assert_eq!(s.read(|c| values(c, "new")).unwrap().0["language"], "es");
    }
}

#[test]
fn content_language_projection_requires_a_single_valid_locale() {
    for (input, expected) in [
        (json!(["fr_FR"]), Some("fr")),
        (json!(["it_IT"]), Some("it")),
        (json!(["en_US"]), Some("en")),
        (json!(["en_GB"]), Some("en")),
        (json!(["es_ES"]), Some("es")),
        (json!(["es_MX"]), Some("es")),
        (json!(["de_DE"]), Some("de")),
        (json!(["nl_NL"]), Some("nl")),
        (json!(["fr"]), Some("fr")),
        (json!(["fr_FR", "it_IT"]), None),
        (json!(["en_US", "en_GB"]), None),
        (json!(["fr_FR", null]), None),
        (json!([]), None),
        (Value::Null, None),
        (json!("fr_FR"), None),
        // Lunii's actual shape: a locale map where only `true` entries count.
        (json!({"fr_FR":true}), Some("fr")),
        (json!({"it_IT":true,"fr_FR":false}), Some("it")),
        (json!({"fr_FR":true,"en_US":true}), None),
        (json!({"fr_FR":false}), None),
        (json!({}), None),
        (json!({"fr_FR":"true"}), None),
        (json!({"fr_FR":1}), None),
        (json!({"bad_locale":true}), None),
        (json!([true]), None),
        (json!([{}]), None),
        (json!(["bad_locale"]), None),
        (json!(["fr_FR_extra"]), None),
        (json!([" FR "]), None),
        (json!(["fr_12"]), None),
    ] {
        let mut raw = fixture();
        raw["arbitrary-key"]["locales_available"] = input.clone();
        let index = parse::parse(raw.to_string().as_bytes()).unwrap();
        let pack = index.values().next().unwrap();
        assert_eq!(pack["language"].as_str(), expected, "{input}");
        assert_eq!(pack["projectionVersion"], 4);
        assert!(pack.get("locales_available").is_none());
        assert_eq!(
            parse::localized(pack, "en").unwrap().1["language"].as_str(),
            expected
        );
    }
}

#[test]
fn missing_content_language_is_checked_once_and_snapshots_keep_markers() {
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('empty',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','empty','{}'); INSERT INTO lunii_filled(fiche_id,author_checked) VALUES ('empty',1);").map_err(error)?;
        Ok(())
    }).unwrap();
    for locales in [json!(["fr_FR", "en_US"]), json!(["fr_FR"])] {
        let mut raw = fixture();
        raw["arbitrary-key"]["locales_available"] = locales;
        s.publish_lunii(
            &parse::parse(raw.to_string().as_bytes()).unwrap(),
            "import",
            &AtomicBool::new(false),
        )
        .unwrap();
    }
    assert!(!s
        .read(|c| values(c, "empty"))
        .unwrap()
        .0
        .contains_key("language"));
    s.write(|tx| {
        use super::super::data::mutate::association;
        let snapshot = association::snapshot(tx, &["empty".into()])?;
        association::restore(tx, &snapshot)?;
        let checked: String = tx
            .query_row(
                "SELECT checked_fields FROM lunii_filled WHERE fiche_id='empty'",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        assert_eq!(checked, r#"["language"]"#);
        // A v5 undo row still restores author_checked and defaults new fields.
        let old = std::collections::BTreeMap::from([(
            json!(["lunii_filled", ["empty"]]).to_string(),
            json!(["empty", 1]),
        )]);
        association::restore(tx, &old)?;
        let markers: (i64, String) = tx
            .query_row(
                "SELECT author_checked,checked_fields FROM lunii_filled WHERE fiche_id='empty'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(error)?;
        assert_eq!(markers, (1, "[]".into()));
        Ok(())
    })
    .unwrap();
}

#[test]
fn v2_projection_refreshes_once_with_consent_and_survives_restart() {
    let (temp, s) = store();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    s.write(|tx| {
        tx.execute("UPDATE lunii_state SET projection_version=2", [])
            .map_err(error)?;
        Ok(())
    })
    .unwrap();
    s.set_lunii_permission(false).unwrap();
    let sink: scan::Sink = Arc::new(|_, _| {});
    assert!(s.open_lunii("fr", sink.clone()).unwrap()["operation"].is_null());
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 0);
    s.set_lunii_permission(true).unwrap();
    s.lunii.download_responses.lock().unwrap().extend([
        br#"{"response":{"token":{"server":"test-token"}}}"#.to_vec(),
        fixture().to_string().into_bytes(),
    ]);
    let result = s.open_lunii("fr", sink.clone()).unwrap();
    assert_eq!(wait_lunii(&s, &result["operation"]).status, "success");
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert!(s.open_lunii("fr", sink.clone()).unwrap()["operation"].is_null());
    drop(s);
    let s = Arc::new(Store::open(&temp.path().join("data"), &temp.path().join("cache")).unwrap());
    assert!(s.open_lunii("fr", sink).unwrap()["operation"].is_null());
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 0);
}

#[test]
fn failed_renewal_of_v2_projection_keeps_data_and_markers() {
    let (_temp, s) = store();
    s.write(|tx|{tx.execute_batch("INSERT INTO fiche VALUES ('kept',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','kept','{}');").map_err(error)?;Ok(())}).unwrap();
    s.publish_lunii(
        &parse::parse(fixture().to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    // State left by v5: v2 projection, author already checked.
    s.write(|tx| {
        tx.execute_batch("UPDATE lunii_filled SET checked_fields='[]'; UPDATE lunii_pack SET document_json=json_set(document_json,'$.projectionVersion',2); UPDATE lunii_state SET projection_version=2;").map_err(error)?;
        Ok(())
    })
    .unwrap();
    let state = |s: &Store| {
        s.read(|c| {
            let packs: Vec<(String, String)> = c
                .prepare("SELECT uuid,document_json FROM lunii_pack ORDER BY uuid")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let values: Vec<(String, String)> = c
                .prepare("SELECT field,value_json FROM reference_value WHERE fiche_id='kept' ORDER BY field,language")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let version: i64 =
                c.query_row("SELECT projection_version FROM lunii_state", [], |r| r.get(0))?;
            let checked: String = c.query_row(
                "SELECT checked_fields FROM lunii_filled WHERE fiche_id='kept'",
                [],
                |r| r.get(0),
            )?;
            Ok((packs, values, version, checked))
        })
        .unwrap()
    };
    let before = state(&s);
    assert_eq!((before.2, before.3.as_str()), (2, "[]"));
    // The token is accepted, then the database answer is unusable.
    s.lunii.download_responses.lock().unwrap().extend([
        br#"{"response":{"token":{"server":"test-token"}}}"#.to_vec(),
        b"not json".to_vec(),
    ]);
    let sink: scan::Sink = Arc::new(|_, _| {});
    let result = s.open_lunii("fr", sink.clone()).unwrap();
    assert_eq!(wait_lunii(&s, &result["operation"]).status, "failed");
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert_eq!(state(&s), before);
    // One automatic attempt per session.
    assert!(s.open_lunii("fr", sink).unwrap()["operation"].is_null());
    assert_eq!(s.lunii.download_requests.load(Ordering::SeqCst), 2);
    assert_eq!(state(&s), before);
}

#[test]
fn content_language_pass_preserves_existing_lunii_values_and_author_marker() {
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('kept',0,0,4); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','kept','{}'); INSERT INTO lunii_filled(fiche_id,author_checked) VALUES ('kept',1); INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR'); INSERT INTO reference_value VALUES ('kept','language','@lunii:fr_FR','\"nl\"','official',NULL);").map_err(error)?;
        Ok(())
    }).unwrap();
    let mut raw = fixture();
    raw["arbitrary-key"]["authors"] = json!(["New author"]);
    raw["arbitrary-key"]["locales_available"] = json!(["it_IT"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    let saved = s.read(|c| values(c, "kept")).unwrap().0;
    assert_eq!(saved["language"], "nl");
    assert!(!saved.contains_key("author"));
    s.read(|c| {
        assert_eq!(
            c.query_row("SELECT revision FROM fiche WHERE id='kept'", [], |r| r
                .get::<_, i64>(0))?,
            4
        );
        assert_eq!(
            c.query_row(
                "SELECT checked_fields FROM lunii_filled WHERE fiche_id='kept'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            r#"["language"]"#
        );
        Ok(())
    })
    .unwrap();
}

// Excerpt of Lunii's actual official metadata: packs keyed by an opaque id,
// `locales_available` as a locale map and `authors` as an indexed object.
fn real_shape() -> Value {
    json!({"code":"0.0","response":{
        "-NfGoq8CodTwNa_IIBQ4":{"uuid":"2f1ab6c1-279c-438b-8c03-f916d4390854","age_min":7,"age_max":-1,"keywords":"Mathématiques,multiplication","locales_available":{"fr_FR":true},"authors":{"-NfH3XkXvoWJRvUMS5i2":{"name":"Rémi Chaurand","gender":"male","image_url":"/public/images/avatars/avatar9.png"}},"localized_infos":{"fr_FR":{"title":"Les chevaliers de la table de multiplication","subtitle":"4 histoires et 9 tables à jouer","description":"Récit"}},"story_count":0,"duration":3300000},
        "-MB4sMjF28GjLlGK8Ot9":{"uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","age_min":5,"locales_available":{"fr_FR":true,"en_US":true},"authors":{},"localized_infos":{"fr_FR":{"title":"Bilingue"},"en_US":{"title":"Bilingual"}}},
        "-Mw25tqfkNsj-_aR4VAA":{"uuid":"bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee","age_min":5,"locales_available":{"it_IT":true},"authors":{"x":{"name":"Autrice"}},"localized_infos":{"it_IT":{"title":"Luna"}}}
    }})
}

#[test]
fn real_lunii_shape_projects_language_and_author() {
    let index = parse::parse(real_shape().to_string().as_bytes()).unwrap();
    let chevaliers = &index["2f1ab6c1-279c-438b-8c03-f916d4390854"];
    assert_eq!(chevaliers["language"], "fr");
    assert_eq!(chevaliers["author"], "Rémi Chaurand");
    assert_eq!(chevaliers["projectionVersion"], 4);
    assert!(index["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]
        .get("language")
        .is_none());
    assert_eq!(
        index["bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"]["language"],
        "it"
    );
}

#[test]
fn void_language_markers_are_refilled_after_v7_and_projection_v4() {
    // State left by FX-LANGUE: projection v3 without language, every filled
    // fiche wrongly marked `["language"]`.
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('official',0,0,0),('corrected',0,0,0); INSERT INTO pack_identity VALUES ('2f1ab6c1-279c-438b-8c03-f916d4390854','official','{}'),('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','corrected','{}'); INSERT INTO provenance(id,kind) VALUES ('local','file'); INSERT INTO correction(fiche_id,field,state,value_json,provenance_id,revision) VALUES ('corrected','language','defined','\"de\"','local',1);").map_err(error)?;
        Ok(())
    })
    .unwrap();
    let index = parse::parse(real_shape().to_string().as_bytes()).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    s.write(|tx| {
        tx.execute_batch(r#"DELETE FROM reference_value WHERE field='language'; UPDATE lunii_filled SET checked_fields='["language"]'; UPDATE lunii_pack SET document_json=json_set(json_remove(document_json,'$.language'),'$.projectionVersion',3); UPDATE lunii_state SET projection_version=3;"#).map_err(error)?;
        // Durable migration v7.
        tx.execute_batch(include_str!("../store/durable_v7.sql"))
            .map_err(error)?;
        // A v3 projection never completes the language pass.
        assert_eq!(fill::missing(tx)?, 0);
        let checked: String = tx
            .query_row(
                "SELECT checked_fields FROM lunii_filled WHERE fiche_id='official'",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        assert_eq!(checked, "[]");
        Ok(())
    })
    .unwrap();
    let language = |id: &str| {
        s.read(|c| super::super::data::card::resolution(c, id, &[]))
            .unwrap()
            .values
            .get("language")
            .cloned()
    };
    assert_eq!(language("official"), None);
    // Renewal with the v4 projection.
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(language("official"), Some(json!("fr")));
    assert_eq!(language("corrected"), Some(json!("de")));
    s.read(|c| {
        let checked: Vec<String> = c
            .prepare("SELECT checked_fields FROM lunii_filled ORDER BY fiche_id")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        assert_eq!(checked, vec![r#"["language"]"#, r#"["language"]"#]);
        Ok(())
    })
    .unwrap();
}

/// Every field retouchable from the fiche keeps the user's correction, set or
/// intentionally cleared, when the official base fills or refills the card.
#[test]
fn fill_never_overwrites_a_correction_on_any_retouchable_field() {
    let (_temp, s) = store();
    s.write(|tx| {
        tx.execute_batch(r#"INSERT INTO fiche VALUES ('mine',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','mine','{}'); INSERT INTO provenance(id,kind) VALUES ('manual','manual');
            INSERT INTO correction VALUES ('mine','title','','defined','"Mon titre"','manual',NULL,1);
            INSERT INTO correction VALUES ('mine','description','','defined','"Ma description"','manual',NULL,1);
            INSERT INTO correction VALUES ('mine','language','','defined','"it"','manual',NULL,1);
            INSERT INTO correction VALUES ('mine','author','','defined','"Mon auteur"','manual',NULL,1);
            INSERT INTO correction VALUES ('mine','producer','','defined','"Mon producteur"','manual',NULL,1);
            INSERT INTO correction VALUES ('mine','bonus','','cleared',NULL,'manual',NULL,1);
            INSERT INTO correction VALUES ('mine','ageMin','','defined','9','manual',NULL,1);"#).map_err(error)?;
        Ok(())
    }).unwrap();
    let mut raw = fixture();
    raw["arbitrary-key"]["authors"] = json!(["Official author"]);
    raw["arbitrary-key"]["locales_available"] = json!(["fr_FR"]);
    s.publish_lunii(
        &parse::parse(raw.to_string().as_bytes()).unwrap(),
        "import",
        &AtomicBool::new(false),
    )
    .unwrap();
    // A later pass for newer fields (author, language) must not overwrite either.
    s.write(|tx| {
        tx.execute_batch("UPDATE lunii_filled SET author_checked=0, checked_fields='[]';")
            .map_err(error)?;
        fill::missing(tx)?;
        Ok(())
    })
    .unwrap();
    let card = s.get_card("mine").unwrap();
    let fields = card["fields"].as_array().unwrap();
    let value = |field: &str| {
        &fields
            .iter()
            .find(|f| f["field"] == field && f["language"].is_null())
            .unwrap()["effective"]["value"]
    };
    assert_eq!(value("title"), "Mon titre");
    assert_eq!(value("description"), "Ma description");
    assert_eq!(value("language"), "it");
    assert_eq!(value("author"), "Mon auteur");
    assert_eq!(value("producer"), "Mon producteur");
    assert!(value("bonus").is_null());
    assert_eq!(value("ageMin"), 9);
    // The list projection (filters, sort, cards) follows the same precedence.
    let listed = s
        .read(|c| super::super::data::card::resolution(c, "mine", &[]))
        .unwrap()
        .values;
    assert_eq!(listed["description"], "Ma description");
    assert_eq!(listed["author"], "Mon auteur");
    assert_eq!(listed["language"], "it");
    assert_eq!(listed["producer"], "Mon producteur");
    assert!(!listed.contains_key("bonus"));
}

#[test]
fn catalogue_import_official_cover_is_read_only_without_acquisition() {
    let (_temp, s) = store();
    let index = parse::parse(fixture().to_string().as_bytes()).unwrap();
    s.publish_lunii(&index, "import", &AtomicBool::new(false))
        .unwrap();
    s.write(|tx| {
        tx.execute("INSERT INTO fiche(id,created_at,revision) VALUES ('import-cover',0,0)", []).map_err(error)?;
        tx.execute("INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','import-cover','{}')", []).map_err(error)?;
        fill::missing(tx)?;
        Ok(())
    }).unwrap();
    *s.lunii.cover_response.lock().unwrap() = Some(png());
    s.lunii
        .cover_response_configured
        .store(true, Ordering::SeqCst);
    let before = s.list_sources().unwrap().catalogue_revision;
    assert!(s.import_local_cover("import-cover").unwrap().is_none());
    assert_eq!(s.list_sources().unwrap().catalogue_revision, before);
    assert_eq!(s.lunii.cover_requests.load(Ordering::SeqCst), 0);
    assert!(s.lunii.cover_attempted.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(s.images_root()).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_dir(s.thumbnail_root()).map_or(0, |entries| entries.count()),
        0
    );
    assert_eq!(
        std::fs::read_dir(s.cover_root()).map_or(0, |entries| entries.count()),
        0
    );
    // A previously retained official image is readable without acquisition.
    let bytes = super::super::thumbnails::encode_bounded(&png()).unwrap();
    s.retain_lunii_cover(
        "import-cover",
        &image_key("/public/images/packs/test.png"),
        &bytes,
    )
    .unwrap();
    let before = s.list_sources().unwrap().catalogue_revision;
    assert_eq!(s.import_local_cover("import-cover").unwrap(), Some(bytes));
    assert_eq!(s.list_sources().unwrap().catalogue_revision, before);
    assert_eq!(s.lunii.cover_requests.load(Ordering::SeqCst), 0);
}
