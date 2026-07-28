//! Résolution du runtime Piper 1.6 embarqué. Le bundle est en lecture seule ;
//! seuls les modèles de voix vivent dans l'app-data inscriptible.

use crate::support::executable::{target_for, validate_executable_file};
use crate::support::tool_resolver::{push_candidate, resource_dir};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const PIPER_VERSION: &str = "1.6.0";
const PIPER_COMMIT: &str = "f04d52c5528ac7cf2d73757f57990ff490f75005";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PiperRuntime {
    pub root: PathBuf,
    pub executable: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RuntimeTarget {
    os: &'static str,
    arch: &'static str,
    manifest_key: &'static str,
    platform_name: &'static str,
    executable: &'static str,
    runtime_files: &'static [&'static str],
}

const WINDOWS_RUNTIME_FILES: &[&str] = &[
    "piper.exe",
    "piper.dll",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
];
const LINUX_RUNTIME_FILES: &[&str] = &[
    "piper",
    "libpiper.so",
    "libonnxruntime.so.1",
    "libonnxruntime_providers_shared.so",
];
const MACOS_RUNTIME_FILES: &[&str] = &["piper", "libpiper.dylib", "libonnxruntime.1.22.0.dylib"];

const RUNTIME_TARGETS: &[RuntimeTarget] = &[
    RuntimeTarget {
        os: "windows",
        arch: "x86_64",
        manifest_key: "win32-x64",
        platform_name: "windows-x86_64",
        executable: "piper.exe",
        runtime_files: WINDOWS_RUNTIME_FILES,
    },
    RuntimeTarget {
        os: "linux",
        arch: "x86_64",
        manifest_key: "linux-x64",
        platform_name: "linux-x86_64",
        executable: "piper",
        runtime_files: LINUX_RUNTIME_FILES,
    },
    RuntimeTarget {
        os: "macos",
        arch: "aarch64",
        manifest_key: "darwin-arm64",
        platform_name: "macos-aarch64",
        executable: "piper",
        runtime_files: MACOS_RUNTIME_FILES,
    },
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    piper: RuntimePiper,
    target: RuntimeManifestTarget,
    runtime_files: HashMap<String, RuntimeFile>,
}

#[derive(Deserialize)]
struct RuntimePiper {
    version: String,
    commit: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifestTarget {
    key: String,
    platform_name: String,
}

#[derive(Deserialize)]
struct RuntimeFile {
    sha256: String,
}

struct PiperResolutionContext {
    os: &'static str,
    arch: &'static str,
    debug: bool,
    override_dir: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    cwd: Option<PathBuf>,
}

fn runtime_target(os: &str, arch: &str) -> Result<&'static RuntimeTarget, String> {
    RUNTIME_TARGETS
        .iter()
        .find(|target| target.os == os && target.arch == arch)
        .ok_or_else(|| format!("Piper n'est pas disponible pour {os} / {arch}."))
}

fn runtime_candidates(context: &PiperResolutionContext, target: &RuntimeTarget) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if context.debug {
        if let Some(path) = &context.override_dir {
            push_candidate(&mut candidates, path.clone());
        }
    }
    if let Some(resource_dir) = &context.resource_dir {
        push_candidate(&mut candidates, resource_dir.join("tools").join("piper"));
    }
    if context.debug {
        if let Some(cwd) = &context.cwd {
            for base in cwd.ancestors() {
                push_candidate(
                    &mut candidates,
                    base.join("src-tauri")
                        .join("tools")
                        .join(target.platform_name)
                        .join("piper"),
                );
                push_candidate(
                    &mut candidates,
                    base.join("tools").join(target.platform_name).join("piper"),
                );
            }
        }
    }
    candidates
}

fn require_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| format!("{label} introuvable : {}.", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{label} doit être un fichier régulier : {}.",
            path.display()
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Lecture de {} impossible : {error}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_runtime(root: &Path, target: &RuntimeTarget) -> Result<PiperRuntime, String> {
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|_| format!("Runtime Piper introuvable : {}.", root.display()))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(format!(
            "Le runtime Piper doit être un dossier régulier : {}.",
            root.display()
        ));
    }

    let manifest_path = root.join("piper-runtime.json");
    require_regular_file(&manifest_path, "Manifeste Piper")?;
    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|error| format!("Lecture du manifeste Piper impossible : {error}"))?;
    let manifest: RuntimeManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Manifeste Piper invalide : {error}"))?;
    if manifest.schema_version != 1
        || manifest.piper.version != PIPER_VERSION
        || manifest.piper.commit != PIPER_COMMIT
        || manifest.target.key != target.manifest_key
        || manifest.target.platform_name != target.platform_name
    {
        return Err("Le manifeste Piper ne correspond pas au runtime attendu.".to_string());
    }

    for name in target.runtime_files {
        let path = root.join(name);
        require_regular_file(&path, "Fichier du runtime Piper")?;
        let expected = manifest
            .runtime_files
            .get(*name)
            .ok_or_else(|| format!("{name} absent du manifeste Piper."))?;
        let actual = sha256_file(&path)?;
        if !actual.eq_ignore_ascii_case(&expected.sha256) {
            return Err(format!("Intégrité du runtime Piper invalide : {name}."));
        }
    }

    let executable = root.join(target.executable);
    let executable_target = target_for(target.os, target.arch)
        .ok_or_else(|| "Architecture Piper non prise en charge.".to_string())?;
    validate_executable_file(&executable, executable_target)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&executable)
            .map_err(|error| format!("Permissions Piper illisibles : {error}"))?
            .permissions()
            .mode();
        if mode & 0o111 == 0 {
            return Err("L'exécutable Piper n'a pas le bit d'exécution.".to_string());
        }
    }

    let espeak_data = root.join("espeak-ng-data");
    let espeak_metadata = std::fs::symlink_metadata(&espeak_data)
        .map_err(|_| "Données espeak-ng Piper introuvables.".to_string())?;
    if espeak_metadata.file_type().is_symlink() || !espeak_metadata.is_dir() {
        return Err("Le dossier espeak-ng-data Piper est invalide.".to_string());
    }
    require_regular_file(&espeak_data.join("phondata"), "Données phonétiques Piper")?;

    Ok(PiperRuntime {
        root: root.to_path_buf(),
        executable,
    })
}

fn resolve_from_context(context: &PiperResolutionContext) -> Result<PiperRuntime, String> {
    let target = runtime_target(context.os, context.arch)?;
    let candidates = runtime_candidates(context, target);
    for candidate in &candidates {
        if std::fs::symlink_metadata(candidate).is_ok() {
            return validate_runtime(candidate, target).map_err(|error| {
                format!("Runtime Piper refusé ({}): {error}", candidate.display())
            });
        }
    }
    let searched = candidates
        .iter()
        .map(|path| format!("  - {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "Runtime Piper 1.6 introuvable. Candidats recherchés :\n{searched}"
    ))
}

pub(super) fn resolve_piper_runtime() -> Result<PiperRuntime, String> {
    resolve_from_context(&PiperResolutionContext {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        debug: cfg!(debug_assertions),
        override_dir: std::env::var_os("STORY_STUDIO_PIPER_RUNTIME").map(PathBuf::from),
        resource_dir: resource_dir(),
        cwd: std::env::current_dir().ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "story_studio_piper_runtime_{label}_{}",
            Uuid::new_v4()
        ))
    }

    fn elf(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    fn write_fixture(root: &Path, target: &RuntimeTarget, executable: &[u8]) {
        fs::create_dir_all(root.join("espeak-ng-data")).unwrap();
        fs::write(root.join("espeak-ng-data/phondata"), b"phondata").unwrap();
        let mut hashes = serde_json::Map::new();
        for name in target.runtime_files {
            let bytes = if *name == target.executable {
                executable
            } else {
                b"runtime library"
            };
            fs::write(root.join(name), bytes).unwrap();
            hashes.insert(
                (*name).to_string(),
                json!({ "sha256": format!("{:x}", Sha256::digest(bytes)) }),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                root.join(target.executable),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        fs::write(
            root.join("piper-runtime.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "piper": { "version": PIPER_VERSION, "commit": PIPER_COMMIT },
                "target": {
                    "key": target.manifest_key,
                    "platformName": target.platform_name,
                },
                "runtimeFiles": hashes,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn targets_cover_only_supported_desktop_architectures() {
        assert_eq!(
            runtime_target("windows", "x86_64").unwrap().executable,
            "piper.exe"
        );
        assert_eq!(
            runtime_target("linux", "x86_64").unwrap().manifest_key,
            "linux-x64"
        );
        assert_eq!(
            runtime_target("macos", "aarch64").unwrap().platform_name,
            "macos-aarch64"
        );
        assert!(runtime_target("linux", "aarch64").is_err());
        assert!(runtime_target("macos", "x86_64").is_err());
    }

    #[test]
    fn packaged_runtime_precedes_development_runtime() {
        let dir = temp_dir("priority");
        let resource_runtime = dir.join("resources/tools/piper");
        let dev_runtime = dir.join("src-tauri/tools/linux-x86_64/piper");
        let target = runtime_target("linux", "x86_64").unwrap();
        write_fixture(&resource_runtime, target, &elf(62));
        write_fixture(&dev_runtime, target, &elf(62));
        let context = PiperResolutionContext {
            os: "linux",
            arch: "x86_64",
            debug: true,
            override_dir: None,
            resource_dir: Some(dir.join("resources")),
            cwd: Some(dir.clone()),
        };
        assert_eq!(
            resolve_from_context(&context).unwrap().root,
            resource_runtime
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn runtime_rejects_wrong_architecture_even_with_matching_hash() {
        let dir = temp_dir("wrong_arch");
        let target = runtime_target("linux", "x86_64").unwrap();
        write_fixture(&dir, target, &elf(183));
        let error = validate_runtime(&dir, target).unwrap_err();
        assert!(error.contains("Architecture exécutable incompatible"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn runtime_rejects_tampered_file_and_manifest_identity() {
        let target = runtime_target("linux", "x86_64").unwrap();

        let tampered = temp_dir("tampered");
        write_fixture(&tampered, target, &elf(62));
        fs::write(tampered.join("libpiper.so"), b"modified").unwrap();
        assert!(validate_runtime(&tampered, target)
            .unwrap_err()
            .contains("Intégrité"));
        fs::remove_dir_all(tampered).unwrap();

        let wrong_identity = temp_dir("identity");
        write_fixture(&wrong_identity, target, &elf(62));
        let manifest_path = wrong_identity.join("piper-runtime.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["piper"]["version"] = json!("2023.11.14-2");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(validate_runtime(&wrong_identity, target)
            .unwrap_err()
            .contains("ne correspond pas"));
        fs::remove_dir_all(wrong_identity).unwrap();
    }
}
