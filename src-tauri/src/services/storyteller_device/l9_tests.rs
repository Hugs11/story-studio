use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
struct Room {
    free: u64,
    unit: u64,
    writable: bool,
}
impl Volumes for Room {
    fn mounted_removable(&self) -> Result<Vec<PathBuf>> {
        Ok(vec![])
    }
    fn capacity(&self, _: &Path) -> Result<(u64, u64)> {
        Ok((self.free, self.free))
    }
    fn allocation_unit(&self, _: &Path) -> Result<u64> {
        Ok(self.unit)
    }
    fn writable(&self, _: &Path) -> Result<bool> {
        Ok(self.writable)
    }
}
fn room() -> Room {
    Room {
        free: 64 * 1024 * 1024,
        unit: 32768,
        writable: true,
    }
}
fn staged(f: &Fixture, id: Uuid) -> crate::services::storyteller::cipher::EncryptedStory {
    if !f.root.join(".content").join(folder(id)).exists() {
        f.story(id);
    }
    let source = f.base.join(format!("staged-{}", folder(id)));
    fs::rename(f.root.join(".content").join(folder(id)), &source).unwrap();
    encrypt(f, id, source)
}
fn encrypt(
    f: &Fixture,
    id: Uuid,
    source: PathBuf,
) -> crate::services::storyteller::cipher::EncryptedStory {
    let output = f.base.join(format!("encrypted-{}", Uuid::new_v4()));
    fs::create_dir(&output).unwrap();
    crate::services::storyteller::cipher::V6Cipher::from_metadata(&f.root)
        .unwrap()
        .encrypt_story(
            &crate::services::storyteller::PlainStory {
                path: source,
                total_bytes: 0,
                uuid: id,
            },
            &output,
            &AtomicBool::new(false),
        )
        .unwrap()
}
fn action(
    story: crate::services::storyteller::cipher::EncryptedStory,
    position: Option<usize>,
) -> Action {
    Action::Install {
        story,
        position,
        cancel: Arc::new(AtomicBool::new(false)),
        progress: None,
    }
}
#[test]
fn install_in_middle_and_duplicate_is_a_prewrite_refusal() {
    let f = Fixture::new();
    let story = staged(&f, C);
    let source = story.path.clone();
    f.device()
        .apply_with_catalogue(action(story, Some(1)), &room(), Some(&Catalogue))
        .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, C, B]);
    f.coherent();
    let count = f.backups().len();
    let duplicate = encrypt(&f, C, source);
    assert_eq!(
        f.device()
            .apply_with_catalogue(action(duplicate, None), &room(), Some(&Catalogue)),
        Err(Error::Duplicate { position: Some(1) })
    );
    assert_eq!(f.backups().len(), count);
}
#[test]
fn install_reports_bytes_copied_then_finalizing_once_after_the_last_byte() {
    let f = Fixture::new();
    let story = staged(&f, C);
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    f.device()
        .apply_with_catalogue(
            Action::Install {
                story,
                position: None,
                cancel: Arc::new(AtomicBool::new(false)),
                progress: Some(Box::new(move |event| seen.lock().unwrap().push(event))),
            },
            &room(),
            Some(&Catalogue),
        )
        .unwrap();
    let events = events.lock().unwrap();
    assert_eq!(events.last(), Some(&CopyEvent::Finalizing));
    assert_eq!(
        events
            .iter()
            .filter(|e| **e == CopyEvent::Finalizing)
            .count(),
        1
    );
    assert!(events.len() > 1);
    assert!(events[..events.len() - 1]
        .iter()
        .all(|e| matches!(e, CopyEvent::Copied { .. })));
}
#[test]
fn exact_e0_size_includes_empty_directories_and_zero_length_files() {
    let f = Fixture::new();
    let path = f.base.join("allocation");
    fs::create_dir(&path).unwrap();
    fs::create_dir(path.join("empty")).unwrap();
    for (name, size) in [("a", 0), ("b", 1), ("c", 32768), ("d", 32769)] {
        fs::write(path.join(name), vec![0; size]).unwrap();
    }
    assert_eq!(install::allocated_size(&path, 32768).unwrap(), 6 * 32768);
    assert_eq!(
        install::allocated_size(&path, 0),
        Err(Error::NoSpace {
            missing_bytes: u64::MAX
        })
    );
}
#[test]
fn insufficient_capacity_and_read_only_do_not_write() {
    for writable in [true, false] {
        let f = Fixture::new();
        let story = staged(&f, C);
        let mut v = room();
        v.free = 1;
        v.writable = writable;
        assert_eq!(
            f.device()
                .apply_with_catalogue(action(story, None), &v, Some(&Catalogue)),
            Err(if writable {
                Error::NoSpace {
                    missing_bytes: 60 * 32768 - 1,
                }
            } else {
                Error::ReadOnly
            })
        );
        assert!(f.backups().is_empty());
        assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    }
}
#[test]
fn damaged_list_and_official_story_refuse_before_copy() {
    let f = Fixture::new();
    let story = staged(&f, A); // listed, but the source is official first
    assert_eq!(
        f.device()
            .apply_with_catalogue(action(story, None), &room(), Some(&Catalogue)),
        Err(Error::PlaylistDamaged)
    );
    let f = Fixture::new();
    f.list(&[B]);
    let story = staged(&f, A);
    assert_eq!(
        f.device()
            .apply_with_catalogue(action(story, None), &room(), Some(&Catalogue)),
        Err(Error::OfficialStory)
    );
    assert!(f.backups().is_empty());
}
#[test]
fn cancellation_before_copy_never_enters_playlist() {
    let f = Fixture::new();
    let story = staged(&f, C);
    assert_eq!(
        f.device().apply_with_catalogue(
            Action::Install {
                story,
                position: None,
                cancel: Arc::new(AtomicBool::new(true)),
                progress: None,
            },
            &room(),
            Some(&Catalogue)
        ),
        Err(Error::Cancelled)
    );
    f.coherent();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}
#[test]
fn every_copy_and_playlist_cut_preserves_existing_entries_and_no_dangling_uuid() {
    for step in 0..70 {
        let f = Fixture::new();
        let story = staged(&f, C);
        let mut device = f.device();
        device.fail_at = Some(step);
        let result = device.apply_with_catalogue(action(story, Some(1)), &room(), Some(&Catalogue));
        f.coherent();
        let ids = read::playlist(&f.root).unwrap();
        assert!(ids.contains(&A) && ids.contains(&B));
        if result == Err(Error::Interrupted) && !ids.contains(&C) {
            assert!(!f
                .root
                .join(".content")
                .join(format!(".story-studio-install-{C}"))
                .exists());
        }
    }
}
#[test]
fn hidden_order_survives_reorder_and_show() {
    let f = Fixture::new();
    f.story(C);
    f.list(&[A, B, C]);
    f.device().apply(Action::Hide(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, C]);
    let inventory = f.inventory();
    assert_eq!(
        inventory
            .stories
            .iter()
            .map(|s| s.uuid.unwrap())
            .collect::<Vec<_>>(),
        vec![A, B, C]
    );
    assert!(inventory.stories[1].probable_hidden);
    assert_eq!(
        f.device().apply(Action::DeleteOrphan(folder(B))),
        Err(Error::HiddenStory)
    );
    f.device().apply(Action::Reorder(vec![C, B, A])).unwrap();
    f.device().apply(Action::Show(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![C, B, A]);
    assert!(state::load(&f.root).hidden.is_empty());
}
#[test]
fn hide_show_same_position_and_hidden_removal() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(A)).unwrap();
    f.device().apply(Action::Show(A)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.device().apply(Action::Hide(B)).unwrap();
    f.device().apply(Action::Remove(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    assert!(!f.root.join(".content").join(folder(B)).exists());
}
#[test]
fn device_name_default_persistence_and_tolerant_state() {
    let f = Fixture::new();
    assert_eq!(f.device().name().unwrap(), "Lunii 00000000000042");
    f.device().rename("Salon".into()).unwrap();
    assert_eq!(f.device().name().unwrap(), "Salon");
    assert_eq!(f.device().rename("\n".into()), Err(Error::InvalidName));
    fs::write(f.root.join(".storystudio/device.json"), b"broken").unwrap();
    assert_eq!(f.device().name().unwrap(), "Lunii 00000000000042");
}
#[test]
fn eject_refuses_during_driver_mutation_without_calling_any_native_api() {
    let mutation = writes::mutation(Path::new("/fake"));
    let _lock = mutation.lock().unwrap();
    assert_eq!(
        platform::eject(&platform::Volume {
            native_id: "/fake".into(),
            root: None
        }),
        Err(Error::Busy)
    );
}
#[test]
fn cancelled_flag_can_be_shared_with_catalogue_operation() {
    let cancel = Arc::new(AtomicBool::new(false));
    let other = Arc::clone(&cancel);
    other.store(true, Ordering::SeqCst);
    let f = Fixture::new();
    let story = staged(&f, C);
    assert_eq!(
        f.device().apply_with_catalogue(
            Action::Install {
                story,
                position: None,
                cancel,
                progress: None,
            },
            &room(),
            Some(&Catalogue)
        ),
        Err(Error::Cancelled)
    );
    f.coherent();
}

#[test]
fn two_devices_installation_is_bound_to_the_target_metadata() {
    let first = Fixture::new();
    let second = Fixture::new();
    let mut md = fs::read(second.root.join(".md")).unwrap();
    md[26..40].copy_from_slice(b"00000000000043");
    md[64..96].fill(33);
    fs::write(second.root.join(".md"), md).unwrap();
    let encrypted = staged(&first, C);
    assert!(encrypted.matches_device(&first.root));
    assert!(!encrypted.matches_device(&second.root));
    assert_eq!(
        second
            .device()
            .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue)),
        Err(Error::Changed)
    );
    assert!(second.backups().is_empty());
    second.coherent();
}

#[test]
fn hidden_positions_follow_insertions_and_removals() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    let story = staged(&f, C);
    f.device()
        .apply_with_catalogue(action(story, Some(1)), &room(), Some(&Catalogue))
        .unwrap();
    let full: Vec<_> = f
        .inventory()
        .stories
        .iter()
        .map(|s| s.uuid.unwrap())
        .collect();
    assert_eq!(full, vec![A, C, B]);
    f.device().apply(Action::Remove(A)).unwrap();
    f.device().apply(Action::Show(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![C, B]);
}

#[test]
fn cancellation_during_copy_removes_our_temporary() {
    let f = Fixture::new();
    let story = staged(&f, C);
    let mut d = f.device();
    d.after_install_chunk = Some(|cancel| cancel.store(true, Ordering::SeqCst));
    assert_eq!(
        d.apply_with_catalogue(action(story, None), &room(), Some(&Catalogue)),
        Err(Error::Cancelled)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
    let inventory = f.inventory();
    assert!(inventory.stories.iter().all(|s| s.listed));
    assert!(!f
        .root
        .join(".content")
        .join(format!(".story-studio-install-{C}"))
        .exists());
}

#[test]
fn installation_reports_non_durable_publication_but_keeps_the_complete_story() {
    let f = Fixture::new();
    let story = staged(&f, C);
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(
        d.apply_with_catalogue(action(story, None), &room(), Some(&Catalogue)),
        Ok(Outcome::InstalledNotDurable)
    );
    f.coherent();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B, C]);
}

#[test]
fn unknown_creation_uses_its_first_screen_but_official_preview_is_never_decrypted() {
    let f = Fixture::new();
    f.story(C);
    let path = f.root.join(".content").join(folder(C));
    let mut bmp = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(320, 240, image::Rgb([20, 30, 40]))
        .write_to(&mut bmp, image::ImageFormat::Bmp)
        .unwrap();
    fs::write(path.join("rf/000/00000000"), bmp.into_inner()).unwrap();
    let mut ri = b"000\\00000000".to_vec();
    ri.resize(16, 0);
    fs::write(path.join("ri"), ri).unwrap();
    let encrypted = staged(&f, C);
    f.device()
        .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
        .unwrap();
    let cover = f.device().first_screen(C, &Catalogue).unwrap();
    assert_eq!(
        image::guess_format(&cover).unwrap(),
        image::ImageFormat::Png
    );
    assert!(f.device().first_screen(A, &Catalogue).is_none());

    // A name-only sidecar changes Unknown into Known without adding an image.
    // Its preview must stay identical, including after reopening the device.
    use crate::services::storyteller_device::cards as device_cards;
    struct Names;
    impl OfficialCatalogue for Names {
        type Error = ();
        fn contains_official(&self, id: &str) -> std::result::Result<bool, ()> {
            Catalogue.contains_official(id)
        }
    }
    impl device_cards::CardCatalogue for Names {
        fn official_title(&self, _: Uuid) -> Result<Option<String>> {
            Ok(None)
        }
        fn card(&self, _: Uuid) -> Result<Option<device_cards::CatalogueCard>> {
            Ok(None)
        }
        fn save_name(&self, _: Uuid, _: &str) -> Result<()> {
            Ok(())
        }
    }
    assert_eq!(
        f.device().resolve_card(C, Some(&Names)).unwrap(),
        device_cards::Resolution::Unknown
    );
    f.device()
        .name_card(C, &Names, "Mon histoire".into())
        .unwrap();
    let device_cards::Resolution::Known(mut card) =
        f.device().resolve_card(C, Some(&Names)).unwrap()
    else {
        panic!("name-only sidecar missing")
    };
    assert_eq!(card.title, "Mon histoire");
    assert!(card.cover_png.is_none());
    assert_eq!(f.device().check_creation_cover(C, &card, &Names), Ok(()));
    assert_eq!(
        f.device().check_creation_cover(A, &card, &Names),
        Err(Error::OfficialStory)
    );
    let sidecar = fs::read(f.root.join(".storystudio").join(format!("{C}.json"))).unwrap();
    assert_eq!(
        f.device().read_creation_cover(C, &card, &Names).unwrap(),
        cover
    );
    assert_eq!(
        fs::read(f.root.join(".storystudio").join(format!("{C}.json"))).unwrap(),
        sidecar,
        "preview remains read-only"
    );
    assert_eq!(
        f.device().read_creation_cover(A, &card, &Names),
        Err(Error::OfficialStory)
    );
    fs::remove_file(path.join("rf/000/00000000")).unwrap();
    assert!(f.device().check_creation_cover(C, &card, &Names).is_err());
    assert!(
        f.device().read_creation_cover(C, &card, &Names).is_err(),
        "missing first screen remains an unavailable cover"
    );
    card.cover_png = Some(cover.clone());
    assert_eq!(f.device().check_creation_cover(C, &card, &Names), Ok(()));
    assert_eq!(
        f.device().read_creation_cover(C, &card, &Names).unwrap(),
        cover,
        "sidecar image takes priority even without a first screen"
    );
}

#[test]
fn allocation_preflight_accepts_the_exact_e0_boundary_and_refuses_one_byte_less() {
    // Fixture: 7 short files, 5 directories. Reserve: 1 .pi unit,
    // 8 directory-entry units, 39 units for the card + device-state temporary.
    let required = 60 * 32768;
    for (free, expected) in [
        (required - 1, Err(Error::NoSpace { missing_bytes: 1 })),
        (required, Ok(Outcome::Complete)),
    ] {
        let f = Fixture::new();
        let story = staged(&f, C);
        let mut volumes = room();
        volumes.free = free;
        assert_eq!(
            f.device()
                .apply_with_catalogue(action(story, None), &volumes, Some(&Catalogue)),
            expected
        );
        f.coherent();
    }
}

#[test]
fn playlist_from_another_tool_overrides_hidden_memory_on_read_and_write() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    fs::rename(
        state::story_path(&f.root, B),
        f.root.join(".content").join(folder(B)),
    )
    .unwrap();
    f.list(&[B, A]);
    assert!(read::hidden(&f.root).unwrap().is_empty());
    assert!(f.inventory().stories.iter().all(|s| !s.probable_hidden));
    let encrypted = staged(&f, C);
    f.device()
        .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
        .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A, C]);
    f.device().apply(Action::Reorder(vec![C, B, A])).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![C, B, A]);
    assert!(state::load(&f.root).hidden.is_empty());
}
#[test]
fn deleted_hidden_folder_can_be_sent_again_and_actually_enters_playlist() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    fs::remove_dir_all(state::story_path(&f.root, B)).unwrap();
    assert!(read::hidden(&f.root).unwrap().is_empty());
    assert_eq!(f.inventory().stories.len(), 1);
    let encrypted = staged(&f, B);
    f.device()
        .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
        .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    assert!(state::load(&f.root).hidden.is_empty());
    f.device().mark_sent(B).unwrap();
    assert!(f.device().sent_at(B).is_some());
    f.device().apply(Action::Remove(B)).unwrap();
    assert!(f.device().sent_at(B).is_none());
}
#[test]
fn hidden_payload_survives_replacement_of_content_and_playlist_by_lunii() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    let parked = f.root.join(".storystudio/masquees").join(folder(B));
    assert!(parked.is_dir());
    assert!(!f.root.join(".content").join(folder(B)).exists());
    fs::remove_dir_all(f.root.join(".content")).unwrap();
    fs::create_dir(f.root.join(".content")).unwrap();
    f.list(&[]);
    let inventory = f.inventory();
    assert_eq!(inventory.stories.len(), 1);
    assert_eq!(inventory.stories[0].uuid, Some(B));
    assert!(inventory.stories[0].complete && inventory.stories[0].probable_hidden);
    f.device().apply(Action::Show(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B]);
    f.coherent();
}
#[test]
fn hide_cut_after_playlist_before_move_remains_actionable() {
    let f = Fixture::new();
    let device = f.device();
    let md = read::metadata(&f.root).unwrap();
    let state = state::normalized(&f.root, &[A, B]);
    let (next, _) = device
        .transition(
            vec![A, B],
            state,
            state::Phase::Prepare(Some((B, true))),
            &md,
        )
        .unwrap();
    // Simulated cut immediately after durable .pi publication.
    f.list(&next);
    assert!(f.root.join(".content").join(folder(B)).is_dir());
    let story = f
        .inventory()
        .stories
        .into_iter()
        .find(|s| s.uuid == Some(B))
        .unwrap();
    assert!(story.probable_hidden && !story.listed);
    f.device().apply(Action::Hide(B)).unwrap();
    assert!(f
        .root
        .join(".storystudio/masquees")
        .join(folder(B))
        .is_dir());
    assert!(!f.root.join(".content").join(folder(B)).exists());
    f.coherent();
}
#[test]
fn show_cut_after_move_before_playlist_is_still_hidden_and_retryable() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    let device = f.device();
    let md = read::metadata(&f.root).unwrap();
    let state = state::normalized(&f.root, &[A]);
    device
        .transition(
            vec![A, B],
            state,
            state::Phase::Prepare(Some((B, false))),
            &md,
        )
        .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    assert_eq!(read::hidden(&f.root).unwrap(), vec![B]);
    assert!(f.root.join(".content").join(folder(B)).is_dir());
    f.device().apply(Action::Show(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}
#[test]
fn legacy_hidden_memory_is_migrated_at_next_write() {
    let f = Fixture::new();
    fs::create_dir(f.root.join(".storystudio")).unwrap();
    fs::write(
        f.root.join(".storystudio/device.json"),
        serde_json::to_vec(
            &serde_json::json!({"version":1,"state":{"hidden":[{"uuid":B,"position":1}]}}),
        )
        .unwrap(),
    )
    .unwrap();
    f.list(&[A]);
    assert_eq!(read::hidden(&f.root).unwrap(), vec![B]);
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    assert!(f
        .root
        .join(".storystudio/masquees")
        .join(folder(B))
        .is_dir());
    f.device().apply(Action::Show(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
}
#[test]
fn third_party_hidden_list_uses_same_order_show_and_remove_as_inventory() {
    for show in [false, true] {
        let f = Fixture::new();
        f.list(&[A]);
        fs::write(f.root.join(".pi.hidden"), B.as_bytes()).unwrap();
        assert!(f
            .inventory()
            .stories
            .iter()
            .any(|s| s.uuid == Some(B) && s.probable_hidden));
        f.device().apply(Action::Reorder(vec![B, A])).unwrap();
        f.device()
            .apply(if show {
                Action::Show(B)
            } else {
                Action::Remove(B)
            })
            .unwrap();
        assert!(read::playlist_file(&f.root.join(".pi.hidden"))
            .unwrap()
            .is_empty());
        assert!(read::hidden(&f.root).unwrap().is_empty());
        assert_eq!(
            read::playlist(&f.root).unwrap(),
            if show { vec![B, A] } else { vec![A] }
        );
    }
}
#[test]
fn corrupt_device_state_is_preserved_and_committed_playlist_returns_warning() {
    let f = Fixture::new();
    f.device().rename("test".into()).unwrap();
    let state_path = f.root.join(".storystudio/device.json");
    fs::write(&state_path, b"broken").unwrap();
    assert_eq!(f.device().rename("new".into()), Err(Error::InvalidCard));
    assert_eq!(
        f.device().apply(Action::Remove(B)),
        Ok(Outcome::StateWarning)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    assert_eq!(fs::read(state_path).unwrap(), b"broken");
}
#[test]
fn residual_install_temporary_is_removed_before_retry() {
    let f = Fixture::new();
    let encrypted = staged(&f, C);
    let temp = f
        .root
        .join(".content")
        .join(format!(".story-studio-install-{C}"));
    fs::create_dir(&temp).unwrap();
    fs::write(temp.join("partial"), b"cut").unwrap();
    f.device()
        .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
        .unwrap();
    assert!(!temp.exists());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B, C]);
    f.coherent();
}
#[test]
fn backup_operation_scope_preserves_previous_sessions_during_many_installs() {
    let f = Fixture::new();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    f.device().apply(Action::Reorder(vec![A, B])).unwrap();
    let previous = f.backups();
    let device = f.device();
    let _operation = device.backup_scope();
    for n in 3..16 {
        let id = Uuid::from_u128(0x00000000000040008000000000000000 + n);
        let encrypted = staged(&f, id);
        device
            .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
            .unwrap();
        device.mark_sent(id).unwrap();
    }
    let after = f.backups();
    assert_eq!(after.len(), previous.len() + 1);
    assert!(previous.iter().all(|p| after.contains(p)));
}
#[test]
fn identical_backup_is_not_duplicated_across_operations() {
    let f = Fixture::new();
    for n in 0..14 {
        f.device().rename(format!("name {n}")).unwrap();
    }
    assert_eq!(f.backups().len(), 1);
}
#[test]
fn preflight_checks_estimate_and_reports_missing_bytes_before_generation() {
    let f = Fixture::new();
    let mut volumes = room();
    volumes.free = 2 * 1024 * 1024 + 1280 - 37;
    assert_eq!(
        f.device().preflight(Some(C), 1024, &volumes),
        Err(Error::NoSpace { missing_bytes: 37 })
    );
    assert!(f.backups().is_empty());
    volumes.free += 37;
    f.device().preflight(Some(C), 1024, &volumes).unwrap();
}
#[test]
fn device_locks_are_shared_per_root_and_independent_between_devices() {
    let f = Fixture::new();
    let second = Fixture::new();
    let first = writes::mutation(&f.root);
    let _held = first.lock().unwrap();
    assert!(writes::mutation(&f.root).try_lock().is_err());
    assert!(writes::mutation(&second.root).try_lock().is_ok());
}

#[test]
fn typed_ipc_contract_keeps_duplicate_position_and_missing_bytes() {
    use crate::support::user_message::{codes, UserMessage};
    let duplicate = UserMessage::from(Error::Duplicate { position: Some(2) });
    assert_eq!(duplicate.code, codes::STORYTELLER_STORY_DUPLICATE);
    assert_eq!(duplicate.params["position"], 3);
    let space = UserMessage::from(Error::NoSpace { missing_bytes: 123 });
    assert_eq!(space.params["missingBytes"], 123);
    for (error, code) in [
        (Error::HiddenStory, codes::STORYTELLER_STORY_HIDDEN),
        (Error::MissingStory, codes::STORYTELLER_STORY_MISSING),
        (Error::IncompleteStory, codes::STORYTELLER_STORY_INCOMPLETE),
        (Error::Changed, codes::STORYTELLER_DEVICE_CHANGED),
        (Error::InvalidOrder, codes::STORYTELLER_INVALID_ORDER),
        (Error::Disconnected, codes::STORYTELLER_SEND_DISCONNECTED),
    ] {
        assert_eq!(UserMessage::from(error).code, code);
    }
}
#[test]
fn hide_with_non_durable_playlist_keeps_payload_in_content_and_intent_retryable() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(d.apply(Action::Hide(B)), Ok(Outcome::StateWarning));
    assert!(f.root.join(".content").join(folder(B)).is_dir());
    assert_eq!(read::hidden(&f.root).unwrap(), vec![B]);
    f.device().apply(Action::Hide(B)).unwrap();
    assert!(f
        .root
        .join(".storystudio/masquees")
        .join(folder(B))
        .is_dir());
    f.coherent();
}

#[test]
fn cancellation_after_payload_rename_removes_unlisted_final_folder() {
    let f = Fixture::new();
    let encrypted = staged(&f, C);
    let mut d = f.device();
    d.after_install_rename = Some(|_, cancel| cancel.store(true, Ordering::SeqCst));
    assert_eq!(
        d.apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue)),
        Err(Error::Cancelled)
    );
    assert!(!f.root.join(".content").join(folder(C)).exists());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}
#[test]
fn payload_completeness_is_rechecked_after_rename_before_playlist_publication() {
    let f = Fixture::new();
    let encrypted = staged(&f, C);
    let mut d = f.device();
    d.after_install_rename = Some(|path, _| fs::remove_file(path.join("ni")).unwrap());
    assert_eq!(
        d.apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue)),
        Err(Error::IncompleteStory)
    );
    assert!(!f.root.join(".content").join(folder(C)).exists());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}

#[test]
fn repair_preserves_hidden_and_discards_stale_hidden_memory_against_repaired_list() {
    for stale in [false, true] {
        let f = Fixture::new();
        f.device().apply(Action::Hide(B)).unwrap();
        if stale {
            fs::rename(
                f.root.join(".storystudio/masquees").join(folder(B)),
                f.root.join(".content").join(folder(B)),
            )
            .unwrap();
            f.list(&[A, B]);
        }
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(f.root.join(".pi"))
            .unwrap()
            .write_all(&[7])
            .unwrap();
        f.device().apply(Action::RepairPlaylist).unwrap();
        assert_eq!(
            read::playlist(&f.root).unwrap(),
            if stale { vec![A, B] } else { vec![A] }
        );
        assert_eq!(
            read::hidden(&f.root).unwrap(),
            if stale { vec![] } else { vec![B] }
        );
        f.coherent();
    }
}

fn parked_orphan(f: &Fixture) -> PathBuf {
    f.device().apply(Action::Hide(B)).unwrap();
    f.story(B); // Lunii sync replaces .content and .pi, leaving the parked copy.
    f.list(&[A, B]);
    f.root.join(".storystudio/masquees").join(folder(B))
}
#[test]
fn unremembered_parked_copy_is_counted_deletable_and_does_not_block_writes() {
    let f = Fixture::new();
    let parked = parked_orphan(&f);
    fs::write(parked.join("old-copy"), [1, 2, 3]).unwrap();
    let inventory = f.inventory();
    assert!(inventory
        .stories
        .iter()
        .any(|s| s.folder == format!("parked:{}", folder(B))
            && !s.probable_hidden
            && s.uuid.is_none()));
    let d = f.device();
    d.rename("Test".into()).unwrap();
    d.apply(Action::Reorder(vec![B, A])).unwrap();
    d.mark_sent(B).unwrap();
    d.apply(Action::Hide(B)).unwrap();
    assert!(!parked.join("old-copy").exists());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    d.apply(Action::Show(B)).unwrap();
    // Another external sync leaves a second unremembered copy to delete.
    d.apply(Action::Hide(B)).unwrap();
    f.story(B);
    f.list(&[A, B]);
    d.apply(Action::DeleteOrphan(format!("parked:{}", folder(B))))
        .unwrap();
    assert!(!parked.exists());
    f.coherent();
}
#[test]
fn parked_copy_of_a_listed_story_is_marked_duplicate_and_a_lone_one_is_not() {
    use crate::commands::lunii_device::is_duplicate_of_listed;
    let f = Fixture::new();
    parked_orphan(&f);
    let parked = format!("parked:{}", folder(B));
    let marks = |f: &Fixture| {
        let inventory = f.inventory();
        let in_list: std::collections::HashSet<_> = inventory
            .stories
            .iter()
            .filter(|s| s.listed || s.probable_hidden)
            .filter_map(|s| s.uuid)
            .collect();
        let d = f.device();
        let orphan = inventory
            .stories
            .iter()
            .find(|s| s.folder == parked)
            .expect("parked orphan");
        let known = match d.orphan_identity(&d.backup_lists(), &orphan.folder) {
            Identity::Known(id) => Some(id),
            _ => None,
        };
        (known, is_duplicate_of_listed(known, &in_list))
    };
    assert_eq!(marks(&f), (Some(B), true));
    // The Lunii copy leaves the list: the parked copy is no longer a duplicate.
    f.device().rename("Test".into()).unwrap();
    f.list(&[A]);
    fs::remove_dir_all(f.root.join(".content").join(folder(B))).unwrap();
    assert_eq!(marks(&f), (Some(B), false));
}
#[test]
fn parked_orphan_does_not_prevent_preflight_or_install_of_same_uuid() {
    let f = Fixture::new();
    let parked = parked_orphan(&f);
    // Persist normalization while the externally restored entry is still listed.
    f.device().rename("Test".into()).unwrap();
    let encrypted = staged(&f, B);
    f.list(&[A]);
    f.device().preflight(Some(B), 0, &room()).unwrap();
    f.device()
        .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
        .unwrap();
    assert!(parked.is_dir());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}
#[test]
fn third_party_hidden_folder_stays_in_content_on_unrelated_writes() {
    let f = Fixture::new();
    f.story(C);
    fs::write(f.root.join(".pi.hidden"), C.as_bytes()).unwrap();
    f.device().rename("Test".into()).unwrap();
    f.device().apply(Action::Reorder(vec![B, A, C])).unwrap();
    assert!(f.root.join(".content").join(folder(C)).is_dir());
    assert!(!f
        .root
        .join(".storystudio/masquees")
        .join(folder(C))
        .exists());
    f.device().apply(Action::Hide(C)).unwrap();
    assert!(!f.root.join(".content").join(folder(C)).exists());
}
#[test]
fn show_failures_restore_parked_payload_before_returning_error() {
    for step in 0..22 {
        let f = Fixture::new();
        f.device().apply(Action::Hide(B)).unwrap();
        let mut d = f.device();
        d.fail_at = Some(step);
        let result = d.apply(Action::Show(B));
        if result.is_err() && !read::playlist(&f.root).unwrap().contains(&B) {
            assert!(
                f.root
                    .join(".storystudio/masquees")
                    .join(folder(B))
                    .is_dir(),
                "step {step}"
            );
            assert!(
                !f.root.join(".content").join(folder(B)).exists(),
                "step {step}"
            );
        }
        f.coherent();
    }
}
#[test]
fn actual_install_cut_residue_is_visible_and_deletable() {
    let f = Fixture::new();
    let name = format!(".story-studio-install-{C}");
    let residue = f.root.join(".content").join(&name);
    fs::create_dir(&residue).unwrap();
    fs::write(residue.join("ni"), [1, 2, 3]).unwrap();
    assert!(f
        .inventory()
        .stories
        .iter()
        .any(|s| s.folder == name && !s.complete && !s.listed));
    f.device().apply(Action::DeleteOrphan(name)).unwrap();
    assert!(!residue.exists());
    f.coherent();
}
#[test]
fn impossible_space_estimates_have_no_public_number() {
    use crate::support::user_message::{codes, UserMessage};
    assert_eq!(
        UserMessage::from(Error::NoSpace {
            missing_bytes: u64::MAX
        })
        .code,
        codes::STORYTELLER_NO_SPACE_UNKNOWN
    );
    let f = Fixture::new();
    assert_eq!(
        f.device().preflight(None, u64::MAX, &room()),
        Err(Error::NoSpace {
            missing_bytes: u64::MAX
        })
    );
}

struct EmptyCards;
impl OfficialCatalogue for EmptyCards {
    type Error = ();
    fn contains_official(&self, _: &str) -> std::result::Result<bool, ()> {
        Ok(false)
    }
}
impl super::super::cards::CardCatalogue for EmptyCards {
    fn official_title(&self, _: Uuid) -> Result<Option<String>> {
        Ok(None)
    }
    fn card(&self, _: Uuid) -> Result<Option<super::super::cards::CatalogueCard>> {
        Ok(None)
    }
    fn save_name(&self, _: Uuid, _: &str) -> Result<()> {
        Ok(())
    }
}
#[test]
fn parked_orphan_does_not_block_card_publication() {
    let f = Fixture::new();
    parked_orphan(&f);
    f.device().name_card(B, &EmptyCards, "Nom".into()).unwrap();
    let result = f.device().sync_cards(&[A, B], &EmptyCards).unwrap();
    assert!(result.failures.is_empty());
    f.coherent();
}

#[test]
fn non_durable_hide_resumes_on_rename_only_if_playlist_still_excludes_story() {
    for restored_by_other_tool in [false, true] {
        let f = Fixture::new();
        let mut d = f.device();
        d.fail_publish_sync = true;
        assert_eq!(d.apply(Action::Hide(B)), Ok(Outcome::StateWarning));
        if restored_by_other_tool {
            f.list(&[A, B]);
        }
        f.device().rename("Test".into()).unwrap();
        assert_eq!(
            f.root.join(".content").join(folder(B)).exists(),
            restored_by_other_tool
        );
        assert_eq!(
            f.root
                .join(".storystudio/masquees")
                .join(folder(B))
                .exists(),
            !restored_by_other_tool
        );
        f.coherent();
    }
}
#[cfg(unix)]
#[test]
fn hide_refuses_unsafe_parked_destination_before_publishing_playlist() {
    let f = Fixture::new();
    let dir = f.root.join(".storystudio/masquees");
    fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(&f.data, dir.join(folder(B))).unwrap();
    assert_eq!(f.device().apply(Action::Hide(B)), Err(Error::UnsafePath));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}

#[test]
fn explicit_hide_intent_overrides_saved_third_party_origin_after_cut() {
    let f = Fixture::new();
    f.story(C);
    fs::write(f.root.join(".pi.hidden"), C.as_bytes()).unwrap();
    f.device().rename("Test".into()).unwrap();
    let d = f.device();
    let state = state::normalized(&f.root, &[A, B]);
    let (next, _) = d
        .transition(
            vec![A, B, C],
            state,
            state::Phase::Prepare(Some((C, true))),
            &read::metadata(&f.root).unwrap(),
        )
        .unwrap();
    f.list(&next); // cut after publishing the explicit Hide
    f.device().rename("Après coupure".into()).unwrap();
    assert!(!f.root.join(".content").join(folder(C)).exists());
    assert!(f
        .root
        .join(".storystudio/masquees")
        .join(folder(C))
        .is_dir());
    f.coherent();
}

#[test]
fn non_durable_show_retains_recovery_memory_until_playlist_is_durable() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(d.apply(Action::Show(B)), Ok(Outcome::StateWarning));
    assert!(state::load(&f.root)
        .hidden
        .iter()
        .any(|h| h.uuid == B.to_string()));
    f.list(&[A]); // power cut loses the non-durable publication
    assert_eq!(read::hidden(&f.root).unwrap(), vec![B]);
    f.device().rename("Reprise".into()).unwrap();
    assert!(f
        .root
        .join(".storystudio/masquees")
        .join(folder(B))
        .is_dir());
    f.coherent();
}

// L9a4: a parked copy is replaced only by an explicit Hide with a complete payload.
fn hidden_with_partial_content_copy(f: &Fixture) -> PathBuf {
    f.device().apply(Action::Hide(B)).unwrap();
    let partial = f.root.join(".content").join(folder(B));
    fs::create_dir(&partial).unwrap();
    fs::write(partial.join("ni"), [1, 2]).unwrap();
    state::parked_path(&f.root, B)
}
fn parked_is_complete(f: &Fixture) -> bool {
    read::complete(
        &state::parked_path(&f.root, B),
        read::metadata(&f.root).unwrap().version,
    )
}
#[test]
fn partial_content_copy_never_replaces_parked_copy_on_unrelated_gestures() {
    let f = Fixture::new();
    hidden_with_partial_content_copy(&f);
    let d = f.device();
    d.rename("Test".into()).unwrap();
    d.mark_sent(A).unwrap();
    d.apply(Action::Reorder(vec![B, A])).unwrap();
    assert!(parked_is_complete(&f));
    let inventory = f.inventory();
    assert!(inventory
        .stories
        .iter()
        .any(|s| s.uuid == Some(B) && s.probable_hidden && s.complete));
    assert!(inventory
        .stories
        .iter()
        .any(|s| s.folder == folder(B) && s.uuid.is_none() && !s.probable_hidden));
    // Show refuses while the orphan occupies the name; deleting it unblocks Show.
    assert_eq!(
        d.apply(Action::Show(B)),
        Err(Error::Duplicate { position: None })
    );
    assert!(parked_is_complete(&f));
    d.apply(Action::DeleteOrphan(folder(B))).unwrap();
    assert!(parked_is_complete(&f));
    d.apply(Action::Show(B)).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    f.coherent();
}
#[test]
fn deleting_parked_copy_of_hidden_story_is_refused_before_any_change() {
    let f = Fixture::new();
    let parked = hidden_with_partial_content_copy(&f);
    assert_eq!(
        f.device()
            .apply(Action::DeleteOrphan(format!("parked:{}", folder(B)))),
        Err(Error::HiddenStory)
    );
    assert!(parked.is_dir() && parked_is_complete(&f));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
}
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}
#[test]
fn restoring_content_folder_of_hidden_story_is_refused_and_keeps_parked_copy() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    let parked = state::parked_path(&f.root, B);
    // A complete foreign copy in .content, and a marker in the parked copy.
    let content = f.root.join(".content").join(folder(B));
    copy_tree(&parked, &content);
    fs::write(parked.join("marker"), b"parked").unwrap();
    assert_eq!(
        f.device().apply(Action::Restore {
            folder: folder(B),
            known_uuid: Some(B),
        }),
        Err(Error::HiddenStory)
    );
    assert_eq!(fs::read(parked.join("marker")).unwrap(), b"parked");
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    assert_eq!(read::hidden(&f.root).unwrap(), vec![B]);
}
#[test]
fn inspection_with_card_sync_keeps_parked_copy() {
    let f = Fixture::new();
    hidden_with_partial_content_copy(&f);
    let inventory = f.inventory();
    let ids: Vec<_> = inventory.stories.iter().filter_map(|s| s.uuid).collect();
    let result = f.device().sync_cards(&ids, &EmptyCards).unwrap();
    assert!(result.failures.is_empty());
    f.device().name_card(B, &EmptyCards, "Nom".into()).unwrap();
    assert!(parked_is_complete(&f));
    assert!(f.root.join(".content").join(folder(B)).join("ni").is_file());
}
#[test]
fn hide_resumed_with_partial_content_keeps_parked_copy() {
    // Re-hide over an unremembered parked copy, cut after .pi, then the
    // .content payload becomes partial: the parked copy must survive.
    let f = Fixture::new();
    let parked = parked_orphan(&f);
    fs::write(parked.join("old-copy"), [1]).unwrap();
    let d = f.device();
    let state = state::normalized(&f.root, &[A, B]);
    let (next, _) = d
        .transition(
            vec![A, B],
            state,
            state::Phase::Prepare(Some((B, true))),
            &read::metadata(&f.root).unwrap(),
        )
        .unwrap();
    f.list(&next);
    let content = f.root.join(".content").join(folder(B));
    fs::remove_dir_all(&content).unwrap();
    fs::create_dir(&content).unwrap();
    fs::write(content.join("ni"), [1, 2]).unwrap();
    f.device().rename("Reprise".into()).unwrap();
    assert!(parked.join("old-copy").is_file());
    assert!(content.join("ni").is_file());
    assert_eq!(state::story_path(&f.root, B), parked);
}
fn residue(f: &Fixture) -> Vec<String> {
    fs::read_dir(f.root.join(".content"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".story-studio-install-"))
        .collect()
}
#[cfg(unix)]
fn deny_parking(f: &Fixture, deny: bool) -> bool {
    use std::os::unix::fs::PermissionsExt;
    // Permission bits do not restrict root: the scenario cannot be produced.
    if unsafe { libc::geteuid() } == 0 {
        return false;
    }
    let parked = f.root.join(".storystudio/masquees");
    fs::create_dir_all(&parked).unwrap();
    fs::set_permissions(
        &parked,
        fs::Permissions::from_mode(if deny { 0o555 } else { 0o755 }),
    )
    .unwrap();
    true
}
#[cfg(unix)]
#[test]
fn impossible_parking_probe_is_typed_and_leaves_no_residue() {
    use crate::support::user_message::{codes, UserMessage};
    let f = Fixture::new();
    if !deny_parking(&f, true) {
        return;
    }
    let result = f.device().apply(Action::Hide(B));
    deny_parking(&f, false);
    assert_eq!(result, Err(Error::ParkingFailed));
    assert_eq!(
        UserMessage::from(Error::ParkingFailed).code,
        codes::STORYTELLER_STORY_PARKING_FAILED
    );
    assert!(residue(&f).is_empty());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}
#[cfg(unix)]
#[test]
fn impossible_parking_after_non_durable_hide_blocks_only_that_story() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(d.apply(Action::Hide(B)), Ok(Outcome::StateWarning));
    if !deny_parking(&f, true) {
        return;
    }
    let outcome = (|| -> Result<()> {
        let d = f.device();
        d.rename("Test".into())?;
        d.mark_sent(A)?;
        d.apply(Action::Reorder(vec![B, A]))?;
        assert!(f
            .inventory()
            .stories
            .iter()
            .any(|s| s.uuid == Some(B) && s.probable_hidden && s.complete));
        assert_eq!(d.apply(Action::Hide(B)), Err(Error::ParkingFailed));
        assert!(residue(&f).is_empty());
        assert!(f.root.join(".content").join(folder(B)).is_dir());
        d.apply(Action::Show(B))?;
        Ok(())
    })();
    deny_parking(&f, false);
    outcome.unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    assert!(state::load(&f.root).hidden.is_empty());
    f.coherent();
}
#[test]
fn commit_tolerates_unsupported_directory_sync_like_publication() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(d.apply(Action::Hide(B)), Ok(Outcome::StateWarning));
    d.rename("Test".into()).unwrap();
    assert!(state::parked_path(&f.root, B).is_dir());
    assert!(!f.root.join(".content").join(folder(B)).exists());
    f.coherent();
}
#[test]
fn file_named_as_parked_folder_is_a_deletable_orphan() {
    let f = Fixture::new();
    let parked = state::parked_path(&f.root, B);
    fs::create_dir_all(parked.parent().unwrap()).unwrap();
    fs::write(&parked, b"stray").unwrap();
    assert!(f
        .inventory()
        .stories
        .iter()
        .any(|s| s.folder == format!("parked:{}", folder(B)) && !s.complete && s.uuid.is_none()));
    assert_eq!(f.device().apply(Action::Hide(B)), Err(Error::UnsafePath));
    f.device()
        .apply(Action::DeleteOrphan(format!("parked:{}", folder(B))))
        .unwrap();
    assert!(parked.symlink_metadata().is_err());
    f.device().apply(Action::Hide(B)).unwrap();
    assert!(parked.is_dir());
    f.coherent();
}

fn upgrade_v7(f: &Fixture) {
    let mut md = fs::read(f.root.join(".md")).unwrap();
    md.resize(128, 0);
    md[..2].copy_from_slice(&7u16.to_le_bytes());
    for (i, b) in md[64..96].iter_mut().enumerate() {
        *b = i as u8;
    }
    fs::write(f.root.join(".md"), md).unwrap();
}
#[test]
fn v7_installation_and_version_change_refusal() {
    let f = Fixture::new();
    let encrypted = staged(&f, C);
    upgrade_v7(&f);
    assert!(!encrypted.matches_device(&f.root));
    assert_eq!(
        f.device()
            .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue)),
        Err(Error::Changed)
    );
    assert!(f.backups().is_empty());
    let f = Fixture::new();
    upgrade_v7(&f);
    f.story(C);
    let encrypted = staged(&f, C);
    assert!(encrypted.matches_device(&f.root));
    let other = Fixture::new();
    upgrade_v7(&other);
    let mut md = fs::read(other.root.join(".md")).unwrap();
    md[26..40].copy_from_slice(b"00000000000043");
    fs::write(other.root.join(".md"), md).unwrap();
    assert!(!encrypted.matches_device(&other.root));
    f.device()
        .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
        .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B, C]);
    f.coherent();
}
#[test]
fn v7_wrong_size_and_unknown_version_stay_read_only() {
    let f = Fixture::new();
    upgrade_v7(&f);
    assert_eq!(f.inventory().metadata.version, 7);
    assert_eq!(f.inventory().metadata.read_only, None);
    let original = fs::read(f.root.join(".md")).unwrap();
    for size in [2, 40, 112, 127, 129] {
        let mut bytes = original.clone();
        bytes.resize(size, 0);
        fs::write(f.root.join(".md"), bytes).unwrap();
        assert_eq!(f.inventory().metadata.read_only, Some(Error::MetadataSize));
        assert_eq!(f.device().apply(Action::Hide(B)), Err(Error::MetadataSize));
    }
    let mut bytes = original;
    bytes[0] = 8;
    fs::write(f.root.join(".md"), bytes).unwrap();
    assert_eq!(f.inventory().metadata.read_only, Some(Error::UnknownFormat));
    assert_eq!(f.device().apply(Action::Hide(B)), Err(Error::UnknownFormat));
}
#[test]
fn pending_hide_of_b_does_not_fail_successful_hide_of_a() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(d.apply(Action::Hide(B)), Ok(Outcome::StateWarning));
    let assert_pending = || {
        assert!(f
            .inventory()
            .stories
            .iter()
            .any(|s| s.uuid == Some(B) && s.parking_pending && s.probable_hidden));
    };
    assert_pending(); // Durable visibility intent survives a new device instance.
    let parked = state::parked_path(&f.root, B);
    fs::create_dir_all(parked.parent().unwrap()).unwrap();
    fs::write(&parked, b"blocks B only").unwrap();
    // A is official in the fixture; hide is explicitly allowed for every story.
    assert_eq!(f.device().apply(Action::Hide(A)), Ok(Outcome::Complete));
    assert_pending();
    assert_eq!(f.device().apply(Action::Hide(A)), Ok(Outcome::Complete));
    assert_pending();
    assert!(f
        .inventory()
        .stories
        .iter()
        .any(|s| s.uuid == Some(A) && s.probable_hidden && !s.parking_pending));
    assert_eq!(f.device().apply(Action::Hide(B)), Err(Error::UnsafePath));
    fs::remove_file(parked).unwrap();
    f.device().rename("Reprise".into()).unwrap();
    assert!(f.inventory().stories.iter().all(|s| !s.parking_pending));
    f.coherent();
}
#[test]
fn v6_and_v7_preview_after_update_validate_bitmap_and_never_show_garbage() {
    for old_story in [true, false] {
        let f = Fixture::new();
        if !old_story {
            upgrade_v7(&f);
        }
        f.story(C);
        let path = f.root.join(".content").join(folder(C));
        let mut bmp = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(320, 240, image::Rgb([20, 30, 40]))
            .write_to(&mut bmp, image::ImageFormat::Bmp)
            .unwrap();
        fs::write(path.join("rf/000/00000000"), bmp.into_inner()).unwrap();
        fs::write(path.join("ri"), b"000\\00000000\0\0\0\0").unwrap();
        let encrypted = staged(&f, C);
        f.device()
            .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
            .unwrap();
        if old_story {
            upgrade_v7(&f);
        }
        assert!(f.device().first_screen(C, &Catalogue).is_some());
        fs::write(path.join("rf/000/00000000"), [0x55; 512]).unwrap();
        assert!(f.device().first_screen(C, &Catalogue).is_none());
        assert_eq!(
            f.device().read_first_screen(C, &Catalogue),
            Err(Error::UnreadableStory)
        );
        assert_eq!(
            crate::support::user_message::UserMessage::from(Error::UnreadableStory).code,
            crate::support::user_message::codes::STORYTELLER_STORY_UNREADABLE
        );
    }
}

#[test]
fn v7_changed_key_block_with_same_serial_and_version_refuses_installation() {
    for offset in [0x40, 0x50] {
        let f = Fixture::new();
        upgrade_v7(&f);
        let encrypted = staged(&f, C);
        let before = read::metadata(&f.root).unwrap();
        let mut md = fs::read(f.root.join(".md")).unwrap();
        md[offset] ^= 0x80;
        fs::write(f.root.join(".md"), md).unwrap();
        assert_eq!(read::metadata(&f.root).unwrap(), before);
        assert!(!encrypted.matches_device(&f.root));
        let error = f
            .device()
            .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
            .unwrap_err();
        assert_eq!(error, Error::Changed);
        assert_eq!(
            crate::support::user_message::UserMessage::from(error).code,
            crate::support::user_message::codes::STORYTELLER_DEVICE_CHANGED
        );
        assert!(f.backups().is_empty());
        assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
        assert!(!f.root.join(".content").join(folder(C)).exists());
    }
}

#[test]
fn preview_preserves_structural_io_and_metadata_errors() {
    for expected in [Error::IncompleteStory, Error::Io, Error::UnknownFormat] {
        let f = Fixture::new();
        f.story(C);
        let encrypted = staged(&f, C);
        f.device()
            .apply_with_catalogue(action(encrypted, None), &room(), Some(&Catalogue))
            .unwrap();
        let path = f.root.join(".content").join(folder(C));
        match expected {
            Error::IncompleteStory => fs::write(path.join("ni"), [0; 512]).unwrap(),
            Error::Io => fs::remove_file(path.join("ri")).unwrap(),
            Error::UnknownFormat => {
                let mut md = fs::read(f.root.join(".md")).unwrap();
                md[..2].copy_from_slice(&8u16.to_le_bytes());
                fs::write(f.root.join(".md"), md).unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(f.device().read_first_screen(C, &Catalogue), Err(expected));
        assert_ne!(
            crate::support::user_message::UserMessage::from(expected).code,
            crate::support::user_message::codes::STORYTELLER_STORY_UNREADABLE
        );
    }
}

#[test]
fn repair_preview_matches_empty_and_truncated_repair_without_writing() {
    let f = Fixture::new();
    let mut bytes = Uuid::nil().as_bytes().to_vec();
    bytes.push(42);
    fs::write(f.root.join(".pi"), &bytes).unwrap();
    let preview = f.device().repair_preview().unwrap();
    assert_eq!(
        preview,
        Outcome::Repaired {
            kept: 0,
            removed: vec![Uuid::nil()],
            empty: true,
            truncated: true,
        }
    );
    assert_eq!(fs::read(f.root.join(".pi")).unwrap(), bytes);
    assert_eq!(f.device().apply(Action::RepairPlaylist).unwrap(), preview);
    assert!(read::playlist(&f.root).unwrap().is_empty());
    assert!(f.root.join(".content").join(folder(A)).is_dir());
}

#[test]
fn parked_orphan_restore_requires_identity_and_never_overwrites_content() {
    let f = Fixture::new();
    let parked = parked_orphan(&f);
    f.device().rename("Test".into()).unwrap();
    let d = f.device();
    let name = format!("parked:{}", folder(B));
    assert_eq!(
        d.apply(Action::Restore {
            folder: name.clone(),
            known_uuid: None
        }),
        Err(Error::UnknownUuid)
    );
    assert!(parked.is_dir());
    f.list(&[A]);
    // An existing content orphan must be explicitly deleted first.
    assert_eq!(
        d.apply(Action::Restore {
            folder: name.clone(),
            known_uuid: Some(B)
        }),
        Err(Error::Duplicate { position: None })
    );
    fs::remove_dir_all(f.root.join(".content").join(folder(B))).unwrap();
    d.apply(Action::Restore {
        folder: name,
        known_uuid: Some(B),
    })
    .unwrap();
    assert!(!parked.exists());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}

#[test]
fn orphan_identity_comes_from_a_validated_full_sidecar() {
    let f = Fixture::new();
    f.list(&[B]);
    let d = f.device();
    assert_eq!(d.orphan_card_uuid(&folder(B)), None);
    d.name_card(B, &EmptyCards, "Nom".into()).unwrap();
    assert_eq!(d.orphan_card_uuid(&folder(B)), Some(B));
    assert_eq!(
        d.orphan_card_uuid(&format!("parked:{}", folder(B))),
        Some(B)
    );
    fs::write(f.root.join(".storystudio").join(format!("{B}.json")), b"{}").unwrap();
    assert_eq!(d.orphan_card_uuid(&folder(B)), None);
}

#[test]
fn parked_restore_cut_keeps_payload_and_never_publishes_a_dangling_entry() {
    for step in 0..8 {
        let f = Fixture::new();
        let parked = parked_orphan(&f);
        f.device().rename("Test".into()).unwrap();
        f.list(&[A]);
        fs::remove_dir_all(f.root.join(".content").join(folder(B))).unwrap();
        let mut d = f.device();
        d.fail_at = Some(step);
        let _ = d.apply(Action::Restore {
            folder: format!("parked:{}", folder(B)),
            known_uuid: Some(B),
        });
        assert!(parked.is_dir() || f.root.join(".content").join(folder(B)).is_dir());
        f.coherent();
    }
}

#[test]
fn parked_restore_checks_content_parent_even_with_an_empty_list() {
    let f = Fixture::new();
    let parked = parked_orphan(&f);
    f.device().rename("Test".into()).unwrap();
    f.list(&[]);
    fs::remove_dir_all(f.root.join(".content")).unwrap();
    fs::write(f.root.join(".content"), b"not a directory").unwrap();
    assert_eq!(
        f.device().apply(Action::Restore {
            folder: format!("parked:{}", folder(B)),
            known_uuid: Some(B),
        }),
        Err(Error::UnsafePath)
    );
    assert!(parked.is_dir());
    assert!(read::playlist(&f.root).unwrap().is_empty());
}

fn parked_restore_fixture() -> (Fixture, PathBuf) {
    let f = Fixture::new();
    let parked = parked_orphan(&f);
    f.device().rename("Test".into()).unwrap();
    f.list(&[A]);
    fs::remove_dir_all(f.root.join(".content").join(folder(B))).unwrap();
    (f, parked)
}
fn restore_parked_b(d: &Device) -> Result<Outcome> {
    d.apply(Action::Restore {
        folder: format!("parked:{}", folder(B)),
        known_uuid: Some(B),
    })
}

#[test]
fn parked_restore_error_after_move_returns_the_folder_to_parking() {
    let (f, parked) = parked_restore_fixture();
    let mut d = f.device();
    // Another tool rewrote the list after the move: Changed before publication.
    d.after_unpark = Some(|root| fs::write(root.join(".pi"), []).unwrap());
    assert_eq!(restore_parked_b(&d), Err(Error::Changed));
    assert!(parked.is_dir());
    assert!(!f.root.join(".content").join(folder(B)).exists());
    assert!(read::playlist(&f.root).unwrap().is_empty());
    // Retryable once the list is stable again.
    f.list(&[A]);
    restore_parked_b(&f.device()).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    f.coherent();
}

#[test]
fn failed_return_keeps_original_error_and_a_visible_orphan() {
    let (f, parked) = parked_restore_fixture();
    let mut d = f.device();
    d.after_unpark = Some(|root| {
        fs::write(root.join(".pi"), []).unwrap();
        // The return target is no longer a directory: the return itself fails.
        let masquees = root.join(".storystudio/masquees");
        fs::remove_dir_all(&masquees).unwrap();
        fs::write(&masquees, b"not a directory").unwrap();
    });
    assert_eq!(restore_parked_b(&d), Err(Error::Changed));
    assert!(!parked.exists());
    assert!(read::playlist(&f.root).unwrap().is_empty());
    assert!(f.root.join(".content").join(folder(B)).is_dir());
    assert!(f
        .inventory()
        .stories
        .iter()
        .any(|s| s.folder == folder(B) && !s.listed && s.directory_present));
}

#[test]
fn parked_copy_of_a_hidden_story_never_returns_under_another_uuid() {
    let f = Fixture::new();
    f.device().apply(Action::Hide(B)).unwrap();
    let parked = f.root.join(".storystudio/masquees").join(folder(B));
    assert!(parked.is_dir());
    let collision = Uuid::from_u128(B.as_u128() | (1 << 96));
    assert_eq!(folder(collision), folder(B));
    assert_eq!(
        f.device().apply(Action::Restore {
            folder: format!("parked:{}", folder(B)),
            known_uuid: Some(collision),
        }),
        Err(Error::SuffixCollision)
    );
    assert!(parked.is_dir());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    assert_eq!(read::hidden(&f.root).unwrap(), vec![B]);
}

/// 30 Oct. 2026 incident: on Linux vfat a renamed entry stayed in memory after
/// the directory fsync. Every gesture now ends with one volume barrier, and a
/// failed barrier is never reported as a completed gesture.
#[test]
fn every_gesture_ends_with_a_volume_barrier() {
    let f = Fixture::new();
    let d = f.device();
    let syncs = |d: &Device| d.volume_syncs.get();
    let before = syncs(&d);
    assert_eq!(d.apply(Action::Reorder(vec![B, A])), Ok(Outcome::Complete));
    assert_eq!(syncs(&d), before + 1);
    let before = syncs(&d);
    assert_eq!(
        d.apply_with_catalogue(action(staged(&f, C), None), &room(), Some(&Catalogue)),
        Ok(Outcome::Complete)
    );
    assert_eq!(syncs(&d), before + 1);
    for gesture in [
        Box::new(|d: &Device| d.apply(Action::Hide(C)).map(drop))
            as Box<dyn Fn(&Device) -> Result<()>>,
        Box::new(|d: &Device| d.apply(Action::Show(C)).map(drop)),
        Box::new(|d: &Device| d.apply(Action::Remove(C)).map(drop)),
        Box::new(|d: &Device| d.rename("Salon".into())),
        Box::new(|d: &Device| d.mark_sent(B)),
        Box::new(|d: &Device| {
            d.write_card(
                B,
                Some(&EmptyCards),
                super::super::cards::Card {
                    title: "Titre".into(),
                    description: String::new(),
                    age_min: None,
                    age_max: None,
                    cover_png: None,
                },
            )
            .map(drop)
        }),
    ] {
        let before = syncs(&d);
        gesture(&d).unwrap();
        assert!(syncs(&d) > before);
    }
    // A refusal is also followed by the barrier and keeps its own error.
    let before = syncs(&d);
    assert_eq!(d.apply(Action::Reorder(vec![A])), Err(Error::InvalidOrder));
    assert_eq!(syncs(&d), before + 1);
}

#[test]
fn failed_volume_barrier_is_never_a_completed_gesture() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_volume_sync = true;
    assert_eq!(
        d.apply(Action::Reorder(vec![B, A])),
        Ok(Outcome::StateWarning)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    assert_eq!(
        d.apply_with_catalogue(action(staged(&f, C), None), &room(), Some(&Catalogue)),
        Ok(Outcome::InstalledNotDurable)
    );
    f.coherent();
    assert_eq!(d.apply(Action::Remove(C)), Ok(Outcome::StateWarning));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    // An orphan put back in the list: the restore-specific warning.
    f.story(C);
    assert_eq!(
        d.apply(Action::Restore {
            folder: folder(C),
            known_uuid: Some(C),
        }),
        Ok(Outcome::RestoredNotDurable)
    );
    // Errors keep their meaning; the barrier never turns one into a success.
    assert_eq!(d.apply(Action::Reorder(vec![A])), Err(Error::InvalidOrder));
    assert_eq!(d.rename("Salon".into()), Err(Error::Io));
    assert_eq!(d.mark_sent(B), Err(Error::Io));
    let card = super::super::cards::Card {
        title: "Titre".into(),
        description: String::new(),
        age_min: None,
        age_max: None,
        cover_png: None,
    };
    assert_eq!(d.write_card(B, Some(&EmptyCards), card), Err(Error::Io));
    f.coherent();
}

#[test]
fn read_only_cause_names_the_volume_first_and_never_the_firmware() {
    let f = Fixture::new();
    let mut inventory = f.inventory();
    assert_eq!(inventory.read_only_cause(true), None);
    assert_eq!(
        inventory.read_only_cause(false),
        Some(ReadOnlyCause::Volume)
    );
    inventory.playlist_state = PlaylistState::Unavailable;
    assert_eq!(
        inventory.read_only_cause(true),
        Some(ReadOnlyCause::Unavailable)
    );
    inventory.metadata.read_only = Some(Error::UnknownFormat);
    assert_eq!(
        inventory.read_only_cause(true),
        Some(ReadOnlyCause::Metadata)
    );
    assert_eq!(
        inventory.read_only_cause(false),
        Some(ReadOnlyCause::Volume)
    );
    // A recent firmware alone is writable (the fixture's .md says 12.34.5).
    let mut md = fs::read(f.root.join(".md")).unwrap();
    md[2..9].copy_from_slice(b"3.3.4\0\0");
    fs::write(f.root.join(".md"), md).unwrap();
    assert_eq!(f.inventory().read_only_cause(true), None);
    assert_eq!(
        serde_json::to_value(ReadOnlyCause::Volume).unwrap(),
        "volume"
    );
    use crate::support::user_message::{codes, UserMessage};
    assert_eq!(
        UserMessage::from(Error::ReadOnly).code,
        codes::STORYTELLER_VOLUME_READ_ONLY
    );
    for metadata in [
        Error::UnknownFormat,
        Error::InvalidMetadata,
        Error::MetadataSize,
    ] {
        assert_eq!(
            UserMessage::from(metadata).code,
            codes::STORYTELLER_READ_ONLY
        );
    }
}

#[test]
fn volume_barrier_accepts_any_path_of_the_volume_and_reports_failures() {
    let f = Fixture::new();
    platform::sync_volume(&f.root).unwrap();
    platform::sync_volume(&f.root.join(".content")).unwrap();
    platform::sync_volume(&f.root.join(".pi")).unwrap();
    #[cfg(unix)]
    assert_eq!(
        platform::sync_volume(&f.root.join("absent")),
        Err(Error::Io)
    );
}

#[test]
fn install_copies_without_per_folder_barrier_then_one_before_the_rename() {
    let f = Fixture::new();
    let d = f.device();
    let story = staged(&f, C);
    // The staged story holds several folders (rf/000, sf/000).
    assert!(story.path.join("rf").join("000").is_dir());
    assert_eq!(
        d.apply_with_catalogue(action(story, None), &room(), Some(&Catalogue)),
        Ok(Outcome::Complete)
    );
    // Before the rename, after it; then the final gesture barrier.
    assert_eq!(d.barriers.get(), 2);
    assert_eq!(d.volume_syncs.get(), 1);
}

struct CopiedCards;
impl OfficialCatalogue for CopiedCards {
    type Error = ();
    fn contains_official(&self, _: &str) -> std::result::Result<bool, ()> {
        Ok(false)
    }
}
impl super::super::cards::CardCatalogue for CopiedCards {
    fn official_title(&self, _: Uuid) -> Result<Option<String>> {
        Ok(None)
    }
    fn card(&self, id: Uuid) -> Result<Option<super::super::cards::CatalogueCard>> {
        Ok(Some(super::super::cards::CatalogueCard {
            card: super::super::cards::Card {
                title: format!("Titre {}", folder(id)),
                description: String::new(),
                age_min: None,
                age_max: None,
                cover_png: None,
            },
            cover_pending: false,
        }))
    }
    fn save_name(&self, _: Uuid, _: &str) -> Result<()> {
        Ok(())
    }
}

type SnapshotEntry = (PathBuf, Option<Vec<u8>>, std::time::SystemTime);
fn device_snapshot(root: &Path) -> Vec<SnapshotEntry> {
    fn visit(root: &Path, path: &Path, out: &mut Vec<SnapshotEntry>) {
        let meta = fs::metadata(path).unwrap();
        out.push((
            path.strip_prefix(root).unwrap().into(),
            meta.is_file().then(|| fs::read(path).unwrap()),
            meta.modified().unwrap(),
        ));
        if meta.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                visit(root, &entry.unwrap().path(), out);
            }
        }
    }
    let mut out = Vec::new();
    visit(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn device_card_quiet_reads_never_publish_sidecars_or_backups() {
    let f = Fixture::new();
    let d = f.device();
    let before = device_snapshot(&f.root);
    for _ in 0..3 {
        let cards = d.read_cards(&[A, B], &CopiedCards);
        assert!(cards
            .iter()
            .all(|card| matches!(card, super::super::cards::Resolution::Known(_))));
        assert_eq!(device_snapshot(&f.root), before);
    }
    assert!(!f.root.join(".storystudio").exists());
    assert!(f.backups().is_empty());
    assert_eq!(d.volume_syncs.get(), 0);
    // The explicit connection still publishes both cards.
    d.sync_cards(&[A, B], &CopiedCards).unwrap();
    let before = device_snapshot(&f.root);
    d.read_cards(&[A, B], &EmptyCards);
    assert_eq!(device_snapshot(&f.root), before);
    // A pending device name differs from the catalogue: a quiet read must
    // neither reconcile it nor rewrite the sidecar like an explicit sync.
    let path = f.root.join(".storystudio").join(format!("{A}.json"));
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["pending_name"] = serde_json::json!(true);
    record["card"]["title"] = serde_json::json!("Pending device name");
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    let before = device_snapshot(&f.root);
    let cards = d.read_cards(&[A, B], &CopiedCards);
    assert!(
        matches!(&cards[0], super::super::cards::Resolution::Known(card) if card.title == "Pending device name")
    );
    assert_eq!(device_snapshot(&f.root), before);
}

#[test]
fn device_card_quiet_resolution_matches_sync_without_writes() {
    use crate::services::storyteller_device::cards::{
        Card, CardCatalogue, CatalogueCard, Resolution,
    };
    use std::cell::{Cell, RefCell};
    struct Profile {
        card: RefCell<Option<Card>>,
        cover_pending: bool,
        saves: Cell<usize>,
    }
    impl OfficialCatalogue for Profile {
        type Error = ();
        fn contains_official(&self, _: &str) -> std::result::Result<bool, ()> {
            Ok(false)
        }
    }
    impl CardCatalogue for Profile {
        fn official_title(&self, _: Uuid) -> Result<Option<String>> {
            Ok(None)
        }
        fn card(&self, _: Uuid) -> Result<Option<CatalogueCard>> {
            Ok(self.card.borrow().clone().map(|card| CatalogueCard {
                card,
                cover_pending: self.cover_pending,
            }))
        }
        fn save_name(&self, _: Uuid, title: &str) -> Result<()> {
            self.saves.set(self.saves.get() + 1);
            if let Some(card) = self.card.borrow_mut().as_mut() {
                card.title = title.into();
            }
            Ok(())
        }
    }
    fn card(title: &str, pixel: u8) -> Card {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(1, 1, image::Rgb([pixel, 0, 0]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        Card {
            title: title.into(),
            description: title.into(),
            age_min: None,
            age_max: None,
            cover_png: Some(png.into_inner()),
        }
    }
    for (case, sidecar, catalogue, pending_name, cover_pending) in [
        ("sidecar only", true, false, false, false),
        ("catalogue only", false, true, false, false),
        ("catalogue correction", true, true, false, false),
        ("pending device name", true, true, true, false),
        ("pending catalogue cover", true, true, false, true),
        ("both pending", true, true, true, true),
    ] {
        let f = Fixture::new();
        let d = f.device();
        let device_card = card("Device name", 10);
        let catalogue_card = card("Catalogue name", 200);
        let profile = Profile {
            card: RefCell::new(catalogue.then(|| catalogue_card.clone())),
            cover_pending,
            saves: Cell::new(0),
        };
        if sidecar {
            d.write_card(B, Some(&profile), device_card.clone())
                .unwrap();
            if pending_name {
                let path = f.root.join(".storystudio").join(format!("{B}.json"));
                let mut record: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                record["pending_name"] = serde_json::json!(true);
                fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
            }
        }
        let before = device_snapshot(&f.root);
        let catalogue_before = profile.card.borrow().clone();
        let silent = d.read_cards(&[B], &profile);
        assert_eq!(device_snapshot(&f.root), before, "{case}");
        assert_eq!(*profile.card.borrow(), catalogue_before, "{case}");
        assert_eq!(profile.saves.get(), 0, "{case}");
        let mut expected = if catalogue {
            catalogue_card
        } else {
            device_card.clone()
        };
        if pending_name {
            expected.title.clone_from(&device_card.title);
        }
        if cover_pending {
            expected.cover_png.clone_from(&device_card.cover_png);
        }
        assert_eq!(silent, vec![Resolution::Known(expected.clone())], "{case}");
        // cover() uses the same read_cards resolution: it must serve the newly
        // selected PNG, including the old device PNG while a cover is pending.
        let Resolution::Known(resolved) = &silent[0] else {
            panic!("{case}")
        };
        assert_eq!(
            d.read_creation_cover(B, resolved, &profile).unwrap(),
            expected.cover_png.unwrap(),
            "{case}"
        );
        assert_eq!(device_snapshot(&f.root), before, "{case}");
        let explicit = d.sync_cards(&[B], &profile).unwrap();
        assert!(explicit.failures.is_empty(), "{case}");
        assert_eq!(silent, explicit.resolutions, "{case}");
    }
}

#[test]
fn device_card_quiet_resolution_preserves_degraded_sync_behaviour_without_writes() {
    use crate::services::storyteller_device::cards::{
        Card, CardCatalogue, CatalogueCard, Resolution, SyncFailure, SyncStage,
    };
    use std::cell::Cell;
    #[derive(Clone, Copy, Debug)]
    enum Case {
        Future,
        FutureWithoutCatalogue,
        InvalidCatalogue,
        InvalidCatalogueWithoutSidecar,
        Missing,
        CatalogueError,
        CatalogueErrorWithoutSidecar,
        SaveNameError,
        ReadOnly,
        ReadOnlyWithoutSidecar,
    }
    struct Profile {
        card: Option<Card>,
        card_error: bool,
        save_error: bool,
        saves: Cell<usize>,
    }
    impl OfficialCatalogue for Profile {
        type Error = ();
        fn contains_official(&self, _: &str) -> std::result::Result<bool, ()> {
            Ok(false)
        }
    }
    impl CardCatalogue for Profile {
        fn official_title(&self, _: Uuid) -> Result<Option<String>> {
            Ok(None)
        }
        fn card(&self, _: Uuid) -> Result<Option<CatalogueCard>> {
            if self.card_error {
                return Err(Error::Io);
            }
            Ok(self.card.clone().map(|card| CatalogueCard {
                card,
                cover_pending: false,
            }))
        }
        fn save_name(&self, _: Uuid, _: &str) -> Result<()> {
            self.saves.set(self.saves.get() + 1);
            assert!(
                self.save_error,
                "only the failed-save case publishes a name"
            );
            Err(Error::Io)
        }
    }
    fn card(title: &str, description: &str) -> Card {
        Card {
            title: title.into(),
            description: description.into(),
            age_min: None,
            age_max: None,
            cover_png: None,
        }
    }
    for case in [
        Case::Future,
        Case::FutureWithoutCatalogue,
        Case::InvalidCatalogue,
        Case::InvalidCatalogueWithoutSidecar,
        Case::Missing,
        Case::CatalogueError,
        Case::CatalogueErrorWithoutSidecar,
        Case::SaveNameError,
        Case::ReadOnly,
        Case::ReadOnlyWithoutSidecar,
    ] {
        let f = Fixture::new();
        let d = f.device();
        let profile = Profile {
            card: match case {
                Case::Missing | Case::FutureWithoutCatalogue => None,
                Case::InvalidCatalogue | Case::InvalidCatalogueWithoutSidecar => {
                    Some(card("", "Invalid catalogue description"))
                }
                _ => Some(card("Catalogue name", "Catalogue description")),
            },
            card_error: matches!(
                case,
                Case::CatalogueError | Case::CatalogueErrorWithoutSidecar
            ),
            save_error: matches!(case, Case::SaveNameError),
            saves: Cell::new(0),
        };
        if !matches!(
            case,
            Case::Missing
                | Case::InvalidCatalogueWithoutSidecar
                | Case::CatalogueErrorWithoutSidecar
                | Case::ReadOnlyWithoutSidecar
        ) {
            fs::create_dir_all(f.root.join(".storystudio")).unwrap();
            // Independent fixture: do not use write_card/sync_cards to build
            // the sidecar whose precedence this test is meant to verify.
            let record = serde_json::json!({
                "version": if matches!(case, Case::Future | Case::FutureWithoutCatalogue) { 9 } else { 1 },
                "uuid": B,
                "pending_name": matches!(case, Case::SaveNameError),
                "card": {
                    "title": "Device name", "description": "Device description",
                    "age_min": null, "age_max": null, "cover_png": null
                }
            });
            fs::write(
                f.root.join(".storystudio").join(format!("{B}.json")),
                serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
        }
        if matches!(case, Case::ReadOnly | Case::ReadOnlyWithoutSidecar) {
            // Portable driver read-only refusal, as in the existing read-only
            // fallback tests: unsupported metadata avoids mounting a real
            // read-only volume and does not depend on host privileges/ACLs.
            let path = f.root.join(".md");
            let mut md = fs::read(&path).unwrap();
            md[..2].copy_from_slice(&8u16.to_le_bytes());
            fs::write(path, md).unwrap();
            assert_eq!(
                read::metadata(&f.root).unwrap().read_only,
                Some(Error::UnknownFormat)
            );
        }
        let expected_quiet = match case {
            Case::Future | Case::ReadOnly | Case::ReadOnlyWithoutSidecar => {
                Resolution::Known(card("Catalogue name", "Catalogue description"))
            }
            Case::InvalidCatalogue | Case::CatalogueError => {
                Resolution::Known(card("Device name", "Device description"))
            }
            Case::SaveNameError => Resolution::Known(card("Device name", "Catalogue description")),
            Case::FutureWithoutCatalogue
            | Case::InvalidCatalogueWithoutSidecar
            | Case::Missing
            | Case::CatalogueErrorWithoutSidecar => Resolution::Unknown,
        };
        let before = device_snapshot(&f.base);
        let quiet = d.read_cards(&[B], &profile);
        assert_eq!(quiet, vec![expected_quiet], "{case:?}");
        // Includes application data: neither device sidecars nor local backups
        // nor pending-name publication may be changed by a silent read.
        assert_eq!(device_snapshot(&f.base), before, "{case:?}");
        assert_eq!(profile.saves.get(), 0, "{case:?}");
        assert_eq!(d.volume_syncs.get(), 0, "{case:?}");
        let explicit = d.sync_cards(&[B], &profile).unwrap();
        let expected_explicit = match case {
            Case::ReadOnly | Case::SaveNameError => {
                // Accepted divergence: when sync cannot publish the new card
                // or save the pending name, its result retains the old device
                // card; quiet resolution still projects catalogue metadata.
                Resolution::Known(card("Device name", "Device description"))
            }
            Case::Future | Case::ReadOnlyWithoutSidecar => {
                Resolution::Known(card("Catalogue name", "Catalogue description"))
            }
            Case::InvalidCatalogue | Case::CatalogueError => {
                Resolution::Known(card("Device name", "Device description"))
            }
            Case::FutureWithoutCatalogue
            | Case::InvalidCatalogueWithoutSidecar
            | Case::Missing
            | Case::CatalogueErrorWithoutSidecar => Resolution::Unknown,
        };
        assert_eq!(explicit.resolutions, vec![expected_explicit], "{case:?}");
        let expected_failure = match case {
            Case::InvalidCatalogue | Case::InvalidCatalogueWithoutSidecar => {
                Some((SyncStage::Publish, Error::InvalidCard))
            }
            Case::CatalogueError | Case::CatalogueErrorWithoutSidecar => {
                Some((SyncStage::Catalogue, Error::Io))
            }
            Case::SaveNameError => Some((SyncStage::SaveName, Error::Io)),
            Case::ReadOnly | Case::ReadOnlyWithoutSidecar => {
                Some((SyncStage::Publish, Error::UnknownFormat))
            }
            _ => None,
        };
        let expected_failures: Vec<_> = expected_failure
            .into_iter()
            .map(|(stage, error)| SyncFailure {
                uuid: B,
                stage,
                error,
            })
            .collect();
        assert_eq!(explicit.failures, expected_failures, "{case:?}");
        assert_eq!(
            profile.saves.get(),
            usize::from(matches!(case, Case::SaveNameError)),
            "{case:?}"
        );
    }
}

#[test]
fn connection_card_copies_share_one_barrier_and_report_a_failed_one() {
    let f = Fixture::new();
    let d = f.device();
    let report = d.sync_cards(&[A, B], &CopiedCards).unwrap();
    assert!(report.failures.is_empty());
    assert_eq!(d.volume_syncs.get(), 1);
    // Nothing left to copy: no barrier at all.
    d.sync_cards(&[A, B], &CopiedCards).unwrap();
    assert_eq!(d.volume_syncs.get(), 1);

    let f = Fixture::new();
    let mut d = f.device();
    d.fail_volume_sync = true;
    let report = d.sync_cards(&[A, B], &CopiedCards).unwrap();
    let mut failed: Vec<_> = report
        .failures
        .iter()
        .map(|v| (v.uuid, v.stage, v.error))
        .collect();
    failed.sort_by_key(|v| v.0);
    assert_eq!(
        failed,
        vec![
            (A, super::super::cards::SyncStage::Publish, Error::Io),
            (B, super::super::cards::SyncStage::Publish, Error::Io)
        ]
    );
}

#[test]
fn card_barrier_also_runs_after_a_refused_write_and_keeps_its_error() {
    let f = Fixture::new();
    let d = f.device();
    let dir = f.root.join(super::super::cards::DIRECTORY);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(format!("{B}.json")), br#"{"version":9}"#).unwrap();
    let card = super::super::cards::Card {
        title: "Titre".into(),
        description: String::new(),
        age_min: None,
        age_max: None,
        cover_png: None,
    };
    assert_eq!(
        d.write_card(B, Some(&EmptyCards), card),
        Err(Error::FutureCard)
    );
    assert_eq!(d.volume_syncs.get(), 1);
}

#[test]
fn final_barrier_failure_downgrades_every_success_but_keeps_warnings() {
    use writes::not_durable;
    let repaired = Outcome::Repaired {
        kept: 1,
        removed: vec![A],
        empty: false,
        truncated: true,
    };
    assert_eq!(
        not_durable(repaired, false, false),
        Outcome::RepairedNotDurable {
            kept: 1,
            removed: vec![A],
            empty: false,
            truncated: true,
        }
    );
    assert_eq!(
        not_durable(Outcome::RestoredWithResidue, false, true),
        Outcome::RestoredNotDurable
    );
    for (outcome, install, restore, expected) in [
        (Outcome::Complete, true, false, Outcome::InstalledNotDurable),
        (Outcome::Complete, false, true, Outcome::RestoredNotDurable),
        (Outcome::Complete, false, false, Outcome::StateWarning),
        // Already not durable: unchanged, never back to Complete.
        (
            Outcome::RemovedWithOrphan,
            false,
            false,
            Outcome::RemovedWithOrphan,
        ),
        (
            Outcome::InstalledNotDurable,
            true,
            false,
            Outcome::InstalledNotDurable,
        ),
        (Outcome::StateWarning, false, false, Outcome::StateWarning),
    ] {
        assert_eq!(not_durable(outcome, install, restore), expected);
    }
}
