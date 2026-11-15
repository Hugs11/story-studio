use super::*;
use std::io::Write;

#[test]
fn exact_asset_path_takes_priority_over_backslash_fallback() {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for name in [r"assets\cover.mp3", "assets/cover.mp3"] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .expect("asset");
        writer.write_all(name.as_bytes()).expect("bytes");
    }
    let archive = zip::ZipArchive::new(writer.finish().expect("zip")).expect("archive");
    assert_eq!(
        crate::services::pack_reader::resolve_zip_asset_name(&archive, "assets/cover.mp3"),
        "assets/cover.mp3"
    );
}

/// Un ZIP produit par Compress-Archive range ses médias sous `assets\…`. L'import
/// et le vérificateur le lisent ; l'agrégation doit le lire aussi.
#[test]
fn aggregating_a_zip_with_backslash_asset_paths_finds_its_assets() {
    let dir = std::env::temp_dir().join(format!("zip_backslash_{}", uuid::Uuid::new_v4()));
    let assets_dir = dir.join("assets");
    fs::create_dir_all(&assets_dir).expect("create assets dir");
    let zip_path = dir.join("pack.zip");
    let story = r#"{
      "title":"Pack","version":1,"format":"v1",
      "stageNodes":[
        {"uuid":"entry","squareOne":true,"audio":"cover.mp3","image":"cover.png",
         "controlSettings":{"wheel":true,"ok":true,"home":false,"pause":false,"autoplay":false},
         "okTransition":{"actionNode":"root","optionIndex":0},"homeTransition":null},
        {"uuid":"story","squareOne":false,"audio":"story.mp3","image":null,
         "controlSettings":{"wheel":false,"ok":false,"home":true,"pause":true,"autoplay":true},
         "okTransition":null,"homeTransition":null}
      ],
      "actionNodes":[{"id":"root","options":["story"]}]
    }"#;
    let mut writer = zip::ZipWriter::new(fs::File::create(&zip_path).expect("create zip"));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file("story.json", options).expect("story");
    writer.write_all(story.as_bytes()).expect("story bytes");
    for name in [
        r"assets\cover.mp3",
        r"assets\cover.png",
        r"assets\story.mp3",
    ] {
        writer.start_file(name, options).expect("asset");
        writer.write_all(name.as_bytes()).expect("asset bytes");
    }
    writer.finish().expect("finish zip");

    // Témoin : le lecteur de l'import trouve bien le média.
    crate::services::pack_reader::get_pack_asset(
        zip_path.to_str().expect("utf8"),
        "assets/cover.mp3",
    )
    .expect("import : média lu");

    let staged = stage_imported_zip_bundle(
        "root/Pack/zip",
        zip_path.to_str().expect("utf8"),
        &assets_dir,
        &mut HashMap::new(),
    );
    let outcome = staged
        .as_ref()
        .map(|(_, assets)| assets.len())
        .map_err(Clone::clone);
    fs::remove_dir_all(&dir).ok();
    assert_eq!(outcome, Ok(3));
}
