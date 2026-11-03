//! Install commits payload first, playlist last. Failed copies remain unlisted.
use super::*;
use std::{
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
};
/// What an install reports to its caller, in this order: bytes copied, then
/// once the payload is entirely written and the write barriers begin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyEvent {
    Copied { copied: u64, total: u64 },
    Finalizing,
}
pub(crate) type CopyProgress = Box<dyn Fn(CopyEvent) + Send>;
struct Copy<'a> {
    cancel: &'a AtomicBool,
    progress: Option<&'a CopyProgress>,
    copied: u64,
    total: u64,
}
/// E0: allocated file lengths plus one allocation unit per directory, including
/// empty directories. Reserve one complete replacement .pi plus 8 units for
/// sidecar/temp directory entries, a bounded card (224 KiB) and a complete
/// device-state replacement (1 MiB maximum). No percentage
/// heuristic: large stories do not need a larger safety margin.
pub(crate) fn allocated_size(path: &Path, unit: u64) -> Result<u64> {
    if unit == 0 {
        return Err(Error::NoSpace {
            missing_bytes: u64::MAX,
        });
    }
    safe(path, true)?;
    let mut size = unit;
    for entry in fs::read_dir(path)? {
        let path = entry?.path();
        let meta = fs::symlink_metadata(&path)?;
        let bytes = if meta.is_dir() {
            allocated_size(&path, unit)?
        } else {
            safe(&path, false)?;
            meta.len()
                .div_ceil(unit)
                .checked_mul(unit)
                .ok_or(Error::NoSpace {
                    missing_bytes: u64::MAX,
                })?
        };
        size = size.checked_add(bytes).ok_or(Error::NoSpace {
            missing_bytes: u64::MAX,
        })?;
    }
    Ok(size)
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
impl Device {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn install_payload(
        &self,
        story: &crate::services::storyteller::cipher::EncryptedStory,
        old: &[Uuid],
        volumes: &impl Volumes,
        metadata: &Metadata,
        cancel: &AtomicBool,
        progress: Option<&CopyProgress>,
    ) -> Result<()> {
        check(cancel)?;
        if !story.matches_device(&self.root) {
            return Err(Error::Changed);
        }
        let target = self.root.join(".content").join(folder(story.uuid));
        if old.contains(&story.uuid)
            || target.symlink_metadata().is_ok()
            || state::normalized(&self.root, old)
                .hidden
                .iter()
                .any(|h| h.uuid == story.uuid.to_string())
        {
            return Err(Error::Duplicate {
                position: old.iter().position(|id| *id == story.uuid),
            });
        }
        if !read::complete(&story.path, metadata.version) {
            return Err(Error::IncompleteStory);
        }
        let unit = volumes.allocation_unit(&self.root)?;
        let required = allocated_size(&story.path, unit)?;
        let overhead = ((old.len() as u64 + 1) * 16)
            .div_ceil(unit)
            .checked_add(8 + ((224 + 1024) * 1024u64).div_ceil(unit))
            .and_then(|v| v.checked_mul(unit))
            .ok_or(Error::NoSpace {
                missing_bytes: u64::MAX,
            })?;
        let required = required.checked_add(overhead).ok_or(Error::NoSpace {
            missing_bytes: u64::MAX,
        })?;
        let free = volumes.capacity(&self.root)?.0;
        if required > free {
            return Err(Error::NoSpace {
                missing_bytes: required - free,
            });
        }
        self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
            .map_err(|_| Error::BackupFailed)?;
        let temp = self
            .root
            .join(".content")
            .join(format!(".story-studio-install-{}", story.uuid));
        if temp.symlink_metadata().is_ok() {
            super::writes::check_tree(&temp)?;
            fs::remove_dir_all(&temp)?;
        }
        fs::create_dir(&temp)?;
        let mut renamed = false;
        let result = (|| {
            let mut copy = Copy {
                cancel,
                progress,
                copied: 0,
                total: story.total_bytes,
            };
            self.copy_payload(&story.path, &temp, &mut copy)?;
            if let Some(progress) = copy.progress {
                progress(CopyEvent::Finalizing);
            }
            check(cancel)?;
            if read::metadata(&self.root)? != *metadata || read::playlist(&self.root)? != old {
                return Err(Error::Changed);
            }
            if target.symlink_metadata().is_ok() {
                return Err(Error::Duplicate {
                    position: old.iter().position(|id| *id == story.uuid),
                });
            }
            // The copied tree (files, folders, FAT) is on the medium before
            // its rename can expose it under the story's name.
            self.volume_barrier(&temp)?;
            platform::move_dir(&temp, &target)?;
            renamed = true;
            #[cfg(test)]
            if let Some(hook) = self.after_install_rename {
                hook(&target, cancel);
            }
            self.volume_barrier(&self.root.join(".content"))?;
            if !read::complete(&target, metadata.version) {
                return Err(Error::IncompleteStory);
            }
            check(cancel)
        })();
        if result.is_err() {
            let cleanup = (|| -> Result<()> {
                if temp.symlink_metadata().is_ok() {
                    super::writes::check_tree(&temp)?;
                    fs::remove_dir_all(&temp)?;
                }
                if renamed
                    && target.symlink_metadata().is_ok()
                    && !read::playlist(&self.root)?.contains(&story.uuid)
                {
                    super::writes::check_tree(&target)?;
                    fs::remove_dir_all(&target)?;
                    platform::sync_volume(&self.root.join(".content"))?;
                }
                Ok(())
            })();
            if cleanup.is_err() {
                state::cleanup_warning();
            }
        }
        result
    }
    fn copy_payload(&self, from: &Path, to: &Path, copy: &mut Copy<'_>) -> Result<()> {
        let cancel = copy.cancel;
        safe(from, true)?;
        for entry in fs::read_dir(from)? {
            check(cancel)?;
            self.checkpoint()?;
            let entry = entry?;
            let source = entry.path();
            let target = to.join(entry.file_name());
            if fs::symlink_metadata(&source)?.is_dir() {
                fs::create_dir(&target)?;
                self.copy_payload(&source, &target, copy)?;
            } else {
                safe(&source, false)?;
                let mut input = fs::File::open(&source)?;
                let mut output = fs::File::create_new(&target)?;
                let mut buffer = [0; 128 * 1024];
                loop {
                    check(cancel)?;
                    self.checkpoint()?;
                    let n = input.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buffer[..n])?;
                    copy.copied += n as u64;
                    if let Some(progress) = copy.progress {
                        progress(CopyEvent::Copied {
                            copied: copy.copied,
                            total: copy.total,
                        });
                    }
                    #[cfg(test)]
                    if let Some(hook) = self.after_install_chunk {
                        hook(cancel);
                    }
                }
                output.sync_all()?;
            }
        }
        // No barrier per directory: one covers the whole copy before the rename.
        Ok(())
    }
}

impl Device {
    /// Cheap preflight before media generation. Install repeats it under the
    /// mutation lock and adds exact allocation after staging is complete.
    pub(crate) fn preflight(
        &self,
        id: Option<Uuid>,
        estimated_bytes: u64,
        volumes: &impl Volumes,
    ) -> Result<()> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        safe(&self.root, true)?;
        if !volumes.writable(&self.root)? {
            return Err(Error::ReadOnly);
        }
        if let Some(error) = read::metadata(&self.root)?.read_only {
            return Err(error);
        }
        if read::recovery(&self.root)?.is_some_and(RecoveryState::requires_restore) {
            return Err(Error::RecoveryRequired);
        }
        let list = read::playlist(&self.root).map_err(|_| Error::PlaylistDamaged)?;
        if read::has_missing_folders(&self.root, &list)? {
            return Err(Error::PlaylistDamaged);
        }
        if let Some(id) = id {
            if list.contains(&id)
                || self
                    .root
                    .join(".content")
                    .join(folder(id))
                    .symlink_metadata()
                    .is_ok()
                || state::normalized(&self.root, &list)
                    .hidden
                    .iter()
                    .any(|h| h.uuid == id.to_string())
            {
                return Err(Error::Duplicate {
                    position: list.iter().position(|v| *v == id),
                });
            }
        }
        // Before generation the catalogue size is a lower-bound estimate.
        // Allow 25% for conversion/allocation and 2 MiB for index and sidecars;
        // installation repeats the exact E0 calculation after encryption.
        let required = estimated_bytes
            .checked_add(estimated_bytes / 4)
            .and_then(|v| v.checked_add(2 * 1024 * 1024))
            .ok_or(Error::NoSpace {
                missing_bytes: u64::MAX,
            })?;
        let free = volumes.capacity(&self.root)?.0;
        if required > free {
            return Err(Error::NoSpace {
                missing_bytes: required - free,
            });
        }
        Ok(())
    }
}
