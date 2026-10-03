//! L'archive produite, relue par Story Studio.
//!
//! La relecture n'emprunte **pas** la fonction qui vient d'écrire : elle passe
//! par `import_pack_as_advanced_document`, le chemin d'acquisition réel d'un
//! pack, celui-là même qu'un auteur emprunterait en rouvrant l'archive. Ce qui
//! est comparé n'est donc pas ce que le writer croit avoir écrit, mais ce qu'un
//! lecteur indépendant y trouve.

use super::*;

/// L'archive relue rend le même graphe, les mêmes destinations médias et la
/// même identité.
#[test]
fn the_published_archive_reads_back_into_the_same_story() {
    let scratch = Scratch::new("readback");
    let first = scratch.write_media("a.png", &png_bytes(320, 240, 0));
    let second = scratch.write_media("b.png", &png_bytes(200, 150, 1));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("a.png")),
            stage(SECOND, false, None, Some("b.png")),
            stage(THIRD, false, None, Some("a.png")),
        ],
        vec![SECOND, THIRD],
    ));
    let exported = export(
        &payload,
        &[binding("a.png", &first), binding("b.png", &second)],
        &scratch.output(),
    )
    .expect("export réussi");

    // Relecture par le chemin d'acquisition réel.
    let acquired = crate::services::pack_reader::import_pack_as_advanced_document(
        &exported.zip_path,
        scratch
            .dir("readback-assets")
            .to_str()
            .expect("chemin des assets"),
    )
    .expect("relecture de l'archive produite");
    let reread = reopen(&acquired.payload);

    // Même identité : l'écran d'entrée relu porte exactement la `packIdentity`.
    let entry = reread
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .expect("un écran d'entrée relu");
    assert_eq!(entry.uuid, exported.pack_identity);
    assert_eq!(
        reread.context.pack_identity.value.as_deref(),
        Some(exported.pack_identity.as_str()),
        "l'identité relue est celle exportée"
    );

    // Même graphe : autant d'écrans, autant d'actions, mêmes cibles.
    let source = reopen(&payload);
    assert_eq!(
        reread.document.stage_nodes.len(),
        source.document.stage_nodes.len()
    );
    assert_eq!(
        reread.document.action_nodes.len(),
        source.document.action_nodes.len()
    );
    let expected_targets: Vec<String> = source.document.action_nodes[0]
        .options
        .iter()
        .flatten()
        .map(|target| exported.stage_id_map[target].clone())
        .collect();
    let observed_targets: Vec<String> = reread.document.action_nodes[0]
        .options
        .iter()
        .flatten()
        .cloned()
        .collect();
    assert_eq!(observed_targets, expected_targets, "mêmes enchaînements");

    // Mêmes destinations médias : chaque écran relu porte le contenu que la
    // carte des destinations lui attribuait, comparé **sur les octets**.
    for destination in &exported.destinations {
        let export_uuid = &exported.stage_id_map[&destination.stage_uuid];
        let stage = reread
            .document
            .stage_nodes
            .iter()
            .find(|stage| &stage.uuid == export_uuid)
            .expect("l'écran relu existe");
        let field = match destination.kind {
            MediaKind::Audio => stage.audio.as_deref(),
            MediaKind::Image => stage.image.as_deref(),
        };
        assert_eq!(
            field,
            Some(destination.archive_name.as_str()),
            "l'écran relu désigne le nom d'archive attendu"
        );
        let binding = acquired
            .media_bindings
            .iter()
            .find(|binding| binding.asset_ref == destination.archive_name)
            .expect("l'acquisition produit une liaison par référence");
        let path = binding
            .path
            .as_deref()
            .expect("un média extrait a un chemin");
        let bytes = fs::read(path).expect("relire le média extrait");
        assert_eq!(
            sha256_of(&bytes),
            destination.output_sha256,
            "le contenu arrivé à cette destination est bien celui préparé"
        );
    }

    // Le média partagé n'a produit qu'un fichier, et les deux écrans le lisent.
    assert_eq!(acquired.media_bindings.len(), 2, "deux contenus distincts");
}

/// La relecture d'un pack **importé STUdio** exporté puis réimporté conserve la
/// couverture et la forme d'archive attendue par les deux passerelles.
#[test]
fn a_studio_pack_survives_a_full_export_and_import_cycle() {
    let scratch = Scratch::new("studio_cycle");
    let (payload, bindings) = imported_studio_project(
        &scratch,
        &story_value(
            vec![
                stage(HYPHENLESS, true, None, Some("cover.png")),
                stage(ENTRY, false, None, Some("second.png")),
            ],
            vec![ENTRY],
        ),
        &[
            ("cover.png", png_bytes(320, 240, 0)),
            ("second.png", png_bytes(320, 240, 2)),
        ],
    );

    let exported = export(&payload, &bindings, &scratch.output()).expect("export du pack STUdio");
    let entries = archive_entries(&exported.zip_path);
    assert!(entries.contains_key("thumbnail.png"));

    // Chaque entrée `assets/` est plate, nommée par son contenu, et référencée.
    let story = story_of(&entries);
    let referenced: Vec<String> = story["stageNodes"]
        .as_array()
        .expect("stageNodes")
        .iter()
        .filter_map(|stage| stage["image"].as_str())
        .map(str::to_string)
        .collect();
    let mut written = asset_names(&entries);
    written.sort();
    let mut referenced = referenced;
    referenced.sort();
    assert_eq!(written, referenced, "complétude croisée du pack publié");

    // Réimport : l'identité STUdio d'origine est conservée par l'export.
    let acquired = crate::services::pack_reader::import_pack_as_advanced_document(
        &exported.zip_path,
        scratch.dir("cycle-assets").to_str().expect("chemin"),
    )
    .expect("réimport du pack exporté");
    let reread = reopen(&acquired.payload);
    assert_eq!(
        reread.context.pack_identity.value.as_deref(),
        Some(HYPHENLESS),
        "l'identité source bridge-compatible traverse le cycle"
    );
}

/// Le contrôle exact d'archive est **réellement appelé**, sur
/// l'archive nominale puis sur une archive dont deux images sont échangées.
///
/// Comparer des empreintes entre elles prouverait la contre-épreuve mais pas la
/// fonction. Ici, `verify_written_archive` — la fonction de production de
/// l'étape 12 — est invoquée deux fois : elle accepte l'archive conforme et
/// rend `media-oracle` avec **deux** désaccords sur l'archive altérée, un par
/// média déplacé.
///
/// La chaîne est montée avec les fonctions réelles — préparation des médias,
/// préparation de la copie, sérialisation standard, écriture — parce que le
/// contrôle a besoin de la préparation qui a produit l'archive, et qu'aucun
/// double ne peut la fournir sans dénaturer la preuve.
#[test]
fn the_archive_control_really_runs_and_rejects_two_swapped_media() {
    let scratch = Scratch::new("archive_control");
    let first = scratch.write_media("a.png", &png_bytes(320, 240, 0));
    let second = scratch.write_media("b.png", &png_bytes(320, 240, 1));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("a.png")),
            stage(SECOND, false, None, Some("b.png")),
        ],
        vec![SECOND],
    ));
    let source = reopen(&payload);
    let bindings = [binding("a.png", &first), binding("b.png", &second)];

    // Les étapes 5 à 11, par leurs fonctions de production.
    let prepared_assets = prepare_advanced_assets(
        &source.document,
        &bindings,
        &scratch.dir("workspace"),
        Path::new(""),
        &AdvancedAudioOptions::default(),
    )
    .expect("préparation des médias");
    let prepared_copy = prepare_graph_document_for_export_with_asset_names(
        &source,
        &prepared_assets.name_table,
        None,
        None,
    )
    .expect("préparation de la copie");
    let story_json = serialize_prepared_graph_document(&prepared_copy).expect("sérialisation");
    let thumbnail = build_cover(&source.document, &prepared_assets, None).expect("couverture");

    let nominal = scratch.dir("archives").join("nominal.zip");
    write_pack_zip(
        &ArchiveContents {
            story_json: &story_json,
            assets: prepared_assets
                .archive_entries
                .iter()
                .map(|entry| ArchiveAsset {
                    archive_name: entry.archive_name.as_str(),
                    source_path: entry.output_path.as_path(),
                })
                .collect(),
            thumbnail_png: thumbnail.clone(),
        },
        &nominal,
    )
    .expect("écriture de l'archive nominale");

    // Appel réel n° 1 : l'archive conforme passe.
    verify_written_archive(&nominal, &story_json, &prepared_assets, thumbnail.is_some())
        .expect("l'archive nominale doit passer le contrôle exact");

    // Deux images échangées : chaque nom porte désormais les octets de l'autre.
    let entries = archive_entries(nominal.to_str().expect("chemin"));
    let mut names = asset_names(&entries);
    names.sort();
    assert_eq!(names.len(), 2, "le banc porte bien deux médias distincts");
    let swapped = scratch.dir("archives").join("swapped.zip");
    write_swapped_archive(&swapped, &entries, &names[0], &names[1]);

    // Appel réel n° 2 : le contrôle refuse, et nomme les deux destinations.
    let error =
        verify_written_archive(&swapped, &story_json, &prepared_assets, thumbnail.is_some())
            .expect_err("une archive dont les médias sont échangés doit être refusée");
    match error {
        AdvancedExportError::MediaOracle { disagreements } => {
            assert_eq!(
                disagreements.len(),
                2,
                "un désaccord par média déplacé : {disagreements:?}"
            );
            let refused: std::collections::BTreeSet<&str> = disagreements
                .iter()
                .map(|disagreement| disagreement.asset_ref.as_str())
                .collect();
            assert_eq!(
                refused,
                [names[0].as_str(), names[1].as_str()].into_iter().collect(),
                "les deux noms d'archive sont nommés"
            );
        }
        other => panic!("refus media-oracle attendu, obtenu {other:?}"),
    }
}

/// Réécrit une archive en permutant le contenu de deux entrées `assets/`.
///
/// Les **noms** ne bougent pas, ni le `story.json` : seule la correspondance
/// nom ↔ octets est rompue. C'est exactement ce que le comparateur structurel
/// figé ne voit pas, et ce que le contrôle exact doit voir.
fn write_swapped_archive(
    path: &Path,
    entries: &BTreeMap<String, Vec<u8>>,
    first: &str,
    second: &str,
) {
    use std::io::Write;
    let first_entry = format!("assets/{first}");
    let second_entry = format!("assets/{second}");
    let file = fs::File::create(path).expect("créer l'archive permutée");
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        zip.start_file(name, opts).expect("entrée");
        let payload: &[u8] = if name == &first_entry {
            &entries[&second_entry]
        } else if name == &second_entry {
            &entries[&first_entry]
        } else {
            bytes
        };
        zip.write_all(payload).expect("écrire l'entrée");
    }
    zip.finish().expect("finaliser l'archive permutée");
}

fn sha256_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// La vignette catalogue de l'enveloppe l'emporte sur l'image d'entrée, et
/// elle est encodée **sans redimensionnement** — c'est ce qui la distingue
/// d'un asset d'Écran, toujours converti en 320×240.
///
/// Son absence n'est pas un cas d'erreur : le repli sur l'image d'entrée est
/// le comportement d'origine, et il doit rester intact.
#[test]
fn la_vignette_d_enveloppe_prime_sur_l_image_d_entree_et_garde_sa_taille() {
    let scratch = Scratch::new("cover_preference");
    let entry_image = scratch.write_media("a.png", &png_bytes(320, 240, 0));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("a.png"))],
        vec![],
    ));
    let source = reopen(&payload);
    let bindings = [binding("a.png", &entry_image)];
    let prepared_assets = prepare_advanced_assets(
        &source.document,
        &bindings,
        &scratch.dir("workspace"),
        Path::new(""),
        &AdvancedAudioOptions::default(),
    )
    .expect("préparation des médias");

    // Une couverture volontairement hors format Lunii : si elle ressort
    // inchangée, c'est qu'aucune conversion ne s'est appliquée.
    let cover_path = scratch.dir("cover").join("cover.png");
    let cover = image::RgbaImage::from_pixel(500, 120, image::Rgba([7, 9, 11, 255]));
    cover.save(&cover_path).expect("écriture de la couverture");

    let preferred =
        build_cover(&source.document, &prepared_assets, Some(&cover_path)).expect("couverture");
    let bytes = preferred.expect("une couverture est produite");
    let decoded = image::load_from_memory(&bytes).expect("PNG relisible");
    assert_eq!(
        (decoded.width(), decoded.height()),
        (500, 120),
        "la vignette catalogue garde sa taille libre",
    );

    let fallback = build_cover(&source.document, &prepared_assets, None).expect("repli");
    assert!(
        fallback.is_some(),
        "sans vignette déclarée, l'image de l'Écran d'entrée reste la couverture",
    );
    assert_ne!(
        fallback.expect("repli"),
        bytes,
        "le repli et la vignette déclarée ne sont pas le même média",
    );
}
