//! Contrôles du comparateur sur le **vrai** trajet de relecture.
//!
//! Les documents relus ne sont pas écrits à la main : un pack filesystem synthétique
//! est posé sur disque, puis repassé par `fs_pack_reader` exactement comme à l'import.
//! Ce qui est vérifié ici, c'est donc le couple comparateur + lecteur, y compris les
//! UUID régénérés et le `squareOne` posé sur l'indice 0 par construction.
//!
//! Aucune passerelle tierce n'est nécessaire : ces contrôles tournent partout.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::native_pack::{
    named_option_targets, ActionNode, ControlSettings, Position, Presence, StageNode,
    StoryDocument, Transition,
};
use crate::support::fs_pack_diagnostics::fixtures::{write_fixture_pack, FixtureStage};

use super::campaign::read_fs_document;
use super::{compare_structure, DivergenceCode, EntryAnchor, StructuralVerdict};

const PACK_NAME: &str = "11111111-2222-3333-4444-555555555555";

fn temp_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("horloge après epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "story_studio_d0b_compare_{label}_{}_{}",
        std::process::id(),
        nonce
    ))
}

/// Un stage `ni` sans média, avec une transition OK à une seule destination.
fn fs_stage(li_offset: i32) -> FixtureStage {
    FixtureStage {
        ok: Some((li_offset, 1, 0)),
        ..FixtureStage::default()
    }
}

/// Écrit le pack, le relit par le chemin de production, rend le document.
fn readback(label: &str, stages: &[FixtureStage], li: &[i32]) -> (StoryDocument, PathBuf) {
    let root = temp_dir(label);
    let pack_dir = root.join(PACK_NAME);
    write_fixture_pack(&pack_dir, stages, li);
    let (document, _report) =
        read_fs_document(&pack_dir, &root.join("relecture"), "Pack synthétique")
            .expect("relecture du pack filesystem");
    (document, root)
}

/// Ces fixtures synthétiques ne portent aucune position d'auteur : le
/// comparateur structurel ne regarde pas la disposition, et un `{0,0}`
/// inventé serait une présence que le document source n'a jamais eue.
fn no_authored_position() -> Presence<Position> {
    Presence::Absent
}

/// Le document source correspondant : `A -OK-> B -OK-> C -OK-> B`.
///
/// Les identifiants sont volontairement sans rapport avec ceux que le lecteur
/// régénérera.
fn source_ring() -> StoryDocument {
    let stage = |uuid: &str, name: &str, square_one: bool, action: &str| StageNode {
        uuid: uuid.to_string(),
        name: Presence::Value(name.to_string()),
        stage_type: Presence::Value("stage".to_string()),
        square_one: Presence::Value(square_one),
        audio: Presence::Null,
        image: Presence::Null,
        control_settings: Presence::Value(ControlSettings::authored(
            false, true, false, false, false,
        )),
        home_transition: Presence::Null,
        ok_transition: Presence::Value(Transition::fixed(action, 0)),
        position: no_authored_position(),
        group_id: Presence::Absent,
    };
    let action = |id: &str, target: &str| ActionNode {
        id: id.to_string(),
        name: Presence::Value(id.to_string()),
        options: named_option_targets(vec![target.to_string()]),
        position: no_authored_position(),
        action_type: Presence::Absent,
        group_id: Presence::Absent,
    };
    StoryDocument {
        title: Presence::Value("anneau source".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: vec![
            action("src-a-vers-b", "src-b"),
            action("src-b-vers-c", "src-c"),
            action("src-c-vers-b", "src-b"),
        ],
        stage_nodes: vec![
            stage("src-a", "A", true, "src-a-vers-b"),
            stage("src-b", "B", false, "src-b-vers-c"),
            stage("src-c", "C", false, "src-c-vers-b"),
        ],
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
    }
}

/// `ni` dans l'ordre `[A, B, C]`, `li = [B, C, B]` : le pack qu'un convertisseur
/// fidèle produirait.
#[test]
fn a_faithful_filesystem_pack_reads_back_as_equivalent() {
    let (document, root) = readback(
        "fidele",
        &[fs_stage(0), fs_stage(1), fs_stage(2)],
        &[1, 2, 1],
    );
    let comparison = compare_structure(&source_ring(), &document);
    fs::remove_dir_all(&root).expect("nettoyage");

    assert_eq!(
        comparison.verdict,
        StructuralVerdict::Equivalent,
        "{:?}",
        comparison.divergences
    );
    assert_eq!(comparison.entry_anchor, EntryAnchor::Verified);
    assert_eq!(comparison.matched_stage_count, 3);
}

/// Même graphe, `ni` réordonné en `[A, C, B]`. Le réordonnancement physique au-delà
/// du point d'entrée est déclaré légitime : il ne doit rien changer.
#[test]
fn physical_reordering_of_the_ni_table_reads_back_as_equivalent() {
    // Indices `ni` : 0 = A, 1 = C, 2 = B. A -> B (2), C -> B (2), B -> C (1).
    let (document, root) = readback(
        "reordonne",
        &[fs_stage(0), fs_stage(1), fs_stage(2)],
        &[2, 2, 1],
    );
    let comparison = compare_structure(&source_ring(), &document);
    fs::remove_dir_all(&root).expect("nettoyage");

    assert_eq!(
        comparison.verdict,
        StructuralVerdict::Equivalent,
        "{:?}",
        comparison.divergences
    );
}

/// **Le piège du drapeau `squareOne`.** Le convertisseur a écrit `B` en
/// position 0 : le pack ne démarre plus au même endroit. Le drapeau `squareOne`
/// du document relu est valide — le lecteur le pose toujours sur l'indice 0 —
/// et une comparaison de drapeaux conclurait donc à tort à l'égalité.
#[test]
fn an_entry_point_moved_in_the_ni_table_is_not_equivalent() {
    // Indices `ni` : 0 = B, 1 = C, 2 = A. B -> C (1), C -> B (0), A -> B (0).
    let (document, root) = readback(
        "entree-deplacee",
        &[fs_stage(0), fs_stage(1), fs_stage(2)],
        &[1, 0, 0],
    );
    assert!(
        document.stage_nodes[0].is_square_one(),
        "le lecteur pose squareOne sur l'indice 0 quoi qu'il arrive"
    );
    let comparison = compare_structure(&source_ring(), &document);
    fs::remove_dir_all(&root).expect("nettoyage");

    assert_eq!(comparison.verdict, StructuralVerdict::NotEquivalent);
    assert!(
        comparison
            .codes()
            .contains(&DivergenceCode::EntryPointMoved),
        "{:?}",
        comparison.divergences
    );
    assert_eq!(
        comparison.entry_anchor,
        EntryAnchor::MovedTo {
            source_stage_index: 1,
            source_stage_name: "B".to_string(),
        }
    );
    // Le nombre de stages, lui, n'a pas bougé : un comparateur de compteurs n'aurait
    // rien vu.
    assert_eq!(
        comparison.source_stage_count,
        comparison.readback_stage_count
    );
}

/// Modification réelle de navigation : le retour `C -> B` devient un self-loop
/// `C -> C`. Compteurs identiques, navigation différente.
#[test]
fn a_rewired_return_edge_is_not_equivalent() {
    let (document, root) = readback(
        "retour-modifie",
        &[fs_stage(0), fs_stage(1), fs_stage(2)],
        &[1, 2, 2],
    );
    let comparison = compare_structure(&source_ring(), &document);
    fs::remove_dir_all(&root).expect("nettoyage");

    assert_eq!(comparison.verdict, StructuralVerdict::NotEquivalent);
    assert_eq!(
        comparison.source_stage_count,
        comparison.readback_stage_count
    );
    assert!(
        comparison
            .codes()
            .contains(&DivergenceCode::DestinationSharing),
        "{:?}",
        comparison.divergences
    );
}

/// Cycle aplati : `A -> B -> C` avec retour `C -> B` ressort en
/// `A -> B -> C -> B2`, une copie de `B`. Le pack livré ne correspond plus à ce que
/// l'utilisateur a édité.
#[test]
fn a_flattened_cycle_read_from_a_real_pack_is_not_equivalent() {
    // 0 = A, 1 = B, 2 = C, 3 = B2. A -> B, B -> C, C -> B2, B2 -> C.
    let (document, root) = readback(
        "cycle-aplati",
        &[fs_stage(0), fs_stage(1), fs_stage(2), fs_stage(3)],
        &[1, 2, 3, 2],
    );
    let comparison = compare_structure(&source_ring(), &document);
    fs::remove_dir_all(&root).expect("nettoyage");

    assert_eq!(comparison.verdict, StructuralVerdict::NotEquivalent);
    assert!(
        comparison.codes().contains(&DivergenceCode::StageCount),
        "{:?}",
        comparison.divergences
    );
}

/// Le plus gros document du corpus 0.9.9 compte 7 063 stages.
/// Ce contrôle pose un pack filesystem de cette taille, le relit, puis compare le
/// document à une copie dont **tous** les identifiants sont régénérés et l'ordre
/// physique inversé — les deux transformations déclarées légitimes, à l'échelle. Il
/// vérifie ensuite qu'une seule arête modifiée au fond de l'anneau reste visible.
#[test]
fn the_comparator_holds_at_the_scale_of_the_largest_corpus_pack() {
    const STAGES: usize = 7_063;

    // Anneau `0 → 1 → … → n-1 → 0`, chaque stage portant sa propre entrée `li`.
    let fs_stages: Vec<FixtureStage> = (0..STAGES).map(|index| fs_stage(index as i32)).collect();
    let li: Vec<i32> = (0..STAGES)
        .map(|index| ((index + 1) % STAGES) as i32)
        .collect();
    let (reference, root) = readback("echelle", &fs_stages, &li);
    fs::remove_dir_all(&root).expect("nettoyage");
    assert_eq!(reference.stage_nodes.len(), STAGES);

    let faithful = renamed_and_reordered(&reference);
    let mut rewired = faithful.clone();
    // Une seule arête change, au milieu de l'anneau : le retour saute un stage.
    let jumped = rewired.stage_nodes[(STAGES / 2 + 2) % STAGES].uuid.clone();
    let action_id = rewired.stage_nodes[STAGES / 2]
        .ok_transition
        .value()
        .expect("transition OK")
        .action_node
        .clone();
    let action = rewired
        .action_nodes
        .iter_mut()
        .find(|action| action.id == action_id)
        .expect("action de la victime");
    assert_ne!(
        action.options[0].as_deref(),
        Some(jumped.as_str()),
        "l'arête doit réellement changer"
    );
    action.options[0] = Some(jumped);

    let equivalent = compare_structure(&reference, &faithful);
    assert_eq!(
        equivalent.verdict,
        StructuralVerdict::Equivalent,
        "{:?}",
        equivalent.divergences
    );
    assert_eq!(equivalent.matched_stage_count, STAGES);

    let divergent = compare_structure(&reference, &rewired);
    assert_eq!(
        divergent.verdict,
        StructuralVerdict::NotEquivalent,
        "une arête modifiée au fond d'un anneau de {STAGES} stages doit rester visible"
    );
}

/// Copie du document avec identifiants régénérés et table de stages inversée : ce que
/// produisent conjointement `fs_pack_reader` et le réordonnancement du writer tiers.
fn renamed_and_reordered(document: &StoryDocument) -> StoryDocument {
    let rename = |id: &str| format!("relu-{id}");
    let mut copy = document.clone();
    for stage in &mut copy.stage_nodes {
        stage.uuid = rename(&stage.uuid);
        for transition in [
            stage.ok_transition.value_mut(),
            stage.home_transition.value_mut(),
        ]
        .into_iter()
        .flatten()
        {
            transition.action_node = rename(&transition.action_node);
        }
    }
    for action in &mut copy.action_nodes {
        action.id = rename(&action.id);
        for option in &mut action.options {
            *option = option.as_deref().map(rename);
        }
    }
    // Le point d'entrée reste en tête, comme le lecteur le pose ; tout le reste bouge.
    copy.stage_nodes[1..].reverse();
    copy
}
