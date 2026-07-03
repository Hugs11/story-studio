import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Upload } from '../icons/LucideLocal';
import { isTauriRuntime } from '../../utils/tauriRuntime';

/**
 * Zone de dépôt réutilisable du châssis (plan 03) — gabarit de la maquette :
 * carte pointillée, pastille violette, titre, indice, et un slot d'actions
 * (boutons « Parcourir… »). Accepte le drag & drop OS (fichiers ET dossiers) via
 * l'événement Tauri `onDragDropEvent`, avec hit-test sur la zone (`data-funnel-drop`).
 *
 * `onFiles(paths)` reçoit les chemins bruts déposés (le funnel décide quoi en faire).
 *
 * @param {Object}   props
 * @param {React.ReactNode} [props.icon]
 * @param {string}   props.title
 * @param {string}   [props.hint]
 * @param {Function} props.onFiles      (paths: string[]) => void
 * @param {boolean}  [props.disabled=false]
 * @param {React.ReactNode} [props.children]  Actions (boutons parcourir).
 */
export function FunnelDropZone({ icon, title, hint, onFiles, disabled = false, children }) {
  const [isOver, setIsOver] = useState(false);
  const scaleRef = useRef(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (disabled || !isTauriRuntime()) return undefined;
    let unlisten;
    let cancelled = false;
    const win = getCurrentWindow();
    win.scaleFactor()
      .then((factor) => { if (!cancelled && Number.isFinite(factor) && factor > 0) scaleRef.current = factor; })
      .catch(() => {});

    const overZone = (position) => {
      if (!position) return false;
      const x = position.x / (scaleRef.current || 1);
      const y = position.y / (scaleRef.current || 1);
      const el = document.elementFromPoint(x, y);
      return !!el?.closest('[data-funnel-drop]');
    };

    win.onDragDropEvent((event) => {
      const { type, paths, position } = event.payload;
      if (type === 'over') { setIsOver(overZone(position)); return; }
      if (type === 'leave' || type === 'cancel') { setIsOver(false); return; }
      if (type === 'drop') {
        setIsOver(false);
        if (!paths?.length || !overZone(position)) return;
        onFilesRef.current?.(paths);
      }
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});

    return () => { cancelled = true; unlisten?.(); };
  }, [disabled]);

  return (
    <div data-funnel-drop className={`funnel-dropzone${isOver ? ' is-over' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span className="funnel-dropzone-icon" aria-hidden="true">{icon ?? <Upload />}</span>
      <div className="funnel-dropzone-text">
        <div className="funnel-dropzone-title">{title}</div>
        {hint ? <div className="funnel-dropzone-hint">{hint}</div> : null}
      </div>
      {children ? <div className="funnel-dropzone-actions">{children}</div> : null}
    </div>
  );
}
