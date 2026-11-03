//! Read-only, bounded discovery. An incomplete scope never proves absence.
use super::sources::Exclusions;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub const MAX_DEPTH: usize = 64;
pub const MAX_ITEMS: usize = 100_000;
#[derive(Default)]
pub struct Discovery {
    pub candidates: Vec<PathBuf>,
    pub directories: u64,
    pub errors: Vec<ScopeError>,
    /// Entries skipped by an exclusion rule, with the rule role.
    pub excluded: Vec<(PathBuf, String)>,
    pub complete: bool,
}
/// A root or directory that could not be visited; counted apart from packs.
pub struct ScopeError {
    pub path: PathBuf,
    pub reason: &'static str,
    pub detail: String,
}
fn scope_error(path: PathBuf, is_root: bool, error: &std::io::Error) -> ScopeError {
    let reason = match error.kind() {
        std::io::ErrorKind::NotFound if is_root => "volumeUnavailable",
        std::io::ErrorKind::NotFound => "fileDisappeared",
        std::io::ErrorKind::PermissionDenied => "accessDenied",
        _ => "unreadableUnknown",
    };
    ScopeError {
        path,
        reason,
        detail: error.to_string(),
    }
}

pub fn within_source(root: &Path, resolved: &Path) -> bool {
    resolved.starts_with(root)
}

pub fn is_pack_directory(path: &Path) -> bool {
    path.join("story.json").is_file()
        || crate::support::fs_pack_reader::detect_fs_pack_variant(path).is_some()
}
pub fn discover(
    root: &Path,
    exclusions: &Exclusions,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(&Path, &Discovery),
) -> Discovery {
    let mut result = Discovery {
        complete: true,
        ..Default::default()
    };
    let boundary = super::refresh::resolve_existing(root);
    let mut stack = vec![(root.to_owned(), 0)];
    let mut seen = HashSet::new();
    let mut visited = 0;
    while let Some((path, depth)) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            result.complete = false;
            break;
        }
        visited += 1;
        if depth > MAX_DEPTH || visited > MAX_ITEMS {
            // Documented limit: past it the root stays incomplete on every scan,
            // so no absence is ever concluded there. The dedicated reason makes
            // that permanent state visible in the report.
            result.errors.push(ScopeError {
                path,
                reason: if depth > MAX_DEPTH {
                    "depthLimitExceeded"
                } else {
                    "itemLimitExceeded"
                },
                detail: format!("depth {depth}, items {visited}"),
            });
            result.complete = false;
            break;
        }
        // One predicate call per entry, over the visited name and its resolved
        // target (a link may lead into a technical location).
        let resolved = std::fs::canonicalize(&path);
        match exclusions.classify(&path, resolved.as_deref().ok()) {
            Ok(Some(rule)) => {
                result.excluded.push((path, rule.role.clone()));
                continue;
            }
            Err(()) => {
                result.errors.push(ScopeError {
                    path,
                    reason: "unreadableUnknown",
                    detail: "workspace structure probe inconclusive".into(),
                });
                result.complete = false;
                continue;
            }
            Ok(None) => {}
        }
        let canonical = match resolved {
            Ok(value) => value,
            Err(error) => {
                result.errors.push(scope_error(path, depth == 0, &error));
                result.complete = false;
                continue;
            }
        };
        if !within_source(&boundary, &canonical) {
            result.errors.push(ScopeError {
                path,
                reason: "outsideSource",
                detail: format!(
                    "target {} outside {}",
                    canonical.display(),
                    boundary.display()
                ),
            });
            continue;
        }
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if is_pack_directory(&path) {
            result.candidates.push(canonical);
            continue;
        }
        if path.is_dir() {
            result.directories += 1;
            match std::fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => stack.push((entry.path(), depth + 1)),
                            Err(error) => {
                                result.errors.push(scope_error(path.clone(), false, &error));
                                result.complete = false;
                            }
                        }
                    }
                }
                Err(error) => {
                    result
                        .errors
                        .push(scope_error(path.clone(), depth == 0, &error));
                    result.complete = false;
                }
            }
            progress(&path, &result);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mbah" | "zip" | "7z"))
        {
            result.candidates.push(canonical);
        }
    }
    if !root.is_dir() {
        result.complete = false;
    }
    result.candidates.sort();
    result
}
