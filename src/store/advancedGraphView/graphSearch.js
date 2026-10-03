// Recherche et liste navigable.
//
// Le canvas n'expose rien au DOM : l'accessibilité et le clavier passent
// intégralement par cette liste et par l'inspecteur. Ce n'est pas un bonus,
// c'est le chemin principal — et c'est un coût assumé du rendu canvas, quel que
// soit le moteur retenu.
//
// La sélection reste donc exploitable **même quand le nœud n'est pas dessiné**
// dans le viewport : la liste travaille sur l'index, jamais sur ce que le
// moteur a bien voulu rendre à ce zoom.
//
// Les filtres de rôle lisent `graphRoles` : le même calcul que la carte
// peinte, sous le même nom. Sans cela « détaché » désignait deux ensembles
// différents selon la surface, et un nœud marqué sur le canvas pouvait ne
// figurer dans aucun filtre.

import { ACTION_KIND, STAGE_KIND } from './graphViewModel.js';
import { NODE_ROLES, nodeRoles } from './graphRoles.js';
import { normalizeFrenchSearchText } from '../../utils/frenchText.js';

export const SEARCH_SCOPES = Object.freeze({
  ALL: 'all',
  STAGES: STAGE_KIND,
  ACTIONS: ACTION_KIND,
  // « Détaché » veut dire **isolé** : ni lien entrant, ni lien sortant. C'est
  // la règle que la liste appliquait déjà ; c'est désormais aussi celle de la
  // pastille peinte.
  DETACHED: 'detached',
  NO_INCOMING: 'no-incoming',
  DEAD_END: 'dead-end',
  DUPLICATED: 'duplicated',
  UNREACHABLE: 'unreachable',
  DIAGNOSED: 'diagnosed',
});

// Le rôle interrogé par chaque filtre de rôle. Un filtre absent de cette table
// n'est pas un filtre de rôle (`all`, `stage`, `action`).
const SCOPE_ROLES = Object.freeze({
  [SEARCH_SCOPES.DETACHED]: NODE_ROLES.ISOLATED,
  [SEARCH_SCOPES.NO_INCOMING]: NODE_ROLES.NO_INCOMING,
  [SEARCH_SCOPES.DEAD_END]: NODE_ROLES.DEAD_END,
  [SEARCH_SCOPES.DUPLICATED]: NODE_ROLES.DUPLICATE,
  [SEARCH_SCOPES.UNREACHABLE]: NODE_ROLES.UNREACHABLE,
  [SEARCH_SCOPES.DIAGNOSED]: NODE_ROLES.DIAGNOSED,
});

// Nombre de résultats rendus par défaut lorsque l'appelant n'en demande pas
// d'autre. La liste, elle, demande **tout** et ne matérialise qu'une fenêtre :
// une borne posée ici la rendait définitivement inatteignable au clavier
// au-delà du deux-centième résultat.
const DEFAULT_RESULT_LIMIT = 200;

export function searchGraph(index, {
  query = '',
  scope = SEARCH_SCOPES.ALL,
  limit = DEFAULT_RESULT_LIMIT,
} = {}) {
  const needle = normalizeFrenchSearchText(query).trim();
  const role = SCOPE_ROLES[scope] ?? null;
  const roles = role ? nodeRoles(index) : null;
  const results = [];
  let total = 0;

  for (const entry of index.entries) {
    if (!matchesScope(entry, scope, role, roles)) continue;
    if (needle !== '' && !entry.haystack.includes(needle)) continue;
    total += 1;
    if (results.length < limit) results.push(entry);
  }

  return { results, total, truncated: total > results.length };
}

function matchesScope(entry, scope, role, roles) {
  if (role) return roles.of(entry.path)[role] === true;
  switch (scope) {
    case SEARCH_SCOPES.STAGES:
      return entry.kind === STAGE_KIND;
    case SEARCH_SCOPES.ACTIONS:
      return entry.kind === ACTION_KIND;
    default:
      return true;
  }
}

// Déplacement au clavier dans la liste des résultats. Le focus reste **dans la
// liste** : parcourir les résultats ne déplace pas la caméra, et n'est donc pas
// un geste de vue.
export function moveListFocus(results, currentPath, delta) {
  if (results.length === 0) return null;
  const current = results.findIndex((entry) => entry.path === currentPath);
  if (current === -1) return results[delta > 0 ? 0 : results.length - 1].path;
  const next = Math.min(results.length - 1, Math.max(0, current + delta));
  return results[next].path;
}
