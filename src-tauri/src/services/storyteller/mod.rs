//! Plain device-format staging, implemented from the storyteller specification.
//! No device access, encryption, bt or playlist writes belong to this service.
pub(crate) mod cipher;
mod indexes;
mod media;
pub(crate) mod repatriate;
pub(crate) mod send;
#[cfg(test)]
mod studio_folder_tests;
#[cfg(test)]
mod tests;

use crate::native_pack::{
    output_identity::{authorize_storyteller_path, StorytellerAuthorization},
    persistence::AdvancedMediaBinding,
};
use crate::services::{
    catalogue::open::{materialize, target::Target},
    official_packs::OfficialCatalogue,
};
use crate::support::user_message::{codes, UserMessage};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

type Result<T> = std::result::Result<T, UserMessage>;

/// A step the engine really enters while it prepares a pack, reported once
/// when it starts: only when at least one medium is re-encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrepStep {
    ConvertingSounds,
    ConvertingImages,
}

#[derive(Debug)]
pub(crate) struct PlainStory {
    pub(crate) path: PathBuf,
    /// Sum of actual file lengths, including short-index padding. Filesystem
    /// allocation units and transport encryption overhead are the driver's concern.
    pub(crate) total_bytes: u64,
    pub(crate) uuid: uuid::Uuid,
}

pub(super) fn failure(reason: impl std::fmt::Display) -> UserMessage {
    UserMessage::new(codes::STORYTELLER_WRITE_FAILED).with_detail(reason.to_string())
}
pub(super) fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(UserMessage::new(codes::GENERATION_CANCELLED))
    } else {
        Ok(())
    }
}

/// Owned scratch directory. Created exclusively; never removes a caller's path.
pub(super) struct Scratch(pub(super) PathBuf);
impl Scratch {
    pub(super) fn new(parent: &Path) -> Result<Self> {
        let path = parent.join(format!(".story-studio-conteuse-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(failure)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Catalogue entry point: reuse its materialization chain for every supported
/// pack format (including archive children). The caller resolves the exemplar
/// and revision through Store::resolve_target; projects are not exported here.
pub(crate) fn write_catalogue_pack(
    app: &tauri::AppHandle,
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    output: &Path,
    cancel: &AtomicBool,
    on_step: &mut dyn FnMut(PrepStep),
) -> Result<PlainStory> {
    let cache =
        crate::support::temp::app_cache_subdir(app, "storyteller").map_err(UserMessage::from)?;
    write_catalogue_pack_observed(
        target,
        catalogue,
        output,
        &cache,
        cancel,
        Route::Direct,
        on_step,
    )
}

fn write_catalogue_pack_in(
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
) -> Result<PlainStory> {
    write_catalogue_pack_with(target, catalogue, output, cache, cancel, Route::Direct)
}

/// `Direct` reads a STUdio folder in place (`studio_folder_for_storyteller`);
/// every other exemplar, and `Converted`, take the converted archive.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    Direct,
    #[cfg(test)]
    Converted,
    /// Test only: `Direct`, but a folder the direct path declines is a failure
    /// instead of a silent fallback to the conversion.
    #[cfg(test)]
    DirectRequired,
}

fn write_catalogue_pack_with(
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
    route: Route,
) -> Result<PlainStory> {
    write_catalogue_pack_observed(target, catalogue, output, cache, cancel, route, &mut |_| {})
}

fn write_catalogue_pack_observed(
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
    route: Route,
    on_step: &mut dyn FnMut(PrepStep),
) -> Result<PlainStory> {
    target.require_unchanged(std::time::Duration::from_secs(5))?;
    fs::create_dir_all(cache).map_err(failure)?;
    let scratch = Scratch::new(cache)?;
    let direct = match route {
        Route::Direct => {
            materialize::studio_folder_for_storyteller(target, &scratch.0, cancel, catalogue)?
        }
        #[cfg(test)]
        Route::Converted => None,
        #[cfg(test)]
        Route::DirectRequired => Some(
            materialize::studio_folder_for_storyteller(target, &scratch.0, cancel, catalogue)?
                .expect("the direct route must read this folder in place"),
        ),
    };
    let (authorized, bindings) = match direct {
        Some(direct) => read_studio_folder(direct, catalogue, &scratch.0, cancel)?,
        None => read_converted(target, catalogue, &scratch.0, cancel)?,
    };
    target.require_unchanged(std::time::Duration::from_secs(5))?;
    write_plain_story_observed(&authorized, &bindings, output, cache, cancel, on_step)
}

/// Archive member of a story reference, as the converted archive names it.
fn asset_name(asset_ref: &str) -> String {
    if asset_ref.starts_with("assets/") {
        asset_ref.to_owned()
    } else {
        format!("assets/{asset_ref}")
    }
}

fn resolved(asset_ref: String, path: &Path) -> AdvancedMediaBinding {
    AdvancedMediaBinding {
        asset_ref,
        path: Some(path.to_string_lossy().into_owned()),
        status: crate::native_pack::persistence::MediaBindingStatus::Resolved,
    }
}

#[cfg(test)]
thread_local! {
    /// Test only: runs between the last copy and `verify_unchanged`, to change
    /// the source folder at the moment the guard exists for.
    static BEFORE_VERIFY: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Same decision and same media files as `read_converted` for this folder:
/// the story is authorized from its archived text, each media is copied from
/// the member the archive would hold, then the folder is checked unchanged.
fn read_studio_folder(
    direct: materialize::StudioFolderStory,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    scratch: &Path,
    cancel: &AtomicBool,
) -> Result<(StorytellerAuthorization, Vec<AdvancedMediaBinding>)> {
    let materialize::StudioFolderStory {
        mut folder,
        story_zip,
    } = direct;
    let authorized = authorize_storyteller_path(&story_zip, catalogue)?;
    let mut bindings = Vec::new();
    let references = crate::native_pack::persistence::referenced_asset_refs(authorized.document());
    for (rank, asset_ref) in references.into_iter().enumerate() {
        check(cancel)?;
        let path = scratch.join(format!("media-{rank}"));
        let name = crate::services::pack_reader::validate_pack_asset_name(&asset_name(&asset_ref))
            .map_err(UserMessage::from)?;
        folder
            .copy_asset(&name, &path, cancel)
            .map_err(UserMessage::from)?;
        bindings.push(resolved(asset_ref, &path));
    }
    check(cancel)?;
    #[cfg(test)]
    BEFORE_VERIFY.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
    folder.verify_unchanged(cancel).map_err(UserMessage::from)?;
    Ok((authorized, bindings))
}

fn read_converted(
    target: &Target,
    catalogue: Option<&dyn OfficialCatalogue<Error = UserMessage>>,
    scratch: &Path,
    cancel: &AtomicBool,
) -> Result<(StorytellerAuthorization, Vec<AdvancedMediaBinding>)> {
    let zip = materialize::pack_zip_for_storyteller(target, scratch, cancel, catalogue)?;
    let authorized = authorize_storyteller_path(&zip, catalogue)?;
    let mut bindings = Vec::new();
    let references = crate::native_pack::persistence::referenced_asset_refs(authorized.document());
    for (rank, asset_ref) in references.into_iter().enumerate() {
        check(cancel)?;
        let path = scratch.join(format!("media-{rank}"));
        let asset_name = asset_name(&asset_ref);
        let bytes =
            crate::services::pack_reader::get_pack_asset(&zip.to_string_lossy(), &asset_name)
                .map_err(UserMessage::from)?;
        fs::write(&path, bytes).map_err(failure)?;
        bindings.push(resolved(asset_ref, &path));
    }
    Ok((authorized, bindings))
}

/// Only the identity decision can construct `authorized`. Its document is
/// immutable and stored inside the capability, so it cannot authorize another.
/// `output` is an existing local directory; final name is the UUID suffix.
pub(crate) fn write_plain_story(
    authorized: &StorytellerAuthorization,
    bindings: &[AdvancedMediaBinding],
    output: &Path,
    cache_root: &Path,
    cancel: &AtomicBool,
) -> Result<PlainStory> {
    write_plain_story_observed(
        authorized,
        bindings,
        output,
        cache_root,
        cancel,
        &mut |_| {},
    )
}

/// Same output as `write_plain_story`; `on_step` is told when re-encoding starts.
pub(crate) fn write_plain_story_observed(
    authorized: &StorytellerAuthorization,
    bindings: &[AdvancedMediaBinding],
    output: &Path,
    cache_root: &Path,
    cancel: &AtomicBool,
    on_step: &mut dyn FnMut(PrepStep),
) -> Result<PlainStory> {
    check(cancel)?;
    let document = authorized.document();
    validate_navigation(document)?;
    if let Err(mut errors) = crate::native_pack::validate_graph_document_integrity(document) {
        // Device export accepts the dialect's null return-to-entry option;
        // the authoring graph validator intentionally refuses those holes.
        errors.retain(|e| e.code != crate::native_pack::GraphIntegrityCode::OptionTargetNull);
        if !errors.is_empty() {
            return Err(failure(format!("{errors:?}")));
        }
    }
    if document
        .stage_nodes
        .iter()
        .find(|s| s.is_square_one())
        .is_some_and(|s| s.image.value().is_none_or(|r| r.trim().is_empty()))
    {
        return Err(UserMessage::new(codes::STORYTELLER_ENTRY_IMAGE_REQUIRED));
    }
    if !output.is_absolute() {
        return Err(failure("output directory must be absolute"));
    }
    let output = output.canonicalize().map_err(failure)?;
    let destination = output.join(story_folder(authorized.uuid()));
    if destination.symlink_metadata().is_ok() {
        return Err(failure("story directory already exists"));
    }
    if !cache_root.is_absolute() {
        return Err(failure("cache directory must be absolute"));
    }
    fs::create_dir_all(cache_root).map_err(failure)?;
    let cache_root = cache_root.canonicalize().map_err(failure)?;
    if cache_root.starts_with(&output) {
        return Err(failure("cache must be outside the output"));
    }
    let conversions = Scratch::new(&cache_root)?;
    let layout = indexes::encode(document)?;
    let assets = media::prepare(document, bindings, &conversions.0, cancel, on_step)?;
    let scratch = Scratch::new(&output)?;
    let story = scratch.0.join("story");
    fs::create_dir(&story).map_err(failure)?;
    let mut total = 0;
    // Specification §5.1: ni, li, nm; images, ri; sounds, si.
    write_file(&story.join("ni"), &layout.ni, cancel, &mut total)?;
    write_file(&story.join("li"), &layout.li, cancel, &mut total)?;
    if document.night_mode_available.value() == Some(&true) {
        write_file(&story.join("nm"), &[], cancel, &mut total)?;
    }
    for (folder, records) in [("rf", &layout.images), ("sf", &layout.sounds)] {
        fs::create_dir_all(story.join(folder).join("000")).map_err(failure)?;
        for (index, reference) in records.iter().enumerate() {
            check(cancel)?;
            let path = assets
                .get(reference)
                .ok_or_else(|| failure("missing prepared media"))?;
            let mut bytes = fs::read(path).map_err(failure)?;
            indexes::pad(&mut bytes);
            write_file(
                &story.join(folder).join("000").join(format!("{index:08X}")),
                &bytes,
                cancel,
                &mut total,
            )?;
        }
        write_file(
            &story.join(if folder == "rf" { "ri" } else { "si" }),
            &indexes::media_index(records.len())?,
            cancel,
            &mut total,
        )?;
    }
    check(cancel)?;
    crate::services::catalogue::files::publish::no_replace(&story, &destination)?;
    Ok(PlainStory {
        path: destination,
        total_bytes: total,
        uuid: authorized.uuid(),
    })
}

/// Device directory: the last four UUID bytes, uppercase hexadecimal.
pub(crate) fn story_folder(id: uuid::Uuid) -> String {
    format!("{:08X}", id.as_u128() as u32)
}

pub(super) fn validate_navigation(document: &crate::native_pack::StoryDocument) -> Result<()> {
    use crate::native_pack::{port_violations, PortViolation};
    let violations: Vec<_> = port_violations(document)
        .into_iter()
        .filter(|v| !matches!(v, PortViolation::HomeLoopsToSelf { .. }))
        .map(|v| v.code())
        .collect();
    if violations.is_empty() {
        Ok(())
    } else {
        Err(UserMessage::new(codes::STORYTELLER_NAVIGATION_REFUSED)
            .param("violations", serde_json::json!(violations)))
    }
}

fn write_file(path: &Path, bytes: &[u8], cancel: &AtomicBool, total: &mut u64) -> Result<()> {
    check(cancel)?;
    let mut file = fs::File::create_new(path).map_err(failure)?;
    file.write_all(bytes).map_err(failure)?;
    file.sync_all().map_err(failure)?;
    *total = total
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| failure("output size overflow"))?;
    #[cfg(test)]
    tests::after_write(path, cancel);
    Ok(())
}
