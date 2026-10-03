// Les rôles d'un nœud, calculés **une fois** et lus par toutes les surfaces.
//
// Avant ce module, le canvas, la liste et les filtres disaient trois choses
// différentes du même nœud : « détaché » valait « sans lien entrant » sur la
// carte peinte et « sans aucun lien » dans le filtre, et une simple fin de
// parcours prenait le badge « à corriger » sans qu'aucun diagnostic ne
// l'établisse. Un rôle peint quelque part doit être retrouvable partout, sous
// le même nom et avec la même règle : c'est la seule raison d'être de ce
// fichier.
//
// Aucun rôle n'est inventé. Chacun se lit dans le DTO — l'entrée, l'unicité de
// l'identifiant, les diagnostics du moteur natif — ou se déduit des seules
// arêtes. « Inaccessible depuis l'entrée » n'est calculé que lorsque le pack
// désigne **exactement une** entrée ; sans entrée, ou avec plusieurs
// candidates, il reste indéterminé et personne ne l'affiche : une accessibilité
// mesurée depuis un départ arbitraire serait une erreur fabriquée.

// Les carrefours mis en avant sous 3 % de zoom (handoff, planche 3b).
const HUB_COUNT = 5;
// Le moins de liens qu'un carrefour porte. Un nœud de passage en a deux, un
// qui arrive et un qui repart : il ne croise rien. Sans ce plancher, un petit
// pack remplissait les cinq places avec ce qu'il avait, jusqu'à une Action à
// un seul lien posée en repère à côté de la racine.
const HUB_MIN_DEGREE = 3;

export const NODE_ROLES = Object.freeze({
  ENTRY: 'entry',
  DIAGNOSED: 'diagnosed',
  DUPLICATE: 'duplicate',
  ISOLATED: 'isolated',
  NO_INCOMING: 'noIncoming',
  UNREACHABLE: 'unreachable',
  DEAD_END: 'deadEnd',
  DANGLING: 'dangling',
});

// L'ordre de lecture : ce qui situe le nœud avant ce qui le met en doute, et un
// défaut établi par le moteur natif avant une déduction de notre part.
const ROLE_ORDER = Object.freeze([
  NODE_ROLES.ENTRY,
  NODE_ROLES.DIAGNOSED,
  NODE_ROLES.DUPLICATE,
  NODE_ROLES.DANGLING,
  NODE_ROLES.ISOLATED,
  NODE_ROLES.NO_INCOMING,
  NODE_ROLES.UNREACHABLE,
  NODE_ROLES.DEAD_END,
]);

// Un index est une lecture jetable, reconstruite à chaque révision du document.
// Les rôles suivent donc sa durée de vie, et seulement la sienne.
const cache = new WeakMap();

export function nodeRoles(index) {
  if (!index) return emptyRoles();
  const known = cache.get(index);
  if (known) return known;
  const computed = computeRoles(index);
  cache.set(index, computed);
  return computed;
}

function emptyRoles() {
  return {
    byPath: new Map(),
    hubs: new Set(),
    counts: countsOf([]),
    reachabilityKnown: false,
    of: () => NEUTRAL,
  };
}

const NEUTRAL = Object.freeze({
  entry: false, diagnosed: false, duplicate: false, isolated: false,
  noIncoming: false, unreachable: false, deadEnd: false, dangling: false,
  hub: false, incomingCount: 0, outgoingCount: 0, degree: 0,
});

function computeRoles(index) {
  const entries = index.entries ?? [];
  const edges = index.view?.edges ?? [];

  const incoming = new Map();
  const outgoing = new Map();
  const dangling = new Set();
  const targets = new Map();
  for (const edge of edges) {
    // Une destination réservée sans cible — celle qu'une Action reçoit à sa
    // création, pour être raccordée avant que l'Écran suivant existe — n'est
    // pas une sortie : elle ne mène nulle part. Elle est signalée « à
    // raccorder », et ne compte ni dans les sorties ni dans le degré.
    if (edge.to === null || edge.to === undefined) {
      dangling.add(edge.from);
      continue;
    }
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    const list = targets.get(edge.from);
    if (list) list.push(edge.to);
    else targets.set(edge.from, [edge.to]);
  }

  // Les carrefours : les cinq nœuds les plus reliés parmi ceux qui ont au
  // moins trois liens, départagés par leur chemin pour que deux lectures du
  // même document donnent le même dessin. Un petit pack peut n'en avoir aucun.
  const hubs = new Set(
    entries
      .map((entry) => ({
        path: entry.path,
        degree: (incoming.get(entry.path) ?? 0) + (outgoing.get(entry.path) ?? 0),
      }))
      .filter((entry) => entry.degree >= HUB_MIN_DEGREE)
      .sort((left, right) => right.degree - left.degree || left.path.localeCompare(right.path))
      .slice(0, HUB_COUNT)
      .map((entry) => entry.path),
  );

  const entryPaths = entries.filter((entry) => entry.node?.squareOne?.value === true);
  const reachabilityKnown = entryPaths.length === 1;
  const reached = reachabilityKnown ? reachableFrom(entryPaths[0].path, targets) : null;

  const byPath = new Map();
  for (const entry of entries) {
    const incomingCount = incoming.get(entry.path) ?? 0;
    const outgoingCount = outgoing.get(entry.path) ?? 0;
    const isEntry = entry.node?.squareOne?.value === true;
    byPath.set(entry.path, Object.freeze({
      entry: isEntry,
      diagnosed: (index.diagnosticsByNode?.get(entry.path) ?? []).length > 0,
      duplicate: entry.node?.uniqueId === false,
      dangling: dangling.has(entry.path),
      isolated: incomingCount === 0 && outgoingCount === 0,
      // Sans entrée : personne n'y mène. L'Écran de départ du pack est la seule
      // exception légitime, et il n'est donc pas signalé.
      noIncoming: incomingCount === 0 && outgoingCount > 0 && !isEntry,
      unreachable: reached !== null && !reached.has(entry.path),
      deadEnd: outgoingCount === 0,
      hub: hubs.has(entry.path),
      incomingCount,
      outgoingCount,
      degree: incomingCount + outgoingCount,
    }));
  }

  const roles = {
    byPath,
    hubs,
    counts: countsOf(byPath.values()),
    reachabilityKnown,
    of: (path) => byPath.get(path) ?? NEUTRAL,
  };
  return roles;
}

// Parcours en largeur depuis l'entrée, avec la garde de visite qui borne les
// cycles : un pack à plat en contient par construction.
function reachableFrom(start, targets) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const next of targets.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function countsOf(all) {
  const counts = {};
  for (const role of ROLE_ORDER) counts[role] = 0;
  for (const entry of all) {
    for (const role of ROLE_ORDER) {
      if (entry[role]) counts[role] += 1;
    }
  }
  return counts;
}
