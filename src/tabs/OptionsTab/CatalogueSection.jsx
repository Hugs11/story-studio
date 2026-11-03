import { Select } from '../../components/common/Select.jsx';
import { useEffect, useState } from 'react';
import { appDataDir, join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { startupPage } from '../../store/catalogue/startupPage.js';
import { KEYS, read, write } from '../../store/persistentSettings.js';
import { catalogueApi } from '../../store/catalogue/catalogueApi.js';
import { useCatalogueSources } from '../../hooks/useCatalogueSources.js';
import { useCatalogueOperations } from '../../hooks/useCatalogueOperations.js';
import { useCatalogueEntries } from '../../hooks/useCatalogueEntries.js';
import { useCatalogueSourceActions } from '../../hooks/useCatalogueSourceActions.js';
import { SourcesScreen } from '../../components/Catalogue/sources/SourcesScreen.jsx';
import { CatalogueNotice } from '../../components/Catalogue/CatalogueNotice.jsx';
import { CatalogueBackupExport } from '../../components/Catalogue/backup/CatalogueBackupExport.jsx';
import { CatalogueBackupImport } from '../../components/Catalogue/backup/CatalogueBackupImport.jsx';
import { Button } from '../../components/common/Button.jsx';
import { Tooltip } from '../../components/common/Tooltip.jsx';
import { LuniiPermission } from './LuniiPermission.jsx';

export function CatalogueSection({ className, sectionRef, workspaceDir, api = catalogueApi() }) {
  const { t, line } = useCatalogueTranslation();
  const sources = useCatalogueSources(workspaceDir, { api });
  const operations = useCatalogueOperations({ api });
  const entries = useCatalogueEntries({ api });
  const [error, setError] = useState(null);
  const [location, setLocation] = useState('');
  const [startup, setStartup] = useState(() => startupPage(read(KEYS.CATALOGUE_STARTUP_PAGE)));
  const { add, refresh } = useCatalogueSourceActions(sources, operations, setError);
  useEffect(() => {
    let active = true;
    void appDataDir().then(dir => join(dir, 'catalogue')).then(path => { if (active) setLocation(path); })
      .catch(error => { if (active) setError(error); });
    return () => { active = false; };
  }, []);
  return <section id="catalogue" className={className} ref={sectionRef}>
    <div className="opts-card-title">{t('catalogue:screen.title.label')}</div>
    <div className="opts-row-label">{t('catalogue:preferences.sources.label')}</div>
    <SourcesScreen sources={sources} onAdd={add} onRefresh={refresh} />
    <div aria-live="polite">{sources.notice && <p className="opts-row-sub">{line(sources.notice)}</p>}</div>
    <CatalogueNotice compact error={error ?? sources.mutationError ?? sources.error ?? operations.state.error ?? entries.error} />
    {sources.warnings?.map(warning => <CatalogueNotice compact key={warning.code} error={warning} />)}
    <div className="opts-row">
      <div className="opts-row-info"><label className="opts-row-label" htmlFor="catalogue-startup">{t('catalogue:startup.page.label')}</label></div>
      <Select id="catalogue-startup" className="xtts-input opts-select" value={startup} onChange={selected => {
        const value = startupPage(selected);
        write(KEYS.CATALOGUE_STARTUP_PAGE, value); setStartup(value);
      }}
        aria-label={t('catalogue:startup.page.label')}
        options={[
          { value: 'home', label: t('catalogue:startup.page.home') },
          { value: 'catalogue', label: t('catalogue:startup.page.catalogue') },
        ]}
      />
    </div>
    <LuniiPermission api={api} />
    <div className="opts-row">
      <div className="opts-row-info">
        <div className="opts-row-label">{t('catalogue:preferences.location.label')}</div>
        <Tooltip asChild text={location}><div className="opts-row-sub opts-catalogue-path" tabIndex={0}>{location}</div></Tooltip>
      </div>
      {location && <Button onClick={() => void revealItemInDir(location).catch(setError)}>{t('catalogue:preferences.location.open')}</Button>}
    </div>
    <div className="opts-row">
      <div className="opts-row-info">
        <div className="opts-row-label">{t('catalogue:preferences.export.label')}</div>
        <div className="opts-row-sub">{t('catalogue:preferences.export.description')}</div>
      </div>
      <CatalogueBackupExport label={t('catalogue:preferences.export.action')} revision={entries.revision} />
    </div>
    <div className="opts-row">
      <div className="opts-row-info">
        <div className="opts-row-label">{t('catalogue:preferences.import.label')}</div>
        <div className="opts-row-sub">{t('catalogue:preferences.import.description')}</div>
      </div>
      <CatalogueBackupImport label={t('catalogue:preferences.import.action')} revision={entries.revision} candidates={entries.cards} />
    </div>
  </section>;
}
