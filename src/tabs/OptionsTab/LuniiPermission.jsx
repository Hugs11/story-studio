import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalogueApi, presentCatalogueError } from '../../store/catalogue/catalogueApi.js';
import { Toggle } from '../../components/common/Toggle.jsx';
import { useErrorDialog } from '../../components/common/Dialog.jsx';

export function LuniiPermission({ api = catalogueApi() }) {
  const { t } = useTranslation('settings');
  const { showErrorDialog } = useErrorDialog();
  const bridge = useRef(api);
  const [allowed, setAllowed] = useState(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    bridge.current.luniiPermission().then(value => { if (active) { setAllowed(value); setBusy(false); } })
      .catch(error => { if (active) showErrorDialog(presentCatalogueError(error)); });
    return () => { active = false; };
  }, [showErrorDialog]);
  async function change(value) {
    setBusy(true);
    try { await bridge.current.setLuniiPermission(value); setAllowed(value); }
    catch (error) { showErrorDialog(presentCatalogueError(error)); }
    finally { setBusy(false); }
  }
  return <div className="opts-row">
    <div className="opts-row-info"><div className="opts-row-label">{t('catalogue:preferences.lunii.permission')}</div></div>
    <Toggle on={allowed === true} disabled={busy} onChange={value => void change(value)} ariaLabel={t('catalogue:preferences.lunii.permission')} />
  </div>;
}
