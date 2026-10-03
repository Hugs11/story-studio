//! Génération des vues du banc d'essai, et mesure de la part **Rust** du
//! chargement (protocole de charge).
//!
//! Ces deux tests sont `#[ignore]` : ils écrivent des fichiers et mesurent des
//! durées, ce qui n'a pas sa place dans la suite de non-régression. Ils sont la
//! moitié Rust de la recette reproductible, et se lancent explicitement :
//!
//! ```text
//! node scripts/advanced-graph-fixtures.mjs
//! cargo test --lib graph_view::tests::bench -- --ignored --nocapture
//! ```
//!
//! Le protocole exige de séparer « temps Rust » et « premier affichage
//! exploitable » : ce fichier ne mesure que le premier — décodage du payload,
//! projection, sérialisation du DTO. Le second se mesure dans la WebView, et
//! aucun des deux ne remplace l'autre.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::native_pack::graph_view::read_advanced_graph_view;

/// Au moins cinq mesures par chargement, comme le protocole l'exige.
const LOAD_SAMPLES: usize = 5;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/graph-view")
}

fn payload_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(fixtures_dir())
        .expect("fixtures générées : lancer d'abord scripts/advanced-graph-fixtures.mjs")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".payload.json"))
        })
        .collect();
    // L'ordre du système de fichiers n'est pas stable : le trier rend le
    // relevé comparable d'une exécution à l'autre.
    files.sort();
    assert!(!files.is_empty(), "aucune fixture trouvée");
    files
}

fn profile_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".payload.json"))
        .unwrap_or_default()
        .to_string()
}

/// Écrit le DTO réel de chaque profil, à côté de son payload.
///
/// Le banc d'essai des deux moteurs consomme **ces** fichiers : même DTO, mêmes
/// fixtures, mêmes gestes. Un moteur mesuré sur un graphe de démonstration et
/// l'autre sur un profil réel ne serait pas un départage.
#[test]
#[ignore = "recette du banc d'essai : écrit des fichiers"]
fn genere_les_vues_du_banc_d_essai() {
    for path in payload_files() {
        let name = profile_name(&path);
        let payload = fs::read_to_string(&path).expect("payload lisible");
        let view = read_advanced_graph_view(&payload).expect("payload projetable");
        let serialized = serde_json::to_string(&view).expect("vue sérialisable");
        let destination = fixtures_dir().join(format!("{name}.view.json"));
        fs::write(&destination, &serialized).expect("vue écrite");
        println!(
            "{name:<20} {:>6} Écrans {:>6} Actions {:>6} options {:>6} arêtes  \
             payload {:>9} o  vue {:>9} o",
            view.counts.stages,
            view.counts.actions,
            view.counts.options,
            view.counts.edges,
            payload.len(),
            serialized.len(),
        );
    }
}

/// Mesure la part Rust du chargement : décodage, projection, sérialisation.
///
/// Ce n'est **pas** le « premier affichage exploitable » du protocole, et ce
/// relevé ne doit pas être présenté comme tel. C'est le coût incompressible qui
/// précède l'IPC, et il est mesuré ici parce qu'il est le même quel que soit le
/// moteur d'affichage : il ne participe donc pas au départage, il le cadre.
#[test]
#[ignore = "recette du banc d'essai : mesure des durées"]
fn mesure_la_part_rust_du_chargement() {
    println!(
        "{:<20} {:>8} {:>8} {:>8} {:>8}   (millisecondes, {LOAD_SAMPLES} mesures)",
        "profil", "médiane", "min", "max", "octets"
    );
    for path in payload_files() {
        let name = profile_name(&path);
        let payload = fs::read_to_string(&path).expect("payload lisible");
        let mut samples = Vec::with_capacity(LOAD_SAMPLES);
        for _ in 0..LOAD_SAMPLES {
            let started = Instant::now();
            let view = read_advanced_graph_view(&payload).expect("payload projetable");
            let serialized = serde_json::to_string(&view).expect("vue sérialisable");
            // `black_box` empêcherait l'optimiseur de tout élider ; la
            // sérialisation consommée ci-dessous joue le même rôle et fait
            // partie du coût réel du transport.
            assert!(!serialized.is_empty());
            samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        samples.sort_by(|left, right| left.partial_cmp(right).expect("durées comparables"));
        println!(
            "{name:<20} {:>8.1} {:>8.1} {:>8.1} {:>8}",
            samples[samples.len() / 2],
            samples[0],
            samples[samples.len() - 1],
            payload.len(),
        );
    }
}
