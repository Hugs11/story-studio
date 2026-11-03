import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueImport } from '../../../hooks/useCatalogueImport.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { pickCatalogueBackupSource } from '../../../hooks/useFileDialog.js';
import { ImportDialog } from './ImportDialog.jsx';
export function CatalogueBackupImport({ revision, candidates = [], label }) {
  const { t } = useCatalogueTranslation(); const flow = useCatalogueImport();
  const available = Number.isSafeInteger(revision) && revision >= 0;
  async function choose() {
    try {
      const path = await pickCatalogueBackupSource({ title: t('catalogue:backupImport.path'), filterLabel: t('catalogue:backupExport.fileType') });
      if (path) flow.dispatch({ type: 'path', path });
    } catch (error) { flow.dispatch({ type: 'failed', error }); }
  }
  return <>
    <Tooltip text={!available ? t('catalogue:screen.refresh.wait') : t('catalogue:backupImport.title')}><Button disabled={!available} onClick={() => { if (available) flow.dispatch({ type: 'open' }); }}>{label ?? t('catalogue:backupImport.title')}</Button></Tooltip>
    {flow.state.phase !== 'closed' && <ImportDialog flow={flow} candidates={candidates} onChoosePath={choose} />}
  </>;
}
