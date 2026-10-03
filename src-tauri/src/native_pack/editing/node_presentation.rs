//! Présentation propre à Story Studio et nom d'auteur des nœuds.
//!
//! La couleur reste dans `StoryDocumentContext` : elle survit au `.mbah` et à
//! undo/redo, mais n'est jamais injectée dans le dialecte exporté. Le nom suit
//! au contraire les trois formes de présence du dialecte et modifie le champ
//! `name` réel du Stage ou de l'Action.

use std::collections::HashSet;

use super::anchors::node_anchor_paths;
use super::metadata::TextUpdate;
use super::positions::{node_path, NodeKind, NodeRef};
use super::structure::{unique_action_index, unique_stage_index};
use super::GestureError;
use crate::native_pack::{DecodedStoryDocument, NodeColor, StoryDocument};

/// Même palette que le Libre. La frontière native la ferme pour qu'un payload
/// manuel ne puisse pas installer une couleur que l'interface ne sait ni
/// nommer, ni filtrer, ni effacer proprement.
const NODE_COLORS: [&str; 7] = [
    "#e24b4a", "#ef9f27", "#f0c84b", "#5fbf6b", "#3d9be9", "#7c6af7", "#d95bb4",
];

pub(crate) fn set_node_name(
    document: &mut StoryDocument,
    node: &NodeRef,
    update: &TextUpdate,
) -> Result<(), GestureError> {
    // Résoudre avant toute écriture garantit que l'identifiant dupliqué refuse
    // sans choisir arbitrairement l'un de ses homonymes.
    let path = node_path(document, node)?;
    match node.kind {
        NodeKind::Stage => {
            let index = unique_stage_index(document, &node.id)?;
            document.stage_nodes[index].name = update.clone().presence();
        }
        NodeKind::Action => {
            let index = unique_action_index(document, &node.id)?;
            document.action_nodes[index].name = update.clone().presence();
        }
    }
    // Le chemin sert à garder une cause précise si ce module évolue : le nom
    // vide est, lui, volontairement autorisé et déclenche le repli d'affichage.
    debug_assert!(!path.is_empty());
    Ok(())
}

pub(crate) fn set_node_color(
    payload: &mut DecodedStoryDocument,
    paths: &[String],
    color: Option<&str>,
) -> Result<(), GestureError> {
    if paths.is_empty() {
        return Err(GestureError::new(
            "EMPTY_NODE_COLOR_TARGETS",
            "/context/nodeColors",
            "Aucun nœud n'est visé par le changement de couleur.".to_string(),
        ));
    }
    if let Some(value) = color {
        if !NODE_COLORS.contains(&value) {
            return Err(GestureError::new(
                "UNSUPPORTED_NODE_COLOR",
                "/context/nodeColors",
                format!("La couleur « {value} » n'appartient pas à la palette de l'éditeur."),
            ));
        }
    }

    let known: HashSet<String> = node_anchor_paths(&payload.document).into_iter().collect();
    let mut unique = HashSet::with_capacity(paths.len());
    for path in paths {
        if !known.contains(path) {
            return Err(GestureError::new(
                "UNKNOWN_NODE_PATH",
                path,
                "Ce chemin ne désigne aucun nœud du document courant.".to_string(),
            ));
        }
        if !unique.insert(path.clone()) {
            return Err(GestureError::new(
                "DUPLICATE_NODE_COLOR_TARGET",
                path,
                "Le même nœud est visé deux fois par ce changement de couleur.".to_string(),
            ));
        }
    }

    payload
        .context
        .node_colors
        .retain(|entry| !unique.contains(&entry.path));
    if let Some(value) = color {
        payload
            .context
            .node_colors
            .extend(paths.iter().map(|path| NodeColor {
                path: path.clone(),
                color: value.to_string(),
            }));
    }
    Ok(())
}
