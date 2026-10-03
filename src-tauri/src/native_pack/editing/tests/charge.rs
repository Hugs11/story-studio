//! Charge des gestes d'auteur sur des profils de graphes volumineux.
//!
//! Trois mesures que le banc canvas ne donne pas : la **durée d'un geste**, la
//! **relecture du DTO** après ce geste, et la **mémoire de l'historique**. Un
//! canvas fluide ne prouve pas une édition utilisable : une roue de 26 options
//! maintenue sur 9 121 nœuds, ou 50 snapshots complets conservés par l'undo,
//! sont des coûts que seule cette mesure-ci fait apparaître.
//!
//! `#[ignore]` comme le banc canvas : le relevé mesure des durées, il n'a
//! pas sa place dans la suite de non-régression. Il se lance explicitement :
//!
//! ```text
//! node scripts/advanced-graph-fixtures.mjs
//! cargo test --lib editing::tests::charge -- --ignored --nocapture
//! ```
//!
//! Les chiffres relevés ici sont ceux de **Fedora**, machine de développement.
//! Ils ne valent pas verdict : le verdict de performance se prononce sur
//! Windows et macOS.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::json;

use super::*;
use crate::native_pack::graph_view::read_advanced_graph_view;

/// Le plafond d'historique du store JavaScript (`projectWorkState.js`).
/// L'historique conserve des payloads **entiers** : c'est ce produit-là qui est
/// mesuré, pas un delta que Story Studio ne calcule pas.
const MAX_HISTORY_SIZE: usize = 50;

const SAMPLES: usize = 5;

/// Les profils mesurés, dans l'ordre du protocole de charge.
const PROFILES: [&str; 3] = ["mediane-124", "p90-795", "max-9121"];

fn fixture(name: &str) -> String {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/graph-view")
        .join(format!("{name}.payload.json"));
    fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("fixture {name} illisible ({error}) : lancer d'abord scripts/advanced-graph-fixtures.mjs")
    })
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(|left, right| left.partial_cmp(right).expect("durées comparables"));
    samples[samples.len() / 2]
}

/// Les cibles d'un profil, dérivées du document plutôt que codées en dur : la
/// mesure ne doit pas se briser quand le générateur de fixtures change.
struct Targets {
    stage: String,
    entry: String,
    widest_action: String,
    widest_options: usize,
}

fn targets(payload: &str) -> Targets {
    let decoded = decode_authoring_payload(payload).expect("payload lisible");
    let entry = decoded
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .expect("un Stage d'entrée")
        .uuid
        .clone();
    let stage = decoded
        .document
        .stage_nodes
        .iter()
        .find(|stage| !stage.is_square_one())
        .expect("un Stage hors entrée")
        .uuid
        .clone();
    let widest = decoded
        .document
        .action_nodes
        .iter()
        .max_by_key(|action| action.options.len())
        .expect("une Action");
    Targets {
        stage,
        entry,
        widest_action: widest.id.clone(),
        widest_options: widest.options.len(),
    }
}

fn measure(payload: &str, request: Value) -> (f64, String) {
    let gesture = gesture(request);
    let mut samples = Vec::with_capacity(SAMPLES);
    let mut produced = String::new();
    for _ in 0..SAMPLES {
        let started = Instant::now();
        let outcome =
            apply_advanced_gesture_with(payload, Vec::new(), &gesture, &mut fixed_uuids())
                .expect("geste accepté");
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        produced = outcome.payload;
    }
    (median(samples), produced)
}

/// Durée d'un geste par famille, et relecture du DTO sur le payload rendu.
#[test]
#[ignore = "recette de charge : mesure des durées"]
fn mesure_la_duree_des_gestes_et_la_relecture_du_dto() {
    println!(
        "{:<16} {:<26} {:>9} {:>9} {:>11}   (ms, {SAMPLES} mesures)",
        "profil", "geste", "geste", "relecture", "payload (o)"
    );
    for profile in PROFILES {
        let payload = fixture(profile);
        let targets = targets(&payload);
        let requests: Vec<(&str, Value)> = vec![
            (
                "set-stage-controls",
                json!({
                    "gesture": "set-stage-controls",
                    "stageUuid": targets.stage,
                    "update": {
                        "form": "complete",
                        "wheel": false, "ok": true, "home": false,
                        "pause": false, "autoplay": false
                    }
                }),
            ),
            (
                "set-stage-transition",
                json!({
                    "gesture": "set-stage-transition",
                    "stageUuid": targets.stage,
                    "slot": "home",
                    "update": {
                        "form": "set",
                        "actionNode": targets.widest_action,
                        "optionIndex": -1
                    }
                }),
            ),
            (
                // Le geste qui touche **toutes** les transitions entrantes de
                // l'Action la plus large : c'est lui qui porte le coût réel.
                "reorder-action-options",
                json!({
                    "gesture": "reorder-action-options",
                    "actionId": targets.widest_action,
                    "newPositionOfOld": (0..targets.widest_options)
                        .map(|rank| (rank + 1) % targets.widest_options)
                        .collect::<Vec<_>>()
                }),
            ),
            (
                // Le geste qui parcourt tous les Écrans.
                "set-square-one",
                json!({"gesture": "set-square-one", "stageUuid": targets.stage}),
            ),
            (
                "create-stage",
                json!({
                    "gesture": "create-stage",
                    "stage": {"controls": controls(false, true, false, false, false)}
                }),
            ),
            (
                "set-authored-position",
                json!({
                    "gesture": "set-authored-position",
                    "node": {"kind": "stage", "id": targets.entry},
                    "position": {"x": 240, "y": 96}
                }),
            ),
        ];

        for (name, request) in requests {
            let (duration, produced) = measure(&payload, request);
            let reread = median(
                (0..SAMPLES)
                    .map(|_| {
                        let started = Instant::now();
                        let view = read_advanced_graph_view(&produced).expect("payload projetable");
                        let serialized = serde_json::to_string(&view).expect("vue sérialisable");
                        assert!(!serialized.is_empty());
                        started.elapsed().as_secs_f64() * 1_000.0
                    })
                    .collect(),
            );
            println!(
                "{profile:<16} {name:<26} {duration:>9.2} {reread:>9.2} {:>11}",
                produced.len()
            );
        }
    }
}

/// Mémoire de l'historique : 50 snapshots complets, comme le store les garde.
#[test]
#[ignore = "recette de charge : mesure des durées et de la mémoire"]
fn mesure_la_memoire_de_l_historique_a_cinquante_etapes() {
    println!(
        "{:<16} {:>11} {:>13} {:>13} {:>11}   ({MAX_HISTORY_SIZE} étapes)",
        "profil", "payload (o)", "historique (o)", "croissance (o)", "50 gestes (ms)"
    );
    for profile in PROFILES {
        let payload = fixture(profile);
        let targets = targets(&payload);
        let initial = payload.len();
        let stages_before = decode_authoring_payload(&payload)
            .expect("payload lisible")
            .document
            .stage_nodes
            .len();
        // Une seule source d'identifiants pour toute la suite : la rejouer à
        // chaque geste referait tirer les mêmes UUID et finirait en collision.
        let mut next = fixed_uuids();
        let mut current = payload;
        let mut history_bytes = 0_usize;
        let started = Instant::now();
        for step in 0..MAX_HISTORY_SIZE {
            // Une suite de gestes réellement différents : un historique de 50
            // fois le même geste ne mesurerait pas la croissance du document.
            let request = if step % 2 == 0 {
                json!({
                    "gesture": "create-stage",
                    "stage": {"controls": controls(false, true, false, false, false)}
                })
            } else {
                json!({
                    "gesture": "set-authored-position",
                    "node": {"kind": "stage", "id": targets.entry},
                    "position": {"x": step, "y": 96}
                })
            };
            let outcome =
                apply_advanced_gesture_with(&current, Vec::new(), &gesture(request), &mut next)
                    .expect("geste accepté");
            // L'historique du store garde le payload **entier** de chaque étape.
            history_bytes += current.len();
            current = outcome.payload;
        }
        let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
        println!(
            "{profile:<16} {initial:>11} {history_bytes:>13} {:>13} {elapsed:>11.1}",
            current.len() - initial,
        );
        // Chaque `create-stage` a bien créé un Stage distinct : sans cela la
        // mesure porterait sur un document qui n'a pas grandi.
        assert_eq!(
            decode_authoring_payload(&current)
                .expect("payload final lisible")
                .document
                .stage_nodes
                .len(),
            stages_before + MAX_HISTORY_SIZE / 2
        );
    }
}
