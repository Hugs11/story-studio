// Recherche textuelle du catalogue : sans accents ni casse (ligatures
// décomposées), tous les mots requis. Champs : titre, description,
// mots-clés, étiquettes, UUID et noms de fichiers de tous les exemplaires.
//
// Quand la correspondance n'est pas visible sur la ligne principale (le
// titre), la recherche indique le champ et, pour un nom de fichier,
// l'exemplaire qui l'expliquent.

import { normalizeSearchText } from '../../utils/frenchText.js';

// Ordre de priorité des explications ; table fermée champ → clé.
const EXPLANATION_KEYS = Object.freeze({
  subtitle: 'catalogue:search.match.subtitle',
  description: 'catalogue:search.match.description',
  keywords: 'catalogue:search.match.keywords',
  tags: 'catalogue:search.match.tags',
  uuid: 'catalogue:search.match.uuid',
  fileName: 'catalogue:search.match.fileName',
});

const indexes = new WeakMap();

// Index normalisé d'une fiche, calculé une fois par objet fiche.
function searchIndex(card) {
  let index = indexes.get(card);
  if (!index) {
    index = {
      title: normalizeSearchText((card.displayTitle ?? card.title) ?? ''),
      fields: [
        { field: 'subtitle', text: normalizeSearchText(card.subtitle ?? '') },
        { field: 'description', text: normalizeSearchText(card.description ?? '') },
        { field: 'keywords', text: normalizeSearchText((card.keywords ?? []).join('\n')) },
        { field: 'tags', text: normalizeSearchText((card.tags ?? []).map((tag) => tag.label ?? '').join('\n')) },
        { field: 'uuid', text: normalizeSearchText((card.uuids ?? []).join('\n')) },
        ...(card.exemplars ?? []).map((exemplar) => ({
          field: 'fileName',
          text: normalizeSearchText(exemplar.fileName ?? ''),
          exemplarId: exemplar.id,
          name: exemplar.fileName,
        })),
      ].filter((entry) => entry.text),
    };
    indexes.set(card, index);
  }
  return index;
}

/** Mots normalisés d'une requête ; une requête vide ne filtre rien. */
export function searchWords(query) {
  return normalizeSearchText(query).split(/\s+/u).filter(Boolean);
}

/**
 * Évalue une fiche. Renvoie `null` si un mot manque ; sinon la liste des
 * explications (vide si tous les mots figurent dans le titre).
 * @returns {null | Array<{key: string, params: object, field: string, exemplarId: string|null}>}
 */
export function matchCard(card, words) {
  if (!words.length) return [];
  const index = searchIndex(card);
  const explanations = [];
  const seen = new Set();
  for (const word of words) {
    if (index.title.includes(word)) continue;
    const found = index.fields.find((entry) => entry.text.includes(word));
    if (!found) return null;
    const identity = `${found.field}\u0000${found.exemplarId ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    explanations.push({
      key: EXPLANATION_KEYS[found.field],
      params: found.field === 'fileName' ? { name: found.name } : {},
      field: found.field,
      exemplarId: found.exemplarId ?? null,
    });
  }
  return explanations;
}
