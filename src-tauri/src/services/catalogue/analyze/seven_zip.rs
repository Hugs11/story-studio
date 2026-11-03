//! Targeted reads through the existing bundled-tool resolver. Solid archives
//! may decompress a whole block, but unrelated media never reach disk/stdout.
use super::*;
use std::{
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn run(path: &Path, args: &[&str], cancel: &AtomicBool, limit: u64) -> Result<Vec<u8>, String> {
    run_output(path, args, cancel, limit, None)
}
fn run_output(
    path: &Path,
    args: &[&str],
    cancel: &AtomicBool,
    limit: u64,
    file: Option<std::fs::File>,
) -> Result<Vec<u8>, String> {
    #[cfg(test)]
    let _inventory = (args[0] == "l").then(super::inventory_profile::Timer::start);
    let binary = crate::support::imported_pack::resolve_7z_path()?;
    run_with_binary(&binary, path, args, cancel, limit, file)
}

pub(crate) fn run_with_binary(
    binary: &Path,
    path: &Path,
    args: &[&str],
    cancel: &AtomicBool,
    limit: u64,
    file: Option<std::fs::File>,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new(binary);
    crate::support::ffmpeg::apply_no_window(&mut command);
    command.arg(args[0]);
    let (switches, member) = if args[0] == "x" {
        (&args[1..args.len() - 1], args.last().copied())
    } else {
        (&args[1..], None)
    };
    command.args(switches);
    if args[0] == "l" {
        // Listings are decoded as UTF-8 by every consumer. Windows 7-Zip
        // otherwise uses the console code page for accented member names.
        command.arg("-sccUTF-8");
    }
    command.arg("-p").arg("--").arg(path);
    if let Some(member) = member {
        command.arg(member);
    }
    execute(command, cancel, limit, file)
}

pub(crate) fn execute(
    mut command: Command,
    cancel: &AtomicBool,
    limit: u64,
    mut file: Option<std::fs::File>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("packReadFailed")?;
    let stderr = child.stderr.take().ok_or("packReadFailed")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let over = Arc::clone(&overflow);
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stdout = stdout;
        let mut total = 0;
        let mut buffer = [0; 65536];
        loop {
            let count = stdout.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > limit {
                over.store(true, Ordering::Relaxed);
                break;
            }
            if let Some(file) = file.as_mut() {
                file.write_all(&buffer[..count])?;
            } else {
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let start = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Relaxed)
            || overflow.load(Ordering::Relaxed)
            || start.elapsed() > Duration::from_secs(60)
        {
            let _ = child.kill();
            break child.wait();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e);
            }
        }
    }
    .map_err(|e| e.to_string())?;
    let bytes = output
        .join()
        .map_err(|_| "packReadFailed")?
        .map_err(|e| e.to_string())?;
    let diagnostic =
        String::from_utf8_lossy(&errors.join().map_err(|_| "packReadFailed")?).to_ascii_lowercase();
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if overflow.load(Ordering::Relaxed) || start.elapsed() > Duration::from_secs(60) {
        return Err("readLimitExceeded".into());
    }
    if !status.success() {
        return Err(
            if diagnostic.contains("password") || diagnostic.contains("encrypted") {
                "archiveProtected"
            } else if diagnostic.contains("is not archive")
                || diagnostic.contains("headers error")
                || diagnostic.contains("crc failed")
            {
                "archiveCorrupt"
            } else {
                "packReadFailed"
            }
            .into(),
        );
    }
    Ok(bytes)
}
/// Validated member listing of a 7z: name, declared size and folder flag of
/// each member. Shared by the analyzer and the trash pack count.
pub(super) fn listing(
    path: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<(String, u64, bool)>, String> {
    let bytes = run(path, &["l", "-slt", "-ba"], cancel, 4 * 1024 * 1024)?;
    let listing = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    parse_listing(listing)
}

pub(crate) fn parse_listing(listing: &str) -> Result<Vec<(String, u64, bool)>, String> {
    let mut members = Vec::new();
    // Declared size and folder flag of each member, for the device-pack reader.
    let mut entries: Vec<(String, u64, bool)> = Vec::new();
    for line in listing.lines().map(|line| line.trim_end_matches('\r')) {
        if let Some(name) = line.strip_prefix("Path = ") {
            // 7-Zip's textual listing uses native separators on Windows.
            // Validate the portable archive name below, including traversal,
            // drive prefixes and collisions after separator normalization.
            let name = name.replace('\\', "/");
            members.push(name.clone());
            entries.push((name, 0, false));
        } else if let Some((_, size, folder)) = entries.last_mut() {
            if let Some(value) = line.strip_prefix("Size = ") {
                *size = value
                    .trim()
                    .parse()
                    .map_err(|_| "archiveCorrupt".to_owned())?;
            } else if line == "Folder = +" || line.starts_with("Attributes = D") {
                *folder = true;
            }
        }
    }
    if members.len() > crate::support::archive_limits::ARCHIVE_MAX_ENTRIES {
        return Err("readLimitExceeded".into());
    }
    super::member::validate_names(members.iter().map(String::as_str))?;
    Ok(entries)
}

#[cfg(test)]
mod listing_tests {
    use super::parse_listing;

    #[test]
    fn native_separators_produce_the_same_inventory() {
        let posix = "Path = Pack/assets/audio.mp3\nSize = 17\n";
        assert_eq!(
            parse_listing(posix).unwrap(),
            parse_listing(&posix.replace('/', "\\")).unwrap()
        );
        assert_eq!(
            parse_listing(posix).unwrap(),
            [("Pack/assets/audio.mp3".into(), 17, false)]
        );
    }

    #[test]
    fn separator_normalization_keeps_traversal_and_collision_checks() {
        for name in ["../a", r"..\a", r"C:\a", r"\a", "a//b", "a/./b"] {
            assert_eq!(
                parse_listing(&format!("Path = {name}\n")),
                Err("invalidArchivePath".into())
            );
        }
        assert_eq!(
            parse_listing("Path = a/b\nPath = a\\b\n"),
            Err("archiveNameCollision".into())
        );
    }

    #[test]
    fn folder_limits_count_all_descendants_with_both_separator_spellings() {
        use crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES;
        for folder in ["Pack", "Collection/Pack"] {
            let listing = format!(
                "Path = {folder}\nFolder = +\n\nPath = {folder}/story.json\nSize = 17\n\nPath = {folder}/assets/audio.mp3\nSize = {}\n\nPath = {folder}-other/large.mp3\nSize = {}\n",
                ARCHIVE_MAX_FILE_BYTES - 17,
                ARCHIVE_MAX_FILE_BYTES + 1,
            );
            for listing in [listing.clone(), listing.replace('/', "\\")] {
                let mut entries = parse_listing(&listing).unwrap();
                assert_eq!(super::check_folder_limits(&entries, folder), Ok(()));
                // The whole nested payload counts, not just the folder entry.
                entries[2].1 += 1;
                assert_eq!(
                    super::check_folder_limits(&entries, folder),
                    Err("readLimitExceeded".into())
                );
                assert_eq!(
                    super::check_folder_limits(&entries, "absent"),
                    Err("invalidPackStructure".into())
                );
            }
        }
    }

    #[test]
    fn folder_entry_count_is_bounded_before_extraction() {
        use crate::support::archive_limits::ARCHIVE_MAX_ENTRIES;
        let mut entries: Vec<_> = (0..ARCHIVE_MAX_ENTRIES)
            .map(|index| (format!("Collection/Pack/assets/{index}"), 0, false))
            .collect();
        assert_eq!(
            super::check_folder_limits(&entries, "Collection/Pack"),
            Ok(())
        );
        entries.push(("Collection/Pack/one-more".into(), 0, false));
        assert_eq!(
            super::check_folder_limits(&entries, "Collection/Pack"),
            Err("readLimitExceeded".into())
        );
    }

    #[test]
    fn invalid_declared_sizes_are_refused_in_the_shared_inventory() {
        for size in ["not-a-size", "-1", "18446744073709551616"] {
            assert_eq!(
                parse_listing(&format!("Path = Pack/audio.mp3\nSize = {size}\n")),
                Err("archiveCorrupt".into())
            );
        }
    }

    #[test]
    fn folder_extraction_materializes_root_and_nested_pack_contents() {
        use std::{fs, process::Command, sync::atomic::AtomicBool};
        let temporary = super::super::temporary::Temporary::new().unwrap();
        let root = temporary.path.parent().unwrap();
        let staging = root.join("source");
        let archive = root.join("packs.7z");
        for folder in ["Pack Été", "Collection/Pack Été"] {
            fs::create_dir_all(staging.join(folder).join("assets/deep")).unwrap();
            fs::write(staging.join(folder).join("story.json"), b"pack metadata").unwrap();
            fs::write(
                staging.join(folder).join("assets/deep/audio.mp3"),
                b"complete audio bytes",
            )
            .unwrap();
        }
        fs::write(
            staging.join("Collection/other.txt"),
            b"outside selected pack",
        )
        .unwrap();
        let tool = crate::support::imported_pack::resolve_7z_path().unwrap();
        let output = Command::new(tool)
            .args(["a", "-t7z", "--"])
            .arg(&archive)
            .args(["Pack Été", "Collection"])
            .current_dir(&staging)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let original = fs::read(&archive).unwrap();
        for (index, folder) in ["Pack Été", "Collection/Pack Été"].into_iter().enumerate() {
            let destination = root.join(format!("extracted-{index}"));
            fs::create_dir(&destination).unwrap();
            super::extract_folder(&archive, folder, &destination, &AtomicBool::new(false)).unwrap();
            assert_eq!(
                fs::read(destination.join(folder).join("story.json")).unwrap(),
                b"pack metadata"
            );
            assert_eq!(
                fs::read(destination.join(folder).join("assets/deep/audio.mp3")).unwrap(),
                b"complete audio bytes"
            );
            assert!(!destination.join("Collection/other.txt").exists());
            assert_eq!(fs::read(&archive).unwrap(), original);
        }
    }
}
/// Inventory names in the ZIP form: a folder ends with `/`.
pub(super) fn inventory_names(entries: &[(String, u64, bool)]) -> Vec<String> {
    entries
        .iter()
        .map(|(name, _, folder)| {
            if *folder {
                format!("{name}/")
            } else {
                name.clone()
            }
        })
        .collect()
}
/// Extracts one nested member to an owned temporary file, as the analyzer
/// does for a nested ZIP.
pub(super) fn spool_nested(
    path: &Path,
    name: &str,
    cancel: &AtomicBool,
) -> Result<super::temporary::Temporary, String> {
    let temporary = super::temporary::Temporary::new()?;
    run_output(
        path,
        &["x", "-so", "-spd", name],
        cancel,
        crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES,
        Some(temporary.write()?),
    )?;
    Ok(temporary)
}
pub fn analyze(path: &Path, cancel: &AtomicBool) -> Result<Vec<Observation>, String> {
    let entries = listing(path, cancel)?;
    let members = entries
        .iter()
        .map(|(name, _, _)| name.clone())
        .collect::<Vec<_>>();
    let direct = members.iter().any(|m| m == "story.json");
    let mut values = Vec::new();
    for name in members.iter().filter(|name| {
        if direct {
            name.as_str() == "story.json"
        } else {
            name.ends_with("/story.json") || name.to_ascii_lowercase().ends_with(".zip")
        }
    }) {
        let read = || -> Result<Vec<Observation>, String> {
            if name.ends_with("story.json") {
                let bytes = run(path, &["x", "-so", "-spd", name], cancel, JSON_LIMIT)?;
                return Ok(vec![super::studio::story(
                    json(std::io::Cursor::new(bytes))?,
                    "7z",
                )]);
            }
            let temporary = spool_nested(path, name, cancel)?;
            // Metadata only: listening values come from the separate solid pass.
            super::studio::zip_at(
                temporary.read()?,
                1,
                cancel,
                Path::new("archive.zip"),
                false,
            )
        };
        // One unreadable child of a multipack is isolated; the others stay indexed.
        let children = match read() {
            Ok(children) => children,
            Err(reason) if direct || reason == "cancelled" => return Err(reason),
            Err(reason) => vec![Observation::failure("7z", reason, None)],
        };
        for mut child in children {
            // Device ZIPs need an outer-container-aware cover/materialization
            // adapter before they can be exposed through a 7z container.
            if child.format == "fsZip" {
                child = Observation::failure("7z", "formatUnsupported".into(), child.member);
            }
            child.format = "7z".into();
            if name.ends_with("story.json") {
                let cover_name = format!("{}thumbnail.png", name.trim_end_matches("story.json"));
                if members.contains(&cover_name) {
                    child.cover =
                        Some(serde_json::json!({"kind":"archiveEntry","path":cover_name}));
                }
            }
            if !direct {
                let (kind, base) = if name.ends_with("story.json") {
                    ("pack-root", name.trim_end_matches("/story.json"))
                } else {
                    ("archive-entry", name.as_str())
                };
                child.prepend_member(kind, base);
                // Same display form as ZIP children: the pack folder or the
                // nested archive, followed by any inner member.
                child.member = Some(format!(
                    "{base}{}",
                    child
                        .member
                        .as_ref()
                        .map(|m| format!("/{m}"))
                        .unwrap_or_default()
                ));
            }
            values.push(child);
        }
    }
    if !members
        .iter()
        .any(|name| name == "story.json" || name.ends_with("/story.json"))
    {
        values.extend(device_packs(path, &entries, cancel)?);
    }
    if values.is_empty() {
        return Err("invalidPackStructure".into());
    }
    Ok(values)
}

/// Device packs (`ni`/`ri`/`si`/`li`) of a 7z, read by the same inventory rule
/// as device ZIPs (`fs_archive`). Folders are named with a trailing `/`, as
/// in a ZIP directory, and each index is read alone through the archive tool.
/// The observations keep the `7z` container format: covers and
/// materialization go through the 7z member readers, and the preview's
/// `variant` tells a device pack from a STUdio one.
fn device_packs(
    path: &Path,
    entries: &[(String, u64, bool)],
    cancel: &AtomicBool,
) -> Result<Vec<Observation>, String> {
    let names = inventory_names(entries);
    let sizes = entries
        .iter()
        .filter(|(_, _, folder)| !folder)
        .map(|(name, size, _)| (name.as_str(), *size))
        .collect::<std::collections::HashMap<_, _>>();
    super::fs_archive::analyze(&names, "7z", cancel, |name, limit| {
        let size = *sizes.get(name).ok_or("invalidPackStructure")?;
        // Only node and asset indexes are read; the tool refuses any output
        // beyond the declared size, the caller only keeps `limit` bytes.
        if size > JSON_LIMIT {
            return Err("readLimitExceeded".into());
        }
        let mut bytes = run(path, &["x", "-so", "-spd", name], cancel, size)?;
        bytes.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok((bytes, size))
    })
}

pub(super) fn read_member(path: &Path, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    run(
        path,
        &["x", "-so", "-spd", name],
        &AtomicBool::new(false),
        limit,
    )
}
pub(crate) fn spool_member(path: &Path, name: &str, file: std::fs::File) -> Result<(), String> {
    spool_member_cancellable(path, name, file, &AtomicBool::new(false))
}
pub(crate) fn spool_member_cancellable(
    path: &Path,
    name: &str,
    file: std::fs::File,
    cancel: &AtomicBool,
) -> Result<(), String> {
    run_output(
        path,
        &["x", "-so", "-spd", name],
        cancel,
        crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES,
        Some(file),
    )
    .map(|_| ())
}

/// Extracts one pack folder of a multipack 7z (the folder and everything
/// under it) into `destination`, an owned temporary folder. The member name is
/// passed literally (`-spd`): no wildcard of an archive name is interpreted.
/// The folder's declared size and entry count are bounded before anything is
/// written, and the extraction stops on `cancel` or after the reader's delay.
pub(crate) fn extract_folder(
    path: &Path,
    folder: &str,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    super::member::validate_names(std::iter::once(folder))?;
    let entries = listing(path, cancel)?;
    check_folder_limits(&entries, folder)?;
    let output = format!("-o{}", destination.display());
    run_output(
        path,
        &["x", "-y", "-spd", &output, folder],
        cancel,
        4 * 1024 * 1024,
        None,
    )
    .map(|_| ())
}

fn check_folder_limits(entries: &[(String, u64, bool)], folder: &str) -> Result<(), String> {
    let prefix = format!("{folder}/");
    let (mut count, mut total) = (0usize, 0u64);
    for (name, size, _) in entries {
        if name == folder || name.starts_with(&prefix) {
            count += 1;
            total = total.saturating_add(*size);
        }
    }
    if count == 0 {
        return Err("invalidPackStructure".into());
    }
    if count > crate::support::archive_limits::ARCHIVE_MAX_ENTRIES
        || total > crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES
    {
        return Err("readLimitExceeded".into());
    }
    Ok(())
}

/// Stream one member to a bounded parser; cancellation owns and kills the child.
pub(super) fn stream_member<T: Send>(
    path: &Path,
    name: &str,
    cancel: &AtomicBool,
    parse: impl FnOnce(&mut dyn Read) -> Result<T, String> + Send,
) -> Result<T, super::ListeningFailure> {
    let binary =
        crate::support::imported_pack::resolve_7z_path().map_err(super::ListeningFailure::Retry)?;
    let mut command = Command::new(binary);
    command
        .args(["x", "-so", "-spd", "-p", "--"])
        .arg(path)
        .arg(name);
    stream_child(command, cancel, parse)
}

/// A solid stream may stay silent while 7-Zip decodes data before a member,
/// but a child that produces nothing for this long is stopped.
const STREAM_INACTIVITY: Duration = Duration::from_secs(60);
/// Diagnostics kept from 7-Zip's error stream; the rest is read and dropped
/// so the child never blocks on a full pipe.
const STDERR_KEPT: u64 = 64 * 1024;

/// Last time the child's output advanced, shared with the supervisor.
struct Activity {
    start: Instant,
    last: std::sync::atomic::AtomicU64,
}
impl Activity {
    fn idle(&self) -> Duration {
        self.start
            .elapsed()
            .saturating_sub(Duration::from_millis(self.last.load(Ordering::Relaxed)))
    }
}
struct Tracked<'a, R> {
    reader: R,
    activity: &'a Activity,
}
impl<R: Read> Read for Tracked<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.reader.read(buffer)?;
        if n > 0 {
            let now = self.activity.start.elapsed().as_millis() as u64;
            self.activity.last.store(now, Ordering::Relaxed);
        }
        Ok(n)
    }
}

/// Runs a 7-Zip child whose stdout is parsed in flux, without a temporary
/// file. The child is killed on cancellation or after `STREAM_INACTIVITY`
/// without output; a successful parse drains the rest of the stream.
///
/// Failures are classified for the listening pass: the tool (missing binary,
/// silence, abnormal exit) is retried at the next scan; the archive's own
/// data (corruption, limits, hostile structure) settles it for good.
pub(super) fn stream_child<T: Send>(
    mut command: Command,
    cancel: &AtomicBool,
    parse: impl FnOnce(&mut dyn Read) -> Result<T, String> + Send,
) -> Result<T, super::ListeningFailure> {
    use super::ListeningFailure::{Cancelled, Retry, Settled};
    crate::support::ffmpeg::apply_no_window(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| Retry(e.to_string()))?;
    let stdout = child.stdout.take().ok_or(Retry("packReadFailed".into()))?;
    let stderr = child.stderr.take().ok_or(Retry("packReadFailed".into()))?;
    let activity = Activity {
        start: Instant::now(),
        last: std::sync::atomic::AtomicU64::new(0),
    };
    let mut silent = false;
    let (status, result, diagnostic) = std::thread::scope(|scope| {
        let activity = &activity;
        let output = scope.spawn(move || {
            let mut stdout = Tracked {
                reader: stdout,
                activity,
            };
            let result = parse(&mut stdout);
            if result.is_ok() {
                let mut b = [0; 65536];
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("cancelled".into());
                    }
                    let n = stdout.read(&mut b).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                }
            }
            result
        });
        let errors = scope.spawn(move || {
            let mut stderr = stderr;
            let mut b = Vec::new();
            let _ = (&mut stderr).take(STDERR_KEPT).read_to_end(&mut b);
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            b
        });
        let status = loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                break child.wait();
            }
            if activity.idle() > STREAM_INACTIVITY {
                silent = true;
                let _ = child.kill();
                break child.wait();
            }
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s),
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(e);
                }
            }
        };
        let result = output
            .join()
            .unwrap_or_else(|_| Err("packReadFailed".into()));
        let diagnostic =
            String::from_utf8_lossy(&errors.join().unwrap_or_default()).to_ascii_lowercase();
        (status, result, diagnostic)
    });
    if cancel.load(Ordering::Relaxed) || result.as_ref().err().is_some_and(|r| r == "cancelled") {
        return Err(Cancelled);
    }
    if silent {
        return Err(Retry("streamInactive".into()));
    }
    let status = status.map_err(|e| Retry(e.to_string()))?;
    if !status.success() && diagnostic_is_definitive(&diagnostic) {
        return Err(Settled("archiveCorrupt".into()));
    }
    match result {
        Ok(value) if status.success() => Ok(value),
        Ok(_) => Err(Retry("packReadFailed".into())),
        // The stream ended early because the tool stopped, not the data.
        Err(reason) if !status.success() && reason == "archiveCorrupt" => {
            Err(Retry("packReadFailed".into()))
        }
        Err(reason) => Err(Settled(reason)),
    }
}

/// Whether a failed run's (lowercased) diagnostic is determined by the archive
/// content. Anything else (a lock, a missing disk, denied access) is retried.
fn diagnostic_is_definitive(diagnostic: &str) -> bool {
    [
        "data error",
        "crc failed",
        "headers error",
        "is not archive",
        "unexpected end",
        "wrong password",
        "unsupported method",
        // Only the "as archive" form is about the content; a bare "can not
        // open" is a lock, an unplugged disk or denied access.
        "can not open the file as archive",
    ]
    .iter()
    .any(|marker| diagnostic.contains(marker))
}

#[cfg(test)]
mod diagnostic_classification {
    use super::diagnostic_is_definitive;
    #[test]
    fn only_content_defined_open_failures_are_definitive() {
        assert!(diagnostic_is_definitive(
            "error: /p/a.7z\ncan not open the file as archive\n"
        ));
        assert!(diagnostic_is_definitive("error: data error : a.mp3"));
        for transient in [
            "error: /p/a.7z\ncan not open the file\nerrno=13 : permission denied",
            "error: the process cannot access the file because it is being used by another process.\n/p/a.7z\ncan not open the file",
            "error: can not open output file : no such device",
        ] {
            assert!(!diagnostic_is_definitive(transient), "{transient}");
        }
    }
}

#[cfg(test)]
mod metadata_equivalence {
    use super::*;
    /// Metadata fixtures built identically for the original reader and this one.
    fn metadata_equivalence_archives(dir: &Path) -> Vec<std::path::PathBuf> {
        use std::io::Write;
        let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
        let story = |title: &str, uuid: &str| {
            serde_json::to_vec(&serde_json::json!({"title":title,"stageNodes":[
                {"uuid":uuid,"squareOne":true}],"actionNodes":[]}))
            .unwrap()
        };
        let zip = |files: &[(&str, Vec<u8>)], link: bool| {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for (name, bytes) in files {
                w.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                w.write_all(bytes).unwrap();
            }
            if link {
                w.add_symlink(
                    "escape",
                    "../../outside",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            }
            w.finish().unwrap().into_inner()
        };
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        };
        let pack = |archive: &str, members: &[&str]| {
            let output = std::process::Command::new(&tool)
                .args(["a", "-t7z", "-ms=on"])
                .arg(dir.join(archive))
                .args(members)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(output.status.success());
            dir.join(archive)
        };
        write(
            "story.json",
            &story("Racine", "11111111-1111-4111-8111-111111111111"),
        );
        write("thumbnail.png", b"cover");
        write(
            "sub/story.json",
            &story("Dossier", "22222222-2222-4222-8222-222222222222"),
        );
        write("sub/thumbnail.png", b"cover");
        write(
            "good.zip",
            &zip(
                &[(
                    "story.json",
                    story("Zip", "33333333-3333-4333-8333-333333333333"),
                )],
                false,
            ),
        );
        write("bad.zip", b"not an archive");
        write(
            "link.zip",
            &zip(
                &[(
                    "story.json",
                    story("Lien", "44444444-4444-4444-8444-444444444444"),
                )],
                true,
            ),
        );
        vec![
            pack("root.7z", &["story.json", "thumbnail.png", "sub"]),
            pack("children.7z", &["sub", "good.zip", "bad.zip", "link.zip"]),
        ]
    }
    fn metadata_equivalence_json(dir: &Path) -> serde_json::Value {
        let cancel = AtomicBool::new(false);
        let archives = metadata_equivalence_archives(dir);
        serde_json::Value::Array(
            archives
                .iter()
                .map(|archive| {
                    let observed = analyze(archive, &cancel).unwrap();
                    serde_json::Value::Array(
                        observed
                            .iter()
                            .map(|o| {
                                let mut value = serde_json::to_value(o).unwrap();
                                let map = value.as_object_mut().unwrap();
                                map.retain(|key, _| !key.starts_with("listening"));
                                value
                            })
                            .collect(),
                    )
                })
                .collect(),
        )
    }
    /// Output of the original reader (`git archive HEAD` of 919fa3c6, same
    /// fixtures and projection), recorded before the listening pass existed.
    const ORIGINAL: &str = r##"
[[{"ageFromName":null,"ageMin":null,"capabilities":{"assessEditors":{"state":"unknown"},"openSimulation":{"state":"unknown"},"readCover":{"state":"unknown"},"readMetadata":{"state":"available","verificationScope":"metadata"}},"chain":[],"cover":{"kind":"archiveEntry","path":"thumbnail.png"},"diagnostics":[],"fields":{"/ageMin":{"presence":"absent","rawValue":null,"source":"/ageMin","validity":"unknown"},"/description":{"presence":"absent","rawValue":null,"source":"/description","validity":"unknown"},"/keywords":{"presence":"absent","rawValue":null,"source":"/keywords","validity":"unknown"},"/minAge":{"presence":"absent","rawValue":null,"source":"/minAge","validity":"unknown"},"/subtitle":{"presence":"absent","rawValue":null,"source":"/subtitle","validity":"unknown"},"/title":{"presence":"present","rawValue":"Racine","source":"/title","validity":"valid"},"/uuid":{"presence":"absent","rawValue":null,"source":"/uuid","validity":"unknown"},"/version":{"presence":"absent","rawValue":null,"source":"/version","validity":"unknown"}},"format":"7z","identity":{"raw":"11111111-1111-4111-8111-111111111111","reliable":true,"source":"/stageNodes/0/uuid","value":"11111111-1111-4111-8111-111111111111"},"member":null,"raw":{"actionNodes":[],"stageNodes":[{"squareOne":true,"uuid":"11111111-1111-4111-8111-111111111111"}],"title":"Racine"},"state":"available","title":"Racine"}],[{"ageFromName":null,"ageMin":null,"capabilities":{"assessEditors":{"state":"unknown"},"openSimulation":{"state":"unknown"},"readCover":{"state":"unknown"},"readMetadata":{"reason":"corruptArchive","state":"unavailable"}},"chain":[{"kind":"archive-entry","path":"bad.zip"}],"cover":null,"diagnostics":["archiveCorrupt"],"fields":{},"format":"7z","identity":null,"member":"bad.zip","raw":null,"state":"corruptArchive","title":null},{"ageFromName":null,"ageMin":null,"capabilities":{"assessEditors":{"state":"unknown"},"openSimulation":{"state":"unknown"},"readCover":{"state":"unknown"},"readMetadata":{"state":"available","verificationScope":"metadata"}},"chain":[{"kind":"archive-entry","path":"good.zip"}],"cover":null,"diagnostics":[],"fields":{"/ageMin":{"presence":"absent","rawValue":null,"source":"/ageMin","validity":"unknown"},"/description":{"presence":"absent","rawValue":null,"source":"/description","validity":"unknown"},"/keywords":{"presence":"absent","rawValue":null,"source":"/keywords","validity":"unknown"},"/minAge":{"presence":"absent","rawValue":null,"source":"/minAge","validity":"unknown"},"/subtitle":{"presence":"absent","rawValue":null,"source":"/subtitle","validity":"unknown"},"/title":{"presence":"present","rawValue":"Zip","source":"/title","validity":"valid"},"/uuid":{"presence":"absent","rawValue":null,"source":"/uuid","validity":"unknown"},"/version":{"presence":"absent","rawValue":null,"source":"/version","validity":"unknown"}},"format":"7z","identity":{"raw":"33333333-3333-4333-8333-333333333333","reliable":true,"source":"/stageNodes/0/uuid","value":"33333333-3333-4333-8333-333333333333"},"member":"good.zip","raw":{"actionNodes":[],"stageNodes":[{"squareOne":true,"uuid":"33333333-3333-4333-8333-333333333333"}],"title":"Zip"},"state":"available","title":"Zip"},{"ageFromName":null,"ageMin":null,"capabilities":{"assessEditors":{"state":"unknown"},"openSimulation":{"state":"unknown"},"readCover":{"state":"unknown"},"readMetadata":{"reason":"invalidStructure","state":"unavailable"}},"chain":[{"kind":"archive-entry","path":"link.zip"}],"cover":null,"diagnostics":["invalidArchivePath"],"fields":{},"format":"7z","identity":null,"member":"link.zip","raw":null,"state":"invalidStructure","title":null},{"ageFromName":null,"ageMin":null,"capabilities":{"assessEditors":{"state":"unknown"},"openSimulation":{"state":"unknown"},"readCover":{"state":"unknown"},"readMetadata":{"state":"available","verificationScope":"metadata"}},"chain":[{"kind":"pack-root","path":"sub"}],"cover":{"kind":"archiveEntry","path":"sub/thumbnail.png"},"diagnostics":[],"fields":{"/ageMin":{"presence":"absent","rawValue":null,"source":"/ageMin","validity":"unknown"},"/description":{"presence":"absent","rawValue":null,"source":"/description","validity":"unknown"},"/keywords":{"presence":"absent","rawValue":null,"source":"/keywords","validity":"unknown"},"/minAge":{"presence":"absent","rawValue":null,"source":"/minAge","validity":"unknown"},"/subtitle":{"presence":"absent","rawValue":null,"source":"/subtitle","validity":"unknown"},"/title":{"presence":"present","rawValue":"Dossier","source":"/title","validity":"valid"},"/uuid":{"presence":"absent","rawValue":null,"source":"/uuid","validity":"unknown"},"/version":{"presence":"absent","rawValue":null,"source":"/version","validity":"unknown"}},"format":"7z","identity":{"raw":"22222222-2222-4222-8222-222222222222","reliable":true,"source":"/stageNodes/0/uuid","value":"22222222-2222-4222-8222-222222222222"},"member":"sub","raw":{"actionNodes":[],"stageNodes":[{"squareOne":true,"uuid":"22222222-2222-4222-8222-222222222222"}],"title":"Dossier"},"state":"available","title":"Dossier"}]]"##;
    #[test]
    fn solid_archive_metadata_is_unchanged_by_the_listening_pass() {
        let dir = std::env::temp_dir().join(format!("story-studio-eq-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let observed = metadata_equivalence_json(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let original: serde_json::Value = serde_json::from_str(ORIGINAL.trim()).unwrap();
        assert_eq!(observed, original);
    }
}
