import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../utils/tauriRuntime';

export function useWindowCloseGuard({ askSaveBeforeLeave, projectRef, savedSnapshotRef, saveHandlerRef }) {
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const win = getCurrentWindow();
    let unlisten;
    win.onCloseRequested(async (e) => {
      e.preventDefault();
      const canClose = await askSaveBeforeLeave(projectRef.current, savedSnapshotRef.current, saveHandlerRef.current);
      if (canClose) await win.destroy();
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);
}
