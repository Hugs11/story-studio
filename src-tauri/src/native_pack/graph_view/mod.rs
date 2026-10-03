//! `read_advanced_graph_view` — la projection de lecture de l'éditeur avancé.
//!
//! Module **frère en lecture seule** de `native_pack` : il n'appelle aucun
//! constructeur, aucun writer et aucun préparateur, ne mute rien et ne touche
//! pas au disque. Il vit ici, et non à l'extérieur, parce qu'il a besoin de
//! `decode_authoring_payload`, `stable_node_paths`, `Presence`,
//! `OptionSelection` et `value_origin`, tous `pub(crate)` : un module extérieur
//! exigerait de les rendre publics, c'est-à-dire d'élargir la surface la plus
//! critique du dépôt pour une fonction de lecture.
//!
//! Trois invariants encadrent tout le fichier :
//!
//! - le DTO est une **projection**, jamais une seconde vérité ;
//! - rien ici ne devient persistant ;
//! - position source et disposition dérivée gardent deux propriétaires
//!   distincts.

pub(crate) mod dto;
mod layout;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use dto::*;
use layout::{fallback_layout, resolve_ranked_layout, EditorPositionIndex, NodeBand};

use super::authoring::{
    classify_group, collect_groups, diagnose_enriched_metadata, value_origin, KnownGroupKind,
};
use super::dialect::{compact_value_bounded, stable_node_paths, DecodedStoryDocument};
use super::document::{ActionNode, StoryDocument, ACTION_NODE_FALLBACK_NAME};
use super::integrity::validate_graph_document_integrity;
use super::option_selection::OptionSelection;
use super::persistence::{decode_authoring_payload, PersistenceError};
use super::presence::Presence;
use crate::services::advanced_view_cache::document_fingerprint;

/// Lit un payload d'auteur et rend sa vue dérivée.
///
/// Elle ne définit **aucun code d'erreur propre** : les refus du codec de projet
/// ressortent tels quels, avec leur `code`, `path`, `found` et `expected`. Un
/// document décodable mais invalide au sens GVI est **lu, pas refusé** — c'est
/// la seule façon de le montrer à l'auteur pour qu'il le répare.
pub(crate) fn read_advanced_graph_view(
    payload: &str,
) -> Result<AdvancedGraphView, PersistenceError> {
    let decoded = decode_authoring_payload(payload)?;
    let mut view = project_graph_view(&decoded);
    view.document_fingerprint = document_fingerprint(payload);
    Ok(view)
}

/// Le cœur de la projection, séparé de la porte IPC pour être éprouvé sur un
/// document déjà décodé.
pub(crate) fn project_graph_view(payload: &DecodedStoryDocument) -> AdvancedGraphView {
    let document = &payload.document;
    let stage_paths = stage_paths(document);
    let action_paths = action_paths(document);
    let index = NodeIndex::new(document, &stage_paths, &action_paths);
    let editor_positions = EditorPositionIndex::new(&payload.context.editor_positions);
    let node_colors: HashMap<&str, &str> = payload
        .context
        .node_colors
        .iter()
        .map(|entry| (entry.path.as_str(), entry.color.as_str()))
        .collect();

    let stages = project_stages(
        payload,
        &stage_paths,
        &index,
        &editor_positions,
        &node_colors,
    );
    let actions = project_actions(
        payload,
        &action_paths,
        &index,
        &editor_positions,
        &node_colors,
    );
    let edges = project_edges(&stages, &actions);
    let media_refs = project_media_refs(&stages);
    let groups = project_groups(document, &stage_paths, &action_paths);
    let opaque_members = project_opaque_members(payload, &index);
    let diagnostics = project_diagnostics(payload, &index);

    AdvancedGraphView {
        view_version: GRAPH_VIEW_VERSION,
        // L'empreinte porte sur les octets du payload, que cette fonction ne
        // reçoit pas : `read_advanced_graph_view` la renseigne. Une projection
        // faite sur un document déjà décodé n'en a pas, et le dit.
        document_fingerprint: String::new(),
        document_origin: payload.context.document_origin,
        default_value_origin: payload.context.default_value_origin,
        pack_identity: PackIdentityView {
            origin: payload.context.pack_identity.origin,
            value: payload.context.pack_identity.value.clone(),
            short_identity: payload.context.pack_identity.short_identity.clone(),
            source_path: payload.context.pack_identity.source_path.clone(),
            unresolved_reason: payload.context.pack_identity.unresolved_reason.clone(),
            generation_reason: payload.context.pack_identity.generation_reason.clone(),
        },
        metadata: DocumentMetadataView {
            title: PresenceView::of(&document.title),
            version: PresenceView::of(&document.version),
            description: PresenceView::of(&document.description),
            uuid: PresenceView::of(&document.uuid),
        },
        entry: project_entry(document, &stage_paths),
        counts: CountsView {
            stages: stages.len(),
            actions: actions.len(),
            options: actions.iter().map(|action| action.options.len()).sum(),
            edges: edges.len(),
        },
        stages,
        actions,
        edges,
        media_refs,
        groups,
        opaque_members,
        diagnostics,
    }
}

fn stage_paths(document: &StoryDocument) -> Vec<String> {
    stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    })
}

fn action_paths(document: &StoryDocument) -> Vec<String> {
    stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
        action.id.as_str()
    })
}

/// Résolution des références du dialecte, construite une fois par lecture.
///
/// Comme le validateur d'intégrité, elle retient la **première** occurrence
/// d'un identifiant dupliqué : la lecture reste lisible sur un document qui
/// porte déjà un doublon, et le doublon lui-même reste visible par `uniqueId`
/// sur chaque nœud plutôt que par un choix silencieux.
struct NodeIndex<'a> {
    stage_by_id: HashMap<&'a str, usize>,
    action_by_id: HashMap<&'a str, usize>,
    stage_occurrences: HashMap<&'a str, usize>,
    action_occurrences: HashMap<&'a str, usize>,
    stage_paths: &'a [String],
    action_paths: &'a [String],
}

impl<'a> NodeIndex<'a> {
    fn new(
        document: &'a StoryDocument,
        stage_paths: &'a [String],
        action_paths: &'a [String],
    ) -> Self {
        let mut stage_by_id = HashMap::with_capacity(document.stage_nodes.len());
        let mut stage_occurrences: HashMap<&str, usize> = HashMap::new();
        for (position, stage) in document.stage_nodes.iter().enumerate() {
            stage_by_id.entry(stage.uuid.as_str()).or_insert(position);
            *stage_occurrences.entry(stage.uuid.as_str()).or_default() += 1;
        }
        let mut action_by_id = HashMap::with_capacity(document.action_nodes.len());
        let mut action_occurrences: HashMap<&str, usize> = HashMap::new();
        for (position, action) in document.action_nodes.iter().enumerate() {
            action_by_id.entry(action.id.as_str()).or_insert(position);
            *action_occurrences.entry(action.id.as_str()).or_default() += 1;
        }
        Self {
            stage_by_id,
            action_by_id,
            stage_occurrences,
            action_occurrences,
            stage_paths,
            action_paths,
        }
    }

    fn stage_path(&self, uuid: &str) -> Option<&str> {
        self.stage_by_id
            .get(uuid)
            .map(|&position| self.stage_paths[position].as_str())
    }

    fn action(&self, id: &str) -> Option<(usize, &str)> {
        self.action_by_id
            .get(id)
            .map(|&position| (position, self.action_paths[position].as_str()))
    }

    fn stage_is_unique(&self, uuid: &str) -> bool {
        self.stage_occurrences.get(uuid).copied().unwrap_or(0) <= 1
    }

    fn action_is_unique(&self, id: &str) -> bool {
        self.action_occurrences.get(id).copied().unwrap_or(0) <= 1
    }

    /// Le préfixe de nœud d'un chemin d'auteur, calculé **ici** pour que
    /// JavaScript n'ait jamais à découper un chemin.
    ///
    /// Un chemin de nœud a exactement trois segments : la racine, la
    /// collection et `@champ=identifiant#occurrence`. L'identifiant a ses `/`
    /// échappés en `~1` par `stable_node_paths`, donc aucune graphie source ne
    /// peut ajouter un segment : la coupure au troisième `/` est exacte, même
    /// pour un identifiant qui contient lui-même un `#`.
    fn node_path_of(&self, path: &str) -> Option<String> {
        let candidate = node_path_prefix(path)?;
        let known = self
            .stage_paths
            .iter()
            .chain(self.action_paths.iter())
            .any(|node_path| node_path == candidate);
        known.then(|| candidate.to_string())
    }
}

fn node_path_prefix(path: &str) -> Option<&str> {
    let rest = path.strip_prefix('/')?;
    let (collection, tail) = rest.split_once('/')?;
    if collection != "stageNodes" && collection != "actionNodes" {
        return None;
    }
    let tail_start = 1 + collection.len() + 1;
    let end = tail
        .find('/')
        .map(|offset| tail_start + offset)
        .unwrap_or(path.len());
    Some(&path[..end])
}

/// L'occurrence d'un nœud, lue dans son propre chemin plutôt que recomptée.
///
/// Le chemin est produit par `stable_node_paths` : son suffixe `#<occurrence>`
/// est la seule autorité sur ce numéro, et le relire évite qu'une seconde règle
/// de comptage diverge un jour de la première.
fn occurrence_of(path: &str) -> usize {
    path.rsplit_once('#')
        .and_then(|(_, suffix)| suffix.parse().ok())
        .unwrap_or(0)
}

fn project_entry(document: &StoryDocument, stage_paths: &[String]) -> EntryView {
    let candidates: Vec<String> = document
        .stage_nodes
        .iter()
        .zip(stage_paths)
        .filter(|(stage, _)| stage.is_square_one())
        .map(|(_, path)| path.clone())
        .collect();
    match candidates.len() {
        0 => EntryView {
            status: EntryStatus::Missing,
            stage_path: None,
            candidates,
        },
        1 => EntryView {
            status: EntryStatus::Unique,
            stage_path: candidates.first().cloned(),
            candidates,
        },
        // L'export refusera ce document (un seul `squareOne` est exigé) ; la
        // lecture, elle, le montre avec ses candidats, parce que c'est ce qui
        // permet de le réparer.
        _ => EntryView {
            status: EntryStatus::Ambiguous,
            stage_path: None,
            candidates,
        },
    }
}

fn project_stages(
    payload: &DecodedStoryDocument,
    stage_paths: &[String],
    index: &NodeIndex<'_>,
    editor_positions: &EditorPositionIndex<'_>,
    node_colors: &HashMap<&str, &str>,
) -> Vec<StageView> {
    let document = &payload.document;
    // Le rang du placement de secours est celui du nœud **dans sa
    // collection**, et le nombre de colonnes vient de la taille de cette
    // collection. Un rang dense sur les seuls nœuds sans disposition faisait
    // glisser toute la grille dès qu'un nœud recevait une position : le
    // suivant venait occuper la place libérée. Ici, cette place reste un trou.
    let stage_count = document.stage_nodes.len();
    document
        .stage_nodes
        .iter()
        .zip(stage_paths)
        .enumerate()
        .map(|(position, (stage, path))| {
            let source_position = stage.position.value().map(PositionView::of);
            let position_origin = value_origin(payload, &format!("{path}/position"));
            let layout = resolve_ranked_layout(
                path,
                source_position.as_ref(),
                editor_positions,
                position_origin,
            )
            .unwrap_or_else(|| fallback_layout(position, stage_count, NodeBand::Stage));
            StageView {
                path: path.clone(),
                personal_color: node_colors
                    .get(path.as_str())
                    .map(|color| (*color).to_string()),
                uuid: stage.uuid.clone(),
                occurrence: occurrence_of(path),
                unique_id: index.stage_is_unique(&stage.uuid),
                name: PresenceView::of(&stage.name),
                // Repli historique d'un Stage sans nom : la chaîne vide.
                fallback_label: stage.label().to_string(),
                stage_type: PresenceView::of(&stage.stage_type),
                square_one: PresenceView::of(&stage.square_one),
                group_id: PresenceView::of(&stage.group_id),
                controls: project_controls(&stage.control_settings),
                audio: MediaSlotView::of(&stage.audio),
                image: MediaSlotView::of(&stage.image),
                ok_transition: project_transition(&stage.ok_transition, index, document),
                home_transition: project_transition(&stage.home_transition, index, document),
                source_position,
                layout,
                provenance: StageProvenanceView {
                    uuid: value_origin(payload, &format!("{path}/uuid")),
                    name: value_origin(payload, &format!("{path}/name")),
                    position: position_origin,
                },
            }
        })
        .collect()
}

fn project_controls(controls: &Presence<super::document::ControlSettings>) -> ControlsView {
    // Un objet absent ou `null` ne porte aucun contrôle : ses cinq membres sont
    // rendus absents, jamais `false`.
    let members = controls.value();
    let member = |pick: fn(&super::document::ControlSettings) -> &Presence<bool>| {
        members.map_or(
            PresenceView {
                presence: PresenceKind::Absent,
                value: None,
            },
            |settings| PresenceView::of(pick(settings)),
        )
    };
    ControlsView {
        presence: PresenceKind::of(controls),
        wheel: member(|settings| &settings.wheel),
        ok: member(|settings| &settings.ok),
        home: member(|settings| &settings.home),
        pause: member(|settings| &settings.pause),
        autoplay: member(|settings| &settings.autoplay),
        complete: controls.is_complete(),
    }
}

fn project_transition(
    transition: &Presence<super::document::Transition>,
    index: &NodeIndex<'_>,
    document: &StoryDocument,
) -> TransitionView {
    let Some(transition) = transition.value() else {
        return TransitionView::without_value(PresenceKind::of(transition));
    };
    let action = index.action(&transition.action_node);
    let selection = SelectionView::of(transition.selection);
    let Some((action_position, action_path)) = action else {
        // L'Action manque. La sélection reste montrée telle quelle ; elle ne
        // désigne simplement aucune option existante.
        return TransitionView {
            presence: PresenceKind::Value,
            action_id: Some(transition.action_node.clone()),
            action_path: None,
            selection: Some(selection),
            within_bounds: false,
            selected_option_id: None,
            resolved_stage_path: None,
        };
    };
    let options = &document.action_nodes[action_position].options;
    let within_bounds = match transition.selection {
        // `Random` exige `N ≥ 1`.
        OptionSelection::Random => !options.is_empty(),
        OptionSelection::Fixed(ordinal) => ordinal < options.len(),
    };
    // Une sélection aléatoire ne désigne aucune occurrence : elle en tire une à
    // chaque entrée. Lui attribuer l'option 0 serait exactement le rabattement
    // qui est interdit.
    let selected_ordinal = match transition.selection {
        OptionSelection::Fixed(ordinal) if within_bounds => Some(ordinal),
        _ => None,
    };
    let selected_option_id = selected_ordinal.map(|ordinal| option_id(action_path, ordinal));
    let resolved_stage_path = selected_ordinal
        .and_then(|ordinal| options[ordinal].as_deref())
        .and_then(|uuid| index.stage_path(uuid))
        .map(str::to_string);
    TransitionView {
        presence: PresenceKind::Value,
        action_id: Some(transition.action_node.clone()),
        action_path: Some(action_path.to_string()),
        selection: Some(selection),
        within_bounds,
        selected_option_id,
        resolved_stage_path,
    }
}

/// L'identifiant de **vue** d'une occurrence d'option.
///
/// Il vaut pour une révision de travail et une seule : le dialecte ne donne
/// aucune identité propre à une option, son identité *est* son rang. Un client
/// qui le conserve au-delà doit le résoudre à nouveau après relecture.
fn option_id(action_path: &str, ordinal: usize) -> String {
    format!("{action_path}/options#{ordinal}")
}

fn project_actions(
    payload: &DecodedStoryDocument,
    action_paths: &[String],
    index: &NodeIndex<'_>,
    editor_positions: &EditorPositionIndex<'_>,
    node_colors: &HashMap<&str, &str>,
) -> Vec<ActionView> {
    let document = &payload.document;
    // Même règle que pour les Écrans : rang dans la collection, colonnes sur
    // sa taille. Les deux collections gardent des grilles séparées, et leurs
    // bandes les empêchent de se recouvrir.
    let action_count = document.action_nodes.len();
    document
        .action_nodes
        .iter()
        .zip(action_paths)
        .enumerate()
        .map(|(position, (action, path))| {
            let source_position = action.position.value().map(PositionView::of);
            let position_origin = value_origin(payload, &format!("{path}/position"));
            let layout = resolve_ranked_layout(
                path,
                source_position.as_ref(),
                editor_positions,
                position_origin,
            )
            .unwrap_or_else(|| fallback_layout(position, action_count, NodeBand::Action));
            ActionView {
                path: path.clone(),
                personal_color: node_colors
                    .get(path.as_str())
                    .map(|color| (*color).to_string()),
                id: action.id.clone(),
                occurrence: occurrence_of(path),
                unique_id: index.action_is_unique(&action.id),
                name: PresenceView::of(&action.name),
                // Repli historique d'une Action sans nom : `"Action node"`.
                fallback_label: ACTION_NODE_FALLBACK_NAME.to_string(),
                action_type: PresenceView::of(&action.action_type),
                group_id: PresenceView::of(&action.group_id),
                options: project_options(action, path, index),
                source_position,
                layout,
                provenance: ActionProvenanceView {
                    id: value_origin(payload, &format!("{path}/id")),
                    name: value_origin(payload, &format!("{path}/name")),
                    position: position_origin,
                },
            }
        })
        .collect()
}

fn project_options(
    action: &ActionNode,
    action_path: &str,
    index: &NodeIndex<'_>,
) -> Vec<OptionView> {
    action
        .options
        .iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let stage_path = target
                .as_deref()
                .and_then(|uuid| index.stage_path(uuid))
                .map(str::to_string);
            OptionView {
                option_id: option_id(action_path, ordinal),
                ordinal,
                target: OptionTargetView {
                    // Un élément de tableau n'est jamais absent ; il est `null`
                    // ou porteur d'un identifiant.
                    presence: match target {
                        Some(_) => PresenceKind::Value,
                        None => PresenceKind::Null,
                    },
                    stage_uuid: target.clone(),
                    // Une cible nommée qui ne désigne aucun Écran est pendante,
                    // et le reste visiblement.
                    dangling: target.is_some() && stage_path.is_none(),
                    stage_path,
                },
            }
        })
        .collect()
}

/// Les arêtes, dérivées des nœuds déjà projetés.
///
/// **Aucune déduplication par couple source/cible** : deux occurrences d'option
/// visant le même Écran produisent deux arêtes distinctes, et une boucle reste
/// une boucle. C'est ce que la vue doit rendre visible.
fn project_edges(stages: &[StageView], actions: &[ActionView]) -> Vec<EdgeView> {
    let mut edges = Vec::new();
    for stage in stages {
        for (kind, suffix, transition) in [
            (EdgeKind::StageOk, "ok", &stage.ok_transition),
            (EdgeKind::StageHome, "home", &stage.home_transition),
        ] {
            if transition.presence != PresenceKind::Value {
                continue;
            }
            edges.push(EdgeView {
                edge_id: format!("{}::{suffix}", stage.path),
                kind,
                from: stage.path.clone(),
                to: transition.action_path.clone(),
                option_id: transition.selected_option_id.clone(),
                ordinal: match transition.selection {
                    Some(SelectionView::Fixed { index }) => Some(index),
                    _ => None,
                },
                selection: transition.selection,
                dangling: transition.action_path.is_none(),
            });
        }
    }
    for action in actions {
        for option in &action.options {
            edges.push(EdgeView {
                edge_id: option.option_id.clone(),
                kind: EdgeKind::ActionOption,
                from: action.path.clone(),
                to: option.target.stage_path.clone(),
                option_id: Some(option.option_id.clone()),
                ordinal: Some(option.ordinal),
                selection: None,
                dangling: option.target.dangling,
            });
        }
    }
    edges
}

/// Les références média et leurs usages, par référence et non par écran.
///
/// L'ordre est celui de la première apparition dans le document : une lecture
/// répétée du même payload rend la même liste, ce dont le cache de vue et les
/// comparaisons de test ont besoin.
fn project_media_refs(stages: &[StageView]) -> Vec<MediaRefView> {
    let mut order: Vec<String> = Vec::new();
    let mut usages: HashMap<String, Vec<MediaUsageView>> = HashMap::new();
    for stage in stages {
        for (field, slot) in [
            (MediaField::Audio, &stage.audio),
            (MediaField::Image, &stage.image),
        ] {
            let Some(asset_ref) = slot.asset_ref.as_ref() else {
                continue;
            };
            let entry = usages.entry(asset_ref.clone()).or_insert_with(|| {
                order.push(asset_ref.clone());
                Vec::new()
            });
            entry.push(MediaUsageView {
                node_path: stage.path.clone(),
                field,
            });
        }
    }
    order
        .into_iter()
        .map(|asset_ref| MediaRefView {
            usages: usages.remove(&asset_ref).unwrap_or_default(),
            asset_ref,
        })
        .collect()
}

/// Les groupes enrichis, transportés et montrés, **jamais interprétés**.
///
/// La classification réutilise celle des diagnostics d'authoring plutôt que
/// d'en écrire une seconde : deux règles de reconnaissance divergeraient, et
/// l'UI afficherait alors une forme que le diagnostic ne signale pas.
fn project_groups(
    document: &StoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
) -> Vec<GroupView> {
    collect_groups(document)
        .into_iter()
        .map(|(group_id, members)| GroupView {
            group_id,
            kind: match classify_group(document, &members) {
                KnownGroupKind::Story => GroupKindView::Story,
                KnownGroupKind::Menu => GroupKindView::Menu,
                KnownGroupKind::Unknown => GroupKindView::Unknown,
            },
            stage_paths: members
                .stage_indices
                .iter()
                .map(|&index| stage_paths[index].clone())
                .collect(),
            action_paths: members
                .action_indices
                .iter()
                .map(|&index| action_paths[index].clone())
                .collect(),
        })
        .collect()
}

fn project_opaque_members(
    payload: &DecodedStoryDocument,
    index: &NodeIndex<'_>,
) -> Vec<OpaqueMemberView> {
    payload
        .context
        .opaque_members
        .iter()
        .map(|member| {
            let (value_preview, truncated) = compact_value_bounded(&member.value);
            OpaqueMemberView {
                node_path: index.node_path_of(&member.path),
                path: member.path.clone(),
                scope: member.scope,
                key: member.key.clone(),
                source_occurrence: member.source_occurrence,
                kind: member.kind,
                origin: member.origin,
                value_preview,
                truncated,
                disposition: member.export_disposition,
                // Même critère que `diagnose_opaque_members` : une décision ne
                // vaut que pour la valeur **et** la provenance exactes sur
                // lesquelles elle a été prise.
                disposition_stale: member.export_disposition.is_some()
                    && !(member.export_disposition_value.matches_json(&member.value)
                        && member.export_disposition_origin == Some(member.origin)),
            }
        })
        .collect()
}

/// Les trois familles de diagnostics, rendues **distinctes**.
///
/// GVI, diagnostics d'auteur et diagnostics d'import ne se fondent pas : un
/// `UNTESTED` d'import n'est pas un refus. Chacun reçoit son préfixe de nœud
/// pour que l'UI les groupe sans découper un chemin d'auteur.
fn project_diagnostics(
    payload: &DecodedStoryDocument,
    index: &NodeIndex<'_>,
) -> Vec<DiagnosticView> {
    let mut diagnostics = Vec::new();
    if let Err(errors) = validate_graph_document_integrity(&payload.document) {
        for error in errors {
            diagnostics.push(DiagnosticView {
                family: DiagnosticFamily::GraphIntegrity,
                level: None,
                // Les neuf codes GVI sont bloquants par définition : ils n'ont
                // pas de niveau à choisir.
                severity: Some(super::dialect::DiagnosticSeverity::Error),
                code: error.code.as_str().to_string(),
                node_path: index.node_path_of(&error.path),
                path: error.path,
                message: error.message,
                resolutions: Vec::new(),
            });
        }
    }
    for diagnostic in diagnose_enriched_metadata(payload) {
        diagnostics.push(DiagnosticView {
            family: DiagnosticFamily::Authoring,
            level: Some(diagnostic.level),
            severity: None,
            code: diagnostic.code,
            node_path: index.node_path_of(&diagnostic.path),
            path: diagnostic.path,
            message: diagnostic.message,
            resolutions: diagnostic.resolutions,
        });
    }
    for diagnostic in &payload.context.diagnostics {
        diagnostics.push(DiagnosticView {
            family: DiagnosticFamily::Import,
            level: None,
            severity: Some(diagnostic.severity),
            code: diagnostic.code.clone(),
            node_path: index.node_path_of(&diagnostic.path),
            path: diagnostic.path.clone(),
            message: diagnostic.message.clone(),
            resolutions: Vec::new(),
        });
    }
    diagnostics
}
