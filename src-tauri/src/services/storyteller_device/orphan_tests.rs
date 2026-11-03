//! « Tout remettre dans la liste » and empty sidecars after a disk check.
use super::*;
use crate::services::storyteller_device::cards::{
    Card, CardCatalogue, CatalogueCard, Resolution, DIRECTORY,
};
use crate::services::storyteller_device::orphans;
const D: Uuid = Uuid::from_u128(0x00000000000040008000000000000004);
const E: Uuid = Uuid::from_u128(0x00000000000040008000000000000005);
const G: Uuid = Uuid::from_u128(0x00000000000040008000000000000006);
const H: Uuid = Uuid::from_u128(0x00000000000040008000000000000007);
/// Same folder as C, other full identity.
const C2: Uuid = Uuid::from_u128(0x00000000000140008000000000000003);

struct OneCard;
impl OfficialCatalogue for OneCard {
    type Error = ();
    fn contains_official(&self, _: &str) -> std::result::Result<bool, ()> {
        Ok(false)
    }
}
impl CardCatalogue for OneCard {
    fn official_title(&self, _: Uuid) -> Result<Option<String>> {
        Ok(None)
    }
    fn card(&self, _: Uuid) -> Result<Option<CatalogueCard>> {
        Ok(Some(CatalogueCard {
            card: card("Depuis le catalogue"),
            cover_pending: false,
        }))
    }
    fn save_name(&self, _: Uuid, _: &str) -> Result<()> {
        Ok(())
    }
}
fn card(title: &str) -> Card {
    Card {
        title: title.into(),
        description: String::new(),
        age_min: None,
        age_max: None,
        cover_png: None,
    }
}
fn sidecar(f: &Fixture, id: Uuid, title: &str) {
    let dir = f.root.join(DIRECTORY);
    fs::create_dir_all(&dir).unwrap();
    let record =
        serde_json::json!({"version": 1, "uuid": id, "card": card(title), "pending_name": false});
    fs::write(dir.join(format!("{id}.json")), record.to_string()).unwrap();
}
fn pi(ids: &[Uuid]) -> Vec<u8> {
    ids.iter().flat_map(|v| *v.as_bytes()).collect()
}
/// Two D15 copies: [A, B, C, D] then, newer, [A, E, C, B]. Then a disk check
/// leaves only A listed; B, C, D, E (and G, incomplete) are orphans.
fn after_disk_check() -> Fixture {
    let f = Fixture::new();
    for id in [C, D, E, G] {
        f.story(id);
    }
    f.list(&[A, B, C, D]);
    f.device().apply(Action::Reorder(vec![A, B, D, C])).unwrap();
    f.list(&[A, E, C, B]);
    f.device().apply(Action::Reorder(vec![A, B, C, E])).unwrap();
    assert_eq!(f.backups().len(), 2);
    fs::remove_file(f.root.join(".content").join(folder(G)).join("si")).unwrap();
    f.list(&[A]);
    f
}
fn items(ids: &[Uuid]) -> Action {
    Action::RestoreOrphans(ids.iter().map(|id| (folder(*id), *id)).collect())
}

#[test]
fn restore_orphans_follows_latest_backup_then_given_order_in_one_write() {
    let f = after_disk_check();
    f.story(H);
    let before = f.backups().len();
    // Display order; H is known to no copy, G is incomplete.
    let outcome = f.device().apply(items(&[B, C, D, E, G, H])).unwrap();
    assert_eq!(outcome, Outcome::Complete);
    // E, C, B from the newest copy; D only from the older one; H last.
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, E, C, B, D, H]);
    // One D15 copy of the list before the single write.
    let mut backups = f.backups();
    backups.sort();
    assert_eq!(backups.len(), before + 1);
    assert_eq!(
        fs::read(backups.last().unwrap().join(".pi")).unwrap(),
        pi(&[A])
    );
    // The incomplete orphan stays out of the list, untouched.
    let inventory = f.inventory();
    let g = inventory
        .stories
        .iter()
        .find(|s| s.folder == folder(G))
        .unwrap();
    assert!(!g.listed && !g.complete && g.directory_present);
    assert!(fs::read_dir(&f.root).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".story-studio-pi-")));
    f.coherent();
    f.untouched();
}

#[test]
fn restore_orphans_from_an_empty_list() {
    let f = after_disk_check();
    f.list(&[]);
    f.device().apply(items(&[A, B, C, D, E])).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, E, C, B, D]);
    f.coherent();
}

#[test]
fn restore_orphans_refusals_write_nothing() {
    let f = after_disk_check();
    let before = (fs::read(f.root.join(".pi")).unwrap(), f.backups().len());
    for (action, error) in [
        (items(&[G]), Error::IncompleteStory),
        (Action::RestoreOrphans(vec![]), Error::MissingStory),
        (
            Action::RestoreOrphans(vec![(folder(C), C), (folder(B), C)]),
            Error::UnknownUuid,
        ),
        (items(&[C, C2]), Error::SuffixCollision),
        (items(&[A]), Error::SuffixCollision),
        (
            Action::RestoreOrphans(vec![("../etc".into(), C)]),
            Error::UnsafePath,
        ),
        (
            Action::RestoreOrphans(vec![(format!("parked:{}", folder(C)), C)]),
            Error::UnsafePath,
        ),
    ] {
        assert_eq!(f.device().apply(action), Err(error));
        assert_eq!(
            (fs::read(f.root.join(".pi")).unwrap(), f.backups().len()),
            before
        );
    }
    f.coherent();
}

#[test]
fn orphan_identity_from_backups_and_sidecars_must_agree() {
    let f = after_disk_check();
    f.story(H);
    let d = f.device();
    let lists = d.backup_lists();
    for id in [B, C, D, E] {
        assert_eq!(d.orphan_uuid(&lists, &folder(id)), Some(id));
    }
    assert_eq!(
        d.orphan_uuid(&lists, &format!("parked:{}", folder(C))),
        Some(C)
    );
    // No copy and no sidecar: no identity from the suffix alone.
    assert_eq!(d.orphan_uuid(&lists, &folder(H)), None);
    sidecar(&f, H, "Connue par sa fiche");
    assert_eq!(d.orphan_uuid(&lists, &folder(H)), Some(H));
    // A sidecar naming another UUID for the same folder: ambiguous.
    sidecar(&f, C2, "Autre");
    assert_eq!(d.orphan_uuid(&lists, &folder(C)), None);
    // Read-only resolution: the sidecar's title, nothing written.
    let cards_before = fs::read_dir(f.root.join(DIRECTORY)).unwrap().count();
    assert_eq!(
        d.orphan_resolution(H, Some(&OneCard)),
        Resolution::Known(card("Connue par sa fiche"))
    );
    assert_eq!(d.orphan_resolution(E, Some(&OneCard)), Resolution::Unknown);
    assert_eq!(
        fs::read_dir(f.root.join(DIRECTORY)).unwrap().count(),
        cards_before
    );
    // Without any D15 copy, nothing is known.
    fs::remove_dir_all(f.data.join("storyteller-backups")).unwrap();
    let lists = d.backup_lists();
    assert_eq!(d.orphan_uuid(&lists, &folder(B)), None);
    assert_eq!(lists.order(&[B, A]), vec![B, A]);
}

#[test]
fn zero_byte_device_memory_and_card_are_absent_then_rewritten() {
    let f = Fixture::new();
    f.story(C);
    f.list(&[A, B, C]);
    let dir = f.root.join(DIRECTORY);
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("device.json"), b"").unwrap();
    fs::write(dir.join(format!("{C}.json")), b"").unwrap();
    let d = f.device();
    assert_eq!(d.name().unwrap(), "Lunii 00000000000042");
    assert!(f.inventory().playlist_error.is_none());
    assert_eq!(d.orphan_card_uuid(&folder(C)), None);
    // A gesture is not degraded into a warning by the empty memory file.
    assert_eq!(
        d.apply(Action::Reorder(vec![B, A, C])),
        Ok(Outcome::Complete)
    );
    d.rename("Chambre".into()).unwrap();
    assert_eq!(d.name().unwrap(), "Chambre");
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("device.json")).unwrap()).unwrap();
    assert_eq!(saved["version"], 1);
    // The empty card is replaced by the catalogue's on the next synchronization.
    let report = d.sync_cards(&[C], &OneCard).unwrap();
    assert!(report.failures.is_empty());
    assert_eq!(
        report.resolutions,
        vec![Resolution::Known(card("Depuis le catalogue"))]
    );
    assert_eq!(d.orphan_card_uuid(&folder(C)), Some(C));
    // Zeros only (FAT clusters) are treated like an empty file.
    fs::write(dir.join("device.json"), [0u8; 64]).unwrap();
    assert_eq!(d.name().unwrap(), "Lunii 00000000000042");
    d.rename("Salon".into()).unwrap();
    assert_eq!(d.name().unwrap(), "Salon");
    f.coherent();
}

#[test]
fn contradicted_identity_is_exposed_and_refused_by_both_restores() {
    let f = after_disk_check();
    let d = f.device();
    // Copies say C for folder C; a catalogue may claim another UUID.
    assert_eq!(
        d.orphan_identity(&d.backup_lists(), &folder(C)),
        orphans::Identity::Known(C)
    );
    for action in [
        items(&[C2]),
        Action::Restore {
            folder: folder(C),
            known_uuid: Some(C2),
        },
    ] {
        assert_eq!(d.apply(action), Err(Error::UnknownUuid));
    }
    // A sidecar naming C2: the candidates contradict each other.
    sidecar(&f, C2, "Autre");
    assert_eq!(
        d.orphan_identity(&d.backup_lists(), &folder(C)),
        orphans::Identity::Contradicted
    );
    assert_eq!(
        d.orphan_identity(&d.backup_lists(), &folder(H)),
        orphans::Identity::Unknown
    );
    let before = (fs::read(f.root.join(".pi")).unwrap(), f.backups().len());
    for action in [
        items(&[C]),
        items(&[C2]),
        Action::Restore {
            folder: folder(C),
            known_uuid: Some(C),
        },
    ] {
        assert_eq!(d.apply(action), Err(Error::UnknownUuid));
    }
    assert_eq!(
        (fs::read(f.root.join(".pi")).unwrap(), f.backups().len()),
        before
    );
    // The others remain restorable.
    d.apply(items(&[B, E])).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, E, B]);
}

#[test]
fn identifying_copy_is_set_aside_until_no_orphan_depends_on_it() {
    let f = after_disk_check();
    f.story(H);
    f.list(&[A, H]);
    let d = f.device();
    for i in 0..12 {
        d.apply(Action::Reorder(if i % 2 == 0 {
            vec![H, A]
        } else {
            vec![A, H]
        }))
        .unwrap();
    }
    // Ten rotating copies plus the one that still identifies B, C and E
    // (D's older copy is set aside too: it is the only one naming D).
    assert_eq!(f.backups().len(), 12);
    let lists = d.backup_lists();
    for id in [B, C, D, E] {
        assert_eq!(d.orphan_uuid(&lists, &folder(id)), Some(id));
    }
    d.apply(items(&[B, C, D, E])).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, H, E, C, B, D]);
    // Nothing outside the list any more: the copies rejoin the rotation.
    let order = read::playlist(&f.root).unwrap();
    for i in 0..12 {
        let mut next = order.clone();
        if i % 2 == 0 {
            next.swap(0, 1);
        }
        d.apply(Action::Reorder(next)).unwrap();
    }
    assert_eq!(f.backups().len(), 10);
    f.coherent();
}

#[test]
fn damaged_list_cause_needs_one_copy_covering_orphans_and_current_list() {
    let f = after_disk_check();
    let lists = f.device().backup_lists();
    assert!(lists.explain_loss(&[E, C, B], &[A]));
    assert!(lists.explain_loss(&[E, C, B], &[]));
    assert!(!lists.explain_loss(&[B, C, D, E], &[A]));
    assert!(!lists.explain_loss(&[E], &[D]));
    assert!(!lists.explain_loss(&[], &[]));
    assert!(!lists.explain_loss(&[H], &[A]));
    // D is only in the older copy, and the newer one already listed A without D.
    assert!(!lists.explain_loss(&[D], &[A]));
}

#[test]
fn only_listed_or_hidden_stories_belong_to_the_list() {
    let f = after_disk_check();
    f.list(&[A, B]);
    let d = f.device();
    assert!(d.lists_story(A) && d.lists_story(B));
    assert!(!d.lists_story(C) && !d.lists_story(H));
    d.apply(Action::Hide(B)).unwrap();
    assert!(d.lists_story(B));
    fs::write(f.root.join(".pi"), [1u8; 17]).unwrap();
    assert!(!d.lists_story(A));
}

#[test]
fn emptied_list_after_a_disk_check_is_a_damaged_list() {
    let f = Fixture::new();
    f.story(C);
    f.list(&[A, B, C]);
    f.device().apply(Action::Reorder(vec![C, B, A])).unwrap();
    f.list(&[]);
    let d = f.device();
    assert!(d.list_lost(&d.backup_lists(), &[A, B, C], &[]));
    // Also when the cut kept the first entries.
    f.list(&[C]);
    assert!(d.list_lost(&d.backup_lists(), &[B, A], &[C]));
}

#[test]
fn interrupted_removal_is_not_a_damaged_list() {
    let f = Fixture::new();
    f.story(C);
    f.list(&[A, B, C]);
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(d.apply(Action::Remove(C)), Ok(Outcome::RemovedWithOrphan));
    assert!(f.root.join(".content").join(folder(C)).is_dir());
    let d = f.device();
    let lists = d.backup_lists();
    // The copy taken before the removal alone would explain it as a loss.
    assert!(lists.explain_loss(&[C], &[A, B]));
    assert!(!d.list_lost(&lists, &[C], &[A, B]));
    // Putting it back explicitly clears the record.
    d.apply(items(&[C])).unwrap();
    d.apply(Action::Reorder(vec![C, B, A])).unwrap();
    assert!(
        !fs::read_to_string(f.root.join(DIRECTORY).join("device.json"))
            .unwrap()
            .contains(&C.to_string())
    );
}

#[test]
fn interrupted_send_of_a_removed_story_is_not_a_damaged_list() {
    let f = Fixture::new();
    f.story(C);
    f.list(&[A, B, C]);
    let d = f.device();
    d.apply(Action::Remove(C)).unwrap();
    d.apply(Action::Reorder(vec![B, A])).unwrap();
    // The send was cut after its folder was renamed, before the list entry.
    f.story(C);
    let lists = d.backup_lists();
    assert!(!lists.explain_loss(&[C], &[B, A]));
    assert!(!d.list_lost(&lists, &[C], &[B, A]));
}

#[test]
fn folder_gone_since_display_is_left_out_of_the_batch() {
    let f = after_disk_check();
    fs::remove_dir_all(f.root.join(".content").join(folder(C))).unwrap();
    f.device().apply(items(&[B, C, E])).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, E, B]);
    fs::remove_dir_all(f.root.join(".content").join(folder(D))).unwrap();
    assert_eq!(f.device().apply(items(&[D])), Err(Error::IncompleteStory));
    f.coherent();
}
