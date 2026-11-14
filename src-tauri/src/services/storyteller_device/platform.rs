//! OS constraints: mount enumeration and native rename-with-replacement on FAT.
//! No hard-link fallback: FAT does not provide hard links.
use super::*;
pub(crate) struct NativeVolumes;
impl Volumes for NativeVolumes {
    fn mounted_removable(&self) -> Result<Vec<PathBuf>> {
        let _guard = access_guard();
        native::mounts()
    }
    fn capacity(&self, root: &Path) -> Result<(u64, u64)> {
        let _guard = access_guard();
        native::capacity(root)
    }
    fn writable(&self, root: &Path) -> Result<bool> {
        #[cfg(unix)]
        {
            Ok(posix_stats(root)?.f_flag & libc::ST_RDONLY == 0
                && !fs::metadata(root)?.permissions().readonly())
        }
        #[cfg(windows)]
        {
            native::writable(root)
        }
    }
}
pub(super) fn replace(from: &Path, to: &Path) -> Result<()> {
    native::replace(from, to)
}
/// File::sync_all maps to FlushFileBuffers on Windows (requires write access).
pub(super) fn sync_file(path: &Path) -> Result<()> {
    crate::support::file_sync::sync_file(path)?;
    Ok(())
}
pub(super) fn move_dir(from: &Path, to: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        native::move_dir(from, to)
    }
    #[cfg(unix)]
    {
        fs::rename(from, to)?;
        Ok(())
    }
}
/// Local directories only (application data). A storyteller volume uses
/// `sync_volume`: on FAT a directory fsync is not a durability barrier.
pub(super) fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path; // MoveFileExW uses WRITE_THROUGH; File::open cannot open directories.
    Ok(())
}
/// Durability barrier for the whole storyteller volume holding `path`: every
/// pending write of this volume (file data, directory entries of renamed or
/// created items, deletions, FAT, FSInfo) reaches the medium before it returns.
/// FAT keeps a renamed item's start cluster and size in that item, not in its
/// parent: a directory fsync leaves them in memory while it already persists
/// the release of the replaced file's clusters, so an unplug in the next
/// minute leaves an entry pointing to free clusters (30 Oct. 2026 incident).
/// An error means "not durable", never "done".
pub(super) fn sync_volume(path: &Path) -> Result<()> {
    native::sync_volume(path)
}
/// Windows: ERROR_ACCESS_DENIED (5) or ERROR_SHARING_VIOLATION (32) when
/// opening the root for the barrier means "barrier unavailable", not failure.
#[cfg_attr(not(windows), allow(dead_code))]
fn root_open_refused(code: Option<i32>) -> bool {
    matches!(code, Some(5 | 32))
}
/// macOS: F_FULLFSYNC refused by msdosfs or the device (ENOTSUP, ENOTTY,
/// EINVAL) falls back to fsync; any other error means "not durable".
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn full_fsync_unsupported(errno: Option<i32>) -> bool {
    matches!(errno, Some(e) if e == libc::ENOTSUP || e == libc::ENOTTY || e == libc::EINVAL)
}
#[test]
fn only_refused_root_opening_makes_the_windows_barrier_unavailable() {
    assert!(root_open_refused(Some(5)) && root_open_refused(Some(32)));
    for other in [
        None,
        Some(0),
        Some(2),
        Some(3),
        Some(19),
        Some(21),
        Some(1117),
    ] {
        assert!(!root_open_refused(other));
    }
}
#[cfg(unix)]
#[test]
fn only_unsupported_full_fsync_falls_back_to_fsync() {
    for errno in [libc::ENOTSUP, libc::ENOTTY, libc::EINVAL] {
        assert!(full_fsync_unsupported(Some(errno)));
    }
    for errno in [None, Some(libc::EIO), Some(libc::ENOSPC), Some(libc::EBADF)] {
        assert!(!full_fsync_unsupported(errno));
    }
}
#[cfg(unix)]
fn output(program: &str, args: &[&std::ffi::OsStr]) -> Result<String> {
    output_until(
        program,
        args,
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    )
}
#[cfg(unix)]
fn output_until(
    program: &str,
    args: &[&std::ffi::OsStr],
    deadline: std::time::Instant,
) -> Result<String> {
    if std::time::Instant::now() >= deadline {
        return Err(Error::Io);
    }
    use std::io::Read;
    use std::process::{Command, Stdio};
    const LIMIT: u64 = 1024 * 1024;
    let mut child = Command::new(program)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().ok_or(Error::Io)?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let mut bytes = None;
    loop {
        match rx.try_recv() {
            Ok(Ok(v)) if v.len() as u64 <= LIMIT => bytes = Some(v),
            Ok(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Io);
            }
            Err(_) => {}
        }
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Io);
            }
        };
        if let Some(status) = status {
            if let Some(bytes) = bytes {
                return if status.success() {
                    String::from_utf8(bytes).map_err(|_| Error::Io)
                } else {
                    Err(Error::Io)
                };
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Io);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
// df is resolved through PATH and bounded by the same runner as diskutil.
#[cfg(unix)]
fn capacity(root: &Path) -> Result<(u64, u64)> {
    let out = output("df", &["-Pk".as_ref(), root.as_os_str()])?;
    parse_capacity(&out).ok_or(Error::Io)
}
#[cfg(unix)]
fn parse_capacity(out: &str) -> Option<(u64, u64)> {
    let fields: Vec<_> = out.lines().last()?.split_whitespace().collect();
    let p = fields.iter().position(|s| s.ends_with('%'))?;
    Some((
        fields
            .get(p.checked_sub(1)?)?
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)?,
        fields
            .get(p.checked_sub(3)?)?
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)?,
    ))
}
#[cfg(target_os = "linux")]
mod native {
    use super::*;
    // mountinfo is kernel-provided and does not depend on lsblk or udev.
    // Restrict probing to FAT-family mounts, then use the shared device filter.
    pub(super) fn parse(text: &str) -> Result<Vec<PathBuf>> {
        use std::os::unix::ffi::OsStringExt;
        let mut paths = Vec::new();
        'lines: for line in text.lines() {
            let Some((left, right)) = line.split_once(" - ") else {
                continue;
            };
            if !matches!(
                right.split_whitespace().next(),
                Some("vfat" | "msdos" | "exfat")
            ) {
                continue;
            }
            let Some(path) = left.split_whitespace().nth(4) else {
                continue;
            };
            let mut decoded = Vec::new();
            let raw = path.as_bytes();
            let mut i = 0;
            while i < raw.len() {
                if raw[i] == b'\\' {
                    if i + 3 >= raw.len()
                        || !raw[i + 1..i + 4].iter().all(|v| (b'0'..=b'7').contains(v))
                    {
                        continue 'lines;
                    }
                    let value = ((raw[i + 1] - b'0') as u16) * 64
                        + ((raw[i + 2] - b'0') as u16) * 8
                        + (raw[i + 3] - b'0') as u16;
                    let Ok(value) = u8::try_from(value) else {
                        continue 'lines;
                    };
                    decoded.push(value);
                    i += 4;
                } else {
                    decoded.push(raw[i]);
                    i += 1;
                }
            }
            paths.push(PathBuf::from(std::ffi::OsString::from_vec(decoded)));
        }
        Ok(paths)
    }
    pub(super) fn mounts() -> Result<Vec<PathBuf>> {
        parse(&fs::read_to_string("/proc/self/mountinfo")?)
    }
    pub(super) fn capacity(root: &Path) -> Result<(u64, u64)> {
        super::capacity(root)
    }
    // Linux FAT rename can leave two entries sharing clusters after a cut.
    // Recovery must retain temporaries until explicit restoration.
    pub(super) fn replace(from: &Path, to: &Path) -> Result<()> {
        fs::rename(from, to)?;
        Ok(())
    }
    // vfat fsync of a directory writes its own buffers, the FAT and a cache
    // flush, but the entry of a child renamed into it stays in the child's
    // dirty inode until writeback (about 30 s, then 30 s more for the buffer).
    // syncfs writes every dirty inode and buffer of this filesystem only,
    // FSInfo included, and reports writeback errors; fsync on the same
    // descriptor then issues the device cache flush.
    pub(super) fn sync_volume(path: &Path) -> Result<()> {
        use std::os::fd::AsRawFd;
        let file = fs::File::open(path)?;
        // SAFETY: live descriptor owned by `file` for the duration of the call.
        if unsafe { libc::syncfs(file.as_raw_fd()) } != 0 {
            return Err(Error::Io);
        }
        file.sync_all()?;
        Ok(())
    }
    #[test]
    fn linux_injected_mountinfo() {
        assert_eq!(
            parse(
                r"1 0 8:1 / /fake/mounted\040volume rw - vfat /dev/fake rw
2 0 8:2 / /ignored rw - ext4 /dev/other rw
4 0 8:4 / /bad\09 rw - vfat /dev/bad rw
5 0 8:5 / /overflow\777 rw - vfat /dev/bad rw
3 0 8:3 / /fake/a\134b\011c rw - exfat /dev/third rw"
            )
            .unwrap(),
            vec![
                PathBuf::from("/fake/mounted volume"),
                PathBuf::from("/fake/a\\b\tc")
            ]
        );
    }
}
#[cfg(target_os = "macos")]
mod native {
    use super::*;
    fn values(xml: &str, key: &str) -> Result<Vec<String>> {
        let doc = roxmltree::Document::parse_with_options(
            xml,
            roxmltree::ParsingOptions {
                allow_dtd: true,
                ..Default::default()
            },
        )
        .map_err(|_| Error::Io)?;
        Ok(doc
            .descendants()
            .filter(|n| n.has_tag_name("key") && n.text() == Some(key))
            .filter_map(|n| n.next_sibling_element())
            .filter_map(|n| n.text().map(str::to_owned))
            .collect())
    }
    pub(super) fn mounts() -> Result<Vec<PathBuf>> {
        // diskutil restricts enumeration to external physical disks, including
        // removable USB volumes whose medium itself is marked non-removable.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let xml = output_until(
            "/usr/sbin/diskutil",
            &[
                "list".as_ref(),
                "-plist".as_ref(),
                "external".as_ref(),
                "physical".as_ref(),
            ],
            deadline,
        )?;
        let mut out = Vec::new();
        for id in values(&xml, "DeviceIdentifier")? {
            if !id.starts_with("disk") || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
                continue;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            let Ok(info) = output_until(
                "/usr/sbin/diskutil",
                &["info".as_ref(), "-plist".as_ref(), id.as_ref()],
                deadline,
            ) else {
                continue;
            };
            out.extend(
                values(&info, "MountPoint")
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from),
            );
        }
        Ok(out)
    }
    pub(super) fn capacity(root: &Path) -> Result<(u64, u64)> {
        super::capacity(root)
    }
    // msdosfs removes the target entry before rename: a power cut can leave
    // .pi absent. There is no atomic replacement primitive on FAT here.
    pub(super) fn replace(from: &Path, to: &Path) -> Result<()> {
        fs::rename(from, to)?;
        Ok(())
    }
    // macOS has no syncfs and its sync(2) does not wait. sync_volume_np
    // (<sys/mount.h>, macOS 10.8+) syncs one mounted volume and waits; it
    // returns 0 or an errno value. F_FULLFSYNC then asks the device to flush
    // its cache; where msdosfs or the device refuses it, fsync is the documented
    // fallback.
    pub(super) fn sync_volume(path: &Path) -> Result<()> {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" {
            fn sync_volume_np(path: *const libc::c_char, flags: libc::c_int) -> libc::c_int;
        }
        // <sys/mount.h>: SYNC_VOLUME_FULLSYNC (0x01) | SYNC_VOLUME_WAIT (0x02).
        const FLAGS: libc::c_int = 0x03;
        let c_path =
            std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::UnsafePath)?;
        // SAFETY: live NUL-terminated path; flags are a plain integer.
        if unsafe { sync_volume_np(c_path.as_ptr(), FLAGS) } != 0 {
            return Err(Error::Io);
        }
        let file = fs::File::open(path)?;
        // SAFETY: live descriptor owned by `file`; F_FULLFSYNC takes no argument.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } == -1 {
            let errno = io::Error::last_os_error().raw_os_error();
            if !super::full_fsync_unsupported(errno) {
                return Err(Error::Io);
            }
            file.sync_all()?;
        }
        Ok(())
    }
    #[test]
    fn macos_injected_diskutil() {
        assert_eq!(
            values(
                r#"<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist><dict><key>MountPoint</key><string>/fake/Volume</string></dict></plist>"#,
                "MountPoint"
            )
            .unwrap(),
            vec!["/fake/Volume"]
        );
    }
}
#[cfg(windows)]
mod native {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetThreadErrorMode(mode: u32, old: *mut u32) -> i32;
        #[cfg(test)]
        fn GetThreadErrorMode() -> u32;
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn GetVolumePathNameW(path: *const u16, root: *mut u16, length: u32) -> i32;
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
        fn GetDiskFreeSpaceW(
            root: *const u16,
            sectors: *mut u32,
            bytes: *mut u32,
            free: *mut u32,
            total: *mut u32,
        ) -> i32;
        fn GetVolumeInformationW(
            root: *const u16,
            name: *mut u16,
            name_len: u32,
            serial: *mut u32,
            max: *mut u32,
            flags: *mut u32,
            fs_name: *mut u16,
            fs_len: u32,
        ) -> i32;
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        fn GetFileAttributesW(path: *const u16) -> u32;
        fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
    }
    pub(crate) struct AccessGuard(Option<u32>);
    pub(crate) fn access_guard() -> AccessGuard {
        let mut old = 0;
        // Removable drives without media must not open a modal "No disk" box.
        // SAFETY: writable old-mode output; mode affects this thread only.
        let ok = unsafe { SetThreadErrorMode(1, &mut old) };
        AccessGuard((ok != 0).then_some(old))
    }
    impl Drop for AccessGuard {
        fn drop(&mut self) {
            if let Some(old) = self.0 {
                // SAFETY: restores the mode on the calling thread.
                unsafe {
                    SetThreadErrorMode(old, std::ptr::null_mut());
                }
            }
        }
    }
    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    fn letters(mask: u32) -> impl Iterator<Item = PathBuf> {
        (0..26)
            .filter(move |i| mask & (1 << i) != 0)
            .map(|i| PathBuf::from(format!("{}:\\", (b'A' + i) as char)))
    }
    pub(super) fn mounts() -> Result<Vec<PathBuf>> {
        // Windows exposes mounted removable drive letters with DRIVE_REMOVABLE.
        // SAFETY: API has no pointer parameters.
        let mask = unsafe { GetLogicalDrives() };
        if mask == 0 {
            return Err(Error::Io);
        }
        Ok(letters(mask)
            .filter(|p| {
                // SAFETY: live NUL-terminated UTF-16 root.
                unsafe { GetDriveTypeW(wide(p).as_ptr()) == 2 }
            })
            .collect())
    }
    pub(super) fn capacity(root: &Path) -> Result<(u64, u64)> {
        let (mut available, mut total) = (0, 0);
        // SAFETY: live UTF-16 path, writable u64 outputs; last output optional.
        if unsafe {
            GetDiskFreeSpaceExW(
                wide(root).as_ptr(),
                &mut available,
                &mut total,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(Error::Io);
        }
        Ok((available, total))
    }

    pub(super) fn eject(root: &Path) -> Result<()> {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateFileW(
                name: *const u16,
                access: u32,
                share: u32,
                security: *mut c_void,
                creation: u32,
                flags: u32,
                template: *mut c_void,
            ) -> *mut c_void;
            fn DeviceIoControl(
                handle: *mut c_void,
                code: u32,
                input: *mut c_void,
                input_len: u32,
                output: *mut c_void,
                output_len: u32,
                returned: *mut u32,
                overlapped: *mut c_void,
            ) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        let text = root.to_str().ok_or(Error::UnsafePath)?;
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        if text.len() != 3
            || text.as_bytes()[1] != b':'
            || text.as_bytes()[2] != 92
            || !text.as_bytes()[0].is_ascii_alphabetic()
        {
            return Err(Error::UnsafePath);
        }
        let volume = PathBuf::from(format!(r"\\.\{}", &text[..2]));
        // SAFETY: live NUL-terminated volume name, no security/template pointers.
        let handle = unsafe {
            CreateFileW(
                wide(&volume).as_ptr(),
                0xc0000000,
                3,
                std::ptr::null_mut(),
                3,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err(Error::Io);
        }
        struct Handle(*mut c_void);
        impl Drop for Handle {
            fn drop(&mut self) {
                /* SAFETY: owned open handle. */
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let handle = Handle(handle);
        // winioctl.h: lock exclusive access, flush/dismount the filesystem,
        // then request media removal. Failure stops before the next request.
        const FSCTL_LOCK_VOLUME: u32 = 0x00090018;
        const FSCTL_DISMOUNT_VOLUME: u32 = 0x00090020;
        const IOCTL_STORAGE_EJECT_MEDIA: u32 = 0x002d4808;
        for code in [
            FSCTL_LOCK_VOLUME,
            FSCTL_DISMOUNT_VOLUME,
            IOCTL_STORAGE_EJECT_MEDIA,
        ] {
            let mut returned = 0;
            // SAFETY: owned handle; these control requests have no data buffers.
            if unsafe {
                DeviceIoControl(
                    handle.0,
                    code,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(Error::Io);
            }
        }
        Ok(())
    }
    pub(super) fn allocation_unit(root: &Path) -> Result<u64> {
        let root = volume_root(root)?;
        let (mut sectors, mut bytes, mut free, mut total) = (0, 0, 0, 0);
        // SAFETY: live root and writable DWORD outputs.
        if unsafe {
            GetDiskFreeSpaceW(
                wide(&root).as_ptr(),
                &mut sectors,
                &mut bytes,
                &mut free,
                &mut total,
            )
        } == 0
        {
            return Err(Error::Io);
        }
        let unit = u64::from(sectors) * u64::from(bytes);
        if unit == 0 {
            return Err(Error::Io);
        }
        Ok(unit)
    }
    pub(super) fn writable(root: &Path) -> Result<bool> {
        let root = volume_root(root)?;
        let mut flags = 0;
        // SAFETY: live root; all unused outputs are optional, flags writable.
        if unsafe {
            GetVolumeInformationW(
                wide(&root).as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut flags,
                std::ptr::null_mut(),
                0,
            )
        } == 0
        {
            return Err(Error::Io);
        }
        Ok(flags & 0x80000 == 0)
    }
    // FlushFileBuffers on the volume handle (\\.\X:) requires administrator
    // rights. fastfat flushes the whole volume (FAT, directories, open files,
    // then the device) when the flushed handle is its root directory, which a
    // standard user may open for writing with backup semantics. Where the
    // system refuses that opening (NTFS ACLs, another process holding the root),
    // the barrier is unavailable: as before it existed, renames keep their
    // WRITE_THROUGH and the gesture is not refused. A failed flush on an
    // opened root remains an error (not durable).
    pub(super) fn sync_volume(path: &Path) -> Result<()> {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        // Query the actual mount point, also for a directory on a test volume.
        let root = volume_root(path)?;
        let opened = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(root);
        let file = match opened {
            Ok(file) => file,
            Err(error) if super::root_open_refused(error.raw_os_error()) => {
                super::state::barrier_unavailable_warning();
                return Ok(());
            }
            Err(error) => return Err(error.into()),
        };
        file.sync_all()?;
        Ok(())
    }
    fn volume_root(path: &Path) -> Result<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        if !path.is_absolute() {
            return Err(Error::UnsafePath);
        }
        // These Win32 volume APIs require a mount root with a trailing slash,
        // not an arbitrary directory or the bare prefix yielded by ancestors.
        let mut buffer = vec![0u16; 32768];
        // SAFETY: input and output buffers live for the call; length is in UTF-16 units.
        if unsafe {
            GetVolumePathNameW(
                wide(path).as_ptr(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let end = buffer.iter().position(|c| *c == 0).ok_or(Error::Io)?;
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..end])))
    }
    #[test]
    fn volume_barrier_uses_a_root_directory_not_a_bare_prefix() {
        for path in [
            std::env::temp_dir(),
            std::env::temp_dir().canonicalize().unwrap(),
        ] {
            let root = volume_root(&path).unwrap();
            assert!(root.is_absolute());
            assert!(root.is_dir());
            assert_eq!(
                allocation_unit(&path).unwrap(),
                allocation_unit(&root).unwrap()
            );
            assert_eq!(writable(&path).unwrap(), writable(&root).unwrap());
        }
        assert!(volume_root(Path::new("relative")).is_err());
    }
    pub(super) fn move_dir(from: &Path, to: &Path) -> Result<()> {
        // FAT folder moves must reach storage before publishing a new playlist.
        // SAFETY: both UTF-16 paths live for the native call. No replacement.
        if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), 8) } == 0 {
            return Err(Error::Io);
        }
        Ok(())
    }
    pub(super) fn replace(from: &Path, to: &Path) -> Result<()> {
        // FAT has no atomic ReplaceFileW. Clear only HIDDEN on an existing
        // target: Windows can otherwise deny replacement of Lunii's hidden .pi.
        // Restore it on failure and on the newly published file on success.
        const HIDDEN: u32 = 2;
        const NORMAL: u32 = 0x80;
        let target = wide(to);
        // SAFETY: live NUL-terminated UTF-16 path.
        let attributes = unsafe { GetFileAttributesW(target.as_ptr()) };
        let hidden = attributes != u32::MAX && attributes & HIDDEN != 0;
        if hidden {
            let cleared = attributes & !HIDDEN;
            // SAFETY: path is live and only file attributes are changed.
            if unsafe {
                SetFileAttributesW(target.as_ptr(), if cleared == 0 { NORMAL } else { cleared })
            } == 0
            {
                return Err(Error::Io);
            }
        }
        // SAFETY: both UTF-16 paths live for the native call.
        let ok = unsafe { MoveFileExW(wide(from).as_ptr(), target.as_ptr(), 1 | 8) } != 0;
        if hidden {
            // SAFETY: same existing target after failure, or its replacement.
            if unsafe { SetFileAttributesW(target.as_ptr(), attributes) } == 0 {
                super::state::cleanup_warning();
            }
        }
        if ok {
            Ok(())
        } else {
            Err(Error::Io)
        }
    }
    #[test]
    fn windows_eject_rejects_non_drive_roots_before_native_access() {
        for path in [r"C:\folder", r"\\server\share", r"C:", r"1:\"] {
            assert_eq!(eject(Path::new(path)), Err(Error::UnsafePath));
        }
    }
    #[test]
    fn windows_hidden_playlist_is_readable_and_replaceable() {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hidden-pi-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let target = dir.join(".pi");
        let temp = dir.join("pending");
        fs::write(&target, []).unwrap();
        // SAFETY: live local temporary path, no device access.
        assert_ne!(unsafe { SetFileAttributesW(wide(&target).as_ptr(), 2) }, 0);
        assert_eq!(read::playlist(&dir).unwrap(), Vec::<Uuid>::new());
        let id = Uuid::new_v4();
        fs::write(&temp, id.as_bytes()).unwrap();
        replace(&temp, &target).unwrap();
        assert_eq!(read::playlist(&dir).unwrap(), vec![id]);
        super::sync_file(&target).unwrap();
        let content = dir.join("content");
        let parked = dir.join("parked");
        fs::create_dir(&content).unwrap();
        super::move_dir(&content, &parked).unwrap();
        assert!(parked.is_dir() && !content.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn windows_no_disk_guard_restores_thread_mode() {
        // SAFETY: reads the current thread's mode, without touching a drive.
        let old = unsafe { GetThreadErrorMode() };
        {
            let _guard = access_guard();
            // SAFETY: same thread, no pointer parameters.
            assert_ne!(unsafe { GetThreadErrorMode() } & 1, 0);
        }
        // SAFETY: reads this thread's mode after guard destruction.
        assert_eq!(unsafe { GetThreadErrorMode() }, old);
    }
    #[test]
    fn windows_injected_drive_mask() {
        assert_eq!(
            letters(1 << 4).collect::<Vec<_>>(),
            vec![PathBuf::from("E:\\")]
        );
    }
}
#[cfg(all(test, unix))]
#[test]
fn capacity_with_spaces() {
    assert_eq!(parse_capacity("Filesystem 1024-blocks Used Available Capacity Mounted on\nA volume 100 20 80 20% /fake/path with spaces\n"),Some((81920,102400)));
}

#[cfg(windows)]
pub(crate) fn access_guard() -> impl Drop {
    native::access_guard()
}
#[cfg(not(windows))]
pub(crate) fn access_guard() -> impl Drop {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {}
    }
    Guard
}
pub(crate) fn is_reparse(metadata: &fs::Metadata) -> bool {
    // Windows junctions and volume mount points are reparse points even when
    // file_type().is_symlink() is false; keep this native rule in the adapter.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

#[cfg(all(test, unix))]
#[test]
fn subprocess_output_and_runtime_are_bounded() {
    assert_eq!(
        output(
            "/usr/bin/head",
            &["-c".as_ref(), "1048577".as_ref(), "/dev/zero".as_ref()]
        ),
        Err(Error::Io)
    );
    assert_eq!(output("/bin/sleep", &["6".as_ref()]), Err(Error::Io));
}

#[cfg(all(test, unix))]
#[test]
fn subprocesses_share_one_deadline() {
    let start = std::time::Instant::now();
    let deadline = start + std::time::Duration::from_millis(100);
    assert_eq!(
        output_until("/bin/sleep", &["1".as_ref()], deadline),
        Err(Error::Io)
    );
    // The expired shared budget prevents even starting the next process.
    assert_eq!(
        output_until("/bin/sleep", &["1".as_ref()], deadline),
        Err(Error::Io)
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
}

#[cfg(unix)]
fn posix_stats(root: &Path) -> Result<libc::statvfs> {
    use std::os::unix::ffi::OsStrExt;
    let path =
        std::ffi::CString::new(root.as_os_str().as_bytes()).map_err(|_| Error::UnsafePath)?;
    let mut stats = std::mem::MaybeUninit::uninit();
    // SAFETY: live C path and correctly sized writable statvfs output.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(Error::Io);
    }
    // SAFETY: initialized by successful statvfs.
    Ok(unsafe { stats.assume_init() })
}
pub(super) fn allocation_unit(root: &Path) -> Result<u64> {
    #[cfg(unix)]
    {
        let stat = posix_stats(root)?;
        let unit = if stat.f_frsize == 0 {
            stat.f_bsize
        } else {
            stat.f_frsize
        };
        if unit == 0 {
            return Err(Error::Io);
        }
        Ok(unit as u64)
    }
    #[cfg(windows)]
    {
        native::allocation_unit(root)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Volume {
    pub native_id: String,
    pub root: Option<PathBuf>,
}
/// Detection does not mount or inspect story payloads. Linux's volume label is
/// a candidate only; opening validates the device marker through the driver.
pub(crate) fn discover() -> Result<Vec<Volume>> {
    #[cfg(target_os = "linux")]
    {
        let mounted = detect(&NativeVolumes).unwrap_or_default();
        parse_lsblk_with_mounts(
            &output(
                "lsblk",
                &[
                    "--json".as_ref(),
                    "--paths".as_ref(),
                    "--output".as_ref(),
                    "NAME,LABEL,MOUNTPOINT,TYPE".as_ref(),
                ],
            )?,
            &mounted,
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(detect(&NativeVolumes)?
            .into_iter()
            .map(|root| Volume {
                native_id: root.to_string_lossy().into_owned(),
                root: Some(root),
            })
            .collect())
    }
}
#[cfg(all(test, target_os = "linux"))]
fn parse_lsblk(text: &str) -> Result<Vec<Volume>> {
    parse_lsblk_with_mounts(text, &[])
}
#[cfg(target_os = "linux")]
fn parse_lsblk_with_mounts(text: &str, mounted: &[PathBuf]) -> Result<Vec<Volume>> {
    fn visit(value: &serde_json::Value, volumes: &mut Vec<Volume>, mounted: &[PathBuf]) {
        if value["mountpoint"]
            .as_str()
            .is_some_and(|p| mounted.iter().any(|root| root == Path::new(p)))
            || value["label"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("LUNII") || s.eq_ignore_ascii_case("FLAM"))
        {
            if let Some(name) = value["name"]
                .as_str()
                .filter(|s| s.starts_with("/dev/") && !s.contains(".."))
            {
                volumes.push(Volume {
                    native_id: name.into(),
                    root: value["mountpoint"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(PathBuf::from),
                });
            }
        }
        if let Some(children) = value["children"].as_array() {
            for child in children {
                visit(child, volumes, mounted);
            }
        }
    }
    let raw: serde_json::Value = serde_json::from_str(text).map_err(|_| Error::Io)?;
    let mut volumes = Vec::new();
    for value in raw["blockdevices"].as_array().ok_or(Error::Io)? {
        visit(value, &mut volumes, mounted);
    }
    Ok(volumes)
}
// Cached roots can outlive unmount/ejection. Validate the device marker before
// reusing one; Linux then reaches its explicit udisks mount path immediately.
fn mounted_root(volume: &Volume) -> Option<PathBuf> {
    volume
        .root
        .as_ref()
        .filter(|root| safe(&root.join(".md"), false).is_ok() || flam::is_device(root))
        .cloned()
}
pub(crate) fn mount(volume: &Volume) -> Result<PathBuf> {
    if let Some(root) = mounted_root(volume) {
        return Ok(root);
    }
    #[cfg(target_os = "linux")]
    {
        output(
            "udisksctl",
            &[
                "mount".as_ref(),
                "--no-user-interaction".as_ref(),
                "--block-device".as_ref(),
                volume.native_id.as_ref(),
            ],
        )?;
        discover()?
            .into_iter()
            .find(|v| v.native_id == volume.native_id)
            .and_then(|v| v.root)
            .ok_or(Error::Io)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(Error::Io)
    }
}
pub(crate) fn eject(volume: &Volume) -> Result<()> {
    // Also covers direct driver users outside the host's reservation registry.
    let _guard = access_guard();
    let mutation = writes::mutation(
        volume
            .root
            .as_deref()
            .unwrap_or(Path::new(&volume.native_id)),
    );
    let _lock = mutation.try_lock().map_err(|_| Error::Busy)?;
    #[cfg(target_os = "linux")]
    {
        if volume.root.is_some() {
            output(
                "udisksctl",
                &[
                    "unmount".as_ref(),
                    "--no-user-interaction".as_ref(),
                    "--block-device".as_ref(),
                    volume.native_id.as_ref(),
                ],
            )?;
        }
        // Power-off is best effort: udisks may deny it without authentication,
        // while successful unmount already permits safe unplugging.
        let _ = output(
            "udisksctl",
            &[
                "power-off".as_ref(),
                "--no-user-interaction".as_ref(),
                "--block-device".as_ref(),
                volume.native_id.as_ref(),
            ],
        );
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        macos_eject_with(volume, output)
    }
    #[cfg(windows)]
    {
        native::eject(volume.root.as_deref().ok_or(Error::Io)?)
    }
}
#[cfg(all(test, target_os = "linux"))]
#[test]
fn linux_unmounted_and_mounted_candidates_without_device_access() {
    let volumes = parse_lsblk(r#"{"blockdevices":[{"name":"/dev/fake","children":[{"name":"/dev/fake1","label":"LUNII","mountpoint":null},{"name":"/dev/fake2","label":"LUNII","mountpoint":"/fake/mount"},{"name":"/dev/ignore","label":"OTHER"}]}]}"#).unwrap();
    assert_eq!(volumes.len(), 2);
    assert!(volumes[0].root.is_none());
    assert_eq!(volumes[1].root.as_deref(), Some(Path::new("/fake/mount")));
}

#[cfg(target_os = "macos")]
fn macos_eject_with(
    volume: &Volume,
    mut run: impl FnMut(&str, &[&std::ffi::OsStr]) -> Result<String>,
) -> Result<()> {
    let root = volume
        .root
        .as_deref()
        .unwrap_or(Path::new(&volume.native_id));
    if !root.is_absolute() {
        return Err(Error::UnsafePath);
    }
    run("/usr/sbin/diskutil", &["eject".as_ref(), root.as_os_str()])?;
    Ok(())
}
#[cfg(all(test, target_os = "macos"))]
#[test]
fn macos_eject_passes_one_volume_argument_and_propagates_failure() {
    let volume = Volume {
        native_id: "/Volumes/fake Lunii".into(),
        root: Some("/Volumes/fake Lunii".into()),
    };
    let mut calls = 0;
    assert_eq!(
        macos_eject_with(&volume, |program, args| {
            calls += 1;
            assert_eq!(program, "/usr/sbin/diskutil");
            assert_eq!(
                args,
                &[
                    std::ffi::OsStr::new("eject"),
                    std::ffi::OsStr::new("/Volumes/fake Lunii")
                ]
            );
            Err(Error::Io)
        }),
        Err(Error::Io)
    );
    assert_eq!(calls, 1);
}
#[cfg(all(test, target_os = "linux"))]
#[test]
fn linux_discovery_merges_label_and_mountinfo_candidates() {
    let mounted = vec![PathBuf::from("/fake/renamed")];
    let volumes = parse_lsblk_with_mounts(r#"{"blockdevices":[{"name":"/dev/fake1","label":"LUNII","mountpoint":null},{"name":"/dev/fake2","label":"RENAMED","mountpoint":"/fake/renamed"},{"name":"/dev/fake3","label":"OTHER","mountpoint":"/fake/other"}]}"#, &mounted).unwrap();
    assert_eq!(volumes.len(), 2);
    assert_eq!(volumes[1].native_id, "/dev/fake2");
    assert_eq!(volumes[1].root.as_deref(), Some(Path::new("/fake/renamed")));
}

#[cfg(all(test, target_os = "linux"))]
#[test]
fn linux_discovers_flam_before_mount_without_treating_other_labels_as_devices() {
    let volumes = parse_lsblk(r#"{"blockdevices":[{"name":"/dev/fake1","label":"flam","mountpoint":null},{"name":"/dev/fake2","label":"OTHER","mountpoint":null}]}"#).unwrap();
    assert_eq!(
        volumes,
        vec![Volume {
            native_id: "/dev/fake1".into(),
            root: None
        }]
    );
}

#[cfg(test)]
#[test]
fn cached_mount_is_reused_only_while_device_marker_is_present() {
    let root = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("cached-mount-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    fs::write(root.join(".md"), []).unwrap();
    let volume = Volume {
        native_id: "/fake/device".into(),
        root: Some(root.clone()),
    };
    assert_eq!(mounted_root(&volume), Some(root.clone()));
    fs::remove_file(root.join(".md")).unwrap();
    assert_eq!(mounted_root(&volume), None);
    fs::write(root.join(".mdf"), []).unwrap();
    assert_eq!(mounted_root(&volume), Some(root.clone()));
    fs::remove_file(root.join(".mdf")).unwrap();
    fs::remove_dir(root).unwrap();
}

#[cfg(all(test, target_os = "macos"))]
#[test]
fn macos_eject_accepts_native_id_after_unmount() {
    let volume = Volume {
        native_id: "/dev/disk99".into(),
        root: None,
    };
    macos_eject_with(&volume, |program, args| {
        assert_eq!(program, "/usr/sbin/diskutil");
        assert_eq!(
            args,
            &[
                std::ffi::OsStr::new("eject"),
                std::ffi::OsStr::new("/dev/disk99")
            ]
        );
        Ok(String::new())
    })
    .unwrap();
}
