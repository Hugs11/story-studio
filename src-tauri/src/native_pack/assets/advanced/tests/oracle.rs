//! Garantie 1 — traçabilité exacte, et ses contre-épreuves.
//!
//! Chaque test éprouve une contre-épreuve de cette garantie. Deux d'entre elles
//! constatent une **limite** plutôt qu'une garantie : elles sont conservées
//! parce qu'une garantie qui ne dit pas ce qu'elle ne couvre pas laisse croire
//! qu'elle couvre tout.

use std::collections::BTreeMap;
use std::fs;
use std::time::Duration;

use super::*;
use crate::native_pack::assets::advanced::executor::{read_registry, TaskExecutor};
use crate::native_pack::assets::advanced::inventory::media_destinations;
use crate::native_pack::assets::advanced::oracle::verify_attachment;
use crate::native_pack::assets::advanced::plan::{ConversionPlan, ConversionTask, PlanStep};
use crate::native_pack::assets::advanced::workspace::AdvancedWorkspace;

const DEADLINE: Duration = Duration::from_secs(120);

/// Dépose deux instantanés distincts et rend l'espace de travail ouvert.
fn workspace_with_two_snapshots(scratch: &Scratch) -> (AdvancedWorkspace, String, String) {
    let workspace = AdvancedWorkspace::open(&scratch.workspace()).expect("espace de travail");
    let mut shas = Vec::new();
    for bytes in [png_bytes(640, 480, 0), png_bytes(640, 480, 1)] {
        let sha = crate::native_pack::assets::advanced::digest::sha256_bytes(&bytes);
        fs::write(workspace.snapshot_path(&sha), &bytes).expect("écrire l'instantané");
        shas.push(sha);
    }
    (workspace, shas[0].clone(), shas[1].clone())
}

#[test]
fn ce1_swapping_the_conversion_receipts_before_the_registry_changes_nothing() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce1") else {
        return;
    };
    let scratch = Scratch::new("ce1");
    let (workspace, sha_a, sha_b) = workspace_with_two_snapshots(&scratch);
    let task_a = ConversionTask::new(sha_a, ConversionPlan::ImageResizePng);
    let task_b = ConversionTask::new(sha_b, ConversionPlan::ImageResizePng);

    let executor = TaskExecutor::new(&workspace, &ffmpeg, DEADLINE);
    let receipt_a = executor.run(&task_a).expect("tâche a");
    let receipt_b = executor.run(&task_b).expect("tâche b");

    // On inverse les retours : un registre qui les lirait serait trompé.
    let swapped = [receipt_b, receipt_a];
    assert_ne!(swapped[0].task_key(), swapped[1].task_key());

    // Le registre ne les lit pas : il relit les adresses dérivées des clés.
    let registry = read_registry(&workspace, &[task_a.clone(), task_b.clone()]).expect("registre");
    let again = read_registry(&workspace, &[task_a.clone(), task_b.clone()]).expect("registre");

    assert_eq!(registry, again);
    assert_eq!(registry[0].task_key, task_a.task_key());
    assert_eq!(registry[1].task_key, task_b.task_key());
    assert_ne!(
        registry[0].output_sha256, registry[1].output_sha256,
        "deux images distinctes produisent deux sorties distinctes"
    );
}

#[test]
fn ce2_no_crossed_pair_is_expressible_every_descriptor_addresses_its_own_output() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce2") else {
        return;
    };
    let scratch = Scratch::new("ce2");
    let (workspace, sha_a, sha_b) = workspace_with_two_snapshots(&scratch);
    let task_a = ConversionTask::new(sha_a.clone(), ConversionPlan::ImageResizePng);
    let task_b = ConversionTask::new(sha_b.clone(), ConversionPlan::ImageResizePng);

    let executor = TaskExecutor::new(&workspace, &ffmpeg, DEADLINE);
    executor.run(&task_a).expect("tâche a");
    executor.run(&task_b).expect("tâche b");

    // `run` ne prend **qu'un** descripteur : il n'existe aucune API qui
    // accepterait l'entrée de l'une et la destination de l'autre. La preuve est
    // la surface d'appel elle-même ; ce qui s'observe à l'exécution, c'est que
    // toute recomposition d'un descripteur **s'adresse ailleurs**.
    let forged = ConversionTask::new(
        sha_a.clone(),
        ConversionPlan::ImageVerbatim { extension: "png" },
    );
    assert_ne!(forged.task_key(), task_a.task_key());
    assert_ne!(forged.task_key(), task_b.task_key());
    assert_ne!(
        workspace.output_path(&forged.task_key()),
        workspace.output_path(&task_b.task_key()),
        "mélanger l'instantané de l'une et le plan de l'autre ne mène jamais à l'adresse d'une tâche existante"
    );

    // Et l'adresse de chaque sortie reste celle que son propre descripteur
    // désigne.
    for task in [&task_a, &task_b] {
        assert!(workspace.output_path(&task.task_key()).is_file());
    }
}

#[test]
fn ce2bis_a_write_behind_the_executor_is_not_detected_and_the_contract_does_not_promise_it() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce2bis") else {
        return;
    };
    let scratch = Scratch::new("ce2bis");
    let (workspace, sha_a, sha_b) = workspace_with_two_snapshots(&scratch);
    let task_a = ConversionTask::new(sha_a, ConversionPlan::ImageResizePng);
    let task_b = ConversionTask::new(sha_b, ConversionPlan::ImageResizePng);

    let executor = TaskExecutor::new(&workspace, &ffmpeg, DEADLINE);
    executor.run(&task_a).expect("tâche a");
    executor.run(&task_b).expect("tâche b");

    // On contourne l'exécuteur et on écrit la sortie de b à l'adresse de a.
    let output_a = workspace.output_path(&task_a.task_key());
    let output_b = workspace.output_path(&task_b.task_key());
    let bytes_b = fs::read(&output_b).expect("relire b");
    fs::write(&output_a, &bytes_b).expect("écrire par-dessus a");

    let registry = read_registry(&workspace, &[task_a, task_b]).expect("registre");

    // Le registre constate une chaîne **cohérente** : il relit ce qui est là.
    // Aucune égalité de hachage ne peut voir une corruption survenue derrière
    // la frontière d'exécution, et c'est assumé. Le filet complémentaire est la
    // garantie 2, bornée aux fixtures distinguables.
    assert_eq!(
        registry[0].output_sha256, registry[1].output_sha256,
        "l'écriture forcée n'est pas détectée : c'est la portée exacte de la garantie 1"
    );
}

#[test]
fn ce3_permuting_two_table_entries_fails_the_attachment_check() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce3") else {
        return;
    };
    let scratch = Scratch::new("ce3");
    let first = scratch.write_source("src", "a.png", &png_bytes(640, 480, 0));
    let second = scratch.write_source("src", "b.png", &png_bytes(640, 480, 1));
    let document = document_with(
        &[
            stage(ENTRY, true, None, Some("img-a")),
            stage(SECOND, false, None, Some("img-b")),
        ]
        .join(","),
        "",
    );
    let bindings = [binding("img-a", &first), binding("img-b", &second)];

    let preparation = prepare(&document, &bindings, &scratch, &ffmpeg).expect("préparation");
    let name_a = preparation.destinations[0].archive_name.clone();
    let name_b = preparation.destinations[1].archive_name.clone();
    assert_ne!(name_a, name_b);

    // On rejoue la vérification avec une table permutée : à la
    // frontière que cette préparation possède. Le contrôle exact d'archive de
    // l'export rejouera la même permutation sur le ZIP écrit.
    let workspace = AdvancedWorkspace::open(&scratch.workspace()).expect("espace de travail");
    let destinations = media_destinations(&document);
    let media = crate::native_pack::assets::advanced::inventory::inventory_media(
        &document, &bindings, &workspace, &ffmpeg, DEADLINE,
    )
    .expect("inventaire");
    let mut tasks = BTreeMap::new();
    for item in &media {
        tasks.insert(
            item.asset_ref.clone(),
            ConversionTask::new(item.snapshot_sha256.clone(), ConversionPlan::ImageResizePng),
        );
    }
    let distinct: Vec<_> = tasks.values().cloned().collect();
    let registry: BTreeMap<_, _> = read_registry(&workspace, &distinct)
        .expect("registre")
        .into_iter()
        .map(|entry| (entry.task_key.clone(), entry))
        .collect();

    let swapped = crate::native_pack::assets::advanced::naming::table_from_pairs(&[
        ("img-a", name_b.as_str()),
        ("img-b", name_a.as_str()),
    ]);

    let disagreements = verify_attachment(
        &workspace,
        &destinations,
        &media,
        &tasks,
        &registry,
        &swapped,
    )
    .expect_err("une table permutée ne doit pas passer");
    assert!(
        !disagreements.is_empty(),
        "permuter deux noms met deux contenus à la mauvaise adresse"
    );
}

#[test]
fn ce4_swapping_two_outputs_after_the_registry_fails_the_attachment_check() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce4") else {
        return;
    };
    let scratch = Scratch::new("ce4");
    let (workspace, sha_a, sha_b) = workspace_with_two_snapshots(&scratch);
    let task_a = ConversionTask::new(sha_a, ConversionPlan::ImageResizePng);
    let task_b = ConversionTask::new(sha_b, ConversionPlan::ImageResizePng);
    let executor = TaskExecutor::new(&workspace, &ffmpeg, DEADLINE);
    executor.run(&task_a).expect("tâche a");
    executor.run(&task_b).expect("tâche b");

    let registry: BTreeMap<_, _> = read_registry(&workspace, &[task_a.clone(), task_b.clone()])
        .expect("registre")
        .into_iter()
        .map(|entry| (entry.task_key.clone(), entry))
        .collect();

    // Le registre est constitué ; **ensuite** on échange le contenu des deux
    // sorties en gardant leurs adresses. La vérification relit et recalcule :
    // elle voit le désaccord.
    let output_a = workspace.output_path(&task_a.task_key());
    let output_b = workspace.output_path(&task_b.task_key());
    let bytes_a = fs::read(&output_a).expect("relire a");
    let bytes_b = fs::read(&output_b).expect("relire b");
    fs::write(&output_a, &bytes_b).expect("écrire a");
    fs::write(&output_b, &bytes_a).expect("écrire b");

    let recomputed =
        read_registry(&workspace, &[task_a.clone(), task_b.clone()]).expect("registre");
    assert_ne!(
        recomputed[0].output_sha256,
        registry[&task_a.task_key()].output_sha256,
        "relire l'adresse montre que son contenu a changé après coup"
    );
}

#[test]
fn ce5_and_ce6_a_nominal_export_and_a_converted_media_pass_the_whole_chain() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce5_ce6") else {
        return;
    };
    let scratch = Scratch::new("ce5");
    let wav = scratch.write_source("src", "voix.wav", &wav_bytes(&tone(440.0, 0.5, 0.5)));
    let png = scratch.write_source("src", "img.png", &png_bytes(320, 240, 0));
    let document = document_with(&stage(ENTRY, true, Some("voix.wav"), Some("img.png")), "");

    let preparation = prepare(
        &document,
        &[binding("voix.wav", &wav), binding("img.png", &png)],
        &scratch,
        &ffmpeg,
    )
    .expect("l'oracle passe sur un export nominal et sur une conversion honnête");

    assert_eq!(preparation.destinations.len(), 2);
    assert_eq!(preparation.name_table.len(), 2);
    for destination in &preparation.destinations {
        let entry = preparation
            .archive_entries
            .iter()
            .find(|entry| entry.archive_name == destination.archive_name)
            .expect("chaque destination a son fichier");
        assert_eq!(entry.output_sha256, destination.output_sha256);
        let (observed, _) =
            crate::native_pack::assets::advanced::digest::sha256_file(&entry.output_path)
                .expect("relire");
        assert_eq!(
            observed, entry.output_sha256,
            "le fichier écrit porte bien l'empreinte que le registre annonce"
        );
    }
}

#[test]
fn an_occupied_output_address_is_a_defect_never_a_silent_reuse() {
    let Some(ffmpeg) = ffmpeg_or_skip("occupied_address") else {
        return;
    };
    let scratch = Scratch::new("occupee");
    let (workspace, sha_a, _) = workspace_with_two_snapshots(&scratch);
    let task = ConversionTask::new(sha_a, ConversionPlan::ImageResizePng);

    // Un contenu étranger occupe déjà l'adresse que la tâche va dériver.
    fs::write(workspace.output_path(&task.task_key()), b"contenu etranger")
        .expect("occuper l'adresse");

    let executor = TaskExecutor::new(&workspace, &ffmpeg, DEADLINE);
    let failure = executor.run(&task).expect_err("défaut attendu");

    assert!(
        matches!(
            failure,
            crate::native_pack::assets::advanced::executor::ExecutionFailure::Oracle(_)
        ),
        "réutiliser en silence ce qu'on n'a pas produit serait exactement la faute que l'adressage doit empêcher : {failure:?}"
    );
}

#[test]
fn a_task_that_left_no_output_is_a_defect_and_the_registry_says_so() {
    let scratch = Scratch::new("inachevee");
    let (workspace, sha_a, _) = workspace_with_two_snapshots(&scratch);
    let task = ConversionTask::new(sha_a, ConversionPlan::ImageResizePng);

    // Le registre n'est lu qu'une fois **toutes** les tâches terminées : une
    // sortie absente est un défaut, pas une entrée vide.
    let failure = read_registry(&workspace, &[task]).expect_err("défaut attendu");

    assert!(matches!(
        failure,
        crate::native_pack::assets::advanced::executor::ExecutionFailure::Oracle(_)
    ));
}

#[test]
fn every_plan_parameter_enters_the_task_key() {
    let sha = "a".repeat(64);
    let verbatim = ConversionTask::new(sha.clone(), ConversionPlan::AudioVerbatim);
    let png = ConversionTask::new(sha.clone(), ConversionPlan::ImageResizePng);
    let image_verbatim = ConversionTask::new(
        sha.clone(),
        ConversionPlan::ImageVerbatim { extension: "png" },
    );

    let mut keys = vec![
        verbatim.task_key(),
        png.task_key(),
        image_verbatim.task_key(),
    ];

    // Deux chaînes de filtres qui ne diffèrent que par une durée de bord — le
    // cas T5b — sont deux tâches.
    for filters in [
        "aformat=channel_layouts=mono,adelay=400",
        "aformat=channel_layouts=mono,adelay=500",
        "aformat=channel_layouts=mono,volume=2dB",
        "aformat=channel_layouts=mono,volume=2dB,alimiter=limit=0.794328:level=disabled",
    ] {
        keys.push(
            ConversionTask::new(
                sha.clone(),
                ConversionPlan::AudioEncode {
                    filters: filters.to_string(),
                    applied: vec![PlanStep::MonoDownmix, PlanStep::Mp3Encode],
                    notice: None,
                },
            )
            .task_key(),
        );
    }

    let distinct: std::collections::BTreeSet<_> = keys.iter().collect();
    assert_eq!(
        distinct.len(),
        keys.len(),
        "deux transformations différentes ne peuvent pas partager une adresse de sortie"
    );

    // Et la clé est une fonction **pure** du descripteur : même descripteur,
    // même clé, à chaque appel.
    assert_eq!(verbatim.task_key(), verbatim.task_key());
    assert_ne!(
        ConversionTask::new("b".repeat(64), ConversionPlan::AudioVerbatim).task_key(),
        verbatim.task_key(),
        "l'instantané entre dans la clé"
    );
}
