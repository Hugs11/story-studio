use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::{Position, Presence, StoryDocument};

const ROOT_FIELDS: &[&str] = &[
    "format",
    "version",
    "stageNodes",
    "actionNodes",
    "title",
    "nightModeAvailable",
    "description",
    "uuid",
    "factoryDisabled",
    "image",
    "official",
];
const STAGE_FIELDS: &[&str] = &[
    "uuid",
    "id",
    "name",
    "type",
    "squareOne",
    "groupId",
    "audio",
    "image",
    "controlSettings",
    "homeTransition",
    "okTransition",
    "position",
];
const ACTION_FIELDS: &[&str] = &[
    "id", "uuid", "name", "type", "groupId", "options", "position",
];
const TRANSITION_FIELDS: &[&str] = &["actionNode", "optionIndex"];
const CONTROL_FIELDS: &[&str] = &["wheel", "ok", "home", "pause", "autoplay"];
const POSITION_FIELDS: &[&str] = &["x", "y"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DocumentOrigin {
    ImportedStudio,
    ImportedFs,
    Created,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ValueOrigin {
    SourceStudio,
    SourceNativeDerived,
    ProjectionDerived,
    Authored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExtensionScope {
    Root,
    Stage,
    Action,
    Transition,
    ControlSettings,
    Position,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OpaqueMemberKind {
    UnknownExtension,
    KnownAlias,
    KnownNeverEmitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OpaqueExportDisposition {
    PreserveUntested,
    RemoveExplicitly,
    PromoteAfterProof,
    NeverEmitStandard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PositionExportDisposition {
    ScaleToShortRange,
    OmitExplicitly,
    PreserveRawAcceptDantsuLoss,
}

/// Décision d'export attachée à la valeur et à la provenance exactes d'une
/// position. Une édition ultérieure rend cette décision périmée sans qu'un
/// appelant ait à penser à l'effacer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PositionExportDecision {
    pub(crate) path: String,
    pub(crate) origin: ValueOrigin,
    pub(crate) position: Position,
    pub(crate) disposition: PositionExportDisposition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpaqueMember {
    pub(crate) scope: ExtensionScope,
    /// Chemin stable d'auteur. Un nœud est ancré par son identifiant source et
    /// son occurrence parmi les identifiants égaux, jamais par son index de
    /// tableau ; une permutation ne détache donc pas son enveloppe.
    pub(crate) path: String,
    pub(crate) key: String,
    pub(crate) source_occurrence: usize,
    pub(crate) kind: OpaqueMemberKind,
    /// Provenance de la valeur opaque, conservée avec elle. Elle participe à
    /// l'identité d'une disposition : une valeur recréée ailleurs n'hérite pas
    /// d'une décision prise sur la source.
    #[serde(default = "source_studio_origin")]
    pub(crate) origin: ValueOrigin,
    pub(crate) value: Value,
    /// `None` signifie que la disposition reste à résoudre et devra bloquer la
    /// readiness si une perte est possible. Le décodage n'invente aucune
    /// décision d'export.
    pub(crate) export_disposition: Option<OpaqueExportDisposition>,
    /// Instantané exact auquel `export_disposition` s'applique. L'absence sur
    /// un ancien payload rend prudemment la décision périmée.
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) export_disposition_value: Presence<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) export_disposition_origin: Option<ValueOrigin>,
}

fn source_studio_origin() -> ValueOrigin {
    ValueOrigin::SourceStudio
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ValueProvenance {
    pub(crate) path: String,
    pub(crate) origin: ValueOrigin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorPosition {
    pub(crate) path: String,
    pub(crate) origin: ValueOrigin,
    pub(crate) position: Position,
}

/// Couleur de présentation choisie par l'auteur pour un nœud du graphe.
///
/// Elle appartient au projet Story Studio, pas au dialecte STUdio : elle est
/// conservée dans le contexte du `.mbah` et n'entre jamais dans le JSON
/// exporté. Le chemin stable distingue même deux identifiants source égaux.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeColor {
    pub(crate) path: String,
    pub(crate) color: String,
}

/// Une transition qu'un retrait a privée de sa destination.
///
/// Elle appartient au projet Story Studio, pas au dialecte STUdio : comme
/// `NodeColor`, elle vit dans le contexte du `.mbah` et n'entre jamais dans le
/// JSON exporté.
///
/// **Pourquoi une marque, et pas une règle lue sur le document.** Un Écran qui
/// n'a pas de transition OK est indiscernable d'un Écran terminal — la fin
/// d'une histoire en est un, et un projet neuf aussi. Le document ne porte donc
/// aucune propriété qui distingue « voulu ainsi » de « on vient de couper
/// l'Action d'en dessous ». Le seul indice de cette différence est le geste
/// lui-même, qui a vu la transition qu'il annulait : il l'écrit ici, et le
/// diagnostic naît de cette écriture seule. Aucun pack importé, aucun écran de
/// fin et aucun projet neuf ne peut donc la déclencher.
///
/// Le chemin ancre la **transition**, pas l'Écran : deux emplacements d'un même
/// Écran sont deux ruptures distinctes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeveredTransition {
    pub(crate) path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum InteroperabilityStatus {
    Supported,
    Prepared,
    Untested,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportQualification {
    pub(crate) dimension: String,
    pub(crate) path: String,
    pub(crate) status: InteroperabilityStatus,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum DiagnosticSeverity {
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportDiagnostic {
    pub(crate) severity: DiagnosticSeverity,
    pub(crate) code: String,
    pub(crate) path: String,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) retained: Presence<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) discarded: Vec<Value>,
}

/// Origine de l'identité stable du pack livrable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PackIdentityOrigin {
    /// Import STUdio : identité de l'unique Stage `squareOne`, conservée sans
    /// normalisation lexicale.
    SquareOneStage,
    /// Import FS : identité du Stage d'entrée reconstruite depuis le dossier.
    FsEntryStage,
    /// Identité source inexploitable : il faut générer une identité canonique
    /// stable. Elle n'est pas produite ici, parce qu'une identité tirée à chaque
    /// décodage ne serait pas stable : sa création et sa persistance relèvent de
    /// l'acquisition du projet.
    RequiresGeneration,
    /// Identité canonique créée puis persistée une seule fois, à l'acquisition
    /// du projet.
    ///
    /// Les trois variantes ci-dessus décrivent une **source** ou un **besoin** ;
    /// aucune ne décrit sa résolution. Sans cette quatrième variante, une
    /// identité déjà générée resterait indistinguable d'une identité encore à
    /// générer, et chaque relecture la régénérerait. Le motif qui a rendu la
    /// source inexploitable reste lisible dans `generation_reason`, et le Stage
    /// dont l'identité a été lue dans `source_path`.
    Generated,
}

/// Emplacement en lecture seule de la `packIdentity`. Elle est
/// distincte de la racine `uuid`, non autoritaire, et du Stage
/// courant `squareOne`, qui peut être réassigné sans changer l'identité.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackIdentity {
    pub(crate) origin: PackIdentityOrigin,
    /// Graphie source retenue telle quelle. `None` quand elle doit être générée.
    pub(crate) value: Option<String>,
    /// Identité courte commune aux deux passerelles, quand elle existe.
    pub(crate) short_identity: Option<String>,
    /// Chemin d'auteur du Stage dont l'identité a été lue, même non retenue.
    pub(crate) source_path: Option<String>,
    /// Motif exact **tant que** l'identité reste à générer. Il est effacé par la
    /// résolution : un motif « à générer » encore actif ferait croire à tout
    /// consommateur que l'identité persistée n'existe pas.
    pub(crate) unresolved_reason: Option<String>,
    /// Trace de la source, conservée après résolution : le motif exact qui a
    /// imposé la génération. Absent sur une identité lue dans sa source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) generation_reason: Option<String>,
}

impl Default for PackIdentity {
    fn default() -> Self {
        Self::requires_generation("Identité de pack non résolue.", None)
    }
}

impl PackIdentity {
    fn requires_generation(reason: &str, source_path: Option<String>) -> Self {
        Self {
            origin: PackIdentityOrigin::RequiresGeneration,
            value: None,
            short_identity: None,
            source_path,
            unresolved_reason: Some(reason.to_string()),
            generation_reason: None,
        }
    }

    /// L'identité canonique créée à l'acquisition du projet quand la source n'en
    /// fournit aucune d'exploitable.
    ///
    /// La graphie est celle d'`uuid`, donc bridge-compatible par construction ;
    /// l'assertion en fait une propriété testée plutôt qu'une supposition. Le
    /// document d'auteur n'est pas touché : `source_path` continue de désigner
    /// le Stage dont l'identité a été lue et écartée.
    pub(crate) fn generated(value: uuid::Uuid, previous: &Self) -> Self {
        Self::chosen(&value.to_string(), previous)
    }

    /// Une identité résolue hors de la source : tirée à l'acquisition, ou choisie par
    /// l'auteur dans la fiche du pack. Sa graphie est gardée telle quelle — une
    /// graphie sans tirets saisie par l'auteur n'est pas réécrite —, et elle
    /// doit être lisible par les deux passerelles : l'appelant l'a vérifié.
    pub(crate) fn chosen(value: &str, previous: &Self) -> Self {
        let classification = classify_stage_id(value);
        debug_assert!(
            classification.bridge_compatible,
            "une identité résolue doit être bridge-compatible"
        );
        Self {
            origin: PackIdentityOrigin::Generated,
            short_identity: classification.short_luniiqt,
            value: Some(value.to_string()),
            source_path: previous.source_path.clone(),
            unresolved_reason: None,
            generation_reason: previous
                .unresolved_reason
                .clone()
                .or_else(|| previous.generation_reason.clone()),
        }
    }

    /// L'identité stable vient de l'unique Stage `squareOne` quand il est
    /// bridge-compatible (voir `classify_stage_id`). Aucune graphie
    /// n'est normalisée et la racine `uuid` n'entre jamais dans le calcul.
    fn derive(document: &StoryDocument, origin: PackIdentityOrigin) -> Self {
        let paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
            stage.uuid.as_str()
        });
        let mut entries = document
            .stage_nodes
            .iter()
            .zip(paths)
            .filter(|(stage, _)| stage.is_square_one());
        let Some((stage, path)) = entries.next() else {
            return Self::requires_generation(
                "Aucun Stage squareOne : l'identité stable doit être générée.",
                None,
            );
        };
        if entries.next().is_some() {
            return Self::requires_generation(
                "Plusieurs Stages squareOne : l'identité d'entrée est ambiguë.",
                Some(path),
            );
        }
        let classification = classify_stage_id(&stage.uuid);
        if !classification.bridge_compatible {
            return Self::requires_generation(
                "Identité du Stage d'entrée non bridge-compatible : génération canonique requise.",
                Some(path),
            );
        }
        Self {
            origin,
            value: Some(stage.uuid.clone()),
            short_identity: classification.short_luniiqt,
            source_path: Some(path),
            unresolved_reason: None,
            generation_reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoryDocumentContext {
    pub(crate) document_origin: DocumentOrigin,
    /// Provenance implicite de toute valeur qui n'a pas d'override plus précis.
    pub(crate) default_value_origin: ValueOrigin,
    /// Identité stable du pack livrable, transmise en lecture seule à la
    /// préparation d'export.
    #[serde(default)]
    pub(crate) pack_identity: PackIdentity,
    #[serde(default)]
    pub(crate) value_provenance: Vec<ValueProvenance>,
    #[serde(default)]
    pub(crate) editor_positions: Vec<EditorPosition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) node_colors: Vec<NodeColor>,
    /// Les transitions qu'un retrait a privées de destination et que l'auteur
    /// n'a pas encore refaites. Elles se purgent d'elles-mêmes dès que la
    /// transition retrouve une valeur.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) severed_transitions: Vec<SeveredTransition>,
    #[serde(default)]
    pub(crate) position_export_decisions: Vec<PositionExportDecision>,
    #[serde(default)]
    pub(crate) export_qualifications: Vec<ExportQualification>,
    #[serde(default)]
    pub(crate) opaque_members: Vec<OpaqueMember>,
    #[serde(default)]
    pub(crate) diagnostics: Vec<ImportDiagnostic>,
}

impl StoryDocumentContext {
    /// Contexte d'un document créé ex nihilo par Story Studio.
    ///
    /// Il n'a ni source ni projection : toute valeur y est `authored`, et
    /// l'identité du pack est générée une seule fois à l'acquisition plutôt que
    /// dérivée d'un Stage — un projet neuf n'en a pas encore.
    #[allow(dead_code)] // Seul appelant : l'acquisition du projet, pas encore raccordée.
    pub(crate) fn created() -> Self {
        Self {
            document_origin: DocumentOrigin::Created,
            default_value_origin: ValueOrigin::Authored,
            pack_identity: PackIdentity::requires_generation(
                "Projet créé : aucune identité source, génération canonique requise.",
                None,
            ),
            value_provenance: Vec::new(),
            editor_positions: Vec::new(),
            node_colors: Vec::new(),
            severed_transitions: Vec::new(),
            position_export_decisions: Vec::new(),
            export_qualifications: Vec::new(),
            opaque_members: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn imported_studio() -> Self {
        Self {
            document_origin: DocumentOrigin::ImportedStudio,
            default_value_origin: ValueOrigin::SourceStudio,
            pack_identity: PackIdentity::default(),
            value_provenance: Vec::new(),
            editor_positions: Vec::new(),
            node_colors: Vec::new(),
            severed_transitions: Vec::new(),
            position_export_decisions: Vec::new(),
            export_qualifications: Vec::new(),
            opaque_members: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    /// Contexte d'un pack FS natif projeté. Les valeurs réellement lues dans
    /// le format natif héritent de `source-native-derived`; seules les valeurs
    /// fabriquées pour rendre le pack affichable sont surchargées.
    ///
    /// `directory_identity` est le nom du dossier du pack : c'est la seule
    /// identité de Stage que le format natif porte réellement. Tous les autres
    /// identifiants et références sont fabriqués par le lecteur, donc
    /// `projection-derived`.
    pub(crate) fn imported_fs(document: &StoryDocument, directory_identity: &str) -> Self {
        let mut context = Self {
            document_origin: DocumentOrigin::ImportedFs,
            default_value_origin: ValueOrigin::SourceNativeDerived,
            pack_identity: PackIdentity::derive(document, PackIdentityOrigin::FsEntryStage),
            value_provenance: Vec::new(),
            editor_positions: Vec::new(),
            node_colors: Vec::new(),
            severed_transitions: Vec::new(),
            position_export_decisions: Vec::new(),
            export_qualifications: Vec::new(),
            opaque_members: Vec::new(),
            diagnostics: Vec::new(),
        };

        for path in ["/format", "/title", "/description"] {
            context.value_provenance.push(ValueProvenance {
                path: path.to_string(),
                origin: ValueOrigin::ProjectionDerived,
            });
        }
        context.value_provenance.push(ValueProvenance {
            path: "/version".to_string(),
            origin: ValueOrigin::SourceNativeDerived,
        });
        if document.version.value().copied() == Some(256) {
            context.export_qualifications.push(ExportQualification {
                dimension: "studio-export-version".to_string(),
                path: "/version".to_string(),
                status: InteroperabilityStatus::Untested,
                reason: "La provenance FS et l'interprétation little-endian sont établies, mais story.json version:256 n'a pas été soumis aux deux passerelles figées.".to_string(),
            });
        }

        let stage_paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
            stage.uuid.as_str()
        });
        for (index, (stage, path)) in document.stage_nodes.iter().zip(stage_paths).enumerate() {
            for field in ["name", "type", "squareOne"] {
                context.value_provenance.push(ValueProvenance {
                    path: format!("{path}/{field}"),
                    origin: ValueOrigin::ProjectionDerived,
                });
            }
            // Le Stage d'entrée porte l'identité lue sur le dossier du pack ;
            // les Stages intérieurs reçoivent un identifiant tiré par le
            // lecteur, qui n'existe nulle part dans la source native.
            let entry_identity = index == 0 && stage.uuid == directory_identity;
            context.value_provenance.push(ValueProvenance {
                path: format!("{path}/uuid"),
                origin: if entry_identity {
                    ValueOrigin::SourceNativeDerived
                } else {
                    ValueOrigin::ProjectionDerived
                },
            });
            // Les deux transitions désignent des Actions nommées par la
            // projection : la référence est fabriquée même quand le lien natif
            // qu'elle traduit, lui, vient bien du pack.
            for (name, transition) in [
                ("okTransition", &stage.ok_transition),
                ("homeTransition", &stage.home_transition),
            ] {
                if transition.is_value() {
                    context.value_provenance.push(ValueProvenance {
                        path: format!("{path}/{name}/actionNode"),
                        origin: ValueOrigin::ProjectionDerived,
                    });
                }
            }
            context.editor_positions.push(EditorPosition {
                path: format!("{path}/position"),
                origin: ValueOrigin::ProjectionDerived,
                position: projected_stage_position(index),
            });
        }

        let action_paths =
            stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
                action.id.as_str()
            });
        for (index, (_, path)) in document.action_nodes.iter().zip(action_paths).enumerate() {
            // `options` liste les identifiants de Stage fabriqués ci-dessus :
            // la référence est aussi fabriquée que sa cible.
            for field in ["id", "name", "options"] {
                context.value_provenance.push(ValueProvenance {
                    path: format!("{path}/{field}"),
                    origin: ValueOrigin::ProjectionDerived,
                });
            }
            context.editor_positions.push(EditorPosition {
                path: format!("{path}/position"),
                origin: ValueOrigin::ProjectionDerived,
                position: projected_action_position(index),
            });
        }

        context
    }

    pub(crate) fn log_warnings(&self) {
        for diagnostic in &self.diagnostics {
            if diagnostic.severity == DiagnosticSeverity::Warning {
                log::warn!(
                    target: "pack_reader",
                    "{} {}: {}",
                    diagnostic.code,
                    diagnostic.path,
                    diagnostic.message
                );
            }
        }
    }
}

/// Quadrillage d'affichage d'une projection FS : le format natif ne porte
/// aucune position, et cette disposition va dans l'état d'éditeur, jamais dans
/// le document d'auteur. La règle est définie ici, une seule fois, parce que le
/// contexte doit pouvoir être reconstruit à l'identique après la mise en cache
/// du ZIP converti.
pub(crate) fn projected_stage_position(index: usize) -> Position {
    Position {
        x: serde_json::Number::from((index + 1) * 160),
        y: serde_json::Number::from(160_u32),
    }
}

pub(crate) fn projected_action_position(index: usize) -> Position {
    Position {
        x: serde_json::Number::from((index + 1) * 120),
        y: serde_json::Number::from(0_u32),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecodedStoryDocument {
    pub(crate) document: StoryDocument,
    /// Vue JSON last-wins utilisée par les consommateurs historiques en lecture.
    /// Elle conserve les extensions pendant l'import, mais reste dérivée et
    /// n'est jamais persistée à côté du document et de son enveloppe.
    #[serde(skip)]
    pub(crate) source_value: Value,
    pub(crate) context: StoryDocumentContext,
}

impl DecodedStoryDocument {
    /// Raccorde au document relu le contexte produit par une conversion amont.
    ///
    /// Une projection FS est la seule à connaître l'origine du pack, la
    /// provenance de ses valeurs, son quadrillage d'éditeur séparé et ses
    /// qualifications d'export ; le décodage de la copie convertie, lui, est le
    /// seul à observer les membres opaques et les doublons de ces octets. Les
    /// deux moitiés doivent donc arriver ensemble à la frontière d'import,
    /// sinon la relecture du ZIP converti reclasse le pack en `imported-studio`
    /// et perd la qualification `UNTESTED` de sa `version`.
    pub(crate) fn with_conversion_context(
        mut self,
        conversion: Option<StoryDocumentContext>,
    ) -> Self {
        let Some(conversion) = conversion else {
            return self;
        };
        let decoded = std::mem::replace(&mut self.context, conversion);
        let derived_origin = if self.context.document_origin == DocumentOrigin::ImportedFs {
            ValueOrigin::ProjectionDerived
        } else {
            self.context.default_value_origin
        };
        self.context
            .opaque_members
            .extend(decoded.opaque_members.into_iter().map(|mut member| {
                member.origin = derived_origin;
                if member.export_disposition.is_some() {
                    member.export_disposition_origin = Some(derived_origin);
                }
                member
            }));
        self.context.diagnostics.extend(decoded.diagnostics);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoryDecodeError {
    pub(crate) diagnostics: Vec<ImportDiagnostic>,
}

impl fmt::Display for StoryDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = self
            .diagnostics
            .iter()
            .map(|diagnostic| {
                format!(
                    "{} {}: {}",
                    diagnostic.code, diagnostic.path, diagnostic.message
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
        formatter.write_str(&detail)
    }
}

/// Décode les octets JSON avant toute conversion en map. La racine conserve
/// ainsi les occurrences dupliquées nécessaires au diagnostic ; la dernière est
/// la vue typée retenue, les précédentes restent dans le diagnostic exact.
pub(crate) fn decode_story_document(
    source: &str,
) -> Result<DecodedStoryDocument, StoryDecodeError> {
    let mut deserializer = serde_json::Deserializer::from_str(source);
    let RootMembers(entries) = RootMembers::deserialize(&mut deserializer)
        .map_err(|error| syntax_error(error.to_string()))?;
    deserializer
        .end()
        .map_err(|error| syntax_error(error.to_string()))?;

    let mut context = StoryDocumentContext::imported_studio();
    let mut occurrences: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (key, value) in &entries {
        occurrences
            .entry(key.clone())
            .or_default()
            .push(value.clone());
    }

    let mut root = Map::new();
    for (key, value) in &entries {
        root.insert(key.clone(), value.clone());
    }

    for (key, values) in &occurrences {
        if values.len() > 1 && ROOT_FIELDS.contains(&key.as_str()) {
            let retained = values.last().cloned().expect("non-empty occurrences");
            let discarded = values[..values.len() - 1].to_vec();
            context.diagnostics.push(ImportDiagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "duplicate-root-key-last-wins".to_string(),
                path: format!("/{}", pointer_segment(key)),
                message: format!(
                    "Clé racine dupliquée : dernière valeur retenue ({}), {} valeur(s) écartée(s) ({}).",
                    compact_value(&retained),
                    discarded.len(),
                    discarded
                        .iter()
                        .map(compact_value)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                retained: Presence::from_json(retained),
                discarded,
            });
        }
    }

    for (key, values) in &occurrences {
        let kind = match key.as_str() {
            "image" | "official" => Some(OpaqueMemberKind::KnownNeverEmitted),
            known if ROOT_FIELDS.contains(&known) => None,
            _ => Some(OpaqueMemberKind::UnknownExtension),
        };
        if let Some(kind) = kind {
            for (source_occurrence, value) in values.iter().enumerate() {
                context.opaque_members.push(OpaqueMember {
                    scope: ExtensionScope::Root,
                    path: "/".to_string(),
                    key: key.clone(),
                    source_occurrence,
                    kind,
                    origin: context.default_value_origin,
                    value: value.clone(),
                    export_disposition: (kind != OpaqueMemberKind::UnknownExtension)
                        .then_some(OpaqueExportDisposition::NeverEmitStandard),
                    export_disposition_value: if kind != OpaqueMemberKind::UnknownExtension {
                        Presence::from_json(value.clone())
                    } else {
                        Presence::Absent
                    },
                    export_disposition_origin: (kind != OpaqueMemberKind::UnknownExtension)
                        .then_some(context.default_value_origin),
                });
            }
        }
    }

    let source_value = Value::Object(root);
    classify_nested_members(&source_value, &mut context);
    let mut shape_errors = validate_transition_shapes(&source_value);
    shape_errors.extend(validate_control_settings_shapes(&source_value));
    if !shape_errors.is_empty() {
        return Err(StoryDecodeError {
            diagnostics: shape_errors,
        });
    }

    let document =
        serde_json::from_value(source_value.clone()).map_err(|error| StoryDecodeError {
            diagnostics: vec![ImportDiagnostic {
                severity: DiagnosticSeverity::Error,
                code: "story-document-invalid".to_string(),
                path: "/".to_string(),
                message: error.to_string(),
                retained: Presence::Absent,
                discarded: Vec::new(),
            }],
        })?;

    context.pack_identity = PackIdentity::derive(&document, PackIdentityOrigin::SquareOneStage);
    qualify_incomplete_control_settings(&document, &mut context);

    Ok(DecodedStoryDocument {
        document,
        source_value,
        context,
    })
}

#[derive(Debug)]
struct RootMembers(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for RootMembers {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct RootVisitor;

        impl<'de> Visitor<'de> for RootVisitor {
            type Value = RootMembers;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("un objet JSON story.json")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut members = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    members.push((key, value));
                }
                Ok(RootMembers(members))
            }
        }

        deserializer.deserialize_map(RootVisitor)
    }
}

fn classify_nested_members(document: &Value, context: &mut StoryDocumentContext) {
    let Some(root) = document.as_object() else {
        return;
    };

    if let Some(stages) = root.get("stageNodes").and_then(Value::as_array) {
        let paths = stable_value_paths(stages, "stageNodes", "uuid");
        for (stage, path) in stages.iter().zip(paths) {
            classify_object(
                stage,
                ExtensionScope::Stage,
                &path,
                STAGE_FIELDS,
                context,
                |_| None,
            );
            if let Some(object) = stage.as_object() {
                capture_known_alias(object, ExtensionScope::Stage, &path, "uuid", "id", context);
                classify_child_object(
                    object.get("controlSettings"),
                    ExtensionScope::ControlSettings,
                    &format!("{path}/controlSettings"),
                    CONTROL_FIELDS,
                    context,
                );
                classify_child_object(
                    object.get("position"),
                    ExtensionScope::Position,
                    &format!("{path}/position"),
                    POSITION_FIELDS,
                    context,
                );
                if object.get("position").is_some_and(|value| !value.is_null()) {
                    context.value_provenance.push(ValueProvenance {
                        path: format!("{path}/position"),
                        origin: ValueOrigin::SourceStudio,
                    });
                }
                for transition_name in ["okTransition", "homeTransition"] {
                    classify_child_object(
                        object.get(transition_name),
                        ExtensionScope::Transition,
                        &format!("{path}/{transition_name}"),
                        TRANSITION_FIELDS,
                        context,
                    );
                }
            }
        }
    }

    if let Some(actions) = root.get("actionNodes").and_then(Value::as_array) {
        let paths = stable_value_paths(actions, "actionNodes", "id");
        for (action, path) in actions.iter().zip(paths) {
            classify_object(
                action,
                ExtensionScope::Action,
                &path,
                ACTION_FIELDS,
                context,
                |_| None,
            );
            if let Some(object) = action.as_object() {
                capture_known_alias(object, ExtensionScope::Action, &path, "id", "uuid", context);
                classify_child_object(
                    object.get("position"),
                    ExtensionScope::Position,
                    &format!("{path}/position"),
                    POSITION_FIELDS,
                    context,
                );
                if object.get("position").is_some_and(|value| !value.is_null()) {
                    context.value_provenance.push(ValueProvenance {
                        path: format!("{path}/position"),
                        origin: ValueOrigin::SourceStudio,
                    });
                }
            }
        }
    }
}

fn classify_object<F>(
    value: &Value,
    scope: ExtensionScope,
    path: &str,
    known_fields: &[&str],
    context: &mut StoryDocumentContext,
    classify_known: F,
) where
    F: Fn(&str) -> Option<OpaqueMemberKind>,
{
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, value) in object {
        let kind = classify_known(key).or_else(|| {
            (!known_fields.contains(&key.as_str())).then_some(OpaqueMemberKind::UnknownExtension)
        });
        if let Some(kind) = kind {
            context.opaque_members.push(OpaqueMember {
                scope,
                path: path.to_string(),
                key: key.clone(),
                source_occurrence: 0,
                kind,
                origin: context.default_value_origin,
                value: value.clone(),
                export_disposition: (kind == OpaqueMemberKind::KnownNeverEmitted)
                    .then_some(OpaqueExportDisposition::NeverEmitStandard),
                export_disposition_value: if kind == OpaqueMemberKind::KnownNeverEmitted {
                    Presence::from_json(value.clone())
                } else {
                    Presence::Absent
                },
                export_disposition_origin: (kind == OpaqueMemberKind::KnownNeverEmitted)
                    .then_some(context.default_value_origin),
            });
        }
    }
}

fn capture_known_alias(
    object: &Map<String, Value>,
    scope: ExtensionScope,
    path: &str,
    canonical_key: &str,
    alias_key: &str,
    context: &mut StoryDocumentContext,
) {
    let Some(alias) = object.get(alias_key) else {
        return;
    };
    let redundant = object.get(canonical_key) == Some(alias);
    context.opaque_members.push(OpaqueMember {
        scope,
        path: path.to_string(),
        key: alias_key.to_string(),
        source_occurrence: 0,
        kind: OpaqueMemberKind::KnownAlias,
        origin: context.default_value_origin,
        value: alias.clone(),
        // Seul le cas redondant est fermé. Une valeur divergente reste UNTESTED
        // et requiert donc une disposition explicite ultérieure.
        export_disposition: redundant.then_some(OpaqueExportDisposition::NeverEmitStandard),
        export_disposition_value: if redundant {
            Presence::from_json(alias.clone())
        } else {
            Presence::Absent
        },
        export_disposition_origin: redundant.then_some(context.default_value_origin),
    });
}

fn classify_child_object(
    value: Option<&Value>,
    scope: ExtensionScope,
    path: &str,
    known_fields: &[&str],
    context: &mut StoryDocumentContext,
) {
    if value.is_none_or(Value::is_null) {
        return;
    }
    classify_object(
        value.expect("checked above"),
        scope,
        path,
        known_fields,
        context,
        |_| None,
    );
}

/// Clause d'entrée : la **forme** des contrôles est vérifiée avant
/// la désérialisation typée, pour rendre un diagnostic localisé au lieu du
/// message serde du document entier.
///
/// Un objet partiel, absent ou `null`, et un membre `null`, sont acceptés :
/// c'est la politique d'entrée conservatrice. Une valeur qui n'est **pas** un
/// booléen est une erreur de forme distincte, refusée avec son propre code :
/// aucun cast implicite ne transforme `1` ou `"oui"` en `true`.
fn validate_control_settings_shapes(document: &Value) -> Vec<ImportDiagnostic> {
    let mut diagnostics = Vec::new();
    let Some(stages) = document.get("stageNodes").and_then(Value::as_array) else {
        return diagnostics;
    };
    let paths = stable_value_paths(stages, "stageNodes", "uuid");
    for (stage, stage_path) in stages.iter().zip(paths) {
        let Some(controls) = stage.get("controlSettings") else {
            continue;
        };
        if controls.is_null() {
            continue;
        }
        let path = format!("{stage_path}/controlSettings");
        let Some(object) = controls.as_object() else {
            diagnostics.push(decode_error(
                "control-settings-not-object",
                &path,
                "controlSettings doit être un objet, `null`, ou absent.",
            ));
            continue;
        };
        for control in CONTROL_FIELDS {
            let Some(value) = object.get(*control) else {
                continue;
            };
            if !value.is_boolean() && !value.is_null() {
                diagnostics.push(decode_error(
                    "control-settings-member-not-boolean",
                    &format!("{path}/{control}"),
                    "Un contrôle présent doit être un booléen ou `null` : aucune autre valeur n'est interprétée.",
                ));
            }
        }
    }
    diagnostics
}

/// Rend observable ce que la clause d'entrée conserve : un objet de contrôles
/// incomplet reste dans le document, mais il est signalé et qualifié
/// `UNTESTED`. Les cinq booléens explicites restent la condition de sortie de
/// la préparation d'export ; ils ne peuvent être complétés que par une commande
/// d'auteur, jamais déduits d'une transition.
fn qualify_incomplete_control_settings(
    document: &StoryDocument,
    context: &mut StoryDocumentContext,
) {
    let paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    for (stage, stage_path) in document.stage_nodes.iter().zip(paths) {
        if stage.control_settings.is_complete() {
            continue;
        }
        let path = format!("{stage_path}/controlSettings");
        let detail = match stage.control_settings.value() {
            None => {
                if stage.control_settings.is_absent() {
                    "l'objet est absent".to_string()
                } else {
                    "l'objet est null".to_string()
                }
            }
            Some(controls) => {
                let missing = controls
                    .members()
                    .into_iter()
                    .filter(|(_, control)| !control.is_value())
                    .map(|(name, control)| {
                        format!(
                            "{name} ({})",
                            if control.is_absent() {
                                "absent"
                            } else {
                                "null"
                            }
                        )
                    })
                    .collect::<Vec<_>>();
                format!("contrôles non renseignés : {}", missing.join(", "))
            }
        };
        context.diagnostics.push(ImportDiagnostic {
            severity: DiagnosticSeverity::Warning,
            code: "control-settings-incomplete".to_string(),
            path: path.clone(),
            message: format!(
                "Contrôles incomplets conservés tels quels : {detail}. Les cinq booléens doivent être renseignés explicitement avant tout export standard."
            ),
            retained: Presence::Absent,
            discarded: Vec::new(),
        });
        context.export_qualifications.push(ExportQualification {
            dimension: "studio-export-control-settings".to_string(),
            path,
            status: InteroperabilityStatus::Untested,
            reason: "Aucune passerelle figée n'a été mesurée sur un controlSettings incomplet ; l'export exige les cinq booléens en sortie et aucune valeur n'est déduite ici.".to_string(),
        });
    }
}

fn validate_transition_shapes(document: &Value) -> Vec<ImportDiagnostic> {
    let mut diagnostics = Vec::new();
    let Some(stages) = document.get("stageNodes").and_then(Value::as_array) else {
        return diagnostics;
    };
    let paths = stable_value_paths(stages, "stageNodes", "uuid");
    for (stage, stage_path) in stages.iter().zip(paths) {
        for transition_name in ["okTransition", "homeTransition"] {
            let Some(transition) = stage.get(transition_name) else {
                continue;
            };
            if transition.is_null() {
                continue;
            }
            let path = format!("{stage_path}/{transition_name}");
            let Some(object) = transition.as_object() else {
                diagnostics.push(decode_error(
                    "transition-not-object",
                    &path,
                    "Une transition présente doit être un objet.",
                ));
                continue;
            };
            if !object.contains_key("actionNode") {
                diagnostics.push(decode_error(
                    "transition-missing-action-node",
                    &path,
                    "La clé actionNode est obligatoire sur une transition objet.",
                ));
            }
            if !object.contains_key("optionIndex") {
                diagnostics.push(decode_error(
                    "transition-missing-option-index",
                    &path,
                    "La clé optionIndex est obligatoire sur une transition objet.",
                ));
            } else if object
                .get("optionIndex")
                .and_then(Value::as_i64)
                .is_some_and(|index| index < -1)
            {
                diagnostics.push(decode_error(
                    "transition-option-index-below-minus-one",
                    &format!("{path}/optionIndex"),
                    "optionIndex doit être supérieur ou égal à -1.",
                ));
            }
        }
    }
    diagnostics
}

fn decode_error(code: &str, path: &str, message: &str) -> ImportDiagnostic {
    ImportDiagnostic {
        severity: DiagnosticSeverity::Error,
        code: code.to_string(),
        path: path.to_string(),
        message: message.to_string(),
        retained: Presence::Absent,
        discarded: Vec::new(),
    }
}

fn syntax_error(message: String) -> StoryDecodeError {
    StoryDecodeError {
        diagnostics: vec![decode_error("story-json-invalid", "/", &message)],
    }
}

fn stable_value_paths(values: &[Value], collection: &str, id_field: &str) -> Vec<String> {
    let mut occurrences: HashMap<String, usize> = HashMap::new();
    values
        .iter()
        .map(|value| {
            let id = value
                .get(id_field)
                .and_then(Value::as_str)
                .unwrap_or("<missing>");
            let occurrence = occurrences.entry(id.to_string()).or_default();
            let path = format!(
                "/{collection}/@{id_field}={}#{}",
                pointer_segment(id),
                *occurrence
            );
            *occurrence += 1;
            path
        })
        .collect()
}

/// Le chemin d'auteur stable d'un nœud typé : ancré sur son identifiant source
/// et sur son occurrence parmi les identifiants égaux, jamais sur son rang dans
/// le tableau. Partagé avec le validateur d'intégrité, qui doit pouvoir
/// désigner sans ambiguïté le second nœud d'un identifiant dupliqué.
pub(crate) fn stable_node_paths<T, F>(
    values: &[T],
    collection: &str,
    id_field: &str,
    id: F,
) -> Vec<String>
where
    F: Fn(&T) -> &str,
{
    let mut occurrences: HashMap<String, usize> = HashMap::new();
    values
        .iter()
        .map(|value| {
            let identifier = id(value);
            let occurrence = occurrences.entry(identifier.to_string()).or_default();
            let path = format!(
                "/{collection}/@{id_field}={}#{}",
                pointer_segment(identifier),
                *occurrence
            );
            *occurrence += 1;
            path
        })
        .collect()
}

fn pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

/// Longueur maximale d'une représentation de lecture d'une valeur opaque.
const COMPACT_VALUE_LIMIT: usize = 160;

fn compact_value(value: &Value) -> String {
    compact_value_bounded(value).0
}

/// La même représentation bornée, avec l'information « la valeur a-t-elle été
/// coupée ? ». Un inspecteur doit pouvoir le dire à l'auteur au lieu de laisser
/// croire que l'aperçu est la valeur entière.
pub(crate) fn compact_value_bounded(value: &Value) -> (String, bool) {
    let serialized = value.to_string();
    if serialized.chars().count() <= COMPACT_VALUE_LIMIT {
        return (serialized, false);
    }
    let prefix = serialized
        .chars()
        .take(COMPACT_VALUE_LIMIT)
        .collect::<String>();
    (format!("{prefix}…"), true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StageIdClassification {
    pub(crate) bridge_compatible: bool,
    pub(crate) short_luniiqt: Option<String>,
    pub(crate) short_dantsu: Option<String>,
}

/// L'identité d'un pack relu, là où l'appareil la lit, sur un `story.json` brut.
///
/// STUdio et Lunii.QT dérivent l'identité de l'Écran d'entrée et ignorent le
/// `uuid` de tête. L'unique Écran `squareOne` l'emporte donc dès
/// que les deux passerelles le lisent de la même façon, écrit tel quel. Sinon,
/// le `uuid` de tête sert s'il est lisible ; à défaut, `None`. C'est la règle
/// de « Modifier un pack » et du correcteur de packs communautaires.
pub(crate) fn pack_identity_from_story(story: &Value) -> Option<String> {
    let mut entries = story
        .get("stageNodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|stage| stage.get("squareOne").and_then(Value::as_bool) == Some(true));
    let entry = entries
        .next()
        .filter(|_| entries.next().is_none())
        .and_then(|stage| stage.get("uuid"))
        .and_then(Value::as_str)
        .filter(|uuid| classify_stage_id(uuid).bridge_compatible);
    if let Some(entry) = entry {
        return Some(entry.to_string());
    }
    story
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|uuid| classify_stage_id(uuid).bridge_compatible)
        .map(str::to_string)
}

/// Pourquoi une identité de pack saisie ne peut pas être livrée, ou `None`.
///
/// C'est le seul contrôle posé sur l'identité choisie par l'auteur : elle
/// devient l'UUID de l'Écran d'entrée, que STUdio et Lunii.QT doivent lire de la
/// même façon. La fiche, le geste du graphe et l'export Libre l'appliquent tous
/// trois, pour qu'aucune saisie acceptée ne soit refusée plus tard.
pub(crate) fn pack_identity_refusal(value: &str) -> Option<String> {
    let identity = value.trim();
    if identity.is_empty() {
        return Some("L'UUID du pack est vide.".to_string());
    }
    (!classify_stage_id(identity).bridge_compatible)
        .then(|| format!("L'UUID du pack « {identity} » n'est pas lisible par STUdio et Lunii.QT."))
}

/// Classification pure d'un identifiant de Stage. La chaîne source n'est jamais
/// normalisée : le remap éventuel se décide sur la copie d'export.
pub(crate) fn classify_stage_id(value: &str) -> StageIdClassification {
    let short_luniiqt = parse_luniiqt_uuid(value).map(|uuid| {
        let hex = uuid.simple().to_string();
        hex[24..].to_ascii_uppercase()
    });
    let without_hyphens = value.replace('-', "");
    let short_dantsu = (without_hyphens.chars().count() >= 8).then(|| {
        without_hyphens
            .chars()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>()
            .to_uppercase()
    });
    let bridge_compatible = short_luniiqt.is_some() && short_luniiqt == short_dantsu;
    StageIdClassification {
        bridge_compatible,
        short_luniiqt,
        short_dantsu,
    }
}

/// Reproduit l'acceptation de `uuid.UUID`, appelé par Lunii.QT figé
/// (`pkg/api/stories.py:88`). CPython y applique littéralement :
///
/// ```python
/// hex = hex.replace('urn:', '').replace('uuid:', '')
/// hex = hex.strip('{}').replace('-', '')
/// if len(hex) != 32: raise ValueError(...)
/// int = int(hex, 16)
/// ```
///
/// `uuid::Uuid::parse_str` n'accepte, lui, que les graphies canonique, simple,
/// URN et entre accolades **appariées** : il refuse un tiret hors position, une
/// accolade seule ou un préfixe `uuid:` sans `urn:`, que la passerelle accepte.
/// La classification doit reproduire l'acceptation du parseur figé, jamais la
/// restreindre ; le suffixe STUdio reste calculé sur la graphie brute.
fn parse_luniiqt_uuid(value: &str) -> Option<uuid::Uuid> {
    let candidate = value.replace("urn:", "").replace("uuid:", "");
    let hex: String = candidate
        .trim_matches(|character| character == '{' || character == '}')
        .chars()
        .filter(|character| *character != '-')
        // CPython normalise les chiffres décimaux Unicode avant int(hex, 16),
        // y compris le zéro éventuel du préfixe 0x.
        .map(|character| {
            python_decimal_digit(character)
                .and_then(|digit| char::from_digit(digit, 10))
                .unwrap_or(character)
        })
        .collect();
    if hex.chars().count() != 32 {
        return None;
    }
    python_int_base16(&hex).map(uuid::Uuid::from_u128)
}

/// Reproduit `int(value, 16)` après normalisation des chiffres décimaux :
/// espaces entourants, signe, préfixe `0x`, `_` après ce préfixe ou entre chiffres.
fn python_int_base16(value: &str) -> Option<u128> {
    // int() refuse U+001C..U+001F, contrairement à str.strip().
    let trimmed = value.trim_matches(char::is_whitespace);
    // Un signe `-` ne peut pas survivre au retrait des tirets ; seul `+` reste
    // atteignable.
    let digits = trimmed.strip_prefix('+').unwrap_or(trimmed);
    let prefixed = digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"));
    let digits = prefixed
        .map(|digits| digits.strip_prefix('_').unwrap_or(digits))
        .unwrap_or(digits);
    if digits.is_empty() {
        return None;
    }

    let mut parsed: u128 = 0;
    let mut previous_was_underscore = true;
    for character in digits.chars() {
        if character == '_' {
            // Ni en tête, ni doublé : c'est la règle des littéraux Python.
            if previous_was_underscore {
                return None;
            }
            previous_was_underscore = true;
            continue;
        }
        let digit = character.to_digit(16)?;
        parsed = parsed.checked_mul(16)?.checked_add(u128::from(digit))?;
        previous_was_underscore = false;
    }
    // Un `_` final laisse `previous_was_underscore` vrai, comme un champ vide.
    (!previous_was_underscore).then_some(parsed)
}

/// Chiffres Nd d'Unicode 16.0, base utilisée par l'oracle CPython 3.14.
/// Chaque zéro commence une suite contiguë de dix chiffres. Les autres nombres
/// Unicode (ex. exposants, fractions) ne sont pas des chiffres pour int().
/// Table reproductible : unicodedata.decimal(chr(cp), None) == 0.
fn python_decimal_digit(character: char) -> Option<u32> {
    if character.is_ascii() {
        return character.to_digit(10);
    }
    const ZEROES: &[u32] = &[
        0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
        0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
        0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
        0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450,
        0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50,
        0x11d50, 0x11da0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce,
        0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
    ];
    let codepoint = u32::from(character);
    let index = ZEROES
        .partition_point(|zero| *zero <= codepoint)
        .checked_sub(1)?;
    let digit = codepoint - ZEROES[index];
    (digit < 10).then_some(digit)
}
