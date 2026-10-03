//! Comparateur structurel : décide si le trajet
//! `StoryDocument → convertisseur tiers → FS → fs_pack_reader → StoryDocument'`
//! préserve la navigation.
//!
//! Le verdict porte sur le **graphe enraciné au stage d'entrée**, à renommage des
//! nœuds près. Il ne compare ni les identifiants, ni l'ordre physique de la table
//! `ni`, ni les octets des assets : ces trois transformations
//! sont déclarées légitimes d'avance, et `fs_pack_reader` régénère de toute façon un
//! `Uuid::new_v4()` pour chaque stage sauf le premier.
//!
//! Ce module est un outil de mesure (labo, `#[cfg(test)]`) : il n'entre dans
//! aucun chemin de production et ne modifie aucune décision d'éditabilité.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::native_pack::StoryDocument;

pub(crate) mod campaign;
#[cfg(test)]
mod family_a;
#[cfg(test)]
mod family_b;
mod matching;
#[cfg(test)]
mod reader_roundtrip;
#[cfg(test)]
mod synthetic;

pub(crate) use matching::GraphIndex;

/// Les quatre transformations déclarées **attendues** d'avance et
/// qui ne comptent donc pas comme écarts. Trois d'entre elles sont vraies par
/// construction du comparateur et n'ont pas de drapeau :
///
/// - **réordonnancement physique** des stages au-delà du point d'entrée : la
///   comparaison est un appariement de graphe, aucun indice n'entre dans une
///   égalité ;
/// - **régénération des identifiants** : aucun `uuid` de stage ni `id` d'action n'est
///   comparé — seules les arêtes résolues le sont ;
/// - **déduplication d'assets de contenu identique** : les médias ne sont comparés
///   qu'en présence, un regroupement est donc invisible. Il reste compté dans les
///   observations pour rester traçable.
///
/// La quatrième a un drapeau parce qu'elle est directionnelle, et pour que les tests
/// synthétiques puissent prouver que c'est bien elle qui fait passer un cas.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ToleratedTransformations {
    /// MP3 silencieux substitué à un audio absent : un `audio: null` côté source peut
    /// revenir avec un audio. L'inverse reste un écart.
    pub(crate) silent_audio_substitution: bool,
}

impl Default for ToleratedTransformations {
    /// Exactement la liste pré-enregistrée. Ne pas l'élargir en cours de mesure
    /// pour faire passer un résultat.
    fn default() -> Self {
        Self {
            silent_audio_substitution: true,
        }
    }
}

impl ToleratedTransformations {
    /// Comparaison sans tolérance — sert aux tests à montrer ce que la règle absorbe.
    pub(crate) fn none() -> Self {
        Self {
            silent_audio_substitution: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum StructuralVerdict {
    /// Bijection prouvée, aucune propriété comparée ne diverge.
    #[serde(rename = "EQUIVALENT")]
    Equivalent,
    /// Au moins un écart imputable au trajet testé.
    #[serde(rename = "NOT_EQUIVALENT")]
    NotEquivalent,
    /// Tous les écarts observés sont des pertes connues de `fs_pack_reader`
    /// (liste de défalcation du lecteur). Le convertisseur n'en est pas responsable.
    #[serde(rename = "READER_KNOWN_LOSS")]
    ReaderKnownLoss,
    /// Le mapping structurel n'est pas déterminable : on ne fabrique pas d'égalité.
    #[serde(rename = "COMPARISON_AMBIGUOUS")]
    ComparisonAmbiguous,
}

impl StructuralVerdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Equivalent => "EQUIVALENT",
            Self::NotEquivalent => "NOT_EQUIVALENT",
            Self::ReaderKnownLoss => "READER_KNOWN_LOSS",
            Self::ComparisonAmbiguous => "COMPARISON_AMBIGUOUS",
        }
    }
}

/// Codes d'écart. Chacun correspond à un écart compté comme échec ; aucun code
/// n'a été ajouté au-delà.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub(crate) enum DivergenceCode {
    /// Le pack relu ne démarre plus au même endroit : le graphe relu correspond à la
    /// source enracinée sur un **autre** stage.
    #[serde(rename = "ENTRY_POINT_MOVED")]
    EntryPointMoved,
    #[serde(rename = "STAGE_COUNT")]
    StageCount,
    #[serde(rename = "STAGE_CONTROLS")]
    StageControls,
    #[serde(rename = "IMAGE_PRESENCE")]
    ImagePresence,
    #[serde(rename = "AUDIO_PRESENCE")]
    AudioPresence,
    /// Une transition OK ou HOME existe d'un seul côté.
    #[serde(rename = "TRANSITION_PRESENCE")]
    TransitionPresence,
    /// `actionNode` introuvable d'un seul côté.
    #[serde(rename = "TRANSITION_ACTION_MISSING")]
    TransitionActionMissing,
    #[serde(rename = "OPTION_COUNT")]
    OptionCount,
    #[serde(rename = "OPTION_INDEX")]
    OptionIndex,
    /// Deux destinations déjà appariées ailleurs ne se retrouvent plus à la même
    /// position : l'ordre de la liste a changé.
    #[serde(rename = "DESTINATION_ORDER")]
    DestinationOrder,
    /// Convergence, self-loop ou cycle différent : deux arêtes qui partageaient une
    /// destination ne la partagent plus, ou l'inverse.
    #[serde(rename = "DESTINATION_SHARING")]
    DestinationSharing,
    /// Destination pendante d'un seul côté.
    #[serde(rename = "DESTINATION_MISSING")]
    DestinationMissing,
    #[serde(rename = "NIGHT_MODE")]
    NightMode,
    /// Stage sans correspondant après appariement complet (partie non atteignable
    /// depuis le point d'entrée).
    #[serde(rename = "UNMATCHED_STAGE")]
    UnmatchedStage,
}

/// Raisons pour lesquelles le comparateur refuse de trancher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum AmbiguityCode {
    #[serde(rename = "SOURCE_ENTRY_UNDEFINED")]
    SourceEntryUndefined,
    #[serde(rename = "SOURCE_ENTRY_MULTIPLE")]
    SourceEntryMultiple,
    #[serde(rename = "READBACK_ENTRY_UNDEFINED")]
    ReadbackEntryUndefined,
    #[serde(rename = "EMPTY_DOCUMENT")]
    EmptyDocument,
    #[serde(rename = "DUPLICATE_STAGE_ID")]
    DuplicateStageId,
    /// Partie non atteignable dont l'appariement demande un choix arbitraire qui ne
    /// se confirme pas : ni équivalence prouvée, ni écart prouvé.
    #[serde(rename = "RESIDUAL_AMBIGUOUS")]
    ResidualAmbiguous,
    /// Budget d'exploration épuisé avant conclusion.
    #[serde(rename = "SEARCH_BUDGET")]
    SearchBudget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Divergence {
    pub(crate) code: DivergenceCode,
    /// Chemin depuis le point d'entrée jusqu'au lieu de l'écart, en arêtes typées.
    pub(crate) witness: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ambiguity {
    pub(crate) code: AmbiguityCode,
    pub(crate) detail: String,
}

/// Ce que le comparateur a pu établir sur l'ancrage du point d'entrée.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(crate) enum EntryAnchor {
    /// Le stage d'entrée relu correspond, **par le contenu**, au stage d'entrée
    /// source : le drapeau `squareOne` n'a servi qu'à proposer le couple.
    Verified,
    /// Le graphe relu correspond à la source enracinée sur un autre stage.
    MovedTo {
        source_stage_index: usize,
        source_stage_name: String,
    },
    /// Aucun stage source ne produit un appariement propre.
    Unmatched,
    /// L'ancrage n'a pas été évalué (comparaison interrompue avant).
    NotEvaluated,
}

/// Perte connue de `fs_pack_reader` à défalquer, relevée par l'instrumentation
/// de `fs_pack_diagnostics`.
///
/// **La liste de production est vide par mesure** : l'instrumentation ne relève
/// aucune collision d'offset, option perdue, transition infidèle, contrôle brut
/// hors `{0, 1}` ni identifiant de Stage non UUID. Le mécanisme existe pour
/// qu'une perte future soit défalquée sans réécrire le comparateur, jamais pour
/// absorber un écart qu'on n'a pas diagnostiqué.
#[derive(Clone)]
pub(crate) struct ReaderKnownLoss {
    /// Mesure d'origine de l'instrumentation, pour tracer la défalcation.
    pub(crate) question: &'static str,
    pub(crate) code: DivergenceCode,
    /// Discrimine l'écart précis : un code seul défalquerait trop.
    pub(crate) matches: fn(&Divergence) -> bool,
}

/// Liste de défalcation consommée par la comparaison.
///
/// Vide : l'instrumentation de `fs_pack_diagnostics` ne relève aucune perte sur
/// les 71 packs filesystem du corpus, avec 115 239 réutilisations d'offset `li` et
/// 137 957 transitions contrôlées. Tout écart reste donc imputable au trajet testé
/// jusqu'à diagnostic contraire.
pub(crate) fn v1_known_losses() -> Vec<ReaderKnownLoss> {
    Vec::new()
}

/// Observations non verdictives : signaux utiles au rapport qui ne
/// figurent **pas** parmi les écarts comptés comme échecs. Les compter
/// produirait un faux négatif.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observations {
    /// Stages dont l'audio absent revient présent (règle du MP3 silencieux).
    pub(crate) silent_audio_substitutions: usize,
    /// Couples appariés dont le partage d'asset audio diffère. Le regroupement est
    /// attendu (déduplication) ; l'éclatement ne l'est pas, mais reste hors critère
    /// car les médias ne sont comparés qu'en présence.
    pub(crate) audio_sharing_splits: usize,
    pub(crate) audio_sharing_merges: usize,
    pub(crate) image_sharing_splits: usize,
    pub(crate) image_sharing_merges: usize,
    /// `actionNode` pendant des deux côtés : ni écart, ni structure.
    pub(crate) dangling_actions_both_sides: usize,
    /// Destinations pendantes des deux côtés.
    pub(crate) dangling_destinations_both_sides: usize,
    /// Nombre d'`actionNode` de chaque document. Le partage d'action est un
    /// identifiant interne, jamais un critère.
    pub(crate) source_action_count: usize,
    pub(crate) readback_action_count: usize,
    /// Le choix d'un candidat a été arbitraire au moins une fois dans la partie non
    /// atteignable ; l'appariement retenu a néanmoins été vérifié arête par arête.
    pub(crate) residual_arbitrary_choices: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StructuralComparison {
    pub(crate) verdict: StructuralVerdict,
    pub(crate) entry_anchor: EntryAnchor,
    pub(crate) source_stage_count: usize,
    pub(crate) readback_stage_count: usize,
    pub(crate) matched_stage_count: usize,
    /// Écarts imputés au trajet testé.
    pub(crate) divergences: Vec<Divergence>,
    /// Écarts défalqués comme pertes connues du lecteur, conservés en détail.
    pub(crate) reader_known_losses: Vec<Divergence>,
    pub(crate) ambiguities: Vec<Ambiguity>,
    pub(crate) observations: Observations,
    /// Compte par code, pour agréger une mesure sans relire les messages.
    pub(crate) divergence_counts: BTreeMap<String, usize>,
}

impl StructuralComparison {
    fn ambiguous(
        source: &StoryDocument,
        readback: &StoryDocument,
        ambiguities: Vec<Ambiguity>,
    ) -> Self {
        Self {
            verdict: StructuralVerdict::ComparisonAmbiguous,
            entry_anchor: EntryAnchor::NotEvaluated,
            source_stage_count: source.stage_nodes.len(),
            readback_stage_count: readback.stage_nodes.len(),
            matched_stage_count: 0,
            divergences: Vec::new(),
            reader_known_losses: Vec::new(),
            ambiguities,
            observations: Observations {
                source_action_count: source.action_nodes.len(),
                readback_action_count: readback.action_nodes.len(),
                ..Observations::default()
            },
            divergence_counts: BTreeMap::new(),
        }
    }

    pub(crate) fn codes(&self) -> Vec<DivergenceCode> {
        self.divergences.iter().map(|gap| gap.code).collect()
    }

    /// Résumé d'une ligne, pour les journaux.
    pub(crate) fn summary(&self) -> String {
        let codes: Vec<&str> = self
            .divergence_counts
            .keys()
            .map(|code| code.as_str())
            .collect();
        format!(
            "{} ({}/{} stages appariés{})",
            self.verdict.as_str(),
            self.matched_stage_count,
            self.source_stage_count,
            if codes.is_empty() {
                String::new()
            } else {
                format!(" ; {}", codes.join(", "))
            }
        )
    }
}

/// Compare la structure de `source` et de `readback` avec la liste de tolérances
/// pré-enregistrée et la liste de défalcation de production.
pub(crate) fn compare_structure(
    source: &StoryDocument,
    readback: &StoryDocument,
) -> StructuralComparison {
    compare_structure_with(
        source,
        readback,
        &ToleratedTransformations::default(),
        &v1_known_losses(),
    )
}

pub(crate) fn compare_structure_with(
    source: &StoryDocument,
    readback: &StoryDocument,
    tolerances: &ToleratedTransformations,
    known_losses: &[ReaderKnownLoss],
) -> StructuralComparison {
    let mut ambiguities = Vec::new();

    let source_index = GraphIndex::build(source);
    let readback_index = GraphIndex::build(readback);

    for (label, index) in [("source", &source_index), ("relu", &readback_index)] {
        if index.is_empty() {
            ambiguities.push(Ambiguity {
                code: AmbiguityCode::EmptyDocument,
                detail: format!("document {label} sans stage"),
            });
        }
        if !index.duplicate_ids.is_empty() {
            ambiguities.push(Ambiguity {
                code: AmbiguityCode::DuplicateStageId,
                detail: format!(
                    "document {label} : identifiants de stage dupliqués ({})",
                    index.duplicate_ids.join(", ")
                ),
            });
        }
    }
    if !ambiguities.is_empty() {
        return StructuralComparison::ambiguous(source, readback, ambiguities);
    }

    // Le drapeau `squareOne` ne sert qu'à **proposer** le couple d'ancrage : le
    // lecteur le pose sur l'indice 0 par construction, il ne prouve donc rien. La
    // vérification se fait ensuite par le contenu, via l'appariement du graphe entier.
    let source_entry = match source_index.declared_entries().as_slice() {
        [single] => *single,
        [] => {
            ambiguities.push(Ambiguity {
                code: AmbiguityCode::SourceEntryUndefined,
                detail: "aucun stage squareOne dans le document source".to_string(),
            });
            return StructuralComparison::ambiguous(source, readback, ambiguities);
        }
        several => {
            ambiguities.push(Ambiguity {
                code: AmbiguityCode::SourceEntryMultiple,
                detail: format!("{} stages squareOne dans le document source", several.len()),
            });
            return StructuralComparison::ambiguous(source, readback, ambiguities);
        }
    };
    let readback_entry = match readback_index.declared_entries().as_slice() {
        [single] => *single,
        [] => {
            ambiguities.push(Ambiguity {
                code: AmbiguityCode::ReadbackEntryUndefined,
                detail: "aucun stage squareOne dans le document relu".to_string(),
            });
            return StructuralComparison::ambiguous(source, readback, ambiguities);
        }
        // `fs_pack_reader` n'en pose qu'un ; un document relu qui en présente
        // plusieurs ne vient pas de ce lecteur, on garde l'indice 0 et on le dit.
        several => {
            ambiguities.push(Ambiguity {
                code: AmbiguityCode::ReadbackEntryUndefined,
                detail: format!(
                    "{} stages squareOne dans le document relu ; ancrage tenté sur l'indice 0",
                    several.len()
                ),
            });
            0
        }
    };

    matching::run(matching::Request {
        source,
        readback,
        source_index: &source_index,
        readback_index: &readback_index,
        source_entry,
        readback_entry,
        tolerances,
        known_losses,
        ambiguities,
    })
}
