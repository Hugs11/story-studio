import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { TriangleAlert } from '../icons/LucideLocal';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './Dialog.css';

const ErrorDialogContext = createContext(null);

function actionVariant(kind) {
  if (kind === 'primary') return 'primary';
  if (kind === 'danger') return 'danger';
  if (kind === 'danger-outline') return 'danger-outline';
  if (kind === 'ghost') return 'ghost';
  return 'secondary';
}

function Dialog({ dialog, onClose, onConfirm, onAction }) {
  const closeButtonRef = useRef(null);
  useEscapeKey(Boolean(dialog), onClose);

  if (!dialog) return null;

  const variant = dialog.variant || 'error';
  const title = dialog.title || 'Erreur';
  const closeLabel = dialog.okLabel || 'Fermer';
  const hasConfirm = typeof dialog.onConfirm === 'function';
  const actions = Array.isArray(dialog.actions) ? dialog.actions : null;

  return createPortal(
    <div className="dialog-overlay" role="presentation">
      <div
        className={`dialog-panel dialog-panel--${variant}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
      >
        <div className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <h2 id="app-dialog-title">{title}</h2>
        </div>
        <div className="dialog-message">{dialog.message}</div>
        <div className="dialog-actions">
          {actions ? actions.map((action) => (
            <Button
              key={String(action.value)}
              variant={actionVariant(action.kind)}
              onClick={() => onAction(action.value)}
              autoFocus={!!action.autoFocus}
            >
              {action.label}
            </Button>
          )) : hasConfirm && (
            <Button ref={closeButtonRef} onClick={onClose} autoFocus>
              {dialog.cancelLabel || 'Annuler'}
            </Button>
          )}
          {!actions ? (
            <Button
              ref={hasConfirm ? null : closeButtonRef}
              variant={actionVariant(dialog.okKind || 'primary')}
              onClick={hasConfirm ? onConfirm : onClose}
              autoFocus={!hasConfirm}
            >
              {closeLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ErrorDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const previousFocusRef = useRef(null);

  const rememberFocus = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }, []);

  const restoreFocus = useCallback(() => {
    const target = previousFocusRef.current;
    previousFocusRef.current = null;
    if (target?.isConnected) window.setTimeout(() => target.focus(), 0);
  }, []);

  const closeDialog = useCallback(() => {
    setDialog((current) => {
      current?.onClose?.();
      return null;
    });
    restoreFocus();
  }, [restoreFocus]);

  const confirmDialog = useCallback(() => {
    setDialog((current) => {
      current?.onConfirm?.();
      return null;
    });
    restoreFocus();
  }, [restoreFocus]);

  const actionDialog = useCallback((value) => {
    setDialog((current) => {
      current?.onAction?.(value);
      return null;
    });
    restoreFocus();
  }, [restoreFocus]);

  const showErrorDialog = useCallback((nextDialog) => {
    rememberFocus();
    setDialog({
      title: nextDialog?.title || 'Erreur',
      message: String(nextDialog?.message ?? ''),
      variant: nextDialog?.variant || 'error',
      okLabel: nextDialog?.okLabel,
      okKind: nextDialog?.okKind,
      onClose: nextDialog?.onClose,
    });
  }, [rememberFocus]);

  const showConfirmDialog = useCallback((nextDialog) => new Promise((resolve) => {
    rememberFocus();
    setDialog({
      title: nextDialog?.title || 'Confirmer',
      message: String(nextDialog?.message ?? ''),
      variant: nextDialog?.variant || 'warning',
      okLabel: nextDialog?.okLabel || 'OK',
      okKind: nextDialog?.okKind,
      cancelLabel: nextDialog?.cancelLabel || 'Annuler',
      onConfirm: () => resolve(true),
      onClose: () => resolve(false),
    });
  }), [rememberFocus]);

  const showChoiceDialog = useCallback((nextDialog) => new Promise((resolve) => {
    rememberFocus();
    const cancelValue = nextDialog?.cancelValue ?? null;
    setDialog({
      title: nextDialog?.title || 'Choisir',
      message: String(nextDialog?.message ?? ''),
      variant: nextDialog?.variant || 'warning',
      actions: nextDialog?.actions ?? [],
      onAction: (value) => resolve(value),
      onClose: () => resolve(cancelValue),
    });
  }), [rememberFocus]);

  const value = useMemo(() => ({
    showErrorDialog,
    showConfirmDialog,
    showChoiceDialog,
  }), [showChoiceDialog, showConfirmDialog, showErrorDialog]);

  return (
    <ErrorDialogContext.Provider value={value}>
      {children}
      <Dialog dialog={dialog} onClose={closeDialog} onConfirm={confirmDialog} onAction={actionDialog} />
    </ErrorDialogContext.Provider>
  );
}

export function useErrorDialog() {
  const context = useContext(ErrorDialogContext);
  if (!context) {
    throw new Error('useErrorDialog must be used inside ErrorDialogProvider');
  }
  return context;
}
