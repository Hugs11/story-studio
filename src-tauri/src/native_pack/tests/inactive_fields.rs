//! Champs que le réglage courant rend inactifs : la collecte des médias ne doit
//! préparer que ce que le constructeur écrit (sinon la relecture d'archive
//! refuse un média inutilisé), et la normalisation Libre ne doit pas activer un
//! contrôle désactivé au point de créer une boucle que `port_rules` refuse.

use super::*;
use std::collections::HashSet;

fn options(auto_next: bool, night_mode: bool) -> CanonicalOptions {
    CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Off,
        harmonize_loudness: true,
        auto_next,
        night_mode,
        end_message_autoplay: true,
    }
}

fn pack(entries: Vec<CanonicalEntry>, options: CanonicalOptions) -> CanonicalProject {
    CanonicalProject {
        name: "Pack".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        options,
        entries,
        shared_entries: Vec::new(),
    }
}

fn full_story(id: &str) -> CanonicalStory {
    CanonicalStory {
        id: id.to_string(),
        name: format!("Histoire {id}"),
        audio: Some(format!("{id}.mp3")),
        item_audio: Some(format!("{id}-title.mp3")),
        item_image: Some(format!("{id}-title.png")),
        ..Default::default()
    }
}

#[test]
fn disabled_home_reaction_is_neither_collected_nor_built() {
    for return_on_home_none in [false, true] {
        let mut story = full_story("a");
        story.home = false;
        story.return_on_home_none = return_on_home_none;
        story.after_playback_sequence =
            vec![end_step("one", None, None), end_step("two", None, None)];
        story.after_playback_home_step = Some(end_step(
            "reaction",
            Some("reaction.mp3"),
            Some("reaction.png"),
        ));
        let project = pack(vec![CanonicalEntry::Story(story)], options(false, false));
        let requests = collect_asset_requests(&project, 0.0, 0.0);
        assert!(!requests
            .iter()
            .any(|r| r.role.contains("afterPlaybackHomeStep")));
        let assets = requests
            .iter()
            .enumerate()
            .map(|(i, r)| prepared_asset(&r.role, &format!("asset-{i}.bin")))
            .collect();
        let report = report_for(project, assets, Vec::new());
        let document = build_story_document(&report).expect("document");
        let play = document
            .stage_nodes
            .iter()
            .find(|s| s.label() == "Histoire - Histoire a")
            .unwrap();
        assert!(!play.control_settings.home());
        assert!(!play.home_transition.is_value());
        assert!(!document
            .stage_nodes
            .iter()
            .any(|s| s.label() == "Étape reaction"));
        assert!(document
            .stage_nodes
            .iter()
            .any(|s| s.label() == "Étape one"));
        assert!(document
            .stage_nodes
            .iter()
            .any(|s| s.label() == "Étape two"));
    }
}

fn end_step(id: &str, audio: Option<&str>, image: Option<&str>) -> CanonicalAfterPlaybackStep {
    CanonicalAfterPlaybackStep {
        id: id.to_string(),
        name: format!("Étape {id}"),
        audio: audio.map(str::to_string),
        image: image.map(str::to_string),
        control_settings: None,
        ok_target: None,
        ok_choice_targets: Vec::new(),
        home_target: None,
        home_follows_ok: false,
        home_none: false,
    }
}

/// Collecte réelle, un fichier distinct par requête (aucune déduplication ne
/// masque un média inutilisé), puis construction : rend les rôles collectés
/// qu'aucun Écran ne désigne.
fn collected_but_unused_roles(project: CanonicalProject) -> Vec<String> {
    let assets: Vec<PreparedAsset> = collect_asset_requests(&project, 0.0, 0.0)
        .into_iter()
        .enumerate()
        .map(|(index, request)| {
            let extension = match request.source_kind {
                AssetSourceKind::Image => "png",
                _ => "mp3",
            };
            prepared_asset(&request.role, &format!("asset-{index}.{extension}"))
        })
        .collect();
    let report = report_for(project, assets.clone(), Vec::new());
    let document = build_story_document(&report).expect("document Libre");
    assert_free_document_passes_gates(&report, &document);
    let used: HashSet<&str> = document
        .stage_nodes
        .iter()
        .flat_map(|stage| [stage.audio.as_deref(), stage.image.as_deref()])
        .flatten()
        .collect();
    assets
        .iter()
        .filter(|asset| !used.contains(asset.staged_asset_name.as_str()))
        .map(|asset| asset.role.clone())
        .collect()
}

#[test]
fn global_end_audio_replaced_by_local_ends_is_not_collected() {
    // Toutes les histoires ont une fin locale ; le message global
    // n'est emprunté par aucune.
    let mut prompt_story = full_story("a");
    prompt_story.after_playback_prompt_audio = Some("a-end.mp3".to_string());
    let mut sequence_story = full_story("b");
    sequence_story.after_playback_sequence = vec![end_step("b1", Some("b-end.mp3"), None)];
    let mut project = pack(
        vec![
            CanonicalEntry::Story(prompt_story),
            CanonicalEntry::Story(sequence_story),
        ],
        options(false, true),
    );
    project.night_mode_audio = Some("global.mp3".to_string());

    assert_eq!(collected_but_unused_roles(project), Vec::<String>::new());
}

#[test]
fn global_end_audio_used_by_one_story_is_still_collected() {
    let mut prompt_story = full_story("a");
    prompt_story.after_playback_prompt_audio = Some("a-end.mp3".to_string());
    let mut project = pack(
        vec![
            CanonicalEntry::Story(prompt_story),
            CanonicalEntry::Story(full_story("b")),
        ],
        options(false, true),
    );
    project.night_mode_audio = Some("global.mp3".to_string());

    let requests = collect_asset_requests(&project, 0.0, 0.0);
    assert!(requests
        .iter()
        .any(|request| request.role == "nightModeAudio"));
    assert_eq!(collected_but_unused_roles(project), Vec::<String>::new());
}

#[test]
fn transparent_menu_image_is_not_collected() {
    // « Écran transparent » garde l'ancienne image dans le projet.
    let project = pack(
        vec![CanonicalEntry::Menu(CanonicalMenu {
            id: "menu".to_string(),
            name: "Dossier".to_string(),
            audio: Some("menu.mp3".to_string()),
            image: Some("menu.png".to_string()),
            auto_black_image: true,
            children: vec![
                CanonicalEntry::Story(full_story("a")),
                CanonicalEntry::Story(full_story("b")),
            ],
            ..Default::default()
        })],
        options(false, false),
    );

    assert_eq!(collected_but_unused_roles(project), Vec::<String>::new());
}

#[test]
fn home_reaction_media_follow_the_sequence_that_writes_them() {
    // La réaction Accueil n'est écrite qu'avec au moins deux étapes
    // (`build_after_playback_sequence`) : avec une seule, ses médias restent
    // hors du pack.
    let home_step = end_step("home", Some("home.mp3"), Some("home.png"));
    let mut one_step = full_story("a");
    one_step.after_playback_sequence = vec![end_step("a1", Some("a-end.mp3"), None)];
    one_step.after_playback_home_step = Some(home_step.clone());
    let mut two_steps = full_story("b");
    two_steps.after_playback_sequence = vec![
        end_step("b1", Some("b-end.mp3"), Some("b-end.png")),
        end_step("b2", None, None),
    ];
    two_steps.after_playback_home_step = Some(home_step);
    let project = pack(
        vec![
            CanonicalEntry::Story(one_step),
            CanonicalEntry::Story(two_steps),
        ],
        options(false, false),
    );

    let roles: Vec<String> = collect_asset_requests(&project, 0.0, 0.0)
        .into_iter()
        .map(|request| request.role)
        .collect();
    assert!(
        roles.iter().any(
            |role| role.contains("Histoire b") && role.ends_with("afterPlaybackHomeStep/audio")
        ),
        "{roles:?}"
    );
    assert_eq!(collected_but_unused_roles(project), Vec::<String>::new());
}

#[test]
fn auto_next_leaves_end_media_out_of_the_pack() {
    // Côté collecte : déjà exclu, conservé comme témoin.
    let mut story = full_story("a");
    story.after_playback_prompt_audio = Some("a-end.mp3".to_string());
    let mut sequence_story = full_story("b");
    sequence_story.after_playback_sequence = vec![end_step("b1", Some("b-end.mp3"), None)];
    let mut project = pack(
        vec![
            CanonicalEntry::Story(story),
            CanonicalEntry::Story(sequence_story),
        ],
        options(true, true),
    );
    project.night_mode_audio = Some("global.mp3".to_string());

    assert_eq!(collected_but_unused_roles(project), Vec::<String>::new());
}

// --- Contrôle désactivé portant une transition vers son propre Écran ---

fn imported_document_with_title(
    title_controls: ControlSettings,
    title_home: Option<Transition>,
    title_ok: Option<Transition>,
) -> StoryDocument {
    let action = |id: &str, target: &str| ActionNode {
        id: id.to_string(),
        name: Presence::Value("Action node".to_string()),
        options: named_option_targets(vec![target.to_string()]),
        position: no_authored_position(),
        action_type: Presence::Absent,
        group_id: Presence::Absent,
    };
    let stage = |uuid: &str,
                 name: &str,
                 square_one: bool,
                 controls: ControlSettings,
                 home: Option<Transition>,
                 ok: Option<Transition>| StageNode {
        uuid: uuid.to_string(),
        name: Presence::Value(name.to_string()),
        stage_type: Presence::Value("stage".to_string()),
        square_one: Presence::Value(square_one),
        audio: Presence::Value(format!("{uuid}.mp3")),
        image: Presence::Value(format!("{uuid}.png")),
        control_settings: Presence::Value(controls),
        home_transition: Presence::from_nullable(home),
        ok_transition: Presence::from_nullable(ok),
        position: no_authored_position(),
        group_id: Presence::Absent,
    };
    StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: vec![
            action("import-root-action", "import-menu"),
            action("import-menu-action", "import-title"),
            action("import-play-action", "import-play"),
        ],
        stage_nodes: vec![
            stage(
                "import-cover",
                "Cover node",
                true,
                ControlSettings::authored(true, true, false, false, false),
                None,
                Some(transition("import-root-action", 0)),
            ),
            stage(
                "import-menu",
                "Imported menu",
                false,
                ControlSettings::authored(false, true, true, false, true),
                None,
                Some(transition("import-menu-action", 0)),
            ),
            // Écran situé après le premier écran de contenu : son Accueil n'est
            // pas remplacé par le rattachement du ZIP.
            stage(
                "import-title",
                "Imported title",
                false,
                title_controls,
                title_home,
                title_ok,
            ),
            stage(
                "import-play",
                "Imported play",
                false,
                playback_controls(),
                Some(transition("import-menu-action", 0)),
                Some(transition("import-menu-action", 0)),
            ),
        ],
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
    }
}

fn aggregate(
    imported: StoryDocument,
) -> (NativeAssetPreparationReport, Result<StoryDocument, String>) {
    let mut assets = vec![
        prepared_asset("rootAudio", "cover.mp3"),
        prepared_asset("rootImage", "cover.png"),
    ];
    for stage in &imported.stage_nodes {
        for name in [stage.audio.as_deref(), stage.image.as_deref()]
            .into_iter()
            .flatten()
        {
            assets.push(prepared_asset(
                &format!("root/Imported pack / imported {name}"),
                name,
            ));
        }
    }
    let report = report_for(
        pack(
            vec![CanonicalEntry::Zip(CanonicalZip {
                name: "Imported pack".to_string(),
                zip_path: Some("imported.zip".to_string()),
                ..Default::default()
            })],
            options(false, false),
        ),
        assets,
        vec![imported_zip_bundle(
            "root/Imported pack/zip",
            "import-cover",
            "import-root-action",
            "import-menu",
            "import-cover",
            imported,
        )],
    );
    let document = build_story_document(&report);
    (report, document)
}

fn title_stage(document: &StoryDocument) -> &StageNode {
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Imported title")
        .expect("imported title")
}

#[test]
fn inactive_home_looping_to_its_own_stage_survives_aggregation() {
    let imported = imported_document_with_title(
        ControlSettings::authored(true, true, false, false, false),
        Some(transition("import-menu-action", 0)),
        Some(transition("import-play-action", 0)),
    );
    let (report, document) = aggregate(imported);
    let document = document.expect("un Accueil désactivé ne crée aucune boucle");
    assert_free_document_passes_gates(&report, &document);

    let title = title_stage(&document);
    assert!(!title.control_settings.home(), "Accueil reste désactivé");
    assert!(title.home_transition.has_no_value());
}

#[test]
fn inactive_ok_looping_to_its_own_stage_survives_aggregation() {
    let imported = imported_document_with_title(
        ControlSettings::authored(true, false, true, false, false),
        Some(transition("import-root-action", 0)),
        Some(transition("import-menu-action", 0)),
    );
    let (_, document) = aggregate(imported);
    let document = document.expect("un OK désactivé ne crée aucune boucle");

    let title = title_stage(&document);
    assert!(!title.control_settings.ok() && !title.control_settings.autoplay());
    assert!(title.ok_transition.has_no_value());
}

#[test]
fn active_home_looping_to_its_own_stage_is_still_refused() {
    let imported = imported_document_with_title(
        ControlSettings::authored(true, true, true, false, false),
        Some(transition("import-menu-action", 0)),
        Some(transition("import-play-action", 0)),
    );
    let (_, document) = aggregate(imported);
    let error = document.expect_err("un Accueil actif qui boucle reste refusé");
    assert!(
        error.contains("homeTransition ramène l'écran sur lui-même"),
        "{error}"
    );
}

#[test]
fn inactive_home_leading_elsewhere_is_still_opened() {
    // Normalisation historique conservée : une transition Accueil vers un autre
    // Écran rouvre le port, comme STUdio le recrée depuis `controlSettings`.
    let imported = imported_document_with_title(
        ControlSettings::authored(true, true, false, false, false),
        Some(transition("import-root-action", 0)),
        Some(transition("import-play-action", 0)),
    );
    let (_, document) = aggregate(imported);
    let document = document.expect("document");
    let title = title_stage(&document);
    assert!(title.control_settings.home());
    assert!(title.home_transition.is_value());
}
