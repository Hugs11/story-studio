//! Les refus, et ce qu'ils garantissent : rien de publié, projet intact.
//!
//! Chaque test vérifie **deux** choses, jamais une seule : le refus est du bon
//! type, et le dossier de destination ne contient aucune archive. Un refus qui
//! laisserait un `.zip` derrière lui serait exactement la faute que le point de
//! publication unique existe pour empêcher.

use super::*;

/// Aucune archive n'a été publiée dans `output`, ni entière ni partielle.
fn nothing_published(output: &Path) {
    let Ok(entries) = fs::read_dir(output) else {
        return;
    };
    let leftovers: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".zip") || name.contains(".partial"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "aucune archive ne doit subsister : {leftovers:?}"
    );
}

/// Un graphe invalide est refusé par la porte readiness, avant toute écriture.
#[test]
fn an_invalid_graph_is_refused_before_any_write() {
    let scratch = Scratch::new("refuse_gvi");
    let output = scratch.output();
    // Une option qui ne désigne aucun Stage : GVI bloque.
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, None)],
        vec!["cible-inexistante"],
    ));

    let error = export(&payload, &[], &output).expect_err("graphe invalide refusé");
    assert!(
        matches!(
            error,
            AdvancedExportError::Preparation {
                error: ExportPreparationError::GraphIntegrity { .. }
            }
        ),
        "refus attendu graph-integrity, obtenu {error:?}"
    );
    nothing_published(&output);
}

/// Une décision d'auteur non tranchée est refusée.
///
/// Un `controlSettings` incomplet n'est jamais complété à la place de
/// l'auteur : l'export refuse au lieu d'inventer.
#[test]
fn an_unresolved_authoring_decision_is_refused_before_any_write() {
    let scratch = Scratch::new("refuse_action_required");
    let output = scratch.output();
    let mut entry = stage(ENTRY, true, None, None);
    entry["controlSettings"] = serde_json::json!({"ok": true});
    let payload = imported_fs_payload(story_value(vec![entry], vec![]));

    let error = export(&payload, &[], &output).expect_err("décision d'auteur requise");
    assert!(
        matches!(
            error,
            AdvancedExportError::Preparation {
                error: ExportPreparationError::AuthoringActionRequired { .. }
                    | ExportPreparationError::ReadinessBlocked { .. }
            }
        ),
        "refus de décision d'auteur attendu, obtenu {error:?}"
    );
    nothing_published(&output);
}

/// Une identité non résolue est refusée à l'étape 3, donc **avant** que le
/// moindre média soit touché.
///
/// C'est exactement ce que la porte dédiée protège : la readiness ne bloque pas
/// sur une identité absente, et sans cette porte un média manquant masquerait le
/// défaut d'identité. Le document porte ici les deux défauts à la fois.
#[test]
fn an_unresolved_identity_is_refused_before_the_media_are_touched() {
    let scratch = Scratch::new("refuse_identity");
    let output = scratch.output();
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("absente.png"))],
        vec![],
    ));
    let mut decoded = reopen(&payload);
    decoded.context.pack_identity.value = None;
    decoded.context.pack_identity.unresolved_reason =
        Some("Identité de pack non résolue par le banc.".to_string());
    let payload = encode_authoring_payload(&decoded).expect("réencodage");

    // Le média est également introuvable : le refus d'identité doit primer.
    let error = export(&payload, &[missing_binding("absente.png")], &output)
        .expect_err("identité non résolue refusée");
    match error {
        AdvancedExportError::Preparation {
            error: ExportPreparationError::PackIdentity { message },
        } => assert!(
            message.contains("non résolue"),
            "le motif d'origine est repris, pas reconstruit : {message}"
        ),
        other => panic!("refus pack-identity attendu, obtenu {other:?}"),
    }
    nothing_published(&output);
}

/// Une identité présente mais **non bridge-compatible** est refusée par le même
/// prédicat, sans `trim` préalable.
#[test]
fn a_padded_identity_is_refused_exactly_like_the_preparation_refuses_it() {
    let scratch = Scratch::new("refuse_identity_padded");
    let payload = imported_fs_payload(story_value(vec![stage(ENTRY, true, None, None)], vec![]));
    let mut decoded = reopen(&payload);
    decoded.context.pack_identity.value = Some(format!(" {ENTRY} "));
    let payload = encode_authoring_payload(&decoded).expect("réencodage");

    let error = export(&payload, &[], &scratch.output()).expect_err("identité rembourrée refusée");
    assert!(
        matches!(
            error,
            AdvancedExportError::Preparation {
                error: ExportPreparationError::PackIdentity { .. }
            }
        ),
        "obtenu {error:?}"
    );
    // La préparation refuse la même entrée : les deux portes sont d'accord.
    let decoded = reopen(&payload);
    assert!(crate::native_pack::preparation::prepare_graph_document_for_export(&decoded).is_err());
}

/// Une disposition d'export **périmée** n'est jamais appliquée silencieusement.
/// Elle ne transforme toutefois pas la nouvelle position auteur en erreur :
/// cette valeur est exportée telle quelle.
#[test]
fn a_stale_position_disposition_does_not_block_export() {
    let scratch = Scratch::new("stale_disposition");
    let payload = imported_fs_payload(story_value(vec![stage(ENTRY, true, None, None)], vec![]));
    let mut decoded = reopen(&payload);
    let path = format!(
        "{}/position",
        crate::native_pack::stable_node_paths(
            &decoded.document.stage_nodes,
            "stageNodes",
            "uuid",
            |stage| stage.uuid.as_str()
        )[0]
    );
    decoded.document.stage_nodes[0].position = Presence::Value(crate::native_pack::Position {
        x: serde_json::Number::from(120_000),
        y: serde_json::Number::from(4),
    });
    decoded.context.default_value_origin = crate::native_pack::ValueOrigin::Authored;
    // Disposition prise sur une **autre** position : elle est périmée.
    decoded
        .context
        .position_export_decisions
        .push(crate::native_pack::PositionExportDecision {
            path,
            origin: crate::native_pack::ValueOrigin::Authored,
            position: crate::native_pack::Position {
                x: serde_json::Number::from(1),
                y: serde_json::Number::from(1),
            },
            disposition: crate::native_pack::PositionExportDisposition::ScaleToShortRange,
        });
    let payload = encode_authoring_payload(&decoded).expect("réencodage");
    let output = scratch.output();

    export(&payload, &[], &output).expect("une position périmée ne bloque pas l'export");
}

/// Un média introuvable arrête l'export, avec la liste des manquants et
/// **aucune archive**.
#[test]
fn a_missing_media_stops_the_export_with_its_list() {
    let scratch = Scratch::new("refuse_media");
    let output = scratch.output();
    let present = scratch.write_media("ici.png", &png_bytes(320, 240, 0));
    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("ici.png")),
            stage(SECOND, false, None, Some("ailleurs.png")),
        ],
        vec![SECOND],
    ));

    let error = export(
        &payload,
        &[
            binding("ici.png", &present),
            missing_binding("ailleurs.png"),
        ],
        &output,
    )
    .expect_err("média introuvable refusé");
    match error {
        AdvancedExportError::MediaUnavailable { entries } => {
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].asset_ref, "ailleurs.png");
            assert_eq!(entries[0].stage_ids, vec![SECOND.to_string()]);
        }
        other => panic!("refus media-unavailable attendu, obtenu {other:?}"),
    }
    nothing_published(&output);
}

/// Un dossier de destination non inscriptible est refusé par le préflight, donc
/// avant toute conversion.
#[test]
fn an_unwritable_destination_is_refused_by_the_preflight() {
    let scratch = Scratch::new("unwritable");
    let locked = scratch.dir("locked");
    let output = locked.join("cible");
    deny_writes(&locked);

    let image = scratch.write_media("i.png", &png_bytes(320, 240, 0));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));
    let error = export(&payload, &[binding("i.png", &image)], &output)
        .expect_err("dossier non inscriptible refusé");

    allow_writes(&locked);
    assert!(
        matches!(error, AdvancedExportError::OutputWrite { .. }),
        "refus output-write attendu, obtenu {error:?}"
    );
    assert!(!output.exists(), "aucun dossier de destination créé");
}

/// Une panne d'écriture **injectée** dans l'espace de travail est rendue
/// explicitement, sans faux succès.
///
/// L'espace de travail est occupé par un **fichier** là où l'export attend un
/// dossier : la panne survient à la première écriture locale, après le
/// préflight, et le dossier de destination reste vide.
#[test]
fn an_injected_local_write_failure_never_becomes_a_false_success() {
    let scratch = Scratch::new("write_failure");
    let output = scratch.output();
    let root = scratch.root.join("occupied-workspace");
    fs::write(&root, b"ce n'est pas un dossier").expect("occuper la racine");

    let workspace = ExportWorkspace::at(root.clone());
    match workspace {
        Err(AdvancedExportError::OutputWrite { path, .. }) => {
            assert!(path.contains("occupied-workspace"));
        }
        Err(other) => panic!("refus output-write attendu, obtenu {other:?}"),
        Ok(_) => panic!("un fichier ne peut pas servir de racine d'espace de travail"),
    }
    nothing_published(&output);
}

/// L'annulation demandée **avant la préparation** : rien n'est publié,
/// et le refus est `export-cancelled`.
#[test]
fn a_cancelled_export_publishes_nothing() {
    let scratch = Scratch::new("cancelled");
    let output = scratch.output();
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 0));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));

    let error = export_advanced_pack_with_cancel(
        &payload,
        &[binding("i.png", &image)],
        &output,
        &AdvancedAudioOptions::default(),
        None,
        None,
        None,
        None,
        &|_| {},
        &|| true,
    )
    .expect_err("annulation demandée");
    assert_eq!(error, AdvancedExportError::ExportCancelled);
    nothing_published(&output);
}

/// Deux exports vers le **même dossier** ne se marchent pas dessus :
/// chacun possède son espace de travail, et les deux archives coexistent.
#[test]
fn two_exports_into_the_same_folder_do_not_collide() {
    let scratch = Scratch::new("concurrent");
    let output = scratch.output();
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 1));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));
    let bindings = [binding("i.png", &image)];

    let first = export(&payload, &bindings, &output).expect("premier export");
    let second = export(&payload, &bindings, &output).expect("second export");

    assert_ne!(first.zip_path, second.zip_path, "deux fichiers distincts");
    assert!(Path::new(&first.zip_path).exists());
    assert!(Path::new(&second.zip_path).exists());
    // Aucun résidu de transfert : le `.partial` a été renommé, pas laissé.
    let leftovers: Vec<String> = fs::read_dir(&output)
        .expect("lire le dossier de destination")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".partial"))
        .collect();
    assert!(leftovers.is_empty(), "résidus de transfert : {leftovers:?}");
}

/// Un payload illisible est refusé par l'étape 1, sans que rien ne soit tenté.
#[test]
fn an_unreadable_payload_is_refused_first() {
    let scratch = Scratch::new("payload_decode");
    let output = scratch.output();
    let error = export("{\"payloadVersion\":", &[], &output).expect_err("payload illisible");
    assert!(
        matches!(error, AdvancedExportError::PayloadDecode { .. }),
        "obtenu {error:?}"
    );
    assert!(!output.exists(), "le préflight n'a même pas été atteint");
}

/// Un refus est **total du point de vue de l'auteur** : le payload et les
/// fichiers médias qu'il désigne sont bit à bit intacts.
#[test]
fn a_refusal_leaves_the_author_project_untouched() {
    let scratch = Scratch::new("refusal_non_mutation");
    let image = scratch.write_media("ici.png", &png_bytes(320, 240, 2));
    let before_media = fs::read(&image).expect("lire la source");
    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("ici.png")),
            stage(SECOND, false, None, Some("perdue.png")),
        ],
        vec![SECOND],
    ));
    let before_payload = payload.clone();

    export(
        &payload,
        &[binding("ici.png", &image), missing_binding("perdue.png")],
        &scratch.output(),
    )
    .expect_err("média manquant");

    assert_eq!(payload, before_payload, "le payload est inchangé");
    assert_eq!(
        fs::read(&image).expect("relire la source"),
        before_media,
        "le média d'auteur est inchangé"
    );
}

/// Une annulation à l'**entrée du transfert** reste `export-cancelled`.
///
/// C'est le contre-exemple minimal : un document créé sans média suffit. Le
/// drapeau est armé par le message de progression du transfert, donc après la
/// dernière garde de l'export ; la première relecture qui l'observe est celle
/// du transfert lui-même. Si `transfer_completed_zip` rendait une simple
/// chaîne, l'export la traduirait en `output-write` : le motif rendu à
/// l'interface dépendrait de l'instant de l'annulation.
#[test]
fn a_cancellation_at_the_transfer_entry_stays_typed() {
    let scratch = Scratch::new("cancel_transfer_entry");
    let output = scratch.output();
    let payload = created_payload(None, None);

    let cancel = CancelOnTransfer::new(0);
    let error = export_advanced_pack_with_cancel(
        &payload,
        &[],
        &output,
        &AdvancedAudioOptions::default(),
        None,
        None,
        None,
        None,
        &|message| cancel.watch(message),
        &|| cancel.cancelled(),
    )
    .expect_err("annulation à l'entrée du transfert");

    assert!(cancel.was_armed(), "le transfert a bien été atteint");
    assert_eq!(
        error,
        AdvancedExportError::ExportCancelled,
        "une annulation n'est pas une panne d'écriture"
    );
    nothing_published(&output);
}

/// Une annulation survenue **pendant la copie** reste `export-cancelled`, et ne
/// laisse aucun `.partial`.
///
/// Ici un bloc a réellement été lu et écrit dans le fichier de transfert avant
/// que l'annulation soit observée : c'est le cas où un résidu serait le plus
/// probable. Le nettoyage du transfert l'efface, et le motif reste le bon.
#[test]
fn a_cancellation_during_the_copy_stays_typed_and_leaves_nothing() {
    let scratch = Scratch::new("cancel_transfer_copy");
    let output = scratch.output();
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 1));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));

    // La racine est imposée pour que le nettoyage soit observable : une
    // annulation doit emporter l'espace de travail comme n'importe quel refus.
    let workspace_root = scratch.root.join("workspace-cancelled");
    let cancel = CancelOnTransfer::new(1);
    let error = export_advanced_pack_within(
        &payload,
        &[binding("i.png", &image)],
        &output,
        &AdvancedAudioOptions::default(),
        None,
        &|message| cancel.watch(message),
        &|| cancel.cancelled(),
        workspace_root.clone(),
    )
    .expect_err("annulation pendant la copie");

    assert!(cancel.was_armed());
    assert_eq!(error, AdvancedExportError::ExportCancelled);
    nothing_published(&output);
    assert!(
        !workspace_root.exists(),
        "une annulation détruit l'espace de travail, ZIP local compris"
    );
}

/// Contre-épreuve : une **vraie** panne d'écriture pendant la
/// publication reste `output-write`.
///
/// Sans elle, la correction pourrait s'être contentée de renommer tous les
/// échecs de transfert en annulation. Le dossier de destination est rendu
/// non inscriptible **après** le préflight, de sorte que la panne tombe au
/// moment de la publication et pas avant. Le fichier obstacle appartient au
/// banc, et l'export n'y touche pas.
#[test]
fn a_real_write_failure_during_publication_is_not_reported_as_a_cancellation() {
    let scratch = Scratch::new("transfer_write_failure");
    let output = scratch.dir("out-locked");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 2));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));

    // Le témoin du banc : il doit survivre intact à l'échec.
    let bystander = output.join("temoin.txt");
    fs::write(&bystander, b"appartient au banc").expect("écrire le témoin");

    let locked = std::cell::Cell::new(false);
    let error = export_advanced_pack_with_cancel(
        &payload,
        &[binding("i.png", &image)],
        &output,
        &AdvancedAudioOptions::default(),
        None,
        None,
        None,
        None,
        &|message| {
            if message.contains("Transfert") && !locked.get() {
                locked.set(true);
                deny_writes(&output);
            }
        },
        &|| false,
    )
    .expect_err("panne d'écriture pendant la publication");

    allow_writes(&output);
    assert!(locked.get(), "la publication a bien été atteinte");
    assert!(
        matches!(error, AdvancedExportError::OutputWrite { .. }),
        "une panne réelle reste output-write, obtenu {error:?}"
    );
    assert_eq!(
        fs::read(&bystander).expect("relire le témoin"),
        b"appartient au banc",
        "l'export ne touche pas aux fichiers qui ne sont pas les siens"
    );
    nothing_published(&output);
}
