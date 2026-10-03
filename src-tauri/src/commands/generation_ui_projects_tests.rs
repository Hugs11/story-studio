//! La génération réelle d'un projet tel qu'un éditeur le crée.
//!
//! Les projets de scripts/fixtures/ui-built-projects/ sont écrits par
//! `scripts/uiBuiltProjects.test.mjs` : les gestes d'un éditeur passés par le
//! store et les hooks de production, jusqu'au `projectJson` que la file de
//! rendu remet à `generate_pack`. Ce test en fait ce que fait `generate_pack` :
//! lecture du JSON, validation, génération par le moteur, relecture de
//! l'archive. Les médias (`/ui-media/…`) sont fabriqués ici : sons et images
//! synthétiques, sans aucun contenu réel.

use super::*;
use crate::native_pack::observed_gates::GateOutcome;
use std::f64::consts::PI;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

const MEDIA_PREFIX: &str = "/ui-media/";

struct Workspace {
    dir: PathBuf,
}

impl Workspace {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ss-ui-project-{tag}-{}-{}",
            std::process::id(),
            crate::support::ffmpeg::now_millis()
        ));
        fs::create_dir_all(dir.join("media")).expect("dossier des médias");
        fs::create_dir_all(dir.join("sortie")).expect("dossier de sortie");
        Self { dir }
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Une seconde de son pur, mono 44,1 kHz, 16 bits ; la fréquence varie avec
/// le rang pour que deux médias ne soient jamais identiques.
pub(crate) fn write_tone_wav(path: &Path, rank: usize) {
    let rate = 44_100u32;
    let frequency = 330.0 + 55.0 * rank as f64;
    let samples: Vec<i16> = (0..rate)
        .map(|n| ((2.0 * PI * frequency * n as f64 / rate as f64).sin() * 8_000.0) as i16)
        .collect();
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    fs::write(path, bytes).expect("son synthétique");
}

/// Une image unie 320×240, d'une teinte propre à chaque rang.
pub(crate) fn write_flat_png(path: &Path, rank: usize) {
    let shade = (40 + 23 * rank % 200) as u8;
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        320,
        240,
        image::Rgb([shade, 255 - shade, 128]),
    ));
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .expect("image synthétique");
    fs::write(path, bytes).expect("écriture de l'image");
}

/// Remplace chaque chemin `/ui-media/<nom>` du projet par un fichier réel du
/// dossier de travail, fabriqué selon son extension.
fn materialize_media(value: &mut serde_json::Value, media: &Path, made: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let Some(name) = text.strip_prefix(MEDIA_PREFIX) else {
                return;
            };
            let target = media.join(name);
            if !made.iter().any(|known| known == name) {
                let rank = made.len();
                match target.extension().and_then(|ext| ext.to_str()) {
                    Some("wav") => write_tone_wav(&target, rank),
                    Some("png") => write_flat_png(&target, rank),
                    other => panic!("média de fixture inattendu : {name} ({other:?})"),
                }
                made.push(name.to_string());
            }
            *text = target.to_string_lossy().to_string();
        }
        serde_json::Value::Array(items) => {
            for item in items {
                materialize_media(item, media, made);
            }
        }
        serde_json::Value::Object(fields) => {
            for field in fields.values_mut() {
                materialize_media(field, media, made);
            }
        }
        _ => {}
    }
}

/// Le déroulé de `generate_pack` sur un projet de l'éditeur ; rend le pack relu.
fn generate_ui_project(tag: &str, fixture: &str) -> serde_json::Value {
    let workspace = Workspace::new(tag);
    let mut project: serde_json::Value =
        serde_json::from_str(fixture).expect("fixture JSON de l'éditeur");
    let mut made = Vec::new();
    materialize_media(&mut project, &workspace.dir.join("media"), &mut made);
    assert!(!made.is_empty(), "{tag} : aucun média dans la fixture");

    let project = parse_project_json(&project.to_string()).expect("projet lisible par Rust");
    validate_project_for_generation(&project).expect("validation avant génération");
    let output = workspace.dir.join("sortie");
    let result = run_generation(&|_| {}, &|| false, |emit, should_cancel| {
        crate::native_pack::generate_native_pack_v1_with_cancel(
            &project,
            output.to_str().expect("sortie UTF-8"),
            emit,
            should_cancel,
        )
    })
    .unwrap_or_else(|error| panic!("{tag} : génération refusée : {error}"));

    assert_eq!(result.gate_observations.len(), 3, "{tag} : trois portes");
    assert!(
        result
            .gate_observations
            .iter()
            .all(|observation| observation.outcome == GateOutcome::Passed),
        "{tag} : {:#?}",
        result.gate_observations
    );
    let report = validate_lunii_zip(&result.zip_path);
    assert!(
        report.valid,
        "{tag} : archive invalide : {:#?}",
        report.issues
    );

    let reread = crate::services::pack_reader::load_pack_zip(&result.zip_path)
        .unwrap_or_else(|error| panic!("{tag} : archive illisible : {error}"));
    serde_json::from_str(&reread).expect("relecture JSON")
}

fn stage_names(pack: &serde_json::Value) -> Vec<&str> {
    pack["stageNodes"]
        .as_array()
        .expect("écrans relus")
        .iter()
        .map(|stage| stage["name"].as_str().unwrap_or(""))
        .collect()
}

fn stage<'a>(pack: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    pack["stageNodes"]
        .as_array()
        .expect("écrans relus")
        .iter()
        .find(|stage| stage["name"] == name)
        .unwrap_or_else(|| panic!("écran « {name} » absent : {:?}", stage_names(pack)))
}

/// L'écran où mène le bouton OK (ou la fin de lecture) de `name`.
fn ok_target<'a>(pack: &'a serde_json::Value, name: &str) -> &'a str {
    let transition = &stage(pack, name)["okTransition"];
    let action = pack["actionNodes"]
        .as_array()
        .expect("actions relues")
        .iter()
        .find(|action| action["id"] == transition["actionNode"])
        .unwrap_or_else(|| panic!("« {name} » : action introuvable"));
    let index = transition["optionIndex"].as_u64().expect("option") as usize;
    let target = &action["options"][index];
    pack["stageNodes"]
        .as_array()
        .expect("écrans relus")
        .iter()
        .find(|stage| &stage["uuid"] == target)
        .and_then(|stage| stage["name"].as_str())
        .unwrap_or_else(|| panic!("« {name} » : écran cible introuvable"))
}

fn has_media(stage: &serde_json::Value, field: &str) -> bool {
    stage[field].as_str().is_some_and(|value| !value.is_empty())
}

#[test]
fn a_simple_editor_project_generates_a_valid_pack() {
    let pack = generate_ui_project(
        "simple",
        include_str!("../../../scripts/fixtures/ui-built-projects/simple.json"),
    );
    // L'éditeur simplifié : la couverture (image, titre audio) mène au récit.
    assert_eq!(stage_names(&pack), ["Cover node", "histoire"], "{pack:#}");
    let cover = stage(&pack, "Cover node");
    assert!(has_media(cover, "image") && has_media(cover, "audio"));
    assert!(has_media(stage(&pack, "histoire"), "audio"));
    assert_eq!(ok_target(&pack, "Cover node"), "histoire");
}

#[test]
fn a_menu_editor_project_generates_a_valid_pack() {
    let pack = generate_ui_project(
        "menus",
        include_str!("../../../scripts/fixtures/ui-built-projects/menus.json"),
    );
    let mut names = stage_names(&pack);
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "Cover node",
            "Dossier de test",
            "Fin - histoire-2",
            "Histoire - histoire-1",
            "Histoire - histoire-2",
            "Titre - histoire-1",
            "Titre - histoire-2",
        ],
        "{pack:#}"
    );
    for title in [
        "Titre - histoire-1",
        "Titre - histoire-2",
        "Dossier de test",
    ] {
        let screen = stage(&pack, title);
        assert!(
            has_media(screen, "image") && has_media(screen, "audio"),
            "{title}"
        );
    }
    // Les réglages posés dans l'éditeur, relus dans l'archive : la première
    // histoire enchaîne sur la seconde ; la seconde joue sa fin locale, dont OK
    // revient au dossier.
    assert_eq!(
        ok_target(&pack, "Titre - histoire-1"),
        "Histoire - histoire-1"
    );
    assert_eq!(
        ok_target(&pack, "Histoire - histoire-1"),
        "Titre - histoire-2"
    );
    assert_eq!(
        ok_target(&pack, "Histoire - histoire-2"),
        "Fin - histoire-2"
    );
    assert_eq!(ok_target(&pack, "Fin - histoire-2"), "Dossier de test");
}
