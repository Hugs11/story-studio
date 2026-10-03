//! Préparation et sérialisation standard d'une copie d'export.
//!
//! Cette couche est volontairement distincte du normaliseur historique du
//! writer Libre. Elle valide le document d'auteur et ses décisions, clone le
//! graphe, puis n'applique que les transformations fermées prévues.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use super::assets::advanced::naming::ArchiveNameTable;
use super::authoring::{opaque_member_never_emitted, AuthoringDiagnostic};
use super::dialect::PackIdentity;
use super::readiness::{assess_graph_document_export_readiness, ExportReadiness};
use super::{
    classify_stage_id, stable_node_paths, DecodedStoryDocument, DocumentOrigin,
    GraphIntegrityError, OpaqueExportDisposition, OpaqueMember, Position,
    PositionExportDisposition, Presence, StoryDocument, ValueOrigin,
};

const SHORT_MIN: f64 = -32_768.0;
const SHORT_MAX: f64 = 32_767.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedGraphDocument {
    pub(crate) document: StoryDocument,
    pub(crate) stage_id_map: BTreeMap<String, String>,
    standard_value: Value,
}

impl PreparedGraphDocument {
    pub(crate) fn standard_value(&self) -> &Value {
        &self.standard_value
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum ExportPreparationError {
    GraphIntegrity {
        errors: Vec<GraphIntegrityError>,
    },
    AuthoringActionRequired {
        diagnostics: Vec<AuthoringDiagnostic>,
    },
    PackIdentity {
        message: String,
    },
    /// Readiness bloquée pour une raison qui n'est ni l'intégrité du graphe ni
    /// une décision d'auteur : un diagnostic de décodage d'un payload relu. Le
    /// cas n'existe pas dans une chaîne d'import saine, mais la conversion
    /// depuis la readiness doit rester totale plutôt que de choisir un refus par
    /// défaut.
    ReadinessBlocked {
        diagnostics: Vec<String>,
    },
    StandardSerialization {
        message: String,
    },
}

impl std::fmt::Display for ExportPreparationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GraphIntegrity { errors } => write!(
                formatter,
                "Intégrité du graphe invalide avant préparation ({} erreur(s)).",
                errors.len()
            ),
            Self::AuthoringActionRequired { diagnostics } => write!(
                formatter,
                "Décision d'auteur requise avant préparation ({} diagnostic(s)).",
                diagnostics.len()
            ),
            Self::ReadinessBlocked { diagnostics } => write!(
                formatter,
                "Readiness d'export bloquée avant préparation ({} diagnostic(s)).",
                diagnostics.len()
            ),
            Self::PackIdentity { message } | Self::StandardSerialization { message } => {
                formatter.write_str(message)
            }
        }
    }
}

/// Le prédicat d'identité **partagé** par la porte d'export et la préparation.
///
/// Les deux doivent refuser exactement les mêmes entrées : la
/// valeur est présente, **non vide au sens strict** — sans `trim`, qui
/// accepterait `" uuid "` que la préparation refuse — puis bridge-compatible sur
/// la **chaîne originale**. L'export s'en sert à l'étape 3, avant tout effet sur
/// les assets ; la préparation continue de le vérifier pour son propre compte à
/// l'étape 9. Aucune valeur n'est générée ici : l'acquisition du projet est le
/// seul lieu de génération, et l'export refuse une acquisition incomplète au lieu de
/// la réparer.
pub(crate) fn pack_identity_for_export(
    identity: &PackIdentity,
) -> Result<&str, ExportPreparationError> {
    let value = identity
        .value
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ExportPreparationError::PackIdentity {
            message: identity.unresolved_reason.clone().unwrap_or_else(|| {
                "La packIdentity stable doit être générée et persistée avant préparation."
                    .to_string()
            }),
        })?;
    if !classify_stage_id(value).bridge_compatible {
        return Err(ExportPreparationError::PackIdentity {
            message: "La packIdentity stable n'est pas bridge-compatible.".to_string(),
        });
    }
    Ok(value)
}

/// Prépare exclusivement une copie du payload d'auteur.
pub(crate) fn prepare_graph_document_for_export(
    payload: &DecodedStoryDocument,
) -> Result<PreparedGraphDocument, ExportPreparationError> {
    prepare_export_copy(payload, None, None, None)
}

/// Même préparation, **portant la table `assetRef → nom d'archive`**.
///
/// C'est l'entrée du writer de production : la substitution des médias a lieu
/// sur la copie, **avant que `standard_value` soit figé**, parce que muter
/// `prepared.document` après coup laisserait les trois origines — document,
/// valeur standard et membres opaques — sérialiser encore les anciens noms.
///
/// Elle partage l'implémentation de `prepare_graph_document_for_export` plutôt
/// que de la dupliquer : mêmes refus, même readiness recalculée, même table
/// d'identifiants, même déterminisme, et aucun accès disque. Le document
/// d'auteur n'est pas muté — `assetRef` reste la chaîne du dialecte dans le
/// projet, le `.mbah` et le payload.
///
/// `story_title` est le titre livré que l'appelant a composé — le nom de
/// convention avec l'âge, comme la chaîne Libre l'écrit dans `story.json`. Il
/// ne remplace le titre que dans la copie : le document d'auteur garde son
/// titre lisible. Vide ou absent, la copie garde le titre du document.
pub(crate) fn prepare_graph_document_for_export_with_asset_names(
    payload: &DecodedStoryDocument,
    asset_names: &ArchiveNameTable,
    story_title: Option<&str>,
    project_name: Option<&str>,
) -> Result<PreparedGraphDocument, ExportPreparationError> {
    prepare_export_copy(payload, Some(asset_names), story_title, project_name)
}

fn prepare_export_copy(
    payload: &DecodedStoryDocument,
    asset_names: Option<&ArchiveNameTable>,
    story_title: Option<&str>,
    project_name: Option<&str>,
) -> Result<PreparedGraphDocument, ExportPreparationError> {
    // Préparer refuse si la readiness est bloquée. Elle est recalculée à chaque
    // appel — jamais reprise d'un résultat antérieur, qu'une édition du document
    // ou d'une disposition aurait pu périmer. La readiness observe sans
    // préparer, et la préparation ne la rappelle pas : le raccord est à sens
    // unique et ne peut pas boucler.
    let readiness = assess_graph_document_export_readiness(Ok(payload));
    if readiness.blocked {
        return Err(refusal_from_readiness(&readiness));
    }

    let pack_identity = pack_identity_for_export(&payload.context.pack_identity)?;

    let author_stage_paths = stable_node_paths(
        &payload.document.stage_nodes,
        "stageNodes",
        "uuid",
        |stage| stage.uuid.as_str(),
    );
    let author_action_paths = stable_node_paths(
        &payload.document.action_nodes,
        "actionNodes",
        "id",
        |action| action.id.as_str(),
    );

    let mut document = payload.document.clone();
    omit_projected_metadata(
        payload,
        &author_stage_paths,
        &author_action_paths,
        &mut document,
    );
    // Un titre déduit du format FS reste absent du document d'auteur. Seule
    // la copie livrée reçoit un titre lisible pour les catalogues tiers.
    // Un titre réel, importé ou saisi, garde sa graphie exacte.
    if let Some(project_name) = project_name {
        if document
            .title
            .value()
            .is_none_or(|title| title.trim().is_empty())
        {
            let title = project_name.trim();
            document.title = Presence::Value(
                if title.is_empty() {
                    "Sans titre"
                } else {
                    title
                }
                .to_string(),
            );
        }
    }
    if let Some(story_title) = story_title.map(str::trim).filter(|title| !title.is_empty()) {
        document.title = Presence::Value(story_title.to_string());
    }
    apply_position_decisions(
        payload,
        &author_stage_paths,
        &author_action_paths,
        &mut document,
    )?;
    fit_positions_to_short_range(&mut document);

    let entry_index = document
        .stage_nodes
        .iter()
        .position(|stage| stage.is_square_one())
        .expect("l'intégrité garantit un squareOne unique");
    let stage_id_map = build_stage_id_map(&document, entry_index, pack_identity);
    for stage in &mut document.stage_nodes {
        stage.uuid = stage_id_map
            .get(&stage.uuid)
            .expect("chaque Stage possède une entrée de remap")
            .clone();
    }
    for action in &mut document.action_nodes {
        for target in action.options.iter_mut().flatten() {
            *target = stage_id_map
                .get(target)
                .expect("l'intégrité garantit une cible Stage existante")
                .clone();
        }
    }

    let entry = document.stage_nodes.remove(entry_index);
    document.stage_nodes.insert(0, entry);
    document.stage_nodes[0].square_one = Presence::Value(true);

    if let Some(asset_names) = asset_names {
        substitute_archive_names(&mut document, asset_names)?;
    }

    apply_required_standard_shape(
        &mut document,
        payload.context.document_origin,
        pack_identity,
    )?;
    let standard_value = standard_value_with_opaque_members(
        &document,
        payload,
        &author_stage_paths,
        &author_action_paths,
        entry_index,
    )?;

    Ok(PreparedGraphDocument {
        document,
        stage_id_map,
        standard_value,
    })
}

/// Traduit un blocage de readiness dans le vocabulaire de refus de la
/// préparation, sans réexécuter le moindre prédicat : les erreurs d'intégrité et les
/// décisions d'auteur sont reprises telles quelles depuis l'agrégat.
///
/// La porte de refus précoce de l'export (étape 2) la partage : deux portes qui
/// doivent refuser les mêmes entrées ne peuvent pas traduire leur blocage de
/// deux façons.
pub(crate) fn refusal_from_readiness(readiness: &ExportReadiness) -> ExportPreparationError {
    let errors = readiness.integrity_errors().cloned().collect::<Vec<_>>();
    if !errors.is_empty() {
        return ExportPreparationError::GraphIntegrity { errors };
    }
    let diagnostics = readiness
        .blocking_authoring_diagnostics()
        .cloned()
        .collect::<Vec<_>>();
    if !diagnostics.is_empty() {
        return ExportPreparationError::AuthoringActionRequired { diagnostics };
    }
    ExportPreparationError::ReadinessBlocked {
        diagnostics: readiness
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.blocks())
            .map(|diagnostic| format!("{} {}", diagnostic.code(), diagnostic.path()))
            .collect(),
    }
}

pub(crate) fn serialize_prepared_graph_document(
    prepared: &PreparedGraphDocument,
) -> Result<String, ExportPreparationError> {
    serde_json::to_string_pretty(prepared.standard_value()).map_err(|error| {
        ExportPreparationError::StandardSerialization {
            message: format!("Impossible de sérialiser la copie préparée : {error}"),
        }
    })
}

fn build_stage_id_map(
    document: &StoryDocument,
    entry_index: usize,
    pack_identity: &str,
) -> BTreeMap<String, String> {
    let mut table = BTreeMap::new();
    // Réserver d'abord tous les IDs dont la conservation est imposée : un
    // remap synthétique ne doit pas prendre l'identité d'un Stage à venir.
    let preserved: HashSet<String> = document
        .stage_nodes
        .iter()
        .enumerate()
        .filter(|(index, stage)| {
            *index != entry_index
                && stage.uuid != pack_identity
                && classify_stage_id(&stage.uuid).bridge_compatible
        })
        .map(|(_, stage)| stage.uuid.clone())
        .collect();
    let mut used = preserved.clone();
    used.insert(pack_identity.to_string());
    table.insert(
        document.stage_nodes[entry_index].uuid.clone(),
        pack_identity.to_string(),
    );

    for (index, stage) in document.stage_nodes.iter().enumerate() {
        if index == entry_index {
            continue;
        }
        let keep = preserved.contains(&stage.uuid);
        let export_id = if keep {
            stage.uuid.clone()
        } else {
            deterministic_stage_uuid(pack_identity, &stage.uuid, &used)
        };
        used.insert(export_id.clone());
        table.insert(stage.uuid.clone(), export_id);
    }
    table
}

pub(crate) fn deterministic_stage_uuid(
    pack_identity: &str,
    author_stage_id: &str,
    used: &HashSet<String>,
) -> String {
    for attempt in 0_u32.. {
        let mut hasher = Sha256::new();
        hash_component(&mut hasher, b"story-studio/d1-prep/stage-id/v1");
        hash_component(&mut hasher, pack_identity.as_bytes());
        hash_component(&mut hasher, author_stage_id.as_bytes());
        hasher.update(attempt.to_be_bytes());
        let digest = hasher.finalize();
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let candidate = uuid::Uuid::from_bytes(bytes).to_string();
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("l'espace UUID déterministe est épuisé")
}

fn hash_component(hasher: &mut Sha256, component: &[u8]) {
    hasher.update((component.len() as u64).to_be_bytes());
    hasher.update(component);
}

/// Substitue le nom d'archive à chaque référence média de la **copie**.
///
/// Trois bornes :
///
/// - la substitution ne touche que `Stage.audio` et `Stage.image`. Les chaînes
///   **opaques** ne sont jamais renommées récursivement ni aspirées comme
///   médias : une extension opaque qui mentionnerait un ancien nom reste une
///   dimension `UNTESTED`, jamais une valeur « corrigée » ;
/// - une chaîne vide n'est pas une référence, exactement comme à l'inventaire.
///   Elle traverse la préparation telle que l'auteur l'a laissée ;
/// - la table doit être **complète** sur les références réellement présentes.
///   Une référence sans nom d'archive est un défaut interne de la chaîne, pas
///   une décision à prendre : la copie ne peut pas recevoir sa forme standard,
///   et le refus est celui de la sérialisation standard, sans variante ajoutée.
fn substitute_archive_names(
    document: &mut StoryDocument,
    asset_names: &ArchiveNameTable,
) -> Result<(), ExportPreparationError> {
    let mut missing: Vec<String> = Vec::new();
    for stage in &mut document.stage_nodes {
        for field in [&mut stage.audio, &mut stage.image] {
            let Some(asset_ref) = field.value() else {
                continue;
            };
            if asset_ref.trim().is_empty() {
                continue;
            }
            match asset_names.archive_name(asset_ref) {
                Some(archive_name) => *field = Presence::Value(archive_name.to_string()),
                None => {
                    if !missing.contains(asset_ref) {
                        missing.push(asset_ref.clone());
                    }
                }
            }
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(ExportPreparationError::StandardSerialization {
        message: format!(
            "Table des noms d'archive incomplète : {} référence(s) sans nom ({}).",
            missing.len(),
            missing.join(", ")
        ),
    })
}

fn apply_required_standard_shape(
    document: &mut StoryDocument,
    origin: DocumentOrigin,
    pack_identity: &str,
) -> Result<(), ExportPreparationError> {
    document.format = Presence::Value("v1".to_string());
    if origin == DocumentOrigin::Created {
        // La version est celle que l'auteur a posée, et `1` seulement s'il n'en
        // a posé aucune (version émise ; projet neuf : 1).
        //
        // L'imposer à `1` écraserait une valeur d'auteur, puisque la fiche du
        // pack, commune aux deux éditeurs, permet de la saisir : l'interface
        // afficherait une valeur que la production contredit.
        //
        // L'identité, elle, reste imposée : `pack_identity` est acquise une
        // seule fois et la racine `uuid` d'un document créé en est le miroir.
        // C'est une règle d'identité, pas un défaut d'interface, et elle n'est
        // pas touchée ici.
        if !document.version.is_value() {
            document.version = Presence::Value(1);
        }
        document.uuid = Presence::Value(pack_identity.to_string());
    } else if !document.version.is_value() {
        return Err(ExportPreparationError::StandardSerialization {
            message: "Un document importé doit porter une version explicite avant export standard."
                .to_string(),
        });
    }

    for stage in &mut document.stage_nodes {
        if stage.audio.is_absent() {
            stage.audio = Presence::Null;
        }
        if stage.image.is_absent() {
            stage.image = Presence::Null;
        }
        if stage.ok_transition.is_absent() {
            stage.ok_transition = Presence::Null;
        }
        if stage.home_transition.is_absent() {
            stage.home_transition = Presence::Null;
        }
    }
    Ok(())
}

/// Les valeurs de confort de la projection FS restent dans le payload ; elles
/// ne deviennent pas authored du seul fait de préparer une copie.
/// Les champs structurels (IDs, références, format, entrée) restent nécessaires.
fn omit_projected_metadata(
    payload: &DecodedStoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
    document: &mut StoryDocument,
) {
    fn omit<T>(payload: &DecodedStoryDocument, path: &str, value: &mut Presence<T>) {
        if value_origin(payload, path) == ValueOrigin::ProjectionDerived {
            *value = Presence::Absent;
        }
    }
    omit(payload, "/title", &mut document.title);
    omit(payload, "/description", &mut document.description);
    for (stage, path) in document.stage_nodes.iter_mut().zip(stage_paths) {
        omit(payload, &format!("{path}/name"), &mut stage.name);
        omit(payload, &format!("{path}/type"), &mut stage.stage_type);
        omit(payload, &format!("{path}/position"), &mut stage.position);
        omit(payload, &format!("{path}/groupId"), &mut stage.group_id);
    }
    for (action, path) in document.action_nodes.iter_mut().zip(action_paths) {
        omit(payload, &format!("{path}/name"), &mut action.name);
        omit(payload, &format!("{path}/type"), &mut action.action_type);
        omit(payload, &format!("{path}/position"), &mut action.position);
        omit(payload, &format!("{path}/groupId"), &mut action.group_id);
    }
}

fn apply_position_decisions(
    payload: &DecodedStoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
    document: &mut StoryDocument,
) -> Result<(), ExportPreparationError> {
    for (stage, path) in document.stage_nodes.iter_mut().zip(stage_paths) {
        apply_position_decision(payload, &format!("{path}/position"), &mut stage.position)?;
    }
    for (action, path) in document.action_nodes.iter_mut().zip(action_paths) {
        apply_position_decision(payload, &format!("{path}/position"), &mut action.position)?;
    }
    Ok(())
}

fn apply_position_decision(
    payload: &DecodedStoryDocument,
    path: &str,
    position: &mut Presence<Position>,
) -> Result<(), ExportPreparationError> {
    let Some(current) = position.value().cloned() else {
        return Ok(());
    };
    let origin = value_origin(payload, path);
    let Some(disposition) = payload
        .context
        .position_export_decisions
        .iter()
        .rev()
        .find(|decision| {
            decision.path == path && decision.origin == origin && decision.position == current
        })
        .map(|decision| decision.disposition)
    else {
        return Ok(());
    };
    match disposition {
        PositionExportDisposition::OmitExplicitly => *position = Presence::Absent,
        PositionExportDisposition::PreserveRawAcceptDantsuLoss => {}
        PositionExportDisposition::ScaleToShortRange => {
            *position = Presence::Value(scale_position_to_short_range(&current)?);
        }
    }
    Ok(())
}

/// Ramène **toute** la disposition dans l'intervalle short quand une position
/// en sort, par un seul facteur : la disposition relative des nœuds est ce que
/// l'auteur a construit, et la réduire uniformément la garde lisible.
///
/// L'auteur ne choisit rien, et STUdio reçoit un pack qu'il affiche. Seule la
/// copie d'export change — le document garde ses positions. Les positions
/// réduites sont arrondies à l'entier ; une disposition déjà dans l'intervalle
/// part intacte, à l'octet.
fn fit_positions_to_short_range(document: &mut StoryDocument) {
    let positions = || {
        document
            .stage_nodes
            .iter()
            .filter_map(|stage| stage.position.value())
            .chain(
                document
                    .action_nodes
                    .iter()
                    .filter_map(|action| action.position.value()),
            )
    };
    let factor = positions()
        .flat_map(|position| [&position.x, &position.y])
        .filter_map(Number::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| {
            if value > SHORT_MAX {
                SHORT_MAX / value
            } else if value < SHORT_MIN {
                SHORT_MIN / value
            } else {
                1.0
            }
        })
        .fold(1.0_f64, f64::min);
    if factor >= 1.0 {
        return;
    }
    let scale = |number: &Number| {
        number
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|value| (value * factor).round().clamp(SHORT_MIN, SHORT_MAX) as i64)
            .map(Number::from)
    };
    let fit = |position: &mut Presence<Position>| {
        let Some(current) = position.value() else {
            return;
        };
        if let (Some(x), Some(y)) = (scale(&current.x), scale(&current.y)) {
            *position = Presence::Value(Position { x, y });
        }
    };
    for stage in &mut document.stage_nodes {
        fit(&mut stage.position);
    }
    for action in &mut document.action_nodes {
        fit(&mut action.position);
    }
}

fn scale_position_to_short_range(position: &Position) -> Result<Position, ExportPreparationError> {
    let x = position
        .x
        .as_f64()
        .ok_or_else(|| numeric_position_error(position))?;
    let y = position
        .y
        .as_f64()
        .ok_or_else(|| numeric_position_error(position))?;
    let factor = [x, y]
        .into_iter()
        .map(|value| {
            if value > SHORT_MAX {
                SHORT_MAX / value
            } else if value < SHORT_MIN {
                SHORT_MIN / value
            } else {
                1.0
            }
        })
        .fold(1.0_f64, f64::min);
    let number = |value: f64| {
        Number::from_f64(value * factor).ok_or_else(|| numeric_position_error(position))
    };
    Ok(Position {
        x: number(x)?,
        y: number(y)?,
    })
}

fn numeric_position_error(position: &Position) -> ExportPreparationError {
    ExportPreparationError::StandardSerialization {
        message: format!(
            "Position impossible à mettre à l'échelle vers l'intervalle short : {position:?}."
        ),
    }
}

fn value_origin(payload: &DecodedStoryDocument, path: &str) -> ValueOrigin {
    payload
        .context
        .value_provenance
        .iter()
        .rev()
        .find(|entry| entry.path == path)
        .map(|entry| entry.origin)
        .unwrap_or(payload.context.default_value_origin)
}

fn standard_value_with_opaque_members(
    document: &StoryDocument,
    payload: &DecodedStoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
    entry_index: usize,
) -> Result<Value, ExportPreparationError> {
    let mut value = serde_json::to_value(document).map_err(|error| {
        ExportPreparationError::StandardSerialization {
            message: format!("Impossible de construire le JSON standard : {error}"),
        }
    })?;
    let stage_export_indices = stage_paths
        .iter()
        .enumerate()
        .map(|(author_index, path)| {
            let export_index = if author_index == entry_index {
                0
            } else if author_index < entry_index {
                author_index + 1
            } else {
                author_index
            };
            (path.as_str(), export_index)
        })
        .collect::<HashMap<_, _>>();
    let action_indices = action_paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.as_str(), index))
        .collect::<HashMap<_, _>>();

    for member in &payload.context.opaque_members {
        if opaque_member_never_emitted(payload, member) || !opaque_member_must_be_emitted(member) {
            continue;
        }
        let target = opaque_target_mut(
            &mut value,
            &member.path,
            &stage_export_indices,
            &action_indices,
        )?;
        target.insert(member.key.clone(), member.value.clone());
    }
    Ok(value)
}

fn opaque_member_must_be_emitted(member: &OpaqueMember) -> bool {
    member.export_disposition_value.matches_json(&member.value)
        && member.export_disposition_origin == Some(member.origin)
        && matches!(
            member.export_disposition,
            Some(
                OpaqueExportDisposition::PreserveUntested
                    | OpaqueExportDisposition::PromoteAfterProof
            )
        )
}

fn opaque_target_mut<'a>(
    root: &'a mut Value,
    path: &str,
    stage_indices: &HashMap<&str, usize>,
    action_indices: &HashMap<&str, usize>,
) -> Result<&'a mut Map<String, Value>, ExportPreparationError> {
    if path == "/" {
        return root.as_object_mut().ok_or_else(|| opaque_path_error(path));
    }
    if let Some((base, index)) = longest_path_match(path, stage_indices) {
        let node = root
            .get_mut("stageNodes")
            .and_then(Value::as_array_mut)
            .and_then(|nodes| nodes.get_mut(index))
            .ok_or_else(|| opaque_path_error(path))?;
        return descend_object(node, path.strip_prefix(base).unwrap_or(""), path);
    }
    if let Some((base, index)) = longest_path_match(path, action_indices) {
        let node = root
            .get_mut("actionNodes")
            .and_then(Value::as_array_mut)
            .and_then(|nodes| nodes.get_mut(index))
            .ok_or_else(|| opaque_path_error(path))?;
        return descend_object(node, path.strip_prefix(base).unwrap_or(""), path);
    }
    Err(opaque_path_error(path))
}

fn longest_path_match<'a>(
    path: &str,
    indices: &'a HashMap<&str, usize>,
) -> Option<(&'a str, usize)> {
    indices
        .iter()
        .filter(|(base, _)| path == **base || path.starts_with(&format!("{base}/")))
        .max_by_key(|(base, _)| base.len())
        .map(|(base, index)| (*base, *index))
}

fn descend_object<'a>(
    mut value: &'a mut Value,
    suffix: &str,
    full_path: &str,
) -> Result<&'a mut Map<String, Value>, ExportPreparationError> {
    for segment in suffix.split('/').filter(|segment| !segment.is_empty()) {
        value = value
            .as_object_mut()
            .and_then(|object| object.get_mut(segment))
            .ok_or_else(|| opaque_path_error(full_path))?;
    }
    value
        .as_object_mut()
        .ok_or_else(|| opaque_path_error(full_path))
}

fn opaque_path_error(path: &str) -> ExportPreparationError {
    ExportPreparationError::StandardSerialization {
        message: format!(
            "La disposition opaque à {path} ne peut pas être appliquée sans perte à la copie préparée."
        ),
    }
}
