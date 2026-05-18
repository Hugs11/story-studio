//! Helpers de normalisation de chemins partagés entre commandes Tauri.

/// Retire le préfixe UNC `\\?\` de Windows que `fs::canonicalize` ajoute systématiquement,
/// afin de rendre le chemin compatible avec :
/// - le plugin `@tauri-apps/plugin-fs` (qui ne reconnaît pas les formes UNC dans son scope) ;
/// - la sérialisation/normalisation côté frontend (comparaisons, audits, médiathèque).
///
/// À appliquer sur tout chemin renvoyé vers le frontend après une canonicalisation.
/// Ne pas l'utiliser pour les vérifications de sécurité internes : la forme canonique
/// reste utile pour les gardes (`is_in_trim_dir`, `delete_workspace_media_file`, etc.).
pub fn path_for_frontend(path: &str) -> String {
    let Some(stripped) = path.strip_prefix(r"\\?\") else {
        return path.to_string();
    };
    if let Some(unc_path) = stripped.strip_prefix(r"UNC\") {
        return format!(r"\\{}", unc_path);
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
