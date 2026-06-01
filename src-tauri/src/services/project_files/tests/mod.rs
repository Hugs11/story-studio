use super::audio::edit::*;
use super::audio::pipeline::*;
use super::*;
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

fn temp_project_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "luniipack_project_files_test_{}_{}_{}",
        name,
        std::process::id(),
        now_millis()
    ))
}

fn path_without_windows_extended_prefix(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix("\\\\?\\")
        .unwrap_or(value.as_ref())
        .to_string()
}

fn temp_workspace_with_dirs(name: &str) -> PathBuf {
    let workspace = temp_project_dir(name);
    for dir in [
        "images-generees",
        "fichiers-importes",
        "enregistrements",
        "voix-generees",
        "zips-extraits",
    ] {
        fs::create_dir_all(workspace.join(dir)).expect("create managed dir");
    }
    workspace
}

fn write_temp_file(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, contents).expect("write temp file");
}

mod audio;
mod delete;
mod paths;
mod recording;
