// Filtres du catalogue. Les familles se combinent par ET ; plusieurs valeurs
// d'une même famille par OU, sauf les étiquettes (toutes requises par défaut,
// interrupteur « au moins une »).
//
// Format, dossier source et disponibilité sont des contraintes d'exemplaire :
// elles doivent être satisfaites par au moins un même exemplaire. « ZIP +
// dossier A » ne retient donc pas une fiche dont le ZIP est dans B et dont
// seul le projet est dans A.
//
// Les familles dont les données ne sont pas encore publiées (langue,
// étiquettes, état projet/pack) savent s'évaluer, mais la liste
// de leurs valeurs possibles reste vide tant qu'aucune fiche n'en porte.

import { EMPTY_AGE_FILTER, ageFilterSummary, evaluateAge, validateAgeFilter } from './ageFilter.js';
import { FORMAT_ORDER, PROJECT_TYPES } from './entryModel.js';

/** Disponibilité des exemplaires retenus ; les packs hors ligne restent visibles par défaut. */
export const AVAILABILITY_VALUES = Object.freeze(['available', 'unavailable', 'all']);

/** Métadonnées dont l'absence peut être recherchée. */
export const MISSING_FIELDS = Object.freeze(['title', 'age', 'description', 'author', 'language', 'cover']);

export const DEFAULT_FILTERS = Object.freeze({
  age: EMPTY_AGE_FILTER,
  languages: Object.freeze([]),
  formats: Object.freeze([]),
  projectTypes: Object.freeze([]),
  sourceIds: Object.freeze([]),
  tags: Object.freeze({ ids: Object.freeze([]), mode: 'any' }),
  packStates: Object.freeze([]),
  missing: Object.freeze([]),
  favoritesOnly: false,
  incompleteOnly: false,
  missingFilesOnly: false,
  hideOfficial: false,
  availability: 'all',
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** Complète un état de filtres partiel avec les valeurs par défaut. */
export function normalizeFilters(filters = {}) {
  // Anciennes sessions : les tableaux vides existaient déjà à côté de contentKind.
  const { contentKind, ...current } = filters ?? {};
  const formats = list(current.formats);
  const legacyFormats = contentKind === 'project' ? ['project']
    : contentKind === 'pack' ? ['zip', 'sevenZip', 'folder'] : [];
  return {
    ...DEFAULT_FILTERS,
    ...current,
    formats: formats.length ? formats : legacyFormats,
    age: { ...EMPTY_AGE_FILTER, ...(current.age ?? {}) },
    // Le filtre d'étiquettes est toujours « au moins une » : un ancien mode « all » restauré retombe sur « any ».
    tags: { ...DEFAULT_FILTERS.tags, ...(current.tags ?? {}), mode: 'any' },
    availability: AVAILABILITY_VALUES.includes(current.availability) ? current.availability : 'all',
  };
}

function isMissing(card, field) {
  switch (field) {
    case 'title': return card.title === null;
    case 'age': return card.age?.kind === 'unknown';
    case 'description': return card.description === null;
    case 'author': return card.author === null;
    case 'language': return card.language === null;
    case 'cover': return card.cover === null || card.cover === undefined;
    default: return false;
  }
}

/** Prédicat des contraintes d'exemplaire (format, source, disponibilité). */
export function exemplarPredicate(filters) {
  const formats = list(filters.formats);
  const sources = list(filters.sourceIds);
  const availability = filters.availability ?? 'all';
  return (exemplar) => (formats.length === 0 || formats.includes(exemplar.format))
    && (sources.length === 0 || exemplar.sourceIds.some((id) => sources.includes(id)))
    && (availability === 'all' || (availability === 'available') === exemplar.available);
}

function cardLevelMatch(card, filters) {
  if (filters.incompleteOnly && !isMissing(card, 'cover') && !isMissing(card, 'age')) return false;
  if (filters.missingFilesOnly && card.offlineReason !== 'missing') return false;
  if (filters.hideOfficial && card.official === true) return false;
  const languages = list(filters.languages);
  if (languages.length && !languages.includes(card.language)) return false;
  const projectTypes = list(filters.projectTypes);
  if (projectTypes.length && !card.projectTypes.some((type) => projectTypes.includes(type))) return false;
  const tagIds = list(filters.tags?.ids);
  if (tagIds.length) {
    const own = new Set(card.tags.map((tag) => tag.id));
    const ok = tagIds.some((id) => own.has(id));
    if (!ok) return false;
  }
  const packStates = list(filters.packStates);
  if (packStates.length && !packStates.includes(card.packState)) return false;
  const missing = list(filters.missing);
  if (missing.length && !missing.some((field) => isMissing(card, field))) return false;
  if (filters.favoritesOnly === true && !card.favorite) return false;
  return true;
}

/**
 * Évalue une fiche. Renvoie `null` si elle est exclue, sinon les exemplaires
 * qui satisfont ensemble les contraintes d'exemplaire (dans l'ordre de la
 * fiche) et le résultat du filtre d'âge.
 */
export function evaluateCard(card, filters, predicate = exemplarPredicate(filters)) {
  if (!cardLevelMatch(card, filters)) return null;
  const age = evaluateAge(card.age, filters.age);
  if (!age.visible) return null;
  const exemplars = card.exemplars.filter(predicate);
  if (!exemplars.length) return null;
  return { exemplars, age: age.outcome };
}

function present(values, order) {
  const found = new Set(values);
  return order ? order.filter((value) => found.has(value)) : [...found].sort();
}

/**
 * Valeurs proposables pour chaque famille, d'après les fiches chargées. Une
 * famille sans donnée a une liste vide.
 */
export function filterOptions(cards) {
  const exemplars = cards.flatMap((card) => card.exemplars);
  const tags = new Map();
  for (const card of cards) for (const tag of card.tags) if (!tags.has(tag.id)) tags.set(tag.id, tag);
  return {
    languages: present(cards.map((card) => card.language).filter(Boolean)),
    formats: present(exemplars.map((exemplar) => exemplar.format), FORMAT_ORDER),
    projectTypes: present(cards.flatMap((card) => card.projectTypes), PROJECT_TYPES),
    sourceIds: present(exemplars.flatMap((exemplar) => exemplar.sourceIds)),
    tags: [...tags.values()],
    packStates: present(cards.map((card) => card.packState).filter(Boolean)),
    missing: MISSING_FIELDS.filter(field => cards.some(card => isMissing(card, field))),
    availability: [...AVAILABILITY_VALUES],
  };
}

// Familles à valeurs multiples ; table fermée famille → clé.
const FAMILY_KEYS = Object.freeze({
  languages: 'catalogue:filter.family.language',
  formats: 'catalogue:filter.family.format',
  projectTypes: 'catalogue:filter.family.projectType',
  sourceIds: 'catalogue:filter.family.source',
  packStates: 'catalogue:filter.family.packState',
  missing: 'catalogue:filter.family.missing',
});

const AVAILABILITY_KEYS = Object.freeze({
  unavailable: 'catalogue:filter.availability.unavailable',
  available: 'catalogue:filter.hideOffline',
});

/**
 * Récapitulatif des filtres actifs, en `{family, key, params}`. Les valeurs
 * restent brutes (`params.values`) : la présentation les affiche une à une.
 */
export function activeFilterSummary(rawFilters) {
  const filters = normalizeFilters(rawFilters);
  const summary = ageFilterSummary(filters.age).map((item) => ({ family: 'age', ...item }));
  for (const [family, key] of Object.entries(FAMILY_KEYS)) {
    const values = list(filters[family]);
    if (values.length) summary.push({ family, key, params: { values: [...values] } });
  }
  const tagIds = list(filters.tags.ids);
  if (tagIds.length) summary.push({ family: 'tags', key: 'catalogue:filter.tags.label', params: { values: [...tagIds] } });
  if (filters.incompleteOnly) summary.push({ family: 'incompleteOnly', key: 'catalogue:palette.incomplete', params: {} });
  if (filters.favoritesOnly) summary.push({ family: 'favoritesOnly', key: 'catalogue:filter.favorites.only', params: {} });
  if (filters.availability !== 'all') summary.push({ family: 'availability', key: AVAILABILITY_KEYS[filters.availability], params: {} });
  if (filters.missingFilesOnly) summary.push({ family: 'missingFilesOnly', key: 'catalogue:filter.missingFiles.label', params: {} });
  if (filters.hideOfficial) summary.push({ family: 'hideOfficial', key: 'catalogue:filter.hideOfficial.label', params: {} });
  return summary;
}

/** Erreur locale du filtre d'âge (minimum supérieur au maximum…), ou `null`. */
export function filterErrors(rawFilters) {
  const validation = validateAgeFilter(normalizeFilters(rawFilters).age);
  return validation.error ? [{ family: 'age', ...validation.error }] : [];
}
