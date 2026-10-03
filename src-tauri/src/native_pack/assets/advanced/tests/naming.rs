//! Nommage d'archive : adressage par contenu, et la garde du suffixe de huit caractères.

use std::fs;

use super::*;
use crate::native_pack::assets::advanced::digest::sha256_bytes;
use crate::native_pack::assets::advanced::naming::{
    build_archive_name_table, lunii_suffix, NameCandidate, NamingError,
};

/// Deux contenus **réellement** distincts dont les SHA-1 partagent leurs huit
/// derniers caractères — `24cf42ff`.
///
/// Ils ont été trouvés par recherche exhaustive, pas supposés : trente-deux
/// bits, une collision apparaît après quelques dizaines de milliers de
/// contenus. Une autre existe (`f7d40bc2`) ; celle-ci est figée ici pour que la
/// garde soit éprouvée à chaque exécution.
const COLLIDING_A: &[u8] = b"p2-04-116831";
const COLLIDING_B: &[u8] = b"p2-04-142292";
const SHARED_SUFFIX: &str = "24CF42FF";

fn candidate<'a>(
    asset_ref: &'a str,
    sha256: &'a str,
    path: &'a std::path::Path,
    extension: &'static str,
) -> NameCandidate<'a> {
    NameCandidate {
        asset_ref,
        output_sha256: sha256,
        output_path: path,
        extension,
    }
}

#[test]
fn the_two_fixtures_really_share_their_lunii_suffix() {
    // La prémisse du test suivant, vérifiée plutôt qu'affirmée.
    let name_a = crate::native_pack::assets::audio::hashed_asset_name(COLLIDING_A, "mp3");
    let name_b = crate::native_pack::assets::audio::hashed_asset_name(COLLIDING_B, "mp3");
    assert_ne!(
        name_a, name_b,
        "deux contenus distincts, deux SHA-1 complets"
    );
    assert_eq!(lunii_suffix(&name_a), SHARED_SUFFIX);
    assert_eq!(
        lunii_suffix(&name_b),
        SHARED_SUFFIX,
        "et le même suffixe de huit caractères, celui dont Lunii.QT tire son nom de fichier"
    );
}

#[test]
fn a_suffix_collision_is_rederived_and_never_left_to_overwrite() {
    let scratch = Scratch::new("collision");
    let first = scratch.write_source("out", "a", COLLIDING_A);
    let second = scratch.write_source("out", "b", COLLIDING_B);
    let sha_a = sha256_bytes(COLLIDING_A);
    let sha_b = sha256_bytes(COLLIDING_B);

    let table = build_archive_name_table(&[
        candidate("ref-a", &sha_a, &first, "mp3"),
        candidate("ref-b", &sha_b, &second, "mp3"),
    ])
    .expect("la collision se re-dérive, elle ne refuse pas");

    let name_a = table.archive_name("ref-a").expect("nom de a");
    let name_b = table.archive_name("ref-b").expect("nom de b");
    assert_ne!(name_a, name_b);
    assert_ne!(
        lunii_suffix(name_a),
        lunii_suffix(name_b),
        "deux contenus distincts ne partagent jamais l'adresse FS que Lunii.QT en tire"
    );
    assert!(name_a.ends_with(".mp3") && name_b.ends_with(".mp3"));
}

#[test]
fn the_allocation_does_not_depend_on_the_order_the_conversions_return() {
    let scratch = Scratch::new("determinisme");
    let first = scratch.write_source("out", "a", COLLIDING_A);
    let second = scratch.write_source("out", "b", COLLIDING_B);
    let sha_a = sha256_bytes(COLLIDING_A);
    let sha_b = sha256_bytes(COLLIDING_B);

    let forward = build_archive_name_table(&[
        candidate("ref-a", &sha_a, &first, "mp3"),
        candidate("ref-b", &sha_b, &second, "mp3"),
    ])
    .expect("table");
    let backward = build_archive_name_table(&[
        candidate("ref-b", &sha_b, &second, "mp3"),
        candidate("ref-a", &sha_a, &first, "mp3"),
    ])
    .expect("table");

    // Sans cette propriété, deux exports du même état d'auteur
    // pourraient nommer différemment le même fichier selon l'ordre où les
    // conversions parallèles rendent la main.
    assert_eq!(
        forward.archive_name("ref-a"),
        backward.archive_name("ref-a")
    );
    assert_eq!(
        forward.archive_name("ref-b"),
        backward.archive_name("ref-b")
    );
}

#[test]
fn identical_contents_share_their_name_and_that_is_the_deduplication() {
    let scratch = Scratch::new("dedup-nom");
    let bytes = b"un contenu unique".to_vec();
    let first = scratch.write_source("out", "a", &bytes);
    let second = scratch.write_source("out", "b", &bytes);
    let sha = sha256_bytes(&bytes);

    let table = build_archive_name_table(&[
        candidate("ref-a", &sha, &first, "mp3"),
        candidate("ref-b", &sha, &second, "mp3"),
    ])
    .expect("table");

    assert_eq!(table.archive_name("ref-a"), table.archive_name("ref-b"));
    assert_eq!(table.distinct_names().len(), 1, "un seul fichier écrit");
    assert_eq!(table.len(), 2, "deux références servies");
}

#[test]
fn an_unreadable_output_is_a_write_failure_not_a_collision() {
    let scratch = Scratch::new("nommage-panne");
    let missing = scratch.sources().join("jamais-ecrit");
    let sha = sha256_bytes(b"peu importe");

    let error = build_archive_name_table(&[candidate("ref", &sha, &missing, "mp3")])
        .expect_err("panne attendue");

    assert!(
        matches!(error, NamingError::Write(_)),
        "relire notre propre sortie est une écriture locale, pas une collision : {error:?}"
    );
}

#[test]
fn the_lunii_suffix_is_read_before_the_extension_and_in_capitals() {
    // Règle de Lunii.QT : `splitext(ref)[0]` puis `[-8:].upper()`.
    assert_eq!(lunii_suffix("0123456789abcdef.mp3"), "89ABCDEF");
    assert_eq!(lunii_suffix("court.png"), "COURT");
    assert_eq!(lunii_suffix("sans-extension"), "XTENSION");
}

#[test]
fn the_archive_name_carries_the_real_format_not_the_author_extension() {
    let Some(ffmpeg) = ffmpeg_or_skip("archive_name_real_format") else {
        return;
    };
    let scratch = Scratch::new("nom-format");
    // La référence du dialecte annonce un `.wav` ; les octets finaux sont du
    // MP3. Laisser le nom d'auteur ferait transcoder par Lunii.QT et
    // décoder en WAV par STUdio.
    let source = scratch.write_source("src", "voix.wav", &wav_bytes(&tone(440.0, 0.4, 0.5)));
    let document = document_with(&stage(ENTRY, true, Some("voix.wav"), None), "");

    let preparation = prepare(
        &document,
        &[binding("voix.wav", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    let name = preparation.destinations[0].archive_name.clone();
    assert!(name.ends_with(".mp3"), "{name}");
    assert!(
        !name.contains('/') && !name.starts_with("assets"),
        "STUdio indexe `assets/` à profondeur 1, par nom nu — {name}"
    );
    let stem = name.trim_end_matches(".mp3");
    assert_eq!(stem.len(), 40, "un SHA-1 hexadécimal complet : {name}");
    assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));

    // Le nom est adressé par le **contenu** : le fichier écrit porte bien
    // l'empreinte que son nom annonce.
    let entry = &preparation.archive_entries[0];
    let bytes = fs::read(&entry.output_path).expect("relire la sortie");
    assert_eq!(
        crate::native_pack::assets::audio::hashed_asset_name(&bytes, "mp3"),
        name
    );
}
