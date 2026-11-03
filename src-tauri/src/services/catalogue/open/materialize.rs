//! Preparation of a consultation: the graph the simulator plays and the table
//! of the media it may read, built from a revalidated exemplar.
//!
//! Each format goes through the readers the application already uses, and
//! nothing is written beside the user's files:
//!
//! - a ZIP pack is read in place (its content token is checked again at every
//!   media read);
//! - a STUdio or FS folder, a 7z and an archive child become a STUdio ZIP in
//!   the consultation's own folder, through the existing conversion (an
//!   archive child is taken out of its container by its member chain, as the
//!   analyzer located it);
//! - a graph project is read by the project codec and projected into the
//!   graph view the editor plays, its media bindings resolved by the
//!   interface's project loader (fallback on the workspace included); a menu
//!   project is projected by the generator from the project the interface
//!   normalized.
//!
//! Media are designated by opaque identifiers; their location stays here. A
//! file named by a project is only served from the project's folder, a
//! workspace the catalogue knows, or when the project file, read here, names
//! it itself (`MediaRoots`), checked again at each read: any other path
//! written by the interface never reaches anything.
use super::{declared_media, target::Target};
use crate::services::catalogue::analyze;
use crate::support::{
    archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES},
    imported_pack::{self, IMPORTED_PACK_CACHE_DIR},
    user_message::{codes, UserMessage},
};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

type Result<T> = std::result::Result<T, UserMessage>;

/// Where the files named by a project may be read from: the project's own
/// folder and the workspaces recorded by the catalogue, resolved once (links
/// followed), and the files the project file names itself, wherever
/// they are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRoots {
    roots: Arc<[PathBuf]>,
    declared: Arc<HashSet<PathBuf>>,
}

impl MediaRoots {
    /// `raw`: the project file as read by the engine itself; a path the
    /// interface sends is only compared with the files it names.
    pub fn for_project(project: &Path, workspaces: &[PathBuf], raw: &Value) -> Self {
        let roots = project
            .parent()
            .into_iter()
            .map(Path::to_owned)
            .chain(workspaces.iter().cloned())
            .filter_map(|root| std::fs::canonicalize(root).ok())
            .collect::<Vec<_>>();
        Self {
            roots: roots.into(),
            declared: Arc::new(declared_media::declared_files(raw, project)),
        }
    }

    /// The real location of `path`, an absolute path, when its target (links
    /// followed) is a file under one of the roots, or exactly a file the
    /// project names. A path with `..` is only compared, without them, with
    /// the files the project names.
    pub fn admit(&self, path: &Path) -> Option<PathBuf> {
        if !path.is_absolute() {
            return None;
        }
        if path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            let real = std::fs::canonicalize(declared_media::lexical(path)).ok()?;
            return (real.is_file() && self.declared.contains(&real)).then_some(real);
        }
        let real = std::fs::canonicalize(path).ok()?;
        (real.is_file()
            && (self.roots.iter().any(|root| real.starts_with(root))
                || self.declared.contains(&real)))
        .then_some(real)
    }
}

/// Where the bytes of one media come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Media {
    /// An asset of a STUdio ZIP: the source itself or an owned conversion
    /// (`roots: None`), or a ZIP named by a menu project (confined).
    PackAsset {
        zip: PathBuf,
        asset: String,
        roots: Option<MediaRoots>,
    },
    /// A file named by a project, confined to `roots`.
    File { path: PathBuf, roots: MediaRoots },
}

fn outside(path: &Path) -> UserMessage {
    unsupported(path, "mediaOutsideProject")
}

impl Media {
    fn extension(&self) -> String {
        let name = match self {
            Media::PackAsset { asset, .. } => Path::new(asset),
            Media::File { path, .. } => path.as_path(),
        };
        name.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    }

    /// Media type by extension, the same table as the interface's loaders.
    pub fn mime(&self) -> &'static str {
        match self.extension().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "gif" => "image/gif",
            "mp3" => "audio/mpeg",
            "ogg" => "audio/ogg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "m4a" => "audio/mp4",
            "webm" => "audio/webm",
            _ => "application/octet-stream",
        }
    }

    pub fn read(&self) -> Result<Vec<u8>> {
        match self {
            Media::PackAsset { zip, asset, roots } => {
                let zip = match roots {
                    None => zip.to_owned(),
                    Some(roots) => roots.admit(zip).ok_or_else(|| outside(zip))?,
                };
                crate::services::pack_reader::get_pack_asset(&zip.to_string_lossy(), asset)
                    .map_err(UserMessage::from)
            }
            Media::File { path, roots } => {
                // Revalidated at each read: a link or a file swapped while
                // listening cannot lead outside the roots.
                let real = roots.admit(path).ok_or_else(|| outside(path))?;
                let file =
                    std::fs::File::open(&real).map_err(|_| super::target::disappeared(path))?;
                let mut bytes = Vec::new();
                file.take(ARCHIVE_MAX_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| UserMessage::from(error.to_string()))?;
                if bytes.len() as u64 > ARCHIVE_MAX_FILE_BYTES {
                    return Err(unsupported(path, "readLimitExceeded"));
                }
                Ok(bytes)
            }
        }
    }
}

/// The prepared content of a consultation, before its publication.
#[derive(Debug)]
pub struct Prepared {
    /// `pack`: a story document (`load_pack_zip` form); `document`: the graph
    /// view of a graph project and its media by asset reference.
    pub kind: &'static str,
    pub graph: Value,
    pub media: HashMap<String, Media>,
}

pub(crate) fn unsupported(path: &Path, reason: &str) -> UserMessage {
    UserMessage::new(codes::CATALOG_SIMULATION_UNSUPPORTED)
        .param("path", crate::support::paths::path_for_frontend(path))
        .with_detail(reason.to_owned())
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(UserMessage::new(codes::CATALOG_CONSULTATION_EXPIRED))
    } else {
        Ok(())
    }
}

/// Reader reasons of the analyzer helpers become explicit refusals; coded
/// transports of the shared readers keep their own message.
fn reader_error(path: &Path) -> impl Fn(String) -> UserMessage + '_ {
    move |reason| match reason.as_str() {
        "archiveCorrupt"
        | "archiveProtected"
        | "readLimitExceeded"
        | "invalidArchivePath"
        | "archiveNameCollision"
        | "invalidPackStructure" => unsupported(path, &reason),
        _ => UserMessage::from(reason),
    }
}

/// Media identifiers of one preparation: a random prefix keeps an
/// identifier of another consultation from naming anything here.
struct MediaTable {
    prefix: String,
    by_media: HashMap<String, Media>,
    ids: Vec<(Media, String)>,
}

impl Default for MediaTable {
    fn default() -> Self {
        Self {
            prefix: uuid::Uuid::new_v4().simple().to_string()[..12].to_owned(),
            by_media: HashMap::new(),
            ids: Vec::new(),
        }
    }
}

impl MediaTable {
    fn id(&mut self, media: Media) -> String {
        if let Some((_, id)) = self.ids.iter().find(|(known, _)| *known == media) {
            return id.clone();
        }
        let id = format!("m{}-{}", self.prefix, self.ids.len() + 1);
        self.by_media.insert(id.clone(), media.clone());
        self.ids.push((media, id.clone()));
        id
    }
}

/// `toPackAssetName` of the interface: a dialect reference names an entry of
/// the archive's `assets/` folder.
fn pack_asset_name(reference: &str) -> Option<String> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.starts_with("assets/") {
        trimmed.to_owned()
    } else {
        format!("assets/{trimmed}")
    })
}

/// Replaces the media references of every Stage by opaque identifiers.
fn rewrite_stages(story: &mut Value, mut media_for: impl FnMut(&str) -> Option<String>) {
    let Some(nodes) = story.get_mut("stageNodes").and_then(Value::as_array_mut) else {
        return;
    };
    for node in nodes {
        for slot in ["audio", "image"] {
            let Some(object) = node.as_object_mut() else {
                continue;
            };
            let replaced = object
                .get(slot)
                .and_then(Value::as_str)
                .and_then(&mut media_for)
                .map(Value::String)
                .unwrap_or(Value::Null);
            if object.contains_key(slot) {
                object.insert(slot.to_owned(), replaced);
            }
        }
    }
}

/// The story of a STUdio ZIP, read exactly as the existing simulator reads it.
pub fn pack_graph(zip: &Path) -> Result<Prepared> {
    let story = crate::services::pack_reader::load_pack_zip_for_simulation(&zip.to_string_lossy())
        .map_err(UserMessage::from)?;
    let mut story: Value =
        serde_json::from_str(&story).map_err(|error| UserMessage::from(error.to_string()))?;
    let mut table = MediaTable::default();
    rewrite_stages(&mut story, |reference| {
        pack_asset_name(reference).map(|asset| {
            table.id(Media::PackAsset {
                zip: zip.to_owned(),
                asset,
                roots: None,
            })
        })
    });
    Ok(Prepared {
        kind: "pack",
        graph: story,
        media: table.by_media,
    })
}

fn segments(raw: &Value) -> Vec<(String, String)> {
    raw["chain"]
        .as_array()
        .map(|chain| {
            chain
                .iter()
                .filter_map(|segment| {
                    Some((
                        segment["kind"].as_str()?.to_owned(),
                        segment["path"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Copies one entry of a ZIP into `out`, bounded.
fn spool_zip_entry(
    source: &Path,
    name: &str,
    out: &Path,
    cancel: &AtomicBool,
) -> std::result::Result<(), String> {
    analyze::validate_member_names(std::iter::once(name))?;
    let file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "archiveCorrupt".to_owned())?;
    let entry = archive.by_name(name).map_err(|e| e.to_string())?;
    if entry.size() > ARCHIVE_MAX_FILE_BYTES {
        return Err("readLimitExceeded".into());
    }
    let mut output = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let copied = crate::support::imported_pack::cancellation::copy(
        &mut entry.take(ARCHIVE_MAX_FILE_BYTES + 1),
        &mut output,
        cancel,
    )
    .map_err(|e| e.to_string())?;
    if copied > ARCHIVE_MAX_FILE_BYTES {
        return Err("readLimitExceeded".into());
    }
    output.flush().map_err(|e| e.to_string())
}

/// Isolates the pack folder `root`, copying entries without recompression.
/// Device packs keep their leaf folder for the shared converter's identity;
/// STUdio packs expose their entries at the archive root.
fn reroot_zip(
    source: &Path,
    root: &str,
    out: &Path,
    cancel: &AtomicBool,
    preserve_directory: bool,
) -> std::result::Result<(), String> {
    analyze::validate_member_names(std::iter::once(root))?;
    let file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "archiveCorrupt".to_owned())?;
    if archive.len() > ARCHIVE_MAX_ENTRIES {
        return Err("readLimitExceeded".into());
    }
    analyze::validate_member_names(archive.file_names())?;
    let prefix = format!("{root}/");
    let mut writer = zip::ZipWriter::new(crate::support::imported_pack::cancellation::Writer {
        inner: std::fs::File::create(out).map_err(|e| e.to_string())?,
        cancel,
        stage: "zipWrite",
    });
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
        if entry.enclosed_name().is_none() {
            return Err("invalidArchivePath".into());
        }
        let Some(rest) = entry.name().strip_prefix(&prefix).map(str::to_owned) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        // FS conversion derives the entry identity from its containing folder.
        // Keep that folder while isolating it from other roots in the archive.
        let name = if preserve_directory {
            format!(
                "{}/{rest}",
                Path::new(root)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or("invalidArchivePath")?
            )
        } else {
            rest
        };
        writer
            .raw_copy_file_rename(entry, name)
            .map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// A converted ZIP is only reread with its provenance when it lies in a
/// folder named like the conversion cache (`ensure_studio_pack_source`).
fn owned_cache(owned: &Path) -> PathBuf {
    owned.join(IMPORTED_PACK_CACHE_DIR)
}

/// Copies a shared conversion and its provenance into the consultation, so
/// that the shared cache is never needed, nor removed, while listening.
fn own_conversion(zip: &Path, owned: &Path, cancel: &AtomicBool) -> Result<PathBuf> {
    let folder = owned_cache(owned);
    std::fs::create_dir_all(&folder).map_err(|error| UserMessage::from(error.to_string()))?;
    let name = zip
        .file_name()
        .map(Path::new)
        .unwrap_or(Path::new("pack.zip"));
    let target = folder.join(name);
    crate::support::imported_pack::cancellation::copy(
        &mut std::fs::File::open(zip).map_err(|e| UserMessage::from(e.to_string()))?,
        &mut std::fs::File::create(&target).map_err(|e| UserMessage::from(e.to_string()))?,
        cancel,
    )
    .map_err(|error| UserMessage::from(error.to_string()))?;
    let sidecar = zip.with_extension("context.json");
    if sidecar.is_file() {
        std::fs::copy(&sidecar, target.with_extension("context.json"))
            .map_err(|error| UserMessage::from(error.to_string()))?;
    }
    Ok(target)
}

fn from_folder(folder: &Path, owned: &Path, cancel: &AtomicBool) -> Result<PathBuf> {
    imported_pack::ensure_studio_pack_zip_from_dir_cancellable(
        &folder.to_string_lossy(),
        &owned_cache(owned),
        cancel,
    )
    .map(|pack| pack.zip_path)
    .map_err(UserMessage::from)
}

/// The STUdio ZIP of a pack exemplar (see the module notes).
pub(crate) fn pack_zip(
    target: &Target,
    owned: &Path,
    cancel: &AtomicBool,
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
) -> Result<PathBuf> {
    pack_zip_with_cache(target, owned, cancel, catalogue, false)
}

pub(crate) fn pack_zip_for_storyteller(
    target: &Target,
    owned: &Path,
    cancel: &AtomicBool,
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
) -> Result<PathBuf> {
    pack_zip_with_cache(target, owned, cancel, catalogue, true)
}

fn pack_zip_with_cache(
    target: &Target,
    owned: &Path,
    cancel: &AtomicBool,
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
    local_cache: bool,
) -> Result<PathBuf> {
    let path = pack_zip_unchecked(target, owned, cancel, local_cache)?;
    if path == target.path {
        crate::native_pack::output_identity::for_path(
            &path,
            crate::native_pack::output_identity::OutputForm::ExactCopy,
            catalogue,
        )?;
        return Ok(path);
    }
    rewritten(path, owned, cancel, catalogue)
}

/// Identity decision of a rewritten pack: `path` is an owned STUdio ZIP.
fn rewritten(
    path: PathBuf,
    owned: &Path,
    cancel: &AtomicBool,
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
) -> Result<PathBuf> {
    let identity = crate::native_pack::output_identity::for_path(
        &path,
        crate::native_pack::output_identity::OutputForm::Rewritten,
        catalogue,
    )?;
    // The selected pack has been isolated into an owned consultation workspace.
    // Rewriting here never touches its source archive or shared conversion cache.
    let output = owned.join(format!("authorized-{}.zip", uuid::Uuid::new_v4()));
    let text = crate::native_pack::output_identity::read_story_text(&path)?;
    let authorized = identity.serialize(&text).map_err(UserMessage::from)?;
    if authorized == text {
        return Ok(path);
    }
    crate::services::community_pack_checker::write_metadata_zip_authorized(
        &identity,
        &path,
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|e| {
                UserMessage::new(codes::FILES_ARCHIVE_CREATE_FAILED)
                    .param("outputZip", output.display().to_string())
                    .param("error", e.to_string())
            })?,
        Some(&authorized),
        None,
        cancel,
    )
    .map_err(UserMessage::from)?;
    Ok(output)
}

/// A STUdio folder read in place for the storyteller, and the archive holding
/// its authorized `story.json` alone.
pub(crate) struct StudioFolderStory {
    pub(crate) folder: imported_pack::StudioFolder,
    pub(crate) story_zip: PathBuf,
}

/// The storyteller's direct path for a STUdio folder exemplar: no archive of
/// its media. The story goes through the same chain as its conversion would
/// (`story.json` authorized as archived, then `rewritten`), from an owned
/// archive that holds that member only. `None`: any other format, or a folder
/// whose pack the conversion alone can read (see `StudioFolder::open`).
pub(crate) fn studio_folder_for_storyteller(
    target: &Target,
    owned: &Path,
    cancel: &AtomicBool,
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
) -> Result<Option<StudioFolderStory>> {
    let observed = target
        .observation
        .as_ref()
        .expect("revalidated observation");
    if observed.format != "studioDirectory" {
        return Ok(None);
    }
    let Some(folder) =
        imported_pack::StudioFolder::open(&target.path, cancel).map_err(UserMessage::from)?
    else {
        return Ok(None);
    };
    let archive = owned.join(format!("story-{}.zip", uuid::Uuid::new_v4()));
    let create_failed = |e: &dyn std::fmt::Display| {
        UserMessage::new(codes::FILES_ARCHIVE_CREATE_FAILED)
            .param("outputZip", archive.display().to_string())
            .param("error", e.to_string())
    };
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&archive)
        .map_err(|e| create_failed(&e))?;
    let mut writer = zip::ZipWriter::new(file);
    writer
        .start_file(
            "story.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .map_err(|e| create_failed(&e))?;
    writer
        .write_all(folder.story().as_bytes())
        .map_err(|e| create_failed(&e))?;
    writer.finish().map_err(|e| create_failed(&e))?;
    let story_zip = rewritten(archive, owned, cancel, catalogue)?;
    Ok(Some(StudioFolderStory { folder, story_zip }))
}

fn converted_zip(
    path: &Path,
    owned: &Path,
    cancel: &AtomicBool,
    local_cache: bool,
) -> Result<PathBuf> {
    if local_cache {
        imported_pack::ensure_studio_pack_zip_in_cancellable(
            &path.to_string_lossy(),
            &owned_cache(owned),
            cancel,
        )
        .map(|pack| pack.zip_path)
        .map_err(UserMessage::from)
    } else {
        let pack =
            imported_pack::ensure_studio_pack_zip_cancellable(&path.to_string_lossy(), cancel)
                .map_err(UserMessage::from)?;
        own_conversion(&pack.zip_path, owned, cancel)
    }
}

fn pack_zip_unchecked(
    target: &Target,
    owned: &Path,
    cancel: &AtomicBool,
    local_cache: bool,
) -> Result<PathBuf> {
    let observed = target
        .observation
        .as_ref()
        .expect("revalidated observation");
    let path = target.path.as_path();
    let chain = segments(&observed.raw);
    let fail = reader_error(path);
    match (observed.format.as_str(), chain.is_empty()) {
        ("zip", true) => Ok(path.to_owned()),
        ("studioDirectory" | "fsDirectory", _) => from_folder(path, owned, cancel),
        ("7z" | "fsZip", true) => converted_zip(path, owned, cancel, local_cache),
        ("zip" | "7z" | "fsZip", false) => {
            let mut current = path.to_owned();
            let mut rest = chain.as_slice();
            if observed.format == "7z" {
                let ((kind, name), tail) = chain.split_first().expect("non-empty chain");
                if kind == "pack-root" {
                    let tree = owned.join("tree");
                    std::fs::create_dir_all(&tree)
                        .map_err(|error| UserMessage::from(error.to_string()))?;
                    analyze::extract_7z_folder(path, name, &tree, cancel).map_err(&fail)?;
                    cancelled(cancel)?;
                    return from_folder(&tree.join(name), owned, cancel);
                }
                let out = owned.join("member-0.zip");
                let file = std::fs::File::create(&out)
                    .map_err(|error| UserMessage::from(error.to_string()))?;
                analyze::spool_7z_member(path, name, file, cancel).map_err(&fail)?;
                current = out;
                rest = tail;
            }
            for (index, (kind, name)) in rest.iter().enumerate() {
                cancelled(cancel)?;
                let out = owned.join(format!("member-{}.zip", index + 1));
                match kind.as_str() {
                    "archive-entry" => {
                        spool_zip_entry(&current, name, &out, cancel).map_err(&fail)?
                    }
                    "pack-root" => {
                        reroot_zip(&current, name, &out, cancel, observed.format == "fsZip")
                            .map_err(&fail)?
                    }
                    _ => return Err(unsupported(path, "unknownMember")),
                }
                current = out;
            }
            if observed.format == "fsZip" {
                converted_zip(&current, owned, cancel, local_cache)
            } else {
                Ok(current)
            }
        }
        _ => Err(unsupported(path, "formatUnsupported")),
    }
}

fn project_raw(path: &Path) -> Result<Value> {
    let file = std::fs::File::open(path).map_err(|_| super::target::disappeared(path))?;
    let raw = analyze::json(file).map_err(reader_error(path))?;
    if !raw.is_object() {
        return Err(unsupported(path, "invalidProjectEnvelope"));
    }
    Ok(raw)
}

/// The graph view of a graph project and its media bindings. `loaded` holds
/// the bindings as the interface's project loader resolved them (relative
/// paths, then the workspace fallback of older projects); without it, only
/// the project-relative resolution applies.
fn document_graph(
    path: &Path,
    raw: &Value,
    loaded: Option<&Value>,
    roots: &MediaRoots,
) -> Result<Prepared> {
    let payload = raw
        .pointer("/authoring/payload")
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported(path, "invalidProjectPayload"))?;
    let view = crate::native_pack::graph_view::read_advanced_graph_view(payload)
        .map_err(|error| unsupported(path, &error.to_string()))?;
    let folder = path.parent().unwrap_or(Path::new("."));
    let mut table = MediaTable::default();
    let mut by_reference = Map::new();
    for binding in loaded
        .unwrap_or(raw)
        .pointer("/authoring/mediaBindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(reference) = binding["assetRef"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        // The last binding of a reference wins, as in `mediaBindingsByAssetRef`.
        let media = binding["path"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .and_then(|value| confined_file(declared_media::project_path(value, folder), roots))
            .map(|media| Value::String(table.id(media)))
            .unwrap_or(Value::Null);
        by_reference.insert(reference.to_owned(), media);
    }
    Ok(Prepared {
        kind: "document",
        graph: json!({"view": view, "media": by_reference}),
        media: table.by_media,
    })
}

/// A file named by a project, or `None` (played as a missing media) when it
/// lies outside the roots.
fn confined_file(path: PathBuf, roots: &MediaRoots) -> Option<Media> {
    if roots.admit(&path).is_none() {
        log::warn!(target: "catalogue_consultation", "media outside the project refused");
        return None;
    }
    Some(Media::File {
        path,
        roots: roots.clone(),
    })
}

/// The generator's projection of a menu project, as normalized by the
/// interface's read-only project loader.
fn projected_graph(project_json: &str, roots: &MediaRoots) -> Result<Prepared> {
    let project =
        crate::commands::generation::parse_project_json(project_json).map_err(UserMessage::from)?;
    let projection = crate::native_pack::simulation::project_story_for_simulation(&project)
        .map_err(UserMessage::from)?;
    let mut story = serde_json::to_value(&projection.story)
        .map_err(|error| UserMessage::from(error.to_string()))?;
    let mut by_name = HashMap::new();
    for entry in &projection.media {
        let media = match (
            entry.kind,
            &entry.path,
            &entry.zip_path,
            &entry.zip_asset_name,
        ) {
            ("disk", Some(file), _, _) => match confined_file(PathBuf::from(file), roots) {
                Some(media) => media,
                None => continue,
            },
            ("pack", _, Some(zip), Some(asset)) => {
                let zip = PathBuf::from(zip);
                if roots.admit(&zip).is_none() {
                    log::warn!(target: "catalogue_consultation", "pack outside the project refused");
                    continue;
                }
                Media::PackAsset {
                    zip,
                    asset: asset.clone(),
                    roots: Some(roots.clone()),
                }
            }
            _ => continue,
        };
        by_name.insert(entry.asset_name.clone(), media);
    }
    let mut table = MediaTable::default();
    rewrite_stages(&mut story, |name| {
        if name == crate::native_pack::simulation::SIMULATION_MISSING_ASSET {
            return None;
        }
        by_name.get(name).cloned().map(|media| table.id(media))
    });
    Ok(Prepared {
        kind: "pack",
        graph: story,
        media: table.by_media,
    })
}

/// Prepares the consultation of a revalidated exemplar into `owned`.
/// `workspaces`: the workspaces recorded by the catalogue, the only folders
/// besides the project's own that its media may come from.
pub fn prepare(
    catalogue: Option<&dyn crate::services::official_packs::OfficialCatalogue<Error = UserMessage>>,
    target: &Target,
    project_json: Option<&str>,
    workspaces: &[PathBuf],
    owned: &Path,
    cancel: &AtomicBool,
) -> Result<Prepared> {
    let observed = target
        .observation
        .as_ref()
        .ok_or_else(|| super::target::changed(&target.display_path()))?;
    if observed.state != "available" {
        return Err(unsupported(&target.path, &observed.state));
    }
    cancelled(cancel)?;
    if observed.format == "project" {
        let raw = project_raw(&target.path)?;
        let roots = MediaRoots::for_project(&target.path, workspaces, &raw);
        let advanced = raw.get("authoringMode").and_then(Value::as_str) == Some("advanced");
        return if advanced {
            let loaded = project_json
                .map(serde_json::from_str::<Value>)
                .transpose()
                .map_err(|_| unsupported(&target.path, "projectNotNormalized"))?;
            document_graph(&target.path, &raw, loaded.as_ref(), &roots)
        } else {
            match project_json {
                Some(project) => projected_graph(project, &roots),
                None => Err(unsupported(&target.path, "projectNotNormalized")),
            }
        };
    }
    let zip = pack_zip(target, owned, cancel, catalogue)?;
    cancelled(cancel)?;
    pack_graph(&zip)
}
