use crate::support::tool_resolver::{
    path_dirs, push_candidate, push_development_candidates, push_path_candidates,
    push_resource_candidates, resolve_regular_file, resource_dir,
};
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn file_ext(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("bin")
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(target_os = "windows")]
pub(crate) fn apply_no_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_no_window(_cmd: &mut Command) {}

fn ffmpeg_binary_names(platform: &str) -> &'static [&'static str] {
    if platform == "windows" {
        &["ffmpeg.exe"]
    } else {
        &["ffmpeg"]
    }
}

struct FfmpegResolutionContext<'a> {
    platform: &'a str,
    debug: bool,
    override_path: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    current_exe: Option<PathBuf>,
    cwd: Option<PathBuf>,
    path_dirs: Vec<PathBuf>,
}

fn ffmpeg_candidates(context: &FfmpegResolutionContext<'_>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let names = ffmpeg_binary_names(context.platform);

    if context.debug {
        if let Some(path) = &context.override_path {
            push_candidate(&mut candidates, path.clone());
        }
    }

    push_resource_candidates(&mut candidates, context.resource_dir.as_deref(), names);

    if context.platform == "windows" {
        if let Some(exe_dir) = context.current_exe.as_deref().and_then(Path::parent) {
            for name in names {
                push_candidate(&mut candidates, exe_dir.join("tools").join(name));
                push_candidate(&mut candidates, exe_dir.join(name));
            }
        }
    }

    if context.debug {
        push_development_candidates(
            &mut candidates,
            context.cwd.as_deref(),
            context.platform,
            names,
        );
        push_path_candidates(&mut candidates, &context.path_dirs, names);
    }

    candidates
}

pub(crate) fn get_ffmpeg_path() -> Result<PathBuf, String> {
    let context = FfmpegResolutionContext {
        platform: std::env::consts::OS,
        debug: cfg!(debug_assertions),
        override_path: std::env::var_os("STORY_STUDIO_FFMPEG_PATH").map(PathBuf::from),
        resource_dir: resource_dir(),
        current_exe: std::env::current_exe().ok(),
        cwd: std::env::current_dir().ok(),
        path_dirs: path_dirs(std::env::var_os("PATH")),
    };
    resolve_regular_file("FFmpeg", ffmpeg_candidates(&context))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "story_studio_ffmpeg_test_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
        ))
    }

    fn context(platform: &'static str) -> FfmpegResolutionContext<'static> {
        FfmpegResolutionContext {
            platform,
            debug: true,
            override_path: None,
            resource_dir: None,
            current_exe: None,
            cwd: None,
            path_dirs: Vec::new(),
        }
    }

    #[test]
    fn binary_name_matches_platform() {
        assert_eq!(ffmpeg_binary_names("windows"), &["ffmpeg.exe"]);
        assert_eq!(ffmpeg_binary_names("linux"), &["ffmpeg"]);
    }

    #[test]
    fn override_has_highest_priority_in_development() {
        let dir = temp_dir("override");
        fs::create_dir_all(&dir).expect("create temp dir");
        let override_path = dir.join("custom ffmpeg");
        let resource_path = dir.join("resources").join("tools").join("ffmpeg");
        fs::create_dir_all(resource_path.parent().expect("resource parent"))
            .expect("create resource dir");
        fs::write(&override_path, b"override").expect("write override");
        fs::write(&resource_path, b"resource").expect("write resource");

        let mut context = context("linux");
        context.override_path = Some(override_path.clone());
        context.resource_dir = Some(dir.join("resources"));
        let resolved =
            resolve_regular_file("FFmpeg", ffmpeg_candidates(&context)).expect("resolve override");
        assert_eq!(resolved, override_path);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn packaged_resource_precedes_development_and_path() {
        let dir = temp_dir("resource");
        let resource_dir = dir.join("resources");
        let resource_path = resource_dir.join("tools").join("ffmpeg");
        let dev_path = dir.join("src-tauri/tools/linux/ffmpeg");
        let path_binary = dir.join("bin/ffmpeg");
        for path in [&resource_path, &dev_path, &path_binary] {
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, b"tool").expect("write tool");
        }

        let mut context = context("linux");
        context.resource_dir = Some(resource_dir);
        context.cwd = Some(dir.clone());
        context.path_dirs = vec![dir.join("bin")];
        let resolved =
            resolve_regular_file("FFmpeg", ffmpeg_candidates(&context)).expect("resolve resource");
        assert_eq!(resolved, resource_path);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn windows_keeps_historical_neighbor_lookup() {
        let dir = temp_dir("windows_neighbor");
        let candidate = dir.join("tools/ffmpeg.exe");
        fs::create_dir_all(candidate.parent().expect("parent")).expect("create tools");
        fs::write(&candidate, b"tool").expect("write tool");

        let mut context = context("windows");
        context.current_exe = Some(dir.join("story-studio.exe"));
        let resolved =
            resolve_regular_file("FFmpeg", ffmpeg_candidates(&context)).expect("resolve neighbor");
        assert_eq!(resolved, candidate);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn missing_ffmpeg_reports_searched_candidates() {
        let dir = temp_dir("missing");
        let mut context = context("linux");
        context.resource_dir = Some(dir.join("resources"));
        context.cwd = Some(dir.clone());
        let error =
            resolve_regular_file("FFmpeg", ffmpeg_candidates(&context)).expect_err("missing");
        assert!(error.contains("FFmpeg introuvable"));
        assert!(error.contains("resources/tools/ffmpeg"));
    }
}
