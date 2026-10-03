// Miroir JS de `native_pack/option_selection.rs` — la sélection d'option du
// dialecte STUdio v1.
//
// `optionIndex = -1` est la sentinelle RANDOM : le writer STUdio l'écrit pour le
// port `randomOptionIn`, son reader la reconnecte à ce port, et son simulateur
// tire un index **à chaque nouvelle entrée** dans l'ActionNode. Elle doit être
// préservée telle quelle et n'est jamais rabattue vers `0`.
//
// Ce module est la seule interprétation JS de `optionIndex` : les consommateurs
// (simulateur ZIP, vue de graphe natif) passent par lui plutôt que de tester le
// signe eux-mêmes.

export const RANDOM_OPTION_INDEX = -1;

export const OPTION_SELECTION = Object.freeze({
  RANDOM: 'random',
  FIXED: 'fixed',
});

// Décode la valeur brute du dialecte.
//   -1        -> { kind: 'random' }
//   i >= 0    -> { kind: 'fixed', index: i }
//   autre     -> null (valeur hors dialecte : le décodeur Rust la refuse déjà)
export function parseOptionSelection(rawOptionIndex) {
  if (!Number.isInteger(rawOptionIndex)) return null;
  if (rawOptionIndex === RANDOM_OPTION_INDEX) {
    return { kind: OPTION_SELECTION.RANDOM };
  }
  if (rawOptionIndex < 0) return null;
  return { kind: OPTION_SELECTION.FIXED, index: rawOptionIndex };
}

// Réencode vers la valeur du dialecte, pour une écriture ou une comparaison.
export function optionSelectionToDialectIndex(selection) {
  if (selection?.kind === OPTION_SELECTION.RANDOM) return RANDOM_OPTION_INDEX;
  if (selection?.kind === OPTION_SELECTION.FIXED) return selection.index;
  return null;
}

// Les indices d'options que la sélection peut désigner, sans tirer au sort.
// `random` les désigne tous ; `fixed` n'en désigne qu'un, et aucun hors bornes.
export function optionSelectionCandidates(selection, optionCount) {
  if (!Number.isInteger(optionCount) || optionCount <= 0) return [];
  if (selection?.kind === OPTION_SELECTION.RANDOM) {
    return Array.from({ length: optionCount }, (_, index) => index);
  }
  if (selection?.kind === OPTION_SELECTION.FIXED && selection.index < optionCount) {
    return [selection.index];
  }
  return [];
}

// Bornes : `random` exige au moins une option, `fixed(i)` exige `i < N`.
export function optionSelectionIsWithinBounds(selection, optionCount) {
  return optionSelectionCandidates(selection, optionCount).length > 0;
}

// Une source d'aléa injectable, pour que le tirage soit déterministe en test.
// `random` doit rendre un flottant dans [0, 1[, comme `Math.random`.
export function createOptionDrawSource(random = Math.random) {
  return (optionCount) => Math.min(optionCount - 1, Math.floor(random() * optionCount));
}

// La destination initiale d'une entrée dans l'Action.
//
// Rend `null` quand la sélection ne désigne aucune option : l'appelant reste
// alors où il est plutôt que d'inventer l'option 0. Le tirage a lieu à chaque
// appel — c'est la cadence du dialecte, et la raison pour laquelle
// la source est injectée au lieu d'être tirée une fois pour toutes.
export function selectInitialOption(selection, optionCount, drawSource) {
  const candidates = optionSelectionCandidates(selection, optionCount);
  if (candidates.length === 0) return null;
  if (selection.kind !== OPTION_SELECTION.RANDOM) return selection.index;
  const draw = (drawSource ?? createOptionDrawSource())(optionCount);
  return Number.isInteger(draw) && draw >= 0 && draw < optionCount ? draw : null;
}

// Résout la destination initiale d'une transition du dialecte sur une Action.
// Rend `{ index, target }` ou `null` — jamais une cible de repli.
export function resolveTransitionEntry(transition, action, drawSource) {
  const options = Array.isArray(action?.options) ? action.options : [];
  const selection = parseOptionSelection(transition?.optionIndex);
  const index = selectInitialOption(selection, options.length, drawSource);
  if (index === null) return null;
  const target = options[index];
  return typeof target === 'string' && target.length > 0 ? { index, target } : null;
}
