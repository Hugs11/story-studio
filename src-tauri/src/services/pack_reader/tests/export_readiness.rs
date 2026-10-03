//! Banc de mesure de `assess_graph_document_export_readiness` sur le corpus privé.
//!
//! Les tests ordinaires de la readiness sont autonomes et vivent avec le module
//! (`native_pack/tests/readiness.rs`). Ce banc mesure l'invariant qui
//! compte sur des documents réels : **aucune sortie n'annonce `SUPPORTED`
//! lorsqu'une dimension pertinente est inconnue**, et toute qualification reste
//! adossée à une ligne de contrat (`ContractLine`).
//!
//! Le corpus reste local et ignoré par Git ; le banc est donc `#[ignore]`
//! et déclenché explicitement, comme les autres bancs locaux de ce dossier.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::native_pack::decode_story_document;
use crate::native_pack::readiness::{
    assess_graph_document_export_readiness, ContractLine, DimensionId, DimensionQualification,
    ExportReadiness,
};

/// Contrôle l'invariant central de la readiness sur une qualification produite.
fn assert_no_false_supported(readiness: &ExportReadiness, label: &str) {
    if !readiness.unevaluated.is_empty() {
        assert_eq!(
            readiness.interoperability,
            DimensionQualification::Untested,
            "{label} : {} dimension(s) non évaluée(s) et pourtant un agrégat {:?}",
            readiness.unevaluated.len(),
            readiness.interoperability
        );
    }
    if readiness.dimensions.is_empty() {
        assert_eq!(
            readiness.interoperability,
            DimensionQualification::Untested,
            "{label} : agrégat sans aucune dimension pour l'expliquer"
        );
    }
    for dimension in &readiness.dimensions {
        assert!(
            !dimension.evidence.is_empty(),
            "{label} : {:?} qualifiée sans preuve",
            dimension.id
        );
        assert_eq!(
            dimension.qualification,
            dimension
                .evidence
                .iter()
                .map(|evidence| evidence.qualification)
                .min()
                .expect("au moins une preuve"),
            "{label} : {:?} au-dessus de ses lignes",
            dimension.id
        );
        for evidence in &dimension.evidence {
            assert!(
                dimension.id.lines().any(|line| line == evidence.line),
                "{label} : preuve hors mapping pour {:?}",
                dimension.id
            );
        }
        assert!(
            readiness.interoperability.le(&dimension.qualification)
                || !readiness.unevaluated.is_empty(),
            "{label} : agrégat au-dessus d'une de ses dimensions"
        );
    }
}

/// Mesure locale de non-régression sur les 366 `story.json` privés.
#[test]
#[ignore = "requires STORY_STUDIO_C1_CORPUS_DIR with the private 08b corpus"]
fn d1_c1_no_real_document_is_falsely_qualified_supported() {
    let corpus = PathBuf::from(
        std::env::var("STORY_STUDIO_C1_CORPUS_DIR").expect("STORY_STUDIO_C1_CORPUS_DIR requis"),
    );
    let mut sources = std::fs::read_dir(&corpus)
        .expect("corpus local lisible")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    sources.sort();
    assert!(!sources.is_empty(), "corpus vide : prérequis manquant");

    let mut aggregates: BTreeMap<String, usize> = BTreeMap::new();
    let mut per_dimension: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut covered_lines: BTreeMap<usize, String> = BTreeMap::new();
    let mut unevaluated: BTreeMap<String, usize> = BTreeMap::new();
    let mut blocked = 0usize;
    let mut refused = 0usize;

    for path in &sources {
        let label = path.file_name().unwrap_or_default().to_string_lossy();
        let raw = std::fs::read_to_string(path).expect("document local lisible");
        let decoded = decode_story_document(&raw);
        let readiness = assess_graph_document_export_readiness(decoded.as_ref());

        assert_no_false_supported(&readiness, &label);

        if decoded.is_err() {
            refused += 1;
            // Un document refusé ne qualifie rien et reste bloqué.
            assert!(readiness.blocked, "{label} : refus non bloquant");
            assert!(readiness.dimensions.is_empty());
        }
        if readiness.blocked {
            blocked += 1;
        }

        *aggregates
            .entry(format!("{:?}", readiness.interoperability))
            .or_default() += 1;
        for dimension in &readiness.dimensions {
            *per_dimension
                .entry(format!("{:?}", dimension.id))
                .or_default()
                .entry(format!("{:?}", dimension.qualification))
                .or_default() += 1;
            for evidence in &dimension.evidence {
                covered_lines
                    .entry(evidence.line.row())
                    .or_insert_with(|| evidence.line.label().to_string());
            }
        }
        for dimension in &readiness.unevaluated {
            *unevaluated
                .entry(format!("{:?}", dimension.id))
                .or_default() += 1;
        }

        // La readiness observe : le payload d'auteur ne bouge pas.
        if let Ok(payload) = &decoded {
            let again = decode_story_document(&raw).expect("second décodage");
            assert_eq!(payload.document, again.document, "{label} : document muté");
            assert_eq!(payload.context, again.context, "{label} : contexte muté");
        }
    }

    let summary = serde_json::json!({
        "documents": sources.len(),
        "refusedAtDecoding": refused,
        "blocked": blocked,
        "interoperability": aggregates,
        "perDimension": per_dimension,
        "unevaluated": unevaluated,
        "contractLinesExercised": covered_lines,
        "dimensionCatalogue": DimensionId::ALL.len(),
        "contractLines": ContractLine::ALL.len(),
    });
    if let Ok(output) = std::env::var("STORY_STUDIO_C1_OUTPUT") {
        std::fs::write(
            output,
            serde_json::to_string_pretty(&summary).expect("synthèse sérialisable"),
        )
        .expect("synthèse écrite");
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&summary).expect("synthèse")
    );
}
