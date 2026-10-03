//! Ancrages du contexte d'auteur : inventaire, retrait ciblé et retargeting.
//!
//! Le codec de lecture ne produit **aucun diagnostic ciblé d'ancrage
//! orphelin** : une suppression de nœud peut détacher un membre opaque, une
//! disposition ou une position ancrés par chemin sans que rien ne le signale.
//! Ce module y répond : il rend les ancrages observables et les
//! maintient dans le même geste que la mutation qui les menace.
//!
//! Deux mécanismes distincts, souvent confondus :
//!
//! - le **retrait** d'un nœud invalide les ancrages qui le désignent, lui et sa
//!   descendance ;
//! - le retrait décale aussi l'**occurrence** des nœuds homonymes qui le
//!   suivent, parce que `stable_node_paths` ancre sur `@id=valeur#occurrence`.
//!   Sans retargeting, l'ancrage du second nœud d'un identifiant dupliqué
//!   (décodable mais invalide) se rabattrait silencieusement sur
//!   un autre nœud. C'est un détachement **muet**, pire qu'un orphelin visible.

use serde::Serialize;

use crate::native_pack::{
    stable_node_paths, DecodedStoryDocument, EditorPosition, ExportQualification, ImportDiagnostic,
    NodeColor, OpaqueMember, PositionExportDecision, SeveredTransition, StoryDocument,
    StoryDocumentContext, ValueProvenance,
};

/// Le sort réservé à un ancrage par une mutation.
pub(crate) enum AnchorFate {
    Keep,
    Remove,
    Retarget(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnchorRetarget {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// Ce qu'un geste a fait des ancrages, et ce qu'il a trouvé en arrivant.
///
/// `preexisting_orphans` n'est pas une faute du geste : un document ouvert peut
/// déjà porter des ancrages détachés auparavant. Les distinguer
/// évite à la fois de refuser un projet légitime et de s'attribuer un dégât
/// qu'on n'a pas causé.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnchorReport {
    pub(crate) removed: Vec<String>,
    pub(crate) retargeted: Vec<AnchorRetarget>,
    pub(crate) preexisting_orphans: Vec<String>,
}

/// Un enregistrement de contexte ancré par chemin d'auteur.
trait Anchored {
    fn anchor(&self) -> &str;
    fn set_anchor(&mut self, path: String);
}

macro_rules! anchored {
    ($($type:ty),+ $(,)?) => {
        $(impl Anchored for $type {
            fn anchor(&self) -> &str {
                &self.path
            }

            fn set_anchor(&mut self, path: String) {
                self.path = path;
            }
        })+
    };
}

anchored!(
    ValueProvenance,
    EditorPosition,
    NodeColor,
    SeveredTransition,
    PositionExportDecision,
    ExportQualification,
    OpaqueMember,
    ImportDiagnostic,
);

/// Les chemins de nœuds réellement portés par le document, dans son ordre.
pub(crate) fn node_anchor_paths(document: &StoryDocument) -> Vec<String> {
    let mut paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    paths.extend(stable_node_paths(
        &document.action_nodes,
        "actionNodes",
        "id",
        |action| action.id.as_str(),
    ));
    paths
}

/// Le nœud désigné par un chemin d'ancrage, ou `None` pour un chemin racine.
///
/// Le découpage sur `/` est sûr : `stable_node_paths` échappe déjà les `/` d'un
/// identifiant en `~1`, donc un segment ne peut pas en contenir.
fn node_prefix(path: &str) -> Option<String> {
    let mut segments = path.split('/');
    segments.next()?;
    let collection = segments.next()?;
    if collection != "stageNodes" && collection != "actionNodes" {
        return None;
    }
    let node = segments.next()?;
    Some(format!("/{collection}/{node}"))
}

/// Les ancrages du contexte qui désignent un nœud absent du document.
pub(crate) fn orphan_anchors(payload: &DecodedStoryDocument) -> Vec<String> {
    let known = node_anchor_paths(&payload.document);
    let mut orphans: Vec<String> = context_anchor_paths(&payload.context)
        .into_iter()
        .filter(|path| node_prefix(path).is_some_and(|prefix| !known.contains(&prefix)))
        .collect();
    orphans.sort();
    orphans.dedup();
    orphans
}

fn context_anchor_paths(context: &StoryDocumentContext) -> Vec<String> {
    let mut paths = Vec::new();
    let mut collect = |entries: &mut dyn Iterator<Item = &str>| {
        paths.extend(entries.map(str::to_string));
    };
    collect(&mut context.value_provenance.iter().map(Anchored::anchor));
    collect(&mut context.editor_positions.iter().map(Anchored::anchor));
    collect(&mut context.node_colors.iter().map(Anchored::anchor));
    collect(&mut context.severed_transitions.iter().map(Anchored::anchor));
    collect(
        &mut context
            .position_export_decisions
            .iter()
            .map(Anchored::anchor),
    );
    collect(&mut context.export_qualifications.iter().map(Anchored::anchor));
    collect(&mut context.opaque_members.iter().map(Anchored::anchor));
    collect(&mut context.diagnostics.iter().map(Anchored::anchor));
    paths
}

fn rewrite_family<T: Anchored>(
    entries: &mut Vec<T>,
    decide: &mut dyn FnMut(&str) -> AnchorFate,
    report: &mut AnchorReport,
) {
    let mut kept = Vec::with_capacity(entries.len());
    for mut entry in std::mem::take(entries) {
        match decide(entry.anchor()) {
            AnchorFate::Keep => kept.push(entry),
            AnchorFate::Remove => report.removed.push(entry.anchor().to_string()),
            AnchorFate::Retarget(to) => {
                report.retargeted.push(AnchorRetarget {
                    from: entry.anchor().to_string(),
                    to: to.clone(),
                });
                entry.set_anchor(to);
                kept.push(entry);
            }
        }
    }
    *entries = kept;
}

/// Applique une décision à **toutes** les familles d'ancrage du contexte.
///
/// Les familles sont énumérées ici et nulle part ailleurs : un champ ancré
/// ajouté au contexte sans passer par cette liste serait le prochain
/// détachement muet.
pub(crate) fn rewrite_context_anchors(
    context: &mut StoryDocumentContext,
    mut decide: impl FnMut(&str) -> AnchorFate,
    report: &mut AnchorReport,
) {
    let decide: &mut dyn FnMut(&str) -> AnchorFate = &mut decide;
    rewrite_family(&mut context.value_provenance, decide, report);
    rewrite_family(&mut context.editor_positions, decide, report);
    rewrite_family(&mut context.node_colors, decide, report);
    rewrite_family(&mut context.severed_transitions, decide, report);
    rewrite_family(&mut context.position_export_decisions, decide, report);
    rewrite_family(&mut context.export_qualifications, decide, report);
    rewrite_family(&mut context.opaque_members, decide, report);
    rewrite_family(&mut context.diagnostics, decide, report);
}

/// La décision d'ancrage d'un retrait de nœud : retirer sous `removed`,
/// retarger sous chaque décalage d'occurrence, conserver le reste.
///
/// `shifts` vient d'une comparaison des chemins avant/après retrait, jamais
/// d'un calcul d'occurrence refait à la main : les deux resteraient à
/// synchroniser avec `stable_node_paths`.
pub(crate) fn removal_fate(removed: &str, shifts: &[AnchorRetarget], path: &str) -> AnchorFate {
    if is_at_or_below(path, removed) {
        return AnchorFate::Remove;
    }
    for shift in shifts {
        if is_at_or_below(path, &shift.from) {
            return AnchorFate::Retarget(format!("{}{}", shift.to, &path[shift.from.len()..]));
        }
    }
    AnchorFate::Keep
}

fn is_at_or_below(path: &str, node: &str) -> bool {
    path == node || (path.starts_with(node) && path.as_bytes().get(node.len()) == Some(&b'/'))
}

/// Les décalages d'occurrence produits par le retrait du nœud d'indice `index`.
///
/// `before` et `after` sont les chemins stables de la **même** collection, de
/// part et d'autre du retrait. Comparer les deux listes est la seule façon de
/// rester exact quand plusieurs nœuds partagent un identifiant.
pub(crate) fn occurrence_shifts(
    before: &[String],
    after: &[String],
    index: usize,
) -> Vec<AnchorRetarget> {
    before
        .iter()
        .enumerate()
        .filter(|(position, _)| *position != index)
        .map(|(_, path)| path)
        .zip(after)
        .filter(|(from, to)| from != to)
        .map(|(from, to)| AnchorRetarget {
            from: from.clone(),
            to: to.clone(),
        })
        .collect()
}
