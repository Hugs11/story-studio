//! Suite synthétique du comparateur : chaque cas prouve qu'une transformation
//! précise est vue comme un écart, ou qu'une transformation déclarée légitime ne
//! l'est pas.
//!
//! Les documents sont construits à la main, jamais lus d'un pack : la suite tourne
//! partout, sans corpus ni passerelle.

use crate::native_pack::{
    named_option_targets, ActionNode, ControlSettings, OptionSelection, Position, Presence,
    StageNode, StoryDocument, Transition,
};

use super::{
    compare_structure, compare_structure_with, v1_known_losses, AmbiguityCode, Divergence,
    DivergenceCode, EntryAnchor, ReaderKnownLoss, StructuralVerdict, ToleratedTransformations,
};

// ---------------------------------------------------------------------------
// Fabrique de documents
// ---------------------------------------------------------------------------

/// Ces fixtures synthétiques ne portent aucune position d'auteur : le
/// comparateur structurel ne regarde pas la disposition, et un `{0,0}`
/// inventé serait une présence que le document source n'a jamais eue.
fn no_authored_position() -> Presence<Position> {
    Presence::Absent
}

fn stage(uuid: &str, name: &str) -> StageNode {
    StageNode {
        uuid: uuid.to_string(),
        name: Presence::Value(name.to_string()),
        stage_type: Presence::Value("stage".to_string()),
        square_one: Presence::Value(false),
        audio: Presence::Null,
        image: Presence::Null,
        control_settings: Presence::Value(ControlSettings::authored(
            false, false, false, false, false,
        )),
        home_transition: Presence::Null,
        ok_transition: Presence::Null,
        position: no_authored_position(),
        group_id: Presence::Absent,
    }
}

fn entry(mut stage: StageNode) -> StageNode {
    stage.square_one = Presence::Value(true);
    stage
}

fn wheel(mut stage: StageNode) -> StageNode {
    if let Some(controls) = stage.control_settings.value_mut() {
        controls.wheel = Presence::Value(true);
    }
    if let Some(controls) = stage.control_settings.value_mut() {
        controls.ok = Presence::Value(true);
    }
    stage
}

fn autoplay(mut stage: StageNode) -> StageNode {
    if let Some(controls) = stage.control_settings.value_mut() {
        controls.autoplay = Presence::Value(true);
    }
    if let Some(controls) = stage.control_settings.value_mut() {
        controls.ok = Presence::Value(true);
    }
    stage
}

fn media(mut stage: StageNode, audio: Option<&str>, image: Option<&str>) -> StageNode {
    stage.audio = Presence::from_nullable(audio.map(str::to_string));
    stage.image = Presence::from_nullable(image.map(str::to_string));
    stage
}

fn ok_to(mut stage: StageNode, action: &str, option_index: usize) -> StageNode {
    stage.ok_transition = Presence::Value(Transition::fixed(action, option_index));
    stage
}

fn home_to(mut stage: StageNode, action: &str, option_index: usize) -> StageNode {
    if let Some(controls) = stage.control_settings.value_mut() {
        controls.home = Presence::Value(true);
    }
    stage.home_transition = Presence::Value(Transition::fixed(action, option_index));
    stage
}

fn action(id: &str, options: &[&str]) -> ActionNode {
    ActionNode {
        id: id.to_string(),
        name: Presence::Value(id.to_string()),
        options: named_option_targets(options.iter().map(|option| option.to_string()).collect()),
        position: no_authored_position(),
        action_type: Presence::Absent,
        group_id: Presence::Absent,
    }
}

fn document(stages: Vec<StageNode>, actions: Vec<ActionNode>) -> StoryDocument {
    StoryDocument {
        title: Presence::Value("synthétique".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: actions,
        stage_nodes: stages,
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
    }
}

fn stage_mut<'a>(document: &'a mut StoryDocument, name: &str) -> &'a mut StageNode {
    document
        .stage_nodes
        .iter_mut()
        .find(|stage| stage.label() == name)
        .unwrap_or_else(|| panic!("stage «{name}» absent du document"))
}

fn action_mut<'a>(document: &'a mut StoryDocument, id: &str) -> &'a mut ActionNode {
    document
        .action_nodes
        .iter_mut()
        .find(|action| action.id == id)
        .unwrap_or_else(|| panic!("action «{id}» absente du document"))
}

/// Graphe de référence : un choix ordonné, un cycle `B ↔ C`, une convergence sur `B`,
/// un self-loop sur `D`, un HOME, et un `optionIndex` non nul.
///
/// `prefix` sépare les identifiants du document source de ceux du document relu : la
/// comparaison ne doit jamais dépendre d'eux.
fn reference_document(prefix: &str) -> StoryDocument {
    let id = |suffix: &str| format!("{prefix}-{suffix}");
    let stages = vec![
        ok_to(
            media(
                wheel(entry(stage(&id("a"), "A"))),
                Some("a.mp3"),
                Some("a.bmp"),
            ),
            &id("choix"),
            0,
        ),
        ok_to(
            media(autoplay(stage(&id("b"), "B")), Some("b.mp3"), Some("b.bmp")),
            &id("b-suite"),
            0,
        ),
        home_to(
            ok_to(
                media(wheel(stage(&id("c"), "C")), Some("c.mp3"), None),
                &id("c-choix"),
                1,
            ),
            &id("c-retour"),
            0,
        ),
        ok_to(
            media(autoplay(stage(&id("d"), "D")), Some("d.mp3"), None),
            &id("d-boucle"),
            0,
        ),
    ];
    let actions = vec![
        action(&id("choix"), &[&id("b"), &id("c")]),
        action(&id("b-suite"), &[&id("c")]),
        action(&id("c-choix"), &[&id("b"), &id("d")]),
        action(&id("c-retour"), &[&id("a")]),
        action(&id("d-boucle"), &[&id("d")]),
    ];
    document(stages, actions)
}

/// Le document relu : mêmes formes, identifiants régénérés, ordre physique changé
/// au-delà du point d'entrée — exactement les deux transformations que
/// `fs_pack_reader` et le writer FS tiers produisent par construction.
fn readback_document() -> StoryDocument {
    let mut readback = reference_document("relu");
    readback.stage_nodes.swap(1, 3);
    readback
}

fn source_document() -> StoryDocument {
    reference_document("src")
}

fn assert_equivalent(source: &StoryDocument, readback: &StoryDocument) {
    let comparison = compare_structure(source, readback);
    assert_eq!(
        comparison.verdict,
        StructuralVerdict::Equivalent,
        "écarts : {:?} — ambiguïtés : {:?}",
        comparison.divergences,
        comparison.ambiguities
    );
    assert_eq!(comparison.matched_stage_count, source.stage_nodes.len());
}

fn assert_not_equivalent(
    source: &StoryDocument,
    readback: &StoryDocument,
    expected: DivergenceCode,
) -> Vec<Divergence> {
    let comparison = compare_structure(source, readback);
    assert_eq!(
        comparison.verdict,
        StructuralVerdict::NotEquivalent,
        "écarts : {:?} — ambiguïtés : {:?}",
        comparison.divergences,
        comparison.ambiguities
    );
    assert!(
        comparison.codes().contains(&expected),
        "écart {expected:?} attendu, obtenu {:?}",
        comparison.divergences
    );
    comparison.divergences
}

// ---------------------------------------------------------------------------
// Transformations déclarées légitimes
// ---------------------------------------------------------------------------

#[test]
fn regenerated_identifiers_are_not_a_divergence() {
    let source = source_document();
    let mut readback = reference_document("relu");
    readback
        .stage_nodes
        .clone_from(&reference_document("relu").stage_nodes);
    assert_equivalent(&source, &readback);
}

#[test]
fn physical_reordering_beyond_the_entry_is_not_a_divergence() {
    let source = source_document();
    let readback = readback_document();
    // L'ordre physique diffère réellement.
    assert_ne!(
        source
            .stage_nodes
            .iter()
            .map(|stage| stage.label().to_string())
            .collect::<Vec<_>>(),
        readback
            .stage_nodes
            .iter()
            .map(|stage| stage.label().to_string())
            .collect::<Vec<_>>()
    );
    assert_equivalent(&source, &readback);
}

#[test]
fn entry_stage_may_sit_anywhere_in_the_source_table() {
    let mut source = source_document();
    source.stage_nodes.swap(0, 2);
    assert_equivalent(&source, &readback_document());
}

#[test]
fn deduplicated_assets_with_identical_content_are_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    // Le writer tiers a dédupliqué : `B` et `C` partagent désormais un seul audio.
    stage_mut(&mut readback, "C").audio = Presence::Value("b.mp3".to_string());

    let comparison = compare_structure(&source, &readback);
    assert_eq!(comparison.verdict, StructuralVerdict::Equivalent);
    assert_eq!(
        comparison.observations.audio_sharing_merges, 1,
        "le regroupement doit rester visible en observation"
    );
}

#[test]
fn silent_audio_substituted_for_a_missing_one_is_equivalent_by_rule() {
    let mut source = source_document();
    stage_mut(&mut source, "D").audio = Presence::Null;
    let readback = readback_document();

    let comparison = compare_structure(&source, &readback);
    assert_eq!(comparison.verdict, StructuralVerdict::Equivalent);
    assert_eq!(comparison.observations.silent_audio_substitutions, 1);
}

#[test]
fn the_silent_audio_rule_is_what_makes_that_case_pass() {
    let mut source = source_document();
    stage_mut(&mut source, "D").audio = Presence::Null;
    let readback = readback_document();

    let comparison = compare_structure_with(
        &source,
        &readback,
        &ToleratedTransformations::none(),
        &v1_known_losses(),
    );
    assert_eq!(comparison.verdict, StructuralVerdict::NotEquivalent);
    assert!(comparison.codes().contains(&DivergenceCode::AudioPresence));
}

#[test]
fn a_present_audio_that_disappears_is_never_tolerated() {
    let source = source_document();
    let mut readback = readback_document();
    stage_mut(&mut readback, "D").audio = Presence::Null;
    assert_not_equivalent(&source, &readback, DivergenceCode::AudioPresence);
}

// ---------------------------------------------------------------------------
// Modifications réelles de navigation
// ---------------------------------------------------------------------------

#[test]
fn a_flattened_cycle_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    // `C -OK[0]-> B` devient `C -OK[0]-> B2`, copie conforme de `B` : les compteurs de
    // stages augmentent d'un, mais surtout le retour n'existe plus.
    let clone = ok_to(
        media(
            autoplay(stage("relu-b2", "B2")),
            Some("b.mp3"),
            Some("b.bmp"),
        ),
        "relu-b-suite",
        0,
    );
    readback.stage_nodes.push(clone);
    action_mut(&mut readback, "relu-c-choix").options[0] = Some("relu-b2".to_string());

    let divergences = assert_not_equivalent(&source, &readback, DivergenceCode::DestinationSharing);
    assert!(
        divergences
            .iter()
            .any(|gap| gap.code == DivergenceCode::StageCount),
        "le stage dupliqué doit aussi apparaître au compte : {divergences:?}"
    );
}

#[test]
fn a_flattened_self_loop_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    let clone = media(autoplay(stage("relu-d2", "D2")), Some("d.mp3"), None);
    readback.stage_nodes.push(clone);
    action_mut(&mut readback, "relu-d-boucle").options[0] = Some("relu-d2".to_string());
    assert_not_equivalent(&source, &readback, DivergenceCode::DestinationSharing);
}

#[test]
fn a_split_convergence_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    // `A` et `C` convergeaient sur `B` ; `C` pointe désormais sur une copie.
    let clone = ok_to(
        media(
            autoplay(stage("relu-b2", "B2")),
            Some("b.mp3"),
            Some("b.bmp"),
        ),
        "relu-b-suite",
        0,
    );
    readback.stage_nodes.push(clone);
    action_mut(&mut readback, "relu-c-choix").options[0] = Some("relu-b2".to_string());
    assert_not_equivalent(&source, &readback, DivergenceCode::DestinationSharing);
}

#[test]
fn a_changed_option_order_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    action_mut(&mut readback, "relu-choix").options.swap(0, 1);
    // Le premier fait observable de l'échange est que la destination arrivée en tête
    // ne porte plus le même `optionIndex` : c'est déjà un écart.
    assert_not_equivalent(&source, &readback, DivergenceCode::OptionIndex);
}

/// Échange de deux destinations déjà appariées ailleurs dans le graphe : l'écart est
/// alors exactement « l'ordre de la liste a changé », sans rien d'autre.
#[test]
fn a_reordered_destination_list_is_reported_as_such() {
    let build = |prefix: &str| {
        let id = |suffix: &str| format!("{prefix}-{suffix}");
        document(
            vec![
                ok_to(
                    media(wheel(entry(stage(&id("a"), "A"))), Some("a.mp3"), None),
                    &id("haut"),
                    0,
                ),
                ok_to(
                    media(autoplay(stage(&id("b"), "B")), Some("b.mp3"), Some("b.bmp")),
                    &id("b-suite"),
                    0,
                ),
                ok_to(
                    media(autoplay(stage(&id("c"), "C")), Some("c.mp3"), None),
                    &id("c-suite"),
                    0,
                ),
                ok_to(
                    media(wheel(stage(&id("d"), "D")), Some("d.mp3"), None),
                    &id("bas"),
                    0,
                ),
            ],
            vec![
                action(&id("haut"), &[&id("b"), &id("c")]),
                action(&id("b-suite"), &[&id("d")]),
                action(&id("c-suite"), &[&id("d")]),
                action(&id("bas"), &[&id("b"), &id("c")]),
            ],
        )
    };
    let source = build("src");
    let mut readback = build("relu");
    action_mut(&mut readback, "relu-bas").options.swap(0, 1);
    assert_not_equivalent(&source, &readback, DivergenceCode::DestinationOrder);
}

/// Frontière déclarée : deux destinations **structurellement indiscernables** ne se
/// distinguent que par le contenu de leurs médias, et le transcodage du convertisseur
/// détruit toute correspondance d'octets entre source et relecture. Un échange entre
/// elles est donc invisible, par construction et non par oubli.
#[test]
fn swapping_two_indistinguishable_destinations_stays_invisible() {
    let build = |prefix: &str, first: &str, second: &str| {
        let id = |suffix: &str| format!("{prefix}-{suffix}");
        document(
            vec![
                ok_to(
                    media(wheel(entry(stage(&id("a"), "A"))), Some("a.mp3"), None),
                    &id("choix"),
                    0,
                ),
                media(autoplay(stage(&id("x"), "X")), Some(first), None),
                media(autoplay(stage(&id("y"), "Y")), Some(second), None),
            ],
            vec![action(&id("choix"), &[&id("x"), &id("y")])],
        )
    };
    let source = build("src", "gauche.mp3", "droite.mp3");
    let mut readback = build("relu", "droite.mp3", "gauche.mp3");
    action_mut(&mut readback, "relu-choix").options.swap(0, 1);

    assert_eq!(
        compare_structure(&source, &readback).verdict,
        StructuralVerdict::Equivalent
    );
}

#[test]
fn a_changed_option_index_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    stage_mut(&mut readback, "C")
        .ok_transition
        .value_mut()
        .expect("C a une transition OK")
        .selection = OptionSelection::Fixed(0);
    assert_not_equivalent(&source, &readback, DivergenceCode::OptionIndex);
}

#[test]
fn a_retargeted_home_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    action_mut(&mut readback, "relu-c-retour").options[0] = Some("relu-d".to_string());
    assert_not_equivalent(&source, &readback, DivergenceCode::DestinationSharing);
    // Le HOME retiré et le HOME redirigé sont deux écarts distincts, tous deux comptés.
}

#[test]
fn a_removed_home_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    let target = stage_mut(&mut readback, "C");
    target.home_transition = Presence::Null;
    if let Some(controls) = target.control_settings.value_mut() {
        controls.home = Presence::Value(false);
    }
    assert_not_equivalent(&source, &readback, DivergenceCode::TransitionPresence);
}

#[test]
fn a_changed_control_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    if let Some(controls) = stage_mut(&mut readback, "D").control_settings.value_mut() {
        controls.pause = Presence::Value(true);
    }
    assert_not_equivalent(&source, &readback, DivergenceCode::StageControls);
}

#[test]
fn a_removed_image_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    stage_mut(&mut readback, "B").image = Presence::Null;
    assert_not_equivalent(&source, &readback, DivergenceCode::ImagePresence);
}

#[test]
fn a_changed_night_mode_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    readback.night_mode_available = Presence::Value(true);
    assert_not_equivalent(&source, &readback, DivergenceCode::NightMode);
}

#[test]
fn an_absent_night_mode_read_back_as_false_is_runtime_equivalent() {
    let mut source = source_document();
    let readback = readback_document();
    source.night_mode_available = Presence::Absent;
    assert_equivalent(&source, &readback);
}

// ---------------------------------------------------------------------------
// Le piège du drapeau `squareOne`
// ---------------------------------------------------------------------------

/// Cycle de trois stages discernables. Enraciné ailleurs, il donne un graphe relu
/// différent — c'est le cas grave que le drapeau ne peut pas détecter.
fn ring_document(prefix: &str, entry_name: &str) -> StoryDocument {
    let id = |suffix: &str| format!("{prefix}-{suffix}");
    let mut stages = vec![
        ok_to(
            media(autoplay(stage(&id("a"), "A")), Some("a.mp3"), Some("a.bmp")),
            &id("a-vers-b"),
            0,
        ),
        ok_to(
            media(autoplay(stage(&id("b"), "B")), Some("b.mp3"), None),
            &id("b-vers-c"),
            0,
        ),
        ok_to(autoplay(stage(&id("c"), "C")), &id("c-vers-a"), 0),
    ];
    let position = stages
        .iter()
        .position(|stage| stage.label() == entry_name)
        .expect("stage d'entrée présent");
    stages[position].square_one = Presence::Value(true);
    // Le lecteur pose toujours `squareOne` sur l'indice 0 : on reproduit la même
    // contrainte pour que le drapeau soit trivialement « valide » des deux côtés.
    stages.swap(0, position);
    document(
        stages,
        vec![
            action(&id("a-vers-b"), &[&id("b")]),
            action(&id("b-vers-c"), &[&id("c")]),
            action(&id("c-vers-a"), &[&id("a")]),
        ],
    )
}

#[test]
fn a_moved_entry_point_is_not_equivalent_although_both_documents_declare_square_one() {
    let source = ring_document("src", "A");
    let readback = ring_document("relu", "B");

    // Les deux documents portent un `squareOne` unique et valide.
    assert_eq!(
        source
            .stage_nodes
            .iter()
            .filter(|stage| stage.is_square_one())
            .count(),
        1
    );
    assert!(readback.stage_nodes[0].is_square_one());

    let comparison = compare_structure(&source, &readback);
    assert_eq!(comparison.verdict, StructuralVerdict::NotEquivalent);
    assert!(comparison
        .codes()
        .contains(&DivergenceCode::EntryPointMoved));
    assert_eq!(
        comparison.entry_anchor,
        EntryAnchor::MovedTo {
            source_stage_index: 1,
            source_stage_name: "B".to_string(),
        }
    );
}

#[test]
fn an_unchanged_entry_point_is_verified_by_content() {
    let comparison = compare_structure(&ring_document("src", "A"), &ring_document("relu", "A"));
    assert_eq!(comparison.verdict, StructuralVerdict::Equivalent);
    assert_eq!(comparison.entry_anchor, EntryAnchor::Verified);
}

/// Un anneau parfaitement symétrique n'a pas de « bon » point de départ observable :
/// tous ses stages sont indiscernables. Le comparateur conclut à l'équivalence, et
/// c'est exact — il n'existe aucune observation qui les sépare.
#[test]
fn a_symmetric_ring_has_no_observable_entry_point() {
    let ring = |prefix: &str| {
        let id = |suffix: &str| format!("{prefix}-{suffix}");
        document(
            vec![
                ok_to(entry(autoplay(stage(&id("a"), "A"))), &id("a-b"), 0),
                ok_to(autoplay(stage(&id("b"), "B")), &id("b-c"), 0),
                ok_to(autoplay(stage(&id("c"), "C")), &id("c-a"), 0),
            ],
            vec![
                action(&id("a-b"), &[&id("b")]),
                action(&id("b-c"), &[&id("c")]),
                action(&id("c-a"), &[&id("a")]),
            ],
        )
    };
    let mut readback = ring("relu");
    readback.stage_nodes.rotate_left(1);
    readback.stage_nodes[0].square_one = Presence::Value(true);
    readback.stage_nodes[2].square_one = Presence::Value(false);

    assert_eq!(
        compare_structure(&ring("src"), &readback).verdict,
        StructuralVerdict::Equivalent
    );
}

// ---------------------------------------------------------------------------
// Parties non atteignables, ambiguïtés, défalcation
// ---------------------------------------------------------------------------

fn orphan(prefix: &str) -> StageNode {
    media(
        stage(&format!("{prefix}-orphelin"), "Orphelin"),
        Some("o.mp3"),
        None,
    )
}

#[test]
fn an_identical_unreachable_component_is_matched() {
    let mut source = source_document();
    source.stage_nodes.push(orphan("src"));
    let mut readback = readback_document();
    readback.stage_nodes.insert(0, orphan("relu"));
    // `squareOne` doit rester unique et porté par `A`.
    assert!(
        readback
            .stage_nodes
            .iter()
            .filter(|s| s.is_square_one())
            .count()
            == 1
    );
    assert_equivalent(&source, &readback);
}

#[test]
fn a_dropped_unreachable_stage_is_not_equivalent() {
    let mut source = source_document();
    source.stage_nodes.push(orphan("src"));
    let readback = readback_document();
    let divergences = assert_not_equivalent(&source, &readback, DivergenceCode::UnmatchedStage);
    assert!(divergences
        .iter()
        .any(|gap| gap.code == DivergenceCode::StageCount));
}

#[test]
fn an_added_unreachable_stage_is_not_equivalent() {
    let source = source_document();
    let mut readback = readback_document();
    readback.stage_nodes.push(orphan("relu"));
    assert_not_equivalent(&source, &readback, DivergenceCode::UnmatchedStage);
}

#[test]
fn a_source_without_square_one_is_ambiguous() {
    let mut source = source_document();
    stage_mut(&mut source, "A").square_one = Presence::Value(false);
    let comparison = compare_structure(&source, &readback_document());
    assert_eq!(comparison.verdict, StructuralVerdict::ComparisonAmbiguous);
    assert_eq!(
        comparison.ambiguities[0].code,
        AmbiguityCode::SourceEntryUndefined
    );
}

#[test]
fn a_source_with_several_square_one_is_ambiguous() {
    let mut source = source_document();
    stage_mut(&mut source, "C").square_one = Presence::Value(true);
    let comparison = compare_structure(&source, &readback_document());
    assert_eq!(comparison.verdict, StructuralVerdict::ComparisonAmbiguous);
    assert_eq!(
        comparison.ambiguities[0].code,
        AmbiguityCode::SourceEntryMultiple
    );
}

#[test]
fn duplicate_stage_identifiers_are_ambiguous() {
    let mut source = source_document();
    let duplicate = source.stage_nodes[1].uuid.clone();
    source.stage_nodes[2].uuid = duplicate;
    let comparison = compare_structure(&source, &readback_document());
    assert_eq!(comparison.verdict, StructuralVerdict::ComparisonAmbiguous);
    assert_eq!(
        comparison.ambiguities[0].code,
        AmbiguityCode::DuplicateStageId
    );
}

/// La liste de production est vide : l'instrumentation du lecteur ne relève aucune
/// perte sur les 71 packs filesystem du corpus. Ce test verrouille l'absence de défalcation
/// implicite — l'élargir demanderait un diagnostic, pas un smoke test qui échoue.
#[test]
fn the_production_deduction_list_is_empty() {
    assert!(v1_known_losses().is_empty());
}

/// Mais le mécanisme, lui, fonctionne : un écart reconnu comme perte du lecteur sort
/// des écarts imputés au convertisseur et change le verdict.
#[test]
fn a_known_reader_loss_is_deducted_from_the_converter() {
    let source = source_document();
    let mut readback = readback_document();
    stage_mut(&mut readback, "B").image = Presence::Null;

    let losses = vec![ReaderKnownLoss {
        question: "Q-test",
        code: DivergenceCode::ImagePresence,
        matches: |divergence: &Divergence| divergence.detail.contains("image source présent"),
    }];
    let comparison = compare_structure_with(
        &source,
        &readback,
        &ToleratedTransformations::default(),
        &losses,
    );

    assert_eq!(comparison.verdict, StructuralVerdict::ReaderKnownLoss);
    assert!(comparison.divergences.is_empty());
    assert_eq!(comparison.reader_known_losses.len(), 1);
    assert!(comparison.reader_known_losses[0]
        .detail
        .contains("perte connue du lecteur"));
}

/// Une perte connue ne blanchit que ce qu'elle couvre : le reste demeure imputé au
/// trajet testé.
#[test]
fn a_known_reader_loss_does_not_absolve_the_rest() {
    let source = source_document();
    let mut readback = readback_document();
    stage_mut(&mut readback, "B").image = Presence::Null;
    readback.night_mode_available = Presence::Value(true);

    let losses = vec![ReaderKnownLoss {
        question: "Q-test",
        code: DivergenceCode::ImagePresence,
        matches: |_: &Divergence| true,
    }];
    let comparison = compare_structure_with(
        &source,
        &readback,
        &ToleratedTransformations::default(),
        &losses,
    );

    assert_eq!(comparison.verdict, StructuralVerdict::NotEquivalent);
    assert_eq!(comparison.codes(), vec![DivergenceCode::NightMode]);
    assert_eq!(comparison.reader_known_losses.len(), 1);
}
