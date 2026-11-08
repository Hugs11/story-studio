import { useTranslation } from 'react-i18next';
import { NotificationToast } from './common/NotificationToast.jsx';
import { useLuniiCloseWaiting } from '../hooks/useLuniiCloseGuard.js';

/** Visible tant que la fermeture attend la fin d'une opération Lunii. */
export function LuniiCloseNotice() {
  const { t } = useTranslation('common');
  const { waiting, failed, cancel, dismiss } = useLuniiCloseWaiting();
  if (failed && !waiting) {
    return <NotificationToast visible title={t('common:app.luniiClose.closeFailed')}
      actionLabel={t('common:app.luniiClose.dismiss')} onAction={dismiss} onClose={dismiss}
      closeLabel={t('common:app.luniiClose.dismiss')} />;
  }
  return <NotificationToast visible={waiting}
    title={t('common:app.luniiClose.notice')}
    actionLabel={t('common:app.luniiClose.keepOpen')}
    closeLabel={t('common:app.luniiClose.keepOpen')}
    onAction={cancel} onClose={cancel} />;
}
