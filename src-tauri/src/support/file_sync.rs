//! Durability barrier for existing ordinary files, shared by all services.
use std::{fs::OpenOptions, io, path::Path};

/// Windows FlushFileBuffers requires write access. Never create or truncate.
pub(crate) fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_existing_file_preserves_bytes_and_refuses_missing_file() {
        let root = std::env::temp_dir().join(format!("file-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("ordinary.bin");
        std::fs::write(&path, b"unchanged contents").unwrap();
        sync_file(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"unchanged contents");
        let missing = root.join("missing");
        assert_eq!(
            sync_file(&missing).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert!(!missing.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
