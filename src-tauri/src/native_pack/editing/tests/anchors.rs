//! Ancrages du contexte : un détachement muet doit être rendu visible ou
//! empêché.

use serde_json::json;

use super::super::anchors::{
    node_anchor_paths, occurrence_shifts, orphan_anchors, removal_fate, rewrite_context_anchors,
    AnchorReport, AnchorRetarget,
};
use super::*;
use crate::native_pack::ValueProvenance;

#[test]
fn deleting_a_stage_removes_every_anchor_of_the_node_and_of_its_descendants() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let entry_path = format!("/stageNodes/@uuid={ENTRY}#0");

    // L'entrée n'est pas supprimable : la vérification porte donc sur `TARGET`, dont
    // le contexte reçoit d'abord les mêmes familles d'ancrage.
    let target_path = format!("/stageNodes/@uuid={TARGET}#0");
    assert!(before
        .context
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.path == target_path));
    assert!(before
        .context
        .value_provenance
        .iter()
        .any(|entry| entry.path == format!("{target_path}/audio")));

    // Libérer `TARGET` : retirer l'arête, puis l'Action qui le désigne.
    let detached = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": ENTRY,
            "slot": "ok",
            "update": {"form": "absent"}
        }),
    );
    let freed = applied(
        &detached.payload,
        bindings(),
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    );
    // Le retrait de l'Action emporte l'ancrage de position d'éditeur qui la
    // désignait, et rien d'autre.
    assert_eq!(
        freed.report.anchors.removed,
        vec!["/actionNodes/@id=action-1#0/position".to_string()]
    );
    assert!(freed.report.anchors.retargeted.is_empty());

    let removed = applied(
        &freed.payload,
        freed.media_bindings.clone(),
        json!({"gesture": "delete-stage", "stageUuid": TARGET}),
    );
    let after = saved_and_reopened(&removed.payload);

    let mut expected = vec![format!("{target_path}/audio"), target_path.clone()];
    expected.sort();
    let mut observed = removed.report.anchors.removed.clone();
    observed.sort();
    assert_eq!(observed, expected);

    // Aucun ancrage résiduel : le writer ne verra pas de chemin pendant.
    assert!(orphan_anchors(&after).is_empty());
    assert!(after
        .context
        .diagnostics
        .iter()
        .all(|d| d.path != target_path));
    assert!(after
        .context
        .value_provenance
        .iter()
        .all(|entry| !entry.path.starts_with(&target_path)));

    // Les ancrages de l'entrée sont intacts : disposition opaque, décision de
    // position, qualification et provenance.
    assert_eq!(after.context.opaque_members, before.context.opaque_members);
    assert_eq!(
        after.context.position_export_decisions,
        before.context.position_export_decisions
    );
    assert!(after
        .context
        .export_qualifications
        .iter()
        .any(|qualification| qualification.path == entry_path));
}

#[test]
fn an_inherited_orphan_anchor_is_reported_and_not_charged_to_the_gesture() {
    // Un ancrage déjà détaché — un cas que le codec laisse sans diagnostic — ne
    // fait pas refuser un projet légitime, mais devient observable.
    let payload = payload();
    let mut decoded = decode_authoring_payload(&payload).expect("payload de départ");
    decoded.context.value_provenance.push(ValueProvenance {
        path: "/stageNodes/@uuid=stage-disparu#0/position".to_string(),
        origin: ValueOrigin::Authored,
    });
    let inherited = encode_authoring_payload(&decoded).expect("payload garni");
    assert_eq!(
        orphan_anchors(&decoded),
        vec!["/stageNodes/@uuid=stage-disparu#0/position".to_string()]
    );

    let outcome = applied(
        &inherited,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": TARGET,
            "slot": "ok",
            "update": {"form": "set", "actionNode": "action-1", "optionIndex": 0}
        }),
    );
    assert_eq!(
        outcome.report.anchors.preexisting_orphans,
        vec!["/stageNodes/@uuid=stage-disparu#0/position".to_string()]
    );
    assert!(outcome.report.anchors.removed.is_empty());
}

#[test]
fn a_gesture_reports_no_orphan_when_the_context_is_sound() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "create-stage",
            "stage": {"controls": controls(false, true, false, false, false)}
        }),
    );
    assert_eq!(outcome.report.anchors, AnchorReport::default());
    let after = saved_and_reopened(&outcome.payload);
    assert!(orphan_anchors(&after).is_empty());
}

#[test]
fn the_node_paths_of_a_document_are_the_only_admissible_anchors() {
    let payload = payload();
    let decoded = decode_authoring_payload(&payload).expect("payload de départ");
    assert_eq!(
        node_anchor_paths(&decoded.document),
        vec![
            format!("/stageNodes/@uuid={ENTRY}#0"),
            format!("/stageNodes/@uuid={TARGET}#0"),
            "/actionNodes/@id=action-1#0".to_string(),
        ]
    );
}

/// Le retrait d'un homonyme décale l'occurrence de ceux qui le suivent.
///
/// La surface de gestes refuse aujourd'hui d'agir sur un identifiant ambigu
/// (`AMBIGUOUS_NODE`), donc l'ensemble des décalages est vide en pratique. La
/// règle est éprouvée ici **à l'unité**, pour qu'un lot qui relâcherait cette
/// garde ne réintroduise pas le détachement muet : sans retargeting, l'ancrage
/// de `#1` se rabattrait silencieusement sur un autre nœud, ce qu'aucune
/// détection d'orphelin ne verrait — le chemin resterait valide.
#[test]
fn removing_a_homonym_retargets_the_anchors_of_the_occurrences_that_follow() {
    let before = vec![
        "/stageNodes/@uuid=a#0".to_string(),
        "/stageNodes/@uuid=b#0".to_string(),
        "/stageNodes/@uuid=a#1".to_string(),
    ];
    let after = vec![
        "/stageNodes/@uuid=b#0".to_string(),
        "/stageNodes/@uuid=a#0".to_string(),
    ];
    let shifts = occurrence_shifts(&before, &after, 0);
    assert_eq!(
        shifts,
        vec![AnchorRetarget {
            from: "/stageNodes/@uuid=a#1".to_string(),
            to: "/stageNodes/@uuid=a#0".to_string(),
        }]
    );

    let mut decoded = decode_authoring_payload(&payload()).expect("payload de départ");
    decoded.context.value_provenance = vec![
        ValueProvenance {
            path: "/stageNodes/@uuid=a#0/position".to_string(),
            origin: ValueOrigin::Authored,
        },
        ValueProvenance {
            path: "/stageNodes/@uuid=a#1/position".to_string(),
            origin: ValueOrigin::SourceStudio,
        },
        ValueProvenance {
            path: "/stageNodes/@uuid=b#0".to_string(),
            origin: ValueOrigin::Authored,
        },
    ];
    let mut report = AnchorReport::default();
    rewrite_context_anchors(
        &mut decoded.context,
        |path| removal_fate("/stageNodes/@uuid=a#0", &shifts, path),
        &mut report,
    );

    assert_eq!(
        report.removed,
        vec!["/stageNodes/@uuid=a#0/position".to_string()]
    );
    assert_eq!(
        report.retargeted,
        vec![AnchorRetarget {
            from: "/stageNodes/@uuid=a#1/position".to_string(),
            to: "/stageNodes/@uuid=a#0/position".to_string(),
        }]
    );
    assert_eq!(
        decoded
            .context
            .value_provenance
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/stageNodes/@uuid=a#0/position", "/stageNodes/@uuid=b#0",]
    );
    // La valeur retargetée garde sa provenance : seul son ancrage a bougé.
    assert_eq!(
        decoded.context.value_provenance[0].origin,
        ValueOrigin::SourceStudio
    );
}

/// Un préfixe n'est pas un ancêtre : `#1` ne descend pas de `#0`.
#[test]
fn a_shared_prefix_is_never_mistaken_for_a_descendant() {
    let shifts: Vec<AnchorRetarget> = Vec::new();
    assert!(matches!(
        removal_fate("/stageNodes/@uuid=a#0", &shifts, "/stageNodes/@uuid=a#1"),
        super::super::anchors::AnchorFate::Keep
    ));
    assert!(matches!(
        removal_fate(
            "/stageNodes/@uuid=a#0",
            &shifts,
            "/stageNodes/@uuid=a#0/position"
        ),
        super::super::anchors::AnchorFate::Remove
    ));
}
