export function normalizeSearchText(value) {
  // Décomposer les ligatures avant de retirer les accents pour les trois langues.
  return String(value ?? '')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

// Compatibilité des domaines pas encore extraits ; leurs appels seront remplacés
// par t(clé, { count }) et les catégories i18next _one/_many/_other.
export function formatFrenchCount(count, singularLabel, pluralLabel) {
  return `${count} ${count === 1 ? singularLabel : pluralLabel}`;
}
