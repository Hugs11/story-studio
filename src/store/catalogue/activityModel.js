// Activité du catalogue montrée dans la pastille de la barre d'outils.
//
// Chaque élément a une **signature** : l'effacer la retient pour la session
// (en mémoire, jamais dans le stockage du navigateur). Il réapparaît seulement
// si sa signature change, c'est-à-dire si la situation change (autre ensemble
// de packs introuvables, autre suggestion, autre message).
//
// Ton : `issue` (ambre, à régler), `progress` (travail en cours), `info`
// (simple information) ou `success` (bilan réussi).

export function createActivityDismissals() {
  let dismissed = new Set();
  const listeners = new Set();
  return {
    has: (signature) => dismissed.has(signature),
    dismiss(signature) {
      if (dismissed.has(signature)) return;
      dismissed = new Set(dismissed).add(signature);
      for (const listener of listeners) listener();
    },
    snapshot: () => dismissed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// Durée de vie : celle de l'application. L'écran Catalogue peut se fermer et
// se rouvrir sans faire revenir ce qui a été effacé.
export const activityDismissals = createActivityDismissals();

export const ACTIVITY_GROUPS = Object.freeze(['issue', 'progress', 'info']);

/** Le groupe d'affichage d'un ton : bilans réussis et informations ensemble. */
export function activityGroup(tone) {
  return tone === 'success' ? 'info' : tone;
}

/** Retire les éléments effacés et range par groupe, dans l'ordre d'arrivée. */
export function visibleActivity(items, dismissed) {
  const visible = items.filter((item) => !item.signature || !dismissed.has(item.signature));
  return ACTIVITY_GROUPS.flatMap((group) => visible.filter((item) => activityGroup(item.tone) === group));
}

/** La couleur suit le contenu dominant ; le compteur couvre toutes les entrées. */
export function activityPill(items) {
  if (items.length === 0) return null;
  const state = items.some(item => item.tone === 'issue') ? 'issues'
    : items.some(item => item.tone === 'progress') ? 'progress'
      : items.every(item => item.kind === 'summary') ? 'ok' : 'info';
  return { state, count: items.length, label: 'catalogue:activity.pill.info' };
}

/** Signature d'un ensemble d'identifiants, indépendante de l'ordre. */
export function idsSignature(prefix, ids) {
  return `${prefix}:${[...new Set(ids)].sort().join('|')}`;
}
