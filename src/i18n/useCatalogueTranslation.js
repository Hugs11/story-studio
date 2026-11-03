import { useMessageLanguage } from './useMessageLanguage.js';
import { presentCatalogueCell, presentCatalogueLine, translateCatalogue } from './cataloguePresentation.js';

export function useCatalogueTranslation() {
  useMessageLanguage();
  return { t: translateCatalogue, line: presentCatalogueLine, cell: presentCatalogueCell };
}
