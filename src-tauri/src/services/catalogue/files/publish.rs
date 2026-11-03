//! Native rename semantics live here. New names must never replace a rival.
use super::{io_error, Result};
use std::fs;
use std::{io, path::Path};
#[cfg(test)]
thread_local! {
    pub(super) static FAIL_EXCLUSIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static FAIL_PUBLICATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
pub(crate) fn no_replace(from: &Path, to: &Path) -> Result<()> {
    #[cfg(test)]
    if FAIL_PUBLICATION.with(|v| v.get()) || FAIL_EXCLUSIVE.with(|v| v.get()) {
        return Err(io_error(io::Error::from_raw_os_error(95)));
    }
    native_no_replace(from, to)
}
#[cfg(target_os = "linux")]
fn native_no_replace(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renameat2(
            olddirfd: i32,
            oldpath: *const i8,
            newdirfd: i32,
            newpath: *const i8,
            flags: u32,
        ) -> i32;
    }
    let a = CString::new(from.as_os_str().as_bytes()).map_err(super::super::store::error)?;
    let b = CString::new(to.as_os_str().as_bytes()).map_err(super::super::store::error)?;
    // Linux RENAME_NOREPLACE rejects both existing files and empty directories.
    let result = unsafe { renameat2(-100, a.as_ptr(), -100, b.as_ptr(), 1) };
    if result != 0 {
        return exclusive_fallback(from, to, io::Error::last_os_error());
    }
    sync_directory(to.parent().unwrap())
}
#[cfg(target_os = "macos")]
fn native_no_replace(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> i32;
    }
    let a = CString::new(from.as_os_str().as_bytes()).map_err(super::super::store::error)?;
    let b = CString::new(to.as_os_str().as_bytes()).map_err(super::super::store::error)?;
    // Darwin RENAME_EXCL supplies the same no-overwrite contract.
    if unsafe { renamex_np(a.as_ptr(), b.as_ptr(), 4) } != 0 {
        return exclusive_fallback(from, to, io::Error::last_os_error());
    }
    sync_directory(to.parent().unwrap())
}
#[cfg(unix)]
fn exclusive_fallback(from: &Path, to: &Path, error: io::Error) -> Result<()> {
    // Some network/FUSE volumes lack exclusive rename. A hard link also
    // creates exclusively; ordinary rename would silently clobber a rival.
    if matches!(error.raw_os_error(), Some(22 | 38 | 45 | 95 | 102)) {
        fs::hard_link(from, to).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                io_error(e)
            } else {
                super::fail(
                    crate::support::user_message::codes::CATALOG_FILE_PUBLICATION_UNAVAILABLE,
                )
                .with_detail(e.to_string())
            }
        })?;
        fs::remove_file(from).map_err(io_error)?;
        return sync_directory(to.parent().unwrap());
    }
    Err(io_error(error))
}
/// Probe the actual staging-to-parent move before preparing large files.
/// Returns whether native identity survives it; exclusive semantics are only
/// required by paths that publish a new name or restore retired files.
pub(super) fn probe(parent: &Path, exclusive: bool) -> Result<bool> {
    let id = uuid::Uuid::new_v4().to_string();
    let staging = parent.join(format!(".story-studio-probe-{id}"));
    let a = staging.join("payload");
    let b = parent.join(format!(".story-studio-probe-{id}-destination"));
    let own = super::writes::OwnWrite::begin(
        super::writes::Declaration::new("catalogueProbe")
            .temporary(&staging)
            .temporary(&b),
    );
    let mut reserved_destination = None;
    let result = (|| {
        fs::create_dir(&staging).map_err(io_error)?;
        // Some FAT drivers derive identity from the first cluster, which an
        // empty file lacks: the probe holds data like the files it predicts.
        fs::File::create_new(&a)
            .and_then(|mut file| io::Write::write_all(&mut file, b"1"))
            .map_err(io_error)?;
        let before = super::writes::file_id(&a).ok_or_else(|| {
            super::fail(crate::support::user_message::codes::CATALOG_FILE_VERIFY_FAILED)
        })?;
        if exclusive {
            no_replace(&a, &b).map_err(|e| {
                super::fail(
                    crate::support::user_message::codes::CATALOG_FILE_PUBLICATION_UNAVAILABLE,
                )
                .with_detail(e.to_string())
            })?;
        } else {
            fs::File::create_new(&b).map_err(io_error)?;
            reserved_destination = super::writes::file_id(&b);
            replace(&a, &b)?;
        }
        let stable = super::writes::file_id(&b).as_ref() == Some(&before);
        // Only the successful move authorizes removing this destination.
        fs::remove_file(&b).map_err(io_error)?;
        Ok(stable)
    })();
    let _ = fs::remove_file(&a);
    if reserved_destination
        .as_ref()
        .is_some_and(|id| super::writes::file_id(&b).as_ref() == Some(id))
    {
        let _ = fs::remove_file(&b);
    }
    let _ = fs::remove_dir(&staging);
    own.finish(&result, |_| vec![]);
    result
}
#[cfg(windows)]
fn native_no_replace(from: &Path, to: &Path) -> Result<()> {
    win_move(from, to, 0)
}
#[cfg(windows)]
fn win_move(from: &Path, to: &Path, flags: u32) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let a: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Explorer preview and antivirus readers can transiently deny a move.
    // Retry only native sharing/access errors, with a bounded total delay.
    for attempt in 0..4 {
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), flags | 8) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if attempt == 3 || !matches!(error.raw_os_error(), Some(5 | 32)) {
            return Err(io_error(error));
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    Ok(())
}
pub(super) fn replace(from: &Path, to: &Path) -> Result<()> {
    #[cfg(test)]
    if FAIL_PUBLICATION.with(|v| v.get()) {
        return Err(io_error(io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));
    }
    #[cfg(windows)]
    {
        win_move(from, to, 1)?;
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to).map_err(io_error)?;
    }
    sync_directory(to.parent().unwrap())
}
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    // Windows cannot open a directory with File::open; native moves above use
    // WRITE_THROUGH. This does not promise power-loss durability on a NAS.
    #[cfg(not(windows))]
    {
        fs::File::open(path)
            .map_err(io_error)?
            .sync_all()
            .map_err(io_error)?;
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    pub(crate) static AVAILABLE_BYTES: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}
pub(crate) fn require_space(path: &Path, bytes: u64) -> Result<()> {
    #[cfg(test)]
    let available = AVAILABLE_BYTES
        .with(|value| value.get())
        .map_or_else(|| free_bytes(path), Ok)?;
    #[cfg(not(test))]
    let available = free_bytes(path)?;
    if available < bytes {
        return Err(super::fail(
            crate::support::user_message::codes::CATALOG_FILE_NO_SPACE,
        ));
    }
    Ok(())
}
// POSIX df is the native volume-information utility on both supported Unix
// targets. An absolute path is one argument; no shell or interpolation.
#[cfg(unix)]
fn free_bytes(path: &Path) -> Result<u64> {
    let output = std::process::Command::new("/bin/df")
        .arg("-Pk")
        .arg(path)
        .env("LC_ALL", "C")
        .output()
        .map_err(io_error)?;
    if !output.status.success() {
        return Err(io_error(io::Error::other("Volume capacity unavailable")));
    }
    parse_capacity(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| io_error(io::Error::other("Invalid volume capacity response")))
}
#[cfg(unix)]
fn parse_capacity(text: &str) -> Option<u64> {
    let fields: Vec<_> = text.lines().last()?.split_whitespace().collect();
    let index = fields.iter().position(|s| s.ends_with('%'))?;
    fields
        .get(index.checked_sub(1)?)?
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)
}
#[cfg(windows)]
fn free_bytes(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io_error(io::Error::last_os_error()));
    }
    Ok(available)
}
#[cfg(all(test, unix))]
#[test]
fn capacity_parser_handles_volume_names_and_mount_paths_with_spaces() {
    assert_eq!(parse_capacity("Filesystem 1024-blocks Used Available Capacity Mounted on\nVolume name 100 20 80 20% /Mounted pack volume\n"),Some(80*1024));
    assert_eq!(parse_capacity("no capacity"), None);
}

#[cfg(all(test, unix))]
#[test]
fn unsupported_exclusive_rename_uses_an_exclusive_hard_link() {
    let dir = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("publication-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    let source = dir.join("source");
    let destination = dir.join("destination");
    fs::write(&source, b"original").unwrap();
    exclusive_fallback(&source, &destination, io::Error::from_raw_os_error(95)).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    fs::write(&source, b"rival").unwrap();
    assert_eq!(
        exclusive_fallback(&source, &destination, io::Error::from_raw_os_error(95))
            .unwrap_err()
            .code,
        crate::support::user_message::codes::CATALOG_FILE_NAME_CONFLICT
    );
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    assert_eq!(fs::read(&source).unwrap(), b"rival");
    fs::remove_dir_all(dir).unwrap();
}
