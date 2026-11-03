//! Bounded, scoped spooling for seekable nested archives. Session helpers own
//! naming and deletion; nothing is extracted beside a user's pack.
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
pub struct Temporary {
    root: PathBuf,
    directory: String,
    pub path: PathBuf,
}
impl Temporary {
    pub fn new() -> Result<Self, String> {
        let root = std::env::temp_dir().join("story_studio_catalogue");
        let directory = crate::support::temp::create_session_workspace(&root)?;
        let path = PathBuf::from(&directory).join("member.zip");
        Ok(Self {
            root,
            directory,
            path,
        })
    }
    pub fn write(&self) -> Result<std::fs::File, String> {
        std::fs::File::create(&self.path).map_err(|e| e.to_string())
    }
    pub fn read(&self) -> Result<std::fs::File, String> {
        std::fs::File::open(&self.path).map_err(|e| e.to_string())
    }
    pub fn spool(reader: &mut impl Read, cancel: &AtomicBool) -> Result<Self, String> {
        let temp = Self::new()?;
        let mut output = temp.write()?;
        let mut total = 0;
        let mut buffer = [0; 65536];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > crate::support::archive_limits::ARCHIVE_MAX_FILE_BYTES {
                return Err("readLimitExceeded".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        Ok(temp)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if let Err(error) =
            crate::support::temp::cleanup_session_workspace(&self.root, &self.directory)
        {
            log::warn!("Catalogue temporary cleanup: {error}");
        }
    }
}
