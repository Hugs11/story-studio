export function normalizeFrenchSearchText(value) {
  // Unicode decomposition does not expand œ consistently, so handle the
  // common French ligatures explicitly before removing diacritics.
  return String(value ?? '')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('fr-FR');
}

export function formatFrenchCount(count, singularLabel, pluralLabel) {
  return `${count} ${count === 1 ? singularLabel : pluralLabel}`;
}
