//! Suite des gestes d'auteur. Chaque geste est formulé en **JSON**, comme la frontière
//! IPC le recevra : la forme de la demande fait partie du contrat, et un test
//! qui construirait les structures Rust à la main ne l'éprouverait pas.

mod anchors;
mod charge;
mod constructions;
mod controls;
mod dispositions;
mod linked_nodes;
mod media;
mod metadata;
mod node_presentation;
mod options;
mod paste;
mod positions;
mod removal;
mod structure;
mod transitions;

use serde_json::{json, Number, Value};
use uuid::Uuid;

use super::*;
use crate::native_pack::persistence::{
    decode_authoring_payload, encode_authoring_payload, initialize_advanced_document,
    AdvancedMediaBinding, MediaBindingStatus,
};
use crate::native_pack::readiness::assess_graph_document_export_readiness;
use crate::native_pack::{
    decode_story_document, validate_graph_document_integrity, ControlSettings,
    DecodedStoryDocument, DiagnosticSeverity, EditorPosition, ExportQualification,
    ImportDiagnostic, InteroperabilityStatus, OpaqueExportDisposition, Position,
    PositionExportDisposition, Presence, ValueOrigin,
};

pub(super) const ENTRY: &str = "1f0a5b6c-2d3e-4f50-8a9b-0c1d2e3f4a5b";
pub(super) const TARGET: &str = "2b7c8d9e-0f11-4223-8455-66778899aabb";
pub(super) const AUDIO_REF: &str = "a1b2c3.mp3";
pub(super) const IMAGE_REF: &str = "d4e5f6.png";

/// Une source d'identifiants fixée, comme celle de l'acquisition d'identité du pack.
///
/// La forme reste canonique et bridge-compatible ; seul l'aléa disparaît, pour
/// que l'unicité et le refus de collision s'observent sans hasard.
pub(super) fn fixed_uuids() -> impl FnMut() -> Uuid {
    let mut counter: u128 = 0;
    move || {
        counter += 1;
        Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0000u128 | counter)
    }
}

/// Un document STUdio réaliste : entrée bridge-compatible, média partagé par
/// deux Stages, position source hors borne, extension opaque de nœud.
pub(super) fn source_document() -> Value {
    json!({
        "format": "v1",
        "version": 1,
        "title": "Le renard",
        "stageNodes": [
            {
                "uuid": ENTRY,
                "name": "Accueil",
                "squareOne": true,
                "audio": AUDIO_REF,
                "image": IMAGE_REF,
                "controlSettings": controls(false, true, false, false, false),
                "okTransition": {"actionNode": "action-1", "optionIndex": 0},
                "homeTransition": null,
                "position": {"x": 12.5, "y": 40000},
                "vendorMarker": {"keep": 1}
            },
            {
                "uuid": TARGET,
                "name": "Forêt",
                "squareOne": false,
                "audio": AUDIO_REF,
                "controlSettings": controls(false, false, false, false, false),
                "okTransition": null,
                "homeTransition": null
            }
        ],
        "actionNodes": [
            {"id": "action-1", "name": "Choix", "options": [TARGET]}
        ]
    })
}

pub(super) fn controls(wheel: bool, ok: bool, home: bool, pause: bool, autoplay: bool) -> Value {
    json!({"wheel": wheel, "ok": ok, "home": home, "pause": pause, "autoplay": autoplay})
}

pub(super) fn number(value: f64) -> Number {
    Number::from_f64(value).expect("nombre JSON fini")
}

pub(super) fn decoded(document: &Value) -> DecodedStoryDocument {
    decode_story_document(&document.to_string()).expect("document de test décodable")
}

/// Le payload d'un projet acquis, contexte **garni** : décision de position,
/// disposition opaque, position d'éditeur, qualification et diagnostic. Les six
/// familles d'ancrage sont ainsi réellement peuplées avant chaque geste.
pub(super) fn payload_from(document: &Value) -> String {
    let mut payload = decoded(document);
    garnish_context(&mut payload);
    initialize_advanced_document(payload, &mut fixed_uuids()).expect("payload encodable")
}

pub(super) fn payload() -> String {
    payload_from(&source_document())
}

fn garnish_context(payload: &mut DecodedStoryDocument) {
    let entry = format!("/stageNodes/@uuid={ENTRY}#0");
    let action = "/actionNodes/@id=action-1#0".to_string();
    crate::native_pack::authoring::set_position_export_disposition(
        payload,
        &format!("{entry}/position"),
        PositionExportDisposition::PreserveRawAcceptDantsuLoss,
    )
    .expect("décision de position sur une position source hors borne");
    crate::native_pack::authoring::set_opaque_export_disposition(
        payload,
        &entry,
        "vendorMarker",
        0,
        OpaqueExportDisposition::PreserveUntested,
    )
    .expect("disposition opaque sur l'extension de nœud");
    payload.context.editor_positions.push(EditorPosition {
        path: format!("{action}/position"),
        origin: ValueOrigin::ProjectionDerived,
        position: Position {
            x: number(4.0),
            y: number(8.0),
        },
    });
    payload
        .context
        .export_qualifications
        .push(ExportQualification {
            dimension: "stage-identity".to_string(),
            path: entry.clone(),
            status: InteroperabilityStatus::Supported,
            reason: "Identité d'entrée bridge-compatible.".to_string(),
        });
    payload.context.diagnostics.push(ImportDiagnostic {
        severity: DiagnosticSeverity::Warning,
        code: "SYNTHETIC_WITNESS".to_string(),
        path: format!("/stageNodes/@uuid={TARGET}#0"),
        message: "Témoin d'ancrage de diagnostic.".to_string(),
        retained: Presence::Absent,
        discarded: Vec::new(),
    });
    payload
        .context
        .value_provenance
        .push(crate::native_pack::ValueProvenance {
            path: format!("/stageNodes/@uuid={TARGET}#0/audio"),
            origin: ValueOrigin::SourceStudio,
        });
}

pub(super) fn bindings() -> Vec<AdvancedMediaBinding> {
    vec![
        AdvancedMediaBinding {
            asset_ref: AUDIO_REF.to_string(),
            path: Some("/projets/renard/medias/intro.mp3".to_string()),
            status: MediaBindingStatus::Resolved,
        },
        AdvancedMediaBinding {
            asset_ref: IMAGE_REF.to_string(),
            path: None,
            status: MediaBindingStatus::Missing,
        },
    ]
}

pub(super) fn gesture(value: Value) -> AdvancedGesture {
    serde_json::from_value(value).expect("geste décodable depuis sa forme IPC")
}

pub(super) fn apply(
    payload: &str,
    bindings: Vec<AdvancedMediaBinding>,
    request: Value,
) -> Result<AdvancedGestureOutcome, GestureError> {
    apply_advanced_gesture_with(payload, bindings, &gesture(request), &mut fixed_uuids())
}

pub(super) fn applied(
    payload: &str,
    bindings: Vec<AdvancedMediaBinding>,
    request: Value,
) -> AdvancedGestureOutcome {
    apply(payload, bindings, request).expect("geste accepté")
}

pub(super) fn refused(
    payload: &str,
    bindings: Vec<AdvancedMediaBinding>,
    request: Value,
) -> GestureError {
    apply(payload, bindings, request).expect_err("geste refusé")
}

/// L'enregistrement puis la réouverture, tels que le `.mbah` les fait subir :
/// la chaîne est écrite telle quelle, relue par le codec, et doit se réécrire à
/// l'identique.
pub(super) fn saved_and_reopened(payload: &str) -> DecodedStoryDocument {
    let reopened = decode_authoring_payload(payload).expect("payload relu");
    assert_eq!(
        encode_authoring_payload(&reopened).expect("payload réencodable"),
        payload,
        "l'aller-retour d'enregistrement doit être stable octet à octet"
    );
    reopened
}

#[test]
fn a_gesture_leaves_the_context_intact_outside_its_own_target() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": TARGET,
            "slot": "ok",
            "update": {"form": "set", "actionNode": "action-1", "optionIndex": 0}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    // Le contexte entier est comparé, pas seulement ce que le geste a regardé.
    assert_eq!(before.context, after.context);
    assert_eq!(
        before.context.pack_identity, after.context.pack_identity,
        "l'identité est acquise une fois et ne se réacquiert pas"
    );
    // `source_value` n'est jamais reconstruit : il vaut Null sur un payload relu
    // et ne peut donc servir d'état de travail.
    assert_eq!(after.source_value, Value::Null);

    // Seule la cible du geste bouge dans le document.
    let mut expected = before.document.clone();
    expected.stage_nodes[1].ok_transition =
        Presence::Value(crate::native_pack::Transition::fixed("action-1", 0));
    assert_eq!(after.document, expected);
    assert_eq!(outcome.media_bindings, bindings());
}

#[test]
fn the_readiness_follows_the_mutation_and_is_never_written_into_the_payload() {
    // Un contrôle incomplet bloque l'export ; le geste ne le complète pas, mais
    // la readiness du payload rendu le voit toujours.
    let mut source = source_document();
    source["stageNodes"][1]["controlSettings"] = json!({"ok": true});
    let payload = payload_from(&source);
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    assert!(assess_graph_document_export_readiness(Ok(&before)).blocked);

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": TARGET,
            "slot": "home",
            "update": {"form": "set", "actionNode": "action-1", "optionIndex": -1}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert!(
        assess_graph_document_export_readiness(Ok(&after)).blocked,
        "un geste ne débloque pas un contrôle incomplet"
    );
    assert_eq!(
        after.document.stage_nodes[1].control_settings,
        before.document.stage_nodes[1].control_settings,
        "aucun booléen n'est inventé par un geste de transition"
    );
    for absent in ["blocked", "interoperability", "unevaluated"] {
        assert!(
            !outcome.payload.contains(absent),
            "la readiness n'est pas persistée dans le payload"
        );
    }
}

#[test]
fn a_malformed_binding_list_is_refused_before_the_document_is_touched() {
    let payload = payload();
    let duplicated = vec![
        AdvancedMediaBinding {
            asset_ref: AUDIO_REF.to_string(),
            path: Some("/a.mp3".to_string()),
            status: MediaBindingStatus::Resolved,
        },
        AdvancedMediaBinding {
            asset_ref: AUDIO_REF.to_string(),
            path: Some("/b.mp3".to_string()),
            status: MediaBindingStatus::Resolved,
        },
    ];
    let error = refused(
        &payload,
        duplicated,
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    );
    assert_eq!(error.code, "DUPLICATE_MEDIA_BINDING");

    let resolved_without_path = vec![AdvancedMediaBinding {
        asset_ref: AUDIO_REF.to_string(),
        path: None,
        status: MediaBindingStatus::Resolved,
    }];
    let error = refused(
        &payload,
        resolved_without_path,
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    );
    assert_eq!(error.code, "INVALID_MEDIA_BINDING");
}

#[test]
fn a_payload_refused_by_the_codec_keeps_the_codec_diagnosis() {
    let error = apply(
        "{\"payloadVersion\":2,\"document\":{\"stageNodes\":[],\"actionNodes\":[]},\"context\":{}}",
        Vec::new(),
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    )
    .expect_err("version future refusée");
    assert_eq!(error.code, "UNSUPPORTED_PAYLOAD_VERSION");
    assert_eq!(error.path, "/payloadVersion");
}

#[test]
fn the_starting_document_is_intact_and_stays_the_reference() {
    let payload = payload();
    let start = decode_authoring_payload(&payload).expect("payload de départ");
    assert!(validate_graph_document_integrity(&start.document).is_ok());
    assert_eq!(start.document.stage_nodes.len(), 2);
    assert_eq!(start.context.opaque_members.len(), 1);
    assert_eq!(start.context.position_export_decisions.len(), 1);
    assert_eq!(start.context.editor_positions.len(), 1);
    assert_eq!(start.context.export_qualifications.len(), 1);
    assert_eq!(start.context.diagnostics.len(), 1);
}
