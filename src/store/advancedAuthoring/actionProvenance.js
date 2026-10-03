// Ce que le panneau d'une Action dit de ses provenances et de l'ordre de ses
// destinations, sans React.
//
// Le panneau a trois encadrés — les destinations, éditables, les arrivées par
// OK, qui racontent l'histoire, et les retours HOME, la navigation de sortie,
// souvent nombreuse et répétitive : sur un pack mesuré, 170 retours pour une
// seule arrivée par OK. Les destinations n'y sont plus répétées.
//
// Un groupe de retours HOME dit **sur quelle destination** il tombe, plutôt
// que « option 7 » : le rang seul obligeait à remonter la liste pour le
// traduire.

import { ACTION_KIND } from '../advancedGraphView/graphViewModel.js';

const STAGE_HOME = 'stage-home';

// La destination sur laquelle une transition arrive dans l'Action : un rang et
// l'Écran qu'il désigne, le hasard, ou rien de lisible.
export function landingOf(index, action, selection) {
  if (selection?.kind === 'random') return { random: true, key: 'random' };
  if (selection?.kind !== 'fixed' || !Number.isInteger(selection.index)) {
    return { unknown: true, key: 'unknown' };
  }
  const rank = selection.index;
  const option = action?.node?.options?.[rank] ?? null;
  const stagePath = option?.target?.stagePath ?? null;
  return {
    rank,
    stagePath,
    label: stagePath ? index.byPath.get(stagePath)?.label?.label ?? null : null,
    missing: option === null,
    key: `fixed:${rank}`,
  };
}

// Les provenances d'une Action : les arrivées par OK une à une, les retours
// HOME regroupés par destination d'arrivée, dans l'ordre des rangs.
export function describeActionProvenance(index, actionPath) {
  const action = index?.byPath.get(actionPath) ?? null;
  if (!action || action.kind !== ACTION_KIND) return { ok: [], home: { total: 0, groups: [] } };

  const ok = [];
  const groups = new Map();
  for (const edge of index.incoming.get(actionPath) ?? []) {
    const source = index.byPath.get(edge.from) ?? null;
    if (!source) continue;
    const row = {
      key: edge.edgeId,
      sourcePath: edge.from,
      source,
      landing: landingOf(index, action, edge.selection),
    };
    if (edge.kind !== STAGE_HOME) {
      ok.push(row);
      continue;
    }
    const group = groups.get(row.landing.key) ?? { landing: row.landing, rows: [] };
    group.rows.push(row);
    groups.set(row.landing.key, group);
  }

  // Les rangs d'abord, dans leur ordre ; le hasard et l'illisible ensuite.
  const weight = (landing) => (Number.isInteger(landing.rank) ? landing.rank : landing.random ? 1e9 : 1e9 + 1);
  const sorted = [...groups.values()].sort((left, right) => weight(left.landing) - weight(right.landing));
  const total = sorted.reduce((sum, group) => sum + group.rows.length, 0);
  return { ok, home: { total, groups: sorted } };
}

// La permutation que `reorder-action-options` attend quand une destination
// glisse du rang `from` au rang `to` : `newPositionOfOld[i]` est la place que
// prend l'occurrence de rang `i`. Les destinations entre les deux se décalent
// d'un cran ; aucune cible n'est déplacée, seuls les rangs le sont.
export function movePermutation(length, from, to) {
  const order = Array.from({ length }, (unused, rank) => rank);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const places = new Array(length);
  order.forEach((oldRank, newRank) => { places[oldRank] = newRank; });
  return places;
}
