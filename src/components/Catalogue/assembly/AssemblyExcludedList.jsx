import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
export function AssemblyExcludedList({ entries = [] }) {
  const { t } = useCatalogueTranslation();
  if (!entries.length) return null;
  return <ul>{entries.map(entry => <li key={entry.ficheId}>{entry.ficheId} — {entry.reason === 'generateFirst' ? t('catalogue:assembly.generateFirst') : t('catalogue:assembly.unavailable')}</li>)}</ul>;
}
