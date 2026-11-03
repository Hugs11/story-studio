//! Copies durable media plus re-editing dependencies. The source session is
//! read-only; every destination is exclusive and an incomplete copy rolls back.
use super::{project_media_dir, ProjectFolderMove, ProjectMediaDestination};
use crate::support::paths::path_for_frontend;
use crate::support::user_message;
use crate::support::user_message::codes;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
pub struct ProjectMediaCopy {
    pub path: String,
    pub copies: Vec<ProjectFolderMove>,
}
struct Copier<'a> {
    root: &'a str,
    destination: Option<&'a ProjectMediaDestination>,
    session: Option<PathBuf>,
    copies: HashMap<PathBuf, PathBuf>,
    created_files: Vec<PathBuf>,
    created_dirs: Vec<PathBuf>,
    sidecars: Vec<(PathBuf, PathBuf, Value)>,
}
fn error(e: impl std::fmt::Display) -> String {
    {
        let _msg_e = (e).to_string();
        user_message::UserMessage::new(codes::FILES_MEDIA_COPY)
            .param("error", user_message::transport_param(_msg_e.clone()))
            .with_detail(format!(
                "Copie du média : {_msg_e}",
                _msg_e = user_message::transport_detail(&_msg_e)
            ))
            .into_transport()
    }
}
fn regular_source(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if super::project_storage::is_link(&metadata) || !metadata.is_file() {
        return Err(
            user_message::UserMessage::new(codes::FILES_LINKED_IRREGULAR_MEDIA_SOURCE)
                .with_detail("Source média liée ou irrégulière.".to_string())
                .into_transport(),
        );
    }
    fs::canonicalize(path).map_err(error)
}
const DEPENDENCY_KEYS: [&str; 3] = ["sourcePath", "original_path", "originalPath"];
// A re-editing dependency deleted meanwhile (e.g. a microphone take removed
// from the library) does not block the copy: the media is kept without this
// sidecar, which would otherwise cite a dead or soon-cleaned session path.
// A present but linked/irregular dependency still fails in regular_source.
fn dependencies_present(metadata: &Value, sidecar: &Path) -> Result<bool, String> {
    for key in DEPENDENCY_KEYS {
        let Some(path) = metadata[key].as_str() else {
            continue;
        };
        match fs::symlink_metadata(path) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                log::warn!(
                    target: "media_copy",
                    "re-edit dependency missing, sidecar dropped: {} -> {path}",
                    sidecar.display()
                );
                return Ok(false);
            }
            Err(e) => return Err(error(format!("{path} : {e}"))),
        }
    }
    Ok(true)
}
impl Copier<'_> {
    fn mkdir(&mut self, path: &Path) -> Result<(), String> {
        fs::create_dir(path).map_err(error)?;
        self.created_dirs.push(path.into());
        Ok(())
    }
    fn category(&self, source: &Path, fallback: &str) -> String {
        self.session
            .as_ref()
            .and_then(|root| source.strip_prefix(root).ok())
            .and_then(|tail| tail.components().next())
            .and_then(|c| c.as_os_str().to_str())
            .filter(|cat| super::project_storage::PROJECT_CATEGORIES.contains(cat))
            .unwrap_or(fallback)
            .into()
    }
    fn exclusive_copy(&mut self, source: &Path, target: &Path) -> Result<(), String> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(error)?;
        self.created_files.push(target.into());
        let mut input = fs::File::open(source).map_err(error)?;
        io::copy(&mut input, &mut output).map_err(error)?;
        output.sync_all().map_err(error)?;
        self.copies.insert(source.into(), target.into());
        Ok(())
    }
    fn file(&mut self, source: &Path, category: &str, depth: usize) -> Result<PathBuf, String> {
        if depth > 128 {
            return Err(
                user_message::UserMessage::new(codes::FILES_MEDIA_DEPENDENCIES_TOO_DEEP)
                    .with_detail("Dépendances médias trop profondes.".to_string())
                    .into_transport(),
            );
        }
        let source = regular_source(source)?;
        if let Some(path) = self.copies.get(&source) {
            return Ok(path.clone());
        }
        let category = self.category(&source, category);
        let directory = project_media_dir(self.root, &category, self.destination)?;
        if source.starts_with(&directory) {
            return Ok(source);
        }
        fs::create_dir_all(&directory).map_err(error)?;
        let name = source
            .file_name()
            .ok_or(codes::FILES_INVALID_MEDIA_NAME_TRANSPORT)?
            .to_string_lossy();
        let stem = source.file_stem().unwrap().to_string_lossy();
        let extension = source
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_default();
        let mut target = None;
        for index in 1..=1000 {
            let candidate = directory.join(if index == 1 {
                name.to_string()
            } else {
                format!("{stem}_{index}{extension}")
            });
            if candidate.try_exists().map_err(error)? {
                continue;
            }
            match self.exclusive_copy(&source, &candidate) {
                Ok(()) => {
                    target = Some(candidate);
                    break;
                }
                Err(e) if candidate.exists() && !self.created_files.contains(&candidate) => {
                    let _ = e;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        let target = target.ok_or(codes::FILES_MEDIA_FILENAME_EXHAUSTED_TRANSPORT)?;
        for sidecar_dir in [".story-studio-image-edits", ".story-studio-audio-edits"] {
            let metadata_source = source
                .parent()
                .unwrap()
                .join(sidecar_dir)
                .join(format!("{name}.edit.json"));
            if !metadata_source.try_exists().map_err(error)? {
                continue;
            }
            let metadata_source = regular_source(&metadata_source)?;
            let metadata: Value =
                serde_json::from_slice(&fs::read(&metadata_source).map_err(error)?)
                    .map_err(error)?;
            if !dependencies_present(&metadata, &metadata_source)? {
                continue;
            }
            for key in DEPENDENCY_KEYS {
                if let Some(path) = metadata[key].as_str() {
                    self.file(Path::new(path), "fichiers-importes", depth + 1)?;
                }
            }
            let metadata_dir = target.parent().unwrap().join(sidecar_dir);
            if !metadata_dir.exists() {
                self.mkdir(&metadata_dir)?;
            }
            let metadata_target = metadata_dir.join(format!(
                "{}.edit.json",
                target.file_name().unwrap().to_string_lossy()
            ));
            self.sidecars
                .push((metadata_source, metadata_target, metadata));
        }
        Ok(target)
    }
    fn tree(&mut self, source: &Path, target: &Path, depth: usize) -> Result<(), String> {
        if depth > 128 {
            return Err(
                user_message::UserMessage::new(codes::FILES_EXTRACTION_TOO_DEEP)
                    .with_detail("Extraction trop profonde.".to_string())
                    .into_transport(),
            );
        }
        for entry in fs::read_dir(source).map_err(error)? {
            let entry = entry.map_err(error)?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(error)?;
            if super::project_storage::is_link(&meta) {
                return Err(
                    user_message::UserMessage::new(codes::FILES_LINK_FORBIDDEN_EXTRACTION)
                        .with_detail("Lien interdit dans une extraction.".to_string())
                        .into_transport(),
                );
            }
            let output = target.join(entry.file_name());
            if meta.is_dir() {
                self.mkdir(&output)?;
                self.tree(&path, &output, depth + 1)?;
            } else if meta.is_file() {
                let canonical = regular_source(&path)?;
                let in_sidecar = path.components().any(|part| {
                    [".story-studio-image-edits", ".story-studio-audio-edits"]
                        .iter()
                        .any(|name| part.as_os_str() == *name)
                });
                if in_sidecar && path.extension().is_some_and(|ext| ext == "json") {
                    let value: Value =
                        serde_json::from_slice(&fs::read(&canonical).map_err(error)?)
                            .map_err(error)?;
                    self.sidecars.push((canonical, output, value));
                } else {
                    self.exclusive_copy(&canonical, &output)?;
                }
            } else {
                return Err(
                    user_message::UserMessage::new(codes::FILES_IRREGULAR_FILE_EXTRACTION)
                        .with_detail("Fichier irrégulier dans une extraction.".to_string())
                        .into_transport(),
                );
            }
        }
        Ok(())
    }
    fn extraction(&mut self, source: &Path) -> Result<Option<PathBuf>, String> {
        let Some(session) = &self.session else {
            return Ok(None);
        };
        let Ok(relative) = source.strip_prefix(session.join("zips-extraits")) else {
            return Ok(None);
        };
        let Some(name) = relative.components().next() else {
            return Ok(None);
        };
        let origin = session.join("zips-extraits").join(name.as_os_str());
        if origin.is_dir() {
            let metadata = fs::symlink_metadata(&origin).map_err(error)?;
            if super::project_storage::is_link(&metadata) {
                return Err(user_message::UserMessage::new(
                    codes::FILES_LINKED_EXTRACTION_SOURCE_FORBIDDEN,
                )
                .with_detail("Extraction source liée interdite".to_string())
                .into_transport());
            }
        }
        if !origin.is_dir() {
            return Ok(None);
        }
        let directory = project_media_dir(self.root, "zips-extraits", self.destination)?;
        let mut output = None;
        for index in 1..=1000 {
            let stem = name.as_os_str().to_string_lossy();
            let candidate = directory.join(if index == 1 {
                stem.into_owned()
            } else {
                format!("{stem}-{index}")
            });
            match fs::create_dir(&candidate) {
                Ok(()) => {
                    self.created_dirs.push(candidate.clone());
                    output = Some(candidate);
                    break;
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(error(e)),
            }
        }
        let output = output.ok_or(codes::FILES_EXTRACTION_FILENAME_EXHAUSTED_TRANSPORT)?;
        self.tree(&origin, &output, 0)?;
        Ok(Some(
            output.join(source.strip_prefix(origin).map_err(error)?),
        ))
    }
    fn finish_sidecars(&mut self) -> Result<(), String> {
        let mut index = 0;
        while index < self.sidecars.len() {
            let (source, _, metadata) = &self.sidecars[index];
            if !dependencies_present(metadata, source)? {
                self.sidecars.remove(index);
                continue;
            }
            let dependencies: Vec<String> = DEPENDENCY_KEYS
                .iter()
                .filter_map(|key| self.sidecars[index].2[*key].as_str().map(String::from))
                .collect();
            for path in dependencies {
                let original = regular_source(Path::new(&path))?;
                if !self.copies.contains_key(&original) {
                    self.file(&original, "fichiers-importes", 0)?;
                }
            }
            index += 1;
        }
        for (source, target, mut value) in std::mem::take(&mut self.sidecars) {
            for key in DEPENDENCY_KEYS {
                if let Some(path) = value[key].as_str() {
                    let original = regular_source(Path::new(path))?;
                    if let Some(copied) = self.copies.get(&original) {
                        value[key] = Value::String(path_for_frontend(copied));
                    }
                }
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(error)?;
            self.created_files.push(target.clone());
            use std::io::Write;
            file.write_all(&serde_json::to_vec_pretty(&value).map_err(error)?)
                .map_err(error)?;
            file.sync_all().map_err(error)?;
            self.copies.insert(source, target);
        }
        Ok(())
    }
}
pub fn copy_project_media(
    source_path: &str,
    root: &str,
    category: &str,
    destination: Option<&ProjectMediaDestination>,
    session_root: Option<&str>,
) -> Result<ProjectMediaCopy, String> {
    let source = regular_source(Path::new(source_path))?;
    let session = session_root
        .map(|path| {
            super::absolute_path(path, codes::FILES_SOURCE_SESSION_TRANSPORT)
                .and_then(|path| fs::canonicalize(path).map_err(error))
        })
        .transpose()?;
    let mut copier = Copier {
        root,
        destination,
        session,
        copies: HashMap::new(),
        created_files: Vec::new(),
        created_dirs: Vec::new(),
        sidecars: Vec::new(),
    };
    let result: Result<ProjectMediaCopy, String> = (|| {
        let path = match copier.extraction(&source)? {
            Some(path) => path,
            None => copier.file(&source, category, 0)?,
        };
        copier.finish_sidecars()?;
        Ok(ProjectMediaCopy {
            path: path_for_frontend(path),
            copies: copier
                .copies
                .iter()
                .map(|(from, to)| ProjectFolderMove {
                    from: path_for_frontend(from),
                    to: path_for_frontend(to),
                })
                .collect(),
        })
    })();
    if result.is_err() {
        let mut failures = Vec::new();
        for path in copier.created_files.iter().rev() {
            if let Err(e) = fs::remove_file(path) {
                failures.push(error(e));
            }
        }
        for path in copier.created_dirs.iter().rev() {
            if let Err(e) = fs::remove_dir(path) {
                failures.push(error(e));
            }
        }
        if !failures.is_empty() {
            return Err({
                let _msg_result_err_unwrap = (result.err().unwrap()).to_string();
                let _msg_failures_join =
                    crate::support::user_message::compose_messages(&failures, "; ");
                user_message::UserMessage::new(codes::FILES_INCOMPLETE_CLEANUP)
                    .param(
                        "error",
                        user_message::transport_param(_msg_result_err_unwrap.clone()),
                    )
                    .param(
                        "failures",
                        user_message::transport_param(_msg_failures_join.clone()),
                    )
                    .with_detail(format!(
                        "{_msg_result_err_unwrap}; nettoyage incomplet : {_msg_failures_join}",
                        _msg_failures_join = user_message::transport_detail(&_msg_failures_join),
                        _msg_result_err_unwrap =
                            user_message::transport_detail(&_msg_result_err_unwrap)
                    ))
                    .into_transport()
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn promotion_preserves_categories_and_rewrites_audio_image_and_extraction_sidecars() {
        let base = std::env::temp_dir().join(format!("media-promotion-{}", uuid::Uuid::new_v4()));
        let session = base.join("session");
        let root = base.join("workspace");
        fs::create_dir_all(&session).unwrap();
        fs::create_dir_all(&root).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let folder =
            super::super::resolve_project_folder(root.to_str().unwrap(), "Azuro", &id, true)
                .unwrap();
        let destination = ProjectMediaDestination {
            folder,
            work_id: id,
        };
        let audio_dir = session.join("voix-generees");
        fs::create_dir_all(audio_dir.join(".story-studio-audio-edits")).unwrap();
        let audio = audio_dir.join("sound.flac");
        let original = audio_dir.join("sound.original.mp3");
        fs::write(&audio, "audio").unwrap();
        fs::write(&original, "original").unwrap();
        fs::write(
            audio_dir.join(".story-studio-audio-edits/sound.flac.edit.json"),
            serde_json::json!({"original_path":original,"mode":"trim"}).to_string(),
        )
        .unwrap();
        let result = copy_project_media(
            audio.to_str().unwrap(),
            root.to_str().unwrap(),
            "fichiers-importes",
            Some(&destination),
            Some(session.to_str().unwrap()),
        )
        .unwrap();
        assert!(Path::new(&result.path).ends_with("voix-generees/Azuro/sound.flac"));
        let metadata: Value = serde_json::from_slice(
            &fs::read(
                root.join("voix-generees/Azuro/.story-studio-audio-edits/sound.flac.edit.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(Path::new(metadata["original_path"].as_str().unwrap())
            .ends_with("voix-generees/Azuro/sound.original.mp3"));
        assert!(original.is_file());
        let images = session.join("images-generees");
        fs::create_dir_all(images.join(".story-studio-image-edits")).unwrap();
        let source = images.join("source.png");
        let edited = images.join("edited.png");
        fs::write(&source, "source").unwrap();
        fs::write(&edited, "edited").unwrap();
        fs::write(
            images.join(".story-studio-image-edits/edited.png.edit.json"),
            serde_json::json!({"version":1,"sourcePath":source}).to_string(),
        )
        .unwrap();
        copy_project_media(
            edited.to_str().unwrap(),
            root.to_str().unwrap(),
            "fichiers-importes",
            Some(&destination),
            Some(session.to_str().unwrap()),
        )
        .unwrap();
        let sidecar: Value = serde_json::from_slice(
            &fs::read(
                root.join("images-generees/Azuro/.story-studio-image-edits/edited.png.edit.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(Path::new(sidecar["sourcePath"].as_str().unwrap())
            .ends_with("images-generees/Azuro/source.png"));
        let extraction = session.join("zips-extraits/Pack/assets");
        fs::create_dir_all(&extraction).unwrap();
        fs::write(extraction.join("one.mp3"), "one").unwrap();
        fs::write(extraction.join("two.png"), "two").unwrap();
        let result = copy_project_media(
            extraction.join("one.mp3").to_str().unwrap(),
            root.to_str().unwrap(),
            "fichiers-importes",
            Some(&destination),
            Some(session.to_str().unwrap()),
        )
        .unwrap();
        assert!(Path::new(&result.path).ends_with("zips-extraits/Azuro/Pack/assets/one.mp3"));
        assert!(root
            .join("zips-extraits/Azuro/Pack/assets/two.png")
            .is_file());
        assert!(result
            .copies
            .iter()
            .any(|copy| copy.to.ends_with("two.png")));
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn irregular_dependency_removes_all_new_files_without_touching_source() {
        let base =
            std::env::temp_dir().join(format!("media-promotion-failure-{}", uuid::Uuid::new_v4()));
        let session = base.join("session");
        let root = base.join("workspace");
        fs::create_dir_all(session.join(".story-studio-image-edits")).unwrap();
        fs::create_dir_all(session.join("not-a-file.png")).unwrap();
        fs::create_dir_all(&root).unwrap();
        let source = session.join("edited.png");
        let present = session.join("present.png");
        fs::write(&source, "edited").unwrap();
        fs::write(&present, "present").unwrap();
        fs::write(
            session.join(".story-studio-image-edits/edited.png.edit.json"),
            serde_json::json!({"version":1,"sourcePath":present,"originalPath":session.join("not-a-file.png")})
                .to_string(),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let folder =
            super::super::resolve_project_folder(root.to_str().unwrap(), "Azuro", &id, true)
                .unwrap();
        assert!(copy_project_media(
            source.to_str().unwrap(),
            root.to_str().unwrap(),
            "images-generees",
            Some(&ProjectMediaDestination {
                folder,
                work_id: id
            }),
            None
        )
        .is_err());
        assert!(source.is_file());
        let directory = root.join("images-generees/Azuro");
        assert!(!directory.join("edited.png").exists());
        assert!(!root.join("fichiers-importes/Azuro/present.png").exists());
        assert!(!directory.join(".story-studio-image-edits").exists());
        assert!(directory.join(".story-studio-dossier.json").is_file());
        fs::remove_dir_all(base).unwrap();
    }
    // ENOTDIR is a non-NotFound error on POSIX; Windows reports it as missing.
    #[cfg(unix)]
    #[test]
    fn dependency_io_error_names_the_dependency() {
        let base =
            std::env::temp_dir().join(format!("media-promotion-io-{}", uuid::Uuid::new_v4()));
        let session = base.join("session");
        let root = base.join("workspace");
        fs::create_dir_all(session.join(".story-studio-image-edits")).unwrap();
        fs::create_dir_all(&root).unwrap();
        let source = session.join("edited.png");
        fs::write(&source, "edited").unwrap();
        let dependency = source.join("child.png");
        fs::write(
            session.join(".story-studio-image-edits/edited.png.edit.json"),
            serde_json::json!({"version":1,"sourcePath":dependency}).to_string(),
        )
        .unwrap();
        let error = copy_project_media(
            source.to_str().unwrap(),
            root.to_str().unwrap(),
            "images-generees",
            None,
            None,
        )
        .err()
        .unwrap();
        assert!(error.contains(dependency.to_str().unwrap()), "{error}");
        assert!(!root.join("images-generees/edited.png").exists());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn missing_re_edit_dependency_copies_media_without_its_sidecar() {
        let base =
            std::env::temp_dir().join(format!("media-promotion-missing-{}", uuid::Uuid::new_v4()));
        let session = base.join("session");
        let root = base.join("workspace");
        let imported = session.join("fichiers-importes");
        fs::create_dir_all(imported.join(".story-studio-audio-edits")).unwrap();
        fs::create_dir_all(&root).unwrap();
        // A microphone take edited into another format, then deleted.
        let take = session.join("enregistrements/take.wav");
        let edited = imported.join("take.mp3");
        fs::write(&edited, "edited").unwrap();
        fs::write(
            imported.join(".story-studio-audio-edits/take.mp3.edit.json"),
            serde_json::json!({"original_path":take,"mode":"convert"}).to_string(),
        )
        .unwrap();
        let extraction = session.join("zips-extraits/Pack");
        fs::create_dir_all(extraction.join(".story-studio-audio-edits")).unwrap();
        fs::write(extraction.join("one.mp3"), "one").unwrap();
        fs::write(
            extraction.join(".story-studio-audio-edits/one.mp3.edit.json"),
            serde_json::json!({"original_path":extraction.join("one.original.mp3")}).to_string(),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let folder =
            super::super::resolve_project_folder(root.to_str().unwrap(), "Azuro", &id, true)
                .unwrap();
        let destination = ProjectMediaDestination {
            folder,
            work_id: id,
        };
        let copy = |source: &Path| {
            copy_project_media(
                source.to_str().unwrap(),
                root.to_str().unwrap(),
                "fichiers-importes",
                Some(&destination),
                Some(session.to_str().unwrap()),
            )
        };
        let result = copy(&edited).unwrap();
        assert!(Path::new(&result.path).ends_with("fichiers-importes/Azuro/take.mp3"));
        assert_eq!(result.copies.len(), 1);
        assert!(!root
            .join("fichiers-importes/Azuro/.story-studio-audio-edits")
            .exists());
        assert!(!root.join("enregistrements/Azuro/take.wav").exists());
        let result = copy(&extraction.join("one.mp3")).unwrap();
        assert!(Path::new(&result.path).ends_with("zips-extraits/Azuro/Pack/one.mp3"));
        assert!(root.join("zips-extraits/Azuro/Pack/one.mp3").is_file());
        assert!(!root
            .join("zips-extraits/Azuro/Pack/.story-studio-audio-edits/one.mp3.edit.json")
            .exists());
        fs::remove_dir_all(base).unwrap();
    }
}
