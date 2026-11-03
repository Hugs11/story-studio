import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueBackup } from '../../../hooks/useCatalogueBackup.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { pickCatalogueBackupDestination } from '../../../hooks/useFileDialog.js';
import { ExportDialog } from './ExportDialog.jsx';
export function CatalogueBackupExport({ revision, label }) {
  const { t } = useCatalogueTranslation();
  const flow = useCatalogueBackup(revision);
  const available = Number.isSafeInteger(revision) && revision >= 0;
  async function choose() {
    try {
      const path = await pickCatalogueBackupDestination({ title: t('catalogue:backupExport.destination'), defaultPath: t('catalogue:backupExport.defaultName'), filterLabel: t('catalogue:backupExport.fileType') });
      if (path) flow.dispatch({ type: 'path', path });
    } catch (error) { flow.dispatch({ type: 'failed', error }); }
  }
  return <>
    <Tooltip text={!available ? t('catalogue:screen.refresh.wait') : t('catalogue:backupExport.title')}><Button disabled={!available} onClick={() => { if (available) flow.dispatch({ type: 'open' }); }}>{label ?? t('catalogue:backupExport.title')}</Button></Tooltip>
    {flow.state.phase !== 'closed' && <ExportDialog flow={flow} onChoosePath={choose} />}
  </>;
}
