import { CatalogueDataDialog } from '../CatalogueDataDialog.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { AssemblyExcludedList } from './AssemblyExcludedList.jsx';
export function AssemblyPreparationDialog({ state, onClose }) {
  const { t } = useCatalogueTranslation();
  return <CatalogueDataDialog label={t('catalogue:assembly.title')} onClose={onClose}>
    <h2>{t('catalogue:assembly.title')}</h2>
    <p aria-atomic="true" role={state.phase === 'error' ? 'alert' : 'status'}>{state.phase === 'error' ? presentCatalogueError(state.error).message : state.progress ? t('catalogue:assembly.progress', { processed: state.progress.candidates?.processed ?? 0, total: state.progress.candidates?.total ?? 0 }) : t('catalogue:assembly.preparing')}</p>
    <AssemblyExcludedList entries={state.preparation?.excluded} />
    <button type="button" onClick={onClose}>{t('catalogue:assembly.cancel')}</button>
  </CatalogueDataDialog>;
}
