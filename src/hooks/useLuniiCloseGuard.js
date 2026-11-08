import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { createLuniiCloseGuard } from '../store/luniiCloseGuard.js';
import { luniiDeviceApi } from '../store/catalogue/luniiDeviceApi.js';

let sharedGuard = null;
const sharedListeners = new Set();
const publishShared = () => { for (const listener of [...sharedListeners]) listener(); };

function closeMessage(t, activity) {
  if (activity.queued > 0) return t('common:app.luniiClose.messageQueued');
  const { title } = activity;
  if (activity.kind === 'send') {
    return title ? t('common:app.luniiClose.message.sendTitled', { title }) : t('common:app.luniiClose.message.send');
  }
  return title ? t('common:app.luniiClose.message.genericTitled', { title }) : t('common:app.luniiClose.message.generic');
}

/** Garde de fermeture Lunii : à passer à `useWindowCloseGuard` (`luniiGuard`). */
export function useLuniiCloseGuard(showChoiceDialog) {
  const { t } = useTranslation('common');
  const latest = useRef({});
  latest.current = { t, showChoiceDialog };
  const guard = useMemo(() => {
    const next = createLuniiCloseGuard({
      engine: luniiDeviceApi,
      ask: activity => {
        const { t, showChoiceDialog } = latest.current;
        return showChoiceDialog({
          title: t('common:app.luniiClose.title'),
          message: closeMessage(t, activity),
          cancelValue: 'cancel',
          actions: [
            { value: 'wait', label: t('common:app.luniiClose.wait'), kind: 'primary', autoFocus: true },
            ...(activity.queued > 0 ? [{ value: 'cancelRest', label: t('common:app.luniiClose.cancelRest'), kind: 'danger-outline' }] : []),
            { value: 'cancel', label: t('common:app.luniiClose.stay') },
          ],
        });
      },
    });
    return next;
  }, []);
  useEffect(() => {
    sharedGuard = guard;
    const stop = guard.subscribe(publishShared);
    return () => { stop(); if (sharedGuard === guard) sharedGuard = null; publishShared(); };
  }, [guard]);
  return guard;
}

/** Vrai tant que la fermeture attend la fin d'une opération Lunii. */
export function useLuniiCloseWaiting() {
  const subscribe = listener => { sharedListeners.add(listener); return () => sharedListeners.delete(listener); };
  const waiting = useSyncExternalStore(subscribe, () => sharedGuard?.isWaiting() ?? false);
  const failed = useSyncExternalStore(subscribe, () => sharedGuard?.hasFailed() ?? false);
  return { waiting, failed, cancel: () => sharedGuard?.cancelWait(), dismiss: () => sharedGuard?.dismissFailure() };
}
