//! Helpers de normalisation de chemins partagés entre commandes Tauri.

use std::path::{Path, PathBuf};

/// Remove only Windows' verbatim disk/UNC prefix, preserving native path data.
/// Other platforms and other Windows prefixes are returned unchanged.
pub(crate) fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        use std::{
            ffi::OsString,
            os::windows::ffi::{OsStrExt, OsStringExt},
            path::{Component, Prefix},
        };
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return path;
        };
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        match prefix.kind() {
            Prefix::VerbatimDisk(_) => PathBuf::from(OsString::from_wide(&units[4..])),
            Prefix::VerbatimUNC(_, _) => {
                let mut normal = vec![b'\\' as u16, b'\\' as u16];
                normal.extend_from_slice(&units[8..]);
                PathBuf::from(OsString::from_wide(&normal))
            }
            _ => path,
        }
    }
    #[cfg(not(windows))]
    path
}

/// Fixtures must not inherit system TEMP aliases (macOS /var, Windows 8.3
/// names or junctions), including when exercising ancestor link guards.
#[cfg(test)]
pub(crate) fn canonical_temp_dir() -> std::path::PathBuf {
    without_verbatim_prefix(std::env::temp_dir().canonicalize().expect("canonical TEMP"))
}

/// Directory ancestors to inspect on disk. A Windows drive or UNC prefix by
/// itself (the last item of Path::ancestors) is not a directory path. Keep all
/// real ancestors, including the root and relative paths, for link checks.
pub(crate) fn filesystem_ancestors(path: &Path) -> impl Iterator<Item = &Path> {
    path.ancestors().filter(|ancestor| {
        !matches!(
            ancestor.components().next_back(),
            Some(std::path::Component::Prefix(_))
        )
    })
}

/// Retire le préfixe UNC `\\?\` de Windows que `fs::canonicalize` ajoute systématiquement,
/// afin de rendre le chemin compatible avec :
/// - le plugin `@tauri-apps/plugin-fs` (qui ne reconnaît pas les formes UNC dans son scope) ;
/// - la sérialisation/normalisation côté frontend (comparaisons, audits, médiathèque).
///
/// À appliquer à tout chemin natif renvoyé vers le frontend. Cela rend la frontière
/// Rust -> Tauri explicite et évite qu'une future canonicalisation fasse fuiter un
/// chemin Windows étendu dans le code JavaScript.
/// Ne pas l'utiliser pour les vérifications de sécurité internes : la forme canonique
/// reste utile pour les gardes (`is_in_trim_dir`, `delete_workspace_media_file`, etc.).
pub fn path_for_frontend(path: impl AsRef<Path>) -> String {
    let path = path.as_ref().to_string_lossy();
    if !path
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\?\"))
    {
        return path.into_owned();
    }
    let stripped = &path[4..];
    if stripped
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC\\"))
    {
        return format!(r"\\{}", &stripped[4..]);
    }
    stripped.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn native_paths_remove_only_verbatim_disk_and_unc_prefixes() {
        for (input, expected) in [
            (r"\\?\C:\Users\name\..\file", r"C:\Users\name\..\file"),
            (r"\\?\UNC\srv\share\file", r"\\srv\share\file"),
            (r"C:\regular\file", r"C:\regular\file"),
            (r"\\.\device", r"\\.\device"),
            (r"\\?\Volume{abc}\file", r"\\?\Volume{abc}\file"),
        ] {
            assert_eq!(
                without_verbatim_prefix(input.into()),
                PathBuf::from(expected)
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn native_paths_are_unchanged_on_other_platforms() {
        for input in ["/home/name/../file", "relative/file", r"\\?\C:\file", ""] {
            let path = PathBuf::from(input);
            assert_eq!(without_verbatim_prefix(path.clone()), path);
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_paths_preserve_non_utf8_names() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        let path = PathBuf::from(OsString::from_vec(b"/tmp/name-\xff".to_vec()));
        assert_eq!(without_verbatim_prefix(path.clone()), path);
    }

    #[test]
    fn filesystem_ancestors_keep_every_real_directory() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let path = root.join("child");
        let ancestors: Vec<_> = filesystem_ancestors(&path).collect();
        assert_eq!(ancestors[0], path);
        assert_eq!(ancestors[1], root);
        assert!(ancestors.last().unwrap().has_root());
        assert_eq!(
            filesystem_ancestors(Path::new("relative")).collect::<Vec<_>>(),
            Path::new("relative").ancestors().collect::<Vec<_>>()
        );
    }

    #[cfg(windows)]
    #[test]
    fn filesystem_ancestors_stop_at_drive_and_unc_roots() {
        for (path, root) in [
            (r"C:\child", r"C:\"),
            (r"\\?\C:\child", r"\\?\C:\"),
            (r"\\server\share\child", r"\\server\share\"),
            (r"\\?\UNC\server\share\child", r"\\?\UNC\server\share\"),
        ] {
            assert_eq!(
                filesystem_ancestors(Path::new(path)).last().unwrap(),
                Path::new(root)
            );
        }
    }

    #[test]
    fn strips_windows_unc_prefix() {
        assert_eq!(
            path_for_frontend(r"\\?\C:\Users\foo\bar.mp3"),
            r"C:\Users\foo\bar.mp3"
        );
    }

    #[test]
    fn converts_windows_extended_network_path() {
        assert_eq!(
            path_for_frontend(r"\\?\UNC\server\share\bar.mp3"),
            r"\\server\share\bar.mp3"
        );
    }

    #[test]
    fn accepts_case_insensitive_windows_extended_prefixes() {
        assert_eq!(
            path_for_frontend(r"\\?\unc\server\share\bar.mp3"),
            r"\\server\share\bar.mp3"
        );
    }

    #[test]
    fn leaves_regular_path_untouched() {
        assert_eq!(
            path_for_frontend(r"C:\Users\foo\bar.mp3"),
            r"C:\Users\foo\bar.mp3"
        );
    }

    #[test]
    fn leaves_unix_path_untouched() {
        assert_eq!(path_for_frontend("/home/foo/bar.mp3"), "/home/foo/bar.mp3");
    }

    #[test]
    fn handles_empty_string() {
        assert_eq!(path_for_frontend(""), "");
    }
}

/// Le jeton de comparaison d'un chemin natif — **miroir Rust** de `pathKey`
/// ([`src/utils/fileUtils.js`](../../../src/utils/fileUtils.js)).
///
/// Les deux implémentations sont vérifiées sur la **même table**,
/// `scripts/fixtures/path-key-cases.json` : la clé du cache de vue avancée est
/// calculée en Rust à partir d'un chemin que JavaScript transmet, et deux
/// normalisations divergentes feraient perdre la vue d'un projet sur une seule
/// plateforme, sans erreur visible.
///
/// La casse n'est rabattue que pour un chemin Windows — lecteur ou UNC. Un
/// chemin POSIX la conserve : son système de fichiers y est sensible.
pub fn path_key(path: &str) -> String {
    let value = strip_windows_long_path_prefix(path);
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    if is_web_path(value) || value.starts_with("blob:") || value.starts_with("data:") {
        return value.to_string();
    }
    let windows = is_windows_drive_path(value) || is_unc_path(value);
    let normalized = with_portable_separators(value);
    if windows {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// `^[a-z]+://` — un protocole, donc pas un chemin de fichier.
fn is_web_path(value: &str) -> bool {
    let scheme_length = value
        .find("://")
        .filter(|&offset| offset > 0)
        .unwrap_or(usize::MAX);
    scheme_length != usize::MAX
        && value[..scheme_length]
            .chars()
            .all(|character| character.is_ascii_alphabetic())
}

/// `^[a-z]:[\\/]`
fn is_windows_drive_path(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(drive) = characters.next() else {
        return false;
    };
    drive.is_ascii_alphabetic()
        && characters.next() == Some(':')
        && matches!(characters.next(), Some('\\') | Some('/'))
}

/// `^(?:\\\\|//)`
fn is_unc_path(value: &str) -> bool {
    value.starts_with("\\\\") || value.starts_with("//")
}

fn strip_windows_long_path_prefix(path: &str) -> String {
    if path.len() >= 8 && path[..8].eq_ignore_ascii_case(r"\\?\UNC\") {
        return format!(r"\\{}", &path[8..]);
    }
    if path.len() >= 4 && path[..4].eq_ignore_ascii_case(r"\\?\") {
        return path[4..].to_string();
    }
    path.to_string()
}

fn with_portable_separators(value: &str) -> String {
    let slashed = value.replace('\\', "/");
    let collapsed = collapse_separators(&slashed);
    if is_unc_path(value) {
        // Un partage UNC garde ses deux séparateurs de tête : les réduire
        // ferait pointer le chemin vers la racine locale.
        format!("//{}", collapse_separators(&slashed[2..]))
    } else {
        collapsed
    }
}

fn collapse_separators(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut previous_was_separator = false;
    for character in value.chars() {
        if character == '/' {
            if previous_was_separator {
                continue;
            }
            previous_was_separator = true;
        } else {
            previous_was_separator = false;
        }
        result.push(character);
    }
    result
}

#[cfg(test)]
mod path_key_tests {
    use super::path_key;

    /// La table est partagée avec la suite JavaScript. Les deux langages la
    /// lisent au même endroit : elle ne peut pas dériver d'un côté seulement.
    const CASES: &str = include_str!("../../../scripts/fixtures/path-key-cases.json");

    #[test]
    fn la_normalisation_suit_la_table_partagee_avec_javascript() {
        let table: serde_json::Value = serde_json::from_str(CASES).expect("table lisible");
        let cases = table["cases"].as_array().expect("table de cas");
        assert!(!cases.is_empty());
        for case in cases {
            let input = case["input"].as_str().expect("entrée");
            let expected = case["key"].as_str().expect("clé attendue");
            assert_eq!(
                path_key(input),
                expected,
                "{} — entrée {input:?}",
                case["why"].as_str().unwrap_or_default()
            );
        }
    }
}
