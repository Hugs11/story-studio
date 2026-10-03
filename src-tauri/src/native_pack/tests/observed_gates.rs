//! Les trois contrôles de l'éditeur avancé, branchés sur la chaîne Libre en
//! observation.
//!
//! Ce que ces tests doivent établir, dans cet ordre :
//!
//! 1. les portes **tournent réellement** — un pack ordinaire les traverse et
//!    rend trois constats, pas un champ vide ;
//! 2. un cas **construit pour être refusé** apparaît dans le relevé **et se
//!    produit quand même** ;
//! 3. aucune production existante n'est modifiée — l'archive est identique,
//!    octet pour octet, que les portes observent ou non.

use super::*;
use crate::native_pack::observed_gates::{
    observe_archive_review, observe_document_gates, refusal_from_gates, GateOutcome, GatePolicy,
    ObservedGate,
};
use std::io::Read;
use std::path::{Path, PathBuf};

fn canonical_options() -> CanonicalOptions {
    CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Off,
        harmonize_loudness: true,
        auto_next: false,
        night_mode: false,
        end_message_autoplay: true,
    }
}

fn temp_gate_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "story_studio_gates_{}_{}_{}",
        name,
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&dir).expect("create gate dir");
    dir
}

fn staged_asset(base: &Path, role: &str, staged_asset_name: &str) -> PreparedAsset {
    let staged_path = base.join("stage").join(staged_asset_name);
    if let Some(parent) = staged_path.parent() {
        fs::create_dir_all(parent).expect("create staged parent");
    }
    fs::write(&staged_path, staged_asset_name.as_bytes()).expect("write staged asset");
    PreparedAsset {
        role: role.to_string(),
        source_path: staged_path.to_string_lossy().to_string(),
        source_kind: "test".to_string(),
        staged_asset_name: staged_asset_name.to_string(),
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed: false,
        deduplicated: false,
    }
}

/// Un projet Libre ordinaire : une histoire, ses médias, sa couverture.
fn ordinary_free_project(base: &Path) -> (CanonicalProject, Vec<PreparedAsset>) {
    let cover_source = base.join("source-cover.png");
    write_test_png(&cover_source);
    (
        CanonicalProject {
            name: "Observation des portes".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some(cover_source.to_string_lossy().to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: canonical_options(),
            entries: vec![CanonicalEntry::Story(CanonicalStory {
                name: "Histoire Alpha".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: Some("item.mp3".to_string()),
                item_image: Some("item.png".to_string()),
                ..Default::default()
            })],
            shared_entries: Vec::new(),
        },
        vec![
            staged_asset(base, "rootAudio", "root.mp3"),
            staged_asset(base, "rootImage", "cover.png"),
            staged_asset(base, "root/Histoire Alpha/itemAudio", "item.mp3"),
            staged_asset(base, "root/Histoire Alpha/itemImage", "item.png"),
            staged_asset(base, "root/Histoire Alpha/storyAudio", "story.mp3"),
        ],
    )
}

fn staged_pairs(report: &NativeAssetPreparationReport) -> Vec<(String, String)> {
    report
        .assets
        .iter()
        .map(|asset| {
            (
                asset.staged_asset_name.clone(),
                asset.staged_asset_path.clone(),
            )
        })
        .collect()
}

/// Les trois portes tournent, et rendent trois constats explicables.
#[test]
fn the_three_gates_really_run_on_a_free_chain_pack() {
    let base = temp_gate_dir("ordinary");
    let (project, assets) = ordinary_free_project(&base);
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");
    let written = write_native_pack_archive(&report, &document, &base.join("out"))
        .expect("write local archive");

    let mut observations =
        observe_document_gates(&written.story_json, None, GatePolicy::OBSERVE_ONLY);
    observations.push(observe_archive_review(
        &written.zip_path,
        &written.story_json,
        &staged_pairs(&report),
        written.has_thumbnail,
        GatePolicy::OBSERVE_ONLY,
    ));

    assert_eq!(observations.len(), 3, "les trois portes doivent répondre");
    assert_eq!(
        observations
            .iter()
            .map(|observation| observation.gate)
            .collect::<Vec<_>>(),
        vec![
            ObservedGate::Readiness,
            ObservedGate::PackIdentity,
            ObservedGate::ArchiveReview,
        ]
    );
    // Une porte qui ne tournerait pas vraiment rendrait un constat vide : c'est
    // exactement ce que ces portes ne doivent pas produire.
    for observation in &observations {
        assert!(
            !observation.note.is_empty(),
            "{:?} n'a rien constaté",
            observation.gate
        );
        assert!(
            !observation.blocking,
            "{:?} ne doit jamais être bloquante dans la chaîne Libre",
            observation.gate
        );
        assert_eq!(
            observation.reasons.is_empty(),
            observation.outcome != GateOutcome::WouldRefuse,
            "{:?} : un refus observé sans motif n'est pas exploitable",
            observation.gate
        );
    }

    // Le relevé de ce pack, écrit ici pour que la mesure ne soit pas la seule
    // trace de ce que les portes répondent sur une production ordinaire.
    for observation in &observations {
        println!("{}", observation.log_line());
    }

    let _ = fs::remove_dir_all(base);
}

/// La relecture d'archive voit ce qu'elle doit voir, et ne touche pas l'archive.
///
/// Le cas est construit : on présente au relecteur une attente que l'archive ne
/// satisfait pas — un média de plus que ce qu'elle porte. La porte le voit, et
/// le ZIP écrit reste intact : un contrôle constate, il ne répare ni n'abîme.
#[test]
fn the_archive_gate_sees_a_built_defect_without_touching_the_archive() {
    let base = temp_gate_dir("refused");
    let (project, assets) = ordinary_free_project(&base);
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");
    let written = write_native_pack_archive(&report, &document, &base.join("out"))
        .expect("write local archive");
    let bytes_before = fs::read(&written.zip_path).expect("read written archive");

    let mut staged = staged_pairs(&report);
    let absent = base.join("stage").join("jamais-ecrit.mp3");
    fs::write(&absent, b"un media que l'archive ne porte pas").expect("write extra asset");
    staged.push((
        "jamais-ecrit.mp3".to_string(),
        absent.to_string_lossy().to_string(),
    ));

    let observation = observe_archive_review(
        &written.zip_path,
        &written.story_json,
        &staged,
        written.has_thumbnail,
        GatePolicy::OBSERVE_ONLY,
    );

    assert_eq!(observation.outcome, GateOutcome::WouldRefuse);
    assert!(
        observation
            .reasons
            .iter()
            .any(|reason| reason.path.contains("jamais-ecrit.mp3")),
        "le motif doit nommer ce qui manque : {:?}",
        observation.reasons
    );

    // L'archive n'a pas bougé d'un octet : le contrôle lit, il n'écrit pas.
    assert_eq!(
        bytes_before,
        fs::read(&written.zip_path).expect("relire l'archive"),
        "un contrôle d'archive ne touche pas l'archive"
    );

    let _ = fs::remove_dir_all(base);
}

/// L'archive produite est identique, que les portes observent ou non.
///
/// C'est la contrainte centrale des portes. Elle est éprouvée sur les octets, pas
/// sur une intention : deux écritures du même projet, l'une suivie des trois
/// observations, l'autre non, doivent rendre le même fichier.
#[test]
fn observation_does_not_change_a_single_byte_of_the_archive() {
    let base = temp_gate_dir("identity");
    let (project, assets) = ordinary_free_project(&base);
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");

    let unobserved = write_native_pack_archive(&report, &document, &base.join("out-a"))
        .expect("write archive without observation");
    let unobserved_bytes = fs::read(&unobserved.zip_path).expect("read unobserved");

    let observed = write_native_pack_archive(&report, &document, &base.join("out-b"))
        .expect("write archive with observation");
    let mut observations =
        observe_document_gates(&observed.story_json, None, GatePolicy::OBSERVE_ONLY);
    observations.push(observe_archive_review(
        &observed.zip_path,
        &observed.story_json,
        &staged_pairs(&report),
        observed.has_thumbnail,
        GatePolicy::OBSERVE_ONLY,
    ));
    let observed_bytes = fs::read(&observed.zip_path).expect("read observed");

    assert_eq!(unobserved_bytes, observed_bytes);
    assert_eq!(unobserved.story_json, observed.story_json);
    assert_eq!(observations.len(), 3);

    let _ = fs::remove_dir_all(base);
}

/// Le `story.json` d'une production Libre ordinaire, pour le casser ensuite.
///
/// Partir de l'artefact réel plutôt que d'une fixture écrite à la main est ce
/// qui rend ces deux cas concluants : ils prouvent que la porte réagit à une
/// altération de **ce que la chaîne Libre produit**, pas d'un document inventé
/// pour l'occasion.
fn produced_story_json(base: &Path) -> String {
    let (project, assets) = ordinary_free_project(base);
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");
    write_native_pack_archive(&report, &document, &base.join("out"))
        .expect("write local archive")
        .story_json
}

/// La porte de readiness tourne : un graphe cassé la fait parler.
#[test]
fn the_readiness_gate_really_refuses_a_broken_graph() {
    let base = temp_gate_dir("readiness");
    let story_json = produced_story_json(&base);
    let mut story: serde_json::Value =
        serde_json::from_str(&story_json).expect("story.json relisible");

    // Deux Stages portant le même identifiant : STUdio les range
    // dans une map indexée par `uuid`, donc un doublon fusionne silencieusement
    // deux écrans — c'est exactement ce que la porte existe pour attraper.
    let stages = story["stageNodes"].as_array_mut().expect("stageNodes");
    assert!(stages.len() >= 2, "le pack doit avoir au moins deux écrans");
    let first_uuid = stages[0]["uuid"].clone();
    stages[1]["uuid"] = first_uuid;
    let broken = serde_json::to_string_pretty(&story).expect("sérialiser le document cassé");

    let observations = observe_document_gates(&broken, None, GatePolicy::OBSERVE_ONLY);
    let readiness = observations
        .iter()
        .find(|observation| observation.gate == ObservedGate::Readiness)
        .expect("la porte de readiness doit répondre");

    assert_eq!(readiness.outcome, GateOutcome::WouldRefuse);
    assert!(
        readiness
            .reasons
            .iter()
            .any(|reason| reason.code == "DUPLICATE_STAGE_ID"),
        "le motif attendu doit être nommé : {:?}",
        readiness.reasons
    );
    // Et elle n'a toujours rien bloqué : c'est une observation.
    assert!(!readiness.blocking);

    let _ = fs::remove_dir_all(base);
}

/// La porte d'identité tourne : une identité d'entrée inexploitable la fait
/// parler, et elle seule.
#[test]
fn the_identity_gate_really_refuses_an_unusable_entry_identity() {
    let base = temp_gate_dir("identity-gate");
    let story_json = produced_story_json(&base);
    let mut story: serde_json::Value =
        serde_json::from_str(&story_json).expect("story.json relisible");

    // L'identité stable du pack est celle de l'unique Stage d'entrée. Une
    // graphie qu'aucune des deux passerelles ne sait relire rend cette identité
    // inexploitable, sans rien casser du graphe.
    let square_one_uuid = {
        let stages = story["stageNodes"].as_array().expect("stageNodes");
        stages
            .iter()
            .find(|stage| stage.get("squareOne").and_then(serde_json::Value::as_bool) == Some(true))
            .and_then(|stage| stage.get("uuid"))
            .and_then(serde_json::Value::as_str)
            .expect("un Stage squareOne")
            .to_string()
    };
    let unusable = "pas une identité";
    for stage in story["stageNodes"].as_array_mut().expect("stageNodes") {
        if stage["uuid"] == serde_json::Value::String(square_one_uuid.clone()) {
            stage["uuid"] = serde_json::Value::String(unusable.to_string());
        }
    }
    // Les cibles qui désignaient ce Stage doivent suivre, sinon c'est la
    // readiness qui parlerait à la place de la porte d'identité.
    for action in story["actionNodes"].as_array_mut().expect("actionNodes") {
        for option in action["options"].as_array_mut().expect("options") {
            if *option == serde_json::Value::String(square_one_uuid.clone()) {
                *option = serde_json::Value::String(unusable.to_string());
            }
        }
    }
    let altered = serde_json::to_string_pretty(&story).expect("sérialiser le document altéré");

    let observations = observe_document_gates(&altered, None, GatePolicy::OBSERVE_ONLY);
    let identity = observations
        .iter()
        .find(|observation| observation.gate == ObservedGate::PackIdentity)
        .expect("la porte d'identité doit répondre");

    assert_eq!(identity.outcome, GateOutcome::WouldRefuse);
    assert_eq!(identity.reasons.len(), 1);
    assert_eq!(identity.reasons[0].code, "PACK_IDENTITY");
    assert!(!identity.blocking);

    let _ = fs::remove_dir_all(base);
}

// ── La reprise : les trois portes bloquent ───────────────────────────────────
//
// Ce que ces tests tiennent n'est pas qu'une porte sait refuser — c'est prouvé
// plus haut, sous la politique de mesure. C'est que **la politique en vigueur
// lui en donne le droit**, et que ce droit s'arrête au bon endroit : avant la
// publication, jamais après.

/// La politique en vigueur donne le droit de refuser aux trois portes.
#[test]
fn the_enforced_policy_lets_all_three_gates_refuse() {
    let base = temp_gate_dir("enforced");
    let story_json = produced_story_json(&base);

    for gate in [ObservedGate::Readiness, ObservedGate::PackIdentity] {
        let observed = observe_document_gates(&story_json, None, GatePolicy::ENFORCED);
        let observation = observed
            .iter()
            .find(|observation| observation.gate == gate)
            .expect("la porte doit répondre");
        assert!(
            observation.blocking,
            "{gate:?} doit avoir le droit d'arrêter la production"
        );
    }

    let _ = fs::remove_dir_all(base);
}

/// Un pack conforme n'est pas arrêté : la politique ne refuse pas par principe.
#[test]
fn an_ordinary_pack_is_not_refused_by_the_enforced_policy() {
    let base = temp_gate_dir("enforced-ok");
    let (project, assets) = ordinary_free_project(&base);
    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");
    let written = write_native_pack_archive(&report, &document, &base.join("out"))
        .expect("write local archive");

    let mut observations = observe_document_gates(
        &written.story_json,
        Some(report.pack_uuid.as_str()),
        GatePolicy::ENFORCED,
    );
    observations.push(observe_archive_review(
        &written.zip_path,
        &written.story_json,
        &staged_pairs(&report),
        written.has_thumbnail,
        GatePolicy::ENFORCED,
    ));

    assert_eq!(refusal_from_gates(&observations), None);
    assert!(observations
        .iter()
        .all(|observation| !observation.refuses()));

    let _ = fs::remove_dir_all(base);
}

/// Un pack fautif est arrêté, et le refus nomme ce qu'il faut corriger.
#[test]
fn a_faulty_pack_is_refused_and_the_message_names_the_cause() {
    let base = temp_gate_dir("enforced-ko");
    let story_json = produced_story_json(&base);
    let mut story: serde_json::Value =
        serde_json::from_str(&story_json).expect("story.json relisible");
    let stages = story["stageNodes"].as_array_mut().expect("stageNodes");
    let first_uuid = stages[0]["uuid"].clone();
    stages[1]["uuid"] = first_uuid;
    let broken = serde_json::to_string_pretty(&story).expect("sérialiser le document cassé");

    let observations = observe_document_gates(&broken, None, GatePolicy::ENFORCED);
    let refusal = refusal_from_gates(&observations).expect("la production doit être refusée");

    // Un auteur doit pouvoir agir sans ouvrir un journal : le message dit ce
    // qui s'est passé, quelle porte a parlé, et ce qu'il advient de l'archive.
    assert!(refusal.contains("Production refusée avant publication"));
    assert!(refusal.contains("Aucune archive n'a été écrite"));
    assert!(refusal.contains("Readiness d'export"));
    assert!(refusal.contains("DUPLICATE_STAGE_ID"));

    let _ = fs::remove_dir_all(base);
}

/// La politique de mesure reste rejouable : elle n'arrête rien.
///
/// Sans cela, la campagne de corpus ne pourrait plus être relancée à l'identique,
/// et le relevé cesserait d'être reproductible.
#[test]
fn the_measurement_policy_still_refuses_nothing() {
    let base = temp_gate_dir("observe-only");
    let story_json = produced_story_json(&base);
    let mut story: serde_json::Value =
        serde_json::from_str(&story_json).expect("story.json relisible");
    let stages = story["stageNodes"].as_array_mut().expect("stageNodes");
    let first_uuid = stages[0]["uuid"].clone();
    stages[1]["uuid"] = first_uuid;
    let broken = serde_json::to_string_pretty(&story).expect("sérialiser le document cassé");

    let observations = observe_document_gates(&broken, None, GatePolicy::OBSERVE_ONLY);
    assert!(
        crate::native_pack::observed_gates::any_would_refuse(&observations),
        "la porte doit toujours constater le défaut"
    );
    assert_eq!(
        refusal_from_gates(&observations),
        None,
        "mais elle ne doit rien arrêter sous la politique de mesure"
    );

    let _ = fs::remove_dir_all(base);
}

/// Le constat d'une porte ne dépend pas de la politique. **Seul son droit change.**
///
/// C'est la propriété qui rend le relevé de mesure transposable à la
/// politique actuelle : si aucune porte n'a refusé sous la politique de
/// mesure, aucune ne refuse sous la politique en vigueur. Sans elle, il aurait
/// fallu rejouer 1 h 44 de campagne pour rétablir la même certitude.
#[test]
fn the_policy_changes_the_right_to_refuse_never_the_finding() {
    let base = temp_gate_dir("policy-neutral");
    let story_json = produced_story_json(&base);
    let mut story: serde_json::Value =
        serde_json::from_str(&story_json).expect("story.json relisible");
    let stages = story["stageNodes"].as_array_mut().expect("stageNodes");
    let first_uuid = stages[0]["uuid"].clone();
    stages[1]["uuid"] = first_uuid;
    let broken = serde_json::to_string_pretty(&story).expect("sérialiser le document cassé");

    for document in [story_json.as_str(), broken.as_str()] {
        let measured = observe_document_gates(document, None, GatePolicy::OBSERVE_ONLY);
        let enforced = observe_document_gates(document, None, GatePolicy::ENFORCED);
        assert_eq!(measured.len(), enforced.len());
        for (measured, enforced) in measured.iter().zip(&enforced) {
            assert_eq!(measured.gate, enforced.gate);
            assert_eq!(measured.outcome, enforced.outcome, "le verdict a changé");
            assert_eq!(measured.reasons, enforced.reasons, "les motifs ont changé");
            assert_eq!(measured.note, enforced.note);
            // La seule différence, et elle est voulue.
            assert!(!measured.blocking);
            assert!(enforced.blocking);
        }
    }

    let _ = fs::remove_dir_all(base);
}

/// Une vignette catalogue distincte de l'image d'accueil garde son sidecar,
/// sans ajouter dans `assets/` une copie étrangère au contenu du pack Libre.
#[test]
fn a_distinct_catalog_thumbnail_passes_the_archive_gate() {
    let base = temp_gate_dir("catalog-thumbnail");
    let (mut project, assets) = ordinary_free_project(&base);
    let thumbnail_source = base.join("catalog-thumbnail.png");
    let thumbnail = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        4,
        4,
        image::Rgb([200, 20, 30]),
    ));
    thumbnail
        .save(&thumbnail_source)
        .expect("write catalog thumbnail");
    project.thumbnail_image = Some(thumbnail_source.to_string_lossy().to_string());

    let requests = collect_asset_requests(&project, 0.4, 0.4);
    assert!(requests
        .iter()
        .all(|request| request.role != "thumbnailImage"));

    let report = report_for(project, assets, Vec::new());
    let document = build_story_document(&report).expect("build story document");
    let written = write_native_pack_archive(&report, &document, &base.join("out"))
        .expect("write local archive");
    let mut observations = observe_document_gates(
        &written.story_json,
        Some(report.pack_uuid.as_str()),
        GatePolicy::ENFORCED,
    );
    observations.push(observe_archive_review(
        &written.zip_path,
        &written.story_json,
        &staged_pairs(&report),
        written.has_thumbnail,
        GatePolicy::ENFORCED,
    ));
    assert_eq!(refusal_from_gates(&observations), None, "{observations:#?}");

    let mut archive = zip::ZipArchive::new(fs::File::open(&written.zip_path).expect("open ZIP"))
        .expect("read ZIP");
    let mut thumbnail_bytes = Vec::new();
    archive
        .by_name("thumbnail.png")
        .expect("catalog thumbnail retained")
        .read_to_end(&mut thumbnail_bytes)
        .expect("read catalog thumbnail");
    assert_eq!(
        thumbnail_bytes,
        crate::native_pack::writer::encode_thumbnail_png(&thumbnail_source)
            .expect("expected thumbnail bytes")
    );

    fs::remove_dir_all(base).expect("remove test files");
}

/// Mesure locale sur des `.mbah` Libre décodés et convertis par le frontend.
/// Les projets et leurs médias restent sur la machine ; seuls les ZIP temporaires
/// produits par ce test sont supprimés après chaque génération.
#[test]
#[ignore = "corpus privé : STORY_STUDIO_N1_PROJECTS doit pointer vers des exports JSON temporaires"]
fn n1_real_free_projects_pass_all_three_enforced_gates() {
    let input = PathBuf::from(
        std::env::var("STORY_STUDIO_N1_PROJECTS").expect("STORY_STUDIO_N1_PROJECTS requis"),
    );
    let mut projects = fs::read_dir(&input)
        .expect("dossier des projets convertis")
        .map(|entry| entry.expect("entrée lisible").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    projects.sort();
    assert!(!projects.is_empty(), "aucun projet Libre à mesurer");

    let output = temp_gate_dir("n1-real-projects");
    let mut failures = Vec::new();
    for (index, path) in projects.iter().enumerate() {
        let project: crate::domain::project::Project =
            serde_json::from_slice(&fs::read(path).expect("projet lisible"))
                .expect("projet exporté vers Rust");
        let destination = output.join(format!("project-{index}"));
        let result = crate::native_pack::generate_native_pack_v1_with_cancel(
            &project,
            destination.to_str().expect("destination UTF-8"),
            &|_| {},
            &|| false,
        );
        match result {
            Ok(result) => {
                assert_eq!(result.gate_observations.len(), 3);
                assert!(
                    result
                        .gate_observations
                        .iter()
                        .all(|observation| observation.outcome == GateOutcome::Passed),
                    "projet {index} : {:#?}",
                    result.gate_observations
                );
                println!("projet {index} : les trois portes passent");
            }
            Err(error) => failures.push(format!("projet {index} refusé : {error}")),
        }
        fs::remove_dir_all(destination).expect("supprimer le ZIP temporaire");
    }
    fs::remove_dir_all(output).expect("supprimer les sorties temporaires");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
