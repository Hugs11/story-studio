// Le nom donné à un nœud créé sans nom dans l'Éditeur graphe.
//
// Un Écran sans nom s'affichait par son UUID, une Action par le repli
// historique « Action node ». Un nœud créé ici reçoit donc un vrai nom
// d'auteur, numéroté par nature : « Écran 1 », « Écran 2 »… et, pour une
// Action — « Liste de choix » pour l'auteur —, « Liste 1 », « Liste 2 »… L'identifiant reste l'identité ; le nom n'est qu'un libellé,
// renommable comme n'importe quel autre.
//
// Le numéro est **le plus grand existant plus un** : un numéro libéré par une
// suppression n'est jamais réattribué, pour qu'un nouveau nœud ne se fasse pas
// passer pour celui qu'on vient de retirer. Seuls les noms exactement de la
// forme « Écran N » comptent — « Écran 3 bis » est un nom d'auteur, pas un
// numéro.

import { STAGE_KIND } from '../advancedGraphView/graphViewModel.js';

const DEFAULT_STAGE_PREFIX = 'Écran';
const DEFAULT_ACTION_PREFIX = 'Liste';

function prefixOf(kind) {
  return kind === STAGE_KIND ? DEFAULT_STAGE_PREFIX : DEFAULT_ACTION_PREFIX;
}

// `reserved` porte les noms déjà promis à des créations que l'index ne montre
// pas encore : la vue est relue par un aller-retour **après** le geste, et une
// création enchaînée dans cette fenêtre recevrait sinon le même numéro.
export function nextDefaultNodeName(index, kind, reserved = []) {
  const prefix = prefixOf(kind);
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  let highest = 0;
  const consider = (text) => {
    const match = typeof text === 'string' ? pattern.exec(text.trim()) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  };
  for (const entry of index?.entries ?? []) {
    if (entry.kind !== kind) continue;
    const name = entry.node?.name;
    if (name?.presence === 'value') consider(name.value);
  }
  for (const name of reserved ?? []) consider(name);
  return `${prefix} ${highest + 1}`;
}

// Les noms promis que l'index ne porte pas encore. Comme les places réservées,
// la liste se purge d'elle-même dès que la vue relue montre le nœud.
export function pruneReservedNames(reserved, index) {
  if (!reserved?.length) return [];
  const shown = new Set();
  for (const entry of index?.entries ?? []) {
    const name = entry.node?.name;
    if (name?.presence === 'value' && typeof name.value === 'string') shown.add(name.value.trim());
  }
  return reserved.filter((name) => !shown.has(name));
}
