//! La copie graphe d'un projet par menus.
//!
//! Un projet graphe, c'est un document à plat et la liste « quel média, quel
//! fichier ». Le document à plat d'un projet par menus existe déjà : c'est
//! celui que la projection d'écoute obtient du **vrai** générateur, sans
//! préparer aucun média. Ce module ne construit donc rien lui-même ; il
//! reprend cette projection, en fait un payload d'auteur, puis vérifie que la
//! chaîne du graphe en tire la même structure de pack.
//!
//! # Ce qu'il ne fait pas
//!
//! Il ne touche ni au générateur, ni à la navigation générée, ni aux packs que
//! produit l'éditeur par menus. Il n'écrit rien sur le disque et ne copie aucun
//! média : chaque liaison désigne le fichier même que l'original emploie.
//!
//! # Les deux refus
//!
//! - Un pack inclus dans l'arbre garde ses médias dans son archive : le graphe
//!   n'aurait aucun fichier à lier. La copie est refusée.
//! - La **garde de fidélité** relit le payload comme le graphe le relit, en
//!   prépare la copie d'export, et la compare à la projection de l'original
//!   par la comparaison structurelle du juge. Un écart refuse la copie : il
//!   n'y a pas de conversion dégradée.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::domain::project::Project;

use super::assets::pipeline::{collect_asset_requests, AssetSourceKind};
use super::fidelity_judge::compare_documents_structural;
use super::persistence::{
    decode_authoring_payload, encode_authoring_payload, AdvancedMediaBinding, MediaBindingStatus,
};
use super::preparation::prepare_graph_document_for_export;
use super::simulation::{project_story_for_simulation, SIMULATION_MISSING_ASSET};
use super::{
    canonicalize_project, classify_stage_id, DecodedStoryDocument, PackIdentity, Presence,
    StoryDocumentContext,
};

/// Refus lisible par l'auteur ; le détail technique suit, séparé.
pub(crate) const INCLUDED_PACK_REFUSAL: &str =
    "Ton projet contient un pack inclus. L'éditeur graphe ne sait pas encore le reprendre.";
pub(crate) const UNFAITHFUL_REFUSAL: &str =
    "La copie graphe ne produirait pas exactement le même pack que ton projet. Rien n'a été créé.";
pub(crate) const IDENTITY_REFUSAL: &str =
    "L'identité du pack de ton projet est illisible : la copie graphe ne pourrait pas la garder.";

/// Ce que l'interface reçoit : la chaîne de payload et ses liaisons, dérivées
/// ensemble du même document, comme pour toute acquisition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphCopy {
    pub(crate) payload: String,
    pub(crate) media_bindings: Vec<AdvancedMediaBinding>,
}

/// Un emplacement média que l'auteur n'a pas encore rempli. Chacun reçoit sa
/// propre référence, liée à aucun fichier : il apparaît comme manquant dans le
/// graphe, et le remplir sur un Écran ne remplit pas les autres.
fn absent_reference(index: usize, field: &str) -> String {
    let extension = if field == "image" { "png" } else { "mp3" };
    format!("absent{index:04}.{extension}")
}

/// La copie graphe d'un projet par menus : payload d'auteur et liaisons.
pub(crate) fn graph_copy_of_project(project: &Project) -> Result<GraphCopy, String> {
    refuse_included_packs(project)?;
    let identity = pack_identity_of(project)?;
    let projection = project_story_for_simulation(project)?;

    let files: HashMap<&str, &str> = projection
        .media
        .iter()
        .filter_map(|media| {
            media
                .path
                .as_deref()
                .map(|path| (media.asset_name.as_str(), path))
        })
        .collect();

    let mut document = projection.story.clone();
    let mut bindings: BTreeMap<String, AdvancedMediaBinding> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut absent_count = 0usize;
    for stage in &mut document.stage_nodes {
        for (field, slot) in [("audio", &mut stage.audio), ("image", &mut stage.image)] {
            let Presence::Value(name) = slot else {
                continue;
            };
            let asset_ref = if name == SIMULATION_MISSING_ASSET {
                absent_count += 1;
                absent_reference(absent_count, field)
            } else {
                name.clone()
            };
            if !bindings.contains_key(&asset_ref) {
                let path = files.get(name.as_str()).map(|path| path.to_string());
                let status = match path.as_deref() {
                    Some(path) if Path::new(path).is_file() => MediaBindingStatus::Resolved,
                    _ => MediaBindingStatus::Missing,
                };
                order.push(asset_ref.clone());
                bindings.insert(
                    asset_ref.clone(),
                    AdvancedMediaBinding {
                        asset_ref: asset_ref.clone(),
                        path,
                        status,
                    },
                );
            }
            *slot = Presence::Value(asset_ref);
        }
    }

    let mut context = StoryDocumentContext::created();
    context.pack_identity = PackIdentity::chosen(&identity, &context.pack_identity);
    let payload = encode_authoring_payload(&DecodedStoryDocument {
        document,
        source_value: serde_json::Value::Null,
        context,
    })
    .map_err(|error| error.to_string())?;

    Ok(GraphCopy {
        payload,
        media_bindings: order
            .into_iter()
            .filter_map(|asset_ref| bindings.remove(&asset_ref))
            .collect(),
    })
}

/// Garde de fidélité : le pack que la copie produirait a-t-il la structure
/// de celui que produit l'original ? Elle relit le payload **tel que le graphe
/// le relit** — y compris après la disposition calculée à l'ouverture — et
/// passe par la préparation d'export du graphe, sans médias.
pub(crate) fn verify_graph_copy(project: &Project, payload: &str) -> Result<(), String> {
    let original = project_story_for_simulation(project)?.story;
    let decoded = decode_authoring_payload(payload)
        .map_err(|error| format!("{UNFAITHFUL_REFUSAL}\n{error}"))?;
    let prepared = prepare_graph_document_for_export(&decoded)
        .map_err(|error| format!("{UNFAITHFUL_REFUSAL}\n{error:?}"))?;
    let report = compare_documents_structural(&prepared.document, &original);
    if report.faithful {
        return Ok(());
    }
    Err(format!("{UNFAITHFUL_REFUSAL}\n{}", report.gaps.join("\n")))
}

fn refuse_included_packs(project: &Project) -> Result<(), String> {
    let canonical = canonicalize_project(project);
    let includes_pack = collect_asset_requests(&canonical, 0.0, 0.0)
        .iter()
        .any(|request| matches!(request.source_kind, AssetSourceKind::Zip));
    if includes_pack {
        return Err(INCLUDED_PACK_REFUSAL.to_string());
    }
    Ok(())
}

/// L'identité du pack est celle que le projet par menus donne à son Écran
/// d'entrée, gardée dans sa graphie : la copie remplace le même pack sur
/// l'appareil.
fn pack_identity_of(project: &Project) -> Result<String, String> {
    let identity = project.pack_uuid.trim();
    if identity.is_empty() || !classify_stage_id(identity).bridge_compatible {
        return Err(IDENTITY_REFUSAL.to_string());
    }
    Ok(identity.to_string())
}

/// Les fichiers qu'un document désigne par ses liaisons, pour les preuves.
#[cfg(test)]
pub(crate) fn bound_files(copy: &GraphCopy) -> Vec<String> {
    let mut files: Vec<String> = copy
        .media_bindings
        .iter()
        .filter_map(|binding| binding.path.clone())
        .collect();
    files.sort();
    files.dedup();
    files
}
