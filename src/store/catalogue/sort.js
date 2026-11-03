// Tris du catalogue : titre, ajout au catalogue, modification du fichier,
// âge, durée, taille, format (meilleur rang des exemplaires présentés), nombre d'histoires, langue, auteur, producteur ; sens inversable. Les valeurs manquantes sont toujours
// en dernier, quel que soit le sens. Le départage final (titre puis
// identifiant de fiche, toujours croissants) rend l'ordre total : le résultat
// ne dépend pas de l'ordre d'entrée.
//
// Date de modification et taille sont celles de l'exemplaire représentatif,
// c'est-à-dire l'exemplaire correspondant aux filtres (commun aux trois vues).

import { packAgeRange } from './ageFilter.js';
import { FORMAT_ORDER } from './entryModel.js';
import { languageLabel } from './languageOptions.js';
import { translateCatalogue } from '../../i18n/cataloguePresentation.js';

export const SORT_KEYS = Object.freeze(['title', 'addedAt', 'modifiedAt', 'age', 'duration', 'size', 'format', 'stories', 'language', 'author', 'producer']);

// Sens « naturel » d'un critère, pris au premier clic sur une colonne ou au choix dans la liste :
// texte A→Z et nombres croissants ; dates et taille, le plus récent / le plus gros d'abord.
const DESCENDING_FIRST = Object.freeze(['addedAt', 'modifiedAt', 'size']);
export function naturalDirection(key) {
  return DESCENDING_FIRST.includes(key) ? 'desc' : 'asc';
}

/** Colonnes de la vue Liste triables → critère de tri (les autres ne le sont pas). */
export const COLUMN_SORT_KEYS = Object.freeze({ title: 'title', age: 'age', duration: 'duration', formats: 'format', stories: 'stories', language: 'language', author: 'author', producer: 'producer' });
export const DEFAULT_SORT = Object.freeze({ key: 'title', direction: 'asc' });

export function normalizeSort(sort = {}) {
  return {
    key: SORT_KEYS.includes(sort.key) ? sort.key : DEFAULT_SORT.key,
    direction: sort.direction === 'desc' ? 'desc' : 'asc',
  };
}

const collators = new Map();

/** Comparateur de titres de la langue d'interface (casse et accents ignorés). */
export function titleCollator(language = 'fr') {
  if (!collators.has(language)) {
    collators.set(language, new Intl.Collator(language, { sensitivity: 'base', numeric: true }));
  }
  return collators.get(language);
}

function numberValue(value) {
  return Number.isFinite(value) ? value : null;
}

// Format : rang le plus petit (ordre fixe Projet, ZIP, 7z, Dossier) parmi les
// exemplaires qui satisfont les filtres ; `null` si aucun format connu.
function formatRank(entry) {
  const exemplars = entry.matching?.length ? entry.matching : [entry.representative];
  const ranks = exemplars.map((exemplar) => FORMAT_ORDER.indexOf(exemplar?.format)).filter((rank) => rank >= 0);
  return ranks.length ? Math.min(...ranks) : null;
}

// Valeur triable : nombre, tableau de nombres (âge) ou texte ; `null` = manquante.
function sortValue(entry, key) {
  const { card, representative } = entry;
  switch (key) {
    case 'title': return card.displayTitle ?? card.title;
    case 'addedAt': return numberValue(card.addedAt);
    case 'modifiedAt': return numberValue(representative?.modifiedAt);
    case 'age': {
      const range = packAgeRange(card.age);
      return range ? [range.min, range.max] : null;
    }
    case 'duration': return numberValue(card.durationSeconds);
    case 'size': return numberValue(representative?.sizeBytes);
    case 'format': return formatRank(entry);
    case 'stories': return numberValue(card.storyCount);
    // Nom affiché à l'écran, pas le code : « Allemand » (de) avant « Anglais » (en).
    case 'language': return card.language ? languageLabel(card.language, translateCatalogue) : null;
    case 'author': return card.author ?? null;
    case 'producer': return card.producer ?? null;
    default: return null;
  }
}

function compareValues(left, right, collator) {
  if (typeof left === 'string') return collator.compare(left, right);
  if (Array.isArray(left)) return left[0] - right[0] || left[1] - right[1];
  return left - right;
}

function compareIds(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Trie des entrées `{card, representative}` (nouveau tableau). Ordre total et
 * stable : valeurs manquantes en dernier, puis titre et identifiant.
 */
export function sortEntries(entries, sort = DEFAULT_SORT, { collator = titleCollator() } = {}) {
  const { key, direction } = normalizeSort(sort);
  const factor = direction === 'desc' ? -1 : 1;
  const keyed = entries.map((entry) => ({ entry, value: sortValue(entry, key), title: (entry.card.displayTitle ?? entry.card.title) }));
  keyed.sort((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value !== right.value) return left.value === null ? 1 : -1;
    } else {
      const order = compareValues(left.value, right.value, collator);
      if (order) return order * factor;
    }
    if (key !== 'title' && left.title !== right.title) {
      if (left.title === null) return 1;
      if (right.title === null) return -1;
      const order = collator.compare(left.title, right.title);
      if (order) return order;
    }
    return compareIds(left.entry.card.id, right.entry.card.id);
  });
  return keyed.map((item) => item.entry);
}
