//! Garantie 1 — traçabilité exacte, re-dérivée à chaque export.
//!
//! Ce module ne fait **rien** confiance à ce que la préparation a mémorisé : il
//! recalcule. Il relit chaque instantané et recalcule son empreinte, recalcule
//! la clé de chaque tâche depuis son descripteur, relit la sortie à l'adresse
//! que cette clé désigne, et vérifie que la table d'archive est complète et
//! injective sur les contenus.
//!
//! **Sa portée est bornée.** Il établit que l'export a livré, à chaque
//! destination, ce que l'exécuteur a produit pour l'instantané que la liaison
//! désignait. Il ne dit rien de la **justesse de la liaison** elle-même — un
//! mauvais fichier lié est transporté fidèlement — ni d'une faute survenue
//! **derrière** la frontière d'exécution : les égalités constatent une chaîne
//! cohérente, elles ne l'auditent pas. Le point de confiance est l'exécuteur
//! fermé, pas ces hachages.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::Serialize;

use super::super::parallel::partition_map_parallel;
use super::digest::sha256_bytes;
use super::executor::ExecutedConversion;
use super::inventory::{InventoriedMedia, MediaDestination};
use super::naming::{is_derived_name, lunii_suffix, ArchiveNameTable};
use super::plan::ConversionTask;
use super::workspace::AdvancedWorkspace;
use super::MediaKind;

/// Un désaccord constaté sur une destination ou sur la table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OracleDisagreement {
    pub(crate) asset_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) stage_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<MediaKind>,
    pub(crate) expected: String,
    pub(crate) observed: String,
}

/// Vérifie la chaîne entière, destination par destination.
///
/// ```text
/// Stage d'auteur → assetRef → liaison → instantané (snapshotSha256)
///    → taskKey = H(snapshotSha256, plan) → sortie lue à l'adresse de taskKey
///    → nom d'archive = image de assetRef dans la table
/// ```
/// Des octets relus, et l'empreinte qu'ils portent réellement.
struct ReadContent {
    bytes: Vec<u8>,
    sha256: String,
}

/// Le détail rendu à l'auteur quand des octets n'ont pas pu être relus.
///
/// `None` ne se produit pas — la table couvre par construction toutes les
/// adresses que la vérification consulte — mais l'oracle ne s'autorise pas à
/// l'affirmer par un `expect` : son rôle est de constater, pas de paniquer.
fn error_detail(read: Option<&Result<ReadContent, String>>) -> String {
    match read {
        Some(Err(error)) => error.clone(),
        _ => "adresse absente de la relecture".to_string(),
    }
}

/// Relit **une fois** chaque instantané et chaque sortie, en parallèle.
///
/// Les adresses sont dédupliquées avant lecture : plusieurs destinations
/// partagent le même média, et plusieurs médias la même tâche.
fn read_once_each(
    workspace: &AdvancedWorkspace,
    media: &[InventoriedMedia],
    registry: &BTreeMap<String, ExecutedConversion>,
) -> BTreeMap<PathBuf, Result<ReadContent, String>> {
    let mut addresses: BTreeSet<PathBuf> = BTreeSet::new();
    for item in media {
        addresses.insert(workspace.snapshot_path(&item.snapshot_sha256));
    }
    for executed in registry.values() {
        addresses.insert(executed.output_path.clone());
    }

    let addresses: Vec<PathBuf> = addresses.into_iter().collect();
    let (read, _) = partition_map_parallel(&addresses, |address| {
        let content = match std::fs::read(address) {
            Ok(bytes) => Ok(ReadContent {
                sha256: sha256_bytes(&bytes),
                bytes,
            }),
            Err(error) => Err(error.to_string()),
        };
        Ok::<_, ()>((address.clone(), content))
    });
    read.into_iter().collect()
}

pub(crate) fn verify_attachment(
    workspace: &AdvancedWorkspace,
    destinations: &[MediaDestination],
    media: &[InventoriedMedia],
    tasks: &BTreeMap<String, ConversionTask>,
    registry: &BTreeMap<String, ExecutedConversion>,
    table: &ArchiveNameTable,
) -> Result<(), Vec<OracleDisagreement>> {
    // Les octets dont l'oracle a besoin, lus **une fois chacun et en
    // parallèle**, avant la vérification.
    //
    // Deux raisons, et la seconde compte autant que la première. Ces lectures
    // sont le coût de l'oracle — chaque instantané et chaque sortie relus et
    // ré-empreintés — et elles sont indépendantes les unes des autres. Mais
    // surtout, plusieurs destinations partagent le même média : la boucle les
    // relisait **autant de fois qu'il y a d'écrans qui les jouent**. Un son de
    // menu posé sur douze écrans était lu douze fois.
    //
    // La vérification, elle, ne bouge pas : elle consulte cette table au lieu
    // du disque, et conserve son état de bijection nom ↔ contenu, qui dépend de
    // l'ordre des destinations.
    let contents = read_once_each(workspace, media, registry);

    let mut disagreements = Vec::new();
    let mut content_of_name: BTreeMap<&str, String> = BTreeMap::new();
    let mut name_of_content: BTreeMap<String, &str> = BTreeMap::new();

    for destination in destinations {
        let asset_ref = destination.asset_ref.as_str();
        let complain = |expected: String, observed: String| OracleDisagreement {
            asset_ref: asset_ref.to_string(),
            stage_uuid: Some(destination.stage_uuid.clone()),
            kind: Some(destination.kind),
            expected,
            observed,
        };

        let Some(inventoried) = media.iter().find(|item| item.asset_ref == asset_ref) else {
            disagreements.push(complain(
                "un média inventorié".to_string(),
                "aucun".to_string(),
            ));
            continue;
        };

        // 1. L'instantané est bien à son adresse, et ses octets y sont
        //    toujours ceux qui la désignent.
        let snapshot = workspace.snapshot_path(&inventoried.snapshot_sha256);
        match contents.get(&snapshot) {
            Some(Ok(read)) if read.sha256 == inventoried.snapshot_sha256 => {}
            Some(Ok(read)) => {
                disagreements.push(complain(
                    inventoried.snapshot_sha256.clone(),
                    read.sha256.clone(),
                ));
                continue;
            }
            other => {
                disagreements.push(complain(
                    format!("l'instantané {}", inventoried.snapshot_sha256),
                    error_detail(other),
                ));
                continue;
            }
        }

        // 2. La clé de tâche est **recalculée** depuis son descripteur, et la
        //    sortie est relue à l'adresse que cette clé désigne.
        let Some(task) = tasks.get(asset_ref) else {
            disagreements.push(complain(
                "une tâche de conversion".to_string(),
                "aucune".to_string(),
            ));
            continue;
        };
        if task.snapshot_sha256() != inventoried.snapshot_sha256 {
            disagreements.push(complain(
                inventoried.snapshot_sha256.clone(),
                task.snapshot_sha256().to_string(),
            ));
            continue;
        }
        let task_key = task.task_key();
        let Some(executed) = registry.get(&task_key) else {
            disagreements.push(complain(
                format!("une sortie pour la tâche {task_key}"),
                "aucune".to_string(),
            ));
            continue;
        };
        let output = workspace.output_path(&task_key);
        if executed.output_path != output {
            disagreements.push(complain(
                output.to_string_lossy().to_string(),
                executed.output_path.to_string_lossy().to_string(),
            ));
            continue;
        }
        let output_bytes = match contents.get(&output) {
            Some(Ok(read)) if read.sha256 == executed.output_sha256 => read.bytes.as_slice(),
            Some(Ok(read)) => {
                disagreements.push(complain(
                    executed.output_sha256.clone(),
                    read.sha256.clone(),
                ));
                continue;
            }
            other => {
                disagreements.push(complain(
                    format!("la sortie {task_key}"),
                    error_detail(other),
                ));
                continue;
            }
        };

        // 3. La table est complète, et son extension est celle du format
        //    réellement établi dans les octets finaux.
        let Some(archive_name) = table.archive_name(asset_ref) else {
            disagreements.push(complain(
                "un nom d'archive".to_string(),
                "aucun".to_string(),
            ));
            continue;
        };
        let expected_extension = task.plan().output_extension();
        if !archive_name.ends_with(&format!(".{expected_extension}")) {
            disagreements.push(complain(
                format!("une extension .{expected_extension}"),
                archive_name.to_string(),
            ));
            continue;
        }

        // 4. Le nom est **celui de ce contenu**, pas seulement un nom cohérent.
        //    C'est ce qui distingue une table correcte d'une table permutée :
        //    permuter deux entrées conserve la bijection, mais donne à chaque
        //    contenu le nom de l'autre.
        if !is_derived_name(output_bytes, expected_extension, archive_name) {
            disagreements.push(complain(
                format!("le nom dérivé des octets de {task_key}"),
                archive_name.to_string(),
            ));
            continue;
        }

        // 5. Un nom, un contenu — dans les deux sens. Deux contenus distincts
        //    qui partageraient un nom s'écraseraient ; un contenu qui porterait
        //    deux noms serait écrit deux fois.
        match content_of_name.get(archive_name) {
            None => {
                content_of_name.insert(archive_name, executed.output_sha256.clone());
            }
            Some(known) if *known == executed.output_sha256 => {}
            Some(known) => {
                disagreements.push(complain(known.clone(), executed.output_sha256.clone()));
                continue;
            }
        }
        match name_of_content.get(&executed.output_sha256) {
            None => {
                name_of_content.insert(executed.output_sha256.clone(), archive_name);
            }
            Some(known) if *known == archive_name => {}
            Some(known) => {
                disagreements.push(complain((*known).to_string(), archive_name.to_string()));
                continue;
            }
        }
    }

    // 6. Toute entrée de la table a un référent, et aucun suffixe de huit
    //    caractères n'est partagé par deux noms distincts.
    let referenced: Vec<&str> = destinations
        .iter()
        .map(|destination| destination.asset_ref.as_str())
        .collect();
    for (asset_ref, archive_name) in table.entries() {
        if !referenced.contains(&asset_ref) {
            disagreements.push(OracleDisagreement {
                asset_ref: asset_ref.to_string(),
                stage_uuid: None,
                kind: None,
                expected: "une référence du document".to_string(),
                observed: format!("une entrée de table sans référent : {archive_name}"),
            });
        }
    }
    let mut suffixes: BTreeMap<String, &str> = BTreeMap::new();
    for name in table.distinct_names() {
        let suffix = lunii_suffix(name);
        match suffixes.get(&suffix) {
            None => {
                suffixes.insert(suffix, name);
            }
            Some(other) => disagreements.push(OracleDisagreement {
                asset_ref: String::new(),
                stage_uuid: None,
                kind: None,
                expected: format!("un suffixe unique pour {other}"),
                observed: format!("{name} partage le suffixe {suffix}"),
            }),
        }
    }

    if disagreements.is_empty() {
        Ok(())
    } else {
        Err(disagreements)
    }
}
