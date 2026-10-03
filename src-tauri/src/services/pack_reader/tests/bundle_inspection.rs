//! Les enveloppes multi-pack, de bout en bout côté Rust : ce qui est reconnu
//! comme enveloppe, ce qui ne l'est pas, et ce qui ressort de la sélection d'un
//! enfant.
//!
//! Les fixtures sont **synthétiques**. Les trois enveloppes réelles de la
//! bibliothèque ne sont pas dans le dépôt et ne peuvent pas y entrer ; elles
//! sont vérifiées séparément par `real_library_envelopes_expose_their_children`,
//! pilotée par variable d'environnement.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::services::pack_reader::bundle::{BundleChildStatus, PackArchiveKind};
use crate::services::pack_reader::{inspect_pack_archive, PackArchiveInspection};
use crate::support::imported_pack::{bundle_container_fingerprint, extract_bundle_child};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "story_studio_bundle_inspection_{}_{}_{}",
        label,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).expect("dossier temporaire");
    dir
}

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("dossier parent");
    }
    let file = fs::File::create(path).expect("créer le zip");
    let mut writer = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in entries {
        writer.start_file(*name, options).expect("entrée zip");
        writer.write_all(bytes).expect("écrire l'entrée");
    }
    writer.finish().expect("finaliser le zip");
}

fn editable_story_json(title: &str) -> serde_json::Value {
    serde_json::json!({
        "title": title,
        "version": 1,
        "description": "",
        "format": "v1",
        "nightModeAvailable": false,
        "stageNodes": [
            {
                "uuid": "cover", "name": "Cover", "type": "stage", "squareOne": true,
                "audio": "root.mp3", "image": "cover.png",
                "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "homeTransition": null
            },
            {
                "uuid": "title", "name": "Titre", "type": "stage", "squareOne": false,
                "audio": "item.mp3", "image": "item.png",
                "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                "okTransition": { "actionNode": "play-action", "optionIndex": 0 },
                "homeTransition": null
            },
            {
                "uuid": "play", "name": "Lecture", "type": "stage", "squareOne": false,
                "audio": "story.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
            }
        ],
        "actionNodes": [
            { "id": "root-action", "name": "Root", "options": ["title"] },
            { "id": "play-action", "name": "Play", "options": ["play"] }
        ]
    })
}

/// Un pack Studio éditable, dont le contenu diffère d'un titre à l'autre : deux
/// enfants identiques partageraient une conversion mise en cache et masqueraient
/// une confusion d'identité.
fn editable_pack_bytes(title: &str) -> Vec<u8> {
    let dir = temp_dir("child-source");
    let path = dir.join("pack.zip");
    let raw = serde_json::to_vec(&editable_story_json(title)).expect("sérialiser story.json");
    write_zip(
        &path,
        &[
            ("story.json", raw.as_slice()),
            ("assets/root.mp3", title.as_bytes()),
            ("assets/cover.png", b"cover"),
            ("assets/item.mp3", b"item"),
            ("assets/item.png", b"item-image"),
            ("assets/story.mp3", b"story"),
        ],
    );
    let bytes = fs::read(&path).expect("relire le pack enfant");
    fs::remove_dir_all(dir).expect("nettoyage");
    bytes
}

fn inspect(path: &Path) -> Result<PackArchiveInspection, String> {
    inspect_pack_archive(path.to_str().expect("utf8"), |_, _| {})
}

/// Une archive normale ouvre exactement comme avant : l'inspection la déclare
/// directe et ne présente aucun enfant.
#[test]
fn a_plain_pack_archive_is_reported_as_direct() {
    let dir = temp_dir("direct");
    let pack = dir.join("Pack seul.zip");
    fs::write(&pack, editable_pack_bytes("Pack seul")).expect("écrire le pack");

    let inspection = inspect(&pack).expect("inspection");
    assert_eq!(inspection.kind, PackArchiveKind::Direct);
    assert!(inspection.children.is_empty());
    assert_eq!(inspection.container_fingerprint.len(), 64);

    fs::remove_dir_all(dir).expect("nettoyage");
}

#[test]
fn an_envelope_of_two_packs_exposes_both_with_their_verdict() {
    let dir = temp_dir("two-children");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            (
                "Premier pack.zip",
                editable_pack_bytes("Premier").as_slice(),
            ),
            ("Second pack.zip", editable_pack_bytes("Second").as_slice()),
        ],
    );

    let inspection = inspect(&envelope).expect("inspection");
    assert_eq!(inspection.kind, PackArchiveKind::Bundle);
    assert_eq!(inspection.children.len(), 2);
    let names: Vec<&str> = inspection
        .children
        .iter()
        .map(|child| child.display_name.as_str())
        .collect();
    assert_eq!(names, vec!["Premier pack", "Second pack"]);
    for child in &inspection.children {
        assert_eq!(child.status, BundleChildStatus::Editable);
        assert!(child.selectable);
        assert!(child.size_bytes > 0);
    }

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Le verdict affiché dans la liste est celui du classifieur commun, et c'est
/// le même que celui qu'aurait reçu l'enfant fourni seul. Sans cette égalité,
/// l'écran de choix promettrait ce que la suite du parcours ne tiendrait pas.
#[test]
fn a_child_verdict_equals_the_verdict_of_the_same_pack_supplied_alone() {
    let dir = temp_dir("same-verdict");
    let alone = dir.join("Seul.zip");
    let bytes = editable_pack_bytes("Comparaison");
    fs::write(&alone, &bytes).expect("écrire le pack seul");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            ("Comparaison.zip", bytes.as_slice()),
            ("Autre.zip", editable_pack_bytes("Autre").as_slice()),
        ],
    );

    let alone_report =
        crate::services::pack_reader::classify_pack_editability(alone.to_str().expect("utf8"))
            .expect("verdict du pack seul");
    let inspection = inspect(&envelope).expect("inspection");
    let child = inspection
        .children
        .iter()
        .find(|child| child.display_name == "Comparaison")
        .expect("enfant présent");

    assert_eq!(child.status, BundleChildStatus::Editable);
    assert!(alone_report.authoring_editable);
    assert_eq!(child.reason, alone_report.reason);

    fs::remove_dir_all(dir).expect("nettoyage");
}

#[test]
fn a_mixed_envelope_keeps_the_broken_child_visible_but_unselectable() {
    let dir = temp_dir("mixed");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            ("Bon pack.zip", editable_pack_bytes("Bon").as_slice()),
            ("Casse.zip", b"ceci n'est pas une archive"),
        ],
    );

    let inspection = inspect(&envelope).expect("inspection");
    assert_eq!(inspection.kind, PackArchiveKind::Bundle);
    let good = &inspection.children[0];
    let broken = &inspection.children[1];
    assert_eq!(good.display_name, "Bon pack");
    assert_eq!(good.status, BundleChildStatus::Editable);
    assert!(good.selectable);
    assert_eq!(broken.display_name, "Casse");
    assert_eq!(broken.status, BundleChildStatus::Error);
    assert!(!broken.selectable);
    assert!(!broken.reason.is_empty());

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Une enveloppe dans une enveloppe est refusée avec une raison lisible, pas
/// avec le symptôme « aucun pack reconnu ».
#[test]
fn a_nested_envelope_child_is_refused_with_a_readable_reason() {
    let dir = temp_dir("nested");
    let inner = dir.join("Interne.zip");
    write_zip(
        &inner,
        &[
            ("A.zip", editable_pack_bytes("A").as_slice()),
            ("B.zip", editable_pack_bytes("B").as_slice()),
        ],
    );
    let inner_bytes = fs::read(&inner).expect("relire l'enveloppe interne");
    let envelope = dir.join("Externe.zip");
    write_zip(
        &envelope,
        &[
            ("Pack.zip", editable_pack_bytes("Pack").as_slice()),
            ("Enveloppe imbriquee.zip", inner_bytes.as_slice()),
        ],
    );

    let inspection = inspect(&envelope).expect("inspection");
    let nested = inspection
        .children
        .iter()
        .find(|child| child.display_name == "Enveloppe imbriquee")
        .expect("enfant imbriqué présent");
    assert_eq!(nested.status, BundleChildStatus::Error);
    assert!(!nested.selectable);
    assert!(
        nested.reason.contains("contient 2 packs"),
        "raison inattendue : {}",
        nested.reason
    );

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Un pack direct accompagné d'annexes reste un pack direct : le premier jalon
/// n'invente pas une enveloppe là où une histoire est déjà lisible.
#[test]
fn a_direct_pack_beside_annex_archives_stays_direct() {
    let dir = temp_dir("annex");
    let archive = dir.join("Pack avec annexes.zip");
    let raw = serde_json::to_vec(&editable_story_json("Direct")).expect("story.json");
    write_zip(
        &archive,
        &[
            ("pack/story.json", raw.as_slice()),
            ("pack/assets/root.mp3", b"root"),
            ("pack/assets/cover.png", b"cover"),
            ("pack/assets/item.mp3", b"item"),
            ("pack/assets/item.png", b"item-image"),
            ("pack/assets/story.mp3", b"story"),
            ("annexe-1.zip", b"annexe"),
            ("annexe-2.zip", b"annexe"),
        ],
    );

    let inspection = inspect(&archive).expect("inspection");
    assert_eq!(inspection.kind, PackArchiveKind::Direct);
    assert!(inspection.children.is_empty());

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Une archive qui ne porte qu'un seul ZIP interne n'offre aucun choix : elle
/// reste l'échec d'import qu'elle était, avec son message d'origine.
#[test]
fn a_single_nested_archive_is_not_an_envelope() {
    let dir = temp_dir("single-child");
    let archive = dir.join("Un seul.zip");
    write_zip(
        &archive,
        &[("Unique.zip", editable_pack_bytes("Unique").as_slice())],
    );

    let error = inspect(&archive).expect_err("aucun pack reconnu");
    assert!(
        error.contains("Aucun pack Lunii reconnu"),
        "message inattendu : {error}"
    );

    fs::remove_dir_all(dir).expect("nettoyage");
}

#[test]
fn selecting_a_child_yields_a_pack_the_classifier_accepts() {
    let dir = temp_dir("select");
    let cache = dir.join("cache");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            ("Premier.zip", editable_pack_bytes("Premier").as_slice()),
            ("Second.zip", editable_pack_bytes("Second").as_slice()),
        ],
    );

    let inspection = inspect(&envelope).expect("inspection");
    let chosen = &inspection.children[1];
    let child_path = extract_bundle_child(
        envelope.to_str().expect("utf8"),
        &inspection.container_fingerprint,
        &chosen.child_id,
        &cache,
    )
    .expect("extraction de l'enfant");

    assert!(child_path.is_file());
    assert!(child_path.starts_with(&cache));
    let report =
        crate::services::pack_reader::classify_pack_editability(child_path.to_str().expect("utf8"))
            .expect("verdict de l'enfant extrait");
    assert!(report.authoring_editable);

    fs::remove_dir_all(dir).expect("nettoyage");
}

#[test]
fn an_unknown_child_identifier_is_refused() {
    let dir = temp_dir("unknown-child");
    let cache = dir.join("cache");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            ("Premier.zip", editable_pack_bytes("Premier").as_slice()),
            ("Second.zip", editable_pack_bytes("Second").as_slice()),
        ],
    );
    let inspection = inspect(&envelope).expect("inspection");

    let error = extract_bundle_child(
        envelope.to_str().expect("utf8"),
        &inspection.container_fingerprint,
        &"0".repeat(64),
        &cache,
    )
    .expect_err("identifiant inconnu refusé");
    assert!(error.contains("ne fait pas partie"), "{error}");

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Un chemin d'entrée malveillant ne sort jamais du temporaire : l'extraction
/// refuse l'archive avant même qu'un inventaire puisse être présenté.
#[test]
fn a_traversal_entry_in_an_envelope_is_refused() {
    let dir = temp_dir("traversal");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            ("../evade.zip", editable_pack_bytes("Evade").as_slice()),
            ("Second.zip", editable_pack_bytes("Second").as_slice()),
        ],
    );

    let error = inspect(&envelope).expect_err("traversal refusé");
    assert!(
        error.contains("invalide ou dangereuse"),
        "message inattendu : {error}"
    );
    assert!(
        !dir.parent().expect("parent").join("evade.zip").exists(),
        "aucune entrée ne doit sortir du temporaire"
    );

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Entre l'affichage de la liste et le choix d'un enfant, l'archive peut avoir
/// été remplacée. L'inventaire d'hier ne doit pas s'appliquer au contenu
/// d'aujourd'hui.
#[test]
fn a_container_replaced_between_listing_and_selection_is_refused() {
    let dir = temp_dir("replaced");
    let cache = dir.join("cache");
    let envelope = dir.join("Enveloppe.zip");
    write_zip(
        &envelope,
        &[
            ("Premier.zip", editable_pack_bytes("Premier").as_slice()),
            ("Second.zip", editable_pack_bytes("Second").as_slice()),
        ],
    );
    let inspection = inspect(&envelope).expect("inspection");
    let chosen_id = inspection.children[0].child_id.clone();

    write_zip(
        &envelope,
        &[
            ("Autre.zip", editable_pack_bytes("Autre").as_slice()),
            ("Encore.zip", editable_pack_bytes("Encore").as_slice()),
        ],
    );
    assert_ne!(
        bundle_container_fingerprint(envelope.to_str().expect("utf8")).expect("empreinte"),
        inspection.container_fingerprint
    );

    let error = extract_bundle_child(
        envelope.to_str().expect("utf8"),
        &inspection.container_fingerprint,
        &chosen_id,
        &cache,
    )
    .expect_err("conteneur remplacé refusé");
    assert!(error.contains("a changé depuis"), "{error}");

    fs::remove_dir_all(dir).expect("nettoyage");
}

/// Validation externe sur les trois enveloppes réelles de la bibliothèque.
///
/// Elles sont privées : ni leur contenu, ni leurs noms n'entrent dans le dépôt.
/// Le test est donc ignoré par défaut et prend son corpus dans
/// `STORY_STUDIO_L00_ENVELOPES`, une liste de chemins séparés par `;`, et le
/// nombre d'enfants attendu dans `STORY_STUDIO_L00_EXPECTED_CHILDREN`, une liste
/// d'entiers dans le même ordre.
///
/// Par défaut, **un** enfant de chaque enveloppe est réellement extrait puis
/// reclassé. `STORY_STUDIO_L00_ALL_CHILDREN=1` les extrait **tous** : c'est la
/// preuve complète, mais chaque extraction ré-ouvre le conteneur, donc elle dure
/// une quinzaine de minutes sur ce corpus.
#[test]
#[ignore = "corpus privé : STORY_STUDIO_L00_ENVELOPES et STORY_STUDIO_L00_EXPECTED_CHILDREN requis"]
fn real_library_envelopes_expose_their_children() {
    let envelopes =
        std::env::var("STORY_STUDIO_L00_ENVELOPES").expect("STORY_STUDIO_L00_ENVELOPES requis");
    let expected = std::env::var("STORY_STUDIO_L00_EXPECTED_CHILDREN")
        .expect("STORY_STUDIO_L00_EXPECTED_CHILDREN requis");
    let envelopes: Vec<&str> = envelopes.split(';').filter(|v| !v.is_empty()).collect();
    let expected: Vec<usize> = expected
        .split(';')
        .filter(|v| !v.is_empty())
        .map(|v| v.trim().parse().expect("entier attendu"))
        .collect();
    assert_eq!(
        envelopes.len(),
        expected.len(),
        "autant de comptes attendus que d'enveloppes"
    );

    let all_children =
        std::env::var("STORY_STUDIO_L00_ALL_CHILDREN").is_ok_and(|value| value == "1");
    let cache = temp_dir("real-corpus").join("cache");
    let mut opened = 0_usize;
    for (envelope, expected_children) in envelopes.iter().zip(expected) {
        let inspection = inspect_pack_archive(envelope, |_, _| {}).expect("inspection");
        assert_eq!(
            inspection.kind,
            PackArchiveKind::Bundle,
            "enveloppe attendue"
        );
        assert_eq!(
            inspection.children.len(),
            expected_children,
            "nombre d'enfants attendu"
        );
        for child in &inspection.children {
            assert_eq!(
                child.status,
                BundleChildStatus::Editable,
                "les 23 enfants relevés par l'audit sont éditables"
            );
        }
        // Les enfants sont réellement ouverts, pas seulement comptés : chacun
        // repasse par la sélection puis par le classifieur, comme le ferait
        // l'auteur qui le choisit dans la liste.
        let chosen: Vec<&crate::services::pack_reader::bundle::InspectedBundleChild> =
            if all_children {
                inspection.children.iter().collect()
            } else {
                inspection.children.iter().take(1).collect()
            };
        for child in chosen {
            let child_path = extract_bundle_child(
                envelope,
                &inspection.container_fingerprint,
                &child.child_id,
                &cache,
            )
            .expect("extraction de l'enfant");
            let report = crate::services::pack_reader::classify_pack_editability(
                child_path.to_str().expect("utf8"),
            )
            .expect("verdict de l'enfant extrait");
            assert!(
                report.authoring_editable,
                "l'enfant extrait doit rester éditable"
            );
            opened += 1;
        }
    }
    println!("{opened} packs enfants extraits et reclassés éditables");
}
