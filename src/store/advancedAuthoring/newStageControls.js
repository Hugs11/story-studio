// Les boutons d'un Écran créé dans l'éditeur graphe : un réglage de départ
// retenu par l'auteur, préférence de l'application et non du projet.
//
// Mesuré sur un pack réel de 259 Écrans, aucun réglage n'est majoritaire : un
// tiers d'écrans de choix (Molette, OK, HOME), un tiers d'histoires (HOME,
// Pause, Lecture automatique), un tiers d'écrans de passage (OK, HOME). Le
// réglage de départ est donc celui des écrans de choix, le plus fréquent, et
// l'auteur en retient un autre quand il enchaîne une série d'écrans d'une
// autre sorte. Un Écran créé tout éteint n'avait ni OK ni lecture
// automatique : on ne pouvait pas en sortir.
//
// Les cinq booléens sont exigés de l'appelant : une valeur lue est donc
// complétée par le réglage de départ, jamais transmise partielle.

import { ADVANCED_CONTROL_KEYS } from '../projectModel/advancedGestures.js';
import { KEYS, read, write } from '../persistentSettings.js';

export const DEFAULT_NEW_STAGE_CONTROLS = Object.freeze({
  wheel: true, ok: true, home: true, pause: false, autoplay: false,
});

function normalize(value) {
  return Object.fromEntries(ADVANCED_CONTROL_KEYS.map((key) => [
    key,
    typeof value?.[key] === 'boolean' ? value[key] : DEFAULT_NEW_STAGE_CONTROLS[key],
  ]));
}

let cached = null;

export function readNewStageControls() {
  if (cached) return cached;
  cached = Object.freeze(normalize(read(KEYS.ADVANCED_NEW_STAGE_CONTROLS, {
    parse: (raw) => {
      try { return JSON.parse(raw); } catch { return null; }
    },
  })));
  return cached;
}

export function writeNewStageControls(controls) {
  cached = Object.freeze(normalize(controls));
  write(KEYS.ADVANCED_NEW_STAGE_CONTROLS, cached, { serialize: JSON.stringify });
}

export function sameControls(left, right) {
  return ADVANCED_CONTROL_KEYS.every((key) => left?.[key] === right?.[key]);
}

// Les cinq valeurs d'un Écran, quand elles sont toutes posées : seul un réglage
// complet peut devenir celui des nouveaux Écrans.
export function completeStageControls(controls) {
  if (!ADVANCED_CONTROL_KEYS.every((key) => controls?.[key]?.presence === 'value')) return null;
  return Object.fromEntries(ADVANCED_CONTROL_KEYS.map((key) => [key, controls[key].value === true]));
}

// Pour les essais : oublier la valeur lue, sans toucher au stockage.
export function resetNewStageControlsCache() {
  cached = null;
}
