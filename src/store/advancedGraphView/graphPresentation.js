import { defaultHomeReturnOf } from './defaultHomeReturns.js';
import { ACTION_KIND } from './graphViewModel.js';

export const PRESENTATION_CONNECTIONS = 'connections';
const PRESENTATION_PLAYBACK = 'playback';

const isHome = (edge) => edge?.kind === 'stage-home';

function addNode(index, nodes, next, path) {
  if (!path || !index.byPath.has(path)) return;
  nodes.add(path);
  next.add(path);
}

function expandBusinessStep(index, path, nodes, edges, showReturns) {
  const center = index.byPath.get(path);
  const next = new Set();
  if (!center) return next;

  if (center.kind === ACTION_KIND) {
    for (const edge of index.incoming.get(path) ?? []) {
      if (!showReturns && isHome(edge)) continue;
      edges.add(edge.edgeId);
      addNode(index, nodes, next, edge.from);
    }
    for (const edge of index.outgoing.get(path) ?? []) {
      edges.add(edge.edgeId);
      addNode(index, nodes, next, edge.to);
    }
    return next;
  }

  // Sorties métier : Écran → Action → destinations. On ne remonte pas ici
  // vers les autres Écrans qui emploient la même Action : ils ne sont pas une
  // destination du centre.
  for (const stageEdge of index.outgoing.get(path) ?? []) {
    if (!showReturns && isHome(stageEdge)) continue;
    edges.add(stageEdge.edgeId);
    const actionPath = stageEdge.to;
    if (!actionPath || !index.byPath.has(actionPath)) continue;
    nodes.add(actionPath);
    for (const option of index.outgoing.get(actionPath) ?? []) {
      edges.add(option.edgeId);
      addNode(index, nodes, next, option.to);
    }
  }

  // Entrées métier : origines → Action → Écran. Même règle dans l'autre sens :
  // on garde toutes les occurrences d'option, sans explorer les autres sorties
  // de l'Action à ce niveau.
  for (const option of index.incoming.get(path) ?? []) {
    edges.add(option.edgeId);
    const actionPath = option.from;
    if (!actionPath || !index.byPath.has(actionPath)) continue;
    nodes.add(actionPath);
    for (const stageEdge of index.incoming.get(actionPath) ?? []) {
      if (!showReturns && isHome(stageEdge)) continue;
      edges.add(stageEdge.edgeId);
      addNode(index, nodes, next, stageEdge.from);
    }
  }
  return next;
}

// Voisinage borné. Un niveau depuis un Écran franchit l'Action intermédiaire
// pour montrer ses vraies origines et destinations ; depuis une Action, il
// montre directement ses Écrans entrants et sortants. Les niveaux suivants
// répètent ce palier métier sans parcourir un cycle deux fois.
export function connectionNeighborhood(index, centerPath, levels = 1, { showReturns = true } = {}) {
  const center = index?.byPath.get(centerPath);
  if (!center) return { centerPath, levels, nodePaths: [], edgeIds: [] };
  const nodes = new Set([centerPath]);
  const edges = new Set();
  let frontier = new Set([centerPath]);
  const visited = new Set([centerPath]);

  for (let depth = 0; depth < Math.max(1, levels) && frontier.size > 0; depth += 1) {
    const next = new Set();
    for (const path of frontier) {
      for (const candidate of expandBusinessStep(index, path, nodes, edges, showReturns)) {
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        next.add(candidate);
      }
    }
    frontier = next;
  }
  return { centerPath, levels, nodePaths: [...nodes], edgeIds: [...edges] };
}

// L'Écran joué n'a pas de marque propre : c'est la sélection qui le suit.
export function playbackPresentation(trace, { followCamera = true } = {}) {
  return {
    mode: PRESENTATION_PLAYBACK,
    nodePaths: [...(trace?.nodePaths ?? [])],
    edgeIds: [...(trace?.edgeIds ?? [])],
    followCamera,
  };
}

export function extendPlaybackTrace(index, trace, previousStagePath, nextStagePath, context = null) {
  const nodePaths = new Set(trace?.nodePaths ?? []);
  const edgeIds = new Set(trace?.edgeIds ?? []);
  if (previousStagePath) nodePaths.add(previousStagePath);
  if (nextStagePath) nodePaths.add(nextStagePath);
  const actionPath = context?.actionNodeId ?? null;
  if (actionPath) {
    nodePaths.add(actionPath);
    const stageEdge = (index?.outgoing.get(previousStagePath) ?? []).find((edge) => (
      edge.to === actionPath && (!context.slot || edge.kind === `stage-${context.slot}`)
    ));
    if (stageEdge) edgeIds.add(stageEdge.edgeId);
    const optionEdge = (index?.outgoing.get(actionPath) ?? []).find((edge) => (
      edge.to === nextStagePath && edge.ordinal === context.optionIdx
    ));
    if (optionEdge) edgeIds.add(optionEdge.edgeId);
  }
  return { nodePaths: [...nodePaths], edgeIds: [...edgeIds] };
}

// Les deux bouts d'un lien, nommés, pour l'étiquette de survol. Un trait droit
// qui croise un nœud sur son chemin se lit comme s'il en partait ; l'étiquette
// dit d'où il part et où il arrive, même quand un bout est hors de l'écran.
export function describeEdgeEnds(index, edgeId) {
  if (!index || !edgeId) return null;
  // Le retour par défaut de la Lunii n'est pas une arête du document :
  // l'étiquette dit qu'il vient de l'appareil.
  const derived = defaultHomeReturnOf(index, edgeId);
  if (derived) {
    const labelOf = (path) => index.byPath.get(path)?.label?.label ?? null;
    return {
      from: labelOf(derived.from),
      to: labelOf(derived.to),
      via: 'Bouton Accueil',
      term: 'retour par défaut de la Lunii, hors du pack',
    };
  }
  for (const edges of index.outgoing.values()) {
    const edge = edges.find((candidate) => candidate.edgeId === edgeId);
    if (!edge) continue;
    const labelOf = (path) => (path ? index.byPath.get(path)?.label?.label ?? null : null);
    // La sortie d'un Écran se nomme comme dans son panneau, avec son terme
    // technique : « Suite du parcours · okTransition ».
    let via;
    let term = null;
    if (edge.kind === 'stage-ok') {
      // Le même trait sert l'appui sur OK et la fin du son : l'étiquette dit
      // lesquels l'activent, quand l'Écran le sait.
      const controls = index.byPath.get(edge.from)?.node?.controls;
      const on = (key) => controls?.[key]?.presence === 'value' && controls[key].value === true;
      const triggers = [on('ok') && 'OK', on('autoplay') && 'fin du son'].filter(Boolean);
      via = triggers.length > 0 ? `Suite du parcours, par ${triggers.join(' ou ')}` : 'Suite du parcours';
      term = 'okTransition';
    } else if (isHome(edge)) {
      via = 'Bouton Accueil';
      term = 'homeTransition';
    } else via = Number.isInteger(edge.ordinal) ? `choix ${edge.ordinal + 1}` : 'choix';
    return {
      from: labelOf(edge.from),
      to: labelOf(edge.to) ?? 'destination à choisir',
      via,
      term,
    };
  }
  return null;
}
