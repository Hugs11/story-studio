// Ce que le panneau d'un Écran dit de ses touches et des listes de choix où il figure,
// sans React. Le pendant de `actionProvenance.js`, dans les mêmes termes.
//
// - Destinations : les deux touches de l'Écran, OK et HOME. Chacune mène à une
//   Action, et arrive sur l'une de ses destinations — le rang dit laquelle, et
//   le nom de l'Écran qu'il désigne le dit mieux.
// - Listes de choix : chaque Action (« Liste de choix » pour l'auteur) qui
//   propose cet Écran, sa place dans la liste, et quand elle y amène
//   vraiment : **à l'ouverture**, par un Écran qui ouvre la liste en
//   commençant sur ce choix (ou au hasard), ou **à la molette**, depuis un choix voisin
//   dont la molette est active. Figurer dans une liste ne suffit pas : un
//   Écran qui ouvre la liste sur un autre choix ne mène pas ici.

import { ACTION_KIND, STAGE_KIND } from '../advancedGraphView/graphViewModel.js';
import { landingOf } from './actionProvenance.js';

const STAGE_SLOTS = ['ok', 'home'];

const STAGE_HOME = 'stage-home';

function stageLabel(index, stagePath) {
  return stagePath ? index.byPath.get(stagePath)?.label?.label ?? null : null;
}

// Les destinations d'un Écran : une ligne par touche, dans l'ordre OK puis
// HOME. `presence` distingue « aucune destination » (`null`) d'une donnée
// absente du document ; les deux se lisent vides.
export function describeStageDestinations(index, stagePath) {
  const stage = index?.byPath.get(stagePath) ?? null;
  if (!stage || stage.kind !== STAGE_KIND) return [];
  return STAGE_SLOTS.map((slot) => {
    const transition = slot === 'ok' ? stage.node.okTransition : stage.node.homeTransition;
    const presence = transition?.presence ?? 'absent';
    const actionPath = presence === 'value' ? transition.actionPath ?? null : null;
    const action = actionPath ? index.byPath.get(actionPath) ?? null : null;
    const options = (action?.node?.options ?? []).map((option, rank) => ({
      key: option.optionId,
      rank,
      stagePath: option.target?.stagePath ?? null,
      label: stageLabel(index, option.target?.stagePath ?? null),
    }));
    return {
      slot,
      presence,
      actionPath,
      action,
      actionLabel: action?.label?.label ?? transition?.actionId ?? null,
      landing: presence === 'value' ? landingOf(index, action, transition.selection) : null,
      options,
    };
  });
}

// La molette d'un Écran : `true`, `false`, ou `null` quand elle n'est pas
// définie.
function wheelOf(entry) {
  const member = entry?.node?.controls?.wheel;
  return member?.presence === 'value' ? member.value === true : null;
}

// Les choix voisins d'un rang, dans l'ordre de la molette : précédent puis
// suivant. La molette boucle, comme sur la Lunii ; une liste de deux choix n'a
// qu'un voisin, une liste d'un choix n'en a aucun.
function neighboursOf(index, options, rank) {
  const count = options.length;
  if (count < 2) return [];
  const ranks = [...new Set([(rank - 1 + count) % count, (rank + 1) % count])];
  return ranks.map((neighbour, position) => {
    const stagePath = options[neighbour]?.target?.stagePath ?? null;
    const entry = stagePath ? index.byPath.get(stagePath) ?? null : null;
    return {
      key: `${neighbour}`,
      side: ranks.length === 1 ? 'both' : position === 0 ? 'previous' : 'next',
      rank: neighbour,
      stagePath,
      label: entry?.label?.label ?? null,
      wheel: wheelOf(entry),
      wraps: position === 0 ? neighbour > rank : neighbour < rank,
    };
  });
}

// Les listes de choix qui proposent un Écran : une ligne par occurrence, avec
// sa place (`rank` sur `count`), les Écrans qui ouvrent la liste sur ce choix
// (`direct`), et les
// voisins d'où la molette y mène. `ok`/`home` gardent tous les Écrans qui
// ouvrent la liste, quel que soit leur point de départ.
export function describeStageMemberships(index, stagePath) {
  const stage = index?.byPath.get(stagePath) ?? null;
  if (!stage || stage.kind !== STAGE_KIND) return [];
  const rows = [];
  for (const edge of index.incoming.get(stagePath) ?? []) {
    const action = index.byPath.get(edge.from) ?? null;
    if (!action || action.kind !== ACTION_KIND) continue;
    const openers = { ok: [], home: [] };
    const direct = [];
    for (const stageEdge of index.incoming.get(edge.from) ?? []) {
      const source = index.byPath.get(stageEdge.from) ?? null;
      if (!source) continue;
      const slot = stageEdge.kind === STAGE_HOME ? 'home' : 'ok';
      const opener = { key: stageEdge.edgeId, sourcePath: stageEdge.from, source, slot };
      openers[slot].push(opener);
      const landing = landingOf(index, action, stageEdge.selection);
      if (landing.random) direct.push({ ...opener, random: true });
      else if (landing.rank === edge.ordinal) direct.push({ ...opener, random: false });
    }
    const options = action.node?.options ?? [];
    rows.push({
      key: edge.edgeId,
      actionPath: edge.from,
      action,
      rank: edge.ordinal,
      count: options.length,
      // Les arrivées par la suite du parcours d'abord : elles racontent
      // l'histoire ; les retours par Accueil ensuite.
      direct: [...direct.filter((opener) => opener.slot === 'ok'), ...direct.filter((opener) => opener.slot === 'home')],
      neighbours: neighboursOf(index, options, edge.ordinal),
      ...openers,
    });
  }
  return rows;
}
