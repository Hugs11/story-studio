use super::*;
use std::ffi::OsString;

#[derive(Debug, PartialEq)]
struct LauncherCommand {
    program: PathBuf,
    args: Vec<OsString>,
    cwd: PathBuf,
}

fn launcher_parent(launcher_path: &str, platform: &str) -> PathBuf {
    if platform == "windows" {
        launcher_path
            .rfind(['\\', '/'])
            .map(|index| PathBuf::from(&launcher_path[..index]))
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        Path::new(launcher_path)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    }
}

fn build_launcher_command(
    launcher_path: &str,
    platform: &str,
    executable: bool,
) -> Result<LauncherCommand, String> {
    let path = PathBuf::from(launcher_path);
    let extension = launcher_path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let cwd = launcher_parent(launcher_path, platform);

    if platform == "windows" && matches!(extension.as_str(), "bat" | "cmd") {
        return Ok(LauncherCommand {
            program: PathBuf::from("cmd"),
            args: vec![OsString::from("/c"), path.into_os_string()],
            cwd,
        });
    }

    if platform != "windows" && extension == "sh" && !executable {
        return Ok(LauncherCommand {
            program: PathBuf::from("/bin/sh"),
            args: vec![path.into_os_string()],
            cwd,
        });
    }

    if !executable {
        return Err(format!(
            "Le script de démarrage ComfyUI n'est pas exécutable : {}",
            launcher_path
        ));
    }

    Ok(LauncherCommand {
        program: path,
        args: Vec::new(),
        cwd,
    })
}

fn launcher_is_executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

fn validated_launcher_command(launcher_path: &str) -> Result<LauncherCommand, String> {
    if launcher_path.trim().is_empty() {
        return Err("Script de démarrage ComfyUI non configuré dans les Préférences.".to_string());
    }
    let path = PathBuf::from(launcher_path);
    let metadata = fs::symlink_metadata(&path).map_err(|_| {
        format!(
            "Script de démarrage ComfyUI introuvable : {}",
            launcher_path
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Le script de démarrage ComfyUI ne peut pas être un lien symbolique : {}",
            launcher_path
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Le script de démarrage ComfyUI doit être un fichier régulier : {}",
            launcher_path
        ));
    }

    build_launcher_command(
        launcher_path,
        std::env::consts::OS,
        launcher_is_executable(&metadata),
    )
}

pub(super) fn start_comfyui(launcher_path: &str) -> Result<(), String> {
    let spec = validated_launcher_command(launcher_path)?;

    // Le chemin est toujours passé comme argument distinct. CREATE_NO_WINDOW
    // évite la fenêtre cmd vide sous Windows ; l'état serveur est suivi par HTTP.
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Impossible de lancer ComfyUI : {}", e))
}

pub fn ensure_comfyui_sync(settings: &ComfyUiSettings) -> Result<(), String> {
    require_local_url(&settings.server_url, "ComfyUI")?;
    if check_health_sync(&settings.server_url).unwrap_or(false) {
        return Ok(());
    }
    if !settings.auto_start {
        return Err(format!(
            "ComfyUI inaccessible sur {}. Lance ComfyUI ou active le démarrage automatique dans les Preferences.",
            settings.server_url
        ));
    }
    start_comfyui(&settings.launcher_path)?;
    // Flux prend 2-3 minutes à charger — on attend jusqu'à 180s.
    let mut last_err = "ComfyUI démarré mais ne répond pas encore.".to_string();
    for _ in 0..180 {
        std::thread::sleep(Duration::from_secs(1));
        match check_health_sync(&settings.server_url) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "ComfyUI ne répond toujours pas après 3 minutes. {}",
        last_err
    ))
}

pub fn check_health_sync(server_url: &str) -> Result<bool, String> {
    let client = http_client(Duration::from_secs(5))?;
    let response = client
        .get(join_url(server_url, "/"))
        .send()
        .map_err(|e| format!("ComfyUI inaccessible sur {} : {}", server_url, e))?;
    Ok(response.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_launcher_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "story_studio_comfy_launcher_{}_{}_{}",
            name,
            std::process::id(),
            crate::support::ffmpeg::now_millis()
        ))
    }

    #[test]
    fn windows_batch_and_cmd_keep_paths_as_separate_arguments() {
        for launcher in [r"C:\Comfy UI\run_nvidia_gpu.bat", r"C:\Comfy UI\start.cmd"] {
            let spec =
                build_launcher_command(launcher, "windows", false).expect("Windows launcher");
            assert_eq!(spec.program, PathBuf::from("cmd"));
            assert_eq!(
                spec.args,
                vec![OsString::from("/c"), OsString::from(launcher)]
            );
            assert_eq!(spec.cwd, PathBuf::from(r"C:\Comfy UI"));
        }
    }

    #[test]
    fn linux_shell_script_uses_direct_exec_or_bin_sh_fallback() {
        let launcher = "/home/user/Comfy UI/start comfy.sh";
        let direct = build_launcher_command(launcher, "linux", true).expect("direct launcher");
        assert_eq!(direct.program, PathBuf::from(launcher));
        assert!(direct.args.is_empty());
        assert_eq!(direct.cwd, PathBuf::from("/home/user/Comfy UI"));

        let fallback = build_launcher_command(launcher, "linux", false).expect("shell fallback");
        assert_eq!(fallback.program, PathBuf::from("/bin/sh"));
        assert_eq!(fallback.args, vec![OsString::from(launcher)]);
    }

    #[test]
    fn linux_executable_without_shell_extension_runs_directly() {
        let launcher = "/opt/comfy/bin/comfy-launcher";
        let spec = build_launcher_command(launcher, "linux", true).expect("direct executable");
        assert_eq!(spec.program, PathBuf::from(launcher));
        assert!(spec.args.is_empty());
        assert_eq!(spec.cwd, PathBuf::from("/opt/comfy/bin"));
    }

    #[test]
    fn non_executable_non_shell_launcher_is_rejected() {
        let error = build_launcher_command("/opt/comfy/launcher.py", "linux", false)
            .expect_err("reject non executable");
        assert!(error.contains("pas exécutable"));
    }

    #[test]
    fn missing_and_directory_launchers_are_rejected() {
        let dir = temp_launcher_dir("invalid");
        fs::create_dir_all(&dir).expect("create temp dir");
        let missing = dir.join("missing.sh");
        assert!(validated_launcher_command(missing.to_str().expect("utf8"))
            .expect_err("missing")
            .contains("introuvable"));
        assert!(validated_launcher_command(dir.to_str().expect("utf8"))
            .expect_err("directory")
            .contains("fichier régulier"));
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn stopped_server_without_autostart_returns_clean_error() {
        let settings = ComfyUiSettings {
            server_url: "http://127.0.0.1:9".to_string(),
            auto_start: false,
            launcher_path: String::new(),
        };

        let error = ensure_comfyui_sync(&settings).expect_err("stopped server");
        assert!(error.contains("ComfyUI inaccessible"));
        assert!(error.contains("démarrage automatique"));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_launcher_is_rejected() {
        use std::os::unix::fs::symlink;

        let dir = temp_launcher_dir("symlink");
        fs::create_dir_all(&dir).expect("create temp dir");
        let target = dir.join("target.sh");
        let link = dir.join("link.sh");
        fs::write(&target, b"#!/bin/sh\n").expect("write target");
        symlink(&target, &link).expect("create symlink");

        let error =
            validated_launcher_command(link.to_str().expect("utf8")).expect_err("reject symlink");
        assert!(error.contains("lien symbolique"));
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
