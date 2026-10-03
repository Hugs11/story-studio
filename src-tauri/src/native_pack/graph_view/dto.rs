//! Le DTO fermé et versionné de la lecture avancée.
//!
//! Il est **indépendant du moteur d'affichage** : aucun champ, aucun nom et
//! aucune convention d'identité ne vient de Cytoscape.js, d'AntV G6 ou d'un
//! repli maison, de sorte que changer de moteur reste abordable.
//!
//! Il est aussi une **projection** : rien ici n'est réémis vers
//! le document, rien n'est persisté, et aucune valeur de confort ne remplace
//! une valeur d'auteur absente.

use serde::Serialize;

use crate::native_pack::authoring::{AuthoringDiagnosticLevel, AuthoringResolution};
use crate::native_pack::dialect::{DiagnosticSeverity, DocumentOrigin, ValueOrigin};
use crate::native_pack::option_selection::OptionSelection;
use crate::native_pack::presence::Presence;

/// Version **de transport** du DTO. Elle n'est jamais écrite sur disque ni relue
/// d'un fichier : un `.mbah` ne la porte pas.
pub(crate) const GRAPH_VIEW_VERSION: u32 = 1;

/// Les trois états du dialecte, rendus distinctement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PresenceKind {
    Absent,
    Null,
    Value,
}

impl PresenceKind {
    pub(crate) fn of<T>(presence: &Presence<T>) -> Self {
        match presence {
            Presence::Absent => PresenceKind::Absent,
            Presence::Null => PresenceKind::Null,
            Presence::Value(_) => PresenceKind::Value,
        }
    }
}

/// Un champ présence-sensible : l'absence et `null` ne sont jamais rendus par
/// la même forme, et `value` reste `null` dans les deux cas.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresenceView<T> {
    pub(crate) presence: PresenceKind,
    pub(crate) value: Option<T>,
}

impl<T: Clone> PresenceView<T> {
    pub(crate) fn of(presence: &Presence<T>) -> Self {
        Self {
            presence: PresenceKind::of(presence),
            value: presence.value().cloned(),
        }
    }
}

/// Une position, dans les deux représentations, numérique et texte.
///
/// `x`/`y` servent au rangement et au rendu ; `xText`/`yText` sont la graphie
/// exacte produite par `serde_json`, celle qu'un inspecteur affiche.
/// `exactInDouble:false` signale l'entier source hors du domaine sûr de
/// JavaScript : aucun consommateur n'a alors le droit de présenter `x` comme
/// la valeur d'auteur.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PositionView {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) x_text: String,
    pub(crate) y_text: String,
    pub(crate) exact_in_double: bool,
}

/// D'où vient la position d'affichage effectivement retenue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LayoutSource {
    /// Rang 1 — `document.*Nodes[].position`, donnée d'auteur.
    Authored,
    /// Rang 2 — `context.editorPositions`, disposition dérivée déjà rangée.
    EditorPosition,
    /// Rang 3 — placement de secours déterministe, jamais écrit nulle part.
    Fallback,
}

/// La position d'affichage résolue. Elle ne devient une donnée d'auteur que par
/// un geste explicite (`apply_editor_position_to_authoring`), jamais par la
/// lecture.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayoutView {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) source: LayoutSource,
    pub(crate) origin: Option<ValueOrigin>,
}

/// La sélection d'option d'une transition, rendue comme le concept sémantique
/// qu'elle est : jamais un entier signé qu'un consommateur pourrait rabattre
/// vers `0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum SelectionView {
    Random,
    Fixed { index: usize },
}

impl SelectionView {
    pub(crate) fn of(selection: OptionSelection) -> Self {
        match selection {
            OptionSelection::Random => SelectionView::Random,
            OptionSelection::Fixed(index) => SelectionView::Fixed { index },
        }
    }
}

/// Une transition OK ou HOME d'un Écran.
///
/// `actionPath: null` désigne une Action introuvable ; `withinBounds` répond à
/// la seule question « la sélection désigne-t-elle une option existante ? ».
/// Les deux faits restent lisibles séparément : une Action absente et une
/// sélection hors bornes ne sont pas confondues, elles sont portées par deux
/// champs distincts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransitionView {
    pub(crate) presence: PresenceKind,
    pub(crate) action_id: Option<String>,
    pub(crate) action_path: Option<String>,
    pub(crate) selection: Option<SelectionView>,
    pub(crate) within_bounds: bool,
    pub(crate) selected_option_id: Option<String>,
    pub(crate) resolved_stage_path: Option<String>,
}

impl TransitionView {
    /// La forme d'une transition sans valeur : elle ne porte ni cible de
    /// confort, ni sélection implicite.
    pub(crate) fn without_value(presence: PresenceKind) -> Self {
        Self {
            presence,
            action_id: None,
            action_path: None,
            selection: None,
            within_bounds: false,
            selected_option_id: None,
            resolved_stage_path: None,
        }
    }
}

/// Les cinq contrôles d'un Écran. Un contrôle absent n'est pas rendu comme
/// `false`, et aucun booléen n'est joint à une transition — les deux
/// informations restent côte à côte.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlsView {
    pub(crate) presence: PresenceKind,
    pub(crate) wheel: PresenceView<bool>,
    pub(crate) ok: PresenceView<bool>,
    pub(crate) home: PresenceView<bool>,
    pub(crate) pause: PresenceView<bool>,
    pub(crate) autoplay: PresenceView<bool>,
    /// `ControlSettings::is_complete` — la seule forme autorisée
    /// en sortie de pack.
    pub(crate) complete: bool,
}

/// Un emplacement média, **par référence**. Le DTO ne porte ni chemin disque,
/// ni octets, ni vignette : le chemin vit dans `authoring.mediaBindings`, que
/// JavaScript possède déjà, et la jointure se fait par `assetRef`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSlotView {
    pub(crate) presence: PresenceKind,
    pub(crate) asset_ref: Option<String>,
}

impl MediaSlotView {
    pub(crate) fn of(presence: &Presence<String>) -> Self {
        Self {
            presence: PresenceKind::of(presence),
            asset_ref: presence.value().cloned(),
        }
    }
}

/// La provenance des trois valeurs qu'un inspecteur doit pouvoir qualifier.
///
/// Les deux collections n'ont pas le même champ d'identité — `uuid` pour un
/// Écran, `id` pour une Action — et le dépôt enregistre leurs provenances sous
/// ces deux clés exactement (`imported_fs`). Les rendre sous une clé commune
/// obligerait le consommateur à traduire un nom de champ d'auteur, ce qui lui
/// est interdit : un chemin est un jeton opaque.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StageProvenanceView {
    pub(crate) uuid: ValueOrigin,
    pub(crate) name: ValueOrigin,
    pub(crate) position: ValueOrigin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionProvenanceView {
    pub(crate) id: ValueOrigin,
    pub(crate) name: ValueOrigin,
    pub(crate) position: ValueOrigin,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StageView {
    pub(crate) path: String,
    /// Couleur de présentation Story Studio, hors dialecte exporté.
    pub(crate) personal_color: Option<String>,
    /// Graphie source, jamais normalisée.
    pub(crate) uuid: String,
    pub(crate) occurrence: usize,
    /// `false` ⇒ les gestes adressés par identifiant refuseront. L'UI explique
    /// le refus **avant** de proposer le geste, au lieu de l'essuyer après coup.
    pub(crate) unique_id: bool,
    pub(crate) name: PresenceView<String>,
    /// Repli d'affichage historique, exposé **à côté** de la présence d'auteur :
    /// il ne crée aucune présence et ne ressort jamais à la sérialisation.
    pub(crate) fallback_label: String,
    pub(crate) stage_type: PresenceView<String>,
    pub(crate) square_one: PresenceView<bool>,
    pub(crate) group_id: PresenceView<String>,
    pub(crate) controls: ControlsView,
    pub(crate) audio: MediaSlotView,
    pub(crate) image: MediaSlotView,
    pub(crate) ok_transition: TransitionView,
    pub(crate) home_transition: TransitionView,
    /// Position d'auteur brute, non arrondie, exposée même quand `layout` la
    /// reprend : la vue doit rester fidèle au document source.
    pub(crate) source_position: Option<PositionView>,
    pub(crate) layout: LayoutView,
    pub(crate) provenance: StageProvenanceView,
}

/// Une occurrence d'option — le point le plus sensible de l'adressage.
///
/// `ordinal` est l'ordre **sémantique** des options, pas une identité de nœud.
/// Deux occurrences visant le même Écran produisent deux `OptionView` distincts
/// et deux arêtes distinctes : **aucune déduplication par couple source/cible
/// n'est permise**.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OptionView {
    pub(crate) option_id: String,
    pub(crate) ordinal: usize,
    pub(crate) target: OptionTargetView,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OptionTargetView {
    /// Un élément de tableau n'est jamais absent, mais il peut être `null`.
    pub(crate) presence: PresenceKind,
    pub(crate) stage_uuid: Option<String>,
    pub(crate) stage_path: Option<String>,
    pub(crate) dangling: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionView {
    pub(crate) path: String,
    /// Couleur de présentation Story Studio, hors dialecte exporté.
    pub(crate) personal_color: Option<String>,
    pub(crate) id: String,
    pub(crate) occurrence: usize,
    pub(crate) unique_id: bool,
    pub(crate) name: PresenceView<String>,
    pub(crate) fallback_label: String,
    pub(crate) action_type: PresenceView<String>,
    pub(crate) group_id: PresenceView<String>,
    pub(crate) options: Vec<OptionView>,
    pub(crate) source_position: Option<PositionView>,
    pub(crate) layout: LayoutView,
    pub(crate) provenance: ActionProvenanceView,
}

/// `stage-ok` / `stage-home` vont d'un Écran vers une **Action** ;
/// `action-option` d'une Action vers un Écran. Conséquence directe :
/// le partage d'une Action est visible comme convergence d'arêtes, et une
/// boucle reste une boucle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EdgeKind {
    StageOk,
    StageHome,
    ActionOption,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EdgeView {
    pub(crate) edge_id: String,
    pub(crate) kind: EdgeKind,
    pub(crate) from: String,
    pub(crate) to: Option<String>,
    pub(crate) option_id: Option<String>,
    pub(crate) ordinal: Option<usize>,
    pub(crate) selection: Option<SelectionView>,
    pub(crate) dangling: bool,
}

/// Un usage d'une référence média. `usages` existe parce que remplacer le fichier
/// d'une référence affecte tous ses écrans, et l'UI doit les montrer **avant**
/// le geste.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaField {
    Audio,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaUsageView {
    pub(crate) node_path: String,
    pub(crate) field: MediaField,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRefView {
    pub(crate) asset_ref: String,
    pub(crate) usages: Vec<MediaUsageView>,
}

/// Le marqueur de groupe est transporté et montré, jamais interprété : aucun
/// groupe n'est transformé en Menu ou en Histoire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GroupKindView {
    Story,
    Menu,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupView {
    pub(crate) group_id: String,
    pub(crate) kind: GroupKindView,
    pub(crate) stage_paths: Vec<String>,
    pub(crate) action_paths: Vec<String>,
}

/// Un membre opaque, rendu en **lecture** seulement.
///
/// `valuePreview` est une représentation bornée à 160 caractères, jamais
/// l'objet d'origine : le DTO ne rend pas une valeur opaque sous une forme que
/// l'appelant pourrait réémettre comme vérité d'auteur. La seule porte
/// d'écriture reste `set_opaque_export_disposition`, en Rust.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpaqueMemberView {
    pub(crate) path: String,
    pub(crate) node_path: Option<String>,
    pub(crate) scope: crate::native_pack::dialect::ExtensionScope,
    pub(crate) key: String,
    /// L'occurrence source du membre, seule façon de distinguer deux valeurs
    /// portant le même chemin et la même clé.
    ///
    /// `set_opaque_export_disposition` adresse un membre par le triplet
    /// `(path, key, source_occurrence)` : sans ce champ, une interface qui lit
    /// ce DTO n'aurait que `0` à proposer, et poserait donc silencieusement la
    /// décision sur la première occurrence au lieu de celle que l'auteur
    /// regarde. Le champ est en lecture seule, comme tout le reste du DTO.
    pub(crate) source_occurrence: usize,
    pub(crate) kind: crate::native_pack::dialect::OpaqueMemberKind,
    pub(crate) origin: ValueOrigin,
    pub(crate) value_preview: String,
    pub(crate) truncated: bool,
    pub(crate) disposition: Option<crate::native_pack::dialect::OpaqueExportDisposition>,
    pub(crate) disposition_stale: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DiagnosticFamily {
    GraphIntegrity,
    Authoring,
    Import,
}

/// `nodePath` est le préfixe de nœud calculé côté Rust : l'UI groupe les
/// diagnostics par nœud sans jamais découper un chemin d'auteur en JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticView {
    pub(crate) family: DiagnosticFamily,
    pub(crate) level: Option<AuthoringDiagnosticLevel>,
    pub(crate) severity: Option<DiagnosticSeverity>,
    pub(crate) code: String,
    pub(crate) path: String,
    pub(crate) node_path: Option<String>,
    pub(crate) message: String,
    pub(crate) resolutions: Vec<AuthoringResolution>,
}

/// L'Écran d'entrée. Un document valide a exactement un `squareOne` ; la lecture
/// montre les trois cas au lieu d'en choisir un.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum EntryStatus {
    Unique,
    Missing,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryView {
    pub(crate) status: EntryStatus,
    pub(crate) stage_path: Option<String>,
    pub(crate) candidates: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountsView {
    pub(crate) stages: usize,
    pub(crate) actions: usize,
    pub(crate) options: usize,
    pub(crate) edges: usize,
}

/// Les métadonnées de tête du document, telles que l'auteur les a laissées.
///
/// Elles sont projetées **présence comprise** : un titre absent n'est pas un
/// titre vide, et une version absente n'est pas la version 1. Sans cette
/// distinction, un formulaire commun aux deux éditeurs afficherait comme valeur
/// d'auteur un repli qu'il vient d'inventer — exactement ce qu'il faut
/// éviter, et ce que la fiche du pack faisait côté Libre en comptant un arbre
/// absent comme zéro histoire.
///
/// Ce qu'elles deviennent à l'export dépend de l'origine du document et n'est
/// pas décidé ici : `apply_required_standard_shape` impose la version et
/// l'identité d'un document créé, et laisse celles d'un document importé. Le
/// consommateur lit donc `documentOrigin` à côté pour savoir quel champ est
/// réellement gouverné par l'auteur.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentMetadataView {
    pub(crate) title: PresenceView<String>,
    pub(crate) version: PresenceView<i32>,
    pub(crate) description: PresenceView<String>,
    /// La racine `uuid` du dialecte, **non autoritaire**. Elle
    /// n'est pas la `packIdentity`, projetée à côté : les confondre ferait
    /// afficher un identifiant qui n'est pas celui de la production.
    pub(crate) uuid: PresenceView<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackIdentityView {
    pub(crate) origin: crate::native_pack::dialect::PackIdentityOrigin,
    pub(crate) value: Option<String>,
    pub(crate) short_identity: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) unresolved_reason: Option<String>,
    pub(crate) generation_reason: Option<String>,
}

/// La vue complète. Le graphe y est **entier** : les nœuds détachés, les
/// boucles, les Actions partagées et les options répétées y figurent, parce que
/// la projection énumère les collections au lieu de parcourir depuis l'entrée.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvancedGraphView {
    pub(crate) view_version: u32,
    /// Empreinte des octets exacts du payload lu.
    ///
    /// Elle est rendue **ici** plutôt que recalculée à chaque écriture de vue :
    /// faire traverser le payload à l'IPC toutes les 800 ms pendant un
    /// panoramique serait exactement le coût que le protocole de charge
    /// interdit. JavaScript la traite comme un jeton opaque, au même
    /// titre qu'un chemin d'auteur.
    pub(crate) document_fingerprint: String,
    pub(crate) document_origin: DocumentOrigin,
    pub(crate) default_value_origin: ValueOrigin,
    pub(crate) pack_identity: PackIdentityView,
    pub(crate) metadata: DocumentMetadataView,
    pub(crate) entry: EntryView,
    pub(crate) counts: CountsView,
    pub(crate) stages: Vec<StageView>,
    pub(crate) actions: Vec<ActionView>,
    pub(crate) edges: Vec<EdgeView>,
    pub(crate) media_refs: Vec<MediaRefView>,
    pub(crate) groups: Vec<GroupView>,
    pub(crate) opaque_members: Vec<OpaqueMemberView>,
    pub(crate) diagnostics: Vec<DiagnosticView>,
}
