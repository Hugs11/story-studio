// Le filtre compare uniquement le seuil « dès N ans » ; ageMax reste dans les données.
import { AGE_LIMIT } from './entryModel.js';

// Filtrage : borne maximale ; édition : âge minimal écrit sur les fiches.
export const AGE_PRESETS = Object.freeze([2, 3, 4, 5, 7, 9]);

export const EMPTY_AGE_FILTER = Object.freeze({ min: null, max: null, hideUnknown: false });

function bound(value) {
  return value === null || value === undefined || value === '' ? null : value;
}

/**
 * Valide les bornes saisies. Un minimum supérieur au maximum n'est jamais
 * inversé : le filtre d'âge est alors inactif et un message local est rendu.
 * @returns {{valid: boolean, active: boolean, min: number|null, max: number|null,
 *   error: null | {key: string, params: object}}}
 */
export function validateAgeFilter(filter = EMPTY_AGE_FILTER) {
  const min = bound(filter.min);
  const max = bound(filter.max);
  for (const value of [min, max]) {
    if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= AGE_LIMIT)) {
      return { valid: false, active: false, min, max, error: { key: 'catalogue:filter.age.outOfRange', params: { limit: AGE_LIMIT } } };
    }
  }
  if (min !== null && max !== null && min > max) {
    return { valid: false, active: false, min, max, error: { key: 'catalogue:filter.age.minAboveMax', params: { min, max } } };
  }
  return { valid: true, active: min !== null || max !== null, min, max, error: null };
}

/**
 * Tranche comparable d'un pack, ou `null` si son âge est inconnu ou
 * contradictoire.
 */
export function packAgeRange(age) {
  return Number.isInteger(age?.min) && age.min >= 0 ? { min: age.min, max: age.min } : null;
}

/**
 * Résultat pour une fiche : `match`, `excluded`, `unknown` (affichée sauf si
 * la case de masquage est cochée) ou `invalid` (idem, classée à part).
 * Sans filtre actif, aucune exclusion pour raison d'âge.
 */
export function evaluateAge(age, filter = EMPTY_AGE_FILTER) {
  const validation = validateAgeFilter(filter);
  if (!validation.active) return { visible: true, outcome: 'inactive' };
  const range = packAgeRange(age);
  if (!range) {
    const outcome = age?.kind === 'invalid' ? 'invalid' : 'unknown';
    return { visible: filter.hideUnknown !== true, outcome };
  }
  const overlaps = (validation.max === null || range.min <= validation.max)
    && (validation.min === null || range.max >= validation.min);
  return { visible: overlaps, outcome: overlaps ? 'match' : 'excluded' };
}

/** Récapitulatif du filtre d'âge actif, en clés de traduction. */
export function ageFilterSummary(filter = EMPTY_AGE_FILTER) {
  const validation = validateAgeFilter(filter);
  if (!validation.active) return [];
  const items = [ageFilterLabel(validation, { summary: true })];
  if (filter.hideUnknown === true) items.push({ key: 'catalogue:filter.age.unknownHidden', params: {} });
  return items;
}

/** Libellé du bouton d'âge ; ses clés restent celles de la présentation actuelle. */
export function ageFilterLabel(filter, { summary = false } = {}) {
  // Bornes égales : un âge exact (« 6 ans »), jamais « 6 à 6 ans ».
  if (filter.min !== null && filter.min === filter.max) return { key: summary ? 'catalogue:filter.age.exact' : 'catalogue:details.age.exact', params: { count: filter.min } };
  if (filter.min !== null) return filter.max !== null
    ? { key: summary ? 'catalogue:filter.age.range' : 'catalogue:age.range', params: { min: filter.min, count: filter.max } }
    : { key: summary ? 'catalogue:filter.age.from' : 'catalogue:palette.minimumAge', params: { count: filter.min } };
  return filter.max !== null ? { key: 'catalogue:palette.forAge', params: { count: filter.max } }
    : { key: 'catalogue:age.button', params: {} };
}
