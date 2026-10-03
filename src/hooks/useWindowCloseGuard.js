import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../utils/tauriRuntime.js';
import { releaseTauriListener } from '../utils/tauriListener.js';
import { nativeGenerationLock } from '../store/nativeGenerationLock.js';

// La garde porte sur toute fermeture, même sans travail à sauvegarder. La
// réservation native empêche un export de démarrer pendant le nettoyage async.
export function createWindowCloseHandler({ readCurrent, win, lock = nativeGenerationLock }) {
  let pending = false;
  return async (event) => {
    event.preventDefault();
    if (pending || readCurrent().isCloseBlocked?.()) return;
    pending = true;
    try {
      const { askSaveBeforeLeave, saveHandlerRef, confirmClose } = readCurrent();
      if (confirmClose) {
        const backgroundWorkAllowsClose = await confirmClose();
        if (backgroundWorkAllowsClose === false || readCurrent().isCloseBlocked?.()) return;
      }
      const canClose = await askSaveBeforeLeave(saveHandlerRef.current);
      if (!canClose || readCurrent().isCloseBlocked?.()) return;
      const permit = lock.acquire({ owner: 'closing', label: 'fermeture de fenêtre' });
      if (!permit) return;
      try {
        await readCurrent().beforeClose?.();
        await win.destroy();
      } finally {
        permit.release();
      }
    } finally {
      pending = false;
    }
  };
}

export function useWindowCloseGuard({ askSaveBeforeLeave, saveHandlerRef, isCloseBlocked, confirmClose, beforeClose }) {
  const current = useRef(null);
  current.current = { askSaveBeforeLeave, saveHandlerRef, isCloseBlocked, confirmClose, beforeClose };
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const win = getCurrentWindow();
    const handleClose = createWindowCloseHandler({ readCurrent: () => current.current, win });
    // Au double montage de StrictMode, l'inscription peut répondre après le
    // nettoyage : on la retire alors dès son arrivée. D'ici là, cet écouteur
    // retiré garde la fenêtre (sinon Tauri la détruirait) sans rien décider :
    // la décision appartient au seul écouteur vivant.
    let disposed = false;
    let unlisten;
    win.onCloseRequested((event) => {
      if (disposed) {
        event.preventDefault();
        return undefined;
      }
      return handleClose(event);
    }).then((fn) => {
      if (disposed) releaseTauriListener(fn);
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      releaseTauriListener(unlisten);
    };
  }, []);
}
