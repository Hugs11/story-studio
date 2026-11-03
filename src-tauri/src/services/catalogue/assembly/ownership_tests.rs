use super::ownership::Preparation;
use crate::services::catalogue::store::Store;
use crate::support::{temp, user_message::codes};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    store: Store,
    session: String,
    preparation: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("assembly-transfer-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&root.join("data"), &root.join("cache")).unwrap();
        let session = temp::create_session_workspace(&root.join("sessions")).unwrap();
        let preparation = root.join("prepared");
        fs::create_dir(&preparation).unwrap();
        fs::write(preparation.join("0.zip"), b"archive media").unwrap();
        fs::write(preparation.join("0.jpg"), b"corrected cover").unwrap();
        store.assemblies.lock().unwrap().preparations.insert(
            "prepared".into(),
            Preparation {
                root: preparation.clone(),
                readers: 0,
                release_requested: false,
            },
        );
        Self {
            root,
            store,
            session,
            preparation,
        }
    }
    fn transfer(&self, request: &str) -> crate::services::catalogue::Result<Value> {
        self.store.transfer_assembly(
            &self.root.join("sessions"),
            "prepared",
            &self.session,
            request,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = temp::cleanup_session_workspace(&self.root.join("sessions"), &self.session);
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn assembly_transfer_contract_and_release_preserve_session_assets() {
    let f = Fixture::new();
    let receipt = f.transfer("request").unwrap();
    assert_eq!(receipt["ownerSessionId"], f.session);
    let mut contract = receipt.clone();
    contract["ownerSessionId"] = json!("session");
    for asset in contract["assets"].as_array_mut().unwrap() {
        for (field, root) in [("sourcePath", "/prepared"), ("sessionPath", "/session")] {
            let filename = PathBuf::from(asset[field].as_str().unwrap())
                .file_name()
                .unwrap()
                .to_owned();
            asset[field] = json!(format!("{root}/{}", filename.to_str().unwrap()));
        }
    }
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/assembly-transfer.json"
    ))
    .unwrap();
    assert_eq!(contract, fixture);
    assert_eq!(f.transfer("request").unwrap(), receipt);
    f.store.release_assembly("prepared").unwrap();
    assert!(!f.preparation.exists());
    // Replays remain available after the assistant relinquishes its preparation.
    assert_eq!(f.transfer("request").unwrap(), receipt);
    for asset in receipt["assets"].as_array().unwrap() {
        let path = PathBuf::from(asset["sessionPath"].as_str().unwrap());
        assert!(path.starts_with(&f.session));
        let expected: &[u8] = if path.extension().unwrap() == "zip" {
            b"archive media"
        } else {
            b"corrected cover"
        };
        assert_eq!(fs::read(path).unwrap(), expected);
    }
}

#[test]
fn assembly_transfer_rejects_forged_sessions_even_under_cache() {
    let f = Fixture::new();
    let forged = f
        .root
        .join("sessions")
        .join(format!("{}forged", temp::SESSION_WORKSPACE_PREFIX));
    fs::create_dir(&forged).unwrap();
    for id in [
        "../../outside".to_owned(),
        forged.to_string_lossy().into_owned(),
        f.root.to_string_lossy().into_owned(),
    ] {
        let err = f
            .store
            .transfer_assembly(&f.root.join("sessions"), "prepared", &id, "request")
            .unwrap_err();
        assert_eq!(err.code, codes::CATALOG_ASSEMBLY_SESSION_INVALID);
    }
    assert!(f.preparation.join("0.zip").is_file());
}

#[test]
fn assembly_transfer_failure_rolls_back_partial_copy_and_can_retry() {
    let f = Fixture::new();
    fs::create_dir(f.preparation.join("z-unexpected-directory")).unwrap();
    let err = f.transfer("retry").unwrap_err();
    assert_eq!(err.code, codes::CATALOG_ASSEMBLY_TRANSFER_FAILED);
    assert_eq!(
        fs::read_dir(PathBuf::from(&f.session).join("fichiers-importes"))
            .unwrap()
            .count(),
        0
    );
    assert!(f.preparation.join("0.zip").is_file());
    fs::remove_dir(f.preparation.join("z-unexpected-directory")).unwrap();
    assert!(f.transfer("retry").unwrap()["transferred"]
        .as_bool()
        .unwrap());
}

#[test]
fn assembly_transfer_refuses_reused_request_with_different_identity() {
    let f = Fixture::new();
    f.transfer("request").unwrap();
    let other = temp::create_session_workspace(&f.root.join("sessions")).unwrap();
    let result = f
        .store
        .transfer_assembly(&f.root.join("sessions"), "prepared", &other, "request");
    assert_eq!(
        result.unwrap_err().code,
        codes::CATALOG_ASSEMBLY_TRANSFER_FAILED
    );
    let result =
        f.store
            .transfer_assembly(&f.root.join("sessions"), "other", &f.session, "request");
    assert_eq!(
        result.unwrap_err().code,
        codes::CATALOG_ASSEMBLY_TRANSFER_FAILED
    );
    temp::cleanup_session_workspace(&f.root.join("sessions"), &other).unwrap();
}

#[test]
fn assembly_transfer_refuses_closed_or_replaced_session_and_empty_request() {
    let f = Fixture::new();
    assert_eq!(
        f.transfer("").unwrap_err().code,
        codes::CATALOG_ASSEMBLY_TRANSFER_FAILED
    );
    f.transfer("request").unwrap();
    temp::cleanup_session_workspace(&f.root.join("sessions"), &f.session).unwrap();
    fs::create_dir_all(&f.session).unwrap();
    assert_eq!(
        f.transfer("request").unwrap_err().code,
        codes::CATALOG_ASSEMBLY_SESSION_INVALID
    );
}

#[test]
fn assembly_transfer_respects_preparation_readers_and_deferred_release() {
    let f = Fixture::new();
    let lease = f.store.retain_assembly_task("prepared").unwrap();
    let receipt = f.transfer("request").unwrap();
    assert!(f.store.release_assembly("prepared").is_err());
    assert_eq!(
        f.transfer("other").unwrap_err().code,
        codes::CATALOG_ASSEMBLY_TRANSFER_FAILED
    );
    f.store.finish_assembly_task(&lease).unwrap();
    assert!(!f.preparation.exists());
    assert!(PathBuf::from(receipt["assets"][0]["sessionPath"].as_str().unwrap()).is_file());
}

#[test]
fn assembly_transfer_copies_accented_names_and_preserves_case() {
    let f = Fixture::new();
    fs::write(f.preparation.join("Été long nom de média.mp3"), b"voice").unwrap();
    fs::write(f.preparation.join("Cover.PNG"), b"image").unwrap();
    let receipt = f.transfer("request").unwrap();
    let names = receipt["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|asset| {
            PathBuf::from(asset["sessionPath"].as_str().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert!(names.contains(&"Été long nom de média.mp3".into()));
    assert!(names.contains(&"Cover.PNG".into()));
}

#[cfg(unix)]
#[test]
fn assembly_transfer_refuses_symlinked_preparation_assets() {
    let f = Fixture::new();
    std::os::unix::fs::symlink(f.preparation.join("0.zip"), f.preparation.join("link.zip"))
        .unwrap();
    assert_eq!(
        f.transfer("request").unwrap_err().code,
        codes::CATALOG_ASSEMBLY_TRANSFER_FAILED
    );
}

#[test]
fn assembly_transfer_survives_orphan_cache_cleanup_during_live_session() {
    let f = Fixture::new();
    let receipt = f.transfer("request").unwrap();
    f.store.release_assembly("prepared").unwrap();
    temp::cleanup_orphan_session_workspaces(&f.root.join("sessions"), std::time::Duration::ZERO);
    assert!(PathBuf::from(receipt["assets"][0]["sessionPath"].as_str().unwrap()).is_file());
    assert_eq!(f.transfer("request").unwrap(), receipt);
}

#[test]
fn assembly_transfer_pack_is_simulatable_and_generates_verified_archive_after_release() {
    use std::io::{Read, Write};
    let f = Fixture::new();
    let root_id = "11111111-1111-4111-8111-111111111111";
    let story_id = "22222222-2222-4222-8222-222222222222";
    let story = json!({
        "format":"v1", "version":1, "title":"Source",
        "stageNodes":[
            {"uuid":root_id,"name":"Accueil","squareOne":true,"controlSettings":{"wheel":true,"ok":true,"home":false,"pause":false,"autoplay":false},"okTransition":{"actionNode":"choose","optionIndex":0}},
            {"uuid":"33333333-3333-4333-8333-333333333333","name":"Titre","squareOne":false,"controlSettings":{"wheel":true,"ok":true,"home":true,"pause":false,"autoplay":false},"okTransition":{"actionNode":"play","optionIndex":0}},
            {"uuid":story_id,"name":"Histoire","squareOne":false,"controlSettings":{"wheel":false,"ok":false,"home":true,"pause":false,"autoplay":false},"homeTransition":{"actionNode":"choose","optionIndex":0}}
        ],
        "actionNodes":[{"id":"choose","options":["33333333-3333-4333-8333-333333333333"]},{"id":"play","options":[story_id]}]
    });
    let mut archive = zip::ZipWriter::new(fs::File::create(f.preparation.join("0.zip")).unwrap());
    archive
        .start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive
        .write_all(&serde_json::to_vec(&story).unwrap())
        .unwrap();
    archive.finish().unwrap();
    let sample_rate = 44100_u32;
    let samples = sample_rate;
    let data_size = samples * 2;
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for index in 0..samples {
        let sample = ((f64::from(index) * 440.0 * std::f64::consts::TAU / f64::from(sample_rate))
            .sin()
            * 4000.0) as i16;
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    fs::write(f.preparation.join("root.wav"), wav).unwrap();
    image::RgbImage::from_pixel(320, 240, image::Rgb([32, 64, 96]))
        .save(f.preparation.join("root.png"))
        .unwrap();
    let receipt = f.transfer("generate").unwrap();
    let zip_path = receipt["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["sourcePath"].as_str().unwrap().ends_with("0.zip"))
        .unwrap()["sessionPath"]
        .as_str()
        .unwrap();
    let asset = |name: &str| {
        receipt["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|asset| {
                PathBuf::from(asset["sourcePath"].as_str().unwrap())
                    .file_name()
                    .unwrap()
                    == name
            })
            .unwrap()["sessionPath"]
            .as_str()
            .unwrap()
    };
    f.store.release_assembly("prepared").unwrap();
    let project: crate::domain::project::Project = serde_json::from_value(json!({
        "name":"Assemblage", "projectType":"pack", "packUuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "rootAudio":asset("root.wav"), "rootImage":asset("root.png"), "thumbnailImage":asset("root.png"),
        "rootEntries":[{"id":"zip-entry","type":"zip","name":"Source","zipPath":zip_path}],
        "globalOptions":{"autoNext":false,"nightMode":false,"harmonizeLoudness":true,"silenceMode":"normalize"}
    })).unwrap();
    let simulation =
        crate::native_pack::simulation::project_story_for_simulation(&project).unwrap();
    assert!(!serde_json::to_string(&simulation.story).unwrap().is_empty());
    let result = crate::native_pack::generate_native_pack_v1_with_cancel(
        &project,
        f.root.join("output").to_str().unwrap(),
        &|_| {},
        &|| false,
    )
    .unwrap();
    let report = crate::support::lunii_zip_validator::validate_lunii_zip(&result.zip_path);
    assert!(report.valid, "{:#?}", report.issues);
    assert_eq!(result.gate_observations.len(), 3);
    let mut archive = zip::ZipArchive::new(fs::File::open(result.zip_path).unwrap()).unwrap();
    let mut text = String::new();
    archive
        .by_name("story.json")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    let generated: Value = serde_json::from_str(&text).unwrap();
    assert!(generated["stageNodes"].as_array().unwrap().len() >= 2);
}

#[test]
fn assembly_transfer_rejects_session_recreated_outside_session_lifecycle() {
    let f = Fixture::new();
    fs::remove_dir_all(&f.session).unwrap();
    fs::create_dir_all(PathBuf::from(&f.session).join("fichiers-importes")).unwrap();
    assert_eq!(
        f.transfer("request").unwrap_err().code,
        codes::CATALOG_ASSEMBLY_SESSION_INVALID
    );
}

#[cfg(unix)]
#[test]
fn assembly_transfer_rejects_symlinked_destination_category() {
    let f = Fixture::new();
    let imports = PathBuf::from(&f.session).join("fichiers-importes");
    fs::remove_dir(&imports).unwrap();
    let outside = f.root.join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, &imports).unwrap();
    assert_eq!(
        f.transfer("request").unwrap_err().code,
        codes::CATALOG_ASSEMBLY_SESSION_INVALID
    );
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}

#[test]
fn failed_orphan_cleanup_does_not_block_catalogue_opening() {
    let root = std::env::temp_dir().join(format!("assembly-cleanup-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("data/catalogue")).unwrap();
    // A non-directory orphan exercises a deterministic remove_dir_all failure
    // on all platforms, without depending on elevated-user permission semantics.
    fs::write(root.join("data/catalogue/assembly"), b"orphan").unwrap();
    let store = Store::open(&root.join("data"), &root.join("cache"));
    assert!(store.is_ok());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
