import { useEffect, useState } from 'react';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { Button } from '../common/Button.jsx';
export function UndoNotice({ state, noticeToken, busy, onUndo }) {
  const { t } = useCatalogueTranslation();
  const [visibleToken, setVisibleToken] = useState(null);
  useEffect(() => {
    if (!noticeToken) return;
    setVisibleToken(noticeToken);
    const timer = setTimeout(() => setVisibleToken(null), 10000);
    return () => clearTimeout(timer);
  }, [noticeToken]);
  if (state.status !== 'ready' || !visibleToken || visibleToken !== state.token) return null;
  return <aside className="catalogue-toast catalogue-undo-toast" role="status">
    {t('catalogue:header.operationDone')} <Button size="sm" disabled={busy} onClick={onUndo}>{t('catalogue:data.undo.title')}</Button>
  </aside>;
}
