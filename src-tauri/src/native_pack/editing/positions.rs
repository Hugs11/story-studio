//! Gestes de position : déplacement authored, disposition de vue conservée, et
//! promotion explicite d'une disposition dans les métadonnées d'auteur.
//!
//! Trois choses ne doivent jamais être confondues :
//!
//! 1. une position **source** est authored et se préserve ;
//! 2. un déplacement manuel ou un « appliquer ce layout aux métadonnées »
//!    **devient** authored — donc modifie le projet et entre dans l'undo ;
//! 3. un auto-layout ou une position synthétique de projection reste **état
//!    d'éditeur** tant que l'auteur ne l'applique pas explicitement.
//!
//! Les trois gestes de ce module correspondent exactement à ces trois lignes, et
//! aucun ne franchit la frontière du suivant. La seule porte vers l'auteur reste
//! `authoring::apply_editor_position_to_authoring`, appelée ici et nulle part
//! ailleurs ; `set_authored_position` reste celle du déplacement direct.
//!
//! `SHORT_MIN`/`SHORT_MAX` ne sont pas une borne de validité du document : une
//! position héritée hors borne se conserve. Ils bornent ce que Story Studio
//! **crée**, et c'est pourquoi la promotion d'une disposition exige une
//! politique explicite au lieu d'un arrondi silencieux.

use serde::{Deserialize, Serialize};
use serde_json::Number;

use super::structure::{unique_action_index, unique_stage_index};
use super::GestureError;
use crate::native_pack::authoring::{apply_editor_position_to_authoring, set_authored_position};
use crate::native_pack::{
    stable_node_paths, DecodedStoryDocument, EditorPosition, Position, StoryDocument, ValueOrigin,
};

/// Les bornes du `short` signé que STUdio lit via `getAsShort()`.
const SHORT_MIN: f64 = -32768.0;
const SHORT_MAX: f64 = 32767.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NodeKind {
    Stage,
    Action,
}

/// Un nœud désigné par sa collection et son identifiant, jamais par son index.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeRef {
    pub(crate) kind: NodeKind,
    pub(crate) id: String,
}

/// Le chemin d'ancrage du nœud, après vérification qu'il est adressable.
///
/// Un identifiant dupliqué est refusé ici comme partout : `stable_node_paths`
/// sait distinguer les homonymes, mais l'auteur, lui, n'a désigné qu'un nom.
pub(crate) fn node_path(document: &StoryDocument, node: &NodeRef) -> Result<String, GestureError> {
    match node.kind {
        NodeKind::Stage => {
            let index = unique_stage_index(document, &node.id)?;
            Ok(
                stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
                    stage.uuid.as_str()
                })
                .swap_remove(index),
            )
        }
        NodeKind::Action => {
            let index = unique_action_index(document, &node.id)?;
            Ok(
                stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
                    action.id.as_str()
                })
                .swap_remove(index),
            )
        }
    }
}

fn position_path(document: &StoryDocument, node: &NodeRef) -> Result<String, GestureError> {
    node_path(document, node).map(|path| format!("{path}/position"))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PositionInput {
    pub(crate) x: Number,
    pub(crate) y: Number,
}

impl PositionInput {
    /// La position telle que l'auteur l'a demandée, graphie comprise.
    ///
    /// Aucun arrondi : une position fractionnaire est une valeur valide. Seules
    /// les valeurs non finies sont refusées, parce qu'elles ne sont pas
    /// représentables dans le dialecte.
    fn finite(&self, path: &str) -> Result<Position, GestureError> {
        for (axis, number) in [("x", &self.x), ("y", &self.y)] {
            if !number.as_f64().is_some_and(f64::is_finite) {
                return Err(GestureError::new(
                    "POSITION_NOT_FINITE",
                    &format!("{path}/{axis}"),
                    format!("Une coordonnée doit être un nombre fini, reçu {number}."),
                ));
            }
        }
        Ok(Position {
            x: self.x.clone(),
            y: self.y.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LayoutEntry {
    pub(crate) node: NodeRef,
    pub(crate) position: PositionInput,
}

/// La politique appliquée aux positions que la promotion ferait sortir du
/// `short`. Aucune n'est choisie par défaut : Story Studio ne doit pas créer
/// une valeur hors borne sans décision, et l'omission comme la mise à l'échelle
/// sont des pertes que l'auteur doit assumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OutOfRangePolicy {
    /// Un facteur unique, appliqué à **tout** l'ensemble promu, pour que la
    /// disposition relative soit conservée. Mettre à l'échelle nœud par nœud
    /// déplacerait les nœuds les uns par rapport aux autres.
    Scale,
    /// Les nœuds hors borne ne sont pas promus ; leur position de vue reste
    /// locale et le document ne reçoit rien pour eux.
    Omit,
    /// Refus sans mutation, avec l'inventaire des nœuds concernés.
    Refuse,
}

/// Ce qu'un geste a fait des positions et de leurs décisions d'export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PositionReport {
    /// Les chemins devenus des positions d'auteur.
    pub(crate) authored: Vec<String>,
    /// Les chemins rangés dans `context.editorPositions`, toujours hors document.
    pub(crate) editor: Vec<String>,
    /// Les chemins mis à l'échelle par la politique demandée.
    pub(crate) scaled: Vec<String>,
    /// Les chemins écartés de la promotion, leur position de vue conservée.
    pub(crate) omitted: Vec<String>,
    /// Les décisions d'export que le geste rend périmées : elles restent
    /// stockées comme trace et ne débloquent plus rien.
    pub(crate) stale_decisions: Vec<String>,
}

fn note_stale_decision(payload: &DecodedStoryDocument, path: &str, report: &mut PositionReport) {
    if payload
        .context
        .position_export_decisions
        .iter()
        .any(|decision| decision.path == path)
        && !report.stale_decisions.iter().any(|known| known == path)
    {
        report.stale_decisions.push(path.to_string());
    }
}

fn refuse(code: &'static str, path: &str, error: String) -> GestureError {
    GestureError::new(code, path, error)
}

/// Déplacement d'auteur.
///
/// La valeur entre dans le document, sa provenance devient `authored`, et une
/// décision d'export antérieure devient périmée du fait même du déplacement :
/// elle était attachée à la valeur précédente, elle ne décrit plus la nouvelle.
pub(crate) fn set_position(
    payload: &mut DecodedStoryDocument,
    node: &NodeRef,
    position: &PositionInput,
    report: &mut PositionReport,
) -> Result<(), GestureError> {
    let path = position_path(&payload.document, node)?;
    let value = position.finite(&path)?;
    note_stale_decision(payload, &path, report);
    set_authored_position(payload, &path, value)
        .map_err(|error| refuse("POSITION_NOT_ADDRESSABLE", &path, error))?;
    report.authored.push(path);
    Ok(())
}

/// Déplacement d'auteur de plusieurs nœuds d'un seul glisser : une sélection
/// entraînée d'un bloc.
///
/// Chaque entrée reçoit exactement ce que `set_position` ferait d'un glisser
/// seul ; ce qui change est la transaction, donc l'étape d'annulation unique.
/// Toute la demande est vérifiée avant la première écriture — nœud adressable,
/// valeur finie, nœud non répété — et elle est refusée entière : un groupe
/// n'est jamais à moitié déplacé.
pub(crate) fn set_positions(
    payload: &mut DecodedStoryDocument,
    entries: &[LayoutEntry],
    report: &mut PositionReport,
) -> Result<(), GestureError> {
    if entries.is_empty() {
        return Err(refuse(
            "EMPTY_LAYOUT",
            "/document",
            "Aucune position n'est fournie : le geste ne déplace rien.".to_string(),
        ));
    }
    let mut paths: Vec<String> = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = position_path(&payload.document, &entry.node)?;
        entry.position.finite(&path)?;
        if paths.contains(&path) {
            return Err(refuse(
                "DUPLICATE_LAYOUT_ENTRY",
                &path,
                "Ce nœud reçoit deux positions dans la même demande.".to_string(),
            ));
        }
        paths.push(path);
    }
    for entry in entries {
        set_position(payload, &entry.node, &entry.position, report)?;
    }
    Ok(())
}

/// Pose de nœuds qui viennent de naître : la position désignée — le point du
/// clic, le centre de la vue décalé, la place d'une carte collée — devient
/// **directement** leur position d'auteur.
///
/// Un nœud n'a qu'une position, celle du graphe à plat. Posée comme disposition
/// d'éditeur, elle restait une seconde notion que l'export ignorait et que la
/// réouverture prenait pour une absence. Les refus sont ceux de
/// `apply_view_layout` — valeur non finie, nœud répété — et la demande est
/// refusée entière : une construction n'est jamais à moitié posée.
pub(crate) fn place_authored(
    payload: &mut DecodedStoryDocument,
    entries: &[LayoutEntry],
    report: &mut PositionReport,
) -> Result<(), GestureError> {
    let mut resolved = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = position_path(&payload.document, &entry.node)?;
        let position = entry.position.finite(&path)?;
        if resolved.iter().any(|(known, _)| *known == path) {
            return Err(refuse(
                "DUPLICATE_LAYOUT_ENTRY",
                &path,
                "Ce nœud reçoit deux positions dans la même demande.".to_string(),
            ));
        }
        resolved.push((path, position));
    }
    for (path, position) in resolved {
        note_stale_decision(payload, &path, report);
        payload
            .context
            .editor_positions
            .retain(|entry| entry.path != path);
        set_authored_position(payload, &path, position)
            .map_err(|error| refuse("POSITION_NOT_ADDRESSABLE", &path, error))?;
        report.authored.push(path);
    }
    Ok(())
}

/// Conservation d'une disposition de lecture.
///
/// Elle rejoint `context.editorPositions` avec `origin: projection-derived` et
/// **ne touche pas au document**. C'est ce qui la distingue d'un déplacement :
/// la disposition reste dérivée, et sa promotion est un second geste.
pub(crate) fn apply_view_layout(
    payload: &mut DecodedStoryDocument,
    entries: &[LayoutEntry],
    report: &mut PositionReport,
) -> Result<(), GestureError> {
    if entries.is_empty() {
        return Err(refuse(
            "EMPTY_LAYOUT",
            "/context/editorPositions",
            "Aucune position n'est fournie : le geste ne conserve rien.".to_string(),
        ));
    }
    let mut resolved = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = position_path(&payload.document, &entry.node)?;
        let position = entry.position.finite(&path)?;
        if resolved.iter().any(|(known, _)| *known == path) {
            return Err(refuse(
                "DUPLICATE_LAYOUT_ENTRY",
                &path,
                "Ce nœud reçoit deux positions dans la même demande.".to_string(),
            ));
        }
        resolved.push((path, position));
    }
    for (path, position) in resolved {
        payload
            .context
            .editor_positions
            .retain(|entry| entry.path != path);
        payload.context.editor_positions.push(EditorPosition {
            path: path.clone(),
            origin: ValueOrigin::ProjectionDerived,
            position,
        });
        report.editor.push(path);
    }
    Ok(())
}

fn out_of_short_range(position: &Position) -> bool {
    [&position.x, &position.y].into_iter().any(|number| {
        number
            .as_f64()
            .is_some_and(|value| !(SHORT_MIN..=SHORT_MAX).contains(&value))
    })
}

fn scaled_number(value: f64, factor: f64) -> Option<Number> {
    Number::from_f64((value * factor).clamp(SHORT_MIN, SHORT_MAX))
}

/// Promotion explicite d'une disposition de vue dans les métadonnées d'auteur.
///
/// Les nœuds sont ceux que l'auteur désigne ; la liste vide promeut toutes les
/// positions d'éditeur du contexte. La promotion elle-même passe par
/// `apply_editor_position_to_authoring`, seule porte admise, après que la
/// politique hors borne a été appliquée à l'entrée d'éditeur.
pub(crate) fn apply_layout_to_authoring(
    payload: &mut DecodedStoryDocument,
    nodes: &[NodeRef],
    policy: OutOfRangePolicy,
    report: &mut PositionReport,
) -> Result<(), GestureError> {
    let selected: Vec<String> = if nodes.is_empty() {
        payload
            .context
            .editor_positions
            .iter()
            .map(|entry| entry.path.clone())
            .collect()
    } else {
        let mut paths = Vec::with_capacity(nodes.len());
        for node in nodes {
            let path = position_path(&payload.document, node)?;
            if !payload
                .context
                .editor_positions
                .iter()
                .any(|entry| entry.path == path)
            {
                return Err(refuse(
                    "NO_EDITOR_POSITION",
                    &path,
                    "Ce nœud ne porte aucune position d'éditeur à promouvoir.".to_string(),
                ));
            }
            paths.push(path);
        }
        paths
    };
    if selected.is_empty() {
        return Err(refuse(
            "EMPTY_LAYOUT",
            "/context/editorPositions",
            "Aucune position d'éditeur à promouvoir.".to_string(),
        ));
    }

    let excess = selected
        .iter()
        .filter_map(|path| {
            payload
                .context
                .editor_positions
                .iter()
                .find(|entry| entry.path == *path)
        })
        .filter(|entry| out_of_short_range(&entry.position))
        .map(|entry| entry.path.clone())
        .collect::<Vec<_>>();

    let mut promoted = selected.clone();
    if !excess.is_empty() {
        match policy {
            OutOfRangePolicy::Refuse => {
                return Err(refuse(
                    "POSITION_OUT_OF_SHORT_RANGE",
                    &excess[0],
                    format!(
                        "{} position(s) sortiraient de [-32768, 32767] : créer cette valeur demande une décision explicite.",
                        excess.len()
                    ),
                )
                .with_references(excess));
            }
            OutOfRangePolicy::Omit => {
                promoted.retain(|path| !excess.contains(path));
                report.omitted = excess;
                if promoted.is_empty() {
                    return Ok(());
                }
            }
            OutOfRangePolicy::Scale => {
                let peak = selected
                    .iter()
                    .filter_map(|path| {
                        payload
                            .context
                            .editor_positions
                            .iter()
                            .find(|entry| entry.path == *path)
                    })
                    .flat_map(|entry| [&entry.position.x, &entry.position.y])
                    .filter_map(Number::as_f64)
                    .fold(0.0_f64, |peak, value| peak.max(value.abs()));
                // Un seul facteur pour tout l'ensemble : la disposition
                // relative des nœuds est ce que l'auteur a construit.
                let factor = if peak > SHORT_MAX {
                    SHORT_MAX / peak
                } else {
                    1.0
                };
                for path in &selected {
                    let Some(entry) = payload
                        .context
                        .editor_positions
                        .iter_mut()
                        .find(|entry| entry.path == *path)
                    else {
                        continue;
                    };
                    let (Some(x), Some(y)) = (
                        entry
                            .position
                            .x
                            .as_f64()
                            .and_then(|value| scaled_number(value, factor)),
                        entry
                            .position
                            .y
                            .as_f64()
                            .and_then(|value| scaled_number(value, factor)),
                    ) else {
                        return Err(refuse(
                            "POSITION_NOT_FINITE",
                            path,
                            "La mise à l'échelle ne produit pas un nombre représentable."
                                .to_string(),
                        ));
                    };
                    entry.position = Position { x, y };
                    report.scaled.push(path.clone());
                }
            }
        }
    }

    for path in promoted {
        note_stale_decision(payload, &path, report);
        apply_editor_position_to_authoring(payload, &path)
            .map_err(|error| refuse("POSITION_NOT_ADDRESSABLE", &path, error))?;
        report.authored.push(path);
    }
    Ok(())
}
