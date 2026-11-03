// Navigation au clavier et à la souris dans les vues du catalogue (grille de
// cartes, liste, détails). Fonctions pures : elles disent quelle fiche devient
// active, quelle action de sélection appliquer et quelle commande lancer ; le
// hook applique le résultat.
//
// Grille : flèches gauche/droite d'une carte, haut/bas d'une rangée
// (`columns`) ; liste et détails : `columns` = 1. Début/Fin : première ou
// dernière fiche ; PageHaut/PageBas : `pageRows` rangées. Un déplacement simple
// sélectionne la fiche atteinte ; avec Ctrl/Cmd il ne déplace que le focus ;
// avec Maj il étend la plage depuis l'ancre. Espace bascule la fiche active,
// Entrée ouvre la fiche complète, touche menu ou Maj+F10 ouvre le menu.

const MOVES = Object.freeze({
  ArrowRight: (index, { columns }) => (columns > 1 ? index + 1 : index),
  ArrowLeft: (index, { columns }) => (columns > 1 ? index - 1 : index),
  ArrowDown: (index, { columns }) => index + columns,
  ArrowUp: (index, { columns }) => index - columns,
  Home: () => 0,
  End: (index, { count }) => count - 1,
  PageDown: (index, { columns, pageRows }) => index + columns * pageRows,
  PageUp: (index, { columns, pageRows }) => index - columns * pageRows,
});

function clamp(value, count) {
  return Math.min(Math.max(value, 0), count - 1);
}

/**
 * @param {{activeId: string|null, order: string[], columns?: number, pageRows?: number}} state
 * @param {{key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @returns {null | {activeId: string|null, selection: object|null, command: null|'open'|'menu', handled: true}}
 *   `null` : touche non gérée (elle suit son comportement natif).
 */
export function navigateKey(state, event) {
  const order = state.order ?? [];
  const count = order.length;
  const columns = Math.max(1, Math.floor(state.columns ?? 1));
  const pageRows = Math.max(1, Math.floor(state.pageRows ?? 5));
  const command = event.ctrlKey || event.metaKey;
  const current = state.activeId !== null ? order.indexOf(state.activeId) : -1;
  const activeId = current >= 0 ? state.activeId : null;

  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    return activeId ? { activeId, selection: null, command: 'menu', handled: true } : null;
  }
  if (event.key === 'Enter') {
    return activeId ? { activeId, selection: null, command: 'open', handled: true } : null;
  }
  if (event.key === ' ' || event.key === 'Spacebar') {
    return activeId ? { activeId, selection: { type: 'toggle', id: activeId }, command: null, handled: true } : null;
  }
  const move = MOVES[event.key];
  if (!move || !count) return null;
  const target = order[clamp(current < 0 ? 0 : move(current, { columns, count, pageRows }), count)];
  let selection = { type: 'click', id: target };
  if (event.shiftKey) selection = { type: 'range', id: target, order };
  else if (command) selection = null;
  return { activeId: target, selection, command: null, handled: true };
}

/**
 * Action de sélection d'un clic sur une fiche : simple = remplace,
 * Ctrl/Cmd = ajoute ou retire, Maj = plage depuis l'ancre (ordre affiché).
 */
export function pointerSelection({ id, order, shiftKey = false, ctrlKey = false, metaKey = false }) {
  if (shiftKey) return { type: 'range', id, order };
  if (ctrlKey || metaKey) return { type: 'toggle', id };
  return { type: 'click', id };
}

/**
 * Fiche active après un changement de résultats : conservée si elle est
 * encore visible, sinon la plus proche de son ancienne position.
 */
export function keepActive(activeId, previousOrder, order) {
  if (!order.length) return null;
  if (activeId !== null && order.includes(activeId)) return activeId;
  const previous = activeId === null ? -1 : (previousOrder ?? []).indexOf(activeId);
  return order[clamp(previous < 0 ? 0 : previous, order.length)];
}

/**
 * Nombre de colonnes d'une grille mesurée : éléments de la première rangée
 * (même ordonnée que le premier). `tops` : positions verticales dans l'ordre.
 */
export function columnsFromTops(tops) {
  if (!Array.isArray(tops) || !tops.length) return 1;
  const first = tops[0];
  let columns = 0;
  for (const top of tops) {
    if (Math.abs(top - first) > 1) break;
    columns += 1;
  }
  return Math.max(1, columns);
}
