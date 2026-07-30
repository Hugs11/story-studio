//! Helpers de normalisation de chemins partagés entre commandes Tauri.

use std::path::Path;

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
