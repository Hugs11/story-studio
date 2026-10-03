//! La matrice de compatibilité des passerelles, sous forme de catalogue
//! exécutable.
//!
//! Toute qualification globale doit être explicable et testable **ligne à
//! ligne** contre cette matrice. Une table recopiée en prose ne le permettrait
//! pas : la couverture serait affirmée, jamais vérifiée. Chaque ligne de la
//! matrice est donc une variante de `ContractLine`, porteuse de son libellé, de
//! sa preuve et de son **traitement** — ce qui décide si elle alimente
//! `dimensions`, un refus, ou un diagnostic de fidélité seul.
//!
//! La matrice compte **31 lignes de données**.
//!
//! Quatre traitements, et quatre seulement :
//!
//! - `Dimension` — ligne d'interopérabilité qualifiable, qui produit une entrée
//!   `dimensions` avec son `evidence`, ou une entrée `unevaluated` ;
//! - `DecodeRefusal` — ligne `INVALID` refusée par le décodeur de dialecte ;
//! - `IntegrityRefusal` — ligne `INVALID` refusée par les contrôles d'intégrité du graphe ;
//! - `FidelityDiagnostic` — les trois lignes `—`, qui ne contribuent **pas** à
//!   l'agrégat mais contribuent à `blocked`.
//!
//! `INVALID` n'entre jamais dans l'énumération à trois qualifications : c'est un
//! refus, pas une qualification d'interopérabilité.

use serde::Serialize;

use super::DimensionQualification;

/// Ce qu'une ligne de la matrice produit dans la readiness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum LineTreatment {
    /// Ligne d'interopérabilité, qualifiée par cette dimension.
    Dimension { id: DimensionId },
    /// Ligne `INVALID` : le dialecte refuse la forme avant tout classificateur.
    DecodeRefusal,
    /// Ligne `INVALID` : `validate_graph_document_integrity` refuse le graphe.
    IntegrityRefusal,
    /// Ligne `—` : diagnostic de fidélité seul, hors agrégat, mais bloquant ou
    /// informatif selon son niveau.
    FidelityDiagnostic,
}

/// Les dimensions d'interopérabilité qualifiables de la matrice.
///
/// Une dimension peut couvrir plusieurs lignes voisines qui décrivent le même
/// prédicat à des valeurs différentes — la largeur de roue, la graphie d'un
/// identifiant de Stage. La qualification retenue reste alors la plus faible
/// des lignes réellement exercées, et chaque ligne garde son `evidence` propre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DimensionId {
    GraphTopology,
    FixedOptionSelection,
    RandomOptionSelection,
    WheelWidth,
    StageWithoutMedia,
    ReachabilityAndControlProfiles,
    ControlSettingsCompleteness,
    StageIdGraphie,
    ActionIdGraphie,
    SquareOneOrder,
    PackIdentity,
    RootUuidProvenance,
    StudioExportVersion,
    KnownOptionalOmissions,
    FractionalPosition,
    SourcePositionOutOfShortRange,
    EnrichedGroupFidelity,
    FactoryDisabled,
    UnknownExtension,
    KnownRootDuplicate,
}

impl DimensionId {
    pub(crate) const ALL: [DimensionId; 20] = [
        DimensionId::GraphTopology,
        DimensionId::FixedOptionSelection,
        DimensionId::RandomOptionSelection,
        DimensionId::WheelWidth,
        DimensionId::StageWithoutMedia,
        DimensionId::ReachabilityAndControlProfiles,
        DimensionId::ControlSettingsCompleteness,
        DimensionId::StageIdGraphie,
        DimensionId::ActionIdGraphie,
        DimensionId::SquareOneOrder,
        DimensionId::PackIdentity,
        DimensionId::RootUuidProvenance,
        DimensionId::StudioExportVersion,
        DimensionId::KnownOptionalOmissions,
        DimensionId::FractionalPosition,
        DimensionId::SourcePositionOutOfShortRange,
        DimensionId::EnrichedGroupFidelity,
        DimensionId::FactoryDisabled,
        DimensionId::UnknownExtension,
        DimensionId::KnownRootDuplicate,
    ];

    /// Les lignes de la matrice que cette dimension explique. Dérivé du catalogue :
    /// aucune seconde liste ne peut diverger de la première.
    pub(crate) fn lines(self) -> impl Iterator<Item = ContractLine> {
        ContractLine::ALL
            .into_iter()
            .filter(move |line| line.treatment() == LineTreatment::Dimension { id: self })
    }
}

/// Les 31 lignes de données de la matrice, dans l'ordre de la table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ContractLine {
    GraphTopology,
    OrderedWheelFixedSelection,
    RandomSelection,
    OptionIndexBelowMinusOne,
    IncompleteTransition,
    UnsatisfiableSelection,
    WheelUpToOneHundred,
    WheelBeyondOneHundred,
    StageWithoutMedia,
    ReachabilityAndControlProfiles,
    IncompleteControlSettings,
    MalformedControlSettings,
    CanonicalStageId,
    HyphenlessStageId,
    UnparsableStageId,
    NonUuidActionId,
    SquareOneNotFirst,
    ProjectedPackIdentity,
    DivergentRootUuid,
    ProjectedVersion256,
    KnownOptionalOmissions,
    FractionalSourcePosition,
    SourcePositionOutOfShortRange,
    AuthoredPositionOutOfShortRange,
    EnrichedGroupFidelity,
    FactoryDisabled,
    UnknownExtension,
    KnownRootDuplicate,
    DanglingReferenceOrSquareOneCount,
    OrphanActionWithAuthoredContent,
    EmptyOrphanScaffold,
}

impl ContractLine {
    pub(crate) const ALL: [ContractLine; 31] = [
        ContractLine::GraphTopology,
        ContractLine::OrderedWheelFixedSelection,
        ContractLine::RandomSelection,
        ContractLine::OptionIndexBelowMinusOne,
        ContractLine::IncompleteTransition,
        ContractLine::UnsatisfiableSelection,
        ContractLine::WheelUpToOneHundred,
        ContractLine::WheelBeyondOneHundred,
        ContractLine::StageWithoutMedia,
        ContractLine::ReachabilityAndControlProfiles,
        ContractLine::IncompleteControlSettings,
        ContractLine::MalformedControlSettings,
        ContractLine::CanonicalStageId,
        ContractLine::HyphenlessStageId,
        ContractLine::UnparsableStageId,
        ContractLine::NonUuidActionId,
        ContractLine::SquareOneNotFirst,
        ContractLine::ProjectedPackIdentity,
        ContractLine::DivergentRootUuid,
        ContractLine::ProjectedVersion256,
        ContractLine::KnownOptionalOmissions,
        ContractLine::FractionalSourcePosition,
        ContractLine::SourcePositionOutOfShortRange,
        ContractLine::AuthoredPositionOutOfShortRange,
        ContractLine::EnrichedGroupFidelity,
        ContractLine::FactoryDisabled,
        ContractLine::UnknownExtension,
        ContractLine::KnownRootDuplicate,
        ContractLine::DanglingReferenceOrSquareOneCount,
        ContractLine::OrphanActionWithAuthoredContent,
        ContractLine::EmptyOrphanScaffold,
    ];

    /// Le rang de la ligne dans la table, à partir de 1. Dérivé de `ALL`, qui
    /// suit l'ordre de la matrice.
    pub(crate) fn row(self) -> usize {
        Self::ALL
            .iter()
            .position(|line| *line == self)
            .expect("chaque ligne appartient au catalogue")
            + 1
    }

    /// La colonne « État / construct » de la matrice.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::GraphTopology => "Cycle, self-loops, convergence, Action partagé, HOME==OK",
            Self::OrderedWheelFixedSelection => "Roue ordonnée ; Fixed(i) in-bounds",
            Self::RandomSelection => "Random=-1 OK / HOME",
            Self::OptionIndexBelowMinusOne => "optionIndex < -1",
            Self::IncompleteTransition => "Transition présente sans actionNode ou optionIndex",
            Self::UnsatisfiableSelection => "Random vers Action vide ; Fixed hors bornes",
            Self::WheelUpToOneHundred => "Roue 48 / 100",
            Self::WheelBeyondOneHundred => "Roue >100",
            Self::StageWithoutMedia => "Stage sans image/audio",
            Self::ReachabilityAndControlProfiles => {
                "Composante inatteignable ; 32 profils contrôle ; contrôle désactivé + transition"
            }
            Self::IncompleteControlSettings => {
                "Objet de contrôles incomplet en entrée (partiel, absent, null, membre null)"
            }
            Self::MalformedControlSettings => {
                "Membre de contrôle non booléen, ou controlSettings non objet"
            }
            Self::CanonicalStageId => "Stage ID UUID canonique",
            Self::HyphenlessStageId => "Stage ID hexadécimal sans tirets, parsable UUID",
            Self::UnparsableStageId => "Stage ID non parsable",
            Self::NonUuidActionId => "Action ID non-UUID (action-N)",
            Self::SquareOneNotFirst => "squareOne pas index 0",
            Self::ProjectedPackIdentity => "packIdentity projetée",
            Self::DivergentRootUuid => "Root uuid divergente",
            Self::ProjectedVersion256 => "version:256 issue d'une projection FS",
            Self::KnownOptionalOmissions => "Omissions optionnelles connues",
            Self::FractionalSourcePosition => "Position source fractionnaire",
            Self::SourcePositionOutOfShortRange => "Position source hors short",
            Self::AuthoredPositionOutOfShortRange => "Position créée par Story Studio hors short",
            Self::EnrichedGroupFidelity => "Groupe enrichi / Action.type fidélité",
            Self::FactoryDisabled => "factoryDisabled",
            Self::UnknownExtension => "Extension inconnue, quel que soit le niveau",
            Self::KnownRootDuplicate => "Doublon racine connu",
            Self::DanglingReferenceOrSquareOneCount => "Référence pendante ; 0/>1 squareOne",
            Self::OrphanActionWithAuthoredContent => "Action orpheline avec contenu authored",
            Self::EmptyOrphanScaffold => "Scaffold Action strictement vide",
        }
    }

    /// La colonne « Preuve / portée » de la matrice. C'est elle qui borne une
    /// qualification : une mesure ne s'étend jamais au-delà des fixtures et des
    /// versions figées qui l'ont produite.
    pub(crate) fn proof(self) -> &'static str {
        match self {
            Self::GraphTopology => "Famille de tests de topologie du graphe.",
            Self::OrderedWheelFixedSelection => "Tests de sélection fixe et de roue ordonnée.",
            Self::RandomSelection => "corpus et test de sélection aléatoire.",
            Self::OptionIndexBelowMinusOne => "hors modèle OptionSelection.",
            Self::IncompleteTransition => {
                "non représentable ; 0/178 869 observées, règle préventive."
            }
            Self::UnsatisfiableSelection => "aucun candidat / aucune option désignée.",
            Self::WheelUpToOneHundred => "Tests de roue jusqu'à cent options.",
            Self::WheelBeyondOneHundred => {
                "aucune capacité démontrée >100. Le plafond signé 32 bits n'est qu'une borne de représentation."
            }
            Self::StageWithoutMedia => "Tests d'Écran sans média, clés standard null.",
            Self::ReachabilityAndControlProfiles => "Tests d'accessibilité et de profils de contrôles ; corpus.",
            Self::IncompleteControlSettings => {
                "Règle des contrôles ; 0/366 dans la bibliothèque, clause préventive."
            }
            Self::MalformedControlSettings => {
                "Règle des contrôles ; forme non représentable, aucun cast implicite."
            }
            Self::CanonicalStageId => "surface dominante.",
            Self::HyphenlessStageId => "8 packs de référence + 14 de la bibliothèque ; vérification de lecture ; 16 sorties FS contrôlées.",
            Self::UnparsableStageId => "Test d'identifiant illisible + 2 exemples réels d'entrée dans la bibliothèque.",
            Self::NonUuidActionId => {
                "22 718/27 631, 71/71 fsPack, 142 conversions ; Lunii.QT résout par chaîne."
            }
            Self::SquareOneNotFirst => "Tests de l'Écran d'entrée hors de la première place.",
            Self::ProjectedPackIdentity => "Tests d'identité de pack projetée.",
            Self::DivergentRootUuid => "Test d'uuid de racine divergent.",
            Self::ProjectedVersion256 => {
                "provenance et interprétation little-endian établies par reader/writer FS STUdio ; story.json version:256 jamais soumis aux passerelles."
            }
            Self::KnownOptionalOmissions => "Tests d'omissions optionnelles connues.",
            Self::FractionalSourcePosition => {
                "836 positions/20 packs de référence testés par passerelle ; 2 197/31 dans bibliothèque."
            }
            Self::SourcePositionOutOfShortRange => {
                "29 coordonnées/1 studioPack hors packs de référence ; STUdio conversion short, Lunii.QT ignore."
            }
            Self::AuthoredPositionOutOfShortRange => {
                "interdiction de créer silencieusement une perte connue."
            }
            Self::EnrichedGroupFidelity => "perte actuelle connue.",
            Self::FactoryDisabled => "consommateurs figés l'ignorent.",
            Self::UnknownExtension => "Règle des extensions ; exemples réels fournis.",
            Self::KnownRootDuplicate => {
                "comportement des deux parseurs établi, pas fixture conversion."
            }
            Self::DanglingReferenceOrSquareOneCount => "GVI + lectures consommateurs.",
            Self::OrphanActionWithAuthoredContent => "Test d'Action orpheline : supprimée silencieusement.",
            Self::EmptyOrphanScaffold => "aucune information authored significative à perdre.",
        }
    }

    /// Le traitement de la ligne. C'est le seul endroit qui décide qu'une ligne
    /// alimente l'agrégat, un refus, ou un diagnostic de fidélité seul.
    pub(crate) fn treatment(self) -> LineTreatment {
        let dimension = |id| LineTreatment::Dimension { id };
        match self {
            Self::GraphTopology => dimension(DimensionId::GraphTopology),
            Self::OrderedWheelFixedSelection => dimension(DimensionId::FixedOptionSelection),
            Self::RandomSelection => dimension(DimensionId::RandomOptionSelection),
            Self::WheelUpToOneHundred | Self::WheelBeyondOneHundred => {
                dimension(DimensionId::WheelWidth)
            }
            Self::StageWithoutMedia => dimension(DimensionId::StageWithoutMedia),
            Self::ReachabilityAndControlProfiles => {
                dimension(DimensionId::ReachabilityAndControlProfiles)
            }
            Self::IncompleteControlSettings => dimension(DimensionId::ControlSettingsCompleteness),
            Self::CanonicalStageId | Self::HyphenlessStageId | Self::UnparsableStageId => {
                dimension(DimensionId::StageIdGraphie)
            }
            Self::NonUuidActionId => dimension(DimensionId::ActionIdGraphie),
            Self::SquareOneNotFirst => dimension(DimensionId::SquareOneOrder),
            Self::ProjectedPackIdentity => dimension(DimensionId::PackIdentity),
            Self::DivergentRootUuid => dimension(DimensionId::RootUuidProvenance),
            Self::ProjectedVersion256 => dimension(DimensionId::StudioExportVersion),
            Self::KnownOptionalOmissions => dimension(DimensionId::KnownOptionalOmissions),
            Self::FractionalSourcePosition => dimension(DimensionId::FractionalPosition),
            Self::SourcePositionOutOfShortRange => {
                dimension(DimensionId::SourcePositionOutOfShortRange)
            }
            Self::EnrichedGroupFidelity => dimension(DimensionId::EnrichedGroupFidelity),
            Self::FactoryDisabled => dimension(DimensionId::FactoryDisabled),
            Self::UnknownExtension => dimension(DimensionId::UnknownExtension),
            Self::KnownRootDuplicate => dimension(DimensionId::KnownRootDuplicate),

            // `INVALID` refusé par le dialecte, avant tout classificateur.
            Self::OptionIndexBelowMinusOne
            | Self::IncompleteTransition
            | Self::MalformedControlSettings => LineTreatment::DecodeRefusal,

            // `INVALID` refusé par GVI.
            Self::UnsatisfiableSelection | Self::DanglingReferenceOrSquareOneCount => {
                LineTreatment::IntegrityRefusal
            }

            // Les trois lignes `—` : hors agrégat, dans `blocked` ou en INFO.
            Self::AuthoredPositionOutOfShortRange
            | Self::OrphanActionWithAuthoredContent
            | Self::EmptyOrphanScaffold => LineTreatment::FidelityDiagnostic,
        }
    }

    /// La qualification que la matrice fixe déjà pour cette ligne, quand elle en
    /// porte une. Elle n'est jamais recalculée : une ligne dont la valeur est
    /// fixée ne se requalifie pas depuis le document.
    pub(crate) fn contract_qualification(self) -> Option<DimensionQualification> {
        use DimensionQualification::{Prepared, Supported, Untested};
        Some(match self {
            Self::GraphTopology
            | Self::OrderedWheelFixedSelection
            | Self::RandomSelection
            | Self::WheelUpToOneHundred
            | Self::StageWithoutMedia
            | Self::ReachabilityAndControlProfiles
            | Self::CanonicalStageId
            | Self::HyphenlessStageId
            | Self::NonUuidActionId
            | Self::DivergentRootUuid
            | Self::KnownOptionalOmissions
            | Self::FractionalSourcePosition => Supported,

            Self::UnparsableStageId | Self::SquareOneNotFirst | Self::ProjectedPackIdentity => {
                Prepared
            }

            Self::WheelBeyondOneHundred
            | Self::IncompleteControlSettings
            | Self::ProjectedVersion256
            | Self::SourcePositionOutOfShortRange
            | Self::EnrichedGroupFidelity
            | Self::FactoryDisabled
            | Self::UnknownExtension
            | Self::KnownRootDuplicate => Untested,

            // Refus et lignes `—` : aucune qualification d'interopérabilité.
            Self::OptionIndexBelowMinusOne
            | Self::IncompleteTransition
            | Self::UnsatisfiableSelection
            | Self::MalformedControlSettings
            | Self::AuthoredPositionOutOfShortRange
            | Self::DanglingReferenceOrSquareOneCount
            | Self::OrphanActionWithAuthoredContent
            | Self::EmptyOrphanScaffold => return None,
        })
    }
}
