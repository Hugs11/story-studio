//! The media a project file names itself, read from the raw file (no
//! migration, no normalization of the project).
//!
//! The project loader of the interface (`walkProjectMediaReferences`, then
//! `resolveLoadedProjectPath`) is the reference. This reading mirrors it:
//!
//! - the same fields: the cover and night-mode media, the bindings of a graph
//!   project, the Stages of an embedded native graph and every media field of
//!   the entry tree. It also reads the containers older files keep until
//!   their migration (`rootItems`, `menus`, `items`) and the covers of a ZIP
//!   entry, whose paths reach the interface's project unchanged;
//! - the same resolution: `./` and `../` are relative to the project's folder,
//!   anything else is kept as written. The interface's fallback on the
//!   workspace always lands in a workspace, which the catalogue already admits
//!   as a root, so it is not needed here.
//!
//! The shared fixture `scripts/fixtures/catalogue/declared-media.json` holds
//! the expected references of existing projects of the repository; the
//! interface's loader and this reading are both checked against it.
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

const ROOT_KEYS: [&str; 4] = ["rootAudio", "rootImage", "thumbnailImage", "nightModeAudio"];
const ENTRY_KEYS: [&str; 8] = [
    "audio",
    "image",
    "itemAudio",
    "itemImage",
    "afterPlaybackPromptAudio",
    "zipPath",
    "coverImage",
    "coverAudio",
];
const STEP_KEYS: [&str; 2] = ["audio", "image"];

fn push_keys<'a>(object: &'a Value, keys: &[&str], out: &mut Vec<&'a str>) {
    for key in keys {
        if let Some(value) = object
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            out.push(value);
        }
    }
}

fn items(value: Option<&Value>) -> impl Iterator<Item = &Value> {
    value.and_then(Value::as_array).into_iter().flatten()
}

fn stages<'a>(graph: Option<&'a Value>, out: &mut Vec<&'a str>) {
    for stage in items(graph.and_then(|graph| graph.pointer("/document/stageNodes"))) {
        push_keys(stage, &STEP_KEYS, out);
    }
}

fn entries<'a>(list: Option<&'a Value>, out: &mut Vec<&'a str>) {
    for entry in items(list) {
        push_keys(entry, &ENTRY_KEYS, out);
        for step in items(entry.get("afterPlaybackSequence")) {
            push_keys(step, &STEP_KEYS, out);
        }
        if let Some(home) = entry.get("afterPlaybackHomeStep") {
            push_keys(home, &STEP_KEYS, out);
        }
        stages(entry.get("nativeGraph"), out);
        entries(entry.get("children"), out);
        entries(entry.get("items"), out);
    }
}

/// Every media reference of a raw project file, as written.
pub fn references(raw: &Value) -> Vec<&str> {
    let mut out = Vec::new();
    push_keys(raw, &ROOT_KEYS, &mut out);
    for binding in items(raw.pointer("/authoring/mediaBindings")) {
        push_keys(binding, &["path"], &mut out);
    }
    stages(raw.get("nativeGraph"), &mut out);
    for key in ["rootEntries", "rootItems", "menus"] {
        entries(raw.get(key), &mut out);
    }
    out
}

/// A project path as the project loader resolves it: `./` and `../` are
/// relative to the project's folder, anything else is kept as written.
pub fn project_path(value: &str, folder: &Path) -> PathBuf {
    if value.starts_with("./") || value.starts_with("../") {
        let mut resolved = folder.to_owned();
        for part in value.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    resolved.pop();
                }
                other => resolved.push(other),
            }
        }
        resolved
    } else {
        PathBuf::from(value.trim())
    }
}

/// `path` without `.` nor `..`, each `..` removing the previous name.
pub fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The real location (links followed) of every existing file the project at
/// `project` names: the only files outside its roots it may be served.
pub fn declared_files(raw: &Value, project: &Path) -> HashSet<PathBuf> {
    let folder = project.parent().unwrap_or(Path::new("."));
    references(raw)
        .into_iter()
        .map(|reference| lexical(&project_path(reference, folder)))
        .filter(|path| path.is_absolute())
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|real| real.is_file())
        .collect()
}
