import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
export function ImportSummary({ result }) {
  const { t } = useCatalogueTranslation();
  return <section aria-label={t('catalogue:backupImport.resultTitle')}><h3>{t('catalogue:backupImport.resultTitle')}</h3>
    <p>{t('catalogue:backupImport.result', result)}</p>
  </section>;
}
