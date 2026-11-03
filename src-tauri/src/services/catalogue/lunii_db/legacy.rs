//! STUdio uses the user's home on all platforms; OS app-data locations are
//! also inspected for installations that redirect Java's user.home there.
use super::*;
use std::path::PathBuf;
pub(super) fn locations(
    home: Option<PathBuf>,
    config: Option<PathBuf>,
    data: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in [home, config, data].into_iter().flatten() {
        for name in [
            ".studio",
            ".studio-perso",
            "studio",
            "studio-perso",
            "STUdio",
            "STUdio Perso",
        ] {
            let p = root.join(name).join("db/official.json");
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
    }
    paths
}
pub(super) fn read(path: &Path) -> Result<parse::Index> {
    let file = std::fs::File::open(path).map_err(|_| message(codes::CATALOG_LUNII_INVALID))?;
    if !file.metadata().map_err(error)?.is_file() {
        return Err(message(codes::CATALOG_LUNII_INVALID));
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    parse::parse(&bytes)
}
impl Store {
    pub fn discover_legacy_lunii(
        &self,
        home: Option<PathBuf>,
        config: Option<PathBuf>,
        data: Option<PathBuf>,
    ) -> Result<()> {
        self.adopt_legacy_lunii(&locations(home, config, data))
    }
    pub(super) fn adopt_legacy_lunii(&self, paths: &[PathBuf]) -> Result<()> {
        let _gate = self.lunii.job.lock().map_err(error)?;
        if self.read(|c| {
            c.query_row("SELECT EXISTS(SELECT 1 FROM lunii_pack)", [], |r| {
                r.get::<_, bool>(0)
            })
        })? {
            return Ok(());
        }
        let mut paths = paths.to_vec();
        paths.sort_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH)
        });
        let mut merged = parse::Index::new();
        for path in &paths {
            match read(path) {
                Ok(index) => merged.extend(index),
                Err(reason) => {
                    if path.is_file() {
                        log::warn!("Existing official metadata ignored: {}", reason.code);
                    }
                }
            }
        }
        if !merged.is_empty() {
            self.publish_lunii(&merged, "import", &AtomicBool::new(false))?;
        }
        Ok(())
    }
}
