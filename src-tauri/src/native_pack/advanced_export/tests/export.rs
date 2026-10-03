//! L'enchaînement nominal, et ce que l'archive contient exactement.

use super::*;

#[test]
fn exported_title_uses_the_project_name_only_when_no_author_title_remains() {
    let scratch = Scratch::new("title_fallback");
    let payload = imported_fs_payload(story_value(vec![stage(ENTRY, true, None, None)], vec![]));
    let author_before = reopen(&payload);

    let title_from = |source: &str, project_name: Option<&str>, directory: &str| {
        let result = export_advanced_pack_with_cancel(
            source,
            &[],
            &scratch.dir(directory),
            &AdvancedAudioOptions::default(),
            None,
            None,
            project_name,
            None,
            &|_| {},
            &|| false,
        )
        .expect("export du pack");
        story_of(&archive_entries(&result.zip_path))["title"]
            .as_str()
            .expect("titre du pack")
            .to_string()
    };

    assert_eq!(
        title_from(&payload, Some("  Mon projet  "), "named"),
        "Mon projet"
    );
    assert_eq!(title_from(&payload, None, "unnamed"), "Sans titre");
    let author_after = reopen(&payload);
    assert_eq!(author_after.document, author_before.document);
    assert_eq!(author_after.context, author_before.context);

    let mut authored = reopen(&payload);
    authored.document.title = Presence::Value("Titre choisi".to_string());
    authored
        .context
        .value_provenance
        .iter_mut()
        .find(|entry| entry.path == "/title")
        .expect("provenance du titre FS")
        .origin = crate::native_pack::ValueOrigin::Authored;
    let authored = encode_authoring_payload(&authored).expect("titre saisi");
    assert_eq!(
        title_from(&authored, Some("Nom du projet"), "authored"),
        "Titre choisi"
    );
}

/// Le titre livré demandé par l'appelant (nom de convention composé côté
/// interface) remplace celui du document dans `story.json`, et seulement là :
/// le document d'auteur garde son titre lisible. Sans demande, rien ne change.
#[test]
fn requested_story_title_replaces_the_document_title_only_in_the_archive() {
    let scratch = Scratch::new("story_title");
    let payload = created_payload(None, None);
    let author_before = reopen(&payload);

    let title_from = |story_title: Option<&str>, directory: &str| {
        let result = export_advanced_pack_with_cancel(
            &payload,
            &[],
            &scratch.dir(directory),
            &AdvancedAudioOptions::default(),
            None,
            story_title,
            None,
            None,
            &|_| {},
            &|| false,
        )
        .expect("export du pack");
        story_of(&archive_entries(&result.zip_path))["title"]
            .as_str()
            .expect("titre du pack")
            .to_string()
    };

    assert_eq!(
        title_from(Some("3+]Projet_créé[by_Auteur_V2"), "convention"),
        "3+]Projet_créé[by_Auteur_V2"
    );
    assert_eq!(title_from(Some("   "), "blank"), "Projet créé");
    assert_eq!(title_from(None, "free"), "Projet créé");
    assert_eq!(reopen(&payload).document, author_before.document);
}

/// Les trois origines produisent chacune une archive.
///
/// Le document créé, le pack STUdio importé et la projection FS ne partagent ni
/// provenance, ni origine d'identité, ni quadrillage d'éditeur. Ils traversent
/// pourtant le même writer, et rendent la même forme d'archive : `story.json`,
/// `assets/` plats, couverture quand l'écran d'entrée porte une image.
#[test]
fn the_three_origins_each_produce_a_readable_archive() {
    let scratch = Scratch::new("three_origins");
    let image = scratch.write_media("cover.png", &png_bytes(320, 240, 0));

    // Origine 1 : document créé, identité générée.
    let created = created_payload(None, Some("cover.png"));
    let created_result = export(
        &created,
        &[binding("cover.png", &image)],
        &scratch.dir("out-created"),
    )
    .expect("export d'un document créé");

    // Origine 2 : pack STUdio importé par le chemin d'import réel.
    let (studio, studio_bindings) = imported_studio_project(
        &scratch,
        &story_value(
            vec![stage(HYPHENLESS, true, None, Some("entry.png"))],
            vec![],
        ),
        &[("entry.png", png_bytes(320, 240, 1))],
    );
    let studio_result = export(&studio, &studio_bindings, &scratch.dir("out-studio"))
        .expect("export d'un pack STUdio importé");

    // Origine 3 : projection FS, provenance native.
    let fs_payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("fs.png"))],
        vec![],
    ));
    let fs_result = export(
        &fs_payload,
        &[binding("fs.png", &image)],
        &scratch.dir("out-fs"),
    )
    .expect("export d'une projection FS");

    for result in [&created_result, &studio_result, &fs_result] {
        let entries = archive_entries(&result.zip_path);
        assert!(entries.contains_key("story.json"), "story.json attendu");
        assert!(
            entries.contains_key("thumbnail.png"),
            "l'écran d'entrée porte une image : la couverture est produite"
        );
        assert!(result.has_thumbnail);
        assert_eq!(asset_names(&entries).len(), 1, "un média, un fichier");
        // L'entrée est plate et le `story.json` porte le nom nu.
        let names = asset_names(&entries);
        let story = story_of(&entries);
        assert_eq!(story["stageNodes"][0]["image"], names[0].as_str());
        assert!(!names[0].contains('/'), "aucun sous-dossier dans assets/");
    }
}

/// La copie place `squareOne` en tête, l'entrée porte exactement la
/// `packIdentity`, et l'ordre relatif des autres nœuds ne bouge pas.
#[test]
fn the_copy_puts_the_entry_first_and_keeps_every_other_order() {
    let scratch = Scratch::new("entry_first");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 2));

    // L'entrée est délibérément au **milieu** du document d'auteur.
    let payload = imported_fs_payload(story_value(
        vec![
            stage(SECOND, false, None, Some("i.png")),
            stage(ENTRY, true, None, Some("i.png")),
            stage(THIRD, false, None, Some("i.png")),
        ],
        vec![SECOND, THIRD],
    ));
    let identity = reopen(&payload)
        .context
        .pack_identity
        .value
        .expect("identité FS résolue");

    let result = export(&payload, &[binding("i.png", &image)], &scratch.output())
        .expect("export d'un document à entrée médiane");
    let story = story_of(&archive_entries(&result.zip_path));
    let stages = story["stageNodes"].as_array().expect("stageNodes");

    assert_eq!(
        stages[0]["uuid"],
        identity.as_str(),
        "l'entrée porte l'identité"
    );
    assert_eq!(stages[0]["squareOne"], serde_json::Value::Bool(true));
    assert_eq!(result.pack_identity, identity);
    // Les deux autres gardent leur ordre relatif d'auteur.
    assert_eq!(stages[1]["uuid"], result.stage_id_map[SECOND].as_str());
    assert_eq!(stages[2]["uuid"], result.stage_id_map[THIRD].as_str());
    assert_eq!(
        story["actionNodes"][0]["options"],
        serde_json::json!([result.stage_id_map[SECOND], result.stage_id_map[THIRD]]),
        "l'ordre des options d'ActionNode est celui de l'auteur"
    );
}

/// Un identifiant sans tirets est **préservé tel quel**, un identifiant non
/// compatible est remappé de façon déterministe et injective.
#[test]
fn hyphenless_ids_survive_and_incompatible_ids_are_remapped_injectively() {
    let scratch = Scratch::new("id_shapes");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 0));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("i.png")),
            stage(HYPHENLESS, false, None, Some("i.png")),
            stage("pas-un-uuid", false, None, Some("i.png")),
        ],
        vec![HYPHENLESS, "pas-un-uuid"],
    ));
    let result = export(&payload, &[binding("i.png", &image)], &scratch.output())
        .expect("export d'identifiants hétérogènes");

    assert_eq!(
        result.stage_id_map[HYPHENLESS], HYPHENLESS,
        "un identifiant bridge-compatible sans tirets est conservé"
    );
    let remapped = &result.stage_id_map["pas-un-uuid"];
    assert_ne!(remapped, "pas-un-uuid");
    assert!(
        crate::native_pack::classify_stage_id(remapped).bridge_compatible,
        "le remap produit un identifiant compatible : {remapped}"
    );
    let distinct: std::collections::BTreeSet<&String> = result.stage_id_map.values().collect();
    assert_eq!(distinct.len(), result.stage_id_map.len(), "table injective");
}

/// La présence-sensibilité traverse l'archive : absent, `null` et valeur
/// restent distincts, aucun `default` `serde` ne fabrique une présence, et
/// `image` / `official` racine ne sont jamais émis.
#[test]
fn presence_sensitivity_survives_the_whole_writer() {
    let scratch = Scratch::new("presence");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 1));

    // Le second Stage omet `audio` et `image` : le décodeur les garde absents.
    let mut second = stage(SECOND, false, None, None);
    second.as_object_mut().expect("objet").remove("audio");
    second.as_object_mut().expect("objet").remove("image");

    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png")), second],
        vec![SECOND],
    ));
    let source = reopen(&payload);
    assert!(source.document.stage_nodes[1].audio.is_absent());

    let result = export(&payload, &[binding("i.png", &image)], &scratch.output())
        .expect("export présence-sensible");
    let story = story_of(&archive_entries(&result.zip_path));

    // La **copie** émet `null` là où l'auteur avait omis, sans que
    // le document d'auteur perde la distinction.
    let second_export = &story["stageNodes"][1];
    assert!(second_export.get("audio").is_some());
    assert_eq!(second_export["audio"], serde_json::Value::Null);
    assert!(story.get("image").is_none(), "pas d'`image` racine");
    assert!(story.get("official").is_none(), "pas d'`official` racine");
    // Le payload d'auteur, lui, conserve l'omission.
    let after = reopen(&payload);
    assert!(after.document.stage_nodes[1].audio.is_absent());
}

/// Pas d'image d'entrée, pas de couverture, et l'export **réussit**.
///
/// Jamais un refus, jamais une image de remplacement, jamais l'image d'un autre
/// écran : le second Stage porte pourtant une image, et elle ne devient pas la
/// couverture.
#[test]
fn an_entry_without_an_image_exports_without_a_cover() {
    let scratch = Scratch::new("no_cover");
    let image = scratch.write_media("other.png", &png_bytes(320, 240, 2));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, None),
            stage(SECOND, false, None, Some("other.png")),
        ],
        vec![SECOND],
    ));
    let result = export(&payload, &[binding("other.png", &image)], &scratch.output())
        .expect("un écran d'entrée sans image n'est pas un refus");

    assert!(!result.has_thumbnail);
    let entries = archive_entries(&result.zip_path);
    assert!(!entries.contains_key("thumbnail.png"));
    assert_eq!(asset_names(&entries).len(), 1, "l'autre image est écrite");
}

/// La table de noms gouverne l'archive : un média partagé par deux
/// écrans donne **un** fichier, et les deux écrans le désignent.
#[test]
fn a_shared_media_yields_one_file_named_by_its_content() {
    let scratch = Scratch::new("shared_media");
    let image = scratch.write_media("shared.png", &png_bytes(320, 240, 0));

    let payload = imported_fs_payload(story_value(
        vec![
            stage(ENTRY, true, None, Some("shared.png")),
            stage(SECOND, false, None, Some("shared.png")),
        ],
        vec![SECOND],
    ));
    let result = export(
        &payload,
        &[binding("shared.png", &image)],
        &scratch.output(),
    )
    .expect("export d'un média partagé");

    let entries = archive_entries(&result.zip_path);
    let names = asset_names(&entries);
    assert_eq!(names.len(), 1, "un contenu, un fichier");
    let story = story_of(&entries);
    assert_eq!(story["stageNodes"][0]["image"], names[0].as_str());
    assert_eq!(story["stageNodes"][1]["image"], names[0].as_str());
    assert_eq!(result.asset_name_map["shared.png"], names[0]);
}

/// Un WAV traverse la conversion, et le rapport le déclare fichier par fichier
/// avec son rattachement structurel.
#[test]
fn an_audio_media_is_converted_and_declared_in_the_report() {
    if !ffmpeg_or_skip("an_audio_media_is_converted_and_declared_in_the_report") {
        return;
    }
    let scratch = Scratch::new("audio_report");
    let audio = scratch.write_media("voix.wav", &wav_bytes(0.8, 440.0));
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 1));

    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, Some("voix.wav"), Some("i.png"))],
        vec![],
    ));
    let result = export(
        &payload,
        &[binding("voix.wav", &audio), binding("i.png", &image)],
        &scratch.output(),
    )
    .expect("export avec conversion audio");

    let record = result
        .conversions
        .iter()
        .find(|record| record.asset_ref == "voix.wav")
        .expect("le rapport porte le média audio");
    assert_eq!(record.output_format, "mp3", "la sortie est du MP3");
    assert!(record.applied_plan.contains(&"mp3-encode"));
    assert!(!record.snapshot_sha256.is_empty());
    assert!(!record.task_key.is_empty());
    assert!(!record.output_sha256.is_empty());

    // La carte des destinations rattache le contenu à la place du graphe.
    let destination = result
        .destinations
        .iter()
        .find(|destination| destination.asset_ref == "voix.wav")
        .expect("la carte porte la destination audio");
    assert_eq!(destination.stage_uuid, ENTRY);
    assert_eq!(destination.output_sha256, record.output_sha256);

    let entries = archive_entries(&result.zip_path);
    let story = story_of(&entries);
    assert_eq!(
        story["stageNodes"][0]["audio"],
        record.archive_name.as_str()
    );
    assert!(record.archive_name.ends_with(".mp3"));
}

/// Un export ne monte aucun arbre hiérarchique : `rootEntries` reste
/// vide, et rien ne ressemble à un projet Libre dans la sortie avancée.
#[test]
fn the_advanced_archive_carries_no_hierarchical_montage() {
    let scratch = Scratch::new("no_hierarchy");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 0));
    let payload = imported_fs_payload(story_value(
        vec![stage(ENTRY, true, None, Some("i.png"))],
        vec![],
    ));
    let result =
        export(&payload, &[binding("i.png", &image)], &scratch.output()).expect("export avancé");
    let story = story_of(&archive_entries(&result.zip_path));

    assert!(story.get("rootEntries").is_none());
    assert!(story.get("hierarchicalProjectType").is_none());
    assert!(story.get("projectType").is_none());
}

/// Une chaîne **opaque** qui ressemble à une référence média n'est jamais
/// renommée.
///
/// Le membre opaque porte exactement la même valeur que `Stage.image`. Après
/// export, le champ média porte le nom d'archive et l'extension opaque porte
/// encore la chaîne d'auteur : la substitution ne touche que `Stage.audio` et
/// `Stage.image`, jamais récursivement le reste du document. Une extension qui
/// mentionne un ancien nom reste une dimension `UNTESTED`, jamais « corrigée ».
#[test]
fn an_opaque_string_that_looks_like_an_asset_ref_is_never_renamed() {
    let scratch = Scratch::new("opaque_asset_ref");
    let image = scratch.write_media("i.png", &png_bytes(320, 240, 0));

    let mut value = story_value(vec![stage(ENTRY, true, None, Some("i.png"))], vec![]);
    // Deux extensions opaques nomment le média : une sur le Stage, une à la
    // racine du document.
    value["stageNodes"][0]["vendorCover"] = serde_json::json!("i.png");
    value["vendorManifest"] = serde_json::json!({"cover": "i.png"});

    // Le décodeur d'un pack STUdio est le seul chemin qui **relève** des membres
    // opaques : une projection FS construit le document elle-même et n'en a pas.
    let mut decoded_payload =
        decode_story_document(&value.to_string()).expect("document décodable");
    let members = decoded_payload.context.opaque_members.clone();
    assert!(
        !members.is_empty(),
        "le banc doit réellement porter des extensions opaques"
    );
    for member in members {
        if member.kind == crate::native_pack::OpaqueMemberKind::UnknownExtension {
            crate::native_pack::authoring::set_opaque_export_disposition(
                &mut decoded_payload,
                &member.path,
                &member.key,
                member.source_occurrence,
                crate::native_pack::OpaqueExportDisposition::PreserveUntested,
            )
            .expect("disposition d'extension");
        }
    }
    let mut draws = Draws::new();
    let payload =
        initialize_advanced_document(decoded_payload, &mut || draws.next()).expect("acquisition");

    let result = export(&payload, &[binding("i.png", &image)], &scratch.output())
        .expect("export avec extensions opaques");
    let entries = archive_entries(&result.zip_path);
    let story = story_of(&entries);
    let archive_name = &result.asset_name_map["i.png"];

    assert_eq!(
        story["stageNodes"][0]["image"],
        archive_name.as_str(),
        "le champ média porte le nom d'archive"
    );
    assert_eq!(
        story["stageNodes"][0]["vendorCover"], "i.png",
        "l'extension opaque du Stage garde la chaîne d'auteur"
    );
    assert_eq!(
        story["vendorManifest"]["cover"], "i.png",
        "l'extension opaque racine garde la chaîne d'auteur"
    );
    // Et la chaîne opaque n'a pas été aspirée comme un média : un seul fichier.
    assert_eq!(asset_names(&entries).len(), 1);
}

// ── Le nom de l'archive ──────────────────────────────────────────────────────
//
// Nommée d'après le seul titre du document, l'archive ne pourrait ni porter un
// nom de convention, ni faire apparaître la version de l'auteur : deux
// productions successives du même pack donneraient `Le_Renard.zip` puis
// `Le_Renard-2.zip`, et ce suffixe dit « ce nom existait déjà », pas
// « deuxième version ».

/// Le nom demandé par l'appelant est celui du fichier publié.
#[test]
fn the_requested_archive_name_is_the_published_file_name() {
    let scratch = Scratch::new("archive_name_requested");
    let output = scratch.output();
    let result = export_named(
        &created_payload(None, None),
        &[],
        &output,
        Some("[6+]Le_Renard[by_Esope_V2"),
    )
    .expect("export nommé");

    let published = Path::new(&result.zip_path)
        .file_name()
        .expect("nom de fichier")
        .to_string_lossy()
        .to_string();
    assert_eq!(published, "[6+]Le_Renard[by_Esope_V2.zip");
}

/// Sans nom demandé, le titre du document reste la source — c'est le
/// comportement par défaut, et il ne bouge pas.
#[test]
fn without_a_requested_name_the_document_title_still_names_the_archive() {
    let scratch = Scratch::new("archive_name_default");
    let output = scratch.output();
    let result = export(&created_payload(None, None), &[], &output).expect("export par défaut");

    let published = Path::new(&result.zip_path)
        .file_name()
        .expect("nom de fichier")
        .to_string_lossy()
        .to_string();
    assert_eq!(published, "Projet_créé.zip");
}

/// Un nom demandé vide n'est pas un nom : il veut dire « rien demandé », et le
/// titre reprend la main. L'envoyer tel quel produirait un fichier nommé par le
/// nom neutre du writer alors que le document porte un titre.
#[test]
fn a_blank_requested_name_falls_back_to_the_document_title() {
    let scratch = Scratch::new("archive_name_blank");
    let output = scratch.output();
    let result = export_named(&created_payload(None, None), &[], &output, Some("   "))
        .expect("export au nom vide");

    let published = Path::new(&result.zip_path)
        .file_name()
        .expect("nom de fichier")
        .to_string_lossy()
        .to_string();
    assert_eq!(published, "Projet_créé.zip");
}

/// Le nom demandé traverse l'assainissement du writer, et un seul : l'appelant
/// n'en tient pas une seconde version, qui divergerait au premier caractère
/// interdit.
#[test]
fn a_requested_name_is_sanitized_by_the_writer_alone() {
    let scratch = Scratch::new("archive_name_sanitized");
    let output = scratch.output();
    let result = export_named(
        &created_payload(None, None),
        &[],
        &output,
        Some("3+]Contes / hiver: l'intégrale"),
    )
    .expect("export au nom à assainir");

    let published = Path::new(&result.zip_path)
        .file_name()
        .expect("nom de fichier")
        .to_string_lossy()
        .to_string();
    assert_eq!(published, "3+]Contes_-_hiver-_l_intégrale.zip");
}
