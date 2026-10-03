// Le repli de la barre d'outils média : ce qui reste visible, et ce qui passe
// sous le bouton « … » quand la place manque.
//
// La largeur nécessaire est **dérivée du contenu**, pas d'une constante unique.
// Une constante unique ne serait juste que si la barre avait toujours les
// mêmes huit actions : le seuil de 300 px valait exactement « huit boutons plus
// les trois widgets de fin de barre ». Côté graphe, la barre n'a que cinq
// actions et aucun widget de fin ; le même seuil l'aurait repliée en entier
// dans un menu, ce qui aurait rendu les quatre outils de son difficiles à
// trouver.
//
// Le panneau emploie des cellules de 27 px ; le L ancré au canvas en emploie
// de 37 px, séparateur compris. Le même calcul garde la recherche visible et
// replie les actions secondaires avant que la barre ne déborde.

export const STRUCTURE_ACTION_SLOT_WIDTH = 27;
export const CANVAS_STRUCTURE_ACTION_SLOT_WIDTH = 37;
// Les widgets posés en fin de barre par le panneau de structure : recherche et
// affichage de l'arbre. Ils ne sont pas des actions, mais ils occupent la même
// rangée et doivent donc entrer dans le calcul.
export const STRUCTURE_ACTIONS_TRAILING_SLOTS = 3;

export function structureActionsRequiredWidth(actionCount, {
  hasTrailing = false,
  slotWidth = STRUCTURE_ACTION_SLOT_WIDTH,
  trailingSlots = STRUCTURE_ACTIONS_TRAILING_SLOTS,
} = {}) {
  const slots = actionCount + (hasTrailing ? trailingSlots : 0);
  return slots * slotWidth;
}

export function partitionStructureActions(actions, {
  variant = 'floating',
  inlineSize = null,
  hasTrailing = false,
  slotWidth = STRUCTURE_ACTION_SLOT_WIDTH,
  trailingSlots = STRUCTURE_ACTIONS_TRAILING_SLOTS,
} = {}) {
  const compact = Number.isFinite(inlineSize)
    ? inlineSize < structureActionsRequiredWidth(actions.length, {
      hasTrailing, slotWidth, trailingSlots,
    })
    : variant === 'panel';

  if (!compact) {
    return {
      directActions: actions,
      overflowActions: [],
    };
  }

  return {
    directActions: actions.filter((action) => action.priority === 'primary'),
    overflowActions: actions.filter((action) => action.priority !== 'primary'),
  };
}
