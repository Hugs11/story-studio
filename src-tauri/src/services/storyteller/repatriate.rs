//! Read-only device acquisition. Only app-owned scratch and catalogue files
//! are written; the existing FS reader and classifier interpret the graph.
use super::{cipher::DeviceCipher, failure, Result, Scratch};
use crate::{
    services::{
        catalogue::{
            scan::{Operation, Sink},
            store::Store,
        },
        storyteller_device::{self as driver, Device},
    },
    support::user_message::{codes, UserMessage},
};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use uuid::Uuid;
// Closed vocabulary: diagnostics identify a check, never input data. In
// particular, do not attach underlying I/O/conversion errors or asset names.
const DIAGNOSTICS: &[&str] = &[
    "read-node-index",
    "node-layout",
    "node-media-reference",
    "node-transition",
    "read-story-key",
    "read-index-li",
    "read-index-ri",
    "read-index-si",
    "decrypt-index-li",
    "decrypt-index-ri",
    "decrypt-index-si",
    "link-target",
    "media-record",
    "read-image",
    "read-sound",
    "media-total-limit",
    "decrypt-image",
    "decrypt-sound",
    "image-signature",
    "image-size",
    "image-padding",
    "image-validation",
    "sound-signature",
    "night-mode-marker",
    "convert-fs-pack",
    "inventory-story-missing",
    "inventory-incomplete",
];

fn diagnostic(mut error: UserMessage, step: &'static str) -> UserMessage {
    debug_assert!(DIAGNOSTICS.contains(&step));
    if matches!(
        error.code.as_str(),
        codes::STORYTELLER_STORY_INCOMPLETE | codes::STORYTELLER_STORY_UNREADABLE
    ) && error.detail.is_none()
    {
        error.detail = Some(format!("repatriation: {step}"));
    }
    error
}

fn safe_repatriation_reason(error: UserMessage) -> UserMessage {
    let detail = error
        .detail
        .as_deref()
        .filter(|detail| {
            !detail.is_empty()
                && detail.lines().count() <= 2
                && detail.lines().all(safe_diagnostic_line)
                && matches!(
                    error.code.as_str(),
                    codes::STORYTELLER_STORY_INCOMPLETE | codes::STORYTELLER_STORY_UNREADABLE
                )
        })
        .map(str::to_owned);
    let mut safe = super::send::safe_reason(error);
    safe.detail = detail;
    safe
}

fn safe_diagnostic_line(line: &str) -> bool {
    line.strip_prefix("repatriation: ")
        .is_some_and(|step| DIAGNOSTICS.contains(&step))
}

fn incomplete() -> UserMessage {
    UserMessage::new(codes::STORYTELLER_STORY_INCOMPLETE)
}
fn unreadable() -> UserMessage {
    UserMessage::new(codes::STORYTELLER_STORY_UNREADABLE)
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(UserMessage::new(codes::STORYTELLER_SEND_CANCELLED))
    } else {
        Ok(())
    }
}
/// Every component is checked before opening, including FAT reparse points.
fn read(root: &Path, relative: &Path, limit: u64, cancel: &AtomicBool) -> Result<Vec<u8>> {
    check(cancel)?;
    let mut path = root.to_owned();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(incomplete());
        }
        path.push(component);
        let meta = fs::symlink_metadata(&path).map_err(|_| incomplete())?;
        if meta.file_type().is_symlink()
            || driver::platform::is_reparse(&meta)
            || (!meta.is_dir() && !meta.is_file())
        {
            return Err(incomplete());
        }
    }
    let meta = fs::metadata(&path).map_err(|_| incomplete())?;
    if !meta.is_file() || meta.len() > limit {
        return Err(incomplete());
    }
    let mut input = fs::File::open(path).map_err(|_| incomplete())?;
    let mut bytes = Vec::new();
    let mut chunk = [0; 65536];
    loop {
        check(cancel)?;
        let count = input.read(&mut chunk).map_err(|_| incomplete())?;
        if count == 0 {
            break;
        }
        if bytes.len() as u64 + count as u64 > limit {
            return Err(incomplete());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(bytes)
}
fn int(bytes: &[u8], offset: usize) -> Result<i32> {
    Ok(i32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(incomplete)?
            .try_into()
            .map_err(|_| incomplete())?,
    ))
}
struct Layout {
    ni: Vec<u8>,
    images: usize,
    sounds: usize,
    links: usize,
    stages: usize,
    stride: usize,
}
fn layout(ni: Vec<u8>) -> Result<Layout> {
    let stages = usize::try_from(int(&ni, 12)?).map_err(|_| incomplete())?;
    let stride = usize::try_from(int(&ni, 8)?).map_err(|_| incomplete())?;
    if int(&ni, 4)? != 512
        || !(44..=1024).contains(&stride)
        || !(1..=100_000).contains(&stages)
        || ni.len() != 512 + stride * stages
    {
        return Err(incomplete());
    }
    let mut counts = [
        usize::try_from(int(&ni, 16)?).map_err(|_| incomplete())?,
        usize::try_from(int(&ni, 20)?).map_err(|_| incomplete())?,
    ];
    let mut links = 0;
    for node in ni[512..].chunks_exact(stride) {
        for (slot, count) in counts.iter_mut().enumerate() {
            let index = int(node, slot * 4)?;
            if !(-1..100_000).contains(&index) {
                return Err(diagnostic(incomplete(), "node-media-reference"));
            }
            *count = (*count).max((index + 1) as usize);
        }
        for offset in [8, 20] {
            let start = int(node, offset)?;
            if start == -1 {
                continue;
            }
            let count = int(node, offset + 4)?;
            let selected = int(node, offset + 8)?;
            if start < 0 || count <= 0 || selected < -1 || selected >= count {
                return Err(diagnostic(incomplete(), "node-transition"));
            }
            links = links.max(start as usize + count as usize);
        }
    }
    if counts.iter().any(|v| *v > 100_000) || links > 1_000_000 {
        return Err(incomplete());
    }
    Ok(Layout {
        ni,
        images: counts[0],
        sounds: counts[1],
        links,
        stages,
        stride,
    })
}
fn index(
    cipher: &DeviceCipher,
    root: &Path,
    story: &Path,
    name: &str,
    len: usize,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    let (read_step, decrypt_step) = match name {
        "li" => ("read-index-li", "decrypt-index-li"),
        "ri" => ("read-index-ri", "decrypt-index-ri"),
        "si" => ("read-index-si", "decrypt-index-si"),
        _ => unreachable!("known device index"),
    };
    let bytes = read(root, &story.join(name), 12_000_016, cancel)
        .map_err(|error| diagnostic(error, read_step))?;
    cipher
        .decrypt(&bytes, Some(len))
        .map_err(|_| diagnostic(unreadable(), decrypt_step))
}
/// Validate indexes required for reconstruction; preserve decrypted media verbatim.
/// Media decoding/repair belongs to opening or sending the recovered pack.
fn decode(
    root: &Path,
    story: &Path,
    clear: &Path,
    layout: &Layout,
    cipher: &DeviceCipher,
    cancel: &AtomicBool,
    notify: &mut impl FnMut(u8),
) -> Result<()> {
    let li = index(cipher, root, story, "li", layout.links * 4, cancel)?;
    for node in layout.ni[512..].chunks_exact(layout.stride) {
        for offset in [8, 20] {
            let start = int(node, offset)?;
            if start == -1 {
                continue;
            }
            for i in start as usize..start as usize + int(node, offset + 4)? as usize {
                let target = int(&li, i * 4)?;
                if target < 0 || target as usize >= layout.stages {
                    return Err(diagnostic(incomplete(), "link-target"));
                }
            }
        }
    }
    fs::write(clear.join("li"), li).map_err(failure)?;
    let mut processed = 0;
    let mut total_bytes = 0u64;
    for (name, folder, count) in [("ri", "rf", layout.images), ("si", "sf", layout.sounds)] {
        let records = index(cipher, root, story, name, count * 12, cancel)?;
        fs::write(clear.join(name), &records).map_err(failure)?;
        fs::create_dir_all(clear.join(folder)).map_err(failure)?;
        for record in records.chunks_exact(12) {
            if record[3] != b'\\'
                || !record[..3]
                    .iter()
                    .chain(&record[4..])
                    .all(u8::is_ascii_hexdigit)
            {
                return Err(diagnostic(unreadable(), "media-record"));
            }
            let relative = PathBuf::from(folder)
                .join(std::str::from_utf8(&record[..3]).map_err(|_| unreadable())?)
                .join(std::str::from_utf8(&record[4..]).map_err(|_| unreadable())?);
            let encrypted =
                read(root, &story.join(&relative), 128 * 1024 * 1024, cancel).map_err(|error| {
                    diagnostic(
                        error,
                        if folder == "rf" {
                            "read-image"
                        } else {
                            "read-sound"
                        },
                    )
                })?;
            total_bytes += encrypted.len() as u64;
            if total_bytes > 4 * 1024 * 1024 * 1024 {
                return Err(diagnostic(incomplete(), "media-total-limit"));
            }
            let media = cipher.decrypt(&encrypted, None).map_err(|_| {
                diagnostic(
                    unreadable(),
                    if folder == "rf" {
                        "decrypt-image"
                    } else {
                        "decrypt-sound"
                    },
                )
            })?;
            let target = clear.join(relative);
            fs::create_dir_all(target.parent().ok_or_else(incomplete)?).map_err(failure)?;
            fs::write(target, media).map_err(failure)?;
            processed += 1;
            notify((10 + processed * 65 / (layout.images + layout.sounds).max(1)) as u8);
        }
    }
    Ok(())
}
pub(crate) fn reconstruct(
    root: &Path,
    story: &Path,
    id: Uuid,
    parent: &Path,
    card: Option<&driver::cards::Card>,
    cancel: &AtomicBool,
    mut notify: impl FnMut(u8),
) -> Result<PathBuf> {
    let ni = read(root, &story.join("ni"), 103_000_512, cancel)
        .map_err(|error| diagnostic(error, "read-node-index"))?;
    let layout = layout(ni).map_err(|error| diagnostic(error, "node-layout"))?;
    let bt = read(root, &story.join("bt"), 32, cancel)
        .map_err(|error| diagnostic(error, "read-story-key"))?;
    let candidates = DeviceCipher::candidates(root, &bt)
        .map_err(|error| diagnostic(UserMessage::from(error), "read-story-key"))?;
    let clear = parent.join(id.to_string());
    let mut last = unreadable();
    let mut diagnostics = Vec::new();
    let mut success = false;
    for (attempt, cipher) in candidates.into_iter().enumerate() {
        check(cancel)?;
        if clear.exists() {
            fs::remove_dir_all(&clear).map_err(failure)?;
        }
        fs::create_dir(&clear).map_err(failure)?;
        match decode(root, story, &clear, &layout, &cipher, cancel, &mut notify) {
            Ok(()) => {
                success = true;
                break;
            }
            Err(error) => {
                if let Some(detail) = safe_repatriation_reason(error.clone()).detail {
                    log::warn!(target: "lunii_repatriate", "candidate {}: {}", attempt + 1, detail);
                    diagnostics.push(detail);
                }
                last = error;
            }
        }
    }
    if !success {
        if !diagnostics.is_empty() {
            // Retain the selected recipe's failure: the fallback can fail much
            // earlier (e.g. random link targets) and otherwise mask the cause.
            last.detail = Some(diagnostics.join("\n"));
        }
        return Err(last);
    }
    fs::write(clear.join("ni"), layout.ni).map_err(failure)?;
    if root.join(story).join("nm").try_exists().map_err(failure)? {
        read(root, &story.join("nm"), 0, cancel)
            .map_err(|error| diagnostic(error, "night-mode-marker"))?;
        fs::write(clear.join("nm"), []).map_err(failure)?;
    }
    check(cancel)?;
    let output = parent.join("repatriated.zip");
    let first_image = int(&fs::read(clear.join("ni")).map_err(failure)?, 512)?;
    let fallback_cover = if first_image >= 0 {
        let ri = fs::read(clear.join("ri")).map_err(failure)?;
        let record = &ri[first_image as usize * 12..first_image as usize * 12 + 12];
        let path = clear
            .join("rf")
            .join(std::str::from_utf8(&record[..3]).map_err(|_| unreadable())?)
            .join(std::str::from_utf8(&record[4..]).map_err(|_| unreadable())?);
        driver::cards::reduced_cover(&fs::read(path).map_err(failure)?).ok()
    } else {
        None
    };
    crate::support::fs_pack_reader::read_repatriated_fs_pack_to_studio_zip(
        &clear,
        &output,
        card.map(|c| c.title.as_str())
            .unwrap_or("Histoire sans titre"),
        card.and_then(|c| c.cover_png.as_deref())
            .or(fallback_cover.as_deref()),
        cancel,
    )
    .map_err(|_| diagnostic(incomplete(), "convert-fs-pack"))?;
    notify(85);
    check(cancel)?;
    classify(&output, cancel)?;
    Ok(output)
}
fn classify(output: &Path, cancel: &AtomicBool) -> Result<()> {
    check(cancel)?;
    let verdict =
        crate::services::pack_reader::classify_pack_editability(&output.to_string_lossy())
            .map_err(|error| refused(UserMessage::from(error)))?;
    if !verdict.authoring_editable && !verdict.read_only_inspectable {
        return Err(refused(UserMessage::new(
            verdict
                .reason_code
                .unwrap_or(codes::STORYTELLER_STORY_INCOMPLETE),
        )));
    }
    check(cancel)?;
    Ok(())
}
fn refused(cause: UserMessage) -> UserMessage {
    // Classifier codes are translatable; never include its paths/labels/details.
    super::send::safe_reason(
        UserMessage::new(codes::STORYTELLER_REPATRIATE_REFUSED).param(
            "cause",
            serde_json::json!({"code":cause.code,"params":cause.params}),
        ),
    )
}
pub(crate) fn acquire(
    store: &Store,
    device: &Device,
    id: Uuid,
    cache: &Path,
    cancel: &AtomicBool,
    notify: impl FnMut(u8),
) -> Result<PathBuf> {
    check(cancel)?;
    let inventory = driver::inspect(&device.root, &driver::NativeVolumes, Some(store))
        .map_err(UserMessage::from)?;
    let story = inventory
        .stories
        .iter()
        .find(|s| s.uuid == Some(id))
        .ok_or_else(|| diagnostic(incomplete(), "inventory-story-missing"))?;
    if story.official != crate::domain::official_provenance::OfficialProvenance::NotOfficial {
        return Err(driver::Error::OfficialStory.into());
    }
    if store.device_card_link(id)?.is_some() {
        return Err(UserMessage::new(codes::STORYTELLER_ALREADY_IN_CATALOGUE));
    }
    if !story.complete {
        return Err(diagnostic(incomplete(), "inventory-incomplete"));
    }
    let path = driver::story_path(&device.root, id);
    let relative = path.strip_prefix(&device.root).map_err(failure)?;
    reconstruct(
        &device.root,
        relative,
        id,
        cache,
        device.repatriation_card(id).as_ref(),
        cancel,
        notify,
    )
}
pub(crate) fn run(
    store: Arc<Store>,
    device: Device,
    id: Uuid,
    cache: PathBuf,
    destination: (PathBuf, String),
    op: Arc<Operation>,
    sink: Sink,
) {
    op.emit(&sink, false);
    let result = (|| {
        let _target = crate::services::catalogue::RepatriationTarget::prepare(&destination.0)?;
        fs::create_dir_all(&cache).map_err(failure)?;
        let scratch = Scratch::new(&cache)?;
        let zip = acquire(&store, &device, id, &scratch.0, &op.cancel, |percent| {
            if let Ok(mut p) = op.progress.lock() {
                p.phase = "reconstructing".into();
                p.result = Some(serde_json::json!({"progress":percent}));
            }
            op.emit(&sink, false);
        })
        .map_err(|error| {
            // A disappearing volume is not an incomplete pack. Keep local
            // workspace/publication failures outside this device-read boundary.
            if !device.root.join(".md").is_file() {
                UserMessage::new(codes::STORYTELLER_REPATRIATE_DISCONNECTED)
            } else {
                error
            }
        })?;
        // Cancellation and publication share the progress mutex. After this
        // boundary publication completes, and late cancellation is a no-op.
        {
            let _p = op.progress.lock().map_err(failure)?;
            check(&op.cancel)?;
            op.published.store(true, Ordering::SeqCst);
        }
        store.publish_repatriated_story(&zip, id, &destination.0, &destination.1)
    })();
    if let Ok(mut p) = op.progress.lock() {
        p.scan_complete = true;
        p.candidates.processed = 1;
        match result {
            Ok((fiche, revision)) => {
                p.status = "success".into();
                p.catalogue_changed = true;
                p.catalogue_revision = revision;
                p.sources_revision = store.sources_revision().unwrap_or(p.sources_revision);
                p.cards.created = 1;
                p.outcomes.indexed_new = 1;
                p.result = Some(serde_json::json!({"progress":100,"catalogueFicheId":fiche}));
            }
            Err(error) => {
                p.status = if op.cancel.load(Ordering::SeqCst) {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                let reason = safe_repatriation_reason(error);
                if let Some(detail) = &reason.detail {
                    log::warn!(target: "lunii_repatriate", "{}", detail);
                }
                p.error = Some(driver::classify_error(reason, "preparing"));
                p.outcomes.refused = 1;
            }
        }
    }
    op.emit(&sink, true);
}
#[cfg(test)]
mod tests;
