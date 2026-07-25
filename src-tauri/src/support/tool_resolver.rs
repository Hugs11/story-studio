use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static TAURI_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn initialize_resource_dir(path: PathBuf) {
    let _ = TAURI_RESOURCE_DIR.set(path);
}

pub(crate) fn resource_dir() -> Option<PathBuf> {
    TAURI_RESOURCE_DIR.get().cloned()
}

pub(crate) fn path_dirs(value: Option<OsString>) -> Vec<PathBuf> {
    value
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect()
}

pub(crate) fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

pub(crate) fn push_resource_candidates(
    candidates: &mut Vec<PathBuf>,
    resource_dir: Option<&Path>,
    names: &[&str],
) {
    let Some(resource_dir) = resource_dir else {
        return;
    };
    for name in names {
        push_candidate(candidates, resource_dir.join("tools").join(name));
        push_candidate(candidates, resource_dir.join(name));
    }
}

pub(crate) fn push_development_candidates(
    candidates: &mut Vec<PathBuf>,
    cwd: Option<&Path>,
    platform: &str,
    names: &[&str],
) {
    let Some(cwd) = cwd else {
        return;
    };
    for base in cwd.ancestors() {
        for name in names {
            push_candidate(
                candidates,
                base.join("src-tauri")
                    .join("tools")
                    .join(platform)
                    .join(name),
            );
            push_candidate(candidates, base.join("tools").join(platform).join(name));
            push_candidate(candidates, base.join("src-tauri").join("tools").join(name));
            push_candidate(candidates, base.join("tools").join(name));
        }
    }
}

pub(crate) fn push_path_candidates(
    candidates: &mut Vec<PathBuf>,
    path_dirs: &[PathBuf],
    names: &[&str],
) {
    for dir in path_dirs {
        for name in names {
            push_candidate(candidates, dir.join(name));
        }
    }
}

pub(crate) fn resolve_regular_file(
    display_name: &str,
    candidates: Vec<PathBuf>,
) -> Result<PathBuf, String> {
    let mut searched = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        searched.push(candidate.clone());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let searched = searched
        .iter()
        .map(|path| format!("  - {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "{display_name} introuvable. Candidats recherches :\n{searched}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_candidates_precede_development_candidates() {
        let mut candidates = Vec::new();
        push_resource_candidates(
            &mut candidates,
            Some(Path::new("/opt/story/resources")),
            &["ffmpeg"],
        );
        push_development_candidates(
            &mut candidates,
            Some(Path::new("/repo/src-tauri")),
            "linux",
            &["ffmpeg"],
        );

        assert_eq!(
            candidates.first(),
            Some(&PathBuf::from("/opt/story/resources/tools/ffmpeg"))
        );
        assert!(candidates.contains(&PathBuf::from("/repo/src-tauri/tools/linux/ffmpeg")));
    }

    #[test]
    fn missing_tool_error_lists_actual_candidates() {
        let missing = std::env::temp_dir().join(format!(
            "story_studio_missing_tool_{}_{}",
            std::process::id(),
            crate::support::ffmpeg::now_millis()
        ));
        let error =
            resolve_regular_file("outil test", vec![missing.clone()]).expect_err("missing tool");
        assert!(error.contains("outil test introuvable"));
        assert!(error.contains(&missing.display().to_string()));
    }
}
