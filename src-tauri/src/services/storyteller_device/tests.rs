use super::*;

#[test]
fn safe_accepts_existing_absolute_and_canonical_directories() {
    let root = std::env::temp_dir().canonicalize().unwrap();
    safe(&root, true).unwrap();
    safe(&root.canonicalize().unwrap(), true).unwrap();
    assert!(matches!(
        safe(Path::new("relative"), true),
        Err(Error::UnsafePath)
    ));
    let mut parent = root.as_os_str().to_os_string();
    parent.push(std::path::MAIN_SEPARATOR_STR);
    parent.push("..");
    assert!(matches!(
        safe(Path::new(&parent), true),
        Err(Error::UnsafePath)
    ));
}
const A: Uuid = Uuid::from_u128(0x00000000000040008000000000000001);
const B: Uuid = Uuid::from_u128(0x00000000000040008000000000000002);
const C: Uuid = Uuid::from_u128(0x00000000000040008000000000000003);
struct FakeVolumes(Vec<PathBuf>);
impl Volumes for FakeVolumes {
    fn mounted_removable(&self) -> Result<Vec<PathBuf>> {
        Ok(self.0.clone())
    }
    fn capacity(&self, _: &Path) -> Result<(u64, u64)> {
        Ok((4096, 8192))
    }
}
struct Catalogue;
impl OfficialCatalogue for Catalogue {
    type Error = ();
    fn contains_official(&self, id: &str) -> std::result::Result<bool, ()> {
        Ok(id == A.to_string())
    }
}
struct Fixture {
    base: PathBuf,
    root: PathBuf,
    data: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("l8a-{}", Uuid::new_v4()));
        let root = base.join("device");
        let data = base.join("app-data");
        fs::create_dir_all(root.join(".content")).unwrap();
        fs::create_dir(&data).unwrap();
        let mut md = vec![0; 112];
        md[..2].copy_from_slice(&6u16.to_le_bytes());
        md[2..9].copy_from_slice(b"12.34.5");
        md[26..40].copy_from_slice(b"00000000000042");
        fs::write(root.join(".md"), md).unwrap();
        fs::write(root.join(".pi.hidden"), b"").unwrap();
        for name in [".cfg", ".logo", ".bgt", "uplugged", "unknown"] {
            fs::write(root.join(name), name).unwrap();
        }
        for name in ["etc", "System Volume Information"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::write(root.join(name).join("unknown"), b"keep").unwrap();
        }
        let f = Self { base, root, data };
        f.story(A);
        f.story(B);
        f.list(&[A, B]);
        f
    }
    fn story(&self, id: Uuid) {
        let dir = self.root.join(".content").join(folder(id));
        fs::create_dir(&dir).unwrap();
        for name in ["li", "ri", "si"] {
            fs::write(dir.join(name), [0; 16]).unwrap();
        }
        fs::write(dir.join("bt"), [0; 32]).unwrap();
        let mut ni = vec![0; 556];
        ni[..2].copy_from_slice(&1u16.to_le_bytes());
        for (off, n) in [(4, 512u32), (8, 44), (12, 1), (16, 1), (20, 0)] {
            ni[off..off + 4].copy_from_slice(&n.to_le_bytes());
        }
        ni[24] = 1; // one sound is referenced despite the permitted count undercount
        fs::write(dir.join("ni"), ni).unwrap();
        for kind in ["rf", "sf"] {
            fs::create_dir_all(dir.join(kind).join("000")).unwrap();
            fs::write(dir.join(kind).join("000/00000000"), b"fake media").unwrap();
        }
    }
    fn list(&self, ids: &[Uuid]) {
        fs::write(
            self.root.join(".pi"),
            ids.iter().flat_map(|v| *v.as_bytes()).collect::<Vec<_>>(),
        )
        .unwrap();
    }
    fn device(&self) -> Device {
        Device::open(&self.root, &self.data).unwrap()
    }
    fn inventory(&self) -> Inventory {
        inspect(&self.root, &FakeVolumes(vec![]), Some(&Catalogue)).unwrap()
    }
    fn backups(&self) -> Vec<PathBuf> {
        let p = self.data.join("storyteller-backups/00000000000042");
        if !p.exists() {
            return vec![];
        }
        fs::read_dir(p)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| !p.file_name().unwrap().to_string_lossy().starts_with('.'))
            .collect()
    }
    fn coherent(&self) {
        for id in read::playlist(&self.root).unwrap() {
            assert!(self.root.join(".content").join(folder(id)).is_dir());
        }
    }
    fn untouched(&self) {
        let m = read::metadata(&self.root).unwrap();
        assert_eq!(m.serial(), Some("00000000000042"));
        for name in [".cfg", ".logo", ".bgt", "uplugged", "unknown"] {
            assert_eq!(fs::read(self.root.join(name)).unwrap(), name.as_bytes());
        }
        for name in ["etc", "System Volume Information"] {
            assert_eq!(
                fs::read(self.root.join(name).join("unknown")).unwrap(),
                b"keep"
            );
        }
        assert_eq!(fs::read(self.root.join(".pi.hidden")).unwrap(), b"");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}
#[test]
fn injected_detection_and_metadata_privacy() {
    let f = Fixture::new();
    assert_eq!(
        detect(&FakeVolumes(vec![
            f.data.clone(),
            f.root.clone(),
            f.root.clone()
        ]))
        .unwrap(),
        vec![f.root.clone()]
    );
    let inv = f.inventory();
    assert_eq!(inv.metadata.firmware.as_deref(), Some("12.34.5"));
    assert_eq!(inv.metadata.read_only, None);
    assert!(!format!("{inv:?}").contains("00000000000042"));
    let source = include_str!("mod.rs").to_owned()
        + include_str!("read.rs")
        + include_str!("writes.rs")
        + include_str!("platform.rs");
    for forbidden in ["log::", "eprintln!", "println!", "tracing::"] {
        assert!(!source.contains(forbidden));
    }
}
#[test]
fn invalid_metadata_visible_but_all_actions_refused() {
    let f = Fixture::new();
    let original = fs::read(f.root.join(".md")).unwrap();
    for (bytes, error) in [
        (vec![8, 0], Error::UnknownFormat),
        (vec![1, 0], Error::UnknownFormat),
        (vec![6, 0], Error::MetadataSize),
        (vec![0], Error::InvalidMetadata),
        (
            {
                let mut b = original.clone();
                b[2] = b'x';
                b
            },
            Error::InvalidMetadata,
        ),
        (
            {
                let mut b = original.clone();
                b[26] = b'/';
                b
            },
            Error::InvalidMetadata,
        ),
        (
            {
                let mut b = original.clone();
                b.push(0);
                b
            },
            Error::MetadataSize,
        ),
    ] {
        fs::write(f.root.join(".md"), bytes).unwrap();
        assert_eq!(f.inventory().metadata.read_only, Some(error));
        for action in [
            Action::Remove(A),
            Action::Reorder(vec![B, A]),
            Action::Restore {
                folder: folder(C),
                known_uuid: Some(C),
            },
            Action::DeleteOrphan(folder(C)),
        ] {
            assert_eq!(f.device().apply(action), Err(error));
        }
        assert!(f.backups().is_empty());
    }
}
#[test]
fn inventory_both_orphan_directions_and_media() {
    let f = Fixture::new();
    f.story(C);
    fs::remove_dir_all(f.root.join(".content").join(folder(B))).unwrap();
    let inv = f.inventory();
    assert_eq!(inv.story_count, 2);
    assert_eq!((inv.free_bytes, inv.total_bytes), (Some(4096), Some(8192)));
    assert!(inv.stories[0].official == OfficialProvenance::Official && inv.stories[0].complete);
    assert!(!inv.stories[1].directory_present);
    assert_eq!(inv.stories[1].official, OfficialProvenance::NotOfficial);
    assert!(inv.stories[2].complete && !inv.stories[2].listed && inv.stories[2].uuid.is_none());
    fs::remove_file(
        f.root
            .join(".content")
            .join(folder(C))
            .join("sf/000/00000000"),
    )
    .unwrap();
    assert!(!f.inventory().stories[2].complete);
    assert_eq!(
        f.device().apply(Action::Reorder(vec![B, A])),
        Err(Error::PlaylistDamaged)
    );
    assert_eq!(f.inventory().playlist_state, PlaylistState::Damaged);
    assert_eq!(
        f.device().apply(Action::Remove(B)),
        Err(Error::PlaylistDamaged)
    );
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 1,
            empty: false,
            truncated: false,
            removed: vec![B],
        })
    );
    f.coherent();
}
#[test]
fn exact_operations_and_rotating_opaque_backups() {
    let f = Fixture::new();
    let md = fs::read(f.root.join(".md")).unwrap();
    let d = f.device();
    d.apply(Action::Reorder(vec![B, A])).unwrap();
    let backup = f.backups().pop().unwrap();
    assert_eq!(fs::read(backup.join(".md")).unwrap(), md);
    assert_eq!(
        fs::read(backup.join(".pi")).unwrap(),
        [A.as_bytes().as_slice(), B.as_bytes().as_slice()].concat()
    );
    assert_eq!(fs::read(backup.join(".pi.hidden")).unwrap(), b"");
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    d.apply(Action::Remove(A)).unwrap();
    assert!(!f.root.join(".content").join(folder(A)).exists());
    f.story(C);
    d.apply(Action::Restore {
        folder: folder(C),
        known_uuid: Some(C),
    })
    .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, C]);
    f.story(A);
    d.apply(Action::DeleteOrphan(folder(A))).unwrap();
    assert!(!f.root.join(".content").join(folder(A)).exists());
    for i in 0..12 {
        d.apply(Action::Reorder(if i % 2 == 0 {
            vec![C, B]
        } else {
            vec![B, C]
        }))
        .unwrap();
    }
    assert_eq!(f.backups().len(), 10);
    f.coherent();
    f.untouched();
}
#[test]
fn explicit_refusals() {
    let f = Fixture::new();
    f.story(C);
    for order in [vec![A], vec![A, A], vec![A, C]] {
        assert_eq!(
            f.device().apply(Action::Reorder(order)),
            Err(Error::InvalidOrder)
        );
    }
    assert_eq!(
        f.device().apply(Action::Restore {
            folder: folder(C),
            known_uuid: None
        }),
        Err(Error::UnknownUuid)
    );
    assert_eq!(
        f.device().apply(Action::Restore {
            folder: folder(C),
            known_uuid: Some(B)
        }),
        Err(Error::UnknownUuid)
    );
    fs::remove_file(f.root.join(".content").join(folder(C)).join("si")).unwrap();
    assert_eq!(
        f.device().apply(Action::Restore {
            folder: folder(C),
            known_uuid: Some(C)
        }),
        Err(Error::IncompleteStory)
    );
    assert_eq!(
        f.device().apply(Action::DeleteOrphan("../etc".into())),
        Err(Error::UnsafePath)
    );
    assert_eq!(
        f.device().apply(Action::DeleteOrphan(folder(A))),
        Err(Error::InvalidPlaylist)
    );
    assert!(f.backups().is_empty());
    f.list(&[A, A]);
    assert_eq!(f.inventory().playlist_error, Some(Error::SuffixCollision));
    fs::write(f.root.join(".pi"), [0; 17]).unwrap();
    assert_eq!(f.inventory().playlist_error, Some(Error::InvalidPlaylist));
}
#[test]
fn failed_backup_refuses_every_mutation() {
    for n in 0..4 {
        let f = Fixture::new();
        f.story(C);
        fs::write(f.data.join("storyteller-backups"), b"blocked").unwrap();
        let before = fs::read(f.root.join(".pi")).unwrap();
        let action = match n {
            0 => Action::Remove(A),
            1 => Action::Reorder(vec![B, A]),
            2 => Action::Restore {
                folder: folder(C),
                known_uuid: Some(C),
            },
            _ => Action::DeleteOrphan(folder(C)),
        };
        assert_eq!(f.device().apply(action), Err(Error::BackupFailed));
        assert_eq!(fs::read(f.root.join(".pi")).unwrap(), before);
        assert!(f.root.join(".content").join(folder(C)).exists());
        f.coherent();
        f.untouched();
    }
}
#[test]
fn interruption_at_every_checkpoint_for_every_action() {
    for op in 0..4 {
        let mut reached_success = false;
        for step in 0..80 {
            let f = Fixture::new();
            f.story(C);
            let mut d = f.device();
            d.fail_at = Some(step);
            let action = match op {
                0 => Action::Remove(A),
                1 => Action::Reorder(vec![B, A]),
                2 => Action::Restore {
                    folder: folder(C),
                    known_uuid: Some(C),
                },
                _ => Action::DeleteOrphan(folder(C)),
            };
            let result = d.apply(action);
            f.coherent();
            f.untouched();
            if result.is_ok() {
                reached_success = true;
                break;
            }
            assert!(
                matches!(result, Err(Error::Interrupted | Error::BackupFailed)),
                "{result:?}, op={op}, step={step}"
            );
            if read::playlist(&f.root).unwrap() != vec![A, B] {
                assert!(!f.backups().is_empty());
            }
        }
        assert!(reached_success);
    }
}
#[test]
fn optional_hidden_absent_and_backup_destination_on_device_refused() {
    let f = Fixture::new();
    fs::remove_file(f.root.join(".pi.hidden")).unwrap();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    assert!(!f.backups()[0].join(".pi.hidden").exists());
    assert!(matches!(
        Device::open(&f.root, &f.root),
        Err(Error::UnsafePath)
    ));
}
#[cfg(unix)]
#[test]
fn symlinks_never_followed_or_removed() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.base.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), b"safe").unwrap();
    symlink(
        &outside,
        f.root.join(".content").join(folder(A)).join("escape"),
    )
    .unwrap();
    assert_eq!(f.device().apply(Action::Remove(A)), Err(Error::UnsafePath));
    fs::remove_file(f.root.join(".pi.hidden")).unwrap();
    symlink(outside.join("keep"), f.root.join(".pi.hidden")).unwrap();
    assert_eq!(
        f.device().apply(Action::Reorder(vec![B, A])),
        Err(Error::BackupFailed)
    );
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"safe");
}

#[test]
fn clear_index_checks_actual_names_and_hostile_counts_do_not_panic() {
    let f = Fixture::new();
    let story = f.root.join(".content").join(folder(A));
    fs::rename(story.join("rf/000/00000000"), story.join("rf/000/ABCDEF01")).unwrap();
    fs::write(story.join("ri"), b"000\\ABCDEF01\0\0\0\0").unwrap();
    assert!(read::complete(&story, 6));
    fs::write(story.join("ri"), b"000\\ABCDEF02\0\0\0\0").unwrap();
    assert!(!read::complete(&story, 6));
    let mut ni = fs::read(story.join("ni")).unwrap();
    ni[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
    fs::write(story.join("ni"), ni).unwrap();
    assert!(!read::complete(&story, 6));
}

#[test]
fn native_replace_preserves_old_target_on_failure() {
    let f = Fixture::new();
    let source = f.root.join("replacement-test");
    fs::write(&source, b"new").unwrap();
    let target = f.root.join("replacement-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), b"old").unwrap();
    assert!(platform::replace(&source, &target).is_err());
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"old");
    fs::remove_dir_all(&target).unwrap();
    fs::write(&target, b"old").unwrap();
    platform::replace(&source, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert!(!source.exists());
}

#[test]
fn catalogue_failure_is_not_interpreted_as_non_official() {
    struct Broken;
    impl OfficialCatalogue for Broken {
        type Error = ();
        fn contains_official(&self, _: &str) -> std::result::Result<bool, ()> {
            Err(())
        }
    }
    let f = Fixture::new();
    // Deliberately changed: a failed catalogue now yields an inventory with
    // conservative Unknown provenance rather than Error::Catalogue.
    let inv = inspect(&f.root, &FakeVolumes(vec![]), Some(&Broken)).unwrap();
    assert!(inv.recognition_degraded);
    assert!(inv
        .stories
        .iter()
        .all(|s| s.official == OfficialProvenance::Unknown));
    assert!(inspect(&f.root, &FakeVolumes(vec![]), None::<&Catalogue>)
        .unwrap()
        .stories
        .iter()
        .all(|s| s.official == OfficialProvenance::Unknown));
}

#[cfg(unix)]
#[test]
fn dangling_hidden_link_is_a_backup_failure() {
    let f = Fixture::new();
    fs::remove_file(f.root.join(".pi.hidden")).unwrap();
    std::os::unix::fs::symlink(f.base.join("absent"), f.root.join(".pi.hidden")).unwrap();
    assert_eq!(
        f.device().apply(Action::Reorder(vec![B, A])),
        Err(Error::BackupFailed)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}

#[test]
fn crash_recovery_keeps_temporary_until_explicit_restore() {
    for missing in [false, true] {
        let f = Fixture::new();
        let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
        fs::write(
            &temp,
            [B.as_bytes().as_slice(), A.as_bytes().as_slice()].concat(),
        )
        .unwrap();
        if missing {
            fs::remove_file(f.root.join(".pi")).unwrap();
        }
        assert_eq!(
            f.inventory().recovery,
            Some(if missing {
                RecoveryState::MissingPlaylist
            } else {
                RecoveryState::PlaylistAndTemporary
            })
        );
        assert!(temp.exists());
        assert_eq!(
            f.device().apply(Action::Reorder(vec![B, A])),
            Err(Error::RecoveryRequired)
        );
        f.device().apply(Action::RestorePlaylist).unwrap();
        assert_eq!(
            read::playlist(&f.root).unwrap(),
            if missing { vec![B, A] } else { vec![A, B] }
        );
        assert!(!temp.exists());
        assert_eq!(f.inventory().recovery, None);
    }
}
#[test]
fn invalid_temporary_restores_latest_d15() {
    let f = Fixture::new();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
    fs::write(&temp, [0; 17]).unwrap();
    fs::remove_file(f.root.join(".pi")).unwrap();
    f.device().apply(Action::RestorePlaylist).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    assert!(!temp.exists());
}
#[test]
fn identical_order_and_orphan_deletion_do_not_replace_playlist() {
    let f = Fixture::new();
    let before = fs::metadata(f.root.join(".pi"))
        .unwrap()
        .modified()
        .unwrap();
    f.device().apply(Action::Reorder(vec![A, B])).unwrap();
    assert!(f.backups().is_empty());
    f.story(C);
    f.device().apply(Action::DeleteOrphan(folder(C))).unwrap();
    assert_eq!(
        fs::metadata(f.root.join(".pi"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(f.backups().len(), 1);
}
#[test]
fn probable_hidden_story_is_protected() {
    let f = Fixture::new();
    f.story(C);
    fs::write(f.root.join(".pi.hidden"), C.as_bytes()).unwrap();
    let inv = f.inventory();
    assert!(inv.stories[2].probable_hidden);
    assert_eq!(inv.stories[2].uuid, Some(C));
    assert_eq!(
        f.device().apply(Action::DeleteOrphan(folder(C))),
        Err(Error::HiddenStory)
    );
}
#[cfg(unix)]
#[test]
fn application_data_may_have_symlink_ancestor() {
    let f = Fixture::new();
    let alias = f.base.join("alias");
    std::os::unix::fs::symlink(&f.data, &alias).unwrap();
    Device::open(&f.root, &alias)
        .unwrap()
        .apply(Action::Reorder(vec![B, A]))
        .unwrap();
    assert_eq!(f.backups().len(), 1);
    fs::remove_dir_all(f.data.join("storyteller-backups")).unwrap();
    std::os::unix::fs::symlink(&f.root, f.data.join("storyteller-backups")).unwrap();
    assert_eq!(
        f.device().apply(Action::Reorder(vec![A, B])),
        Err(Error::BackupFailed)
    );
}
#[test]
fn backwards_clock_cannot_evict_current_backup() {
    let f = Fixture::new();
    // Simulate ten copies made by the timestamp implementation far in the future.
    let parent = f.data.join("storyteller-backups/00000000000042");
    fs::create_dir_all(&parent).unwrap();
    for n in 0..10u128 {
        let copy = parent.join(format!(
            "{:039}-{}",
            9_000_000_000_000_000_000_000u128 + n,
            Uuid::new_v4()
        ));
        fs::create_dir(copy).unwrap();
    }
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    let copies = f.backups();
    assert_eq!(copies.len(), 10);
    assert_eq!(copies.iter().filter(|p| p.join(".pi").exists()).count(), 1);
}
#[test]
fn legacy_bt_size_and_unknown_capacity() {
    let f = Fixture::new();
    let story = f.root.join(".content").join(folder(A));
    fs::write(story.join("bt"), [0; 64]).unwrap();
    assert!(!read::complete(&story, 6));
    assert!(read::complete(&story, 1));
    assert!(read::complete(&story, 2));
    struct NoCapacity;
    impl Volumes for NoCapacity {
        fn mounted_removable(&self) -> Result<Vec<PathBuf>> {
            Ok(vec![])
        }
        fn capacity(&self, _: &Path) -> Result<(u64, u64)> {
            Err(Error::Io)
        }
    }
    let inv = inspect(&f.root, &NoCapacity, Some(&Catalogue)).unwrap();
    assert_eq!((inv.free_bytes, inv.total_bytes), (None, None));
}
#[test]
fn overly_deep_story_is_refused_before_mutation() {
    let f = Fixture::new();
    let mut path = f.root.join(".content").join(folder(A));
    for _ in 0..66 {
        path = path.join("d");
        fs::create_dir(&path).unwrap();
    }
    assert_eq!(f.device().apply(Action::Remove(A)), Err(Error::UnsafePath));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}

#[test]
fn directory_sync_failure_after_verified_replacement_is_success() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_publish_sync = true;
    d.apply(Action::Reorder(vec![B, A])).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
}
#[cfg(unix)]
#[test]
fn detection_skips_unsafe_volume_and_continues() {
    let f = Fixture::new();
    let alias = f.base.join("unsafe-volume");
    std::os::unix::fs::symlink(&f.root, &alias).unwrap();
    assert_eq!(
        detect(&FakeVolumes(vec![alias, f.root.clone()])).unwrap(),
        vec![f.root.clone()]
    );
}
#[test]
fn unfinished_write_retains_temporary_and_requires_explicit_recovery() {
    let f = Fixture::new();
    let mut d = f.device();
    // Locate an interrupted write after exclusive creation, before publication.
    for step in 0..40 {
        d.fail_at = Some(step);
        let result = d.apply(Action::Reorder(vec![B, A]));
        if !read::temporaries(&f.root).unwrap().is_empty() {
            assert!(result.is_err());
            assert_eq!(
                f.inventory().recovery,
                Some(RecoveryState::PlaylistAndTemporary)
            );
            return;
        }
        // A fresh Device resets the injected checkpoint counter.
        d = f.device();
    }
    panic!("no interrupted temporary found");
}

#[test]
fn orphan_deletion_does_not_require_repairing_other_dangling_entries() {
    let f = Fixture::new();
    f.story(C);
    fs::remove_dir_all(f.root.join(".content").join(folder(B))).unwrap();
    f.device().apply(Action::DeleteOrphan(folder(C))).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}
#[test]
fn recovery_refuses_invalid_uuids_and_missing_folders_without_d15() {
    for bytes in [vec![0; 16], C.as_bytes().to_vec(), vec![0; 17]] {
        let f = Fixture::new();
        let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
        fs::write(&temp, &bytes).unwrap();
        fs::remove_file(f.root.join(".pi")).unwrap();
        assert!(f.device().apply(Action::RestorePlaylist).is_err());
        assert_eq!(fs::read(&temp).unwrap(), bytes);
        assert!(!f.root.join(".pi").exists());
    }
}

#[test]
fn partial_temporary_never_replaces_readable_playlist() {
    for bytes in [vec![], A.as_bytes().to_vec()] {
        let f = Fixture::new();
        let before = fs::metadata(f.root.join(".pi"))
            .unwrap()
            .modified()
            .unwrap();
        let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
        fs::write(&temp, bytes).unwrap();
        f.device().apply(Action::RestorePlaylist).unwrap();
        assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
        assert_eq!(
            fs::metadata(f.root.join(".pi"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        assert!(!temp.exists());
        assert_eq!(f.backups().len(), 1);
    }
}
#[test]
fn healthy_playlist_cannot_be_rolled_back_by_restore() {
    let f = Fixture::new();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    assert_eq!(
        f.device().apply(Action::RestorePlaylist),
        Err(Error::NoRecoveryRequired)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    assert_eq!(f.backups().len(), 1);
}
#[test]
fn identical_temporary_is_retained_and_does_not_block_actions() {
    let f = Fixture::new();
    let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
    fs::copy(f.root.join(".pi"), &temp).unwrap();
    assert_eq!(
        f.inventory().recovery,
        Some(RecoveryState::ResidueDiskCheckRecommended)
    );
    assert_eq!(f.inventory().playlist_state, PlaylistState::Readable);
    f.device().apply(Action::RestorePlaylist).unwrap();
    assert!(temp.exists());
    f.story(C);
    f.device().apply(Action::DeleteOrphan(folder(C))).unwrap();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    assert!(temp.exists());
}
#[test]
fn third_party_uuid_variant_is_accepted_but_nil_is_rejected() {
    let f = Fixture::new();
    let id = Uuid::from_u128(0x12345678);
    f.story(id);
    f.list(&[id]);
    assert_eq!(read::playlist(&f.root).unwrap(), vec![id]);
    f.device().apply(Action::Remove(id)).unwrap();
    f.list(&[Uuid::nil()]);
    assert_eq!(read::playlist(&f.root), Err(Error::InvalidPlaylist));
}
#[test]
fn non_durable_removal_retains_story_as_orphan() {
    let f = Fixture::new();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(
        d.apply(Action::Remove(A)),
        Ok(writes::Outcome::RemovedWithOrphan)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B]);
    assert!(f.root.join(".content").join(folder(A)).is_dir());
    let inv = f.inventory();
    assert!(inv
        .stories
        .iter()
        .any(|s| s.uuid.is_none() && s.folder == folder(A) && !s.listed));
    f.device().apply(Action::DeleteOrphan(folder(A))).unwrap();
}

#[test]
fn recovery_rechecks_metadata_and_playlist_after_d15() {
    for change in [
        (|root: &Path| {
            let mut md = fs::read(root.join(".md")).unwrap();
            md[2] = b'9';
            fs::write(root.join(".md"), md).unwrap();
        }) as fn(&Path),
        |root: &Path| {
            fs::write(root.join(".pi"), B.as_bytes()).unwrap();
        },
    ] {
        for missing in [false, true] {
            let f = Fixture::new();
            let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
            fs::write(&temp, A.as_bytes()).unwrap();
            if missing {
                fs::remove_file(f.root.join(".pi")).unwrap();
            }
            let mut d = f.device();
            d.after_recovery_backup = Some(change);
            assert_eq!(d.apply(Action::RestorePlaylist), Err(Error::Changed));
            assert!(temp.exists());
            assert_eq!(f.backups().len(), 1);
        }
    }
}
#[test]
fn unreadable_playlist_uses_d15_even_with_parseable_temporary() {
    let f = Fixture::new();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
    fs::write(&temp, B.as_bytes()).unwrap();
    fs::write(f.root.join(".pi"), [0; 17]).unwrap();
    f.device().apply(Action::RestorePlaylist).unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    assert!(!temp.exists());
}

#[test]
fn empty_recovery_candidate_uses_backup_and_durable_adoption_cleans_up() {
    let f = Fixture::new();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    fs::remove_file(f.root.join(".pi")).unwrap();
    let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
    fs::write(&temp, []).unwrap();
    assert_eq!(
        f.device().apply(Action::RestorePlaylist),
        Ok(Outcome::Complete)
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    assert!(!temp.exists());
}
#[test]
fn recovery_reports_non_durable_publication_and_failed_cleanup() {
    for cleanup in [false, true] {
        let f = Fixture::new();
        fs::remove_file(f.root.join(".pi")).unwrap();
        let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
        fs::write(&temp, B.as_bytes()).unwrap();
        let mut device = f.device();
        device.fail_publish_sync = !cleanup;
        device.fail_cleanup = cleanup;
        assert_eq!(
            device.apply(Action::RestorePlaylist),
            Ok(if cleanup {
                Outcome::RestoredWithResidue
            } else {
                Outcome::RestoredNotDurable
            })
        );
        assert!(temp.exists());
        assert_eq!(read::playlist(&f.root).unwrap(), vec![B]);
    }
}

#[test]
fn recovery_sync_failure_only_means_residue_if_a_temporary_was_removed() {
    for identical in [false, true] {
        let f = Fixture::new();
        let temp = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
        fs::write(
            &temp,
            if identical {
                fs::read(f.root.join(".pi")).unwrap()
            } else {
                B.as_bytes().to_vec()
            },
        )
        .unwrap();
        let mut d = f.device();
        d.fail_cleanup_sync = true;
        assert_eq!(
            d.apply(Action::RestorePlaylist),
            Ok(if identical {
                Outcome::Complete
            } else {
                Outcome::RestoredWithResidue
            })
        );
        assert_eq!(temp.exists(), identical);
        assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    }
}
#[test]
fn unsafe_temporary_after_durable_restore_is_refused() {
    let f = Fixture::new();
    fs::remove_file(f.root.join(".pi")).unwrap();
    fs::write(f.root.join(format!(".story-studio-pi-{B}")), B.as_bytes()).unwrap();
    let mut d = f.device();
    d.before_recovery_cleanup = Some(|root| {
        let path = root.join(format!(".story-studio-pi-{B}"));
        fs::remove_file(&path).unwrap();
        fs::create_dir(path).unwrap();
    });
    assert_eq!(d.apply(Action::RestorePlaylist), Err(Error::UnsafePath));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B]);
}

#[test]
fn unsafe_temporary_with_retained_playlist_is_refused() {
    let f = Fixture::new();
    fs::write(f.root.join(format!(".story-studio-pi-{B}")), B.as_bytes()).unwrap();
    let mut d = f.device();
    d.before_recovery_cleanup = Some(|root| {
        let path = root.join(format!(".story-studio-pi-{B}"));
        fs::remove_file(&path).unwrap();
        fs::create_dir(path).unwrap();
    });
    assert_eq!(d.apply(Action::RestorePlaylist), Err(Error::UnsafePath));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}
#[cfg(unix)]
#[test]
fn linked_temporary_with_retained_playlist_is_refused() {
    let f = Fixture::new();
    fs::write(f.root.join(format!(".story-studio-pi-{B}")), B.as_bytes()).unwrap();
    let mut d = f.device();
    d.before_recovery_cleanup = Some(|root| {
        let path = root.join(format!(".story-studio-pi-{B}"));
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.join(".pi"), path).unwrap();
    });
    assert_eq!(d.apply(Action::RestorePlaylist), Err(Error::UnsafePath));
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}

mod cards {
    use super::super::cards::*;
    use super::*;
    use std::{cell::RefCell, collections::BTreeMap};
    #[derive(Default)]
    struct Profile(RefCell<BTreeMap<Uuid, Card>>);
    impl OfficialCatalogue for Profile {
        type Error = ();
        fn contains_official(&self, id: &str) -> std::result::Result<bool, ()> {
            Ok(id == A.to_string())
        }
    }
    impl CardCatalogue for Profile {
        fn official_title(&self, _: Uuid) -> Result<Option<String>> {
            Ok(Some("Titre officiel".into()))
        }
        fn card(&self, id: Uuid) -> Result<Option<CatalogueCard>> {
            Ok(self.0.borrow().get(&id).cloned().map(|card| CatalogueCard {
                card,
                cover_pending: false,
            }))
        }
        fn save_name(&self, id: Uuid, title: &str) -> Result<()> {
            if let Some(card) = self.0.borrow_mut().get_mut(&id) {
                card.title = title.into();
            }
            Ok(())
        }
    }
    fn card() -> Card {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(640, 480)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        Card {
            title: "Mon histoire".into(),
            description: "Une aventure".into(),
            age_min: Some(4),
            age_max: Some(8),
            cover_png: Some(reduced_cover(&bytes.into_inner()).unwrap()),
        }
    }
    #[test]
    fn card_sync_resumes_legacy_hidden_folder_move() {
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
        let profile = Profile::default();
        profile.0.borrow_mut().insert(B, card());
        assert!(f
            .device()
            .sync_cards(&[B], &profile)
            .unwrap()
            .failures
            .is_empty());
        assert!(!f.root.join(".content").join(folder(B)).exists());
        assert!(f
            .root
            .join(".storystudio/masquees")
            .join(folder(B))
            .is_dir());
        assert_eq!(read::playlist(&f.root).unwrap(), vec![A]);
    }
    #[test]
    fn syncing_many_cards_keeps_one_backup_and_previous_sessions() {
        let f = Fixture::new();
        f.device().apply(Action::Reorder(vec![B, A])).unwrap();
        f.device().apply(Action::Reorder(vec![A, B])).unwrap();
        let previous = f.backups();
        let profile = Profile::default();
        let ids: Vec<_> = (3..18)
            .map(|n| Uuid::from_u128(0x00000000000040008000000000000000 + n))
            .collect();
        for &id in &ids {
            profile.0.borrow_mut().insert(id, card());
        }
        let report = f.device().sync_cards(&ids, &profile).unwrap();
        assert!(report.failures.is_empty());
        let after = f.backups();
        assert_eq!(after.len(), previous.len() + 1);
        assert!(previous.iter().all(|p| after.contains(p)));
        // A second sync (including changed card contents) has the same three
        // opaque files as the last snapshot, so it creates no duplicate copy.
        for c in profile.0.borrow_mut().values_mut() {
            c.title = "updated".into();
        }
        assert!(f
            .device()
            .sync_cards(&ids, &profile)
            .unwrap()
            .failures
            .is_empty());
        assert_eq!(f.backups().len(), after.len());
    }
    fn contents(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path == root.join(DIRECTORY) {
                    continue;
                }
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    out.insert(
                        path.strip_prefix(root).unwrap().into(),
                        fs::read(path).unwrap(),
                    );
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }
    #[test]
    fn sent_card_survives_catalogue_removal_and_another_profile_without_payload_changes() {
        let f = Fixture::new();
        let before = contents(&f.root);
        let p = Profile::default();
        let expected = card();
        p.0.borrow_mut().insert(B, expected.clone());
        assert!(f
            .device()
            .write_card(B, Some(&p), expected.clone())
            .unwrap());
        p.0.borrow_mut().clear();
        assert_eq!(
            f.device().resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(expected.clone())
        );
        let other_data = f.base.join("another-profile");
        fs::create_dir(&other_data).unwrap();
        let other = Device::open(&f.root, &other_data).unwrap();
        assert_eq!(
            other.resolve_card(B, Some(&Profile::default())).unwrap(),
            Resolution::Known(expected)
        );
        assert_eq!(contents(&f.root), before);
    }
    #[test]
    fn reconstruction_catalogue_corrections_and_device_names() {
        let f = Fixture::new();
        let before = contents(&f.root);
        let p = Profile::default();
        p.0.borrow_mut().insert(B, card());
        let d = f.device();
        d.sync_cards(&[A, B, C], &p).unwrap();
        fs::remove_dir_all(f.root.join(DIRECTORY)).unwrap();
        assert!(matches!(
            d.resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(_)
        ));
        p.0.borrow_mut().get_mut(&B).unwrap().description = "Corrigée".into();
        d.sync_cards(&[B], &p).unwrap();
        assert_eq!(
            d.resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(p.card(B).unwrap().unwrap().card)
        );
        d.name_card(B, &p, "Nommée sur la conteuse".into()).unwrap();
        assert_eq!(
            p.card(B).unwrap().unwrap().card.title,
            "Nommée sur la conteuse"
        );
        // Simulate a durable device rename awaiting catalogue publication.
        let path = f.root.join(DIRECTORY).join(format!("{B}.json"));
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        record["pending_name"] = serde_json::json!(true);
        record["card"]["title"] = serde_json::json!("Après redémarrage");
        fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        d.sync_cards(&[B], &p).unwrap();
        assert_eq!(p.card(B).unwrap().unwrap().card.title, "Après redémarrage");
        assert_eq!(d.resolve_card(C, Some(&p)).unwrap(), Resolution::Unknown);
        assert_eq!(contents(&f.root), before);
    }
    #[test]
    fn official_and_unknown_recognition_never_read_or_write_sidecars() {
        let f = Fixture::new();
        let p = Profile::default();
        let d = f.device();
        assert!(!d.write_card(A, Some(&p), card()).unwrap());
        assert!(!d.write_card::<Profile>(B, None, card()).unwrap());
        assert!(!f.root.join(DIRECTORY).exists());
        assert_eq!(
            d.resolve_card(A, Some(&p)).unwrap(),
            Resolution::Official {
                title: Some("Titre officiel".into())
            }
        );
        // A forged official sidecar must never participate in resolution/sync.
        fs::create_dir(f.root.join(DIRECTORY)).unwrap();
        fs::write(f.root.join(DIRECTORY).join(format!("{A}.json")), b"forged").unwrap();
        d.sync_cards(&[A], &p).unwrap();
        assert!(matches!(
            d.resolve_card(A, Some(&p)).unwrap(),
            Resolution::Official { .. }
        ));
        assert_eq!(
            d.resolve_card::<Profile>(B, None).unwrap(),
            Resolution::Unknown
        );
    }
    #[test]
    fn corrupted_oversized_wrong_uuid_and_future_records_are_ignored() {
        let f = Fixture::new();
        let p = Profile::default();
        let d = f.device();
        d.write_card(B, Some(&p), card()).unwrap();
        let path = f.root.join(DIRECTORY).join(format!("{B}.json"));
        let good = fs::read(&path).unwrap();
        for bad in [b"{".to_vec(), vec![0; 384 * 1024 + 1]] {
            fs::write(&path, bad).unwrap();
            assert_eq!(d.resolve_card(B, Some(&p)).unwrap(), Resolution::Unknown);
        }
        for (key, value) in [
            ("uuid", serde_json::json!(C)),
            ("version", serde_json::json!(2)),
        ] {
            let mut record: serde_json::Value = serde_json::from_slice(&good).unwrap();
            record[key] = value;
            fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            assert_eq!(d.resolve_card(B, Some(&p)).unwrap(), Resolution::Unknown);
        }
        p.0.borrow_mut().insert(B, card());
        assert!(matches!(
            d.resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(_)
        ));
    }
    struct PendingProfile(Profile);
    impl OfficialCatalogue for PendingProfile {
        type Error = ();
        fn contains_official(&self, id: &str) -> std::result::Result<bool, ()> {
            self.0.contains_official(id)
        }
    }
    impl CardCatalogue for PendingProfile {
        fn official_title(&self, id: Uuid) -> Result<Option<String>> {
            self.0.official_title(id)
        }
        fn card(&self, id: Uuid) -> Result<Option<CatalogueCard>> {
            Ok(self.0.card(id)?.map(|mut c| {
                c.cover_pending = true;
                c.card.cover_png = None;
                c
            }))
        }
        fn save_name(&self, id: Uuid, title: &str) -> Result<()> {
            self.0.save_name(id, title)
        }
    }
    fn sidecar_inventory(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
        fs::read_dir(root.join(DIRECTORY))
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                (
                    p.clone(),
                    (
                        fs::read(&p).unwrap(),
                        fs::metadata(&p).unwrap().modified().unwrap(),
                    ),
                )
            })
            .collect()
    }
    #[test]
    fn repeated_sync_and_pending_cover_leave_inventory_and_dates_unchanged() {
        let f = Fixture::new();
        let p = Profile::default();
        p.0.borrow_mut().insert(B, card());
        let d = f.device();
        assert!(d.sync_cards(&[B], &p).unwrap().failures.is_empty());
        let before = sidecar_inventory(&f.root);
        for _ in 0..2 {
            assert!(d.sync_cards(&[B], &p).unwrap().failures.is_empty());
        }
        let pending = PendingProfile(p);
        for _ in 0..2 {
            assert!(d.sync_cards(&[B], &pending).unwrap().failures.is_empty());
        }
        assert_eq!(sidecar_inventory(&f.root), before);
        // Explicit absence does clear the cover.
        pending.0 .0.borrow_mut().get_mut(&B).unwrap().cover_png = None;
        d.sync_cards(&[B], &pending.0).unwrap();
        assert!(matches!(
            d.resolve_card(B, Some(&pending.0)).unwrap(),
            Resolution::Known(Card {
                cover_png: None,
                ..
            })
        ));
    }
    #[test]
    fn invalid_middle_card_reports_failure_and_syncs_next_story() {
        let f = Fixture::new();
        let p = Profile::default();
        let last = Uuid::new_v4();
        let mut invalid = card();
        invalid.title.clear();
        for (id, value) in [(B, card()), (C, invalid), (last, card())] {
            p.0.borrow_mut().insert(id, value);
        }
        let report = f.device().sync_cards(&[B, C, last], &p).unwrap();
        assert_eq!(
            report.resolutions,
            vec![
                Resolution::Known(card()),
                Resolution::Unknown,
                Resolution::Known(card())
            ]
        );
        assert!(report
            .failures
            .iter()
            .all(|e| e.uuid == C && e.error == Error::InvalidCard));
        assert!(report
            .failures
            .iter()
            .any(|e| e.stage == SyncStage::Publish));
        assert!(f.root.join(DIRECTORY).join(format!("{last}.json")).exists());
    }
    #[test]
    fn oversized_v1_is_repaired_but_future_prefix_is_preserved() {
        let f = Fixture::new();
        let p = Profile::default();
        p.0.borrow_mut().insert(B, card());
        fs::create_dir_all(f.root.join(DIRECTORY)).unwrap();
        let path = f.root.join(DIRECTORY).join(format!("{B}.json"));
        for version in [1, 2] {
            let mut bytes = format!("{{\"version\":{version},\"broken\":\"").into_bytes();
            bytes.resize(300 * 1024, b'x');
            fs::write(&path, &bytes).unwrap();
            let report = f.device().sync_cards(&[B], &p).unwrap();
            assert_eq!(report.resolutions, vec![Resolution::Known(card())]);
            if version == 1 {
                assert!(fs::metadata(&path).unwrap().len() < bytes.len() as u64);
            } else {
                assert_eq!(fs::read(&path).unwrap(), bytes);
            }
        }
    }
    #[test]
    fn invalid_or_unavailable_catalogue_card_resolves_unknown() {
        struct Unavailable;
        impl OfficialCatalogue for Unavailable {
            type Error = Error;
            fn contains_official(&self, _: &str) -> Result<bool> {
                Ok(false)
            }
        }
        impl CardCatalogue for Unavailable {
            fn official_title(&self, _: Uuid) -> Result<Option<String>> {
                Ok(None)
            }
            fn card(&self, _: Uuid) -> Result<Option<CatalogueCard>> {
                Err(Error::Io)
            }
            fn save_name(&self, _: Uuid, _: &str) -> Result<()> {
                Ok(())
            }
        }
        let f = Fixture::new();
        assert_eq!(
            f.device().resolve_card(B, Some(&Unavailable)).unwrap(),
            Resolution::Unknown
        );
        let p = Profile::default();
        let mut invalid = card();
        invalid.title.clear();
        p.0.borrow_mut().insert(B, invalid);
        assert_eq!(
            f.device().resolve_card(B, Some(&p)).unwrap(),
            Resolution::Unknown
        );
    }
    #[test]
    fn catalogue_fallback_survives_read_only_device() {
        let f = Fixture::new();
        let p = Profile::default();
        p.0.borrow_mut().insert(B, card());
        // Driver read-only mode on an unsupported metadata version, independent of OS privileges.
        let path = f.root.join(".md");
        let mut md = fs::read(&path).unwrap();
        md[..2].copy_from_slice(&8u16.to_le_bytes());
        fs::write(path, md).unwrap();
        assert_eq!(
            f.device().write_card(B, Some(&p), card()),
            Err(Error::UnknownFormat)
        );
        assert_eq!(
            f.device().resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(card())
        );
        assert!(!f.root.join(DIRECTORY).exists());
    }
    #[test]
    fn future_shape_is_preserved_by_all_writers_and_base64_is_used() {
        let f = Fixture::new();
        let p = Profile::default();
        let d = f.device();
        d.write_card(B, Some(&p), card()).unwrap();
        let path = f.root.join(DIRECTORY).join(format!("{B}.json"));
        let v: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(v["card"]["cover_png"].is_string());
        p.0.borrow_mut().insert(B, card());
        let future = br#"{"version":256,"new_shape":{"opaque":true}}"#;
        fs::write(&path, future).unwrap();
        let before = sidecar_inventory(&f.root);
        assert_eq!(
            d.resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(card())
        );
        assert!(d.sync_cards(&[B], &p).unwrap().failures.is_empty());
        assert_eq!(d.write_card(B, Some(&p), card()), Err(Error::FutureCard));
        assert_eq!(d.name_card(B, &p, "Name".into()), Err(Error::FutureCard));
        assert_eq!(sidecar_inventory(&f.root), before);
        assert_eq!(
            d.name_card(A, &p, "Official".into()),
            Err(Error::OfficialStory)
        );
    }
    #[test]
    fn card_directory_sync_failure_does_not_fail_publication() {
        let f = Fixture::new();
        let p = Profile::default();
        let mut d = f.device();
        d.fail_publish_sync = true;
        assert_eq!(d.write_card(B, Some(&p), card()), Ok(true));
        assert_eq!(
            d.resolve_card(B, Some(&p)).unwrap(),
            Resolution::Known(card())
        );
    }
    #[cfg(unix)]
    #[test]
    fn sidecar_links_cannot_escape_device() {
        let f = Fixture::new();
        let p = Profile::default();
        let outside = f.base.join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, f.root.join(DIRECTORY)).unwrap();
        assert_eq!(
            f.device().write_card(B, Some(&p), card()),
            Err(Error::UnsafePath)
        );
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }
}

#[test]
fn sound_minus_one_is_complete_without_sound_files() {
    let f = Fixture::new();
    let path = f.root.join(".content").join(folder(B));
    let mut ni = fs::read(path.join("ni")).unwrap();
    ni[516..520].copy_from_slice(&(-1i32).to_le_bytes());
    fs::write(path.join("ni"), ni).unwrap();
    fs::remove_dir_all(path.join("sf")).unwrap();
    fs::write(path.join("si"), []).unwrap();
    assert!(read::complete(&path, 6));
}

#[test]
fn restored_story_reports_non_durable_playlist() {
    let f = Fixture::new();
    f.story(C);
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(
        d.apply(Action::Restore {
            folder: folder(C),
            known_uuid: Some(C)
        }),
        Ok(Outcome::RestoredNotDurable)
    );
    assert!(f.root.join(".content").join(folder(C)).is_dir());
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B, C]);
}

/// Full fake-volume inventory, including directories, contents and timestamps.
fn repair_inventory(
    root: &Path,
) -> std::collections::BTreeMap<PathBuf, (Option<Vec<u8>>, std::time::SystemTime)> {
    fn visit(
        root: &Path,
        dir: &Path,
        out: &mut std::collections::BTreeMap<PathBuf, (Option<Vec<u8>>, std::time::SystemTime)>,
    ) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            let bytes = if metadata.is_dir() {
                None
            } else {
                Some(fs::read(&path).unwrap())
            };
            out.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                (bytes, metadata.modified().unwrap()),
            );
            if metadata.is_dir() {
                visit(root, &path, out);
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    visit(root, root, &mut out);
    out
}

#[test]
fn repair_600_bytes_keeps_37_records_and_only_changes_playlist() {
    let f = Fixture::new();
    let ids: Vec<_> = (100..138).map(Uuid::from_u128).collect();
    for id in &ids {
        f.story(*id);
    }
    let bytes: Vec<_> = ids.iter().flat_map(|id| *id.as_bytes()).take(600).collect();
    fs::write(f.root.join(".pi"), &bytes).unwrap();
    let before = repair_inventory(&f.root);
    let inv = f.inventory();
    assert_eq!(inv.playlist_state, PlaylistState::Damaged);
    assert_eq!(inv.recovery, None);
    // All folders remain inspectable even though no valid .pi can be decoded.
    assert_eq!(inv.stories.len(), 40);
    assert!(inv.stories.iter().all(|s| !s.listed && s.complete));
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 37,
            empty: false,
            truncated: true,
            removed: vec![],
        })
    );
    assert_eq!(read::playlist(&f.root).unwrap(), ids[..37]);
    let mut after = repair_inventory(&f.root);
    let mut before_without_pi = before.clone();
    before_without_pi.remove(Path::new(".pi"));
    after.remove(Path::new(".pi"));
    assert_eq!(after, before_without_pi);
    let copies = f.backups();
    assert_eq!(copies.len(), 1);
    assert_eq!(fs::read(copies[0].join(".pi")).unwrap(), bytes);
    assert_eq!(
        fs::read(copies[0].join(".md")).unwrap(),
        fs::read(f.root.join(".md")).unwrap()
    );
    assert_eq!(fs::read(copies[0].join(".pi.hidden")).unwrap(), b"");
    assert_eq!(f.inventory().playlist_state, PlaylistState::Readable);
    let orphan = f
        .inventory()
        .stories
        .into_iter()
        .find(|s| s.folder == folder(ids[37]))
        .unwrap();
    assert!(!orphan.listed && orphan.complete);
    f.device()
        .apply(Action::Restore {
            folder: orphan.folder,
            known_uuid: Some(ids[37]),
        })
        .unwrap();
    assert_eq!(read::playlist(&f.root).unwrap(), ids);
}

#[test]
fn repair_reports_missing_duplicate_and_nil_in_original_order() {
    let f = Fixture::new();
    f.list(&[B, C, B, Uuid::nil(), A, C]);
    assert_eq!(f.inventory().playlist_state, PlaylistState::Damaged);
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 2,
            empty: false,
            truncated: false,
            removed: vec![C, B, Uuid::nil(), C],
        })
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    f.untouched();
}

#[test]
fn missing_folder_alone_is_damaged_and_ordinary_actions_are_refused() {
    let f = Fixture::new();
    f.list(&[A, C, B]);
    assert_eq!(f.inventory().playlist_error, None);
    assert_eq!(f.inventory().playlist_state, PlaylistState::Damaged);
    for action in [
        Action::Remove(C),
        Action::Reorder(vec![B, C, A]),
        Action::Restore {
            folder: folder(C),
            known_uuid: Some(C),
        },
    ] {
        assert_eq!(f.device().apply(action), Err(Error::PlaylistDamaged));
    }
    assert!(f.backups().is_empty());
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 2,
            empty: false,
            truncated: false,
            removed: vec![C]
        })
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
}

#[test]
fn repair_collision_refused_even_for_absent_folders() {
    for first in [A, C] {
        let f = Fixture::new();
        let collision = Uuid::from_u128(first.as_u128() | (1 << 96));
        f.list(&[first, collision, first]);
        let before = repair_inventory(&f.root);
        assert_eq!(f.inventory().playlist_state, PlaylistState::Damaged);
        assert_eq!(
            f.device().apply(Action::RepairPlaylist),
            Err(Error::SuffixCollision)
        );
        assert_eq!(repair_inventory(&f.root), before);
        assert!(f.backups().is_empty());
    }
}

#[test]
fn healthy_playlist_repair_is_refused_without_backup_or_write() {
    let f = Fixture::new();
    for ids in [vec![A, B], vec![]] {
        f.list(&ids);
        let before = repair_inventory(&f.root);
        assert_eq!(f.inventory().playlist_state, PlaylistState::Readable);
        assert_eq!(
            f.device().apply(Action::RepairPlaylist),
            Err(Error::NoRepairRequired)
        );
        assert_eq!(repair_inventory(&f.root), before);
        assert!(f.backups().is_empty());
    }
}

#[test]
fn repair_backup_failure_writes_nothing_to_device() {
    let f = Fixture::new();
    f.list(&[A, A, C]);
    fs::write(f.data.join("storyteller-backups"), b"blocked").unwrap();
    let before = repair_inventory(&f.root);
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Err(Error::BackupFailed)
    );
    assert_eq!(repair_inventory(&f.root), before);
}

#[test]
fn repair_sync_failure_returns_typed_non_durable_result() {
    let f = Fixture::new();
    f.list(&[B, Uuid::nil(), A]);
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(
        d.apply(Action::RepairPlaylist),
        Ok(Outcome::RepairedNotDurable {
            kept: 2,
            empty: false,
            truncated: false,
            removed: vec![Uuid::nil()]
        })
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B, A]);
    assert!(f.root.join(".content").join(folder(A)).is_dir());
    f.untouched();
}

#[test]
fn repair_never_uses_backup_and_defers_to_existing_recovery() {
    let f = Fixture::new();
    f.device().apply(Action::Reorder(vec![B, A])).unwrap();
    // An intact D15 copy must not supply missing or truncated records to repair.
    f.list(&[B]);
    let mut bytes = B.as_bytes().to_vec();
    bytes.extend_from_slice(&A.as_bytes()[..8]);
    fs::write(f.root.join(".pi"), bytes).unwrap();
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 1,
            empty: false,
            truncated: true,
            removed: vec![]
        })
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![B]);
    f.list(&[Uuid::nil()]);
    fs::write(
        f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4())),
        A.as_bytes(),
    )
    .unwrap();
    assert_eq!(
        f.inventory().playlist_state,
        PlaylistState::RecoveryRequired
    );
    let before = repair_inventory(&f.root);
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Err(Error::RecoveryRequired)
    );
    assert_eq!(repair_inventory(&f.root), before);
}

#[test]
fn two_serials_restore_only_their_own_d15_without_fallback() {
    for remove_parent in [false, true] {
        let a = Fixture::new();
        let b = Fixture::new();
        let mut md = fs::read(b.root.join(".md")).unwrap();
        md[26..40].copy_from_slice(b"00000000000043");
        fs::write(b.root.join(".md"), md).unwrap();
        b.story(C);
        b.list(&[B, C]);
        a.device().apply(Action::Reorder(vec![B, A])).unwrap();
        let db = Device::open(&b.root, &a.data).unwrap();
        db.apply(Action::Reorder(vec![C, B])).unwrap();
        for f in [&a, &b] {
            fs::write(f.root.join(".pi"), [0; 17]).unwrap();
            fs::write(
                f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4())),
                [0],
            )
            .unwrap();
        }
        // Both series have D15 copies in the exact same app_data.
        a.device().apply(Action::RestorePlaylist).unwrap();
        db.apply(Action::RestorePlaylist).unwrap();
        assert_eq!(read::playlist(&a.root).unwrap(), vec![A, B]);
        assert_eq!(read::playlist(&b.root).unwrap(), vec![B, C]);
        let parent = a.data.join("storyteller-backups/00000000000043");
        for entry in fs::read_dir(&parent).unwrap() {
            fs::remove_dir_all(entry.unwrap().path()).unwrap();
        }
        if remove_parent {
            fs::remove_dir(&parent).unwrap();
        }
        fs::write(b.root.join(".pi"), [0; 17]).unwrap();
        fs::write(
            b.root.join(format!(".story-studio-pi-{}", Uuid::new_v4())),
            [0],
        )
        .unwrap();
        let before_a = repair_inventory(&a.root);
        let before_b = repair_inventory(&b.root);
        assert_eq!(db.apply(Action::RestorePlaylist), Err(Error::BackupFailed));
        assert_eq!(repair_inventory(&a.root), before_a);
        assert_eq!(repair_inventory(&b.root), before_b);
    }
}

#[test]
fn repair_errors_have_registered_user_messages() {
    use crate::support::user_message::{codes, UserMessage};
    for error in [
        Error::PlaylistDamaged,
        Error::ContentUnavailable,
        Error::PlaylistTooLarge,
        Error::NoRepairRequired,
        Error::SuffixCollision,
        Error::BackupFailed,
        Error::RecoveryRequired,
    ] {
        let message = UserMessage::from(error);
        assert!(codes::REGISTRY
            .iter()
            .any(|(code, _, _)| *code == message.code));
        assert!(message.params.is_empty());
        assert!(message.detail.is_none());
    }
}

#[test]
fn repair_interrupted_d15_copy_writes_nothing_to_device() {
    let f = Fixture::new();
    f.list(&[A, A]);
    let before = repair_inventory(&f.root);
    let mut d = f.device();
    // Initial checkpoint succeeds, then the .md copy fails inside D15.
    d.fail_at = Some(1);
    assert_eq!(d.apply(Action::RepairPlaylist), Err(Error::BackupFailed));
    assert_eq!(repair_inventory(&f.root), before);
    assert!(f.backups().is_empty());
}

#[test]
fn repair_can_publish_an_empty_list_without_removing_folders() {
    let f = Fixture::new();
    fs::write(f.root.join(".pi"), [0; 17]).unwrap();
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 0,
            empty: true,
            truncated: true,
            removed: vec![Uuid::nil()]
        })
    );
    assert!(fs::read(f.root.join(".pi")).unwrap().is_empty());
    assert_eq!(f.inventory().playlist_state, PlaylistState::Readable);
    assert!(f
        .inventory()
        .stories
        .iter()
        .all(|s| !s.listed && s.complete));
}

#[test]
fn identical_residue_does_not_block_repair_of_missing_folder() {
    let f = Fixture::new();
    f.list(&[A, C, B]);
    let residue = f.root.join(format!(".story-studio-pi-{}", Uuid::new_v4()));
    let bytes = fs::read(f.root.join(".pi")).unwrap();
    fs::write(&residue, &bytes).unwrap();
    let inv = f.inventory();
    assert_eq!(
        inv.recovery,
        Some(RecoveryState::ResidueDiskCheckRecommended)
    );
    assert_eq!(inv.playlist_state, PlaylistState::Damaged);
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Ok(Outcome::Repaired {
            kept: 2,
            removed: vec![C],
            empty: false,
            truncated: false,
        })
    );
    assert_eq!(read::playlist(&f.root).unwrap(), vec![A, B]);
    assert_eq!(fs::read(residue).unwrap(), bytes);
    assert_eq!(fs::read(f.backups()[0].join(".pi")).unwrap(), bytes);
}

#[test]
fn repair_refuses_unavailable_content_without_backup_or_write() {
    for as_file in [false, true] {
        let f = Fixture::new();
        f.list(&[A, C]);
        fs::remove_dir_all(f.root.join(".content")).unwrap();
        if as_file {
            fs::write(f.root.join(".content"), b"unavailable").unwrap();
        }
        let before = repair_inventory(&f.root);
        assert_eq!(
            f.device().apply(Action::RepairPlaylist),
            Err(Error::ContentUnavailable)
        );
        assert_eq!(repair_inventory(&f.root), before);
        assert!(f.backups().is_empty());
    }
}

#[cfg(unix)]
#[test]
fn repair_refuses_unreadable_content_without_emptying_playlist() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.list(&[A, C]);
    let content = f.root.join(".content");
    let before = repair_inventory(&f.root);
    let permissions = fs::metadata(&content).unwrap().permissions();
    fs::set_permissions(&content, fs::Permissions::from_mode(0o0)).unwrap();
    let result = f.device().apply(Action::RepairPlaylist);
    fs::set_permissions(&content, permissions).unwrap();
    assert_eq!(result, Err(Error::ContentUnavailable));
    assert_eq!(repair_inventory(&f.root), before);
    assert!(f.backups().is_empty());
}

#[test]
fn oversized_playlist_is_unavailable_and_repair_has_a_dedicated_error() {
    let f = Fixture::new();
    fs::OpenOptions::new()
        .write(true)
        .open(f.root.join(".pi"))
        .unwrap()
        .set_len(16 * 100_000 + 1)
        .unwrap();
    let before = repair_inventory(&f.root);
    let inv = f.inventory();
    assert_eq!(inv.playlist_state, PlaylistState::Unavailable);
    assert_eq!(inv.playlist_error, Some(Error::PlaylistTooLarge));
    assert_eq!(
        f.device().apply(Action::RepairPlaylist),
        Err(Error::PlaylistTooLarge)
    );
    assert_eq!(repair_inventory(&f.root), before);
    assert!(f.backups().is_empty());
}

#[test]
fn non_durable_repair_reports_empty_and_truncated() {
    let f = Fixture::new();
    fs::write(f.root.join(".pi"), [0; 600]).unwrap();
    let mut d = f.device();
    d.fail_publish_sync = true;
    assert_eq!(
        d.apply(Action::RepairPlaylist),
        Ok(Outcome::RepairedNotDurable {
            kept: 0,
            removed: vec![Uuid::nil(); 37],
            empty: true,
            truncated: true,
        })
    );
    assert!(fs::read(f.root.join(".pi")).unwrap().is_empty());
    assert_eq!(fs::read(f.backups()[0].join(".pi")).unwrap().len(), 600);
}

#[path = "l9_tests.rs"]
mod l9;

#[test]
fn factory_zero_is_complete_and_does_not_decide_provenance() {
    let f = Fixture::new();
    for id in [A, B] {
        let path = f.root.join(".content").join(folder(id)).join("ni");
        let mut ni = fs::read(&path).unwrap();
        ni[24] = 0;
        fs::write(path, ni).unwrap();
    }
    let inventory = f.inventory();
    assert!(inventory.stories.iter().all(|s| s.complete));
    assert_eq!(inventory.stories[0].official, OfficialProvenance::Official);
    assert_eq!(
        inventory.stories[1].official,
        OfficialProvenance::NotOfficial
    );
}

#[path = "orphan_tests.rs"]
mod orphan_tests;
