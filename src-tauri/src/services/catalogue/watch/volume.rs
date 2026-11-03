//! Native adapter: is a source on a network volume?
//!
//! Native notifications are not reliable on network shares (NFS, SMB, AFP,
//! WebDAV, FUSE network file systems): changes made by another machine may
//! never be reported, without any watcher error. Such sources are watched by
//! periodic polling instead. Each operating system exposes the volume type
//! differently, hence the confined branches below; an undetermined volume is
//! treated as local (native watching, plus the periodic reconciliation).
use std::path::Path;

/// Network file-system type names, as reported by Linux and macOS.
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", test)),
    allow(dead_code)
)]
fn is_network_type(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "nfs"
            | "nfs4"
            | "cifs"
            | "smb"
            | "smb2"
            | "smb3"
            | "smbfs"
            | "afpfs"
            | "webdav"
            | "davfs"
            | "ncpfs"
            | "afs"
            | "9p"
            | "ceph"
            | "glusterfs"
    ) || name.starts_with("fuse.sshfs")
        || name.starts_with("fuse.rclone")
        || name.starts_with("fuse.davfs")
        || name.starts_with("fuse.gvfsd-fuse")
        || name.starts_with("fuse.smbnetfs")
}

/// Windows UNC paths (`\\server\share`, verbatim or not) always designate a
/// network share; plain path parsing, valid on every platform.
fn is_unc(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(std::path::Component::Prefix(prefix))
            if matches!(
                prefix.kind(),
                std::path::Prefix::UNC(..) | std::path::Prefix::VerbatimUNC(..)
            )
    )
}

pub fn is_network(path: &Path) -> bool {
    is_unc(path) || native::is_network(path)
}

/// Linux: the mount table of the process gives the file-system type of the
/// longest mount point containing the path.
#[cfg(target_os = "linux")]
mod native {
    use std::path::{Path, PathBuf};

    fn unescape(field: &str) -> String {
        let bytes = field.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'\\' && index + 3 < bytes.len() {
                if let Ok(value) = u8::from_str_radix(&field[index + 1..index + 4], 8) {
                    out.push(value);
                    index += 4;
                    continue;
                }
            }
            out.push(bytes[index]);
            index += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    pub(super) fn mount_type(table: &str, path: &Path) -> Option<String> {
        let mut best: Option<(usize, String)> = None;
        for line in table.lines() {
            let Some((left, right)) = line.split_once(" - ") else {
                continue;
            };
            let Some(mount_point) = left.split(' ').nth(4).map(unescape) else {
                continue;
            };
            let Some(kind) = right.split(' ').next() else {
                continue;
            };
            let mount_point = PathBuf::from(mount_point);
            if path.starts_with(&mount_point) {
                let depth = mount_point.components().count();
                if best.as_ref().is_none_or(|(d, _)| depth >= *d) {
                    best = Some((depth, kind.to_owned()));
                }
            }
        }
        best.map(|(_, kind)| kind)
    }

    pub fn is_network(path: &Path) -> bool {
        std::fs::read_to_string("/proc/self/mountinfo")
            .ok()
            .and_then(|table| mount_type(&table, path))
            .is_some_and(|kind| super::is_network_type(&kind))
    }
}

/// macOS: `statfs` reports the file-system type name and whether the volume
/// is local (`MNT_LOCAL`). Layout of `struct statfs` with 64-bit inodes, the
/// only layout on Apple Silicon; a trailing reserve keeps the buffer larger
/// than the system structure.
#[cfg(target_os = "macos")]
mod native {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path};

    #[repr(C)]
    struct StatFs {
        bsize: u32,
        iosize: i32,
        blocks: u64,
        bfree: u64,
        bavail: u64,
        files: u64,
        ffree: u64,
        fsid: [i32; 2],
        owner: u32,
        kind: u32,
        flags: u32,
        fssubtype: u32,
        fstypename: [u8; 16],
        mntonname: [u8; 1024],
        mntfromname: [u8; 1024],
        flags_ext: u32,
        reserved: [u32; 7],
        margin: [u8; 256],
    }

    const MNT_LOCAL: u32 = 0x0000_1000;

    unsafe extern "C" {
        fn statfs(path: *const std::ffi::c_char, buffer: *mut StatFs) -> i32;
    }

    pub fn is_network(path: &Path) -> bool {
        let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: zeroed plain-old-data buffer larger than `struct statfs`,
        // valid NUL-terminated path; the call only writes into the buffer.
        let mut buffer: StatFs = unsafe { std::mem::zeroed() };
        if unsafe { statfs(name.as_ptr(), &mut buffer) } != 0 {
            return false;
        }
        let end = buffer.fstypename.iter().position(|b| *b == 0).unwrap_or(16);
        let kind = String::from_utf8_lossy(&buffer.fstypename[..end]);
        buffer.flags & MNT_LOCAL == 0 || super::is_network_type(&kind)
    }
}

/// Windows: a mapped network drive is reported as `DRIVE_REMOTE` for its
/// root; UNC paths are recognised by their prefix above.
#[cfg(windows)]
mod native {
    use std::{os::windows::ffi::OsStrExt, path::Path};

    const DRIVE_REMOTE: u32 = 4;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }

    pub fn is_network(path: &Path) -> bool {
        let Some(std::path::Component::Prefix(prefix)) = path.components().next() else {
            return false;
        };
        let letter = match prefix.kind() {
            std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => letter,
            _ => return false,
        };
        let root: Vec<u16> = std::ffi::OsStr::new(&format!("{}:\\", letter as char))
            .encode_wide()
            .chain(Some(0))
            .collect();
        // SAFETY: NUL-terminated UTF-16 root path; the call reads it only.
        unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod native {
    pub fn is_network(_: &std::path::Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_type_names_and_unc_prefix() {
        for kind in ["nfs4", "cifs", "smbfs", "fuse.sshfs", "afpfs", "webdav"] {
            assert!(is_network_type(kind), "{kind}");
        }
        for kind in ["ext4", "btrfs", "apfs", "ntfs", "tmpfs", "fuse.portal"] {
            assert!(!is_network_type(kind), "{kind}");
        }
        assert!(!is_unc(Path::new("/srv/packs")));
        assert!(!is_network(&std::env::temp_dir()) || cfg!(not(target_os = "linux")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_unc_paths_are_network() {
        assert!(is_unc(Path::new(r"\\nas\packs\a.zip")));
        assert!(is_unc(Path::new(r"\\?\UNC\nas\packs")));
        assert!(!is_unc(Path::new(r"C:\packs")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_mount_table_longest_prefix() {
        let table = "\
22 1 0:21 / / rw - btrfs /dev/sda2 rw
40 22 0:40 / /mnt/nas\\040packs rw - cifs //nas/packs rw
41 40 0:41 / /mnt/nas\\040packs/local rw - ext4 /dev/sdb1 rw";
        assert_eq!(
            native::mount_type(table, Path::new("/mnt/nas packs/a.zip")).as_deref(),
            Some("cifs")
        );
        assert_eq!(
            native::mount_type(table, Path::new("/mnt/nas packs/local/a.zip")).as_deref(),
            Some("ext4")
        );
        assert_eq!(
            native::mount_type(table, Path::new("/home/a.zip")).as_deref(),
            Some("btrfs")
        );
    }
}
