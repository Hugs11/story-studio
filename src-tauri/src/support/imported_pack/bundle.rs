//! Détection des **enveloppes multi-pack** : une archive qui ne contient aucun
//! pack à sa racine, mais plusieurs archives de packs indépendants.
//!
//! Ce module ne classe rien et n'ouvre aucun enfant. Il repère les archives
//! enfants dans un arbre déjà extrait et confiné, leur donne une identité
//! opaque, et refuse les inventaires qui ne sont pas portables. Le verdict
//! d'éditabilité reste la responsabilité du classifieur de `pack_reader`, seule
//! vérité sur ce qu'est un pack ouvrable.

use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

use super::source_tree::{archive_entry_name, revalidate_regular_entry, validated_directory_tree};

/// Une enveloppe est un conteneur, pas une bibliothèque : l'écran de choix ne
/// pagine pas au premier jalon, donc l'inventaire est borné.
pub(crate) const BUNDLE_MAX_CHILDREN: usize = 64;

/// Une enveloppe commence à deux enfants. Une archive qui n'en contient qu'un
/// reste un échec d'import ordinaire : elle n'a pas de choix à offrir.
pub(crate) const BUNDLE_MIN_CHILDREN: usize = 2;

/// Version de l'identité d'un enfant. L'identifiant reste **opaque** pour le
/// frontend : il ne transporte aucun chemin d'archive, donc aucun chemin venu
/// du frontend ne peut désigner une entrée à extraire.
const CHILD_IDENTITY_VERSION: &str = "v1-bundle-child-identity";

/// Version de l'empreinte du conteneur, indépendante de celle des conversions :
/// elle ne sert qu'à vérifier que l'archive n'a pas changé entre l'affichage de
/// sa liste et la sélection d'un enfant.
pub(crate) const BUNDLE_CONTAINER_FINGERPRINT_VERSION: &str = "v1-bundle-container";

/// Une archive enfant repérée dans l'arbre extrait d'une enveloppe.
///
/// `absolute` désigne un fichier de la session temporaire d'extraction : il ne
/// vaut que tant que cette session est tenue vivante par son propriétaire.
#[derive(Debug, Clone)]
pub struct BundleChildEntry {
    pub child_id: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub(crate) absolute: PathBuf,
}

/// Repère les archives enfants d'un arbre extrait dans lequel aucun pack n'a
/// été reconnu.
///
/// Rend une liste vide quand l'arbre n'est pas une enveloppe : l'appelant
/// conserve alors son erreur d'origine, qui décrit mieux le vrai problème.
pub(crate) fn collect_bundle_children(
    extracted_dir: &Path,
) -> Result<Vec<BundleChildEntry>, String> {
    let entries = validated_directory_tree(extracted_dir)?;
    let mut children = Vec::new();
    let mut portable_names = std::collections::HashSet::new();

    for entry in &entries {
        if entry.is_dir || !is_child_archive(&entry.relative) {
            continue;
        }
        let relative = archive_entry_name(&entry.relative)?;
        let metadata = revalidate_regular_entry(extracted_dir, entry)?;
        if !portable_names.insert(portable_key(&relative)) {
            return Err(format!(
                "Archive enveloppe refusée : deux packs y portent un nom que certains \
                 systèmes de fichiers ne distinguent pas ({relative})."
            ));
        }
        children.push(BundleChildEntry {
            child_id: child_identity(&relative),
            display_name: child_display_name(&entry.relative),
            size_bytes: metadata.len(),
            absolute: entry.absolute.clone(),
        });
    }

    if children.len() < BUNDLE_MIN_CHILDREN {
        return Ok(Vec::new());
    }
    if children.len() > BUNDLE_MAX_CHILDREN {
        return Err(format!(
            "Archive enveloppe refusée : elle contient {} packs (maximum {}).",
            children.len(),
            BUNDLE_MAX_CHILDREN
        ));
    }

    children.sort_by(|left, right| {
        portable_key(&left.display_name)
            .cmp(&portable_key(&right.display_name))
            .then_with(|| left.child_id.cmp(&right.child_id))
    });
    Ok(children)
}

/// Vrai si le dossier extrait contient des archives annexes à côté du pack
/// reconnu. Le pack direct l'emporte ; l'annexe est seulement journalisée, et
/// jamais présentée comme une enveloppe au premier jalon.
pub(crate) fn has_annex_archives(extracted_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(extracted_dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().is_file() && is_child_archive(Path::new(&entry.file_name())))
}

fn is_child_archive(relative: &Path) -> bool {
    matches!(
        relative
            .extension()
            .and_then(OsStr::to_str)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("zip" | "7z")
    )
}

/// Le nom montré à l'auteur : celui du fichier, sans son extension. Aucune
/// autre métadonnée n'est lue — les extraire imposerait d'ouvrir chaque média
/// de l'enveloppe pour afficher une liste.
fn child_display_name(relative: &Path) -> String {
    relative
        .file_stem()
        .and_then(OsStr::to_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            relative
                .file_name()
                .and_then(OsStr::to_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "Pack sans nom".to_string())
}

/// NFC + minuscules : la même règle de portabilité que les noms d'assets, pour
/// les mêmes volumes Windows/macOS insensibles à la casse et les mêmes formes
/// Unicode composées ou décomposées.
fn portable_key(value: &str) -> String {
    value.nfc().flat_map(char::to_lowercase).collect()
}

fn child_identity(relative: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CHILD_IDENTITY_VERSION.as_bytes());
    hasher.update([0_u8]);
    hasher.update(relative.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_tree(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "story_studio_bundle_tests_{}_{}_{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp tree");
        root
    }

    fn write_child(root: &Path, name: &str, bytes: &[u8]) {
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, bytes).expect("child");
    }

    #[test]
    fn two_child_archives_form_an_envelope() {
        let root = temp_tree("two");
        write_child(&root, "Premier.zip", b"a");
        write_child(&root, "Second.7z", b"bb");
        let children = collect_bundle_children(&root).expect("inventaire");
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].display_name, "Premier");
        assert_eq!(children[1].display_name, "Second");
        assert_eq!(children[1].size_bytes, 2);
        assert_ne!(children[0].child_id, children[1].child_id);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn a_single_child_archive_is_not_an_envelope() {
        let root = temp_tree("single");
        write_child(&root, "Seul.zip", b"a");
        assert!(collect_bundle_children(&root)
            .expect("inventaire")
            .is_empty());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn non_archive_files_are_never_children() {
        let root = temp_tree("mixed");
        write_child(&root, "Premier.zip", b"a");
        write_child(&root, "lisezmoi.txt", b"b");
        write_child(&root, "couverture.png", b"c");
        assert!(collect_bundle_children(&root)
            .expect("inventaire")
            .is_empty());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn children_in_a_subdirectory_are_listed() {
        let root = temp_tree("nested-dir");
        write_child(&root, "packs/Premier.zip", b"a");
        write_child(&root, "packs/Second.zip", b"b");
        let children = collect_bundle_children(&root).expect("inventaire");
        assert_eq!(children.len(), 2);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn identity_depends_on_the_full_entry_path_not_on_the_shown_name() {
        let root = temp_tree("identity");
        write_child(&root, "a/Meme nom.zip", b"a");
        write_child(&root, "b/Meme nom.zip", b"b");
        let children = collect_bundle_children(&root).expect("inventaire");
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].display_name, children[1].display_name);
        assert_ne!(
            children[0].child_id, children[1].child_id,
            "deux entrées distinctes ne peuvent pas partager une identité"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn an_identifier_carries_no_path() {
        let root = temp_tree("opaque");
        write_child(&root, "packs/Premier.zip", b"a");
        write_child(&root, "packs/Second.zip", b"b");
        let children = collect_bundle_children(&root).expect("inventaire");
        for child in &children {
            assert_eq!(child.child_id.len(), 64);
            assert!(child.child_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn case_only_collisions_are_refused_instead_of_presented() {
        let root = temp_tree("case");
        write_child(&root, "Premier.zip", b"a");
        write_child(&root, "PREMIER.zip", b"b");
        write_child(&root, "Second.zip", b"c");
        // Un volume insensible à la casse n'aurait jamais produit les deux
        // fichiers ; ce test ne vaut donc que là où ils coexistent.
        if fs::read_dir(&root).expect("lecture du dossier").count() == 3 {
            let error = collect_bundle_children(&root).expect_err("collision refusée");
            assert!(error.contains("ne distinguent pas"), "{error}");
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn unicode_normalization_collisions_are_refused() {
        let root = temp_tree("nfc");
        write_child(&root, "Ét\u{00e9}.zip", b"a");
        write_child(&root, "E\u{0301}t\u{00e9}.zip", b"b");
        write_child(&root, "Second.zip", b"c");
        // Un volume qui normalise les noms (APFS) n'aurait gardé qu'un seul
        // des deux fichiers ; ce test ne vaut donc que là où ils coexistent.
        if fs::read_dir(&root).expect("lecture du dossier").count() == 3 {
            let error = collect_bundle_children(&root).expect_err("collision refusée");
            assert!(error.contains("ne distinguent pas"), "{error}");
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn an_envelope_beyond_the_inventory_limit_is_refused() {
        let root = temp_tree("limit");
        for index in 0..=BUNDLE_MAX_CHILDREN {
            write_child(&root, &format!("pack-{index:03}.zip"), b"a");
        }
        let error = collect_bundle_children(&root).expect_err("limite dépassée");
        assert!(error.contains("maximum"), "{error}");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn annex_archives_are_seen_next_to_a_recognised_pack() {
        let root = temp_tree("annex");
        write_child(&root, "annexe.zip", b"a");
        assert!(has_annex_archives(&root));
        let other = temp_tree("annex-none");
        write_child(&other, "story.json", b"{}");
        assert!(!has_annex_archives(&other));
        fs::remove_dir_all(root).expect("cleanup");
        fs::remove_dir_all(other).expect("cleanup");
    }
}
