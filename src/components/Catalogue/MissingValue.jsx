import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';

/** Le tiret visible garde sa largeur ; la valeur manquante est nommée à l'oral. */
export function MissingValue() {
  const { t } = useCatalogueTranslation();
  return missingValue(t);
}

export function missingValue(t) {
  return <><span aria-hidden="true">{t('catalogue:details.value.notProvided')}</span><span className="catalogue-visually-hidden">{t('catalogue:details.value.notProvidedAccessible')}</span></>;
}
