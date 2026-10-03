//! Le cache de vue local de l'éditeur avancé.
//!
//! La vue est mémorisée **uniquement en local**. Rien n'est copié
//! dans le projet, ni à la sauvegarde, ni ailleurs. Le cache ne contient **ni
//! payload, ni médias, ni positions de nœuds** — celles-ci appartiennent à
//! `context.editorPositions`, dans le payload. Le perdre ne perd ni le pack, ni
//! sa mise en page.
//!
//! Il n'a **jamais autorité sur le document**. Une entrée qui ne correspond
//! plus se dégrade ; elle ne s'impose pas, ne répare rien, ne recrée aucun nœud
//! et ne déclenche aucune écriture dans le projet.
//!
//! Un seul mécanisme, et un seul : un dossier dans le cache applicatif, une
//! entrée JSON par clé. Pas de `localStorage` en parallèle —
//! `persistentSettings.js` reste le seul accès `localStorage` du dépôt et
//! n'accueille aucune clé de vue avancée.

#[cfg(test)]
mod tests;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::support::paths::path_key;

/// Dossier du cache applicatif qui porte les entrées de vue.
pub const CACHE_DIR_NAME: &str = "advanced-view";

/// Version du schéma d'une entrée. **Ajout toléré** : hors projet, hors dépôt,
/// perdable par construction. Elle n'entre ni dans le `.mbah`,
/// ni dans le payload.
pub const CACHE_VERSION: u64 = 1;

/// Nombre d'entrées conservées, par date d'écriture décroissante. L'élagage est
/// fait par l'écrivain, à l'écriture : une lecture ne supprime jamais rien.
pub const MAX_ENTRIES: usize = 32;

/// Le séparateur des composantes de la clé. `U+001F` (*unit separator*) ne peut
/// apparaître ni dans une identité de pack, ni dans un chemin réel : deux
/// composantes différentes ne peuvent donc pas produire la même concaténation.
const KEY_SEPARATOR: char = '\u{001F}';

/// Ce que JavaScript transmet pour désigner le projet ouvert.
///
/// La clé, elle, est **calculée ici** : elle n'est jamais fabriquée côté vue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewCacheProject {
    #[serde(default)]
    pub pack_identity: Option<String>,
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub session_dir: Option<String>,
}

impl ViewCacheProject {
    /// **Jamais `packIdentity` seule** : deux Save As du même projet
    /// partagent légitimement cette identité, et leur donner la même vue ferait
    /// fuiter la caméra d'un projet dans l'autre — l'inverse exact de l'isolation
    /// attendue entre projets.
    ///
    /// Un projet enregistré est ancré sur le chemin de son `.mbah` ; une
    /// session éphémère sur son dossier de session. Le chemin traverse
    /// `path_key`, donc la sensibilité à la casse des systèmes POSIX est
    /// respectée.
    pub fn cache_key(&self) -> Result<String, String> {
        let identity = self.pack_identity.as_deref().unwrap_or("-");
        let anchor = self
            .save_path
            .as_deref()
            .map(path_key)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                self.session_dir
                    .as_deref()
                    .map(path_key)
                    .filter(|value| !value.is_empty())
            })
            .ok_or_else(|| {
                "Une vue avancée s'ancre sur le chemin du projet ou sur son dossier de session."
                    .to_string()
            })?;
        let mut hasher = Sha256::new();
        hasher.update(identity.as_bytes());
        hasher.update(KEY_SEPARATOR.to_string().as_bytes());
        hasher.update(anchor.as_bytes());
        Ok(hex(&hasher.finalize()))
    }

    /// Vrai quand une entrée relue décrit bien **ce** projet.
    ///
    /// Une collision de clé est impossible sans égalité de l'identité et du
    /// chemin, c'est-à-dire sans qu'il s'agisse du même fichier. Ce contrôle
    /// est la ceinture : une entrée dont ces valeurs ne correspondent pas est
    /// ignorée plutôt qu'appliquée.
    fn describes(&self, stored: &ViewCacheProject) -> bool {
        let same_identity = stored.pack_identity == self.pack_identity;
        let anchor = |project: &ViewCacheProject| {
            project
                .save_path
                .as_deref()
                .map(path_key)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    project
                        .session_dir
                        .as_deref()
                        .map(path_key)
                        .filter(|value| !value.is_empty())
                })
        };
        same_identity && anchor(stored) == anchor(self)
    }
}

/// La caméra : coordonnées finies, zoom fini strictement positif.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Viewport {
    /// Une valeur non finie, un zoom nul ou négatif font ignorer **le seul
    /// `viewport`**, pas l'entrée entière : la sélection reste utilisable.
    fn is_usable(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.zoom.is_finite() && self.zoom > 0.0
    }
}

/// La sélection, ancrée sur des **chemins d'auteur**, jamais sur des index.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Selection {
    #[serde(default)]
    pub stages: Vec<String>,
    #[serde(default)]
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    #[serde(default)]
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub selection: Selection,
    #[serde(default)]
    pub last_focused_path: Option<String>,
}

/// Ce qu'une lecture rend à l'appelant.
///
/// `fingerprintMatches` dit seulement si le document a changé depuis
/// l'écriture. Il ne déclenche aucune purge : la revalidation des ancrages est
/// faite à l'affichage, contre le graphe relu, et les entrées qui ne désignent
/// plus rien sont **ignorées, pas supprimées**.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewCacheRead {
    pub key: String,
    pub view: ViewState,
    pub fingerprint_matches: bool,
    /// Vrai quand le `viewport` relu a été écarté pour domaine numérique
    /// invalide. La sélection, elle, a survécu.
    pub viewport_rejected: bool,
}

/// L'empreinte d'un document, calculée sur les octets exacts du payload.
///
/// Elle est rendue **par la lecture du graphe**, et non recalculée à chaque
/// écriture de vue : faire traverser le payload à l'IPC toutes les 800 ms
/// pendant un panoramique serait exactement le coût que le protocole de charge
/// interdit. JavaScript la traite comme un jeton opaque, comme un chemin.
pub fn document_fingerprint(payload: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn entry_path(root: &Path, key: &str) -> PathBuf {
    root.join(format!("{key}.json"))
}

/// Relit l'entrée d'un projet, ou `None` quand il n'y en a pas d'utilisable.
///
/// Aucune panne de lecture n'est une erreur : un dossier absent, un fichier
/// illisible, un JSON cassé ou une version inconnue rendent tous `None`. La vue
/// est alors reconstruite, et **rien n'est réécrit du fait de la lecture**.
pub fn read_entry(
    root: &Path,
    project: &ViewCacheProject,
    fingerprint: &str,
) -> Result<Option<ViewCacheRead>, String> {
    let key = project.cache_key()?;
    let Ok(contents) = fs::read_to_string(entry_path(root, &key)) else {
        return Ok(None);
    };
    let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(&contents) else {
        return Ok(None);
    };
    // Une version inconnue n'est pas réparée et n'est pas remplacée : elle est
    // ignorée. L'entrée ne sera écrasée que si l'auteur déplace réellement sa
    // vue dans cette session.
    if stored.get("cacheVersion").and_then(Value::as_u64) != Some(CACHE_VERSION) {
        return Ok(None);
    }
    let described = stored
        .get("project")
        .cloned()
        .and_then(|value| serde_json::from_value::<ViewCacheProject>(value).ok());
    if !described.is_some_and(|stored| project.describes(&stored)) {
        return Ok(None);
    }
    let Some(view_value) = stored.get("view") else {
        return Ok(None);
    };
    let Ok(mut view) = serde_json::from_value::<ViewState>(view_value.clone()) else {
        return Ok(None);
    };
    let viewport_rejected = view.viewport.is_some_and(|viewport| !viewport.is_usable());
    if viewport_rejected {
        view.viewport = None;
    }
    Ok(Some(ViewCacheRead {
        key,
        view,
        // Une caméra ne s'ancre à aucun nœud : elle reste appliquée même quand
        // le fichier a changé hors de Story Studio.
        fingerprint_matches: stored.get("documentFingerprint").and_then(Value::as_str)
            == Some(fingerprint),
        viewport_rejected,
    }))
}

/// Écrit l'entrée d'un projet, puis élague le dossier.
///
/// Les champs inconnus déjà présents — au premier niveau comme dans `view` —
/// sont relus, conservés et réécrits verbatim : une version ultérieure de
/// Story Studio ne perd pas ce qu'une autre y avait rangé.
pub fn write_entry(
    root: &Path,
    project: &ViewCacheProject,
    fingerprint: &str,
    view: &ViewState,
) -> Result<String, String> {
    let key = project.cache_key()?;
    fs::create_dir_all(root)
        .map_err(|error| format!("Cache de vue avancée inaccessible : {error}"))?;
    let path = entry_path(root, &key);
    let previous = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| match value {
            Value::Object(object) => Some(object),
            _ => None,
        })
        // Les inconnus d'une **autre** version ne sont pas transportés dans
        // celle-ci : ils décriraient une forme que ce schéma ne connaît pas.
        .filter(|object| object.get("cacheVersion").and_then(Value::as_u64) == Some(CACHE_VERSION));

    let mut entry = previous.clone().unwrap_or_default();
    entry.insert("cacheVersion".into(), Value::from(CACHE_VERSION));
    entry.insert("key".into(), Value::from(key.clone()));
    entry.insert("writtenAtMs".into(), Value::from(now_ms()));
    entry.insert(
        "project".into(),
        serde_json::to_value(project).map_err(|error| error.to_string())?,
    );
    entry.insert("documentFingerprint".into(), Value::from(fingerprint));
    entry.insert(
        "view".into(),
        merged_view(
            previous.as_ref().and_then(|object| object.get("view")),
            view,
        )?,
    );

    let serialized =
        serde_json::to_string(&Value::Object(entry)).map_err(|error| error.to_string())?;
    write_atomically(&path, &serialized)?;
    prune(root)?;
    Ok(key)
}

/// Fusionne la vue à écrire avec les clés inconnues de l'entrée précédente.
fn merged_view(previous: Option<&Value>, view: &ViewState) -> Result<Value, String> {
    let mut merged = match previous {
        Some(Value::Object(object)) => object.clone(),
        _ => Map::new(),
    };
    let Value::Object(current) = serde_json::to_value(view).map_err(|error| error.to_string())?
    else {
        return Err("État de vue non sérialisable en objet.".to_string());
    };
    for (key, value) in current {
        merged.insert(key, value);
    }
    Ok(Value::Object(merged))
}

/// Écriture par fichier temporaire puis renommage : une coupure pendant
/// l'écriture laisse l'entrée précédente entière plutôt qu'un fichier tronqué.
fn write_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents)
        .map_err(|error| format!("Écriture du cache de vue impossible : {error}"))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Publication du cache de vue impossible : {error}")
    })
}

/// Renomme une entrée d'une clé vers une autre — la promotion d'une session
/// éphémère en projet enregistré.
///
/// Un échec fait **abandonner** l'entrée : la vue est reconstruite, rien
/// d'autre n'est perdu. C'est pourquoi l'appelant traite le refus comme une
/// dégradation et non comme une panne de sauvegarde.
pub fn rename_entry(
    root: &Path,
    from: &ViewCacheProject,
    to: &ViewCacheProject,
) -> Result<Option<String>, String> {
    let from_key = from.cache_key()?;
    let to_key = to.cache_key()?;
    if from_key == to_key {
        return Ok(Some(to_key));
    }
    let source = entry_path(root, &from_key);
    if !source.is_file() {
        return Ok(None);
    }
    let destination = entry_path(root, &to_key);
    fs::create_dir_all(root)
        .map_err(|error| format!("Cache de vue avancée inaccessible : {error}"))?;
    fs::rename(&source, &destination)
        .map_err(|error| format!("Renommage du cache de vue impossible : {error}"))?;
    // La clé change : la valeur `project` de l'entrée doit suivre, sinon le
    // contrôle de correspondance de la prochaine lecture l'écarterait.
    if let Ok(contents) = fs::read_to_string(&destination) {
        if let Ok(Value::Object(mut entry)) = serde_json::from_str::<Value>(&contents) {
            entry.insert("key".into(), Value::from(to_key.clone()));
            entry.insert(
                "project".into(),
                serde_json::to_value(to).map_err(|error| error.to_string())?,
            );
            let serialized =
                serde_json::to_string(&Value::Object(entry)).map_err(|error| error.to_string())?;
            write_atomically(&destination, &serialized)?;
        }
    }
    Ok(Some(to_key))
}

/// Borne le dossier à `MAX_ENTRIES`, par date d'écriture décroissante.
///
/// L'élagage est fait par l'écrivain : une lecture ne supprime jamais rien, et
/// un projet simplement déplacé perd sa vue par ancienneté plutôt que par une
/// purge qui devrait deviner ce qui est encore utile.
fn prune(root: &Path) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };
    let mut candidates: Vec<(u64, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| (written_at(&path), path))
        .collect();
    if candidates.len() <= MAX_ENTRIES {
        return Ok(());
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    for (_, path) in candidates.into_iter().skip(MAX_ENTRIES) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

/// La date d'écriture déclarée par l'entrée, avec la date du fichier en repli.
fn written_at(path: &Path) -> u64 {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| value.get("writtenAtMs").and_then(Value::as_u64))
        .or_else(|| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis() as u64)
        })
        .unwrap_or(0)
}
