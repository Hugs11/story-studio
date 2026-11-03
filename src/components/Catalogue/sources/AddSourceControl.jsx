import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useState } from 'react';
import { pickFolder } from '../../../hooks/useFileDialog.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { CatalogueNotice } from '../CatalogueNotice.jsx';

// Le dépôt d'un dossier sur la fenêtre est géré une fois pour tout l'écran (useCatalogueAddFolders).
export function AddSourceControl({ sources = [], busy = false, onAdd }) {
  const { t } = useCatalogueTranslation();
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [picking, setPicking] = useState(false);
  const unavailable = busy || picking;
  async function choose() {
    if (unavailable) return;
    setPicking(true); setError(null); setNotice(null);
    try {
      const selected = await pickFolder({ multiple: true });
      for (const path of Array.isArray(selected) ? selected : selected ? [selected] : []) {
        const existing = sources.find((s) => s.path === path && s.status === 'active');
        if (existing) { setNotice('catalogue:sources.duplicate.message'); continue; }
        await onAdd(path);
      }
    } catch (error) { setError(error); }
    finally { setPicking(false); }
  }
  return <div className="opts-row" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setNotice('catalogue:sources.folderOnly.message'); }}>
    <Tooltip text={unavailable ? t('catalogue:sources.busy.message') : t('catalogue:sources.folderOnly.message')}><Button disabled={unavailable} onClick={choose}>{t('catalogue:sources.add.label')}</Button></Tooltip>
    {notice && <p>{t(notice)}</p>}
    <CatalogueNotice compact error={error} />
  </div>;
}
