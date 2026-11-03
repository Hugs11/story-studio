//! Format adapters. Child archives and filesystem packs are materialized by the
//! same readers as consultation; only verified direct packs may be replaced.
use super::{fail, io_error, Result};
use crate::{
    services::catalogue::{
        analyze,
        open::{
            materialize,
            target::{Observed, Target},
        },
        writes,
    },
    support::{imported_pack, user_message::codes},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub(super) struct Scratch {
    pub path: PathBuf,
    _own: writes::OwnWrite,
}
impl Scratch {
    pub fn new() -> Result<Self> {
        let path = std::env::temp_dir()
            .canonicalize()
            .map_err(io_error)?
            .join(format!("story-catalogue-write-{}", uuid::Uuid::new_v4()));
        let own =
            writes::OwnWrite::begin(writes::Declaration::new("catalogueStaging").temporary(&path));
        fs::create_dir(&path).map_err(io_error)?;
        Ok(Self { path, _own: own })
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
pub(super) fn view(
    source: &Path,
    format: &str,
    chain: &[serde_json::Value],
    owned: &Path,
    cancel: &AtomicBool,
) -> Result<PathBuf> {
    if chain.is_empty() && matches!(format, "zip" | "studioDirectory") {
        return Ok(source.to_owned());
    }
    materialize::pack_zip(
        &Target {
            path: source.to_owned(),
            observation: Some(Observed {
                format: format.into(),
                state: "available".into(),
                token: String::new(),
                raw: json!({"chain":chain}),
            }),
        },
        owned,
        cancel,
        None,
    )
    .map_err(|error| {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            fail(codes::GENERATION_CANCELLED)
        } else {
            error
        }
    })
}
/// Size of an archive member read from its container's index alone, without
/// decompressing anything. Only a single `archive-entry` of a zip or 7z
/// container is sized: `view` then spools exactly that member's bytes, so its
/// size and digest compare with those of a standalone file. A pack root is
/// rebuilt as a new zip, an `fsZip` member is converted and a nested member
/// needs its parent extracted first: none of them has an index size matching
/// the bytes `view` yields, so they return `None` and are not compared.
pub(super) fn member_size(
    source: &Path,
    format: &str,
    chain: &[serde_json::Value],
    cancel: &AtomicBool,
) -> Result<Option<u64>> {
    let [segment] = chain else {
        return Ok(None);
    };
    let (Some("archive-entry"), Some(name)) = (segment["kind"].as_str(), segment["path"].as_str())
    else {
        return Ok(None);
    };
    match format {
        "zip" => {
            let mut archive = zip::ZipArchive::new(fs::File::open(source).map_err(io_error)?)
                .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
            let entry = archive
                .by_name(name)
                .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
            Ok((!entry.is_dir()).then(|| entry.size()))
        }
        "7z" => {
            let tool = imported_pack::resolve_7z_path()
                .map_err(|e| fail(codes::CATALOG_FILE_VERIFY_FAILED).with_detail(e))?;
            let listing = read(
                &tool,
                source,
                &["l", "-slt", "-ba"],
                cancel,
                4 * 1024 * 1024,
            )?;
            let listing = std::str::from_utf8(&listing)
                .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
            let entries = analyze::parse_7z_listing(listing)
                .map_err(|e| fail(codes::CATALOG_FILE_VERIFY_FAILED).with_detail(e))?;
            Ok(entries
                .into_iter()
                .find_map(|(path, size, folder)| (path == name && !folder).then_some(size)))
        }
        _ => Ok(None),
    }
}
pub(super) fn is_seven(path: &Path) -> bool {
    let mut bytes = [0u8; 6];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok()
        && bytes == *b"7z\xbc\xaf\x27\x1c"
}
fn read(
    tool: &Path,
    path: &Path,
    args: &[&str],
    cancel: &AtomicBool,
    limit: u64,
) -> Result<Vec<u8>> {
    analyze::read_archive_tool(tool, path, args, cancel, limit, None)
        .map_err(|e| fail(codes::CATALOG_FILE_VERIFY_FAILED).with_detail(e))
}
pub(super) fn story(path: &Path) -> Result<Vec<u8>> {
    let tool = imported_pack::resolve_7z_path()
        .map_err(|e| fail(codes::CATALOG_FILE_VERIFY_FAILED).with_detail(e))?;
    read(
        &tool,
        path,
        &["x", "-so", "-spd", "story.json"],
        &AtomicBool::new(false),
        analyze::JSON_LIMIT,
    )
}
pub(super) fn inventory_with(
    tool: &Path,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<BTreeMap<String, String>> {
    let listing = read(tool, path, &["l", "-slt", "-ba"], cancel, 4 * 1024 * 1024)?;
    let listing =
        std::str::from_utf8(&listing).map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
    let listing = listing.replace("\r\n", "\n");
    let mut names = vec![];
    let mut total = 0u64;
    for section in listing.split("\n\n") {
        let mut name = None;
        let mut directory = false;
        for line in section.lines().map(|v| v.trim_end_matches('\r')) {
            if let Some(v) = line.strip_prefix("Path = ") {
                // Same portable member spelling as the analyzer's listing.
                name = Some(v.replace('\\', "/"));
            }
            if line == "Folder = +" || line.starts_with("Attributes = D") {
                directory = true;
            }
            if line.starts_with("Symbolic Link = ")
                || line.starts_with("Hard Link = ")
                || line.contains("lrwx")
            {
                return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
            }
            if let Some(v) = line.strip_prefix("Size = ") {
                total = total.saturating_add(
                    v.parse::<u64>()
                        .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?,
                );
            }
        }
        if let Some(name) = name {
            names.push((name, directory));
        }
    }
    if names.len() > 100000 || total > 16 * 1024 * 1024 * 1024 {
        return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
    }
    analyze::validate_member_names(names.iter().map(|(n, _)| n.as_str()))
        .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
    let mut result = BTreeMap::new();
    for (name, directory) in names {
        if !directory {
            let bytes = read(
                tool,
                path,
                &["x", "-so", "-spd", &name],
                cancel,
                crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES,
            )?;
            if result
                .insert(name, format!("{:x}", Sha256::digest(bytes)))
                .is_some()
            {
                return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
            }
        }
    }
    Ok(result)
}
pub(super) fn inventory(path: &Path, cancel: &AtomicBool) -> Result<BTreeMap<String, String>> {
    let tool = imported_pack::resolve_7z_path()
        .map_err(|e| fail(codes::CATALOG_FILE_VERIFY_FAILED).with_detail(e))?;
    inventory_with(&tool, path, cancel)
}

#[cfg(test)]
pub(super) fn write_seven(
    tool: &Path,
    zip: &Path,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    if output.exists() {
        return Err(fail(codes::CATALOG_FILE_NAME_CONFLICT));
    }
    use super::patch;

    let expected = patch::inventory(zip, cancel)?;
    let scratch = Scratch::new()?;
    let mut archive = zip::ZipArchive::new(fs::File::open(zip).map_err(io_error)?)
        .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
    for i in 0..archive.len() {
        patch::check(cancel)?;
        let mut entry = archive
            .by_index(i)
            .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
        let path = scratch.path.join(
            entry
                .enclosed_name()
                .ok_or_else(|| fail(codes::CATALOG_FILE_VERIFY_FAILED))?,
        );
        if entry.is_dir() {
            fs::create_dir_all(path).map_err(io_error)?;
        } else {
            fs::create_dir_all(path.parent().unwrap()).map_err(io_error)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(io_error)?;
            std::io::copy(&mut entry, &mut file).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
        }
    }
    let mut command = std::process::Command::new(tool);
    crate::support::ffmpeg::apply_no_window(&mut command);
    command
        .current_dir(&scratch.path)
        .args(["a", "-t7z", "-y", "--"])
        .arg(output)
        .arg(".");
    analyze::run_archive_tool(command, cancel, 4 * 1024 * 1024, None)
        .map_err(|e| fail(codes::CATALOG_FILE_WRITE_FAILED).with_detail(e))?;
    if !is_seven(output) || inventory_with(tool, output, cancel)? != expected {
        return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
    }
    crate::support::file_sync::sync_file(output).map_err(io_error)?;
    super::publish::sync_directory(output.parent().unwrap())
}
