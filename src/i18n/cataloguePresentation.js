import i18next, { createInstance } from 'i18next';
import frCatalogue from '../locales/fr/catalogue.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };
import { getIntlLocale } from './language.js';

// Les fonctions pures peuvent précéder le Provider ; le catalogue FR reste
// leur unique source. Résoudre à l'appel, jamais au chargement d'une table.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'catalogue', keySeparator: false, initAsync: false,
  resources: { fr: { catalogue: frCatalogue, common: frCommon } }, interpolation: { escapeValue: false } });

export function translateCatalogue(key, params) {
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'catalogue')
    ? i18next.t(key, params) : source.t(key, params);
}

/** Traduit une ligne `{key, params}` produite par la logique du catalogue. */
export function presentCatalogueLine(line) {
  return line ? translateCatalogue(line.key, line.params) : '';
}

const BYTE_UNITS = Object.freeze(['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte']);

/**
 * Texte d'une cellule du catalogue (`detailsRow.js`) : donnée de
 * l'utilisateur telle quelle, ligne traduite, date ou taille localisées.
 */
export function presentCatalogueCell(cell) {
  if (!cell) return '';
  switch (cell.kind) {
    case 'text': return cell.value;
    case 'date': return new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(cell.value));
    case 'bytes': {
      let value = cell.value;
      let unit = 0;
      while (value >= 1000 && unit < BYTE_UNITS.length - 1) { value /= 1000; unit += 1; }
      return new Intl.NumberFormat(getIntlLocale(), { style: 'unit', unit: BYTE_UNITS[unit], unitDisplay: 'short', maximumFractionDigits: unit ? 1 : 0 }).format(value);
    }
    default: return translateCatalogue(cell.key, cell.params);
  }
}
