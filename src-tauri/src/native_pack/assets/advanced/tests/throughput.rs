//! Banc de débit de la préparation avancée, ignoré par défaut.
//!
//! Il n'affirme rien sur une durée absolue — elle dépend de la machine, du
//! disque et de FFmpeg — et ne peut donc pas être un test de non-régression.
//! Il répond à une seule question, en la mesurant plutôt qu'en la supposant :
//! **la préparation avancée profite-t-elle réellement des cœurs disponibles ?**
//!
//! Le témoin est `RAYON_NUM_THREADS=1`, qui redonne exactement le comportement
//! séquentiel d'avant la parallélisation, sans avoir à défaire le code.
//!
//! ```bash
//! STORY_STUDIO_THROUGHPUT_MEDIA=/chemin/vers/des/mp3 \
//!   cargo test --release --lib advanced_preparation_throughput -- --ignored --nocapture
//! # puis, pour le témoin séquentiel :
//! RAYON_NUM_THREADS=1 STORY_STUDIO_THROUGHPUT_MEDIA=… cargo test --release …
//! ```

use std::path::PathBuf;
use std::time::Instant;

use super::*;

/// Les médias réels sur lesquels mesurer. Un dossier de `.mp3`.
fn throughput_media() -> Vec<PathBuf> {
    let root = PathBuf::from(
        std::env::var("STORY_STUDIO_THROUGHPUT_MEDIA")
            .expect("STORY_STUDIO_THROUGHPUT_MEDIA requis"),
    );
    let mut media: Vec<PathBuf> = std::fs::read_dir(&root)
        .expect("dossier de médias lisible")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
        })
        .collect();
    media.sort();
    media
}

#[test]
#[ignore = "banc local : STORY_STUDIO_THROUGHPUT_MEDIA requis"]
fn advanced_preparation_throughput() {
    let ffmpeg = match crate::support::ffmpeg::get_ffmpeg_path() {
        Ok(path) => path,
        Err(error) => panic!("FFmpeg requis pour ce banc : {error}"),
    };
    let media = throughput_media();
    assert!(!media.is_empty(), "aucun média : prérequis manquant");

    let scratch = Scratch::new("throughput");
    let mut stages = Vec::new();
    let mut bindings = Vec::new();
    for (index, source) in media.iter().enumerate() {
        let asset_ref = format!("media-{index:03}.mp3");
        let staged = scratch.write_source(
            "media",
            &asset_ref,
            &std::fs::read(source).expect("lire le média"),
        );
        stages.push(stage(
            &format!("11111111-2222-4333-8444-{index:012}"),
            index == 0,
            Some(&asset_ref),
            None,
        ));
        bindings.push(binding(&asset_ref, &staged));
    }
    let document = document_with(&stages.join(","), "");

    let threads = rayon::current_num_threads();
    let started = Instant::now();
    let preparation = prepare_advanced_assets(
        &document,
        &bindings,
        &scratch.workspace(),
        &ffmpeg,
        &AdvancedAudioOptions::default(),
    )
    .expect("préparation réussie");
    let elapsed = started.elapsed();

    println!(
        "\n== Débit de la préparation avancée ==\n\
         médias      : {}\n\
         fils rayon  : {}\n\
         durée       : {:.2} s\n\
         par média   : {:.0} ms\n",
        media.len(),
        threads,
        elapsed.as_secs_f64(),
        elapsed.as_millis() as f64 / media.len() as f64,
    );
    assert_eq!(preparation.assets.len(), media.len());

    let _ = std::fs::remove_dir_all(&scratch.root);
}
