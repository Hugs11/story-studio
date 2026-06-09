import { useEffect, useRef } from 'react';
import { FilePen, FolderOpen, Package } from '../icons/LucideLocal';
import './GenerateMenuPopover.css';

function ToolbarIcon({ Icon, className = 'chrome-icon' }) {
  return <Icon className={className} aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function GenerateMenuItem({ disabled = false, onClick, children }) {
  return (
    <button
      className="chrome-generate-menu-item"
      role="menuitem"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function GenerateMenuPopover({
  open,
  onOpenChange,
  trigger,
  generateDisabled,
  onGenerate,
  onOpenPackMetadata,
  onOpenExportFolder,
  exportPackName = '',
  generateShortcut = '',
}) {
  const wrapRef = useRef(null);
  const closeTimerRef = useRef(null);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) onOpenChange?.(false);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') onOpenChange?.(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  function openPopover() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    onOpenChange?.(true);
  }

  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onOpenChange?.(false), 140);
  }

  function handleAction(action) {
    onOpenChange?.(false);
    action?.();
  }

  return (
    <div
      className={`chrome-generate-menu-wrap ${open ? 'is-open' : ''}`}
      ref={wrapRef}
      onPointerEnter={openPopover}
      onPointerLeave={scheduleClose}
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClose}
      onFocus={openPopover}
    >
      {trigger({ openPopover })}

      {open ? (
        <>
          <div className="chrome-generate-menu-bridge" aria-hidden="true" />
          <div className="chrome-generate-menu" role="menu">
            <GenerateMenuItem disabled={generateDisabled} onClick={() => handleAction(onGenerate)}>
              <ToolbarIcon Icon={Package} />
              <span>
                <strong>Générer maintenant</strong>
                <small>{exportPackName ? `${exportPackName}.zip` : 'Export ZIP'}{generateShortcut ? ` · ${generateShortcut}` : ''}</small>
              </span>
            </GenerateMenuItem>
            <span className="chrome-generate-menu-sep" />
            {onOpenPackMetadata ? (
              <GenerateMenuItem onClick={() => handleAction(onOpenPackMetadata)}>
                <ToolbarIcon Icon={FilePen} />
                <span>
                  <strong>Modifier les métadonnées...</strong>
                  <small>Titre, âge, auteur, version</small>
                </span>
              </GenerateMenuItem>
            ) : null}
            <GenerateMenuItem onClick={() => handleAction(onOpenExportFolder)}>
              <ToolbarIcon Icon={FolderOpen} />
              <span>
                <strong>Ouvrir le dossier d'export</strong>
                <small>Dernier emplacement utilisé</small>
              </span>
            </GenerateMenuItem>
          </div>
        </>
      ) : null}
    </div>
  );
}
