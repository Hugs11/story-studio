//! Assemblage du ZIP **local** d'un pack STUdio, commun aux deux writers.
//!
//! Le mode Libre et l'export avancé écrivent la même archive : `story.json` à
//! la racine, les médias sous `assets/` en noms nus, et `thumbnail.png` en
//! sidecar. Ils ne diffèrent que par la **provenance** de ces trois choses — un
//! rapport de préparation hiérarchique d'un côté, la préparation avancée de
//! l'autre. Ce module porte donc la mécanique, et les deux appelants portent
//! les données.
//!
//! Il n'écrit **que** le ZIP local. Le préflight du dossier de destination et la
//! publication atomique restent dans `writer.rs` : ce sont les deux points où
//! l'export touche le dossier choisi par l'auteur, et ils doivent rester
//! uniques.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Un média à écrire dans l'archive, une fois par nom distinct.
pub(super) struct ArchiveAsset<'a> {
    /// Nom nu dans l'archive : l'entrée écrite est `assets/<archive_name>`,
    /// plate et sans sous-dossier, la seule forme que les deux passerelles
    /// figées savent consommer.
    pub(super) archive_name: &'a str,
    /// Fichier déjà préparé, relu tel quel : ce module ne convertit rien.
    pub(super) source_path: &'a Path,
}

/// Le contenu exact d'une archive, avant écriture.
pub(super) struct ArchiveContents<'a> {
    pub(super) story_json: &'a str,
    pub(super) assets: Vec<ArchiveAsset<'a>>,
    /// Couverture déjà encodée en PNG. `None` quand l'écran d'entrée n'a pas
    /// d'image : c'est un succès sans couverture, jamais un refus (D-04).
    pub(super) thumbnail_png: Option<Vec<u8>>,
}

/// Panne d'écriture locale : `output-write`.
///
/// Elle nomme **ce qu'on écrivait** et **où**, parce qu'un appelant typé doit
/// pouvoir rendre les deux sans réanalyser un message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ZipWriteError {
    pub(super) path: String,
    pub(super) entry: Option<String>,
    pub(super) message: String,
}

impl ZipWriteError {
    fn at(path: &Path, message: impl std::fmt::Display) -> Self {
        Self {
            path: path.to_string_lossy().to_string(),
            entry: None,
            message: message.to_string(),
        }
    }

    fn entry(path: &Path, entry: &str, message: impl std::fmt::Display) -> Self {
        Self {
            path: path.to_string_lossy().to_string(),
            entry: Some(entry.to_string()),
            message: message.to_string(),
        }
    }
}

impl std::fmt::Display for ZipWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.entry {
            Some(entry) => write!(
                formatter,
                "Écriture de '{entry}' impossible dans le ZIP local '{}' : {}",
                self.path, self.message
            ),
            None => write!(
                formatter,
                "Écriture du ZIP local '{}' impossible : {}",
                self.path, self.message
            ),
        }
    }
}

/// Écrit l'archive locale à `zip_path`, dans l'ordre `story.json`, `assets/`,
/// `thumbnail.png`.
///
/// Les médias sont dédupliqués **par nom d'archive** : deux références qui
/// partagent un contenu partagent légitimement un nom, et l'archive ne
/// porte alors qu'un fichier.
pub(super) fn write_pack_zip(
    contents: &ArchiveContents<'_>,
    zip_path: &Path,
) -> Result<(), ZipWriteError> {
    if let Some(parent) = zip_path.parent() {
        fs::create_dir_all(parent).map_err(|error| ZipWriteError::at(parent, error))?;
    }

    let out_file =
        fs::File::create(zip_path).map_err(|error| ZipWriteError::at(zip_path, error))?;
    let mut out_zip = zip::ZipWriter::new(out_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    add_entry(&mut out_zip, opts, zip_path, "story.json", |writer| {
        writer.write_all(contents.story_json.as_bytes())
    })?;

    let mut written = HashSet::new();
    for asset in &contents.assets {
        if !written.insert(asset.archive_name) {
            continue;
        }
        let entry_name = format!("assets/{}", asset.archive_name);
        let bytes = fs::read(asset.source_path)
            .map_err(|error| ZipWriteError::entry(asset.source_path, &entry_name, error))?;
        add_entry(&mut out_zip, opts, zip_path, &entry_name, |writer| {
            writer.write_all(&bytes)
        })?;
    }

    if let Some(thumbnail) = &contents.thumbnail_png {
        add_entry(&mut out_zip, opts, zip_path, "thumbnail.png", |writer| {
            writer.write_all(thumbnail)
        })?;
    }

    out_zip
        .finish()
        .map_err(|error| ZipWriteError::at(zip_path, error))?;
    Ok(())
}

fn add_entry(
    zip: &mut zip::ZipWriter<fs::File>,
    opts: zip::write::SimpleFileOptions,
    zip_path: &Path,
    entry_name: &str,
    write: impl FnOnce(&mut zip::ZipWriter<fs::File>) -> std::io::Result<()>,
) -> Result<(), ZipWriteError> {
    zip.start_file(entry_name, opts)
        .map_err(|error| ZipWriteError::entry(zip_path, entry_name, error))?;
    write(zip).map_err(|error| ZipWriteError::entry(zip_path, entry_name, error))
}

/// Prépare le dossier du ZIP local et rend son chemin.
///
/// Le nom est celui du projet assaini, comme en mode Libre : l'archive publiée
/// hérite du même nom, et deux exports successifs ne se marchent pas dessus.
pub(super) fn local_zip_path(
    local_output_dir: &Path,
    project_name: &str,
) -> Result<PathBuf, ZipWriteError> {
    fs::create_dir_all(local_output_dir)
        .map_err(|error| ZipWriteError::at(local_output_dir, error))?;
    Ok(super::writer::export_zip_path(
        local_output_dir,
        project_name,
    ))
}
