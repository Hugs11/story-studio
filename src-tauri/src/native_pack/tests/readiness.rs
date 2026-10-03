//! Tests de `assess_graph_document_export_readiness`.
//!
//! L'ordre suit celui du catalogue : composition, absence de faux
//! `SUPPORTED`, lignes `INVALID`, lignes `—`, lignes inapplicables, couverture
//! ligne à ligne du catalogue de readiness, puis raccord avec la préparation.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::super::authoring::set_position_export_disposition;
use super::super::preparation::{prepare_graph_document_for_export, ExportPreparationError};
use super::super::readiness::*;
use super::*;

const ENTRY_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECOND_ID: &str = "123e4567-e89b-12d3-a456-426614174000";
const HYPHENLESS_ID: &str = "123E4567E89B12D3A456426614174001";
const THIRD_ID: &str = "cccccccc-dddd-4eee-8fff-000000000000";

fn complete_controls() -> Value {
    json!({"wheel": false, "ok": true, "home": false, "pause": false, "autoplay": false})
}

fn stage(id: &str, square_one: bool) -> Value {
    json!({
        "uuid": id,
        "squareOne": square_one,
        "audio": null,
        "image": null,
        "controlSettings": complete_controls(),
        "okTransition": null,
        "homeTransition": null
    })
}

fn ok_to(action: &str, option_index: i64) -> Value {
    json!({"actionNode": action, "optionIndex": option_index})
}

/// Un document sain : cycle et ActionNode partagé, identifiants canoniques,
/// contrôles complets, aucune extension, aucune position. Toutes ses lignes
/// applicables du catalogue sont `SUPPORTED`. Le cycle passe par deux Écrans
/// hors de l'entrée, qui n'est jamais un choix (`port_rules`).
fn nominal() -> Value {
    let mut entry = stage(ENTRY_ID, true);
    entry["okTransition"] = ok_to("menu", 0);
    let mut second = stage(SECOND_ID, false);
    second["okTransition"] = ok_to("menu", 1);
    let mut third = stage(THIRD_ID, false);
    third["okTransition"] = ok_to("menu", 0);
    json!({
        "format": "v1",
        "version": 1,
        "stageNodes": [entry, second, third],
        "actionNodes": [{"id": "menu", "options": [SECOND_ID, THIRD_ID]}]
    })
}

fn decode(value: &Value) -> DecodedStoryDocument {
    decode_story_document(&value.to_string()).expect("payload décodable")
}

fn assess(value: &Value) -> ExportReadiness {
    assess_graph_document_export_readiness(Ok(&decode(value)))
}

fn qualification(readiness: &ExportReadiness, id: DimensionId) -> Option<DimensionQualification> {
    readiness
        .dimensions
        .iter()
        .find(|dimension| dimension.id == id)
        .map(|dimension| dimension.qualification)
}

fn exercised_lines(readiness: &ExportReadiness) -> BTreeSet<ContractLine> {
    readiness
        .dimensions
        .iter()
        .flat_map(|dimension| dimension.evidence.iter().map(|evidence| evidence.line))
        .collect()
}

fn has_diagnostic(readiness: &ExportReadiness, code: &str) -> bool {
    readiness
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code() == code)
}

fn unevaluated_ids(readiness: &ExportReadiness) -> BTreeSet<DimensionId> {
    readiness
        .unevaluated
        .iter()
        .map(|dimension| dimension.id)
        .collect()
}

// ---------------------------------------------------------------- composition

#[test]
fn the_three_qualifications_compose_from_weakest_to_strongest() {
    use DimensionQualification::{Prepared, Supported, Untested};
    assert!(Untested < Prepared && Prepared < Supported);
    assert_eq!(
        [Supported, Untested, Prepared].into_iter().min(),
        Some(Untested)
    );
    assert_eq!([Supported, Prepared].into_iter().min(), Some(Prepared));
    assert_eq!([Supported].into_iter().min(), Some(Supported));
}

#[test]
fn a_nominal_document_is_supported_and_explains_every_qualification() {
    let readiness = assess(&nominal());

    assert!(!readiness.blocked);
    assert!(readiness.unevaluated.is_empty());
    assert_eq!(
        readiness.interoperability,
        DimensionQualification::Supported
    );
    assert!(!readiness.dimensions.is_empty());

    for dimension in &readiness.dimensions {
        // Aucune qualification sans preuve, et jamais au-dessus de la plus
        // faible de ses lignes : la sortie est explicable ligne à ligne.
        assert!(
            !dimension.evidence.is_empty(),
            "{:?} sans preuve",
            dimension.id
        );
        assert_eq!(
            dimension.qualification,
            dimension
                .evidence
                .iter()
                .map(|evidence| evidence.qualification)
                .min()
                .expect("au moins une preuve")
        );
        for evidence in &dimension.evidence {
            assert!(dimension.id.lines().any(|line| line == evidence.line));
            assert_eq!(evidence.contract_row, evidence.line.row());
            assert!(!evidence.proof.is_empty());
        }
    }
}

#[test]
fn an_unevaluated_dimension_caps_the_aggregate_at_untested() {
    // Identité d'entrée non bridge-compatible : la préparation n'est pas qualifiable
    // tant que l'identité stable n'a pas été générée et persistée.
    let mut source = nominal();
    source["stageNodes"][0]["uuid"] = json!("entry-stage");
    let readiness = assess(&source);

    assert!(unevaluated_ids(&readiness).contains(&DimensionId::PackIdentity));
    assert_eq!(
        qualification(&readiness, DimensionId::StageIdGraphie),
        Some(DimensionQualification::Prepared)
    );
    // La plus faible dimension évaluée vaut `PREPARED` ; l'entrée `unevaluated`
    // plafonne malgré tout l'agrégat.
    assert_eq!(readiness.interoperability, DimensionQualification::Untested);
    assert!(
        !readiness.blocked,
        "une dimension non évaluée ne bloque pas"
    );
}

#[test]
fn an_empty_explanation_never_justifies_a_qualification() {
    let readiness = assess_graph_document_export_readiness(Err(&StoryDecodeError {
        diagnostics: Vec::new(),
    }));
    assert!(readiness.dimensions.is_empty());
    assert_eq!(readiness.interoperability, DimensionQualification::Untested);
}

// ------------------------------------------------ blocage et séparation des couches

#[test]
fn an_orphan_action_blocks_while_its_runtime_dimensions_stay_supported() {
    // Les deux passerelles acceptent le document puis relisent 4 Actions
    // sur 6. La navigation runtime reste qualifiée ; la perte authored bloque.
    let mut source = nominal();
    source["actionNodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "orpheline", "name": "Chapitre coupé", "options": [SECOND_ID]}));
    let readiness = assess(&source);

    assert!(readiness.blocked);
    assert!(has_diagnostic(&readiness, "ORPHAN_ACTION_AUTHORED_CONTENT"));
    assert_eq!(
        qualification(&readiness, DimensionId::GraphTopology),
        Some(DimensionQualification::Supported)
    );
    assert_eq!(
        qualification(&readiness, DimensionId::ReachabilityAndControlProfiles),
        Some(DimensionQualification::Supported)
    );
    // Ligne `—` : elle bloque, elle ne descend pas dans l'agrégat.
    assert!(!exercised_lines(&readiness).contains(&ContractLine::OrphanActionWithAuthoredContent));
    assert_eq!(
        readiness.interoperability,
        DimensionQualification::Supported
    );
}

#[test]
fn warnings_and_infos_never_block() {
    let mut source = nominal();
    // Ligne 31 : scaffold strictement vide, `INFO`.
    source["actionNodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "scaffold", "options": []}));
    // Ligne 22 : position source fractionnaire, conservée sans diagnostic.
    source["stageNodes"][0]["position"] = json!({"x": 12.5, "y": -3.25});
    let readiness = assess(&source);

    assert!(!readiness.blocked);
    assert!(has_diagnostic(&readiness, "ORPHAN_ACTION_EMPTY_SCAFFOLD"));
    assert!(!has_diagnostic(&readiness, "POSITION_FRACTIONAL"));
    assert!(readiness
        .diagnostics
        .iter()
        .all(|diagnostic| !diagnostic.blocks()));
    assert_eq!(
        qualification(&readiness, DimensionId::FractionalPosition),
        Some(DimensionQualification::Supported)
    );
    // Ligne `—` : le scaffold vide n'entre pas dans l'agrégat.
    assert!(!exercised_lines(&readiness).contains(&ContractLine::EmptyOrphanScaffold));
}

#[test]
fn positions_out_of_short_range_are_preserved_without_blocking() {
    let mut source = nominal();
    source["stageNodes"][0]["position"] = json!({"x": 40_000, "y": 0});
    let mut payload = decode(&source);
    let path = format!("/stageNodes/@uuid={ENTRY_ID}#0/position");
    payload.context.value_provenance.push(ValueProvenance {
        path,
        origin: ValueOrigin::Authored,
    });
    let readiness = assess_graph_document_export_readiness(Ok(&payload));

    assert!(!readiness.blocked);
    assert!(!has_diagnostic(
        &readiness,
        "POSITION_OUT_OF_RANGE_ACTION_REQUIRED"
    ));
    assert!(!has_diagnostic(&readiness, "POSITION_DISPOSITION_STALE"));
    // Les positions restent des valeurs d'auteur, quelle que soit leur
    // provenance ; aucune ligne de fidélité ne devient une correction.
    let lines = exercised_lines(&readiness);
    assert!(!lines.contains(&ContractLine::AuthoredPositionOutOfShortRange));
    assert!(!lines.contains(&ContractLine::SourcePositionOutOfShortRange));
    assert_eq!(
        qualification(&readiness, DimensionId::SourcePositionOutOfShortRange),
        None
    );
}

// --------------------------------------------------- lignes INVALID et refus

#[test]
fn a_document_refused_at_decoding_qualifies_nothing() {
    // Ligne 4 : `optionIndex < -1`, hors du modèle `OptionSelection`.
    let mut source = nominal();
    source["stageNodes"][0]["okTransition"] = ok_to("menu", -2);
    let error = decode_story_document(&source.to_string()).expect_err("refus de dialecte");
    let readiness = assess_graph_document_export_readiness(Err(&error));

    assert!(readiness.blocked);
    assert!(readiness.dimensions.is_empty());
    assert_eq!(readiness.interoperability, DimensionQualification::Untested);
    assert_eq!(unevaluated_ids(&readiness).len(), DimensionId::ALL.len());
    // Les diagnostics de décodage restent accessibles avec leur provenance.
    assert!(readiness.decode_diagnostics().next().is_some());
}

#[test]
fn the_other_two_decode_refusals_are_also_refusals_and_not_qualifications() {
    // Ligne 5 : transition sans `optionIndex`.
    let mut incomplete = nominal();
    incomplete["stageNodes"][0]["okTransition"] = json!({"actionNode": "menu"});
    // Ligne 12 : membre de contrôle non booléen.
    let mut malformed = nominal();
    malformed["stageNodes"][0]["controlSettings"]["ok"] = json!(1);

    for source in [incomplete, malformed] {
        let error = decode_story_document(&source.to_string()).expect_err("refus de dialecte");
        let readiness = assess_graph_document_export_readiness(Err(&error));
        assert!(readiness.blocked);
        assert!(readiness.dimensions.is_empty());
        assert_eq!(readiness.interoperability, DimensionQualification::Untested);
    }
}

#[test]
fn a_graph_integrity_failure_qualifies_nothing() {
    // Ligne 29 : référence pendante. Ligne 6 : sélection insatisfiable.
    let mut dangling = nominal();
    dangling["actionNodes"][0]["options"][0] = json!("absent-stage");
    let mut unsatisfiable = nominal();
    unsatisfiable["stageNodes"][0]["okTransition"] = ok_to("menu", 7);

    for source in [dangling, unsatisfiable] {
        let readiness = assess(&source);
        assert!(readiness.blocked);
        assert!(readiness.dimensions.is_empty());
        assert_eq!(readiness.interoperability, DimensionQualification::Untested);
        assert_eq!(unevaluated_ids(&readiness).len(), DimensionId::ALL.len());
        assert!(readiness.integrity_errors().next().is_some());
    }
}

// ------------------------------------------------------- lignes inapplicables

#[test]
fn an_inapplicable_line_is_not_an_unevaluated_dimension() {
    // Un document sans topologie remarquable, sans position et sans extension :
    // ces lignes ne s'appliquent pas, et l'agrégat n'en souffre pas.
    let mut entry = stage(ENTRY_ID, true);
    entry["okTransition"] = ok_to("menu", 0);
    let source = json!({
        "format": "v1",
        "version": 1,
        "stageNodes": [entry, stage(SECOND_ID, false)],
        "actionNodes": [{"id": "menu", "options": [SECOND_ID]}]
    });
    let readiness = assess(&source);

    assert!(readiness.unevaluated.is_empty());
    assert_eq!(qualification(&readiness, DimensionId::GraphTopology), None);
    assert_eq!(
        qualification(&readiness, DimensionId::FractionalPosition),
        None
    );
    assert_eq!(
        qualification(&readiness, DimensionId::UnknownExtension),
        None
    );
    assert_eq!(
        readiness.interoperability,
        DimensionQualification::Supported
    );
}

// -------------------------------- couverture ligne à ligne du catalogue

#[test]
fn the_contract_catalogue_is_complete_and_unambiguous() {
    let all = ContractLine::ALL;
    assert_eq!(all.len(), 31, "le catalogue compte 31 lignes de données");
    assert_eq!(all.iter().collect::<BTreeSet<_>>().len(), 31);
    for (index, line) in all.into_iter().enumerate() {
        assert_eq!(line.row(), index + 1);
        assert!(!line.label().is_empty());
        assert!(!line.proof().is_empty());
    }

    // Chaque ligne de dimension porte une qualification écrite ;
    // aucune autre ligne n'en porte, `INVALID` n'étant pas une qualification.
    let dimension_lines = DimensionId::ALL
        .into_iter()
        .flat_map(DimensionId::lines)
        .collect::<BTreeSet<_>>();
    assert_eq!(dimension_lines.len(), 23);
    for line in all {
        assert_eq!(
            line.contract_qualification().is_some(),
            dimension_lines.contains(&line),
            "ligne {} mal classée",
            line.row()
        );
    }

    // Les huit lignes restantes sont exactement les refus et les lignes `—`.
    let remainder = all
        .into_iter()
        .filter(|line| !dimension_lines.contains(line))
        .collect::<BTreeSet<_>>();
    assert_eq!(
        remainder,
        BTreeSet::from([
            ContractLine::OptionIndexBelowMinusOne,
            ContractLine::IncompleteTransition,
            ContractLine::UnsatisfiableSelection,
            ContractLine::MalformedControlSettings,
            ContractLine::AuthoredPositionOutOfShortRange,
            ContractLine::DanglingReferenceOrSquareOneCount,
            ContractLine::OrphanActionWithAuthoredContent,
            ContractLine::EmptyOrphanScaffold,
        ])
    );
}

/// Les six payloads qui, ensemble, exercent les 23 lignes de dimension.
fn coverage_fixtures() -> Vec<(&'static str, DecodedStoryDocument)> {
    // Graphies, roue large, sélection Random, entrée déplacée.
    let mut graphies = nominal();
    graphies["stageNodes"][1]["uuid"] = json!(HYPHENLESS_ID);
    graphies["stageNodes"][1]["squareOne"] = json!(true);
    graphies["stageNodes"][0]["squareOne"] = json!(false);
    graphies["stageNodes"][1]["okTransition"] = ok_to("large", -1);
    // L'ancienne entrée n'est plus qu'un Écran : elle peut être un choix, la
    // nouvelle non (`port_rules`), et personne ne revient sur soi-même.
    graphies["stageNodes"][0]["okTransition"] = ok_to("menu", 1);
    let mut wide = vec![Value::String(ENTRY_ID.to_string())];
    for index in 0..101u32 {
        let uuid = format!("{index:08x}-0000-4000-8000-000000000000");
        graphies["stageNodes"].as_array_mut().unwrap().push({
            let mut terminal = stage(&uuid, false);
            terminal["controlSettings"]["ok"] = json!(false);
            terminal["controlSettings"]["home"] = json!(true);
            terminal
        });
        wide.push(Value::String(uuid));
    }
    graphies["stageNodes"].as_array_mut().unwrap().push({
        let mut terminal = stage("texte-non-parsable", false);
        terminal["controlSettings"]["ok"] = json!(false);
        terminal["controlSettings"]["home"] = json!(true);
        terminal
    });
    graphies["actionNodes"][0]["options"] = json!([ENTRY_ID, THIRD_ID, "texte-non-parsable"]);
    graphies["actionNodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "large", "options": wide}));

    // Racine : uuid divergente, factoryDisabled, doublon de clé racine.
    let root = format!(
        r#"{{"format":"v1","version":1,"title":"un","title":"deux","uuid":"{SECOND_ID}","factoryDisabled":true,
            "stageNodes":[{},{}],"actionNodes":[{{"id":"menu","options":["{THIRD_ID}"]}}]}}"#,
        {
            let mut entry = stage(ENTRY_ID, true);
            entry["okTransition"] = ok_to("menu", 0);
            entry.to_string()
        },
        {
            let mut terminal = stage(THIRD_ID, false);
            terminal["controlSettings"]["ok"] = json!(false);
            terminal["controlSettings"]["home"] = json!(true);
            terminal
        }
    );

    // Enrichis et extension inconnue.
    let mut enriched = nominal();
    enriched["stageNodes"][0]["groupId"] = json!("groupe-1");
    enriched["actionNodes"][0]["type"] = json!("story.storyaction");
    enriched["actionNodes"][0]["groupId"] = json!("groupe-1");
    enriched["storyStudioMetadata"] = json!({"auteur": "tiers"});

    // Positions source : fractionnaire et hors short.
    let mut positions = nominal();
    positions["stageNodes"][0]["position"] = json!({"x": 12.5, "y": 4.0});
    positions["stageNodes"][1]["position"] = json!({"x": 40_000, "y": 12});

    // Contrôles incomplets conservés à l'entrée.
    let mut controls = nominal();
    controls["stageNodes"][1]["controlSettings"] = json!({"wheel": false, "ok": true});

    // Projection FS : identité projetée et version 256 little-endian.
    let mut fs_source = nominal();
    fs_source["version"] = json!(256);
    let mut fs = decode(&fs_source);
    fs.context = StoryDocumentContext::imported_fs(&fs.document, ENTRY_ID);

    vec![
        ("nominal", decode(&nominal())),
        ("graphies", decode(&graphies)),
        ("racine", decode_story_document(&root).expect("racine")),
        ("enrichis", decode(&enriched)),
        ("positions", decode(&positions)),
        ("contrôles", decode(&controls)),
        ("projection-fs", fs),
    ]
}

#[test]
fn every_qualifiable_line_of_the_matrix_is_exercised_by_a_real_payload() {
    let mut covered = BTreeSet::new();
    for (name, payload) in coverage_fixtures() {
        let readiness = assess_graph_document_export_readiness(Ok(&payload));
        assert!(
            readiness
                .dimensions
                .iter()
                .all(|dimension| !dimension.evidence.is_empty()),
            "{name} produit une dimension sans preuve"
        );
        covered.extend(exercised_lines(&readiness));
    }

    let expected = DimensionId::ALL
        .into_iter()
        .flat_map(DimensionId::lines)
        .collect::<BTreeSet<_>>();
    let missing = expected.difference(&covered).collect::<Vec<_>>();
    assert!(
        missing.is_empty(),
        "lignes du catalogue jamais exercées : {:?}",
        missing
            .iter()
            .map(|line| (line.row(), line.label()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn the_projected_fs_lines_carry_their_measured_qualifications() {
    let (_, payload) = coverage_fixtures()
        .into_iter()
        .find(|(name, _)| *name == "projection-fs")
        .expect("fixture FS");
    let readiness = assess_graph_document_export_readiness(Ok(&payload));

    assert_eq!(
        qualification(&readiness, DimensionId::PackIdentity),
        Some(DimensionQualification::Prepared)
    );
    assert_eq!(
        qualification(&readiness, DimensionId::StudioExportVersion),
        Some(DimensionQualification::Untested)
    );
    // Une seule ligne `UNTESTED` suffit à empêcher un agrégat `SUPPORTED`.
    assert_eq!(readiness.interoperability, DimensionQualification::Untested);
}

#[test]
fn a_wheel_beyond_the_measured_width_is_untested_without_blocking() {
    let (_, payload) = coverage_fixtures()
        .into_iter()
        .find(|(name, _)| *name == "graphies")
        .expect("fixture graphies");
    let readiness = assess_graph_document_export_readiness(Ok(&payload));

    assert_eq!(
        qualification(&readiness, DimensionId::WheelWidth),
        Some(DimensionQualification::Untested)
    );
    assert!(!readiness.blocked, "la seule nouveauté ne bloque pas");
    let lines = exercised_lines(&readiness);
    assert!(lines.contains(&ContractLine::WheelUpToOneHundred));
    assert!(lines.contains(&ContractLine::WheelBeyondOneHundred));
}

#[test]
fn a_divergent_root_uuid_stays_supported_with_its_provenance_warning() {
    let (_, payload) = coverage_fixtures()
        .into_iter()
        .find(|(name, _)| *name == "racine")
        .expect("fixture racine");
    let readiness = assess_graph_document_export_readiness(Ok(&payload));

    assert_eq!(
        qualification(&readiness, DimensionId::RootUuidProvenance),
        Some(DimensionQualification::Supported)
    );
    assert!(has_diagnostic(&readiness, "ROOT_UUID_DIVERGENT"));
    assert!(has_diagnostic(&readiness, "duplicate-root-key-last-wins"));
    assert_eq!(
        qualification(&readiness, DimensionId::KnownRootDuplicate),
        Some(DimensionQualification::Untested)
    );
    assert_eq!(
        qualification(&readiness, DimensionId::FactoryDisabled),
        Some(DimensionQualification::Untested)
    );
    assert!(!readiness.blocked);
}

#[test]
fn enriched_markers_stay_untested_even_though_the_author_cycle_preserves_them() {
    let (_, payload) = coverage_fixtures()
        .into_iter()
        .find(|(name, _)| *name == "enrichis")
        .expect("fixture enrichis");
    let readiness = assess_graph_document_export_readiness(Ok(&payload));

    // La conservation prouvée est locale : aucune fixture n'a fait
    // traverser un groupe enrichi aux deux passerelles figées.
    assert_eq!(
        qualification(&readiness, DimensionId::EnrichedGroupFidelity),
        Some(DimensionQualification::Untested)
    );
    assert_eq!(
        qualification(&readiness, DimensionId::UnknownExtension),
        Some(DimensionQualification::Untested)
    );
    assert_eq!(readiness.interoperability, DimensionQualification::Untested);
}

// ------------------------------------------- raccord avec la préparation

#[test]
fn preparation_refuses_exactly_what_readiness_blocks() {
    let mut dangling = nominal();
    dangling["actionNodes"][0]["options"][0] = json!("absent-stage");
    let mut orphan = nominal();
    orphan["actionNodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "orpheline", "name": "Chapitre coupé", "options": [SECOND_ID]}));

    let dangling = decode(&dangling);
    assert!(assess_graph_document_export_readiness(Ok(&dangling)).blocked);
    assert!(matches!(
        prepare_graph_document_for_export(&dangling),
        Err(ExportPreparationError::GraphIntegrity { .. })
    ));

    let orphan = decode(&orphan);
    assert!(assess_graph_document_export_readiness(Ok(&orphan)).blocked);
    assert!(matches!(
        prepare_graph_document_for_export(&orphan),
        Err(ExportPreparationError::AuthoringActionRequired { .. })
    ));

    // Le cas nominal traverse : la readiness n'est pas un refus par défaut.
    let nominal = decode(&nominal());
    assert!(!assess_graph_document_export_readiness(Ok(&nominal)).blocked);
    assert!(prepare_graph_document_for_export(&nominal).is_ok());
}

#[test]
fn preparation_fits_out_of_range_positions_even_after_a_disposition_becomes_stale() {
    let mut source = nominal();
    source["stageNodes"][1]["position"] = json!({"x": 40_000, "y": 12});
    let mut payload = decode(&source);
    let path = format!("/stageNodes/@uuid={SECOND_ID}#0/position");

    // 1. Position source hors short sans disposition : elle reste exportable,
    //    et la copie la ramène en silence dans l'intervalle.
    assert!(!assess_graph_document_export_readiness(Ok(&payload)).blocked);
    let prepared = prepare_graph_document_for_export(&payload).expect("position ramenée");
    assert_eq!(
        prepared.document.stage_nodes[1]
            .position
            .value()
            .and_then(|position| position.x.as_f64()),
        Some(32_767.0)
    );

    // 2. Disposition explicite : la readiness débloque, la préparation passe,
    //    mais la dimension reste `UNTESTED` et l'agrégat avec elle.
    set_position_export_disposition(
        &mut payload,
        &path,
        PositionExportDisposition::OmitExplicitly,
    )
    .expect("disposition acceptée");
    let readiness = assess_graph_document_export_readiness(Ok(&payload));
    assert!(!readiness.blocked);
    assert_eq!(
        qualification(&readiness, DimensionId::SourcePositionOutOfShortRange),
        Some(DimensionQualification::Untested)
    );
    assert_eq!(readiness.interoperability, DimensionQualification::Untested);
    assert!(prepare_graph_document_for_export(&payload).is_ok());

    // 3. L'auteur déplace la position : la décision périmée est ignorée et la
    //    nouvelle valeur est, elle aussi, ramenée dans l'intervalle.
    payload.document.stage_nodes[1].position = Presence::Value(Position {
        x: serde_json::Number::from(45_000),
        y: serde_json::Number::from(12),
    });
    let readiness = assess_graph_document_export_readiness(Ok(&payload));
    assert!(!readiness.blocked);
    assert!(!has_diagnostic(&readiness, "POSITION_DISPOSITION_STALE"));
    let prepared = prepare_graph_document_for_export(&payload).expect("nouvelle position ramenée");
    assert_eq!(
        prepared.document.stage_nodes[1]
            .position
            .value()
            .and_then(|position| position.x.as_f64()),
        Some(32_767.0)
    );
    assert_eq!(
        payload.document.stage_nodes[1]
            .position
            .value()
            .and_then(|position| position.x.as_f64()),
        Some(45_000.0),
        "le document garde sa valeur"
    );
}

#[test]
fn readiness_never_mutates_the_author_payload() {
    for (name, payload) in coverage_fixtures() {
        let before = payload.clone();
        let _ = assess_graph_document_export_readiness(Ok(&payload));
        assert_eq!(payload.document, before.document, "{name} : document muté");
        assert_eq!(payload.context, before.context, "{name} : contexte muté");
    }
}
