import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
export function BackupExportSummary({ result }) {
  const { t } = useCatalogueTranslation();
  return <section aria-label={t('catalogue:backupExport.summary')}>
    <p>{result.missingLuniiImages > 0
      ? t('catalogue:backupExport.successMissingCovers', { bytes: result.byteSize, count: result.missingLuniiImages })
      : t('catalogue:backupExport.success', { bytes: result.byteSize })}</p>
    <p className="catalogue-path">{result.path}</p>
    <p>{t('catalogue:backupExport.contract', { version: result.formatVersion, revision: result.catalogueRevision, cards: result.counts.cards, tags: result.counts.tags, images: result.counts.images })}</p>
    <p className="catalogue-path">{t('catalogue:backupExport.digest', { digest: result.digest })}</p>
  </section>;
}
