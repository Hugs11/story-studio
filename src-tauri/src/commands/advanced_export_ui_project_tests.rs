//! L'export réel d'un document de l'éditeur graphe, créé par ses gestes.
//!
//! Le document naît par `create_advanced_document`, la commande appelée à la
//! création d'un projet graphe. Chaque geste part sous la forme que
//! `advancedGestures.js` envoie (le JSON désérialisé comme par l'IPC) et passe
//! par `apply_advanced_gesture`, la commande que la session d'édition invoque.
//! L'export appelle le point d'entrée de `export_advanced_pack` avec les
//! options que `exportRequest.js` envoie par défaut. Les médias sont des sons et
//! des images synthétiques, sans aucun contenu réel.

use super::*;
use crate::commands::generation::ui_projects_tests::{write_flat_png, write_tone_wav};
use crate::commands::project_codec::{apply_advanced_gesture, create_advanced_document};
use crate::native_pack::persistence::decode_authoring_payload;
use crate::support::lunii_zip_validator::validate_lunii_zip;
use serde_json::{json, Value};
use std::fs;

/// Le projet graphe tel que la session le tient : un payload et ses liaisons.
struct GraphSession {
    payload: String,
    bindings: Vec<AdvancedMediaBinding>,
}

impl GraphSession {
    /// Un geste accepté remplace le document et ses liaisons ; un refus fait
    /// échouer le test avec son code, comme la notice de l'éditeur l'afficherait.
    fn run(&mut self, gesture: Value) -> Value {
        let name = gesture["gesture"].as_str().unwrap_or("?").to_string();
        let outcome = apply_advanced_gesture(
            self.payload.clone(),
            self.bindings.clone(),
            serde_json::from_value(gesture).expect("geste de la forme IPC"),
        )
        .unwrap_or_else(|error| panic!("geste {name} refusé : {error}"));
        self.payload = outcome.payload;
        self.bindings = outcome.media_bindings;
        serde_json::to_value(outcome.report).expect("rapport du geste")
    }

    fn entry_stage_uuid(&self) -> String {
        decode_authoring_payload(&self.payload)
            .expect("document relisible")
            .document
            .stage_nodes
            .iter()
            .find(|stage| stage.is_square_one())
            .expect("un Écran d'entrée")
            .uuid
            .clone()
    }
}

/// Dépôt d'un fichier de la médiathèque sur un Écran : ce que rend
/// `planStageMediaAssignment` pour un fichier que le projet ne lie pas encore,
/// une référence neuve nommée d'après le fichier et son emplacement.
fn drop_media(stage_uuid: &str, field: &str, path: &std::path::Path) -> Value {
    let asset_ref = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("nom");
    json!({
        "gesture": "set-stage-media",
        "stageUuid": stage_uuid,
        "field": field,
        "update": {
            "form": "set",
            "assetRef": asset_ref,
            "location": { "path": path.to_string_lossy(), "present": true }
        }
    })
}

#[test]
fn a_graph_editor_document_built_by_its_gestures_exports_a_valid_pack() {
    let dir = std::env::temp_dir().join(format!(
        "ss-ui-graph-{}-{}",
        std::process::id(),
        crate::support::ffmpeg::now_millis()
    ));
    let media = dir.join("media");
    let output = dir.join("sortie");
    fs::create_dir_all(&media).expect("dossier des médias");
    fs::create_dir_all(&output).expect("dossier de sortie");
    let entry_audio = media.join("entree.wav");
    let entry_image = media.join("entree.png");
    let second_audio = media.join("ecran-2.wav");
    write_tone_wav(&entry_audio, 0);
    write_flat_png(&entry_image, 1);
    write_tone_wav(&second_audio, 2);

    // Nouveau projet graphe.
    let mut session = GraphSession {
        payload: create_advanced_document("Pack graphe de test".to_string())
            .expect("document créé"),
        bindings: Vec::new(),
    };
    let entry = session.entry_stage_uuid();

    // Un son et une image déposés sur l'Écran d'entrée.
    session.run(drop_media(&entry, "audio", &entry_audio));
    session.run(drop_media(&entry, "image", &entry_image));

    // « Nouvel Écran » (clic droit sur le canvas) : nom par défaut et réglage
    // de départ des boutons (`DEFAULT_NEW_STAGE_CONTROLS`).
    let created = session.run(json!({
        "gesture": "create-stage",
        "stage": {
            "name": "Écran 2",
            "controls": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false }
        },
        "position": { "x": 400, "y": 0 }
    }));
    let second = created["created"]["stageUuid"]
        .as_str()
        .expect("uuid de l'Écran créé")
        .to_string();
    session.run(drop_media(&second, "audio", &second_audio));

    // Relier : depuis la sortie OK de l'Écran d'entrée, « Créer une liste de
    // choix » dont la destination est l'Écran 2 (`GraphLinkDialog`). OK est déjà
    // allumé sur l'entrée : le raccord n'allume aucune touche.
    session.run(json!({
        "gesture": "create-linked-node",
        "linked": {
            "direction": "stage-to-action",
            "stageUuid": entry,
            "slot": "ok",
            "action": { "id": null, "name": "Action 1", "options": [{ "target": "stage", "uuid": second }] },
            "optionIndex": 0,
            "position": { "x": 200, "y": 0 }
        }
    }));

    // L'Écran terminal revient par Accueil ; son OK sans lien reste désactivé.
    session.run(json!({
        "gesture": "set-stage-controls", "stageUuid": second,
        "update": {"form": "members", "members": {"ok": {"form": "set", "value": false}}}
    }));

    // « Générer » : options par défaut de `exportRequest.js`.
    let options: AdvancedExportOptions = serde_json::from_value(json!({
        "silenceMode": "normalize",
        "harmonizeLoudness": true,
        "leadingSilenceSec": 0.4,
        "trailingSilenceSec": 0.4
    }))
    .expect("options d'export");
    let result = export_advanced_pack_with_cancel(
        &session.payload,
        &session.bindings,
        &output,
        &options.into_audio_options(),
        Some("Pack graphe de test"),
        None,
        Some("Pack graphe de test"),
        None,
        &|_| {},
        &|| false,
    )
    .unwrap_or_else(|error| panic!("export refusé : {error:?}"));

    let report = validate_lunii_zip(&result.zip_path);
    assert!(report.valid, "archive invalide : {:#?}", report.issues);
    assert!(
        result.has_thumbnail,
        "l'image de l'entrée sert de couverture"
    );

    let pack: Value = serde_json::from_str(
        &crate::services::pack_reader::load_pack_zip(&result.zip_path).expect("archive relue"),
    )
    .expect("relecture JSON");
    let stages = pack["stageNodes"].as_array().expect("écrans relus");
    assert_eq!(stages.len(), 2, "{pack:#}");
    let entry_stage = stages
        .iter()
        .find(|stage| stage["squareOne"] == true)
        .expect("entrée relue");
    assert!(entry_stage["audio"]
        .as_str()
        .is_some_and(|name| !name.is_empty()));
    assert!(entry_stage["image"]
        .as_str()
        .is_some_and(|name| !name.is_empty()));
    let second_stage = stages
        .iter()
        .find(|stage| stage["squareOne"] != true)
        .expect("Écran 2 relu");
    assert!(second_stage["audio"]
        .as_str()
        .is_some_and(|name| !name.is_empty()));
    let action = pack["actionNodes"]
        .as_array()
        .expect("actions relues")
        .iter()
        .find(|action| action["id"] == entry_stage["okTransition"]["actionNode"])
        .expect("l'entrée mène à une action");
    assert_eq!(action["options"], json!([second_stage["uuid"]]));

    let _ = fs::remove_dir_all(dir);
}
