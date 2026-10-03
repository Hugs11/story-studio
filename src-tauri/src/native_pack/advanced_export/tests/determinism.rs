//! Non-mutation, stabilité d'identité et déterminisme de l'export.

use super::*;
use crate::native_pack::ControlSettings;

/// Deux exports successifs, sans modification, donnent la même table
/// d'identifiants, le même ordre et le même JSON logique.
///
/// L'égalité porte sur le `story.json` **et** sur les noms d'archive : ces
/// derniers sont adressés par le contenu, et leur allocation ne doit rien devoir
/// à l'ordre dans lequel les conversions rendent la main.
#[test]
fn two_exports_of_the_same_state_agree_on_everything_that_matters() {
    let scratch = Scratch::new("determinism");
    let first_image = scratch.write_media("a.png", &png_bytes(320, 240, 0));
    let second_image = scratch.write_media("b.png", &png_bytes(320, 240, 1));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("a.png")),
            stage(SECOND, false, None, Some("b.png")),
            stage("identifiant-libre", false, None, Some("a.png")),
        ],
        vec![SECOND, "identifiant-libre"],
    ));
    let bindings = [
        binding("a.png", &first_image),
        binding("b.png", &second_image),
    ];

    let first = export(&payload, &bindings, &scratch.dir("out-1")).expect("premier export");
    let second = export(&payload, &bindings, &scratch.dir("out-2")).expect("second export");

    assert_eq!(first.stage_id_map, second.stage_id_map, "même table");
    assert_eq!(
        first.asset_name_map, second.asset_name_map,
        "même table de noms"
    );
    assert_eq!(first.pack_identity, second.pack_identity);
    assert_eq!(
        story_of(&archive_entries(&first.zip_path)),
        story_of(&archive_entries(&second.zip_path)),
        "même JSON logique"
    );
    assert_eq!(
        asset_names(&archive_entries(&first.zip_path)),
        asset_names(&archive_entries(&second.zip_path))
    );
}

/// Après une réassignation de `squareOne`, après un Save As et après un
/// déplacement du dossier, l'**identité** et son suffixe court restent les
/// mêmes.
///
/// La **table**, elle, change après une réassignation : le nouvel écran
/// d'entrée porte `packIdentity`, et remappe l'ancien en cas de collision. Les
/// deux propriétés sont distinctes, et le test les sépare.
#[test]
fn identity_survives_reassignment_save_as_and_a_moved_folder() {
    let scratch = Scratch::new("identity_stability");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 0));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("i.png")),
            stage(SECOND, false, None, Some("i.png")),
        ],
        vec![SECOND],
    ));
    let reference = export(
        &payload,
        &[binding("i.png", &image)],
        &scratch.dir("out-ref"),
    )
    .expect("export de référence");

    // Save As : le payload est le même objet, écrit ailleurs.
    let saved_as = payload.clone();
    let after_save_as = export(
        &saved_as,
        &[binding("i.png", &image)],
        &scratch.dir("out-saved-as"),
    )
    .expect("export après copie sous");
    assert_eq!(after_save_as.pack_identity, reference.pack_identity);
    assert_eq!(after_save_as.stage_id_map, reference.stage_id_map);

    // Déplacement du dossier : les médias changent d'adresse, pas d'identité.
    let moved_dir = scratch.dir("moved");
    let moved_image = moved_dir.join("i.png");
    fs::copy(&image, &moved_image).expect("déplacer le média");
    let after_move = export(
        &payload,
        &[binding("i.png", &moved_image)],
        &scratch.dir("out-moved"),
    )
    .expect("export après déplacement");
    assert_eq!(after_move.pack_identity, reference.pack_identity);
    assert_eq!(after_move.stage_id_map, reference.stage_id_map);
    assert_eq!(after_move.asset_name_map, reference.asset_name_map);

    // Réassignation de `squareOne` : l'identité tient, la table bouge.
    let mut decoded = reopen(&payload);
    decoded.document.stage_nodes[0].square_one = Presence::Value(false);
    decoded.document.stage_nodes[1].square_one = Presence::Value(true);
    decoded.document.stage_nodes[1].ok_transition =
        decoded.document.stage_nodes[0].ok_transition.clone();
    decoded.document.stage_nodes[0].ok_transition = Presence::Null;
    decoded.document.stage_nodes[0].control_settings =
        Presence::Value(ControlSettings::authored(false, false, true, false, false));
    decoded.document.stage_nodes[1].control_settings =
        Presence::Value(ControlSettings::authored(false, true, false, false, false));
    // La nouvelle entrée n'est ni un choix ni un Accueil qui revient sur
    // elle-même (`port_rules`) : le menu mène désormais à l'ancienne entrée.
    decoded.document.action_nodes[0].options = vec![Some(ENTRY.to_string())];
    decoded.document.stage_nodes[1]
        .control_settings
        .value_mut()
        .expect("contrôles")
        .home = Presence::Value(false);
    let reassigned = encode_authoring_payload(&decoded).expect("réencodage");

    let after_reassignment = export(
        &reassigned,
        &[binding("i.png", &image)],
        &scratch.dir("out-reassigned"),
    )
    .expect("export après réassignation");
    assert_eq!(
        after_reassignment.pack_identity, reference.pack_identity,
        "l'identité survit à la réassignation"
    );
    assert_eq!(
        short_identity(&after_reassignment.pack_identity),
        short_identity(&reference.pack_identity),
        "le suffixe court commun aux deux passerelles est le même"
    );
    assert_eq!(
        after_reassignment.stage_id_map[SECOND], reference.pack_identity,
        "le nouvel écran d'entrée porte l'identité"
    );
}

/// Le suffixe court que Lunii.QT retient : huit caractères en capitales.
fn short_identity(identity: &str) -> String {
    let cleaned: String = identity.chars().filter(|c| *c != '-').collect();
    cleaned[cleaned.len().saturating_sub(8)..].to_ascii_uppercase()
}

/// Le projet enregistré est inchangé après un export réussi :
/// document, contexte, identité, liaisons et fichiers sur disque.
#[test]
fn a_successful_export_mutates_nothing_of_the_author_project() {
    let scratch = Scratch::new("non_mutation");
    let image = scratch.write_media("i.png", &png_bytes(300, 200, 2));
    let media_before = fs::read(&image).expect("lire la source");

    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));
    let payload_before = payload.clone();
    let decoded_before = reopen(&payload);
    let bindings = vec![binding("i.png", &image)];
    let bindings_before = bindings.clone();

    // Le projet est aussi écrit sur disque : un export ne réécrit pas le fichier.
    let project_file = scratch.dir("projet").join("projet.mbah");
    fs::write(&project_file, &payload).expect("écrire le projet");
    let file_before = fs::read(&project_file).expect("lire le projet");

    let result = export(&payload, &bindings, &scratch.output()).expect("export réussi");
    assert!(Path::new(&result.zip_path).exists());

    assert_eq!(payload, payload_before, "la chaîne de payload est intacte");
    assert_eq!(bindings, bindings_before, "les liaisons sont intactes");
    assert_eq!(
        fs::read(&project_file).expect("relire le projet"),
        file_before,
        "le fichier de projet n'est pas réécrit"
    );
    assert_eq!(
        fs::read(&image).expect("relire la source"),
        media_before,
        "le média d'auteur n'est pas transformé sur place"
    );

    // Le document redécodé est identique : l'image reste l'`assetRef` d'auteur,
    // jamais le nom d'archive.
    let decoded_after = reopen(&payload);
    assert_eq!(decoded_after.document, decoded_before.document);
    assert_eq!(decoded_after.context, decoded_before.context);
    assert_eq!(
        decoded_after.document.stage_nodes[0].image.as_deref(),
        Some("i.png"),
        "`assetRef` reste la chaîne du dialecte, verbatim"
    );
}

/// L'espace de travail de l'export ne survit pas à l'export, et rien de
/// temporaire n'atteint le dossier de destination.
///
/// La racine observée est **imposée** par le banc : lire le dossier temporaire
/// de la machine ferait dépendre le résultat des autres tests qui tournent en
/// parallèle.
#[test]
fn the_export_owns_and_destroys_its_own_workspace() {
    let scratch = Scratch::new("workspace_ownership");
    let output = scratch.output();
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 1));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));

    let workspace_root = scratch.root.join("workspace-observe");
    let result = export_advanced_pack_within(
        &payload,
        &[binding("i.png", &image)],
        &output,
        &AdvancedAudioOptions::default(),
        None,
        &|_| {},
        &|| false,
        workspace_root.clone(),
    )
    .expect("export réussi");

    assert!(
        !workspace_root.exists(),
        "l'espace de travail est détruit sur le chemin de succès"
    );
    assert!(result.warnings.is_empty(), "aucun échec de nettoyage");

    let published: Vec<String> = fs::read_dir(&output)
        .expect("lire le dossier de destination")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(published.len(), 1, "un seul fichier publié : {published:?}");
    assert!(published[0].ends_with(".zip"));
}

/// Un refus détruit lui aussi l'espace de travail : les instantanés déjà copiés
/// partent avec lui, et rien ne subsiste d'un export abandonné.
#[test]
fn a_refused_export_destroys_its_workspace_too() {
    let scratch = Scratch::new("workspace_refusal");
    let present = scratch.write_media("ici.png", &png_bytes(320, 240, 0));
    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("ici.png")),
            stage(SECOND, false, None, Some("perdue.png")),
        ],
        vec![SECOND],
    ));

    let workspace_root = scratch.root.join("workspace-refused");
    export_advanced_pack_within(
        &payload,
        &[binding("ici.png", &present), missing_binding("perdue.png")],
        &scratch.output(),
        &AdvancedAudioOptions::default(),
        None,
        &|_| {},
        &|| false,
        workspace_root.clone(),
    )
    .expect_err("média manquant");

    assert!(
        !workspace_root.exists(),
        "l'espace de travail est détruit sur le chemin de refus"
    );
}
