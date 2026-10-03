//! `assess_graph_document_export_readiness` — le point d'agrégation unique et
//! **non mutateur** de la readiness d'export.
//!
//! Il observe ; il ne prépare ni ne corrige rien. Il agrège décodage et GVI,
//! diagnostics enrichis, fidélité présence-sensible et numérique, extensions
//! inconnues à tous niveaux, diagnostics d'authoring, `packIdentity` — et
//! **les prédicats de la matrice de compatibilité uniquement**.
//!
//! Trois propriétés structurent ce module, dans cet ordre d'importance :
//!
//! 1. **Aucun faux `SUPPORTED`.** Toute dimension pertinente non observable
//!    part dans `unevaluated`, et toute entrée `unevaluated` contribue
//!    `UNTESTED`. Un agrégat sans aucune dimension évaluée est `UNTESTED` : une
//!    explication vide ne justifie pas une qualification haute.
//! 2. **Explicable ligne à ligne.** Chaque `EvidenceRef` nomme la ligne de la matrice
//!    qu'elle exerce et porte sa propre qualification ; celle de la dimension
//!    est la plus faible de ses preuves. La couverture n'est pas racontée, elle
//!    est calculée.
//! 3. **Deux couches distinctes.** Une dimension runtime peut rester
//!    `SUPPORTED` alors qu'un risque de perte authored pose `ACTION_REQUIRED`
//!    et donc `blocked=true`. L'Action orpheline à contenu d'auteur en est le cas de
//!    référence.
//!
//! Le symbole `—` de la matrice n'est pas un cinquième statut : les trois lignes
//! concernées produisent un diagnostic de fidélité, contribuent à `blocked`, et
//! ne touchent jamais l'agrégat. `INVALID` non plus n'est pas une
//! qualification : c'est un refus de décodage ou de GVI.

mod contract;
mod observation;

use serde::Serialize;

use super::authoring::{AuthoringDiagnostic, AuthoringDiagnosticLevel};
use super::{
    DecodedStoryDocument, DiagnosticSeverity, GraphIntegrityError, ImportDiagnostic,
    StoryDecodeError,
};

pub(crate) use contract::{ContractLine, DimensionId};

/// Les trois qualifications d'interopérabilité.
///
/// L'ordre de déclaration **est** l'ordre de composition
/// `UNTESTED < PREPARED < SUPPORTED` : `Ord` dérivé le rend total et testable,
/// et `min` suffit alors à composer un agrégat sans règle recopiée ailleurs.
/// `INVALID` n'y figure pas volontairement — c'est un refus, pas une
/// qualification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum DimensionQualification {
    Untested,
    Prepared,
    Supported,
}

/// Une observation qui rattache une qualification à une ligne de la matrice.
///
/// `path` est le chemin d'auteur stable du nœud concerné, ou `/` pour une
/// propriété de racine ; `observation` dit ce qui a été vu dans ce document ;
/// `proof` recopie la portée que la matrice donne à cette ligne, pour qu'aucune
/// qualification ne circule sans sa borne de validité.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidenceRef {
    pub(crate) line: ContractLine,
    pub(crate) contract_row: usize,
    pub(crate) qualification: DimensionQualification,
    pub(crate) path: String,
    pub(crate) observation: String,
    pub(crate) proof: &'static str,
}

impl EvidenceRef {
    fn new(
        line: ContractLine,
        qualification: DimensionQualification,
        path: impl Into<String>,
        observation: impl Into<String>,
    ) -> Self {
        Self {
            line,
            contract_row: line.row(),
            qualification,
            path: path.into(),
            observation: observation.into(),
            proof: line.proof(),
        }
    }
}

/// Une dimension évaluée : sa qualification et les preuves qui l'expliquent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DimensionAssessment {
    pub(crate) id: DimensionId,
    pub(crate) qualification: DimensionQualification,
    pub(crate) evidence: Vec<EvidenceRef>,
}

/// Une dimension pertinente que ce payload ne permet pas d'observer. Elle
/// contribue `UNTESTED` et interdit donc tout `SUPPORTED` global.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnevaluatedDimension {
    pub(crate) id: DimensionId,
    pub(crate) lines: Vec<ContractLine>,
    pub(crate) reason: String,
}

/// Le niveau d'un diagnostic agrégé.
///
/// `Error` couvre les refus de décodage et de GVI, `ActionRequired` la décision
/// d'auteur non résolue : les deux bloquent. `Warning` et `Info` ne bloquent
/// jamais.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ReadinessDiagnosticLevel {
    Info,
    Warning,
    ActionRequired,
    Error,
}

/// Une observation produite par la couche de readiness elle-même, quand la
/// colonne « Readiness / fidélité » de la matrice en demande une qu'aucune couche
/// amont ne produit. Le seul cas est la provenance d'une racine `uuid`
/// divergente, que la matrice qualifie `SUPPORTED` **avec** un avertissement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadinessObservation {
    pub(crate) level: ReadinessDiagnosticLevel,
    pub(crate) code: String,
    pub(crate) path: String,
    pub(crate) message: String,
}

/// Un diagnostic agrégé, avec la couche qui l'a produit.
///
/// L'enveloppe conserve le type d'origine : la préparation peut refuser sur les
/// erreurs GVI exactes plutôt que sur des chaînes reconstruites, et les
/// diagnostics de décodage restent accessibles avec leur provenance même quand
/// le document est refusé.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "source", rename_all = "kebab-case")]
pub(crate) enum ReadinessDiagnostic {
    Decode(ImportDiagnostic),
    GraphIntegrity(GraphIntegrityError),
    Authoring(AuthoringDiagnostic),
    Readiness(ReadinessObservation),
}

impl ReadinessDiagnostic {
    pub(crate) fn level(&self) -> ReadinessDiagnosticLevel {
        match self {
            Self::Decode(diagnostic) => match diagnostic.severity {
                DiagnosticSeverity::Warning => ReadinessDiagnosticLevel::Warning,
                DiagnosticSeverity::Error => ReadinessDiagnosticLevel::Error,
            },
            Self::GraphIntegrity(_) => ReadinessDiagnosticLevel::Error,
            Self::Authoring(diagnostic) => match diagnostic.level {
                AuthoringDiagnosticLevel::Info => ReadinessDiagnosticLevel::Info,
                AuthoringDiagnosticLevel::Warning => ReadinessDiagnosticLevel::Warning,
                AuthoringDiagnosticLevel::ActionRequired => {
                    ReadinessDiagnosticLevel::ActionRequired
                }
            },
            Self::Readiness(observation) => observation.level,
        }
    }

    /// Erreur de décodage ou de GVI, ou `ACTION_REQUIRED` non
    /// résolu. `WARNING` et `INFO` ne bloquent pas, et `UNTESTED` ne bloque pas
    /// par sa seule nouveauté.
    pub(crate) fn blocks(&self) -> bool {
        matches!(
            self.level(),
            ReadinessDiagnosticLevel::ActionRequired | ReadinessDiagnosticLevel::Error
        )
    }

    pub(crate) fn code(&self) -> &str {
        match self {
            Self::Decode(diagnostic) => &diagnostic.code,
            Self::GraphIntegrity(error) => error.code.as_str(),
            Self::Authoring(diagnostic) => &diagnostic.code,
            Self::Readiness(observation) => &observation.code,
        }
    }

    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Decode(diagnostic) => &diagnostic.path,
            Self::GraphIntegrity(error) => &error.path,
            Self::Authoring(diagnostic) => &diagnostic.path,
            Self::Readiness(observation) => &observation.path,
        }
    }

    /// Le libellé de l'observation, symétrique de `code` et `path`.
    ///
    /// La traduction d'un blocage en refus n'en a pas besoin — elle transporte
    /// les diagnostics typés. Une **mesure** en a besoin : un relevé qui
    /// n'écrirait que `ORPHAN_ACTION_AUTHORED_CONTENT /stageNodes[12]` ne
    /// permettrait de trancher entre défaut du pack et règle trop stricte
    /// qu'en rouvrant le code.
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Decode(diagnostic) => &diagnostic.message,
            Self::GraphIntegrity(error) => &error.message,
            Self::Authoring(diagnostic) => &diagnostic.message,
            Self::Readiness(observation) => &observation.message,
        }
    }
}

/// La qualification d'export d'un document, explicable dimension par dimension.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportReadiness {
    pub(crate) blocked: bool,
    pub(crate) interoperability: DimensionQualification,
    pub(crate) dimensions: Vec<DimensionAssessment>,
    pub(crate) unevaluated: Vec<UnevaluatedDimension>,
    pub(crate) diagnostics: Vec<ReadinessDiagnostic>,
}

impl ExportReadiness {
    /// Les erreurs GVI typées, pour que la préparation refuse sur ces erreurs sans
    /// réexécuter le validateur ni reconstruire ses erreurs depuis du texte.
    pub(crate) fn integrity_errors(&self) -> impl Iterator<Item = &GraphIntegrityError> {
        self.diagnostics
            .iter()
            .filter_map(|diagnostic| match diagnostic {
                ReadinessDiagnostic::GraphIntegrity(error) => Some(error),
                _ => None,
            })
    }

    /// Les décisions d'auteur non résolues, typées, pour la même raison.
    pub(crate) fn blocking_authoring_diagnostics(
        &self,
    ) -> impl Iterator<Item = &AuthoringDiagnostic> {
        self.diagnostics
            .iter()
            .filter_map(|diagnostic| match diagnostic {
                ReadinessDiagnostic::Authoring(authoring)
                    if authoring.level == AuthoringDiagnosticLevel::ActionRequired =>
                {
                    Some(authoring)
                }
                _ => None,
            })
    }

    /// Les diagnostics de décodage conservés, y compris quand le document est
    /// refusé : ils doivent rester accessibles pour produire `blocked=true`
    /// sans qualification fictive.
    pub(crate) fn decode_diagnostics(&self) -> impl Iterator<Item = &ImportDiagnostic> {
        self.diagnostics
            .iter()
            .filter_map(|diagnostic| match diagnostic {
                ReadinessDiagnostic::Decode(decode) => Some(decode),
                _ => None,
            })
    }
}

/// Qualifie l'export d'un document d'auteur, ou l'absence de document.
///
/// L'entrée est le **résultat de décodage** lui-même, pas seulement son succès.
/// C'est ce qui rend impossible d'oublier un refus en chemin : un document
/// indécodable produit `blocked=true`, aucune dimension qualifiée, et
/// l'intégralité de la matrice en `unevaluated` — jamais un agrégat flatteur
/// calculé sur une représentation absente.
///
/// Le payload décodé est le couple document + contexte minimal — identité,
/// enveloppe opaque, provenance et dispositions — que la préparation reçoit
/// déjà ; la readiness ne définit ni fichier projet ni cycle de session.
///
/// La fonction est non mutatrice : elle n'accepte que des références partagées,
/// et n'appelle jamais la préparation. Le refus de la préparation sur les
/// erreurs GVI est raccordé dans l'autre sens, par
/// `prepare_graph_document_for_export`, sans cycle possible.
pub(crate) fn assess_graph_document_export_readiness(
    decoded: Result<&DecodedStoryDocument, &StoryDecodeError>,
) -> ExportReadiness {
    let (dimensions, unevaluated, diagnostics) = match decoded {
        Ok(payload) => observation::observe(payload),
        Err(error) => observation::observe_rejected(error),
    };
    compose(dimensions, unevaluated, diagnostics)
}

/// La composition de l'agrégat, isolée pour être testée seule.
fn compose(
    dimensions: Vec<DimensionAssessment>,
    unevaluated: Vec<UnevaluatedDimension>,
    diagnostics: Vec<ReadinessDiagnostic>,
) -> ExportReadiness {
    // Une dimension sans preuve ne peut rien justifier ; l'observation n'en
    // produit pas, et l'agrégat refuse quand même de s'y fier.
    let evaluated = dimensions
        .iter()
        .filter(|dimension| !dimension.evidence.is_empty())
        .map(|dimension| dimension.qualification)
        .min();

    // Une explication vide ne justifie jamais mieux qu'`UNTESTED`, et toute
    // entrée `unevaluated` plafonne l'agrégat à `UNTESTED`.
    let interoperability = match evaluated {
        Some(weakest) if unevaluated.is_empty() => weakest,
        _ => DimensionQualification::Untested,
    };

    ExportReadiness {
        blocked: diagnostics.iter().any(ReadinessDiagnostic::blocks),
        interoperability,
        dimensions,
        unevaluated,
        diagnostics,
    }
}
