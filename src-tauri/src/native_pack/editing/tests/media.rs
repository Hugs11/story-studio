//! Geste 2 — remplacer le fichier derrière une référence, et publier le média
//! d'un Stage créé.

use serde_json::json;

use super::*;

const NEW_FILE: &str = "/projets/renard/medias/intro-remasterisee.mp3";

fn repoint(asset_ref: &str, path: Option<&str>, present: bool) -> Value {
    json!({
        "gesture": "repoint-media",
        "assetRef": asset_ref,
        "location": {"path": path, "present": present}
    })
}

#[test]
fn replacing_the_file_follows_every_use_and_never_rewrites_the_dialect_string() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        repoint(AUDIO_REF, Some(NEW_FILE), true),
    );
    let after = saved_and_reopened(&outcome.payload);

    // `assetRef` reste la chaîne du dialecte, verbatim. Le nom d'archive est
    // adressé par le contenu, sur la copie d'export.
    assert_eq!(
        after.document.stage_nodes[0].audio.as_deref(),
        Some(AUDIO_REF)
    );
    assert_eq!(
        after.document.stage_nodes[1].audio.as_deref(),
        Some(AUDIO_REF)
    );
    assert_eq!(
        after.document,
        decode_authoring_payload(&payload)
            .expect("payload de départ")
            .document,
        "un remplacement de fichier ne touche pas le document d'auteur"
    );

    // Une seule liaison porte la référence : les deux Stages qui la partagent
    // suivent ensemble, sans jointure à refaire.
    assert_eq!(outcome.media_bindings.len(), 2);
    let bound = &outcome.media_bindings[0];
    assert_eq!(bound.asset_ref, AUDIO_REF);
    assert_eq!(bound.path.as_deref(), Some(NEW_FILE));
    assert_eq!(bound.status, MediaBindingStatus::Resolved);
    assert_eq!(outcome.report.media.repointed, vec![AUDIO_REF.to_string()]);
    assert!(outcome.report.media.added.is_empty());
}

#[test]
fn a_file_that_is_not_there_stays_bound_as_missing() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        repoint(AUDIO_REF, Some(NEW_FILE), false),
    );
    assert_eq!(outcome.media_bindings[0].path.as_deref(), Some(NEW_FILE));
    assert_eq!(
        outcome.media_bindings[0].status,
        MediaBindingStatus::Missing
    );
    // Les deux références manquantes sont listées, dans l'ordre du document.
    assert_eq!(
        outcome.report.media.missing,
        vec![AUDIO_REF.to_string(), IMAGE_REF.to_string()]
    );

    // La liaison de l'image, déjà manquante et sans chemin, reste lisible.
    assert_eq!(outcome.media_bindings[1].asset_ref, IMAGE_REF);
    assert_eq!(outcome.media_bindings[1].path, None);
    assert!(outcome
        .report
        .media
        .missing
        .contains(&IMAGE_REF.to_string()));
}

#[test]
fn a_reference_unknown_to_the_document_is_never_created_by_a_replacement() {
    let payload = payload();
    let error = refused(
        &payload,
        bindings(),
        repoint("z9y8x7.mp3", Some(NEW_FILE), true),
    );
    assert_eq!(error.code, "UNKNOWN_ASSET_REF");
}

#[test]
fn a_reference_declared_by_the_document_but_unbound_is_reported_not_invented() {
    let payload = payload();
    let outcome = applied(
        &payload,
        vec![bindings()[0].clone()],
        repoint(AUDIO_REF, Some(NEW_FILE), true),
    );
    assert_eq!(outcome.report.media.unbound, vec![IMAGE_REF.to_string()]);
    assert!(outcome
        .media_bindings
        .iter()
        .all(|binding| binding.asset_ref != IMAGE_REF));
}

#[test]
fn a_created_stage_publishes_its_new_media_bindings() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "create-stage",
            "stage": {
                "name": "Clairière",
                "controls": controls(false, true, false, false, false),
                "audio": {"assetRef": "e7f8a9.mp3", "location": {"path": "/projets/renard/medias/clairiere.mp3", "present": true}},
                "image": {"assetRef": "b0c1d2.png", "location": {"path": "/projets/renard/images/clairiere.png", "present": false}}
            }
        }),
    );
    let created = outcome.report.created.clone().expect("nœuds créés");
    let after = saved_and_reopened(&outcome.payload);
    let stage = after
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == created.stage_uuid)
        .expect("Stage créé");
    assert_eq!(stage.audio.as_deref(), Some("e7f8a9.mp3"));
    assert_eq!(stage.image.as_deref(), Some("b0c1d2.png"));

    assert_eq!(
        outcome.report.media.added,
        vec!["e7f8a9.mp3".to_string(), "b0c1d2.png".to_string()]
    );
    let added: Vec<_> = outcome
        .media_bindings
        .iter()
        .filter(|binding| binding.asset_ref.starts_with('e') || binding.asset_ref.starts_with('b'))
        .collect();
    assert_eq!(added[0].status, MediaBindingStatus::Resolved);
    // Un fichier annoncé absent reste lié, en manquant, avec son chemin.
    assert_eq!(added[1].status, MediaBindingStatus::Missing);
    assert_eq!(
        added[1].path.as_deref(),
        Some("/projets/renard/images/clairiere.png")
    );
    assert!(outcome
        .report
        .media
        .missing
        .contains(&"b0c1d2.png".to_string()));
}

#[test]
fn a_created_stage_shares_a_bound_reference_but_never_repoints_it_silently() {
    let payload = payload();

    // Partage explicite : aucune liaison n'est ajoutée ni re-pointée.
    let shared = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "create-stage",
            "stage": {
                "controls": controls(false, true, false, false, false),
                "audio": {"assetRef": AUDIO_REF}
            }
        }),
    );
    assert_eq!(shared.media_bindings, bindings());
    assert!(shared.report.media.added.is_empty());
    assert!(shared.report.media.repointed.is_empty());

    // Donner un chemin à une référence déjà liée serait un remplacement muet
    // pour tous les écrans qui la partagent : refusé, avec le geste à employer.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "create-stage",
            "stage": {
                "controls": controls(false, true, false, false, false),
                "audio": {"assetRef": AUDIO_REF, "location": {"path": NEW_FILE, "present": true}}
            }
        }),
    );
    assert_eq!(error.code, "ASSET_REF_ALREADY_BOUND");

    // À l'inverse, une référence neuve sans emplacement n'est liée à rien.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "create-stage",
            "stage": {
                "controls": controls(false, true, false, false, false),
                "audio": {"assetRef": "e7f8a9.mp3"}
            }
        }),
    );
    assert_eq!(error.code, "UNBOUND_ASSET_REF");
}

#[test]
fn a_binding_that_lost_its_last_reference_is_reported_never_removed() {
    // Le Stage `TARGET` partage l'audio ; le retirer laisse la référence
    // utilisée par l'entrée, donc la liaison reste **nécessaire**.
    let payload = payload();
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
        detached.media_bindings.clone(),
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    );
    let removed = applied(
        &freed.payload,
        freed.media_bindings.clone(),
        json!({"gesture": "delete-stage", "stageUuid": TARGET}),
    );
    // L'entrée référence toujours l'audio : la liaison est encore utilisée.
    assert!(removed
        .media_bindings
        .iter()
        .any(|binding| binding.asset_ref == AUDIO_REF));
    assert!(removed.report.media.unreferenced.is_empty());

    // En retirant aussi le média de l'entrée, la liaison perd sa dernière
    // référence — et reste néanmoins déclarée, simplement signalée.
    let mut source = source_document();
    source["stageNodes"][0]["audio"] = Value::Null;
    source["stageNodes"][1]["audio"] = Value::Null;
    let orphaned = payload_from(&source);
    let outcome = applied(
        &orphaned,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": TARGET,
            "slot": "home",
            "update": {"form": "null"}
        }),
    );
    assert!(outcome
        .media_bindings
        .iter()
        .any(|binding| binding.asset_ref == AUDIO_REF));
    assert_eq!(
        outcome.report.media.unreferenced,
        vec![AUDIO_REF.to_string()]
    );
}

#[test]
fn a_local_media_change_touches_one_stage_while_a_repoint_follows_every_use() {
    let payload = payload();
    // Les deux Stages partagent `AUDIO_REF` : c'est le cas dont l'impact doit
    // être visible avant le geste.
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    assert_eq!(
        before.document.stage_nodes[0].audio.as_deref(),
        Some(AUDIO_REF)
    );
    assert_eq!(
        before.document.stage_nodes[1].audio.as_deref(),
        Some(AUDIO_REF)
    );

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-media",
            "stageUuid": TARGET,
            "field": "audio",
            "update": {
                "form": "set",
                "assetRef": "e7f8a9.mp3",
                "location": {"path": "/projets/renard/medias/foret.mp3", "present": true}
            }
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    // Un seul écran change ; l'autre garde sa référence, verbatim.
    assert_eq!(
        after.document.stage_nodes[0].audio.as_deref(),
        Some(AUDIO_REF)
    );
    assert_eq!(
        after.document.stage_nodes[1].audio.as_deref(),
        Some("e7f8a9.mp3")
    );
    assert_eq!(outcome.report.media.added, vec!["e7f8a9.mp3".to_string()]);
    assert_eq!(outcome.report.media.released, vec![AUDIO_REF.to_string()]);
    // La liaison relâchée reste : aucun fichier n'est effacé, rien n'est délié.
    assert_eq!(outcome.media_bindings.len(), 3);
    assert!(outcome
        .media_bindings
        .iter()
        .any(|binding| binding.asset_ref == AUDIO_REF));
    // Les usages des références touchées sont rapportés, des deux côtés.
    let usages: Vec<(&str, &str)> = outcome
        .report
        .media
        .usages
        .iter()
        .map(|usage| (usage.asset_ref.as_str(), usage.field))
        .collect();
    assert!(usages.contains(&("e7f8a9.mp3", "audio")));
    assert!(usages.contains(&(AUDIO_REF, "audio")));
    assert_eq!(
        outcome
            .report
            .media
            .usages
            .iter()
            .filter(|usage| usage.asset_ref == AUDIO_REF)
            .count(),
        1,
        "l'ancienne référence n'a plus qu'un usage après le geste"
    );
}

#[test]
fn sharing_an_existing_reference_needs_no_path_and_repointing_it_is_another_gesture() {
    let payload = payload();
    // Partage explicite : la référence est déjà liée, aucun emplacement n'est
    // fourni, et la liaison existante n'est pas re-pointée en silence.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-media",
            "stageUuid": TARGET,
            "field": "image",
            "update": {"form": "set", "assetRef": IMAGE_REF}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(
        after.document.stage_nodes[1].image.as_deref(),
        Some(IMAGE_REF)
    );
    assert_eq!(outcome.media_bindings, bindings());
    // `IMAGE_REF` est `missing` dans la fixture : le geste le constate sans
    // fabriquer de chemin, et le projet reste enregistrable.
    assert_eq!(outcome.report.media.missing, vec![IMAGE_REF.to_string()]);
    assert_eq!(outcome.report.media.usages.len(), 0);

    // Re-pointer une référence déjà liée est `repoint-media`, pas une création.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-media",
            "stageUuid": TARGET,
            "field": "image",
            "update": {
                "form": "set",
                "assetRef": IMAGE_REF,
                "location": {"path": "/projets/renard/medias/foret.png", "present": true}
            }
        }),
    );
    assert_eq!(error.code, "ASSET_REF_ALREADY_BOUND");

    // Une référence inconnue sans emplacement n'est pas inventée.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-media",
            "stageUuid": TARGET,
            "field": "image",
            "update": {"form": "set", "assetRef": "inconnue.png"}
        }),
    );
    assert_eq!(error.code, "UNBOUND_ASSET_REF");
}

#[test]
fn removing_a_local_media_keeps_its_binding_and_carries_its_presence() {
    let payload = payload();
    for (form, expected) in [("null", Presence::Null), ("absent", Presence::Absent)] {
        let outcome = applied(
            &payload,
            bindings(),
            json!({
                "gesture": "set-stage-media",
                "stageUuid": ENTRY,
                "field": "image",
                "update": {"form": form}
            }),
        );
        let after = saved_and_reopened(&outcome.payload);
        // Le retrait porte sa forme.
        assert_eq!(after.document.stage_nodes[0].image, expected);
        // Plus aucun écran ne cite la référence : elle est relâchée, sa liaison
        // reste, et le constat `unreferenced` la rend retrouvable.
        assert_eq!(outcome.report.media.released, vec![IMAGE_REF.to_string()]);
        assert_eq!(
            outcome.report.media.unreferenced,
            vec![IMAGE_REF.to_string()]
        );
        assert_eq!(outcome.media_bindings, bindings());
        assert!(outcome.report.media.usages.is_empty());
    }

    // Un fichier manquant ne bloque ni l'édition ni l'enregistrement.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-media",
            "stageUuid": TARGET,
            "field": "audio",
            "update": {
                "form": "set",
                "assetRef": "b0c1d2.mp3",
                "location": {"path": null, "present": false}
            }
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    let binding = outcome
        .media_bindings
        .iter()
        .find(|binding| binding.asset_ref == "b0c1d2.mp3")
        .expect("liaison ajoutée");
    assert_eq!(binding.path, None);
    assert_eq!(binding.status, MediaBindingStatus::Missing);
    assert!(outcome
        .report
        .media
        .missing
        .contains(&"b0c1d2.mp3".to_string()));
    assert_eq!(
        encode_authoring_payload(&after).expect("payload réencodable"),
        outcome.payload
    );
}

#[test]
fn a_repoint_reports_every_screen_that_the_replacement_affects() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        repoint(AUDIO_REF, Some(NEW_FILE), true),
    );
    let usages: Vec<&str> = outcome
        .report
        .media
        .usages
        .iter()
        .map(|usage| usage.node_path.as_str())
        .collect();
    assert_eq!(
        usages,
        vec![
            format!("/stageNodes/@uuid={ENTRY}#0").as_str(),
            format!("/stageNodes/@uuid={TARGET}#0").as_str(),
        ],
        "remplacer le fichier d'une référence partagée affecte les deux écrans"
    );
    assert!(outcome
        .report
        .media
        .usages
        .iter()
        .all(|usage| usage.field == "audio"));
}
