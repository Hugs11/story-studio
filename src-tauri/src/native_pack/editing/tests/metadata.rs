//! Geste des métadonnées de tête.
//!
//! Ce que la suite doit tenir tient en une phrase : la fiche du pack est
//! commune aux deux éditeurs, donc côté graphe elle écrit **dans le document**,
//! et ce qu'elle n'a pas visé ne bouge pas.

use serde_json::json;

use super::*;

fn update(members: Value) -> Value {
    json!({"gesture": "set-document-metadata", "update": members})
}

#[test]
fn changing_pack_uuid_updates_the_export_identity_and_survives_reopening() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let chosen = "7f3d1c2b-4a5e-4f60-9b8c-0d1e2f3a4b5c";
    let outcome = applied(
        &payload,
        bindings(),
        update(json!({"packIdentity": chosen, "uuid": {"form": "set", "value": chosen}})),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(after.context.pack_identity.value.as_deref(), Some(chosen));
    assert_eq!(after.document.uuid, Presence::Value(chosen.into()));
    assert_eq!(after.document.stage_nodes, before.document.stage_nodes);
    assert_eq!(after.document.action_nodes, before.document.action_nodes);
    assert_eq!(outcome.media_bindings, bindings());
}

#[test]
fn invalid_pack_uuid_refuses_without_changing_the_payload() {
    let payload = payload();
    let error = refused(
        &payload,
        bindings(),
        update(json!({"packIdentity": "not-an-uuid"})),
    );
    assert_eq!(error.code, "INVALID_PACK_IDENTITY");
    assert_eq!(error.path, "/context/packIdentity/value");
    saved_and_reopened(&payload);
}

#[test]
fn each_named_field_moves_alone_and_the_others_keep_their_form() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    assert_eq!(before.document.title, Presence::Value("Le renard".into()));
    assert_eq!(before.document.version, Presence::Value(1));
    // La description et la racine `uuid` sont **absentes** du document source :
    // c'est la forme que le geste doit laisser intacte quand il ne les vise pas.
    assert_eq!(before.document.description, Presence::Absent);
    assert_eq!(before.document.uuid, Presence::Absent);

    let outcome = applied(
        &payload,
        bindings(),
        update(json!({"title": {"form": "set", "value": "Le renard et la grue"}})),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        after.document.title,
        Presence::Value("Le renard et la grue".into())
    );
    assert_eq!(after.document.version, before.document.version);
    assert_eq!(after.document.description, Presence::Absent);
    assert_eq!(after.document.uuid, Presence::Absent);

    // Hors des métadonnées, le document est l'ancien à l'octet : ni les nœuds,
    // ni les transitions, ni les médias ne sont réécrits par ce geste.
    let mut expected = before.document.clone();
    expected.title = Presence::Value("Le renard et la grue".into());
    assert_eq!(after.document, expected);
    assert_eq!(outcome.media_bindings, bindings());
}

#[test]
fn the_context_and_the_pack_identity_survive_the_gesture() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");

    let outcome = applied(
        &payload,
        bindings(),
        update(json!({
            "title": {"form": "set", "value": "Nouveau titre"},
            "version": {"form": "set", "value": 3},
            "description": {"form": "set", "value": "Deuxième révision."},
            "uuid": {"form": "set", "value": "7f3d1c2b-4a5e-4f60-9b8c-0d1e2f3a4b5c"}
        })),
    );
    let after = saved_and_reopened(&outcome.payload);

    // Le contexte entier, ancrages compris, est comparé — pas seulement ce que
    // le geste a regardé. Seule la provenance des trois champs saisis change :
    // ils sont désormais ceux de l'auteur.
    let edited = ["/title", "/version", "/description"];
    let mut expected = before.context.clone();
    expected
        .value_provenance
        .retain(|entry| !edited.contains(&entry.path.as_str()));
    let mut observed = after.context.clone();
    observed
        .value_provenance
        .retain(|entry| !edited.contains(&entry.path.as_str()));
    assert_eq!(expected, observed);
    for path in edited {
        assert_eq!(
            crate::native_pack::authoring::value_origin(&after, path),
            ValueOrigin::Authored,
            "{path}"
        );
    }
    assert_eq!(
        before.context.pack_identity, after.context.pack_identity,
        "l'identité de pack est acquise une fois et ce geste n'y touche pas"
    );
    assert_eq!(after.document.version, Presence::Value(3));
    assert_eq!(
        after.document.uuid,
        Presence::Value("7f3d1c2b-4a5e-4f60-9b8c-0d1e2f3a4b5c".into())
    );
    assert_eq!(outcome.report.gesture, "set-document-metadata");
}

#[test]
fn the_three_presences_are_distinct_and_a_round_trip_restores_the_absence() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");

    // absent → valeur
    let with_value = applied(
        &payload,
        bindings(),
        update(json!({"description": {"form": "set", "value": "Un conte."}})),
    );
    let seen = saved_and_reopened(&with_value.payload);
    assert_eq!(
        seen.document.description,
        Presence::Value("Un conte.".into())
    );

    // valeur → null : `null` est une présence réelle, pas une absence.
    let nulled = applied(
        &with_value.payload,
        bindings(),
        update(json!({"description": {"form": "null"}})),
    );
    let seen = saved_and_reopened(&nulled.payload);
    assert_eq!(seen.document.description, Presence::Null);

    // null → absent : le champ disparaît de la sérialisation, et le document
    // redevient celui du départ.
    let cleared = applied(
        &nulled.payload,
        bindings(),
        update(json!({"description": {"form": "absent"}})),
    );
    let seen = saved_and_reopened(&cleared.payload);
    assert_eq!(seen.document.description, Presence::Absent);
    assert_eq!(seen.document, before.document);
}

#[test]
fn an_update_naming_nothing_is_refused_rather_than_applied_as_a_no_op() {
    // Un geste vide passerait pour une étape d'annulation sans rien avoir fait :
    // l'auteur aurait un pas d'historique qui ne rend rien.
    let error = refused(&payload(), bindings(), update(json!({})));
    assert_eq!(error.code, "EMPTY_METADATA_UPDATE");
    assert_eq!(error.path, "/");
}

#[test]
fn a_version_that_is_not_a_version_is_refused_and_writes_nothing() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");

    for value in [0, -1] {
        let error = refused(
            &payload,
            bindings(),
            update(json!({
                "title": {"form": "set", "value": "Titre qui ne doit pas passer"},
                "version": {"form": "set", "value": value}
            })),
        );
        assert_eq!(error.code, "INVALID_DOCUMENT_VERSION");
        assert_eq!(error.path, "/version");
    }

    // Le refus est total : le titre nommé dans la même demande n'a pas été
    // écrit. Un geste à moitié appliqué laisserait un état que personne n'a
    // demandé et qu'aucune annulation ne nomme.
    let untouched = decode_authoring_payload(&payload).expect("payload inchangé");
    assert_eq!(untouched.document, before.document);
}

#[test]
fn an_empty_identifier_is_refused_because_it_is_not_a_value() {
    let error = refused(
        &payload(),
        bindings(),
        update(json!({"uuid": {"form": "set", "value": "   "}})),
    );
    assert_eq!(error.code, "EMPTY_DOCUMENT_UUID");
    assert_eq!(error.path, "/uuid");
}

#[test]
fn an_unknown_metadata_field_is_refused_at_the_ipc_boundary() {
    // La fiche du pack Libre porte auteur, âge, producteur et bonus ; le
    // document de graphe n'en a aucun. Les accepter en silence les ferait
    // disparaître sans que personne ne le sache.
    let request: Result<AdvancedGesture, _> =
        serde_json::from_value(update(json!({"author": {"form": "set", "value": "Ésope"}})));
    assert!(
        request.is_err(),
        "un champ que le document ne porte pas doit être refusé à la frontière"
    );
}

#[test]
fn the_metadata_reaches_the_read_view_that_the_form_consults() {
    // La fiche lit la vue, pas le payload : si la projection ne portait pas ces
    // quatre champs, le formulaire commun afficherait des valeurs inventées.
    let outcome = applied(
        &payload(),
        bindings(),
        update(json!({
            "title": {"form": "set", "value": "Le renard"},
            "description": {"form": "null"}
        })),
    );
    let view = crate::native_pack::graph_view::read_advanced_graph_view(&outcome.payload)
        .expect("vue lisible");

    assert_eq!(view.metadata.title.value.as_deref(), Some("Le renard"));
    assert_eq!(view.metadata.version.value, Some(1));
    // `null` et l'absence ne sont pas rendus par la même forme : sans cela, la
    // fiche ne saurait pas distinguer « vidé » de « jamais renseigné ».
    assert_eq!(
        view.metadata.description.presence,
        crate::native_pack::graph_view::dto::PresenceKind::Null
    );
    assert_eq!(view.metadata.description.value, None);
    assert_eq!(
        view.metadata.uuid.presence,
        crate::native_pack::graph_view::dto::PresenceKind::Absent
    );
}

/// Un pack FS n'a ni titre ni description : ceux que le lecteur fabrique ne
/// partent pas dans le pack. Ceux que l'auteur saisit dans la fiche, si.
#[test]
fn a_title_typed_on_an_fs_pack_reaches_the_export() {
    let mut source = source_document();
    // Le témoin d'export possède une sortie ; ce test porte sur le titre FS.
    source["stageNodes"][1]["controlSettings"]["home"] = json!(true);
    let mut fs = decoded(&source);
    fs.context = crate::native_pack::StoryDocumentContext::imported_fs(&fs.document, ENTRY);
    let payload = initialize_advanced_document(fs, &mut fixed_uuids()).expect("payload FS");

    let untouched = decode_authoring_payload(&payload).expect("payload FS relu");
    let prepared = crate::native_pack::preparation::prepare_graph_document_for_export(&untouched)
        .expect("FS préparé");
    assert!(
        prepared.standard_value().get("title").is_none(),
        "le titre fabriqué par le lecteur ne part pas"
    );

    let outcome = applied(
        &payload,
        bindings(),
        update(json!({
            "title": {"form": "set", "value": "Example"},
            "description": {"form": "set", "value": "Six histoires"},
        })),
    );
    let after = saved_and_reopened(&outcome.payload);
    let prepared = crate::native_pack::preparation::prepare_graph_document_for_export(&after)
        .expect("FS préparé après la fiche");
    assert_eq!(prepared.standard_value()["title"], "Example");
    assert_eq!(prepared.standard_value()["description"], "Six histoires");
}

/// La graphie choisie par l'auteur est gardée : une graphie sans tirets, lue de
/// la même façon par les deux passerelles, n'est pas réécrite en canonique.
#[test]
fn a_hyphenless_pack_uuid_is_kept_as_typed() {
    let chosen = "7F3D1C2B4A5E4F609B8C0D1E2F3A4B5C";
    let outcome = applied(
        &payload(),
        bindings(),
        update(json!({"packIdentity": chosen, "uuid": {"form": "set", "value": chosen}})),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(after.context.pack_identity.value.as_deref(), Some(chosen));
    assert_eq!(after.document.uuid, Presence::Value(chosen.into()));
}

/// Une graphie que les passerelles lisent différemment est refusée à la saisie,
/// et non plus seulement à l'export.
#[test]
fn a_braced_pack_uuid_is_refused_at_input() {
    let error = refused(
        &payload(),
        bindings(),
        update(json!({"packIdentity": "{7f3d1c2b-4a5e-4f60-9b8c-0d1e2f3a4b5c}"})),
    );
    assert_eq!(error.code, "INVALID_PACK_IDENTITY");
    assert!(
        error.message.contains("n'est pas lisible"),
        "{}",
        error.message
    );
}
