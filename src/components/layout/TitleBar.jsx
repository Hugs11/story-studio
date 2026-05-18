import { useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PackNameModal } from './PackNameModal';
import { isTauriRuntime } from '../../utils/tauriRuntime';

function AppMark() {
  return (
    <span className="chrome-app-mark" aria-hidden="true">
      <img src="/favicon.png" alt="" className="chrome-app-mark-img" />
    </span>
  );
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="chrome-icon" aria-hidden="true">
      <path d="M3 8.75h10v1.5H3z" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="chrome-icon" aria-hidden="true">
      <path d="M3.75 3.75h8.5v8.5h-8.5z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="chrome-icon" aria-hidden="true">
      <path d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 16 16" className="chrome-icon" aria-hidden="true">
      <path d="M6.7 6.15a1.55 1.55 0 1 1 2.25 1.37c-.66.33-.95.73-.95 1.43v.35" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M8 11.55h.01" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" className="chrome-titlebar-chevron-icon" aria-hidden="true">
      <path d="M4.25 2.25 7.75 6 4.25 9.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TitleBar({ projectName, isDirty, hasSavePath = false, saveState = null, showProjectMeta = true, onOpenCredits = null, packName = null, packDescription = '', packVersion = 1, packMinAge = '', onUpdatePackName = null }) {
  const currentWindow = useMemo(() => (isTauriRuntime() ? getCurrentWindow() : null), []);
  const [isMaximizing, setIsMaximizing] = useState(false);
  const [showConventionModal, setShowConventionModal] = useState(false);
  const displayProjectName = projectName || 'Nouveau projet';
  const showSaveIndicator = isDirty || hasSavePath || saveState === 'ok';
  const saveIndicatorClass = (isDirty && saveState !== 'ok')
    ? 'chrome-titlebar-status is-dirty'
    : 'chrome-titlebar-status is-saved';
  const saveIndicatorTitle = (isDirty && saveState !== 'ok') ? 'Modifications non enregistrées' : 'Projet sauvegardé';

  async function handleToggleMaximize() {
    if (!currentWindow || isMaximizing) return;
    setIsMaximizing(true);
    try {
      const maximized = await currentWindow.isMaximized();
      if (maximized) await currentWindow.unmaximize();
      else await currentWindow.maximize();
    } finally {
      setIsMaximizing(false);
    }
  }

  return (
    <div className="chrome-titlebar">
      <div className="chrome-titlebar-left">
        <div className="chrome-titlebar-identity" data-tauri-drag-region>
          <AppMark />
          <span className="chrome-titlebar-brand">Story Studio</span>
          {showProjectMeta ? (
            <>
              <span className="chrome-titlebar-chevron"><ChevronIcon /></span>
              <span className="chrome-titlebar-project" title={displayProjectName}>{displayProjectName}</span>
              {showSaveIndicator && <span className={saveIndicatorClass} title={saveIndicatorTitle} />}
            </>
          ) : null}
        </div>
      </div>

      {packName !== null && onUpdatePackName ? (
        <div className="chrome-titlebar-center">
          <div className="chrome-titlebar-spacer" data-tauri-drag-region />
          <input
            className="chrome-pack-name-input"
            value={packName}
            onChange={(e) => onUpdatePackName({ name: e.target.value })}
            placeholder="Nom du pack"
          />
          <button
            className={`pack-name-convention-btn${showConventionModal ? ' active' : ''}`}
            onClick={() => setShowConventionModal(true)}
            title="Nom avancé et métadonnées"
          >
            ✦
          </button>
          <div className="chrome-titlebar-spacer" data-tauri-drag-region />
          <PackNameModal
            open={showConventionModal}
            packName={packName}
            packDescription={packDescription}
            packVersion={packVersion}
            packMinAge={packMinAge}
            onUpdatePackName={onUpdatePackName}
            onClose={() => setShowConventionModal(false)}
          />
        </div>
      ) : (
        <div className="chrome-titlebar-spacer" data-tauri-drag-region />
      )}

      <div className="chrome-window-controls">
        {onOpenCredits ? (
          <button className="chrome-window-btn" onClick={onOpenCredits} title="À propos">
            <HelpIcon />
          </button>
        ) : null}
        {currentWindow ? (
          <>
            <button className="chrome-window-btn" onClick={() => currentWindow.minimize()} title="Réduire">
              <MinimizeIcon />
            </button>
            <button className="chrome-window-btn" onClick={handleToggleMaximize} title="Agrandir ou restaurer" disabled={isMaximizing}>
              <MaximizeIcon />
            </button>
            <button className="chrome-window-btn chrome-window-btn-close" onClick={() => currentWindow.close()} title="Fermer">
              <CloseIcon />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
