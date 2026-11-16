use crate::support::user_message;
use crate::support::user_message::codes;
use unicode_normalization::UnicodeNormalization;

pub(crate) const PROJECT_CATEGORIES: [&str; 5] = [
    "voix-generees",
    "images-generees",
    "fichiers-importes",
    "enregistrements",
    "zips-extraits",
];

pub(crate) fn sanitize_project_folder(value: &str) -> String {
    let replaced: String = value
        .nfc()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut name: String = replaced
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .chars()
        .take(60)
        .collect();
    name = name.trim_end_matches(['.', ' ']).to_string();
    if name.trim().is_empty() {
        return "Projet sans titre".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        // Alter the reserved stem before its extension so validation is
        // idempotent (CON.txt -> CON_.txt) and Windows accepts the component.
        let stem_end = name.find('.').unwrap_or(name.len());
        name.insert(stem_end, '_');
        name = name.chars().take(60).collect();
        name = name.trim_end_matches(['.', ' ']).to_string();
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sidecar_paths_follow_windows_keys_without_folding_posix_paths() {
        assert_eq!(
            relocated_path(
                r"\\?\c:\WS\Projet sans titre\Source.WAV",
                "C:/ws/Projet sans titre",
                "C:/ws/Azuro"
            ),
            Some("C:/ws/Azuro/Source.WAV".into())
        );
        assert_eq!(
            relocated_path(
                r"\\?\UNC\Server\Share\old\a.png",
                "//server/share/old",
                "//server/share/new"
            ),
            Some("//server/share/new/a.png".into())
        );
        assert_eq!(relocated_path("/WS/old/a.png", "/ws/old", "/ws/new"), None);
        assert_eq!(
            relocated_path("/ws/old-other/a.png", "/ws/old", "/ws/new"),
            None
        );
    }
    #[test]
    fn shared_name_fixtures() {
        let fixtures: Vec<(String, String)> = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/projectFolders.json"
        ))
        .unwrap();
        for (input, expected) in fixtures {
            assert_eq!(sanitize_project_folder(&input), expected, "{input}");
            assert_eq!(
                sanitize_project_folder(&expected),
                expected,
                "idempotence: {input}"
            );
            assert!(expected.chars().count() <= 60);
        }
        assert_eq!(PROJECT_CATEGORIES.len(), 5);
    }
}

#[cfg(test)]
mod disk_tests {
    use super::*;
    use std::fs;
    struct Workspace(std::path::PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("story-project-folders-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            let path: std::path::PathBuf =
                crate::support::paths::path_for_frontend(path.canonicalize().unwrap()).into();
            Self(path)
        }
        fn root(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    const OWNER: &str = "00000000-0000-4000-8000-000000000001";
    // Existing tests exercise transactions with all five categories populated.
    // Build that fixture explicitly now that name resolution creates no media folders.
    fn populate_all_categories(root: &str, folder: &str, work_id: &str) -> Result<String, String> {
        let name =
            resolve_project_media_folder(root, folder, work_id, PROJECT_CATEGORIES[0], true)?;
        for category in PROJECT_CATEGORIES {
            resolve_project_media_folder(root, folder, work_id, category, true)?;
        }
        Ok(name)
    }
    #[test]
    fn media_categories_are_created_only_when_used_at_the_shared_rank() {
        let ws = Workspace::new();
        fs::create_dir_all(ws.0.join("zips-extraits/Azuro")).unwrap();
        let folder = super::resolve_project_folder(ws.root(), "Azuro", OWNER, true).unwrap();
        assert_eq!(folder, "Azuro (2)");
        assert_eq!(
            resolve_project_media_folder(ws.root(), "Azuro", OWNER, "images-generees", false)
                .unwrap(),
            folder
        );
        assert_eq!(fs::read_dir(&ws.0).unwrap().count(), 1);
        let destination = ProjectMediaDestination {
            folder: "Azuro".into(),
            work_id: OWNER.into(),
        };
        for category in ["images-generees", "voix-generees"] {
            let path = project_media_dir(ws.root(), category, Some(&destination)).unwrap();
            assert_eq!(
                path,
                fs::canonicalize(ws.0.join(category).join(&folder)).unwrap()
            );
            assert!(owns_folder(&path, path.parent().unwrap(), OWNER));
            assert_eq!(
                project_media_dir(ws.root(), category, Some(&destination)).unwrap(),
                path
            );
            assert!(!ws.0.join("enregistrements").exists());
            assert!(!ws.0.join("fichiers-importes").exists());
            if category == "images-generees" {
                assert!(!ws.0.join("voix-generees").exists());
            }
        }
        assert!(!ws.0.join("zips-extraits").join(folder).exists());
    }
    #[test]
    fn interleaved_category_collision_preserves_media_and_renames_only_owned_folders() {
        let ws = Workspace::new();
        let destination = ProjectMediaDestination {
            folder: "Azuro".into(),
            work_id: OWNER.into(),
        };
        let image = project_media_dir(ws.root(), "images-generees", Some(&destination)).unwrap();
        fs::write(image.join("a.png"), b"image").unwrap();
        let foreign = ws.0.join("voix-generees/Azuro");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(
            foreign.join(MARKER),
            serde_json::json!({"version":1,"workId":"00000000-0000-4000-8000-000000000002"})
                .to_string(),
        )
        .unwrap();
        fs::write(foreign.join("foreign.mp3"), b"foreign").unwrap();
        let audio = project_media_dir(ws.root(), "voix-generees", Some(&destination)).unwrap();
        assert!(audio.ends_with("voix-generees/Azuro (2)"));
        fs::write(audio.join("a.mp3"), b"audio").unwrap();
        let edits = image.join(".story-studio-image-edits");
        fs::create_dir(&edits).unwrap();
        let metadata = serde_json::json!({"sourcePath": path_for_frontend(audio.join("a.mp3")).replace('\\', "/"), "originalPath": path_for_frontend(image.join("a.png")).replace('\\', "/")});
        fs::write(
            edits.join("a.png.edit.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert_eq!(
            project_media_dir(ws.root(), "images-generees", Some(&destination)).unwrap(),
            image
        );
        assert_eq!(
            project_media_dir(ws.root(), "voix-generees", Some(&destination)).unwrap(),
            audio
        );
        assert_eq!(
            resolve_project_media_folder(ws.root(), "Azuro", OWNER, "images-generees", false)
                .unwrap(),
            "Azuro"
        );
        assert_eq!(
            resolve_project_media_folder(ws.root(), "Azuro", OWNER, "voix-generees", false)
                .unwrap(),
            "Azuro (2)"
        );
        let old = "Azuro".to_string();
        let moves = rename_project_folder(ws.root(), &old, "Nouveau", OWNER).unwrap();
        assert_eq!(moves.len(), 2);
        assert_eq!(
            fs::read(ws.0.join("images-generees/Nouveau/a.png")).unwrap(),
            b"image"
        );
        assert_eq!(
            fs::read(ws.0.join("voix-generees/Nouveau/a.mp3")).unwrap(),
            b"audio"
        );
        assert_eq!(fs::read(foreign.join("foreign.mp3")).unwrap(), b"foreign");
        assert!(!ws.0.join("enregistrements").exists());
        let original_folders = moves
            .iter()
            .map(|mapping| {
                let from = Path::new(&mapping.from);
                (
                    from.parent()
                        .unwrap()
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_string(),
                    from.file_name().unwrap().to_str().unwrap().to_string(),
                )
            })
            .collect();
        restore_project_folder(ws.root(), "Nouveau", &old, OWNER, &original_folders).unwrap();
        assert_eq!(fs::read(image.join("a.png")).unwrap(), b"image");
        assert_eq!(fs::read(audio.join("a.mp3")).unwrap(), b"audio");
        let restored: Value =
            serde_json::from_slice(&fs::read(edits.join("a.png.edit.json")).unwrap()).unwrap();
        assert_eq!(restored, metadata);
    }
    #[test]
    fn rename_leaves_other_bases_with_the_same_owner_untouched() {
        let ws = Workspace::new();
        let destination = |folder: &str| ProjectMediaDestination {
            folder: folder.into(),
            work_id: OWNER.into(),
        };
        let first =
            project_media_dir(ws.root(), "images-generees", Some(&destination("Base"))).unwrap();
        let other =
            project_media_dir(ws.root(), "images-generees", Some(&destination("Autre"))).unwrap();
        fs::write(first.join("first.png"), b"first").unwrap();
        fs::write(other.join("other.png"), b"other").unwrap();
        let moves = rename_project_folder(ws.root(), "Base", "Nouveau", OWNER).unwrap();
        assert_eq!(moves.len(), 1);
        assert!(!first.exists());
        assert_eq!(
            fs::read(ws.0.join("images-generees/Nouveau/first.png")).unwrap(),
            b"first"
        );
        assert_eq!(fs::read(other.join("other.png")).unwrap(), b"other");
    }
    #[test]
    fn rename_accepts_absent_categories_and_a_project_without_media() {
        let ws = Workspace::new();
        assert!(rename_project_folder(ws.root(), "Ancien", "Nouveau", OWNER)
            .unwrap()
            .is_empty());
        let destination = ProjectMediaDestination {
            folder: "Ancien".into(),
            work_id: OWNER.into(),
        };
        project_media_dir(ws.root(), "images-generees", Some(&destination)).unwrap();
        let moves = rename_project_folder(ws.root(), "Ancien", "Nouveau", OWNER).unwrap();
        assert_eq!(moves.len(), 1);
        assert!(ws.0.join("images-generees/Nouveau").join(MARKER).is_file());
        assert_eq!(fs::read_dir(&ws.0).unwrap().count(), 1);
    }
    #[test]
    fn reserved_names_with_extensions_support_media_and_provisional_rename() {
        for name in [
            "CON.txt".to_string(),
            "NUL.mp3".into(),
            "COM1.foo".into(),
            "LPT9.bar".into(),
            format!("CON.{}", "😀".repeat(60)),
        ] {
            let ws = Workspace::new();
            let old = populate_all_categories(ws.root(), "Projet sans titre", OWNER).unwrap();
            let target = resolve_project_folder(ws.root(), &name, OWNER, false).unwrap();
            assert_eq!(sanitize_project_folder(&target), target);
            rename_project_folder(ws.root(), &old, &target, OWNER).unwrap();
            let resolved = populate_all_categories(ws.root(), &name, OWNER).unwrap();
            assert_eq!(resolved, target);
            let destination = ProjectMediaDestination {
                folder: resolved,
                work_id: OWNER.into(),
            };
            for category in PROJECT_CATEGORIES {
                let directory = project_media_dir(ws.root(), category, Some(&destination)).unwrap();
                assert!(directory.is_dir());
                assert_eq!(directory.file_name().unwrap().to_str().unwrap(), target);
            }
        }
    }
    #[test]
    fn foreign_manual_and_unicode_case_collisions_are_never_adopted() {
        let ws = Workspace::new();
        fs::create_dir_all(ws.0.join("images-generees/azuro")).unwrap();
        assert_eq!(
            populate_all_categories(ws.root(), "Azuro", OWNER).unwrap(),
            "Azuro (2)"
        );
        assert_eq!(
            populate_all_categories(ws.root(), "Azuro", OWNER).unwrap(),
            "Azuro (2)"
        );
        let other = "00000000-0000-4000-8000-000000000002";
        assert_eq!(
            populate_all_categories(ws.root(), "Azuro", other).unwrap(),
            "Azuro (3)"
        );
        fs::create_dir_all(ws.0.join("zips-extraits/ÉTÉ")).unwrap();
        assert_eq!(
            resolve_project_folder(ws.root(), "Été", OWNER, false).unwrap(),
            "Été (2)"
        );
        assert!(!ws.0.join("voix-generees/Été (2)").exists());
        // Unmarked POSIX case twins only occupy their rank.
        fs::create_dir_all(ws.0.join("voix-generees/Twin")).unwrap();
        fs::create_dir_all(ws.0.join("voix-generees/twin")).unwrap();
        assert_eq!(
            resolve_project_folder(ws.root(), "Twin", OWNER, false).unwrap(),
            "Twin (2)"
        );
    }
    #[test]
    fn shared_collision_fixtures_on_disk() {
        let fixtures: Vec<(String, String, String)> = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/projectFolderCollisions.json"
        ))
        .unwrap();
        for (folder, existing, expected) in fixtures {
            let ws = Workspace::new();
            fs::create_dir_all(ws.0.join("zips-extraits").join(&existing)).unwrap();
            assert_eq!(
                resolve_project_folder(ws.root(), &folder, OWNER, false).unwrap(),
                expected,
                "{folder} / {existing}"
            );
        }
    }
    #[test]
    fn owned_suffixed_folder_wins_over_a_freed_first_rank() {
        let ws = Workspace::new();
        let foreign = ws.0.join("enregistrements/Projet sans titre");
        fs::create_dir_all(&foreign).unwrap();
        let old = populate_all_categories(ws.root(), "Projet sans titre", OWNER).unwrap();
        assert_eq!(old, "Projet sans titre (2)");
        fs::remove_dir(&foreign).unwrap();
        // A category folder lost meanwhile is recreated in the owned rank.
        fs::remove_file(
            ws.0.join("images-generees/Projet sans titre (2)")
                .join(MARKER),
        )
        .unwrap();
        fs::remove_dir(ws.0.join("images-generees/Projet sans titre (2)")).unwrap();
        for create in [false, true] {
            assert_eq!(
                if create {
                    populate_all_categories(ws.root(), "Projet sans titre", OWNER)
                } else {
                    resolve_project_folder(ws.root(), "Projet sans titre", OWNER, false)
                }
                .unwrap(),
                old
            );
        }
        for category in PROJECT_CATEGORIES {
            assert!(!ws.0.join(category).join("Projet sans titre").exists());
            assert!(ws.0.join(category).join(&old).join(MARKER).is_file());
        }
        // First manual save: the provisional folder really owned is renamed.
        let from = resolve_project_folder(ws.root(), "Projet sans titre", OWNER, false).unwrap();
        let moves = rename_project_folder(ws.root(), &from, "Azuro", OWNER).unwrap();
        assert_eq!(moves.len(), 5);
        for category in PROJECT_CATEGORIES {
            assert!(!ws.0.join(category).join(&old).exists());
            assert!(ws.0.join(category).join("Azuro").join(MARKER).is_file());
        }
    }
    #[test]
    fn creation_collision_invisible_to_the_key_moves_to_the_next_rank() {
        // e.g. a case-insensitive volume folding "ſ" and "s": create_dir
        // fails although no listed entry matches the candidate.
        let ws = Workspace::new();
        let attempts = std::cell::Cell::new(0);
        let name = resolve_project_folder_impl(
            ws.root(),
            "Azuro",
            OWNER,
            true,
            Some("enregistrements"),
            |path| {
                attempts.set(attempts.get() + 1);
                if path.ends_with("enregistrements/Azuro") {
                    Err(std::io::ErrorKind::AlreadyExists.into())
                } else {
                    fs::create_dir(path)
                }
            },
        )
        .unwrap();
        assert_eq!(name, "Azuro (2)");
        assert!(attempts.get() <= 10, "{} creation attempts", attempts.get());
        for category in PROJECT_CATEGORIES {
            assert!(!ws.0.join(category).join("Azuro").exists());
            assert_eq!(
                ws.0.join(category).join(&name).join(MARKER).is_file(),
                category == "enregistrements"
            );
        }
    }
    #[test]
    fn rename_rewrites_sidecars_and_rolls_back_failures() {
        let ws = Workspace::new();
        populate_all_categories(ws.root(), "Projet sans titre", OWNER).unwrap();
        let old = ws.0.join("voix-generees/Projet sans titre");
        fs::write(old.join("sound.mp3"), "audio").unwrap();
        let edits = old.join(".story-studio-audio-edits");
        fs::create_dir(&edits).unwrap();
        let content =
            serde_json::json!({"original_path": old.join("sound.original.mp3"), "mode": "trim"})
                .to_string();
        fs::write(edits.join("sound.mp3.edit.json"), &content).unwrap();
        let result = rename_project_folder(ws.root(), "Projet sans titre", "Azuro", OWNER).unwrap();
        assert_eq!(result.len(), 5);
        let new = ws.0.join("voix-generees/Azuro");
        assert!(new.join("sound.mp3").is_file());
        let rewritten =
            fs::read_to_string(new.join(".story-studio-audio-edits/sound.mp3.edit.json")).unwrap();
        assert!(rewritten.contains("voix-generees/Azuro/sound.original.mp3"));
        rename_project_folder(ws.root(), "Azuro", "Projet sans titre", OWNER).unwrap();
        let restored: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(edits.join("sound.mp3.edit.json")).unwrap())
                .unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(&content).unwrap();
        expected["original_path"] = expected["original_path"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .into();
        assert_eq!(restored, expected);
        let fail = rename_project_folder_impl(
            ws.root(),
            "Projet sans titre",
            "Azuro",
            OWNER,
            None,
            |index| {
                if index == 2 {
                    Err("Injected rename failure".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(fail.is_err());
        for category in PROJECT_CATEGORIES {
            assert!(ws.0.join(category).join("Projet sans titre").is_dir());
            assert!(!ws.0.join(category).join("Azuro").exists());
        }
    }
    #[test]
    fn rename_refuses_foreign_markers_and_existing_destinations_even_owned() {
        let ws = Workspace::new();
        populate_all_categories(ws.root(), "Old", OWNER).unwrap();
        populate_all_categories(ws.root(), "New", OWNER).unwrap();
        assert!(rename_project_folder(ws.root(), "Old", "New", OWNER).is_err());
        // Un autre projet qui ne possède aucun dossier candidat n'a rien à
        // déplacer : succès sans déplacement, dossiers de « Old » intacts.
        let other = "00000000-0000-4000-8000-000000000002";
        assert!(rename_project_folder(ws.root(), "Old", "Absent", other)
            .unwrap()
            .is_empty());
        for category in PROJECT_CATEGORIES {
            assert!(ws.0.join(category).join("Old").is_dir());
            assert!(!ws.0.join(category).join("Absent").exists());
        }
    }
    #[test]
    fn rename_skips_categories_where_only_a_foreign_homonym_exists() {
        let ws = Workspace::new();
        let other = "00000000-0000-4000-8000-000000000002";
        populate_all_categories(ws.root(), "Projet sans titre", OWNER).unwrap();
        let name = resolve_project_media_folder(
            ws.root(),
            "Projet sans titre",
            other,
            "fichiers-importes",
            true,
        )
        .unwrap();
        assert_eq!(name, "Projet sans titre (2)");
        let moves = rename_project_folder(ws.root(), "Projet sans titre", "Hayate", other).unwrap();
        assert_eq!(moves.len(), 1);
        assert!(ws.0.join("fichiers-importes/Hayate").is_dir());
        assert!(!ws
            .0
            .join("fichiers-importes/Projet sans titre (2)")
            .exists());
        for category in PROJECT_CATEGORIES {
            assert!(ws.0.join(category).join("Projet sans titre").is_dir());
            if category != "fichiers-importes" {
                assert!(!ws.0.join(category).join("Hayate").exists());
            }
        }
    }
    #[test]
    fn rename_without_any_owned_folder_succeeds_without_moves() {
        let ws = Workspace::new();
        let other = "00000000-0000-4000-8000-000000000002";
        populate_all_categories(ws.root(), "Projet sans titre", OWNER).unwrap();
        assert!(
            rename_project_folder(ws.root(), "Projet sans titre", "Hayate", other)
                .unwrap()
                .is_empty()
        );
        for category in PROJECT_CATEGORIES {
            assert!(ws.0.join(category).join("Projet sans titre").is_dir());
        }
    }
    #[test]
    fn concurrent_owners_reserve_independent_folders() {
        let ws = Workspace::new();
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..12)
                .map(|_| {
                    scope.spawn(|| {
                        populate_all_categories(
                            ws.root(),
                            "Azuro",
                            &uuid::Uuid::new_v4().to_string(),
                        )
                        .unwrap()
                    })
                })
                .collect();
            let names: std::collections::HashSet<_> =
                handles.into_iter().map(|h| h.join().unwrap()).collect();
            assert_eq!(names.len(), 12);
        });
    }
    #[cfg(unix)]
    #[test]
    fn symlink_categories_folders_and_markers_are_refused() {
        let ws = Workspace::new();
        let outside = Workspace::new();
        std::os::unix::fs::symlink(&outside.0, ws.0.join("voix-generees")).unwrap();
        assert!(populate_all_categories(ws.root(), "Azuro", OWNER).is_err());
        fs::remove_file(ws.0.join("voix-generees")).unwrap();
        fs::create_dir(ws.0.join("voix-generees")).unwrap();
        std::os::unix::fs::symlink(&outside.0, ws.0.join("voix-generees/Azuro")).unwrap();
        assert_eq!(
            populate_all_categories(ws.root(), "Azuro", OWNER).unwrap(),
            "Azuro (2)"
        );
        let marker =
            ws.0.join("voix-generees/Azuro (2)/.story-studio-dossier.json");
        fs::remove_file(&marker).unwrap();
        fs::write(
            outside.0.join("marker"),
            serde_json::json!({"version":1,"workId":OWNER}).to_string(),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.0.join("marker"), &marker).unwrap();
        // Un marqueur lien symbolique ne prouve pas la propriété : ce dossier
        // n'est ni déplacé ni suivi, les autres catégories le sont normalement.
        let moves = rename_project_folder(ws.root(), "Azuro (2)", "New", OWNER).unwrap();
        assert_eq!(moves.len(), PROJECT_CATEGORIES.len() - 1);
        assert!(ws.0.join("voix-generees/Azuro (2)").is_dir());
        assert!(!ws.0.join("voix-generees/New").exists());
        assert!(outside.0.join("marker").is_file());
    }
}

use crate::support::paths::path_for_frontend;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MARKER: &str = ".story-studio-dossier.json";
// Serializes reservations and moves within the application. Exclusive mkdir
// handles other processes; an unmarked directory is never adopted.
static FOLDER_LOCK: Mutex<()> = Mutex::new(());

fn io_error(error: impl std::fmt::Display) -> String {
    {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::FILES_PROJECT_ORGANIZATION)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Rangement du projet : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    }
}
fn validate_owner(work_id: &str) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(work_id).map_err(io_error)?;
    if id.get_version_num() != 4 {
        return Err(
            user_message::UserMessage::new(codes::FILES_INVALID_WORK_IDENTITY)
                .with_detail("Identité de travail invalide.".to_string())
                .into_transport(),
        );
    }
    Ok(())
}
fn validate_component(name: &str) -> Result<(), String> {
    // Resolved names may include the bounded collision suffix beyond 60 chars.
    let base = name
        .rsplit_once(" (")
        .and_then(|(base, suffix)| {
            let rank = suffix.strip_suffix(')')?.parse::<u16>().ok()?;
            (2..=1000).contains(&rank).then_some(base)
        })
        .unwrap_or(name);
    if sanitize_project_folder(base) != base || name.is_empty() {
        return Err(
            user_message::UserMessage::new(codes::FILES_INVALID_PROJECT_FOLDER_NAME)
                .with_detail("Nom de dossier de projet invalide.".to_string())
                .into_transport(),
        );
    }
    Ok(())
}
pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    // Windows junctions are reparse points, even when reported as directories.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn direct_directory(path: &Path, parent: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err(
            user_message::UserMessage::new(codes::FILES_LINKED_IRREGULAR_PROJECT_FOLDER)
                .with_detail("Dossier de projet lié ou irrégulier.".to_string())
                .into_transport(),
        );
    }
    let canonical = fs::canonicalize(path).map_err(io_error)?;
    if canonical.parent() != Some(parent) {
        return Err(
            user_message::UserMessage::new(codes::FILES_PROJECT_FOLDER_OUTSIDE_CATEGORY)
                .with_detail("Dossier de projet hors de sa catégorie.".to_string())
                .into_transport(),
        );
    }
    Ok(canonical)
}
fn root_and_categories(root: &str, create: bool) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let root = super::absolute_path(root, codes::FILES_WORKSPACE_LOCATION_TRANSPORT)?;
    if create {
        fs::create_dir_all(&root).map_err(io_error)?;
    }
    let root = fs::canonicalize(root).map_err(io_error)?;
    let mut categories = Vec::new();
    for category in PROJECT_CATEGORIES {
        let dir = root.join(category);
        if fs::symlink_metadata(&dir).is_ok() {
            direct_directory(&dir, &root)?;
        }
        categories.push(dir);
    }
    Ok((root, categories))
}
// Mirrored in projectStorage.js: per-character lowercase (never contextual)
// with the final sigma folded, as case-insensitive filesystems may do.
fn collision_key(name: &str) -> String {
    name.nfc()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ς' { 'σ' } else { c })
        .collect()
}
fn existing_candidate(parent: &Path, name: &str) -> Result<Option<PathBuf>, String> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    };
    let key = collision_key(name);
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(io_error)?;
        if collision_key(&entry.file_name().to_string_lossy()) == key {
            if found.is_some() {
                return Err(user_message::UserMessage::new(
                    codes::FILES_PROJECT_FOLDER_NAME_COLLISION,
                )
                .with_detail("Plusieurs dossiers ont le même nom normalisé.".to_string())
                .into_transport());
            }
            found = Some(entry.path());
        }
    }
    Ok(found)
}
fn owns_folder(path: &Path, parent: &Path, work_id: &str) -> bool {
    if direct_directory(path, parent).is_err() {
        return false;
    }
    let marker = path.join(MARKER);
    let Ok(meta) = fs::symlink_metadata(&marker) else {
        return false;
    };
    if is_link(&meta) || !meta.is_file() || meta.len() > 1024 {
        return false;
    }
    fs::read(&marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|value| value["version"] == 1 && value["workId"].as_str() == Some(work_id))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_file_name(format!(".story-studio-write-{}", uuid::Uuid::new_v4()));
    atomic_write_to(path, bytes, &temporary)
}
pub(crate) fn atomic_write_to(path: &Path, bytes: &[u8], temporary: &Path) -> Result<(), String> {
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary)
            .map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        fs::rename(temporary, path).map_err(io_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn candidate_name(base: &str, rank: u16) -> String {
    if rank == 1 {
        base.into()
    } else {
        format!("{base} ({rank})")
    }
}
// Lists each category once and groups the entries named like one of the
// candidates `base`, `base (2)` … `base (1000)` by rank and category.
fn candidate_entries(
    base: &str,
    categories: &[PathBuf],
) -> Result<BTreeMap<u16, Vec<(usize, PathBuf)>>, String> {
    let ranks: HashMap<String, u16> = (1..=1000)
        .map(|rank| (collision_key(&candidate_name(base, rank)), rank))
        .collect();
    let mut found: BTreeMap<u16, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for (category, parent) in categories.iter().enumerate() {
        let entries = match fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_error(e)),
        };
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            if let Some(rank) = ranks.get(&collision_key(&entry.file_name().to_string_lossy())) {
                found
                    .entry(*rank)
                    .or_default()
                    .push((category, entry.path()));
            }
        }
    }
    Ok(found)
}
// Rank choice: first a rank already holding one of our folders and no foreign
// one (storage.folder only keeps the base, so a "(2)" must be found again
// even once the base is freed), otherwise the first rank free everywhere.
// `unavailable` holds names whose creation collided out of the listing's view.
fn choose_candidate(
    base: &str,
    categories: &[PathBuf],
    work_id: &str,
    unavailable: &HashSet<String>,
    target: Option<usize>,
) -> Result<String, String> {
    let found = candidate_entries(base, categories)?;
    for entries in found.values() {
        if entries
            .iter()
            .all(|(category, path)| owns_folder(path, &categories[*category], work_id))
            && entries.iter().enumerate().any(|(index, (category, _))| {
                entries[..index].iter().any(|(other, _)| other == category)
            })
        {
            return Err(
                user_message::UserMessage::new(codes::FILES_PROJECT_FOLDER_NAME_COLLISION)
                    .with_detail("Plusieurs dossiers ont le même nom normalisé.".to_string())
                    .into_transport(),
            );
        }
    }
    // Once categories are lazy, another project may occupy the shared rank
    // in an unused category. Keep each owned category stable first.
    if let Some(target) = target {
        for require_target in [true, false] {
            for entries in found.values() {
                let owned: Vec<_> = entries
                    .iter()
                    .filter(|(category, path)| owns_folder(path, &categories[*category], work_id))
                    .collect();
                if owned.is_empty() {
                    continue;
                }
                let in_target: Vec<_> = entries
                    .iter()
                    .filter(|(category, _)| *category == target)
                    .collect();
                let path = if require_target {
                    if in_target.len() != 1
                        || !owns_folder(&in_target[0].1, &categories[target], work_id)
                    {
                        continue;
                    }
                    &in_target[0].1
                } else {
                    if !in_target.is_empty() {
                        continue;
                    }
                    &owned.last().unwrap().1
                };
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if !unavailable.contains(&name) {
                    return Ok(name);
                }
            }
        }
    }
    for entries in found.values() {
        if target.is_some()
            || !entries
                .iter()
                .all(|(category, path)| owns_folder(path, &categories[*category], work_id))
        {
            continue;
        }
        // Reuse the existing spelling rather than creating a case twin on POSIX.
        let (_, path) = entries.last().unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if !unavailable.contains(&name) {
            return Ok(name);
        }
    }
    (1..=1000)
        .filter(|rank| !found.contains_key(rank))
        .map(|rank| candidate_name(base, rank))
        .find(|name| !unavailable.contains(name))
        .ok_or_else(|| {
            user_message::UserMessage::new(codes::FILES_PROJECT_FOLDER_NAME_EXHAUSTED)
                .with_detail("Impossible de réserver un dossier de projet unique.".to_string())
                .into_transport()
        })
}

pub fn resolve_project_folder(
    root: &str,
    folder: &str,
    work_id: &str,
    create: bool,
) -> Result<String, String> {
    resolve_project_folder_impl(root, folder, work_id, create, None, |path| {
        fs::create_dir(path)
    })
}
pub fn resolve_project_media_folder(
    root: &str,
    folder: &str,
    work_id: &str,
    category: &str,
    create: bool,
) -> Result<String, String> {
    resolve_project_folder_impl(root, folder, work_id, create, Some(category), |path| {
        fs::create_dir(path)
    })
}
fn resolve_project_folder_impl(
    root: &str,
    folder: &str,
    work_id: &str,
    create: bool,
    category: Option<&str>,
    create_dir: impl Fn(&Path) -> std::io::Result<()>,
) -> Result<String, String> {
    let _lock = FOLDER_LOCK.lock().map_err(io_error)?;
    validate_owner(work_id)?;
    let target = category
        .map(|category| {
            PROJECT_CATEGORIES
                .iter()
                .position(|name| *name == category)
                .ok_or_else(|| {
                    user_message::UserMessage::new(codes::FILES_INVALID_MEDIA_CATEGORY)
                        .into_transport()
                })
        })
        .transpose()?;
    let base = sanitize_project_folder(folder);
    let (_, categories) = root_and_categories(root, create)?;
    // Each lost creation race (another process) lists the categories again;
    // the raced name is excluded, the collision may be invisible to
    // collision_key on a case-insensitive volume (ſ/s for instance).
    let mut unavailable = HashSet::new();
    for _ in 0..1000 {
        let name = choose_candidate(&base, &categories, work_id, &unavailable, target)?;
        let Some(target) = target.filter(|_| create) else {
            return Ok(name);
        };
        let parent = &categories[target];
        fs::create_dir_all(parent).map_err(io_error)?;
        direct_directory(parent, parent.parent().unwrap())?;
        if let Some(path) = existing_candidate(parent, &name)? {
            if owns_folder(&path, parent, work_id) {
                return Ok(path.file_name().unwrap().to_string_lossy().into_owned());
            }
            unavailable.insert(name);
            continue;
        }
        let path = parent.join(&name);
        match create_dir(&path) {
            Ok(()) => {
                let result = direct_directory(&path, parent).and_then(|_| {
                    atomic_write(
                        &path.join(MARKER),
                        serde_json::json!({"version":1,"workId":work_id})
                            .to_string()
                            .as_bytes(),
                    )
                });
                if let Err(error) = result {
                    let _ = fs::remove_dir(&path);
                    return Err(error);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                unavailable.insert(name);
                continue;
            }
            Err(e) => return Err(io_error(e)),
        }
        return Ok(name);
    }
    Err(
        user_message::UserMessage::new(codes::FILES_PROJECT_FOLDER_NAME_EXHAUSTED)
            .with_detail("Impossible de réserver un dossier de projet unique.".to_string())
            .into_transport(),
    )
}

#[derive(Clone, serde::Serialize)]
pub struct ProjectFolderMove {
    pub from: String,
    pub to: String,
}
// Sidecars cross the Rust/JS path boundary: Windows spelling and extended
// prefixes can differ, while POSIX paths must retain their case sensitivity.
fn relocated_path(path: &str, from: &str, to: &str) -> Option<String> {
    let key = crate::support::paths::path_key(path);
    let prefix = crate::support::paths::path_key(from);
    let prefix = prefix.trim_end_matches('/');
    if key != prefix && !key.starts_with(&format!("{prefix}/")) {
        return None;
    }
    let portable = path_for_frontend(Path::new(path)).replace('\\', "/");
    let count = path_for_frontend(Path::new(from))
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .count();
    let tail = portable
        .split('/')
        .filter(|part| !part.is_empty())
        .skip(count)
        .collect::<Vec<_>>()
        .join("/");
    let target = path_for_frontend(Path::new(to)).replace('\\', "/");
    Some(if tail.is_empty() {
        target
    } else {
        format!("{}/{tail}", target.trim_end_matches('/'))
    })
}

fn remap_sidecar(value: &mut Value, moves: &[ProjectFolderMove]) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if ["sourcePath", "original_path", "originalPath"].contains(&key.as_str()) {
                    if let Some(path) = value.as_str() {
                        for mapping in moves {
                            if let Some(target) = relocated_path(path, &mapping.from, &mapping.to) {
                                *value = Value::String(target);
                                break;
                            }
                        }
                    }
                } else {
                    remap_sidecar(value, moves);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                remap_sidecar(value, moves);
            }
        }
        _ => (),
    }
}
fn collect_sidecars(dir: &Path, output: &mut Vec<PathBuf>, in_sidecar: bool) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if is_link(&metadata) {
            return Err(
                user_message::UserMessage::new(codes::FILES_LINK_FORBIDDEN_FOLDER_RENAME)
                    .with_detail("Lien interdit dans un dossier à renommer.".to_string())
                    .into_transport(),
            );
        }
        if metadata.is_dir() {
            let name = entry.file_name();
            let sidecar = in_sidecar
                || name == ".story-studio-image-edits"
                || name == ".story-studio-audio-edits";
            collect_sidecars(&path, output, sidecar)?;
        } else if in_sidecar
            && metadata.is_file()
            && path.extension().is_some_and(|ext| ext == "json")
        {
            output.push(path);
        }
    }
    Ok(())
}
pub fn rename_project_folder(
    root: &str,
    old: &str,
    new: &str,
    work_id: &str,
) -> Result<Vec<ProjectFolderMove>, String> {
    rename_project_folder_impl(root, old, new, work_id, None, |_| Ok(()))
}
pub fn restore_project_folder(
    root: &str,
    old: &str,
    new: &str,
    work_id: &str,
    original_folders: &HashMap<String, String>,
) -> Result<Vec<ProjectFolderMove>, String> {
    rename_project_folder_impl(root, old, new, work_id, Some(original_folders), |_| Ok(()))
}
fn rename_project_folder_impl(
    root: &str,
    old: &str,
    new: &str,
    work_id: &str,
    original_folders: Option<&HashMap<String, String>>,
    before_rename: impl Fn(usize) -> Result<(), String>,
) -> Result<Vec<ProjectFolderMove>, String> {
    let _lock = FOLDER_LOCK.lock().map_err(io_error)?;
    validate_owner(work_id)?;
    validate_component(old)?;
    validate_component(new)?;
    let (_, categories) = root_and_categories(root, false)?;
    if let Some(folders) = original_folders {
        for (category, folder) in folders {
            if !PROJECT_CATEGORIES.contains(&category.as_str()) {
                return Err(
                    user_message::UserMessage::new(codes::FILES_INVALID_MEDIA_CATEGORY)
                        .into_transport(),
                );
            }
            validate_component(folder)?;
        }
    }
    let mut pairs = Vec::new();
    let mut sidecars = Vec::new();
    // Category ranks may diverge after a late collision. Only this base's
    // candidates belong to the rename, even when another base shares its owner.
    let candidates = candidate_entries(old, &categories)?;
    let mut owned = Vec::new();
    for (category, parent) in categories.iter().enumerate() {
        if original_folders.is_some_and(|folders| {
            !folders.contains_key(parent.file_name().unwrap().to_str().unwrap())
        }) {
            continue;
        }
        for (index, from) in candidates.values().flatten() {
            if *index == category
                && owns_folder(from, parent, work_id)
                && (original_folders.is_none() || from.file_name().unwrap() == old)
            {
                owned.push((parent, from.clone()));
            }
        }
    }
    for (parent, from) in owned {
        let new = original_folders
            .and_then(|folders| folders.get(parent.file_name().unwrap().to_str().unwrap()))
            .map_or(new, String::as_str);
        if from.file_name().is_some_and(|name| name == new) {
            continue;
        }
        if existing_candidate(parent, new)?.is_some() {
            return Err(
                user_message::UserMessage::new(codes::FILES_PROJECT_MERGE_FORBIDDEN)
                    .with_detail("Dossier cible déjà présent : fusion interdite.".to_string())
                    .into_transport(),
            );
        }
        collect_sidecars(&from, &mut sidecars, false)?;
        pairs.push((from, parent.join(new)));
    }
    let moves: Vec<_> = pairs
        .iter()
        .map(|(from, to)| ProjectFolderMove {
            from: path_for_frontend(from),
            to: path_for_frontend(to),
        })
        .collect();
    // Prepare every sidecar before touching the filesystem. Malformed metadata
    // fails the transaction instead of silently breaking re-editing.
    let mut prepared = Vec::new();
    for path in sidecars {
        let original = fs::read(&path).map_err(io_error)?;
        let mut value: Value = serde_json::from_slice(&original).map_err(io_error)?;
        remap_sidecar(&mut value, &moves);
        let mut target = path.clone();
        for (from, to) in &pairs {
            if let Ok(tail) = path.strip_prefix(from) {
                target = to.join(tail);
                break;
            }
        }
        prepared.push((
            target,
            original,
            serde_json::to_vec_pretty(&value).map_err(io_error)?,
        ));
    }
    let mut renamed = 0;
    let mut rewritten = 0;
    let result = (|| {
        for (index, (from, to)) in pairs.iter().enumerate() {
            before_rename(index)?;
            // Repeat ownership and destination checks immediately before rename.
            if !owns_folder(from, from.parent().unwrap(), work_id)
                || existing_candidate(
                    to.parent().unwrap(),
                    to.file_name().unwrap().to_str().unwrap(),
                )?
                .is_some()
            {
                return Err(user_message::UserMessage::new(
                    codes::FILES_FOLDER_CHANGED_DURING_ORGANIZATION,
                )
                .with_detail("Dossier modifié pendant le rangement.".to_string())
                .into_transport());
            }
            fs::rename(from, to).map_err(io_error)?;
            renamed += 1;
        }
        for (path, _, bytes) in &prepared {
            atomic_write(path, bytes)?;
            rewritten += 1;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (path, bytes, _) in prepared[..rewritten].iter().rev() {
            if let Err(e) = atomic_write(path, bytes) {
                failures.push(e);
            }
        }
        for (from, to) in pairs[..renamed].iter().rev() {
            if let Err(e) = fs::rename(to, from) {
                failures.push(io_error(e));
            }
        }
        return Err(if failures.is_empty() {
            error
        } else {
            {
                let _msg_error = (error).to_string();
                let _msg_failures_join =
                    crate::support::user_message::compose_messages(&failures, "; ");
                user_message::UserMessage::new(codes::FILES_INCOMPLETE_ROLLBACK)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .param(
                        "failures",
                        user_message::transport_param(_msg_failures_join.clone()),
                    )
                    .with_detail(format!(
                        "{_msg_error}; retour arrière incomplet : {_msg_failures_join}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_failures_join = user_message::transport_detail(&_msg_failures_join)
                    ))
                    .into_transport()
            }
        });
    }
    Ok(moves)
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMediaDestination {
    pub folder: String,
    pub work_id: String,
}

pub(crate) fn project_media_dir(
    root: &str,
    category: &str,
    destination: Option<&ProjectMediaDestination>,
) -> Result<PathBuf, String> {
    if !PROJECT_CATEGORIES.contains(&category) {
        return Err(
            user_message::UserMessage::new(codes::FILES_INVALID_MEDIA_CATEGORY)
                .with_detail("Catégorie média invalide.".to_string())
                .into_transport(),
        );
    }
    let Some(destination) = destination else {
        return Ok(
            super::absolute_path(root, codes::FILES_WORKSPACE_LOCATION_TRANSPORT)?.join(category),
        );
    };
    validate_component(&destination.folder)?;
    validate_owner(&destination.work_id)?;
    let folder = resolve_project_media_folder(
        root,
        &destination.folder,
        &destination.work_id,
        category,
        true,
    )?;
    let (_, categories) = root_and_categories(root, false)?;
    let parent = &categories[PROJECT_CATEGORIES
        .iter()
        .position(|name| *name == category)
        .unwrap()];
    let path = parent.join(folder);
    // Resolution only returns an owned folder; recheck before writing in case
    // another process replaced it in between.
    if !owns_folder(&path, parent, &destination.work_id) {
        return Err(
            user_message::UserMessage::new(codes::FILES_FOREIGN_UNRESERVED_MEDIA_TARGET)
                .with_detail("Destination média étrangère ou non réservée.".to_string())
                .into_transport(),
        );
    }
    direct_directory(&path, parent)
}
