use super::*;
use std::io::{Read, Seek};
pub(super) fn story(value: Value, format: &str) -> Observation {
    let mut out = Observation::new(format);
    out.title = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(uuid) = crate::native_pack::pack_identity_from_story(&value) {
        let entries = value
            .get("stageNodes")
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .enumerate()
                    .filter(|(_, node)| {
                        node.get("squareOne").and_then(Value::as_bool) == Some(true)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let source = if entries.len() == 1
            && entries[0].1.get("uuid").and_then(Value::as_str) == Some(uuid.as_str())
        {
            format!("/stageNodes/{}/uuid", entries[0].0)
        } else {
            "/uuid".into()
        };
        out.identity = Some(identity(
            value.pointer(&source).unwrap_or(&Value::String(uuid)),
            &source,
        ));
    } else if let Some(raw) = value.get("uuid") {
        out.identity = Some(identity(raw, "/uuid"));
    }
    for (pointer, kind) in [
        ("/uuid", "string"),
        ("/title", "string"),
        ("/subtitle", "string"),
        ("/keywords", "keywords"),
        ("/ageMin", "age"),
        ("/minAge", "age"),
        ("/description", "string"),
        ("/version", "integer"),
    ] {
        out.fields
            .insert(pointer.into(), observed(&value, pointer, kind));
    }
    out.raw = value;
    out
}
pub fn directory(
    path: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    measure: bool,
) -> Result<Observation, String> {
    if path.join("story.json").is_file() {
        let mut out = story(
            json(std::fs::File::open(path.join("story.json")).map_err(|e| e.to_string())?)?,
            "studioDirectory",
        );
        if path.join("thumbnail.png").is_file() {
            out.cover = Some(serde_json::json!({"kind":"file","path":path.join("thumbnail.png")}));
        }
        if measure {
            super::listening::directory(&mut out, path, cancel);
        }
        return Ok(out);
    }
    if crate::support::fs_pack_reader::detect_fs_pack_variant(path).is_some() {
        let mut out = Observation::new("fsDirectory");
        out.raw = crate::support::fs_pack_reader::read_fs_pack_preview(path)
            .map_err(crate::support::fs_pack_reader::FsPreviewError::into_reason)?;
        out.cover = out.raw.get("cover").filter(|v| !v.is_null()).cloned();
        if measure {
            let variant = crate::support::fs_pack_reader::detect_fs_pack_variant(path).unwrap();
            let mut dependencies = Vec::new();
            let mut unstable = false;
            super::listening::fs(
                &mut out,
                variant,
                crate::support::fs_pack_reader::has_fs_pack_cleartext_marker(path),
                |name, limit| {
                    let file = std::fs::File::open(
                        crate::support::fs_pack_reader::resolve_fs_path(path, name),
                    )
                    .map_err(|e| e.to_string())?;
                    let size = file.metadata().map_err(|e| e.to_string())?.len();
                    let mut bytes = Vec::new();
                    file.take(limit)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                    Ok((bytes, size))
                },
                cancel,
                |name, variant| {
                    let p = crate::support::fs_pack_reader::resolve_fs_path(path, name);
                    dependencies.push(crate::support::paths::path_for_frontend(&p));
                    let before = std::fs::metadata(&p)
                        .ok()
                        .and_then(|m| Some((m.len(), m.modified().ok()?)));
                    let (f, size) = super::listening::open_regular(&p)?;
                    let reader =
                        crate::support::audio_duration::FsAudio::new(f, variant, size).ok()?;
                    let duration = crate::support::audio_duration::seekable(reader, size, cancel);
                    let after = std::fs::metadata(&p)
                        .ok()
                        .and_then(|m| Some((m.len(), m.modified().ok()?)));
                    unstable |= before != after;
                    duration
                },
            );
            out.listening_dependencies = dependencies;
            // A sound changed while it was measured: metadata stays valid, the
            // listening values are measured again next time.
            out.listening_incomplete = unstable;
        }
        let name = crate::support::fs_pack_reader::fs_pack_directory_identity(path);
        out.identity = Some(identity(&Value::String(name), "directoryName"));
        return Ok(out);
    }
    Err("invalidPackStructure".into())
}
#[cfg(test)]
pub fn zip(
    reader: impl Read + Seek,
    depth: usize,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Vec<Observation>, String> {
    zip_at(reader, depth, cancel, Path::new("archive.zip"), true)
}
pub(super) fn zip_at(
    reader: impl Read + Seek,
    depth: usize,
    cancel: &std::sync::atomic::AtomicBool,
    source: &Path,
    measure: bool,
) -> Result<Vec<Observation>, String> {
    #[cfg(test)]
    let inventory = super::inventory_profile::Timer::start();
    let mut archive = validated(reader, depth, cancel)?;
    #[cfg(test)]
    drop(inventory);
    let has_cover = archive.file_names().any(|name| name == "thumbnail.png");
    // Same lookup as before listening: an unreadable root entry falls through.
    let direct = archive.by_name("story.json").ok().map(json);
    if let Some(value) = direct {
        let mut out = story(value?, "zip");
        if measure {
            super::listening::zip(&mut out, &mut archive, "", cancel);
        }
        if has_cover {
            out.cover = Some(serde_json::json!({"kind":"archiveEntry","path":"thumbnail.png"}));
        }
        return Ok(vec![out]);
    }
    let mut values = Vec::new();
    for index in 0..archive.len() {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let raw = archive.by_index_raw(index).map_err(zip_error)?;
        let name = raw.name().to_owned();
        drop(raw);
        if name.ends_with("/story.json") {
            let root = name.trim_end_matches("story.json").trim_end_matches('/');
            // One unreadable child of a multipack is isolated, as for 7z.
            let entry = archive.by_index(index).map_err(zip_error)?;
            let mut out = match json(entry) {
                Ok(value) => story(value, "zip"),
                Err(reason) => Observation::failure("zip", reason, None),
            };
            if measure {
                super::listening::zip(&mut out, &mut archive, &format!("{root}/"), cancel);
            }
            let cover_name = format!("{root}/thumbnail.png");
            if archive.file_names().any(|name| name == cover_name) {
                out.cover = Some(serde_json::json!({"kind":"archiveEntry","path":cover_name}));
            }
            out.member = Some(root.to_owned());
            out.prepend_member("pack-root", root);
            values.push(out);
        } else if name.to_ascii_lowercase().ends_with(".zip") {
            let mut entry = archive.by_index(index).map_err(zip_error)?;
            if entry.size() > crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES {
                let mut failure =
                    Observation::failure("zip", "readLimitExceeded".into(), Some(name.clone()));
                failure.prepend_member("archive-entry", &name);
                values.push(failure);
                continue;
            }
            let temporary = super::temporary::Temporary::spool(&mut entry, cancel)?;
            match zip_at(
                temporary.read()?,
                depth + 1,
                cancel,
                Path::new(&name),
                measure,
            ) {
                Ok(children) => {
                    for mut child in children {
                        child.prepend_member("archive-entry", &name);
                        child.member = Some(format!(
                            "{name}{}",
                            child
                                .member
                                .as_ref()
                                .map(|m| format!("/{m}"))
                                .unwrap_or_default()
                        ));
                        values.push(child);
                    }
                }
                Err(reason) => {
                    let mut failure = Observation::failure("zip", reason, Some(name.clone()));
                    failure.prepend_member("archive-entry", &name);
                    values.push(failure);
                }
            }
        }
    }
    if !archive
        .file_names()
        .any(|name| name == "story.json" || name.ends_with("/story.json"))
    {
        let names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
        values.extend(super::fs_archive::analyze(
            &names,
            "fsZip",
            cancel,
            |name, limit| {
                let index = archive.index_for_name(name).ok_or("invalidPackStructure")?;
                let raw = archive.by_index_raw(index).map_err(zip_error)?;
                let compression = raw.compression();
                let size = raw.size();
                drop(raw);
                let entry = archive.by_name(name).map_err(|e| {
                    // Standard methods keep the precise archive reason
                    // (protected, corrupt); only an unsupported method or an
                    // unclassified failure uses the editor's entry message.
                    let standard = matches!(
                        compression,
                        zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
                    );
                    match zip_error(e).as_str() {
                        reason @ ("archiveProtected" | "archiveCorrupt") if standard => {
                            reason.to_owned()
                        }
                        other => crate::support::imported_pack::unreadable_zip_entry_message(
                            source,
                            name,
                            compression,
                            &std::io::Error::other(other.to_owned()),
                        ),
                    }
                })?;
                if size > crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES {
                    return Err("readLimitExceeded".into());
                }
                let mut bytes = Vec::new();
                entry.take(limit).read_to_end(&mut bytes).map_err(|e| {
                    crate::support::imported_pack::unreadable_zip_entry_message(
                        source,
                        name,
                        compression,
                        &e,
                    )
                })?;
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                Ok((bytes, size))
            },
        )?);
    }
    for out in &mut values {
        if measure && out.format == "fsZip" {
            super::listening::fs_zip(out, &mut archive, cancel);
        }
    }
    if values.is_empty() {
        return Err("invalidPackStructure".into());
    }
    Ok(values)
}
/// The archive once every entry name is validated, before any early return,
/// including direct packs. Shared by the analyzer and the trash pack count.
pub(super) fn validated<R: Read + Seek>(
    reader: R,
    depth: usize,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<zip::ZipArchive<R>, String> {
    if depth > 2 {
        return Err("readLimitExceeded".into());
    }
    let mut archive = zip::ZipArchive::new(reader).map_err(zip_error)?;
    if archive.len() > crate::support::archive_limits::ARCHIVE_MAX_ENTRIES {
        return Err("readLimitExceeded".into());
    }
    super::member::validate_names(archive.file_names())?;
    for index in 0..archive.len() {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let entry = archive.by_index_raw(index).map_err(zip_error)?;
        if entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("invalidArchivePath".into());
        }
    }
    Ok(archive)
}
pub(super) fn zip_error(error: zip::result::ZipError) -> String {
    match error {
        zip::result::ZipError::UnsupportedArchive(message)
            if message.to_ascii_lowercase().contains("password") =>
        {
            "archiveProtected".into()
        }
        zip::result::ZipError::InvalidArchive(_) => "archiveCorrupt".into(),
        other => other.to_string(),
    }
}
