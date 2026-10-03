//! Appariement du graphe enraciné : c'est lui qui décide, pas les compteurs.
//!
//! Les arêtes sont **typées et ordonnées** (`OK`/`HOME`, puis position dans la liste
//! d'options). Le graphe est donc déterministe : une fois le couple de stages
//! d'entrée posé, l'appariement est forcé, arête par arête. Aucune recherche n'est
//! nécessaire tant qu'on reste dans la partie atteignable — ce qui rend le verdict
//! reproductible et le témoin d'écart lisible.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};

use crate::native_pack::{ActionNode, OptionSelection, StageNode, StoryDocument};

use super::{
    Ambiguity, AmbiguityCode, Divergence, DivergenceCode, EntryAnchor, Observations,
    ReaderKnownLoss, StructuralComparison, StructuralVerdict, ToleratedTransformations,
};

/// Plafond d'arêtes visitées, tous appariements confondus. Il ne peut transformer un
/// écart en équivalence : dépassé, le comparateur signale `SEARCH_BUDGET`.
const STEP_BUDGET: usize = 8_000_000;
/// Budget d'arêtes visitées par la recherche d'ancrage de repli, tous candidats
/// confondus. Il se règle en pas plutôt qu'en nombre de candidats pour que les petits
/// graphes soient explorés exhaustivement et les gros restent bornés en temps.
///
/// Le dépassement ne change pas le verdict — `NOT_EQUIVALENT` dans les deux cas —
/// seulement la finesse du diagnostic : « point d'entrée déplacé » plutôt que
/// « premier écart rencontré ».
const ANCHOR_SEARCH_STEP_BUDGET: usize = 1_000_000;
/// Tours de raffinement de couleur utilisés pour présélectionner les ancrages.
const REFINEMENT_ROUNDS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trigger {
    Ok,
    Home,
}

impl Trigger {
    fn label(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::Home => "HOME",
        }
    }
}

const TRIGGERS: [Trigger; 2] = [Trigger::Ok, Trigger::Home];

/// Forme d'une transition résolue, à l'exclusion de tout identifiant.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TransitionShape {
    Absent,
    /// `actionNode` déclaré mais introuvable dans le document.
    DanglingAction {
        selection: OptionSelection,
    },
    Present {
        selection: OptionSelection,
        /// Destinations ordonnées ; `None` = identifiant de stage introuvable.
        options: Vec<Option<usize>>,
    },
}

impl TransitionShape {
    fn arity(&self) -> (u8, i64, usize) {
        match self {
            Self::Absent => (0, 0, 0),
            Self::DanglingAction { selection } => (1, selection.to_dialect_index(), 0),
            Self::Present { selection, options } => {
                (2, selection.to_dialect_index(), options.len())
            }
        }
    }
}

pub(crate) struct GraphIndex<'a> {
    stages: Vec<&'a StageNode>,
    by_id: HashMap<&'a str, usize>,
    actions: HashMap<&'a str, &'a ActionNode>,
    pub(crate) duplicate_ids: Vec<String>,
}

impl<'a> GraphIndex<'a> {
    pub(crate) fn build(document: &'a StoryDocument) -> Self {
        let mut by_id = HashMap::with_capacity(document.stage_nodes.len());
        let mut duplicate_ids = Vec::new();
        for (index, stage) in document.stage_nodes.iter().enumerate() {
            if by_id.insert(stage.uuid.as_str(), index).is_some() {
                duplicate_ids.push(stage.uuid.clone());
            }
        }
        Self {
            stages: document.stage_nodes.iter().collect(),
            by_id,
            actions: document
                .action_nodes
                .iter()
                .map(|action| (action.id.as_str(), action))
                .collect(),
            duplicate_ids,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.stages.is_empty()
    }

    fn len(&self) -> usize {
        self.stages.len()
    }

    fn stage(&self, index: usize) -> &'a StageNode {
        self.stages[index]
    }

    /// Stages portant le drapeau `squareOne`. Le drapeau propose l'ancrage ; il ne
    /// le prouve jamais.
    pub(crate) fn declared_entries(&self) -> Vec<usize> {
        self.stages
            .iter()
            .enumerate()
            .filter(|(_, stage)| stage.is_square_one())
            .map(|(index, _)| index)
            .collect()
    }

    fn name(&self, index: usize) -> String {
        let stage = self.stage(index);
        if stage.label().is_empty() {
            format!("#{index}")
        } else {
            format!("#{index} «{}»", stage.label())
        }
    }

    fn shape(&self, index: usize, trigger: Trigger) -> TransitionShape {
        let stage = self.stage(index);
        let transition = match trigger {
            Trigger::Ok => stage.ok_transition.value(),
            Trigger::Home => stage.home_transition.value(),
        };
        let Some(transition) = transition else {
            return TransitionShape::Absent;
        };
        let Some(action) = self.actions.get(transition.action_node.as_str()) else {
            return TransitionShape::DanglingAction {
                selection: transition.selection,
            };
        };
        TransitionShape::Present {
            selection: transition.selection,
            options: action
                .options
                .iter()
                .map(|target| {
                    target
                        .as_deref()
                        .and_then(|target| self.by_id.get(target).copied())
                })
                .collect(),
        }
    }

    /// Couleurs raffinées, audio exclu : la substitution du MP3 silencieux rendrait
    /// deux stages équivalents de couleurs différentes. Une couleur trop grossière ne
    /// fait que laisser passer des candidats d'ancrage, jamais en écarter un vrai.
    fn refined_colors(&self) -> Vec<u64> {
        let mut colors: Vec<u64> = (0..self.len())
            .map(|index| {
                let stage = self.stage(index);
                let mut hasher = DefaultHasher::new();
                (
                    stage.control_settings.wheel(),
                    stage.control_settings.ok(),
                    stage.control_settings.home(),
                    stage.control_settings.pause(),
                    stage.control_settings.autoplay(),
                    stage.image.is_value(),
                )
                    .hash(&mut hasher);
                for trigger in TRIGGERS {
                    self.shape(index, trigger).arity().hash(&mut hasher);
                }
                hasher.finish()
            })
            .collect();

        let shapes: Vec<[TransitionShape; 2]> = (0..self.len())
            .map(|index| {
                [
                    self.shape(index, Trigger::Ok),
                    self.shape(index, Trigger::Home),
                ]
            })
            .collect();

        for _ in 0..REFINEMENT_ROUNDS {
            let next: Vec<u64> = (0..self.len())
                .map(|index| {
                    let mut hasher = DefaultHasher::new();
                    colors[index].hash(&mut hasher);
                    for shape in &shapes[index] {
                        if let TransitionShape::Present { options, .. } = shape {
                            for option in options {
                                match option {
                                    Some(target) => colors[*target].hash(&mut hasher),
                                    None => u64::MAX.hash(&mut hasher),
                                }
                            }
                        }
                    }
                    hasher.finish()
                })
                .collect();
            colors = next;
        }
        colors
    }
}

/// Issue d'un appariement enraciné : les écarts « locaux » n'invalident pas la
/// bijection et sont donc collectés ; un écart de structure, lui, interrompt.
struct AnchoredMatch {
    local: Vec<Divergence>,
}

enum MatchError {
    Structural(Box<Divergence>),
    Budget,
}

struct Matcher<'a> {
    source: &'a GraphIndex<'a>,
    readback: &'a GraphIndex<'a>,
    tolerances: &'a ToleratedTransformations,
    map: Vec<Option<usize>>,
    rmap: Vec<Option<usize>>,
    parent: Vec<Option<(usize, Trigger, usize)>>,
    steps: usize,
    silent_audio_substitutions: usize,
    dangling_actions_both_sides: usize,
    dangling_destinations_both_sides: usize,
}

impl<'a> Matcher<'a> {
    fn new(
        source: &'a GraphIndex<'a>,
        readback: &'a GraphIndex<'a>,
        tolerances: &'a ToleratedTransformations,
    ) -> Self {
        Self {
            map: vec![None; source.len()],
            rmap: vec![None; readback.len()],
            parent: vec![None; source.len()],
            source,
            readback,
            tolerances,
            steps: 0,
            silent_audio_substitutions: 0,
            dangling_actions_both_sides: 0,
            dangling_destinations_both_sides: 0,
        }
    }

    fn reset(&mut self) {
        self.map.iter_mut().for_each(|slot| *slot = None);
        self.rmap.iter_mut().for_each(|slot| *slot = None);
        self.parent.iter_mut().for_each(|slot| *slot = None);
        self.silent_audio_substitutions = 0;
        self.dangling_actions_both_sides = 0;
        self.dangling_destinations_both_sides = 0;
    }

    fn matched_count(&self) -> usize {
        self.map.iter().filter(|slot| slot.is_some()).count()
    }

    /// Chemin depuis la racine d'appariement jusqu'au stage, en arêtes typées et
    /// ordonnées. C'est le témoin qui rend un écart rejouable à la main.
    fn witness(&self, source_index: usize) -> String {
        let mut steps = Vec::new();
        let mut current = source_index;
        for _ in 0..=self.source.len() {
            let Some((parent, trigger, position)) = self.parent[current] else {
                break;
            };
            steps.push((trigger, position, current));
            current = parent;
        }
        steps.reverse();
        let mut witness = self.source.name(current);
        for (trigger, position, target) in steps {
            witness.push_str(&format!(
                " -{}[{}]-> {}",
                trigger.label(),
                position,
                self.source.name(target)
            ));
        }
        witness
    }

    /// Pose le couple racine puis vérifie tout le sous-graphe atteignable.
    fn expand_from(
        &mut self,
        source_root: usize,
        readback_root: usize,
    ) -> Result<AnchoredMatch, MatchError> {
        let mut local = Vec::new();
        if let Some(conflict) = self.bind(source_root, readback_root, None, &[])? {
            return Err(MatchError::Structural(Box::new(conflict)));
        }
        let mut queue = VecDeque::from([source_root]);

        while let Some(source_index) = queue.pop_front() {
            self.steps += 1;
            if self.steps > STEP_BUDGET {
                return Err(MatchError::Budget);
            }
            let readback_index = self.map[source_index].expect("stage apparié avant dépilement");
            local.extend(self.compare_local(source_index, readback_index));

            for trigger in TRIGGERS {
                let source_shape = self.source.shape(source_index, trigger);
                let readback_shape = self.readback.shape(readback_index, trigger);
                self.compare_transition(
                    source_index,
                    trigger,
                    &source_shape,
                    &readback_shape,
                    &mut queue,
                )?;
            }
        }
        Ok(AnchoredMatch { local })
    }

    /// Lie deux stages. `Ok(None)` = lien posé ou déjà cohérent ; `Ok(Some(gap))` =
    /// conflit d'appariement.
    ///
    /// `siblings` porte les destinations de la transition en cours : quand les deux
    /// extrémités du conflit y figurent toutes les deux, la liste a été réordonnée ;
    /// sinon l'arête a changé de cible, ce qui casse un partage, un cycle ou un
    /// self-loop.
    fn bind(
        &mut self,
        source_index: usize,
        readback_index: usize,
        edge: Option<(usize, Trigger, usize)>,
        siblings: &[Option<usize>],
    ) -> Result<Option<Divergence>, MatchError> {
        match (self.map[source_index], self.rmap[readback_index]) {
            (Some(existing), _) if existing == readback_index => Ok(None),
            (None, None) => {
                self.map[source_index] = Some(readback_index);
                self.rmap[readback_index] = Some(source_index);
                if let Some(edge) = edge {
                    self.parent[source_index] = Some(edge);
                }
                Ok(None)
            }
            (Some(existing), Some(other)) => Ok(Some(Divergence {
                code: if siblings.contains(&Some(other)) {
                    // Les deux destinations croisées appartiennent à la même liste :
                    // c'est son ordre qui a changé.
                    DivergenceCode::DestinationOrder
                } else {
                    DivergenceCode::DestinationSharing
                },
                witness: self.witness(source_index),
                detail: format!(
                    "le stage source {} est apparié au stage relu {}, et le stage relu {} au stage source {} : cette arête les croise",
                    self.source.name(source_index),
                    self.readback.name(existing),
                    self.readback.name(readback_index),
                    self.source.name(other)
                ),
            })),
            (Some(existing), None) => Ok(Some(Divergence {
                code: DivergenceCode::DestinationSharing,
                witness: self.witness(source_index),
                detail: format!(
                    "le stage source {} est déjà apparié au stage relu {} ; cette arête le mène vers {}, un stage relu encore inconnu",
                    self.source.name(source_index),
                    self.readback.name(existing),
                    self.readback.name(readback_index)
                ),
            })),
            (None, Some(existing)) => Ok(Some(Divergence {
                code: DivergenceCode::DestinationSharing,
                witness: self.witness(existing),
                detail: format!(
                    "le stage relu {} est déjà apparié au stage source {} ; cette arête l'atteint depuis {}",
                    self.readback.name(readback_index),
                    self.source.name(existing),
                    self.source.name(source_index)
                ),
            })),
        }
    }

    /// Contrôles et présence de média : un écart ici n'invalide pas la bijection.
    fn compare_local(&mut self, source_index: usize, readback_index: usize) -> Vec<Divergence> {
        let source = self.source.stage(source_index);
        let readback = self.readback.stage(readback_index);
        let mut gaps = Vec::new();

        if !controls_equal(source, readback) {
            gaps.push(Divergence {
                code: DivergenceCode::StageControls,
                witness: self.witness(source_index),
                detail: format!(
                    "contrôles source {} vs relu {}",
                    controls_text(source),
                    controls_text(readback)
                ),
            });
        }
        if source.image.is_value() != readback.image.is_value() {
            gaps.push(Divergence {
                code: DivergenceCode::ImagePresence,
                witness: self.witness(source_index),
                detail: format!(
                    "image source {} vs relu {}",
                    presence(source.image.is_value()),
                    presence(readback.image.is_value())
                ),
            });
        }
        match (source.audio.is_value(), readback.audio.is_value()) {
            (a, b) if a == b => {}
            // Règle du MP3 silencieux : le writer FS tiers substitue délibérément un
            // audio à un `audio: null` pour satisfaire l'appareil.
            (false, true) if self.tolerances.silent_audio_substitution => {
                self.silent_audio_substitutions += 1;
            }
            (source_has, readback_has) => gaps.push(Divergence {
                code: DivergenceCode::AudioPresence,
                witness: self.witness(source_index),
                detail: format!(
                    "audio source {} vs relu {}",
                    presence(source_has),
                    presence(readback_has)
                ),
            }),
        }
        gaps
    }

    fn compare_transition(
        &mut self,
        source_index: usize,
        trigger: Trigger,
        source_shape: &TransitionShape,
        readback_shape: &TransitionShape,
        queue: &mut VecDeque<usize>,
    ) -> Result<(), MatchError> {
        let fail = |code: DivergenceCode, detail: String, witness: String| {
            Err(MatchError::Structural(Box::new(Divergence {
                code,
                witness,
                detail,
            })))
        };

        match (source_shape, readback_shape) {
            (TransitionShape::Absent, TransitionShape::Absent) => Ok(()),
            (
                TransitionShape::DanglingAction { selection: a },
                TransitionShape::DanglingAction { selection: b },
            ) => {
                self.dangling_actions_both_sides += 1;
                if a != b {
                    return fail(
                        DivergenceCode::OptionIndex,
                        format!(
                            "{} : optionIndex source {a} vs relu {b} (action pendante des deux côtés)",
                            trigger.label()
                        ),
                        self.witness(source_index),
                    );
                }
                Ok(())
            }
            (TransitionShape::Absent, _) | (_, TransitionShape::Absent) => fail(
                DivergenceCode::TransitionPresence,
                format!(
                    "transition {} présente côté {} seulement",
                    trigger.label(),
                    if matches!(source_shape, TransitionShape::Absent) {
                        "relu"
                    } else {
                        "source"
                    }
                ),
                self.witness(source_index),
            ),
            (TransitionShape::DanglingAction { .. }, _)
            | (_, TransitionShape::DanglingAction { .. }) => fail(
                DivergenceCode::TransitionActionMissing,
                format!(
                    "transition {} : actionNode introuvable côté {} seulement",
                    trigger.label(),
                    if matches!(source_shape, TransitionShape::DanglingAction { .. }) {
                        "source"
                    } else {
                        "relu"
                    }
                ),
                self.witness(source_index),
            ),
            (
                TransitionShape::Present {
                    selection: source_option,
                    options: source_options,
                },
                TransitionShape::Present {
                    selection: readback_option,
                    options: readback_options,
                },
            ) => {
                if source_option != readback_option {
                    return fail(
                        DivergenceCode::OptionIndex,
                        format!(
                            "transition {} : optionIndex source {source_option} vs relu {readback_option}",
                            trigger.label()
                        ),
                        self.witness(source_index),
                    );
                }
                if source_options.len() != readback_options.len() {
                    return fail(
                        DivergenceCode::OptionCount,
                        format!(
                            "transition {} : {} destination(s) source vs {} relu",
                            trigger.label(),
                            source_options.len(),
                            readback_options.len()
                        ),
                        self.witness(source_index),
                    );
                }
                for (position, (source_target, readback_target)) in source_options
                    .iter()
                    .zip(readback_options.iter())
                    .enumerate()
                {
                    self.steps += 1;
                    if self.steps > STEP_BUDGET {
                        return Err(MatchError::Budget);
                    }
                    match (source_target, readback_target) {
                        (None, None) => {
                            self.dangling_destinations_both_sides += 1;
                        }
                        (Some(_), None) | (None, Some(_)) => {
                            return fail(
                                DivergenceCode::DestinationMissing,
                                format!(
                                    "transition {} destination {position} : identifiant de stage introuvable côté {} seulement",
                                    trigger.label(),
                                    if source_target.is_none() {
                                        "source"
                                    } else {
                                        "relu"
                                    }
                                ),
                                self.witness(source_index),
                            );
                        }
                        (Some(source_target), Some(readback_target)) => {
                            let already_mapped = self.map[*source_target].is_some();
                            if let Some(conflict) = self.bind(
                                *source_target,
                                *readback_target,
                                Some((source_index, trigger, position)),
                                source_options,
                            )? {
                                return Err(MatchError::Structural(Box::new(conflict)));
                            }
                            if !already_mapped {
                                queue.push_back(*source_target);
                            }
                        }
                    }
                }
                Ok(())
            }
        }
    }
}

fn controls_equal(left: &StageNode, right: &StageNode) -> bool {
    // Comparaison de présence : deux contrôles ne sont égaux que s'ils ont la
    // même forme, pas seulement la même valeur booléenne effective.
    left.control_settings == right.control_settings
}

fn controls_text(stage: &StageNode) -> String {
    let controls = &stage.control_settings;
    format!(
        "wheel={} ok={} home={} pause={} autoplay={}",
        controls.wheel(),
        controls.ok(),
        controls.home(),
        controls.pause(),
        controls.autoplay()
    )
}

fn presence(present: bool) -> &'static str {
    if present {
        "présent"
    } else {
        "absent"
    }
}

pub(crate) struct Request<'a> {
    pub(crate) source: &'a StoryDocument,
    pub(crate) readback: &'a StoryDocument,
    pub(crate) source_index: &'a GraphIndex<'a>,
    pub(crate) readback_index: &'a GraphIndex<'a>,
    pub(crate) source_entry: usize,
    pub(crate) readback_entry: usize,
    pub(crate) tolerances: &'a ToleratedTransformations,
    pub(crate) known_losses: &'a [ReaderKnownLoss],
    pub(crate) ambiguities: Vec<Ambiguity>,
}

/// Couleurs raffinées des deux graphes, calculées une seule fois par comparaison :
/// elles ne dépendent que de la structure, jamais de l'appariement en cours.
struct Colors {
    source: Vec<u64>,
    readback: Vec<u64>,
    source_multiset: Vec<u64>,
    readback_multiset: Vec<u64>,
}

impl Colors {
    fn compute(source: &GraphIndex<'_>, readback: &GraphIndex<'_>) -> Self {
        let source = source.refined_colors();
        let readback = readback.refined_colors();
        let mut source_multiset = source.clone();
        let mut readback_multiset = readback.clone();
        source_multiset.sort_unstable();
        readback_multiset.sort_unstable();
        Self {
            source,
            readback,
            source_multiset,
            readback_multiset,
        }
    }
}

pub(crate) fn run(request: Request<'_>) -> StructuralComparison {
    let Request {
        source,
        readback,
        source_index,
        readback_index,
        source_entry,
        readback_entry,
        tolerances,
        known_losses,
        mut ambiguities,
    } = request;

    let colors = Colors::compute(source_index, readback_index);
    let mut matcher = Matcher::new(source_index, readback_index, tolerances);
    let mut divergences = Vec::new();
    let mut observations = Observations {
        source_action_count: source.action_nodes.len(),
        readback_action_count: readback.action_nodes.len(),
        ..Observations::default()
    };
    let mut entry_anchor = EntryAnchor::NotEvaluated;
    let mut mapping_usable = false;

    // Premier essai sur l'ancrage déclaré. Le drapeau `squareOne` du document relu
    // est vrai par construction du lecteur : il ne prouve rien, seule la réussite de
    // cet appariement vérifie l'ancrage **par le contenu**.
    let declared = matcher.expand_from(source_entry, readback_entry);
    let declared_is_clean = matches!(&declared, Ok(anchored) if anchored.local.is_empty());
    let declared_budget = matches!(&declared, Err(MatchError::Budget));

    if declared_is_clean {
        entry_anchor = EntryAnchor::Verified;
        mapping_usable = true;
    } else if declared_budget {
        ambiguities.push(Ambiguity {
            code: AmbiguityCode::SearchBudget,
            detail: "budget d'exploration épuisé sur l'ancrage déclaré".to_string(),
        });
    } else {
        // L'ancrage déclaré ne rend pas compte du document relu. Reste à savoir si le
        // convertisseur a écrit **un autre stage en position 0** — cas grave où le pack
        // ne démarre plus au même endroit — ou s'il a modifié la structure.
        let moved = search_moved_anchor(
            &mut matcher,
            &colors,
            source_index,
            source_entry,
            readback_entry,
        );
        match moved {
            MovedAnchor::Found(alternative) => {
                entry_anchor = EntryAnchor::MovedTo {
                    source_stage_index: alternative,
                    source_stage_name: source_index.stage(alternative).label().to_string(),
                };
                divergences.push(Divergence {
                    code: DivergenceCode::EntryPointMoved,
                    witness: format!("ancrage déclaré {}", source_index.name(source_entry)),
                    detail: format!(
                        "le graphe relu correspond à la source enracinée sur {} ; le pack ne démarre plus au même stage",
                        source_index.name(alternative)
                    ),
                });
                mapping_usable = true;
            }
            other => {
                if matches!(other, MovedAnchor::Truncated) {
                    ambiguities.push(Ambiguity {
                        code: AmbiguityCode::SearchBudget,
                        detail: format!(
                            "recherche d'ancrage de repli tronquée après {ANCHOR_SEARCH_STEP_BUDGET} pas ; l'écart reste avéré, seul son diagnostic est moins précis"
                        ),
                    });
                }
                // Aucun ancrage de repli : on revient au diagnostic de l'ancrage déclaré,
                // qui reste le plus informatif.
                matcher.reset();
                match matcher.expand_from(source_entry, readback_entry) {
                    Ok(anchored) => {
                        entry_anchor = EntryAnchor::Verified;
                        divergences.extend(anchored.local);
                        mapping_usable = true;
                    }
                    // `EntryAnchor::Unmatched` dit déjà qu'aucun stage source
                    // n'enracine le graphe relu ; l'écart conserve son propre code,
                    // qui est ce qu'une agrégation de résultats retient.
                    Err(MatchError::Structural(gap)) => {
                        entry_anchor = EntryAnchor::Unmatched;
                        divergences.push(*gap);
                    }
                    Err(MatchError::Budget) => ambiguities.push(Ambiguity {
                        code: AmbiguityCode::SearchBudget,
                        detail: "budget d'exploration épuisé sur l'ancrage déclaré".to_string(),
                    }),
                }
            }
        }
    }

    if mapping_usable {
        match match_residual(&mut matcher, &colors, &mut observations) {
            Residual::Complete => {}
            Residual::Divergences(gaps) => divergences.extend(gaps),
            Residual::Ambiguous(detail) => ambiguities.push(Ambiguity {
                code: AmbiguityCode::ResidualAmbiguous,
                detail,
            }),
            Residual::Budget => ambiguities.push(Ambiguity {
                code: AmbiguityCode::SearchBudget,
                detail: "budget d'exploration épuisé sur la partie non atteignable".to_string(),
            }),
        }
    }

    if source.stage_nodes.len() != readback.stage_nodes.len() {
        divergences.push(Divergence {
            code: DivergenceCode::StageCount,
            witness: "document".to_string(),
            detail: format!(
                "{} stage(s) source vs {} relu(s)",
                source.stage_nodes.len(),
                readback.stage_nodes.len()
            ),
        });
    }
    // Le comparateur mesure le comportement runtime des passerelles, pas
    // l'oracle de présence auteur (testé séparément). Une omission source relue
    // comme `false` est équivalente.
    if source.night_mode_available.is_true() != readback.night_mode_available.is_true() {
        divergences.push(Divergence {
            code: DivergenceCode::NightMode,
            witness: "document".to_string(),
            detail: format!(
                "nightModeAvailable source {} vs relu {}",
                source.night_mode_available.is_true(),
                readback.night_mode_available.is_true()
            ),
        });
    }

    observations.silent_audio_substitutions = matcher.silent_audio_substitutions;
    observations.dangling_actions_both_sides = matcher.dangling_actions_both_sides;
    observations.dangling_destinations_both_sides = matcher.dangling_destinations_both_sides;
    if mapping_usable {
        collect_asset_sharing(&matcher, &mut observations);
    }

    let matched_stage_count = matcher.matched_count();
    let (divergences, reader_known_losses) = split_known_losses(divergences, known_losses);
    let mut divergence_counts: BTreeMap<String, usize> = BTreeMap::new();
    for gap in &divergences {
        *divergence_counts
            .entry(format!("{:?}", gap.code))
            .or_insert(0) += 1;
    }

    let verdict = if !ambiguities.is_empty() && divergences.is_empty() {
        StructuralVerdict::ComparisonAmbiguous
    } else if !divergences.is_empty() {
        StructuralVerdict::NotEquivalent
    } else if !reader_known_losses.is_empty() {
        StructuralVerdict::ReaderKnownLoss
    } else {
        StructuralVerdict::Equivalent
    };

    StructuralComparison {
        verdict,
        entry_anchor,
        source_stage_count: source.stage_nodes.len(),
        readback_stage_count: readback.stage_nodes.len(),
        matched_stage_count,
        divergences,
        reader_known_losses,
        ambiguities,
        observations,
        divergence_counts,
    }
}

enum MovedAnchor {
    Found(usize),
    None,
    Truncated,
}

/// Cherche un stage source, autre que l'entrée déclarée, dont le graphe enraciné
/// reproduit exactement le graphe relu. Une correspondance signifie que le
/// convertisseur a écrit un autre stage en position 0.
fn search_moved_anchor(
    matcher: &mut Matcher<'_>,
    colors: &Colors,
    source_index: &GraphIndex<'_>,
    declared_source_entry: usize,
    readback_entry: usize,
) -> MovedAnchor {
    // Un isomorphisme conserve les couleurs raffinées : si les deux multiensembles
    // diffèrent, aucun ancrage ne peut convenir et la recherche est inutile. Sans ce
    // filtre, le pire cas coûte `ANCHOR_CANDIDATE_LIMIT` appariements complets.
    if colors.source_multiset != colors.readback_multiset {
        return MovedAnchor::None;
    }
    let target_color = colors.readback[readback_entry];

    let candidates: Vec<usize> = (0..source_index.len())
        .filter(|index| *index != declared_source_entry && colors.source[*index] == target_color)
        .collect();

    let start = matcher.steps;
    let mut truncated = false;
    for (rank, candidate) in candidates.iter().enumerate() {
        if matcher.steps.saturating_sub(start) > ANCHOR_SEARCH_STEP_BUDGET {
            truncated = rank < candidates.len();
            break;
        }
        matcher.reset();
        // Un ancrage de repli n'est retenu que s'il est **propre** : un appariement
        // qui laisse des écarts locaux ne prouve pas que le point d'entrée a bougé.
        // Un appariement enraciné qui réussit prouve l'isomorphisme des parties
        // atteignables ; le résidu est traité ensuite comme pour tout ancrage.
        if let Ok(anchored) = matcher.expand_from(*candidate, readback_entry) {
            if anchored.local.is_empty() {
                return MovedAnchor::Found(*candidate);
            }
        }
    }
    matcher.reset();
    if truncated {
        MovedAnchor::Truncated
    } else {
        MovedAnchor::None
    }
}

enum Residual {
    Complete,
    Divergences(Vec<Divergence>),
    Ambiguous(String),
    Budget,
}

/// Apparie ce qui n'est pas atteignable depuis l'ancrage. Le nombre de stages
/// compte ; ces composantes doivent donc se correspondre elles aussi.
fn match_residual(
    matcher: &mut Matcher<'_>,
    colors: &Colors,
    observations: &mut Observations,
) -> Residual {
    let mut arbitrary_choice = false;
    loop {
        let unmatched_source: Vec<usize> = (0..matcher.source.len())
            .filter(|index| matcher.map[*index].is_none())
            .collect();
        let unmatched_readback: Vec<usize> = (0..matcher.readback.len())
            .filter(|index| matcher.rmap[*index].is_none())
            .collect();

        if unmatched_source.is_empty() && unmatched_readback.is_empty() {
            return Residual::Complete;
        }
        if unmatched_source.is_empty() || unmatched_readback.is_empty() {
            let (side, count) = if unmatched_source.is_empty() {
                ("relu", unmatched_readback.len())
            } else {
                ("source", unmatched_source.len())
            };
            return Residual::Divergences(vec![Divergence {
                code: DivergenceCode::UnmatchedStage,
                witness: "hors atteinte depuis l'ancrage".to_string(),
                detail: format!("{count} stage(s) sans correspondant, côté {side}"),
            }]);
        }

        // On commence par le stage résiduel le plus contraint : moins de candidats,
        // moins de choix arbitraires, diagnostic plus net en cas d'écart.
        let mut best: Option<(usize, Vec<usize>)> = None;
        for source_candidate in &unmatched_source {
            let color = colors.source[*source_candidate];
            let candidates: Vec<usize> = unmatched_readback
                .iter()
                .copied()
                .filter(|readback_candidate| colors.readback[*readback_candidate] == color)
                .collect();
            let better = best
                .as_ref()
                .is_none_or(|(_, current)| candidates.len() < current.len());
            if better {
                let empty = candidates.is_empty();
                best = Some((*source_candidate, candidates));
                if empty {
                    break;
                }
            }
        }

        let Some((source_candidate, candidates)) = best else {
            return Residual::Complete;
        };
        if candidates.is_empty() {
            return Residual::Divergences(vec![Divergence {
                code: DivergenceCode::UnmatchedStage,
                witness: format!("hors atteinte : {}", matcher.source.name(source_candidate)),
                detail: format!(
                    "aucun stage relu de même forme pour {} ; {} stage(s) résiduel(s) source, {} relu(s)",
                    matcher.source.name(source_candidate),
                    unmatched_source.len(),
                    unmatched_readback.len()
                ),
            }]);
        }
        if candidates.len() > 1 {
            arbitrary_choice = true;
            observations.residual_arbitrary_choices += 1;
        }

        let snapshot = (
            matcher.map.clone(),
            matcher.rmap.clone(),
            matcher.parent.clone(),
        );
        let mut matched = false;
        let mut first_failure: Option<Divergence> = None;
        for candidate in candidates {
            match matcher.expand_from(source_candidate, candidate) {
                Ok(anchored) if anchored.local.is_empty() => {
                    matched = true;
                    break;
                }
                Ok(anchored) => {
                    // Un résidu apparié mais divergent localement reste un écart
                    // exploitable : on le retient si aucun candidat propre n'existe.
                    if first_failure.is_none() {
                        first_failure = anchored.local.into_iter().next();
                    }
                    matcher.map.clone_from(&snapshot.0);
                    matcher.rmap.clone_from(&snapshot.1);
                    matcher.parent.clone_from(&snapshot.2);
                }
                Err(MatchError::Budget) => return Residual::Budget,
                Err(MatchError::Structural(gap)) => {
                    if first_failure.is_none() {
                        first_failure = Some(*gap);
                    }
                    matcher.map.clone_from(&snapshot.0);
                    matcher.rmap.clone_from(&snapshot.1);
                    matcher.parent.clone_from(&snapshot.2);
                }
            }
        }

        if !matched {
            if arbitrary_choice {
                return Residual::Ambiguous(format!(
                    "partie non atteignable : aucun appariement confirmé pour {} après un choix arbitraire ; ni équivalence ni écart prouvés",
                    matcher.source.name(source_candidate)
                ));
            }
            return Residual::Divergences(vec![first_failure.unwrap_or(Divergence {
                code: DivergenceCode::UnmatchedStage,
                witness: format!("hors atteinte : {}", matcher.source.name(source_candidate)),
                detail: "aucun appariement possible dans la partie non atteignable".to_string(),
            })]);
        }
    }
}

/// Partage d'assets **à travers la bijection** : deux stages qui partageaient un
/// audio le partagent-ils encore ? Observation seule — les médias ne sont comparés
/// qu'en présence, et compter un éclatement comme échec ajouterait un critère
/// non déclaré.
fn collect_asset_sharing(matcher: &Matcher<'_>, observations: &mut Observations) {
    for image in [false, true] {
        let mut forward: HashMap<&str, HashSet<&str>> = HashMap::new();
        let mut backward: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (source_index, readback_index) in matcher.map.iter().enumerate() {
            let Some(readback_index) = readback_index else {
                continue;
            };
            let source_stage = matcher.source.stage(source_index);
            let readback_stage = matcher.readback.stage(*readback_index);
            let (left, right) = if image {
                (
                    source_stage.image.as_deref(),
                    readback_stage.image.as_deref(),
                )
            } else {
                (
                    source_stage.audio.as_deref(),
                    readback_stage.audio.as_deref(),
                )
            };
            let (Some(left), Some(right)) = (left, right) else {
                continue;
            };
            forward.entry(left).or_default().insert(right);
            backward.entry(right).or_default().insert(left);
        }
        let splits = forward.values().filter(|targets| targets.len() > 1).count();
        let merges = backward
            .values()
            .filter(|sources| sources.len() > 1)
            .count();
        if image {
            observations.image_sharing_splits = splits;
            observations.image_sharing_merges = merges;
        } else {
            observations.audio_sharing_splits = splits;
            observations.audio_sharing_merges = merges;
        }
    }
}

/// Sépare les écarts défalqués (pertes connues du lecteur) de ceux qui
/// restent imputables au trajet testé. La liste de production est vide.
fn split_known_losses(
    divergences: Vec<Divergence>,
    known_losses: &[ReaderKnownLoss],
) -> (Vec<Divergence>, Vec<Divergence>) {
    let mut remaining = Vec::new();
    let mut deducted = Vec::new();
    for gap in divergences {
        let known = known_losses
            .iter()
            .find(|loss| loss.code == gap.code && (loss.matches)(&gap));
        match known {
            Some(loss) => deducted.push(Divergence {
                detail: format!(
                    "[{} — perte connue du lecteur] {}",
                    loss.question, gap.detail
                ),
                ..gap
            }),
            None => remaining.push(gap),
        }
    }
    (remaining, deducted)
}
