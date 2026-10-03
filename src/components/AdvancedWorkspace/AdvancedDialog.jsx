// Le châssis de dialogue de l'Éditeur avancé.
//
// Il porte la classe `app-modal-overlay` du portail commun, et c'est ce qui
// **suspend les raccourcis globaux** pendant qu'un dialogue est ouvert
// (`utils/modalSurfaces.js`). Un raccourci ne peut donc pas agir sur le graphe
// pendant qu'un formulaire de suppression est à l'écran, et la saisie d'un
// champ texte reste en outre protégée par `isEditableTarget` (`utils/shortcutTarget`).
//
// Échap annule toujours, et annuler **préserve les données** : le dialogue rend
// la main sans envoyer de geste, et l'appelant garde son brouillon s'il en
// tient un.

import { useEffect, useRef } from 'react';

import { AppModalPortal } from '../common/AppModalPortal';
import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './AdvancedDialog.css';

export function AdvancedDialog({
  title,
  description = null,
  children,
  onCancel,
  onConfirm = null,
  confirmLabel = 'Appliquer',
  cancelLabel = 'Annuler',
  confirmDisabled = false,
  confirmKind = 'primary',
  busy = false,
  footer = null,
}) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);
  useEscapeKey(true, () => { if (!busy) onCancel(); });

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    const focusable = panelRef.current?.querySelector(
      'input, select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, []);

  // Le piège de focus est explicite : Tab et Maj+Tab bouclent dans le panneau.
  // Sans lui, la tabulation sortirait vers le canvas, qui n'expose rien au DOM
  // et n'aurait donc rien à montrer au clavier.
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...(panelRef.current?.querySelectorAll(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return (
    <AppModalPortal>
      <div
        ref={panelRef}
        className="advanced-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <header className="advanced-dialog__header">
          <h2>{title}</h2>
          {description && <p className="advanced-dialog__description">{description}</p>}
        </header>
        <div className="advanced-dialog__body">{children}</div>
        <footer className="advanced-dialog__footer">
          {footer}
          <span className="advanced-dialog__spacer" />
          <Button onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          {onConfirm && (
            <Button variant={confirmKind} onClick={onConfirm} disabled={confirmDisabled || busy}>
              {confirmLabel}
            </Button>
          )}
        </footer>
      </div>
    </AppModalPortal>
  );
}
