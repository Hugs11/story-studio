//! Regression tests for the community pack checker.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use ::image::{ImageBuffer, Rgba};

use super::*;
use crate::support::ffmpeg::now_millis;

pub(super) fn dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "story_studio_{}_{}_{}",
        label,
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

pub(super) fn png(width: u32, height: u32) -> Vec<u8> {
    let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(width, height, Rgba([32, 80, 140, 255]));
    let mut bytes = Vec::new();
    ::image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            ::image::ImageFormat::Png,
        )
        .expect("png");
    bytes
}

pub(super) fn story(title: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "title": title,
        "stageNodes": [{
            "uuid": "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
            "name": "Racine",
            "squareOne": true,
            "image": "cover.png",
            "controlSettings": {"wheel": true, "ok": true, "home": true, "pause": true, "autoplay": false}
        }],
        "actionNodes": []
    })
}

/// Écrit un ZIP dont les entrées portent exactement les noms donnés.
pub(super) fn zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
    let mut writer = zip::ZipWriter::new(fs::File::create(path).expect("create zip"));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer.start_file(*name, opts).expect("start entry");
        writer.write_all(bytes).expect("write entry");
    }
    writer.finish().expect("finish zip");
}

fn title_warnings(report: &ReportModel) -> Vec<String> {
    report
        .issues
        .iter()
        .filter(|issue| {
            issue.category == "title" && issue.severity == PackValidationSeverity::Warning
        })
        .map(|issue| issue.message.clone())
        .collect()
}

/// C1. Même pack, même nom de fichier à la convention communautaire ; seule
/// change la forme de l'archive (à plat / enveloppée dans un dossier, donc
/// convertie dans le cache). Le jugement du nom ne doit pas changer.
/// La séquence est celle de la commande `analyze_community_pack`.
#[test]
fn naming_convention_is_judged_on_the_source_name_after_conversion() {
    let dir = dir("convention");
    let story = serde_json::to_vec_pretty(&story("Mon histoire")).unwrap();
    let cover = png(320, 240);
    let name = "3+]Mon_histoire[by_Auteur.zip";

    let flat_dir = dir.join("flat");
    fs::create_dir_all(&flat_dir).unwrap();
    let flat = flat_dir.join(name);
    zip(
        &flat,
        &[
            ("story.json", story.clone()),
            ("assets/cover.png", cover.clone()),
        ],
    );
    let wrapped_dir = dir.join("wrapped");
    fs::create_dir_all(&wrapped_dir).unwrap();
    let wrapped = wrapped_dir.join(name);
    zip(
        &wrapped,
        &[
            ("Mon histoire/story.json", story),
            ("Mon histoire/assets/cover.png", cover),
        ],
    );

    let analyse = |source: &Path| {
        let cache = dir.join("cache");
        let analysis_zip = crate::support::imported_pack::ensure_studio_pack_zip_in_cancellable(
            source.to_string_lossy().as_ref(),
            &cache,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .expect("ensure studio zip")
        .zip_path;
        (
            analysis_zip.clone(),
            analyze_pack_with_source_log(&analysis_zip, source, &|_| {}),
        )
    };
    let (flat_zip, flat_report) = analyse(&flat);
    let (wrapped_zip, wrapped_report) = analyse(&wrapped);
    assert_eq!(
        flat_zip.file_name(),
        flat.file_name(),
        "témoin : non converti"
    );
    assert_ne!(
        wrapped_zip.file_name(),
        wrapped.file_name(),
        "enveloppé : converti dans le cache"
    );
    assert!(
        title_warnings(&flat_report).is_empty(),
        "témoin sans avertissement de nom"
    );
    assert_eq!(
        title_warnings(&wrapped_report),
        Vec::<String>::new(),
        "le même nom de fichier, une fois l'archive convertie, ne doit pas devenir « convention non respectée » (analysé sous {:?})",
        wrapped_zip.file_name()
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn folder_naming_convention_is_judged_on_the_source_name_after_conversion() {
    let dir = dir("folder_convention");
    let source = dir.join("3+]Mon_histoire[by_Auteur");
    fs::create_dir_all(source.join("assets")).unwrap();
    fs::write(
        source.join("story.json"),
        serde_json::to_vec_pretty(&story("Mon histoire")).unwrap(),
    )
    .unwrap();
    fs::write(source.join("assets/cover.png"), png(320, 240)).unwrap();
    let converted = crate::support::imported_pack::ensure_studio_pack_zip_from_dir(
        source.to_str().unwrap(),
        &dir.join("cache"),
    )
    .unwrap();
    assert_ne!(converted.zip_path.file_stem(), source.file_name());
    let report = analyze_pack_with_source_log(&converted.zip_path, &source, &|_| {});
    assert!(title_warnings(&report).is_empty());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn exact_asset_name_takes_priority_over_normalized_fallback() {
    let dir = dir("exact_asset");
    let zip_path = dir.join("pack.zip");
    zip(
        &zip_path,
        &[
            ("story.json", serde_json::to_vec(&story("Pack")).unwrap()),
            ("assets\\cover.png", png(1, 1)),
            ("assets/cover.png", png(320, 240)),
        ],
    );
    assert_eq!(
        crate::services::pack_reader::get_pack_asset(
            zip_path.to_str().unwrap(),
            "assets/cover.png",
        )
        .unwrap(),
        png(320, 240),
    );
    let _ = fs::remove_dir_all(dir);
}

/// C4. Entrées en `assets\cover.png`, telles que les écrit `Compress-Archive`
/// de Windows PowerShell 5.1 (module Archive 1.0.1.0, vérifié le 13 nov. 2026).
/// Le pack est lu (story.json à la racine) : ses médias doivent l'être aussi.
#[test]
fn backslash_entry_names_are_read_like_the_listing_reads_them() {
    let dir = dir("backslash");
    let zip_path = dir.join("pack.zip");
    zip(
        &zip_path,
        &[
            (
                "story.json",
                serde_json::to_vec_pretty(&story("Pack")).unwrap(),
            ),
            ("assets\\cover.png", png(320, 240)),
        ],
    );
    let names: Vec<String> = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap())
        .unwrap()
        .file_names()
        .map(str::to_string)
        .collect();
    assert!(
        names.iter().any(|name| name == "assets\\cover.png"),
        "fixture : le nom d'entrée garde sa barre oblique inverse ({names:?})"
    );

    let report = analyze_pack(&zip_path);
    assert_eq!(
        crate::services::pack_reader::get_pack_asset(
            zip_path.to_str().unwrap(),
            "assets/cover.png"
        )
        .unwrap(),
        png(320, 240)
    );
    let errors: Vec<_> = report
        .issues
        .iter()
        .filter(|issue| issue.severity == PackValidationSeverity::Error)
        .map(|issue| (issue.category.clone(), issue.message.clone()))
        .collect();
    assert_eq!(
        report.image_items.len(),
        1,
        "l'image listée est analysée ; erreurs : {errors:?}"
    );
    let _ = fs::remove_dir_all(dir);
}

fn preview_patch(title: &str, producer: Option<&str>, export_name: &str) -> PackMetadataPatchModel {
    PackMetadataPatchModel {
        title: Some(title.to_string()),
        description: Some(String::new()),
        version: Some(2),
        min_age: Some("3".to_string()),
        author: Some("Auteur".to_string()),
        producer: producer.map(str::to_string),
        bonus: Some(String::new()),
        uuid: None,
        naming_mode: Some("convention".to_string()),
        export_name: Some(export_name.to_string()),
    }
}

/// Le nom affiché dans l'aperçu de la fenêtre des métadonnées vient de
/// `generateConventionName` (JS) ; les valeurs attendues ci-dessous sont celles
/// que `scripts/checkerPreviewName.test.mjs` fige pour les mêmes champs.
#[test]
fn fixed_zip_stem_matches_the_preview_for_a_title_with_a_leading_age() {
    assert_eq!(
        convention_zip_stem(&preview_patch(
            "5+ Le prince",
            None,
            "3+]Le_prince[by_Auteur_V2",
        ))
        .as_deref(),
        Some("3+]Le_prince[by_Auteur_V2")
    );
}

#[test]
fn fixed_zip_stem_matches_the_preview_for_a_producer_with_an_apostrophe() {
    assert_eq!(
        convention_zip_stem(&preview_patch(
            "Le loup",
            Some("L'école des loisirs"),
            "3+]L'école_des_loisirs_-_Le_loup[by_Auteur_V2",
        ))
        .as_deref(),
        Some("3+]L'école_des_loisirs_-_Le_loup[by_Auteur_V2")
    );
}

#[test]
fn preview_zip_stem_sanitizes_filename_characters() {
    let patch = preview_patch("Le prince", None, "3+]Le_prince:_partie/2[by_Auteur_V2");
    assert_eq!(
        convention_zip_stem(&patch).as_deref(),
        Some("3+]Le_prince__partie_2[by_Auteur_V2")
    );
}

#[test]
fn metadata_patch_without_preview_keeps_legacy_naming() {
    let patch: PackMetadataPatchModel = serde_json::from_value(serde_json::json!({
        "title": "Le prince", "minAge": "5", "author": "Auteur", "version": 2
    }))
    .unwrap();
    assert_eq!(
        convention_zip_stem(&patch).as_deref(),
        Some("5+]Le_prince[by_Auteur_V2")
    );
}
