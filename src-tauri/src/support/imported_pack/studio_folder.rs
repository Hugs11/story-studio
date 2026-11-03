//! Dossier de pack Studio lu sur place, sans archive intermédiaire.
//!
//! Même périmètre et mêmes refus que sa conversion en ZIP
//! (`ensure_studio_pack_zip_from_dir`) : racine de pack localisée par
//! `locate_pack_root`, dossiers intermédiaires et entrées refusés s'ils sont des
//! liens, seuls `story.json`, `thumbnail.png` et `assets/` parcourus, et le
//! `story.json` rendu est celui que la conversion aurait écrit dans l'archive.
//! Un média est désigné par le nom qu'il aurait dans cette archive, comparé
//! exactement (casse comprise) comme le ferait la lecture du ZIP.
//!
//! Garde contre un dossier modifié pendant l'envoi : chaque fichier lu est
//! copié dans un espace possédé par l'appelant. `verify_unchanged` relit
//! ensuite la liste du pack (noms, types, tailles), le `story.json` (octets
//! identiques) et chaque source copiée, comparée octet pour octet à sa copie :
//! la moindre différence refuse l'envoi avec le message de la conversion
//! (`IMPORT_CONVERSION_FOLDER_CHANGED`). Ce qui est envoyé est la copie, jamais
//! la source relue après cette vérification.
use super::source_tree::{
    archive_entry_name, reject_linked_pack_root_ancestors, revalidate_regular_entry,
    validated_studio_pack_tree_cancellable, ValidatedDirectoryEntry,
};
use super::{
    authorize_studio_story_text, cancellation, folder_changed, locate_pack_root,
    looks_like_studio_pack_directory,
};
use crate::native_pack::output_identity::{read_story_text, AuthorizedStory};
use crate::services::project_files::validate_existing_dir_path;
use crate::support::user_message::{self, codes, UserMessage};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

struct Copied {
    entry: usize,
    copy: PathBuf,
    len: u64,
}

const CHUNK: usize = 256 * 1024;

pub(crate) struct StudioFolder {
    source: PathBuf,
    root: PathBuf,
    text: String,
    story: AuthorizedStory,
    entries: Vec<ValidatedDirectoryEntry>,
    files: HashMap<String, usize>,
    copied: Vec<Copied>,
}

impl StudioFolder {
    /// `None` quand le dossier ne porte pas un pack Studio lisible tel quel
    /// (pack filesystem, `story.json` sous une autre casse) : la conversion en
    /// ZIP reste alors seule juge.
    pub(crate) fn open(dir: &Path, cancel: &AtomicBool) -> Result<Option<Self>, String> {
        cancellation::check(cancel)?;
        let source = validate_existing_dir_path(
            &dir.to_string_lossy(),
            codes::FILES_IMPORTED_PACK_FOLDER_TRANSPORT,
        )?;
        let root = locate_pack_root(&source)?;
        if !looks_like_studio_pack_directory(&root) {
            return Ok(None);
        }
        reject_linked_pack_root_ancestors(&source, &root)?;
        let entries = validated_studio_pack_tree_cancellable(&root, cancel)?;
        let mut files = HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            if !entry.is_dir {
                files.insert(archive_entry_name(&entry.relative)?, index);
            }
        }
        // The converted archive names its story member exactly `story.json`.
        if !files.contains_key("story.json") {
            return Ok(None);
        }
        let text = read_story_text(&root).map_err(UserMessage::into_transport)?;
        let story = authorize_studio_story_text(&text)?;
        Ok(Some(Self {
            source,
            root,
            text,
            story,
            entries,
            files,
            copied: Vec::new(),
        }))
    }

    /// The `story.json` the conversion would have archived.
    pub(crate) fn story(&self) -> &AuthorizedStory {
        &self.story
    }

    /// Copies the member `name` of the would-be archive (an `assets/` name
    /// already validated by the caller) to `to`, a new file.
    pub(crate) fn copy_asset(
        &mut self,
        name: &str,
        to: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let index = *self.files.get(name).ok_or_else(|| asset_not_found(name))?;
        let entry = &self.entries[index];
        revalidate_regular_entry(&self.root, entry)?;
        let mut input = fs::File::open(&entry.absolute).map_err(|e| read_failed(entry, e))?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)
            .map_err(write_failed)?;
        let mut buffer = vec![0_u8; CHUNK];
        let mut len = 0_u64;
        loop {
            cancellation::check(cancel)?;
            let count = input.read(&mut buffer).map_err(|e| read_failed(entry, e))?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(write_failed)?;
            len += count as u64;
        }
        self.copied.push(Copied {
            entry: index,
            copy: to.to_owned(),
            len,
        });
        Ok(())
    }

    /// Refuses when the pack listing, `story.json` or any copied source no
    /// longer matches what was read (see the module notes).
    pub(crate) fn verify_unchanged(&self, cancel: &AtomicBool) -> Result<(), String> {
        let changed = || folder_changed(&self.source);
        let now = validated_studio_pack_tree_cancellable(&self.root, cancel)?;
        if now.len() != self.entries.len()
            || now.iter().zip(&self.entries).any(|(a, b)| {
                a.relative != b.relative
                    || a.absolute != b.absolute
                    || a.is_dir != b.is_dir
                    || a.len != b.len
            })
        {
            return Err(changed());
        }
        if read_story_text(&self.root).map_err(UserMessage::into_transport)? != self.text {
            return Err(changed());
        }
        for copied in &self.copied {
            let entry = &self.entries[copied.entry];
            revalidate_regular_entry(&self.root, entry).map_err(|_| changed())?;
            if entry.len != copied.len {
                return Err(changed());
            }
            let mut input = fs::File::open(&entry.absolute).map_err(|e| read_failed(entry, e))?;
            let mut copy = fs::File::open(&copied.copy).map_err(write_failed)?;
            let (mut source, mut kept) = (vec![0_u8; CHUNK], vec![0_u8; CHUNK]);
            loop {
                cancellation::check(cancel)?;
                let count = input.read(&mut source).map_err(|e| read_failed(entry, e))?;
                if count == 0 {
                    // The copy must end here as well.
                    if copy.read(&mut kept[..1]).map_err(write_failed)? != 0 {
                        return Err(changed());
                    }
                    break;
                }
                if copy.read_exact(&mut kept[..count]).is_err() || source[..count] != kept[..count]
                {
                    return Err(changed());
                }
            }
        }
        Ok(())
    }
}

/// Same message as a missing member of the converted archive (`get_pack_asset`).
fn asset_not_found(name: &str) -> String {
    let _msg_asset_name = (name).to_string();
    UserMessage::new(codes::IMPORT_ASSET_NOT_FOUND)
        .param(
            "assetName",
            user_message::transport_param(_msg_asset_name.clone()),
        )
        .with_detail(format!(
            "Asset introuvable : {_msg_asset_name}",
            _msg_asset_name = user_message::transport_detail(&_msg_asset_name)
        ))
        .into_transport()
}

fn read_failed(entry: &ValidatedDirectoryEntry, error: std::io::Error) -> String {
    let _msg_entry_absolute = (entry.absolute.display()).to_string();
    let _msg_error = (error).to_string();
    UserMessage::new(codes::FILES_ARCHIVE_ENTRY_READ_FAILED)
        .param(
            "entryAbsolute",
            user_message::transport_param(_msg_entry_absolute.clone()),
        )
        .param("error", user_message::transport_param(_msg_error.clone()))
        .with_detail(format!(
            "Impossible de lire {_msg_entry_absolute} : {_msg_error}",
            _msg_entry_absolute = user_message::transport_detail(&_msg_entry_absolute),
            _msg_error = user_message::transport_detail(&_msg_error)
        ))
        .into_transport()
}

/// The destination belongs to the caller's staging: same failure as its other writes.
fn write_failed(error: std::io::Error) -> String {
    UserMessage::new(codes::STORYTELLER_WRITE_FAILED)
        .with_detail(error.to_string())
        .into_transport()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::user_message::MessageTransportAssertions as _;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn dir() -> Dir {
        let path = std::env::temp_dir().join(format!("studio-folder-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("pack/assets")).unwrap();
        Dir(path)
    }

    #[test]
    fn a_copied_source_listing_or_story_changed_after_reading_is_refused() {
        let base = dir();
        let pack = base.0.join("pack");
        fs::write(pack.join("story.json"), br#"{"title":"x"}"#).unwrap();
        fs::write(pack.join("assets/a.mp3"), b"original").unwrap();
        fs::write(pack.join("assets/b.png"), b"unused").unwrap();
        let cancel = AtomicBool::new(false);
        let open = || StudioFolder::open(&pack, &cancel).unwrap().unwrap();
        let changed = |folder: &StudioFolder| {
            assert!(folder
                .verify_unchanged(&cancel)
                .unwrap_err()
                .contains_any_code(&[codes::IMPORT_CONVERSION_FOLDER_CHANGED]));
        };

        let mut folder = open();
        let copy = base.0.join("copy-0");
        folder.copy_asset("assets/a.mp3", &copy, &cancel).unwrap();
        folder.verify_unchanged(&cancel).unwrap();
        // Same size, other bytes: only the content digest can see it.
        fs::write(pack.join("assets/a.mp3"), b"modified").unwrap();
        changed(&folder);
        assert_eq!(fs::read(&copy).unwrap(), b"original");

        let mut folder = open();
        folder
            .copy_asset("assets/a.mp3", &base.0.join("copy-1"), &cancel)
            .unwrap();
        // Outside the pack scope: ignored, as by the conversion.
        fs::write(pack.join("notes.txt"), b"foreign").unwrap();
        folder.verify_unchanged(&cancel).unwrap();
        fs::write(pack.join("assets/c.mp3"), b"added").unwrap();
        changed(&folder);

        let folder = open();
        fs::write(pack.join("story.json"), br#"{"title":"y"}"#).unwrap();
        changed(&folder);

        let mut folder = open();
        fs::write(pack.join("assets/b.png"), b"resized!").unwrap();
        changed(&folder);
        assert!(folder
            .copy_asset("assets/A.mp3", &base.0.join("copy-2"), &cancel)
            .unwrap_err()
            .contains_any_code(&[codes::IMPORT_ASSET_NOT_FOUND]));
    }

    #[test]
    fn the_story_is_the_one_the_conversion_archives() {
        let base = dir();
        let pack = base.0.join("pack");
        let text = r#"{"title":"x","official":true}"#;
        fs::write(pack.join("story.json"), text).unwrap();
        let folder = StudioFolder::open(&pack, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert_eq!(
            folder.story().as_str(),
            authorize_studio_story_text(text).unwrap().as_str()
        );
        assert!(!folder.story().contains("official"));
    }
}
