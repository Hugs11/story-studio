//! Intégrité abstraite du graphe et sélection d'option, vues depuis le
//! document décodé.
//!
//! Les documents de ces tests passent par `decode_story_document`, le décodeur
//! réel : un test qui construirait un `StoryDocument` à la main sauterait le
//! refus de dialecte de `< -1` et la conservation présence-sensible, donc ne
//! prouverait pas la chaîne réelle.
//!
//! Le banc local sur les 366 `story.json` privés reste `#[ignore]`.

use std::collections::BTreeMap;

use crate::native_pack::{
    decode_story_document, validate_graph_document_integrity, GraphIntegrityCode, OptionSelection,
    Presence, StoryDocument,
};

fn decode(raw: &str) -> StoryDocument {
    decode_story_document(raw)
        .unwrap_or_else(|error| panic!("document décodable : {error}"))
        .document
}

fn integrity_codes(document: &StoryDocument) -> Vec<GraphIntegrityCode> {
    match validate_graph_document_integrity(document) {
        Ok(()) => Vec::new(),
        Err(errors) => errors.into_iter().map(|error| error.code).collect(),
    }
}

fn assert_valid(raw: &str) {
    let document = decode(raw);
    assert_eq!(
        validate_graph_document_integrity(&document),
        Ok(()),
        "document attendu conforme : {raw}"
    );
}

fn assert_rejected_with(raw: &str, expected: GraphIntegrityCode) {
    let document = decode(raw);
    let codes = integrity_codes(&document);
    assert!(
        codes.contains(&expected),
        "{expected:?} attendu, obtenu {codes:?}"
    );
}

const CONTROLS: &str = r#"{"wheel":true,"ok":true,"home":false,"pause":false,"autoplay":false}"#;

/// Un document minimal valide : une entrée, une Action à deux options, deux
/// destinations. Les trous du gabarit permettent de casser un seul prédicat à la
/// fois.
fn document(stages: &str, actions: &str) -> String {
    format!(
        r#"{{"format":"v1","version":1,"title":"GVI",
            "stageNodes":[{stages}],"actionNodes":[{actions}]}}"#
    )
}

fn entry_stage(uuid: &str, transition: &str) -> String {
    format!(
        r#"{{"uuid":"{uuid}","squareOne":true,"audio":null,"image":null,
             "controlSettings":{CONTROLS},"okTransition":{transition},"homeTransition":null}}"#
    )
}

fn plain_stage(uuid: &str) -> String {
    format!(
        r#"{{"uuid":"{uuid}","audio":null,"image":null,
             "controlSettings":{CONTROLS},"okTransition":null,"homeTransition":null}}"#
    )
}

fn action(id: &str, options: &str) -> String {
    format!(r#"{{"id":"{id}","options":[{options}]}}"#)
}

fn valid_document() -> String {
    document(
        &format!(
            "{},{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left"),
            plain_stage("right")
        ),
        &action("choice", r#""left","right""#),
    )
}

// ---------------------------------------------------------------------------
// Les neuf prédicats bloquants, une fixture dédiée chacun.
// ---------------------------------------------------------------------------

#[test]
fn the_reference_document_passes_every_predicate() {
    assert_valid(&valid_document());
}

#[test]
fn gvi_001_refuses_an_empty_stage_identifier() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("")
        ),
        &action("choice", r#""entry""#),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::StageIdEmpty);
}

#[test]
fn gvi_002_refuses_two_stages_sharing_an_identifier() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("entry")
        ),
        &action("choice", r#""entry""#),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::DuplicateStageId);
}

#[test]
fn gvi_003_refuses_an_empty_action_identifier() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left")
        ),
        &format!(
            "{},{}",
            action("choice", r#""left""#),
            action("", r#""left""#)
        ),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::ActionIdEmpty);
}

#[test]
fn gvi_004_refuses_two_actions_sharing_an_identifier() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left")
        ),
        &format!(
            "{},{}",
            action("choice", r#""left""#),
            action("choice", r#""left""#)
        ),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::DuplicateActionId);
}

#[test]
fn gvi_004_leaves_the_stage_and_action_identifier_spaces_distinct() {
    // Une Action et un Stage peuvent porter le même identifiant : leurs espaces
    // restent séparés.
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("shared", r#"{"actionNode":"shared","optionIndex":0}"#),
            plain_stage("left")
        ),
        &action("shared", r#""left""#),
    );
    assert_valid(&raw);
}

#[test]
fn gvi_005_refuses_zero_or_several_entry_stages() {
    let without_entry = document(
        &format!("{},{}", plain_stage("a"), plain_stage("left")),
        &action("choice", r#""left""#),
    );
    assert_rejected_with(&without_entry, GraphIntegrityCode::SquareOneCount);

    let with_two_entries = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            entry_stage("second", "null")
        ),
        &action("choice", r#""second""#),
    );
    assert_rejected_with(&with_two_entries, GraphIntegrityCode::SquareOneCount);
}

#[test]
fn gvi_006_refuses_a_transition_towards_an_unknown_action() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"ghost","optionIndex":0}"#),
            plain_stage("left")
        ),
        &action("choice", r#""left""#),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::TransitionActionMissing);
}

#[test]
fn gvi_006_covers_the_home_port_as_well_as_ok() {
    let raw = document(
        &format!(
            r#"{{"uuid":"entry","squareOne":true,"audio":null,"image":null,
                 "controlSettings":{CONTROLS},
                 "okTransition":{{"actionNode":"choice","optionIndex":0}},
                 "homeTransition":{{"actionNode":"ghost","optionIndex":0}}}},{}"#,
            plain_stage("left")
        ),
        &action("choice", r#""left""#),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::TransitionActionMissing);
}

#[test]
fn gvi_007_refuses_a_null_option_without_turning_it_into_an_empty_string() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left")
        ),
        &action("choice", r#""left",null"#),
    );
    let document = decode(&raw);
    // La cible nulle est conservée à son index : elle atteint le contrôle
    // d'intégrité telle quelle.
    assert_eq!(
        document.action_nodes[0].options,
        vec![Some("left".into()), None]
    );
    let codes = integrity_codes(&document);
    assert!(
        codes.contains(&GraphIntegrityCode::OptionTargetNull),
        "{codes:?}"
    );
    // Une cible nulle n'est pas une cible introuvable : les deux codes sont
    // distincts et ne se déclenchent pas ensemble sur la même option.
    assert!(
        !codes.contains(&GraphIntegrityCode::OptionTargetMissing),
        "{codes:?}"
    );
}

#[test]
fn gvi_008_refuses_an_option_towards_an_unknown_stage() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left")
        ),
        &action("choice", r#""left","ghost""#),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::OptionTargetMissing);
}

#[test]
fn gvi_009_refuses_a_random_selection_on_an_action_without_option() {
    let raw = document(
        &entry_stage("entry", r#"{"actionNode":"empty","optionIndex":-1}"#),
        &action("empty", ""),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::OptionSelectionInvalid);
}

#[test]
fn gvi_009_refuses_a_fixed_selection_out_of_bounds() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":2}"#),
            plain_stage("left")
        ),
        &action("choice", r#""left""#),
    );
    assert_rejected_with(&raw, GraphIntegrityCode::OptionSelectionInvalid);
}

#[test]
fn gvi_009_accepts_random_on_ok_and_on_home_separately() {
    let ok_random = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":-1}"#),
            plain_stage("left")
        ),
        &action("choice", r#""left""#),
    );
    assert_valid(&ok_random);

    let home_random = document(
        &format!(
            r#"{{"uuid":"entry","squareOne":true,"audio":null,"image":null,
                 "controlSettings":{CONTROLS},
                 "okTransition":{{"actionNode":"choice","optionIndex":0}},
                 "homeTransition":{{"actionNode":"choice","optionIndex":-1}}}},{}"#,
            plain_stage("left")
        ),
        &action("choice", r#""left""#),
    );
    assert_valid(&home_random);
}

#[test]
fn a_selection_below_minus_one_is_refused_before_integrity() {
    let raw = document(
        &entry_stage("entry", r#"{"actionNode":"choice","optionIndex":-2}"#),
        &action("choice", r#""entry""#),
    );
    let error = decode_story_document(&raw).expect_err("dialecte invalide");
    assert!(
        error
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "transition-option-index-below-minus-one"),
        "{:?}",
        error.diagnostics
    );
}

// ---------------------------------------------------------------------------
// Ce que l'intégrité abstraite ne refuse pas.
// ---------------------------------------------------------------------------

#[test]
fn gvi_010_accepts_a_stage_identifier_that_is_not_a_uuid() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("foo")
        ),
        &action("choice", r#""foo""#),
    );
    assert_valid(&raw);
}

#[test]
fn gvi_011_accepts_a_component_unreachable_from_the_entry() {
    let island = format!(
        r#"{{"uuid":"island","audio":null,"image":null,"controlSettings":{CONTROLS},
             "okTransition":{{"actionNode":"island-action","optionIndex":0}},
             "homeTransition":null}}"#
    );
    let raw = document(
        &format!(
            "{},{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left"),
            // Île complète, jamais atteinte depuis `entry` : les deux passerelles
            // la conservent.
            island
        ),
        &format!(
            "{},{}",
            action("choice", r#""left""#),
            action("island-action", r#""island""#)
        ),
    );
    assert_valid(&raw);
}

#[test]
fn gvi_011a_accepts_an_orphan_action_node() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("left")
        ),
        &format!(
            "{},{}",
            action("choice", r#""left""#),
            action("orphan", r#""left""#)
        ),
    );
    assert_valid(&raw);
}

#[test]
fn gvi_012_accepts_cycles_self_loops_and_a_home_equal_to_ok() {
    // `entry` boucle sur lui-même par OK et par HOME, via la même Action : cycle,
    // self-loop OK, self-loop HOME et HOME égal à OK d'un seul coup. Le validateur
    // historique refuse ces trois formes ; l'intégrité abstraite ne les hérite pas.
    let raw = document(
        &format!(
            r#"{{"uuid":"entry","squareOne":true,"audio":null,"image":null,
                 "controlSettings":{CONTROLS},
                 "okTransition":{{"actionNode":"loop","optionIndex":0}},
                 "homeTransition":{{"actionNode":"loop","optionIndex":0}}}}"#
        ),
        &action("loop", r#""entry""#),
    );
    assert_valid(&raw);

    let document = decode(&raw);
    assert!(
        crate::native_pack::validate_document_for_studio_compat(&document).is_err(),
        "le validateur historique doit toujours refuser cette forme : c'est ce qui \
         rend la démonstration d'indépendance concluante"
    );
}

#[test]
fn gvi_012_accepts_a_shared_action_node_with_converging_parents() {
    let middle = format!(
        r#"{{"uuid":"middle","audio":null,"image":null,"controlSettings":{CONTROLS},
             "okTransition":{{"actionNode":"shared","optionIndex":0}},
             "homeTransition":null}}"#
    );
    let raw = document(
        &format!(
            "{},{},{}",
            entry_stage("entry", r#"{"actionNode":"shared","optionIndex":0}"#),
            middle,
            plain_stage("target")
        ),
        &action("shared", r#""target""#),
    );
    assert_valid(&raw);
}

#[test]
fn gvi_013_accepts_a_stage_without_image_or_audio() {
    // Un Stage sans média est livrable. `null` et absence sont deux
    // formes distinctes, et aucune n'est une erreur d'intégrité.
    let raw = document(
        &format!(
            r#"{{"uuid":"entry","squareOne":true,"controlSettings":{CONTROLS},
                 "okTransition":{{"actionNode":"choice","optionIndex":0}},
                 "homeTransition":null}},
               {{"uuid":"left","audio":null,"image":null,"controlSettings":{CONTROLS},
                 "okTransition":null,"homeTransition":null}}"#
        ),
        &action("choice", r#""left""#),
    );
    let document = decode(&raw);
    assert!(document.stage_nodes[0].audio.is_absent());
    assert!(matches!(document.stage_nodes[1].audio, Presence::Null));
    assert_eq!(validate_graph_document_integrity(&document), Ok(()));
}

#[test]
fn no_maximum_option_count_enters_integrity() {
    // Une roue de 101 options est `UNTESTED`, pas `INVALID`.
    let targets: Vec<String> = (0..101)
        .map(|index| plain_stage(&format!("t{index}")))
        .collect();
    let options: Vec<String> = (0..101).map(|index| format!(r#""t{index}""#)).collect();
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"wide","optionIndex":100}"#),
            targets.join(",")
        ),
        &action("wide", &options.join(",")),
    );
    assert_valid(&raw);
}

#[test]
fn every_error_is_reported_rather_than_only_the_first() {
    let raw = document(
        &format!("{},{}", plain_stage("a"), plain_stage("a")),
        &action("choice", r#""ghost",null"#),
    );
    let codes = integrity_codes(&decode(&raw));
    for expected in [
        GraphIntegrityCode::DuplicateStageId,
        GraphIntegrityCode::SquareOneCount,
        GraphIntegrityCode::OptionTargetNull,
        GraphIntegrityCode::OptionTargetMissing,
    ] {
        assert!(
            codes.contains(&expected),
            "{expected:?} manquant dans {codes:?}"
        );
    }
}

#[test]
fn an_error_names_the_node_by_its_stable_author_path() {
    let raw = document(
        &format!(
            "{},{}",
            entry_stage("entry", r#"{"actionNode":"choice","optionIndex":0}"#),
            plain_stage("entry")
        ),
        &action("choice", r#""entry""#),
    );
    let errors = validate_graph_document_integrity(&decode(&raw)).expect_err("doublon");
    let duplicate = errors
        .iter()
        .find(|error| error.code == GraphIntegrityCode::DuplicateStageId)
        .expect("doublon signalé");
    // L'ancre porte l'occurrence : c'est le second `entry` qui est désigné.
    assert_eq!(duplicate.path, "/stageNodes/@uuid=entry#1/uuid");
}

// ---------------------------------------------------------------------------
// La sentinelle `Random` traverse le document sans être rabattue.
// ---------------------------------------------------------------------------

fn selection_of(document: &StoryDocument, stage: usize, home: bool) -> OptionSelection {
    let stage = &document.stage_nodes[stage];
    let transition = if home {
        stage.home_transition.value()
    } else {
        stage.ok_transition.value()
    };
    transition.expect("transition présente").selection
}

#[test]
fn the_random_sentinel_survives_a_document_roundtrip_on_ok_and_on_home() {
    let raw = document(
        &format!(
            r#"{{"uuid":"entry","squareOne":true,"audio":null,"image":null,
                 "controlSettings":{CONTROLS},
                 "okTransition":{{"actionNode":"choice","optionIndex":-1}},
                 "homeTransition":{{"actionNode":"choice","optionIndex":-1}}}},{}"#,
            plain_stage("left")
        ),
        &action("choice", r#""left""#),
    );
    let decoded = decode(&raw);
    assert_eq!(selection_of(&decoded, 0, false), OptionSelection::Random);
    assert_eq!(selection_of(&decoded, 0, true), OptionSelection::Random);

    let reemitted = serde_json::to_value(&decoded).expect("réémission");
    for field in ["okTransition", "homeTransition"] {
        assert_eq!(
            reemitted["stageNodes"][0][field]["optionIndex"],
            serde_json::json!(-1),
            "{field} doit ressortir exactement à -1"
        );
    }

    let reread: StoryDocument = serde_json::from_value(reemitted).expect("relecture");
    assert_eq!(selection_of(&reread, 0, false), OptionSelection::Random);
    assert_eq!(selection_of(&reread, 0, true), OptionSelection::Random);
}

#[test]
fn a_random_document_and_a_fixed_zero_document_never_become_equal() {
    let with = |index: &str| {
        document(
            &format!(
                "{},{},{}",
                entry_stage(
                    "entry",
                    &format!(r#"{{"actionNode":"choice","optionIndex":{index}}}"#)
                ),
                plain_stage("left"),
                plain_stage("right")
            ),
            &action("choice", r#""left","right""#),
        )
    };
    let random = decode(&with("-1"));
    let fixed = decode(&with("0"));

    // Les deux documents sont valides, mais ils ne sont pas le même document.
    assert_eq!(validate_graph_document_integrity(&random), Ok(()));
    assert_eq!(validate_graph_document_integrity(&fixed), Ok(()));
    assert_ne!(
        selection_of(&random, 0, false),
        selection_of(&fixed, 0, false)
    );
    assert_ne!(
        serde_json::to_value(&random).expect("random"),
        serde_json::to_value(&fixed).expect("fixed")
    );
}

// ---------------------------------------------------------------------------
// Banc local : les 366 `story.json` matérialisés de la bibliothèque privée.
// Corpus privé, ignoré par Git.
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntegrityLibraryRecord {
    library_index: u32,
    relative_path: String,
    source_format: String,
    story_json_path: Option<String>,
}

#[test]
#[ignore = "campagne locale : non-régression de l'intégrité sur les story.json privés"]
fn d1_b1_no_real_document_is_rejected_by_graph_integrity() {
    use std::fs;
    use std::path::Path;

    let index_path =
        std::env::var("STORY_STUDIO_D1_B1_LIBRARY").expect("STORY_STUDIO_D1_B1_LIBRARY requis");
    let output_path =
        std::env::var("STORY_STUDIO_D1_B1_OUTPUT").expect("STORY_STUDIO_D1_B1_OUTPUT requis");
    let content = fs::read_to_string(Path::new(&index_path)).expect("index de bibliothèque");
    let library: Vec<IntegrityLibraryRecord> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("JSONL de bibliothèque"))
        .collect();

    let mut scanned = 0_usize;
    let mut undecodable = Vec::new();
    let mut invalid = Vec::new();
    let mut by_code: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut by_format: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut random_selection_count = 0_usize;
    let mut random_packs = 0_usize;
    let mut transition_count = 0_usize;

    for record in &library {
        let Some(story_json_path) = record.story_json_path.as_ref() else {
            continue;
        };
        let raw = fs::read_to_string(story_json_path).expect("story.json matérialisé");
        scanned += 1;
        let format_entry = by_format
            .entry(record.source_format.clone())
            .or_insert((0, 0));
        format_entry.0 += 1;

        let decoded = match decode_story_document(&raw) {
            Ok(decoded) => decoded,
            Err(error) => {
                undecodable.push(serde_json::json!({
                    "libraryIndex": record.library_index,
                    "relativePath": record.relative_path,
                    "diagnostics": error.diagnostics,
                }));
                continue;
            }
        };

        let mut pack_random = 0_usize;
        for stage in &decoded.document.stage_nodes {
            for transition in [stage.ok_transition.value(), stage.home_transition.value()]
                .into_iter()
                .flatten()
            {
                transition_count += 1;
                if transition.selection == OptionSelection::Random {
                    pack_random += 1;
                }
            }
        }
        random_selection_count += pack_random;
        if pack_random > 0 {
            random_packs += 1;
        }

        if let Err(errors) = validate_graph_document_integrity(&decoded.document) {
            format_entry.1 += 1;
            for error in &errors {
                *by_code.entry(error.code.as_str()).or_default() += 1;
            }
            invalid.push(serde_json::json!({
                "libraryIndex": record.library_index,
                "relativePath": record.relative_path,
                "sourceFormat": record.source_format,
                "errors": errors,
            }));
        }
    }

    let report = serde_json::json!({
        "documentsScanned": scanned,
        "undecodableDocuments": undecodable.len(),
        "invalidDocuments": invalid.len(),
        "transitionsInspected": transition_count,
        "randomSelections": random_selection_count,
        "packsWithRandomSelection": random_packs,
        "violationsByCode": by_code,
        "bySourceFormat": by_format
            .iter()
            .map(|(format, (documents, invalid))| {
                serde_json::json!({
                    "sourceFormat": format,
                    "documents": documents,
                    "invalidDocuments": invalid,
                })
            })
            .collect::<Vec<_>>(),
        "undecodable": undecodable,
        "invalid": invalid,
    });
    fs::write(
        Path::new(&output_path),
        serde_json::to_string_pretty(&report).expect("rapport sérialisable"),
    )
    .expect("écriture du rapport");

    assert!(scanned > 0, "aucun story.json matérialisé n'a été lu");
    assert!(
        undecodable.is_empty(),
        "{} document(s) indécodable(s) : {}",
        undecodable.len(),
        output_path
    );
    assert!(
        invalid.is_empty(),
        "aucun document invalide attendu, {} trouvé(s) : {}",
        invalid.len(),
        output_path
    );
}
