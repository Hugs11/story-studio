// Sélectionner un nœud ouvre-t-il son panneau d'édition ? Préférence de
// l'application, commune aux deux éditeurs : les Réglages du Libre et
// l'Inspecteur du graphe répondent à la même règle.
//
// Activée par défaut : on désigne un nœud — dans l'arbre, le diagramme, la
// liste ou le graphe — pour l'éditer, seul ou en sélection multiple, puisque le
// panneau agit aussi sur plusieurs nœuds. Désactivée, le panneau fermé le reste
// et la sélection ne se cache pas derrière lui : c'est ce que veut un auteur
// qui compose une sélection pour la déplacer.
//
// Relue au moment du clic par `readSelectionOpensSettings`, et suivie par les
// Préférences au travers de `subscribeSelectionOpensSettings`.

import { KEYS, read, write } from './persistentSettings.js';

export const DEFAULT_SELECTION_OPENS_SETTINGS = true;

const listeners = new Set();
let cached = null;

export function readSelectionOpensSettings() {
  if (cached !== null) return cached;
  const raw = read(KEYS.SELECTION_OPENS_SETTINGS);
  cached = raw === null ? DEFAULT_SELECTION_OPENS_SETTINGS : raw === 'true';
  return cached;
}

export function writeSelectionOpensSettings(enabled) {
  cached = enabled === true;
  write(KEYS.SELECTION_OPENS_SETTINGS, String(cached));
  for (const listener of listeners) listener();
}

export function subscribeSelectionOpensSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// La règle : une sélection non vide, faite par l'auteur, ouvre le panneau s'il
// est fermé et si la préférence le permet.
export function shouldOpenSettingsForSelection(count, { panelOpen, enabled = readSelectionOpensSettings() }) {
  return enabled && !panelOpen && count > 0;
}

// Pour les essais : oublier la valeur lue, sans toucher au stockage.
export function resetSelectionOpensSettingsCache() {
  cached = null;
}
