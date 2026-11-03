import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
export function CatalogueActions({ children }) {
  const { t } = useCatalogueTranslation();
  return <div className="catalogue-actions" role="group" aria-label={t('catalogue:actions.menu.label')}>{children}</div>;
}
