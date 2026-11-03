import './CatalogueOpen.css';
import { useEffect, useId, useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { catalogueApi, presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { generationFolder, shouldProposeGenerationFolder } from '../../../store/catalogue/generationProposal.js';

/** Mounted in the existing successful generation result, never on project save. */
export function GenerationFolderPrompt({ outputPath, api = catalogueApi() }) {
  const folder = generationFolder(outputPath);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!folder) return;
    let disposed = false;
    Promise.all([api.explainPath(folder), api.listSources()]).then(([explanation, sources]) => {
      if (!disposed) setVisible(shouldProposeGenerationFolder({ explanation, declined: sources.items.some(source => source.status === 'declined' && source.path.replace(/[\\/]+$/, '') === folder.replace(/[\\/]+$/, '')) }));
    }).catch(() => { /* A missing catalogue must not disturb the generation result. */ });
    return () => { disposed = true; };
  }, [api, folder]);
  async function choose(declined) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const sources = await api.listSources();
      await api.addSource(folder, sources.sourcesRevision, declined);
      setVisible(false);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  if (!visible) return null;
  return <GenerationFolderPromptContent folder={folder} busy={busy} error={error} onChoose={choose} />;
}

export function GenerationFolderPromptContent({ folder, busy = false, error = null, onChoose }) {
  const { t } = useCatalogueTranslation();
  const busyId = useId();
  return <aside className="catalogue-generation-proposal" aria-busy={busy}>
    <p>{t('catalogue:generation.folder.question', { folder })}</p>
    <button type="button" aria-disabled={busy} aria-describedby={busy ? busyId : undefined} onClick={() => !busy && onChoose(false)}>{t('catalogue:generation.folder.add')}</button>
    <button type="button" aria-disabled={busy} aria-describedby={busy ? busyId : undefined} onClick={() => !busy && onChoose(true)}>{t('catalogue:generation.folder.decline')}</button>
    {busy && <p id={busyId}>{t('catalogue:generation.folder.busy')}</p>}
    {error && <p role="alert">{presentCatalogueError(error).message}</p>}
  </aside>;
}
