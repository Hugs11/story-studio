// Index de lecture dérivé du DTO Rust.
//
// Ce module ne connaît **aucun moteur d'affichage** : il ne produit ni nœud
// Cytoscape, ni donnée G6, ni élément de rendu. Il range ce que la recherche,
// la sélection et l'inspecteur doivent consulter, et rien d'autre. Le banc
// d'essai des moteurs reste ainsi abordable et son verdict réversible.
//
// Il ne mute pas le DTO et n'en dérive aucune vérité : le document d'auteur est
// l'unique vérité sémantique, et l'index en est une lecture jetable,
// reconstruite à chaque révision de document.

import { normalizeFrenchSearchText } from '../../utils/frenchText.js';

export const STAGE_KIND = 'stage';
export const ACTION_KIND = 'action';

// Le nom que STUdio donne d'office à une Action, et le repli du moteur pour
// une Action sans nom (`ACTION_NODE_FALLBACK_NAME`, `native_pack/document.rs`).
const STUDIO_UNNAMED_ACTION = 'Action node';
// Ce que l'auteur lit à sa place : une Liste de choix qui n'a pas de nom.
const UNNAMED_LIST_LABEL = 'Liste sans nom';

// Le libellé d'affichage d'un nœud, avec l'information « est-ce un repli ? ».
//
// Un repli historique — `""` pour un Écran sans nom, `"Action node"` pour une
// Action sans nom — est **exposé comme tel**, jamais présenté comme une valeur
// d'auteur. Sans ce drapeau, l'inspecteur laisserait croire qu'un nom existe.
//
// Une Action nommée exactement « Action node » n'a pas de nom d'auteur non
// plus : STUdio écrit ce texte d'office dans le `story.json`. Les deux se
// lisent « Liste sans nom ». Seul l'affichage change : le document garde sa
// valeur, et le pack généré aussi.
export function nodeLabel(node) {
  const authored = node.name?.presence === 'value' ? node.name.value : null;
  const fallback = node.fallbackLabel ?? '';
  const isAction = fallback === STUDIO_UNNAMED_ACTION;
  if (typeof authored === 'string' && authored.trim() !== ''
    && !(isAction && authored.trim() === STUDIO_UNNAMED_ACTION)) {
    return { label: authored, isFallback: false };
  }
  if (isAction) return { label: UNNAMED_LIST_LABEL, isFallback: true };
  if (fallback.trim() !== '') return { label: fallback, isFallback: true };
  // Dernier recours : l'identifiant source. Il est toujours présent, et le
  // montrer vaut mieux qu'une ligne vide dans une liste de 9 121 entrées.
  return { label: node.uuid ?? node.id ?? '', isFallback: true };
}

// Vrai pour un Écran d'entrée (`squareOne: true` explicite). Il n'est jamais le
// choix d'une liste : STUdio lui retire sa prise d'arrivée, et le moteur refuse
// le geste (`ENTRY_STAGE_AS_OPTION`).
export function isEntryStage(entry) {
  const squareOne = entry?.node?.squareOne;
  return entry?.kind === STAGE_KIND && squareOne?.presence === 'value' && squareOne.value === true;
}

// L'identifiant source d'un nœud, quelle que soit sa collection.
function nodeIdentifier(node) {
  return node.uuid ?? node.id ?? '';
}

function searchableText(node, kind, label) {
  const type = kind === STAGE_KIND ? node.stageType : node.actionType;
  return [
    label,
    nodeIdentifier(node),
    type?.presence === 'value' ? type.value : '',
    node.groupId?.presence === 'value' ? node.groupId.value : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// Construit l'index d'une vue. Une seule passe par collection et par arête :
// le coût reste linéaire, ce qu'exigent les très gros packs.
export function buildGraphIndex(view) {
  const entries = [];
  const byPath = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const mediaByNode = new Map();

  // Les listes sans nom sont numérotées dans l'ordre du document : vingt
  // « Liste sans nom » identiques ne se distinguent plus sur le graphe.
  // Affichage seul, comme le repli lui-même.
  let unnamedLists = 0;
  const displayLabel = (node) => {
    const label = nodeLabel(node);
    if (label.isFallback && label.label === UNNAMED_LIST_LABEL) {
      unnamedLists += 1;
      return { label: `${UNNAMED_LIST_LABEL} ${unnamedLists}`, isFallback: true };
    }
    return label;
  };

  const register = (node, kind) => {
    const label = displayLabel(node);
    const entry = {
      kind,
      path: node.path,
      node,
      // Les textes de recherche sont calculés **une fois**, à la construction :
      // les recalculer à chaque frappe coûterait une passe complète par
      // caractère sur un profil à 9 121 nœuds.
      haystack: normalizeFrenchSearchText(searchableText(node, kind, label.label)),
      label,
    };
    entries.push(entry);
    byPath.set(node.path, entry);
    outgoing.set(node.path, []);
    incoming.set(node.path, []);
  };

  for (const stage of view.stages ?? []) register(stage, STAGE_KIND);
  for (const action of view.actions ?? []) register(action, ACTION_KIND);

  for (const edge of view.edges ?? []) {
    outgoing.get(edge.from)?.push(edge);
    // Une arête pendante n'a pas de cible : elle reste sortante et visible,
    // elle n'entre simplement dans l'entrant de personne.
    if (edge.to) incoming.get(edge.to)?.push(edge);
  }

  for (const media of view.mediaRefs ?? []) {
    for (const usage of media.usages ?? []) {
      const list = mediaByNode.get(usage.nodePath) ?? [];
      list.push({ assetRef: media.assetRef, field: usage.field, usageCount: media.usages.length });
      mediaByNode.set(usage.nodePath, list);
    }
  }

  const diagnosticsByNode = new Map();
  for (const diagnostic of view.diagnostics ?? []) {
    if (!diagnostic.nodePath) continue;
    const list = diagnosticsByNode.get(diagnostic.nodePath) ?? [];
    list.push(diagnostic);
    diagnosticsByNode.set(diagnostic.nodePath, list);
  }

  return {
    view,
    entries,
    byPath,
    outgoing,
    incoming,
    mediaByNode,
    diagnosticsByNode,
  };
}

function findNode(index, path) {
  return index.byPath.get(path) ?? null;
}

// Ce qu'un inspecteur affiche d'un nœud, **en lecture seule**.
//
// Il ne joint jamais un booléen de contrôle à une transition et ne présente
// aucune absence comme un `false` : il transporte les présences telles que le
// DTO les rend.
export function inspectNode(index, path) {
  const entry = findNode(index, path);
  if (!entry) return null;
  return {
    kind: entry.kind,
    path: entry.path,
    identifier: nodeIdentifier(entry.node),
    label: entry.label,
    node: entry.node,
    // Un identifiant dupliqué reste lisible, mais les gestes le refuseront :
    // l'inspecteur doit pouvoir l'expliquer **avant** de proposer le geste.
    editableByIdentifier: entry.node.uniqueId === true,
    outgoing: index.outgoing.get(path) ?? [],
    incoming: index.incoming.get(path) ?? [],
    media: index.mediaByNode.get(path) ?? [],
    diagnostics: index.diagnosticsByNode.get(path) ?? [],
  };
}

// Les nœuds qu'aucune arête n'atteint et dont aucune arête ne part.
//
// Ils sont dans l'index comme les autres — la projection énumère les
// collections au lieu de parcourir depuis l'entrée — et cette liste ne sert
// qu'à les **proposer** dans la recherche, jamais à les traiter à part.
export function detachedPaths(index) {
  return index.entries
    .filter((entry) => (index.outgoing.get(entry.path) ?? []).length === 0
      && (index.incoming.get(entry.path) ?? []).length === 0)
    .map((entry) => entry.path);
}

// L'étendue occupée par la disposition, mesurée sur les valeurs **reçues**.
//
// Elle sert à cadrer la vue à l'ouverture. Elle est mesurée et non supposée :
// on ne reprend pas les limites de zoom du diagramme Libre sans avoir mesuré
// les étendues réelles, et un quadrillage FS atteint `x = 376 960` là où un
// pack STUdio tient dans quelques milliers de pixels.
export function layoutExtent(index) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entry of index.entries) {
    const { x, y } = entry.node.layout ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    return { empty: true, minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  return {
    empty: false,
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
