import { useEffect, useRef } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import './Dialog.css';

/** Native modal containment for rich content, sharing the app dialog surface. */
export function ContentDialog({ label, busy, onClose, children, className = '' }) {
  const ref = useRef(null);
  useEscapeKey(true, () => { if (!busy) onClose(); });
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog className={`dialog-panel ${className}`} aria-label={label} ref={ref} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}
