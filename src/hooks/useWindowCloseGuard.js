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
      const { askSaveBeforeLeave, saveHandlerRef, confirmClose, luniiGuard } = readCurrent();
      if (confirmClose) {
        const backgroundWorkAllowsClose = await confirmClose();
        if (backgroundWorkAllowsClose === false || readCurrent().isCloseBlocked?.()) return;
      }
      // Après la file de rendu : une opération Lunii n'est jamais coupée, on
      // la signale puis, si l'utilisateur attend, on enregistre tout de suite.
      // eslint-disable-next-line i18next/no-literal-string -- Valeur de contrôle interne, jamais rendue.
      const luniiChoice = luniiGuard ? await luniiGuard.confirm() : 'proceed';
      if (luniiChoice === 'cancel' || readCurrent().isCloseBlocked?.()) return;
      const canClose = await askSaveBeforeLeave(saveHandlerRef.current);
      if (!canClose || readCurrent().isCloseBlocked?.()) return;
      // La demande reste « en cours » pendant l'attente : une seconde demande
      // ne rouvre aucun dialogue et ne double pas la fermeture.
      let waited = false;
      if (luniiChoice === 'wait' || (luniiGuard && await luniiGuard.isBusy())) {
        waited = true;
        const { readWorkSignature } = readCurrent();
        let signature = readWorkSignature?.();
        for (;;) {
          const idle = await luniiGuard.waitIdle();
          if (!idle || readCurrent().isCloseBlocked?.()) return;
          // La file de rendu a pu démarrer pendant l'attente.
          if (confirmClose && (await readCurrent().confirmClose?.()) === false) return;
          // Projet modifié pendant l'attente : on redemande plutôt que de perdre le travail.
          if (readWorkSignature && readWorkSignature() !== signature) {
            const again = await readCurrent().askSaveBeforeLeave(readCurrent().saveHandlerRef.current);
            if (!again || readCurrent().isCloseBlocked?.()) return;
            signature = readWorkSignature();
          }
          // Dernière lecture du moteur juste avant de détruire la fenêtre.
          if (!(await luniiGuard.isBusy())) break;
        }
      }
      // eslint-disable-next-line i18next/no-literal-string -- Diagnostic interne du verrou, jamais rendu par la garde.
      const permit = lock.acquire({ owner: 'closing', label: 'fermeture de fenêtre' });
      if (!permit) {
        if (waited) luniiGuard.reportCloseFailed();
        return;
      }
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

export function useWindowCloseGuard({ askSaveBeforeLeave, saveHandlerRef, isCloseBlocked, confirmClose, beforeClose, luniiGuard, readWorkSignature }) {
  const current = useRef(null);
  current.current = { askSaveBeforeLeave, saveHandlerRef, isCloseBlocked, confirmClose, beforeClose, luniiGuard, readWorkSignature };
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
