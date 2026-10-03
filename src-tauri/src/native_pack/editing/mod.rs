//! Les gestes d'auteur du MVP de l'Éditeur avancé.
//!
//! Ce module regroupe les familles de gestes que le MVP exige : contrôles,
//! transitions, options, médias partagés et locaux, créations, retraits,
//! entrée, positions et décisions d'export. Aucune interface n'est livrée ici :
//! ce sont des commandes, éprouvées comme telles.
//!
//! **Aucune cascade implicite.** Un geste qui priverait une référence de sa
//! destination refuse et **inventorie** ce qui bloque, ou applique le plan
//! explicite que l'auteur a formulé — jamais les deux à moitié. C'est la règle
//! commune aux options, aux contrôles et aux marqueurs enrichis : l'intégrité
//! runtime et les choix d'auteur sont deux propriétés distinctes, et la seconde ne se
//! devine pas pour sauver la première.
//!
//! **Une seule forme de sortie.** Chaque geste décode le payload courant, mute
//! le `DecodedStoryDocument`, puis réencode document **et** contexte par le
//! codec. Rien n'est recalculé depuis l'arbre hiérarchique, le ZIP source ou
//! `source_value` — qui vaut `Null` sur un payload relu et ne peut donc pas
//! servir d'état de travail. L'identité de pack acquise reste intacte, sauf si
//! l'auteur demande explicitement un nouvel UUID.
//!
//! **La readiness n'est pas ici.** Elle reste recalculée à la demande sur le
//! payload courant (`assess_advanced_payload_readiness`) et n'est jamais
//! persistée : un geste la change donc sans qu'aucun `SUPPORTED` ancien puisse
//! survivre. Le geste ne la consulte pas davantage : un document non
//! exportable reste éditable et enregistrable.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) mod anchors;
pub(crate) mod constructions;
pub(crate) mod controls;
pub(crate) mod dispositions;
pub(crate) mod media;
pub(crate) mod metadata;
pub(crate) mod node_presentation;
pub(crate) mod options;
pub(crate) mod paste;
pub(crate) mod positions;
pub(crate) mod removal;
pub(crate) mod structure;
pub(crate) mod transitions;

#[cfg(test)]
mod tests;

use anchors::{orphan_anchors, AnchorReport};
use constructions::{
    create_construction, create_linked_node, ConstructionReport, CreateConstructionRequest,
    CreateLinkedNodeRequest,
};
use controls::{activate_slot_control, set_stage_controls, set_stages_controls, ControlsUpdate};
use dispositions::{
    flatten_group, set_opaque_disposition, set_position_disposition, OpaqueMemberRef,
};
use media::{
    observe_media, repoint_media, set_stage_media, validate_media_bindings, AssetLocationInput,
    MediaBindingReport, MediaField, StageMediaUpdate,
};
use metadata::{set_document_metadata, DocumentMetadataUpdate};
use node_presentation::{set_node_color, set_node_name};
use options::{
    insert_option, remove_option, reorder_options, set_option_target, ActionOptionTarget,
    DecisionBook, ReferenceReport, SelectionDecision,
};
use paste::{paste_subgraph, PasteSubgraphRequest};
use positions::{
    apply_layout_to_authoring, apply_view_layout, place_authored, set_position, set_positions,
    LayoutEntry, NodeKind, NodeRef, OutOfRangePolicy, PositionInput, PositionReport,
};
use removal::{
    delete_subgraph, mark_transitions_severed_by_removal, prune_severed_transitions,
    DeleteSubgraphRequest,
};
use structure::{
    create_action, create_stage, delete_action, delete_stage, set_square_one, ActionRemovalPlan,
    CreateActionRequest, CreateStageRequest, CreatedNodes, StageRemovalPlan,
};
use transitions::{
    connect_stage_to_empty_action, set_stage_transition, TransitionSlot, TransitionUpdate,
};

use crate::native_pack::persistence::{
    decode_authoring_payload, encode_authoring_payload, system_pack_identity, AdvancedMediaBinding,
    PersistenceError,
};
use crate::native_pack::{
    DecodedStoryDocument, OpaqueExportDisposition, PositionExportDisposition,
};

/// Refus typé d'un geste : un code stable, le chemin d'auteur visé, une phrase.
///
/// Le code est ce que l'interface branchera ; le chemin est celui du document,
/// pas un index de tableau, pour qu'un message reste vrai après réordonnancement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GestureError {
    pub(crate) code: &'static str,
    pub(crate) path: String,
    pub(crate) message: String,
    /// L'inventaire des références qui motivent le refus, en chemins d'auteur.
    ///
    /// Un refus de suppression nomme ce qui désigne encore la cible : l'interface
    /// construit son plan à partir de cette liste au lieu de découper la phrase
    /// française du message, et l'inventaire des références entrantes
    /// est tenu par la commande elle-même.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) references: Vec<String>,
}

impl GestureError {
    pub(crate) fn new(code: &'static str, path: &str, message: String) -> Self {
        Self {
            code,
            path: path.to_string(),
            message,
            references: Vec::new(),
        }
    }

    pub(crate) fn with_references(mut self, references: Vec<String>) -> Self {
        self.references = references;
        self
    }
}

impl std::fmt::Display for GestureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} à {} : {}",
            self.code, self.path, self.message
        )
    }
}

impl std::error::Error for GestureError {}

/// Un refus du codec reste un refus du codec : son code n'est pas réécrit en
/// code de geste, sans quoi l'appelant perdrait la cause réelle.
impl From<PersistenceError> for GestureError {
    fn from(error: PersistenceError) -> Self {
        Self {
            code: error.code,
            path: error.path.clone(),
            message: error.to_string(),
            references: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "gesture", rename_all = "kebab-case")]
pub(crate) enum AdvancedGesture {
    // --- Contrôles -------------------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetStageControls {
        stage_uuid: String,
        update: ControlsUpdate,
    },
    /// Le même réglage sur plusieurs Écrans sélectionnés : une transaction.
    #[serde(rename_all = "camelCase")]
    SetStagesControls {
        stage_uuids: Vec<String>,
        update: ControlsUpdate,
    },
    // --- Transitions -----------------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetStageTransition {
        stage_uuid: String,
        slot: TransitionSlot,
        update: TransitionUpdate,
        /// Allume la touche qu'exige `slot` (OK ou HOME) avec le raccord.
        #[serde(default)]
        activate_control: bool,
    },
    /// Raccorde un Écran à une Action vide en réservant atomiquement sa
    /// première option. La cible de cette option reste nulle jusqu'à ce que
    /// l'auteur crée ou choisisse l'Écran suivant.
    #[serde(rename_all = "camelCase")]
    ConnectStageToEmptyAction {
        stage_uuid: String,
        slot: TransitionSlot,
        action_node: String,
        /// Allume la touche qu'exige `slot` (OK ou HOME) avec le raccord.
        #[serde(default)]
        activate_control: bool,
    },
    // --- Options ---------------------------------------------------------
    #[serde(rename_all = "camelCase")]
    InsertActionOption {
        action_id: String,
        index: usize,
        target: ActionOptionTarget,
    },
    #[serde(rename_all = "camelCase")]
    SetActionOptionTarget {
        action_id: String,
        ordinal: usize,
        target: ActionOptionTarget,
    },
    #[serde(rename_all = "camelCase")]
    ReorderActionOptions {
        action_id: String,
        /// La permutation des rangs courants : `newPositionOfOld[i]` est la
        /// place de l'occurrence qui occupait `i`. Une liste de cibles
        /// fusionnerait deux occurrences de même destination.
        new_position_of_old: Vec<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RemoveActionOption {
        action_id: String,
        ordinal: usize,
        #[serde(default)]
        selections: Vec<SelectionDecision>,
    },
    // --- Médias ----------------------------------------------------------
    #[serde(rename_all = "camelCase")]
    RepointMedia {
        asset_ref: String,
        location: AssetLocationInput,
    },
    #[serde(rename_all = "camelCase")]
    SetStageMedia {
        stage_uuid: String,
        field: MediaField,
        update: StageMediaUpdate,
    },
    // --- Créations et retraits -------------------------------------------
    /// La position est un champ **frère** de la création, jamais un membre de
    /// la requête : c'est la convention que `create-linked-node` a posée, et
    /// elle tient à ce que placer un nœud est un geste de vue
    /// là où le créer est un geste de document. Les deux partent ensemble
    /// pour ne faire qu'un seul pas d'annulation.
    ///
    /// Absente, le nœud naît où la disposition le met. C'est le cas de la
    /// barre d'outils, qui ne désigne aucun point.
    #[serde(rename_all = "camelCase")]
    CreateStage {
        stage: CreateStageRequest,
        #[serde(default)]
        position: Option<PositionInput>,
    },
    #[serde(rename_all = "camelCase")]
    CreateAction {
        action: CreateActionRequest,
        #[serde(default)]
        position: Option<PositionInput>,
    },
    #[serde(rename_all = "camelCase")]
    CreateConstruction {
        construction: CreateConstructionRequest,
    },
    #[serde(rename_all = "camelCase")]
    CreateLinkedNode { linked: CreateLinkedNodeRequest },
    /// Collage d'un sous-graphe : N Écrans, M Actions et leurs raccords
    /// internes en **une** transaction, donc en un seul pas d'annulation. Le
    /// collage est clos sur lui-même : ses options et ses transitions ne
    /// désignent que ses propres nœuds, par leur rang.
    #[serde(rename_all = "camelCase")]
    PasteSubgraph { subgraph: PasteSubgraphRequest },
    #[serde(rename_all = "camelCase")]
    DeleteStage {
        stage_uuid: String,
        #[serde(default)]
        plan: Option<StageRemovalPlan>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteAction {
        action_id: String,
        #[serde(default)]
        plan: Option<ActionRemovalPlan>,
    },
    /// Retrait d'un lot de nœuds en **une** transaction, donc en un seul pas
    /// d'annulation. Le plan porte sur les seules références qui **survivent**
    /// au retrait : celles venues d'un nœud que le geste retire aussi
    /// disparaissent avec lui et n'ont rien à décider.
    #[serde(rename_all = "camelCase")]
    DeleteSubgraph { subgraph: DeleteSubgraphRequest },
    // --- Métadonnées de tête ---------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetDocumentMetadata { update: DocumentMetadataUpdate },
    // --- Nom et présentation ---------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetNodeName {
        node: NodeRef,
        update: metadata::TextUpdate,
    },
    #[serde(rename_all = "camelCase")]
    SetNodeColor {
        paths: Vec<String>,
        color: Option<String>,
    },
    // --- Entrée ----------------------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetSquareOne { stage_uuid: String },
    // --- Positions -------------------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetAuthoredPosition {
        node: NodeRef,
        position: PositionInput,
    },
    /// Un glisser de plusieurs nœuds sélectionnés : une seule transaction.
    #[serde(rename_all = "camelCase")]
    SetAuthoredPositions { positions: Vec<LayoutEntry> },
    #[serde(rename_all = "camelCase")]
    ApplyViewLayout { positions: Vec<LayoutEntry> },
    #[serde(rename_all = "camelCase")]
    ApplyLayoutToAuthoring {
        /// Vide, la promotion porte sur toutes les positions d'éditeur.
        #[serde(default)]
        nodes: Vec<NodeRef>,
        out_of_range: OutOfRangePolicy,
    },
    // --- Décisions d'export ----------------------------------------------
    #[serde(rename_all = "camelCase")]
    SetPositionExportDisposition {
        node: NodeRef,
        disposition: PositionExportDisposition,
    },
    #[serde(rename_all = "camelCase")]
    SetOpaqueExportDisposition {
        member: OpaqueMemberRef,
        disposition: OpaqueExportDisposition,
    },
    #[serde(rename_all = "camelCase")]
    FlattenKnownGroup { group_id: String },
}

impl AdvancedGesture {
    fn name(&self) -> &'static str {
        match self {
            AdvancedGesture::SetStageControls { .. } => "set-stage-controls",
            AdvancedGesture::SetStagesControls { .. } => "set-stages-controls",
            AdvancedGesture::SetStageTransition { .. } => "set-stage-transition",
            AdvancedGesture::ConnectStageToEmptyAction { .. } => "connect-stage-to-empty-action",
            AdvancedGesture::InsertActionOption { .. } => "insert-action-option",
            AdvancedGesture::SetActionOptionTarget { .. } => "set-action-option-target",
            AdvancedGesture::ReorderActionOptions { .. } => "reorder-action-options",
            AdvancedGesture::RemoveActionOption { .. } => "remove-action-option",
            AdvancedGesture::RepointMedia { .. } => "repoint-media",
            AdvancedGesture::SetStageMedia { .. } => "set-stage-media",
            AdvancedGesture::CreateStage { .. } => "create-stage",
            AdvancedGesture::CreateAction { .. } => "create-action",
            AdvancedGesture::CreateConstruction { .. } => "create-construction",
            AdvancedGesture::CreateLinkedNode { .. } => "create-linked-node",
            AdvancedGesture::PasteSubgraph { .. } => "paste-subgraph",
            AdvancedGesture::DeleteStage { .. } => "delete-stage",
            AdvancedGesture::DeleteAction { .. } => "delete-action",
            AdvancedGesture::DeleteSubgraph { .. } => "delete-subgraph",
            AdvancedGesture::SetDocumentMetadata { .. } => "set-document-metadata",
            AdvancedGesture::SetNodeName { .. } => "set-node-name",
            AdvancedGesture::SetNodeColor { .. } => "set-node-color",
            AdvancedGesture::SetSquareOne { .. } => "set-square-one",
            AdvancedGesture::SetAuthoredPosition { .. } => "set-authored-position",
            AdvancedGesture::SetAuthoredPositions { .. } => "set-authored-positions",
            AdvancedGesture::ApplyViewLayout { .. } => "apply-view-layout",
            AdvancedGesture::ApplyLayoutToAuthoring { .. } => "apply-layout-to-authoring",
            AdvancedGesture::SetPositionExportDisposition { .. } => {
                "set-position-export-disposition"
            }
            AdvancedGesture::SetOpaqueExportDisposition { .. } => "set-opaque-export-disposition",
            AdvancedGesture::FlattenKnownGroup { .. } => "flatten-known-group",
        }
    }
}

/// Ce que le geste a fait, au-delà du payload : les seules choses que lui seul
/// sait. Diagnostics, intégrité et readiness restent observables ailleurs, sur
/// le payload rendu, et ne sont pas recopiés ici.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GestureReport {
    pub(crate) gesture: &'static str,
    pub(crate) created: Option<CreatedNodes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) construction: Option<ConstructionReport>,
    pub(crate) anchors: AnchorReport,
    pub(crate) media: MediaBindingReport,
    /// Les effets du geste sur les références entrantes de sa cible :
    /// sélections maintenues ou tranchées, occurrences d'options déplacées,
    /// retirées ou retargetées, et changement d'entrée.
    pub(crate) references: ReferenceReport,
    /// Les effets du geste sur les positions et leurs décisions d'export.
    pub(crate) positions: PositionReport,
}

/// Payload et liaisons sortent **ensemble** : ils dérivent du même document
/// muté, et rendre le payload seul obligerait l'appelant à l'ouvrir en
/// JavaScript pour retrouver ses références — ce qu'il faut éviter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvancedGestureOutcome {
    pub(crate) payload: String,
    pub(crate) media_bindings: Vec<AdvancedMediaBinding>,
    pub(crate) report: GestureReport,
}

/// Pose le nœud qui vient de naître, quand l'auteur a désigné un point.
///
/// Le point devient sa position d'auteur (`place_authored`) : c'est la seule
/// position d'un nœud, celle du graphe à plat. Sans point, rien n'est écrit :
/// la disposition placera le nœud.
fn place_created_node(
    decoded: &mut DecodedStoryDocument,
    kind: NodeKind,
    id: &str,
    position: Option<&PositionInput>,
    report: &mut PositionReport,
) -> Result<(), GestureError> {
    let Some(position) = position else {
        return Ok(());
    };
    place_authored(
        decoded,
        &[LayoutEntry {
            node: NodeRef {
                kind,
                id: id.to_owned(),
            },
            position: position.clone(),
        }],
        report,
    )
}

pub(crate) fn apply_advanced_gesture(
    payload: &str,
    media_bindings: Vec<AdvancedMediaBinding>,
    gesture: &AdvancedGesture,
) -> Result<AdvancedGestureOutcome, GestureError> {
    apply_advanced_gesture_with(payload, media_bindings, gesture, &mut system_pack_identity)
}

/// Le geste, avec sa source d'identifiants injectée.
///
/// Chaque Stage créé reçoit un UUID canonique unique ; le tirage vient
/// du CSPRNG du système en production et d'une suite fixée en test, exactement
/// comme l'acquisition d'identité du pack.
pub(crate) fn apply_advanced_gesture_with(
    payload: &str,
    mut bindings: Vec<AdvancedMediaBinding>,
    gesture: &AdvancedGesture,
    next: &mut dyn FnMut() -> Uuid,
) -> Result<AdvancedGestureOutcome, GestureError> {
    validate_media_bindings(&bindings)?;
    let mut decoded = decode_authoring_payload(payload)?;
    let is_removal = matches!(
        gesture,
        AdvancedGesture::RemoveActionOption { .. }
            | AdvancedGesture::DeleteStage { .. }
            | AdvancedGesture::DeleteAction { .. }
            | AdvancedGesture::DeleteSubgraph { .. }
    );
    let previously_linked = if is_removal {
        decoded
            .document
            .stage_nodes
            .iter()
            .flat_map(|stage| {
                TransitionSlot::all()
                    .into_iter()
                    .filter_map(|slot| slot.read(stage).value().map(|_| (stage.uuid.clone(), slot)))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    // Relevé d'entrée : un ancrage déjà détaché avant ce geste n'est
    // pas imputable au geste, et ne doit pas faire refuser un projet légitime.
    let inherited = orphan_anchors(&decoded);
    let mut report = GestureReport {
        gesture: gesture.name(),
        created: None,
        construction: None,
        anchors: AnchorReport::default(),
        media: MediaBindingReport::default(),
        references: ReferenceReport::default(),
        positions: PositionReport::default(),
    };

    match gesture {
        AdvancedGesture::SetStageControls { stage_uuid, update } => {
            set_stage_controls(&mut decoded.document, stage_uuid, update)?
        }
        AdvancedGesture::SetStagesControls {
            stage_uuids,
            update,
        } => set_stages_controls(&mut decoded.document, stage_uuids, update)?,
        AdvancedGesture::SetStageTransition {
            stage_uuid,
            slot,
            update,
            activate_control,
        } => {
            if *activate_control {
                activate_slot_control(&mut decoded.document, stage_uuid, *slot)?;
            }
            set_stage_transition(&mut decoded.document, stage_uuid, *slot, update)?;
        }
        AdvancedGesture::ConnectStageToEmptyAction {
            stage_uuid,
            slot,
            action_node,
            activate_control,
        } => {
            if *activate_control {
                activate_slot_control(&mut decoded.document, stage_uuid, *slot)?;
            }
            connect_stage_to_empty_action(
                &mut decoded.document,
                stage_uuid,
                *slot,
                action_node,
                &mut report.references,
            )?;
        }
        AdvancedGesture::InsertActionOption {
            action_id,
            index,
            target,
        } => insert_option(
            &mut decoded.document,
            action_id,
            *index,
            target,
            &mut report.references,
        )?,
        AdvancedGesture::SetActionOptionTarget {
            action_id,
            ordinal,
            target,
        } => set_option_target(
            &mut decoded.document,
            action_id,
            *ordinal,
            target,
            &mut report.references,
        )?,
        AdvancedGesture::ReorderActionOptions {
            action_id,
            new_position_of_old,
        } => reorder_options(
            &mut decoded.document,
            action_id,
            new_position_of_old,
            &mut report.references,
        )?,
        AdvancedGesture::RemoveActionOption {
            action_id,
            ordinal,
            selections,
        } => {
            let mut decisions = DecisionBook::new(selections);
            remove_option(
                &mut decoded.document,
                action_id,
                *ordinal,
                &mut decisions,
                &mut report.references,
            )?;
            decisions.unused()?;
        }
        AdvancedGesture::RepointMedia {
            asset_ref,
            location,
        } => repoint_media(
            &decoded.document,
            &mut bindings,
            asset_ref,
            location,
            &mut report.media,
        )?,
        AdvancedGesture::SetStageMedia {
            stage_uuid,
            field,
            update,
        } => set_stage_media(
            &mut decoded.document,
            &mut bindings,
            stage_uuid,
            *field,
            update,
            &mut report.media,
        )?,
        AdvancedGesture::CreateStage { stage, position } => {
            let created =
                create_stage(&mut decoded, &mut bindings, stage, next, &mut report.media)?;
            // Seul le nœud **demandé** est placé. Une Action née du même geste
            // — `stage.action` — n'a pas reçu de point de l'auteur, et lui
            // donner celui du Stage les ferait naître l'une sur l'autre.
            place_created_node(
                &mut decoded,
                NodeKind::Stage,
                &created.stage_uuid,
                position.as_ref(),
                &mut report.positions,
            )?;
            report.created = Some(created);
        }
        AdvancedGesture::CreateAction { action, position } => {
            let created = create_action(&mut decoded, action, next)?;
            if let Some(action_id) = created.action_id.as_deref() {
                place_created_node(
                    &mut decoded,
                    NodeKind::Action,
                    action_id,
                    position.as_ref(),
                    &mut report.positions,
                )?;
            }
            report.created = Some(created);
        }
        AdvancedGesture::CreateConstruction { construction } => {
            let (created, details) = create_construction(
                &mut decoded,
                &mut bindings,
                construction,
                next,
                &mut report.media,
            )?;
            report.created = Some(created);
            report.construction = Some(details);
        }
        AdvancedGesture::CreateLinkedNode { linked } => {
            let (created, details) = create_linked_node(
                &mut decoded,
                &mut bindings,
                linked,
                next,
                &mut report.media,
                &mut report.references,
                &mut report.positions,
            )?;
            report.created = Some(created);
            report.construction = Some(details);
        }
        AdvancedGesture::PasteSubgraph { subgraph } => {
            let (created, details) = paste_subgraph(
                &mut decoded,
                &mut bindings,
                subgraph,
                next,
                &mut report.media,
                &mut report.positions,
            )?;
            report.created = Some(created);
            report.construction = Some(details);
        }
        AdvancedGesture::DeleteStage { stage_uuid, plan } => delete_stage(
            &mut decoded,
            stage_uuid,
            plan.as_ref(),
            &mut report.anchors,
            &mut report.references,
        )?,
        AdvancedGesture::DeleteAction { action_id, plan } => delete_action(
            &mut decoded,
            action_id,
            plan.as_ref(),
            &mut report.anchors,
            &mut report.references,
        )?,
        AdvancedGesture::DeleteSubgraph { subgraph } => delete_subgraph(
            &mut decoded,
            subgraph,
            &mut report.anchors,
            &mut report.references,
        )?,
        AdvancedGesture::SetDocumentMetadata { update } => {
            set_document_metadata(&mut decoded, update)?
        }
        AdvancedGesture::SetNodeName { node, update } => {
            set_node_name(&mut decoded.document, node, update)?
        }
        AdvancedGesture::SetNodeColor { paths, color } => {
            set_node_color(&mut decoded, paths, color.as_deref())?
        }
        AdvancedGesture::SetSquareOne { stage_uuid } => {
            set_square_one(&mut decoded.document, stage_uuid, &mut report.references)?
        }
        AdvancedGesture::SetAuthoredPosition { node, position } => {
            set_position(&mut decoded, node, position, &mut report.positions)?
        }
        AdvancedGesture::SetAuthoredPositions { positions } => {
            set_positions(&mut decoded, positions, &mut report.positions)?
        }
        AdvancedGesture::ApplyViewLayout { positions } => {
            apply_view_layout(&mut decoded, positions, &mut report.positions)?
        }
        AdvancedGesture::ApplyLayoutToAuthoring {
            nodes,
            out_of_range,
        } => apply_layout_to_authoring(&mut decoded, nodes, *out_of_range, &mut report.positions)?,
        AdvancedGesture::SetPositionExportDisposition { node, disposition } => {
            set_position_disposition(&mut decoded, node, *disposition)?
        }
        AdvancedGesture::SetOpaqueExportDisposition {
            member,
            disposition,
        } => set_opaque_disposition(&mut decoded, member, *disposition)?,
        AdvancedGesture::FlattenKnownGroup { group_id } => flatten_group(&mut decoded, group_id)?,
    }

    if is_removal {
        mark_transitions_severed_by_removal(&mut decoded, &previously_linked);
    }

    // Une marque de rupture que le document ne justifie plus s'efface, quel que
    // soit le geste qui vient de la rendre caduque — un raccord à la souris, un
    // réglage de l'inspecteur, un undo. Central, donc aucun chemin d'écriture
    // n'a à y penser.
    prune_severed_transitions(&mut decoded);

    // « Aucun ancrage résiduel ne doit atteindre le writer » : le geste échoue
    // s'il en **introduit** un, et laisse voir ceux dont il a hérité.
    let remaining = orphan_anchors(&decoded);
    if let Some(introduced) = remaining
        .iter()
        .find(|path| !inherited.iter().any(|known| known == *path))
    {
        return Err(GestureError::new(
            "ORPHAN_CONTEXT_ANCHOR",
            introduced,
            "Le geste détacherait un ancrage de contexte : il est refusé plutôt qu'appliqué."
                .to_string(),
        ));
    }
    report.anchors.preexisting_orphans = remaining;

    validate_media_bindings(&bindings)?;
    observe_media(&decoded.document, &bindings, &mut report.media);

    Ok(AdvancedGestureOutcome {
        payload: encode_authoring_payload(&decoded)?,
        media_bindings: bindings,
        report,
    })
}
