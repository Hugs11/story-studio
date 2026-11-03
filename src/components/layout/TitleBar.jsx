import { useCommonTranslation } from '../../i18n/commonPresentation.js';
import { useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { CircleHelp, Image as ImageIcon, Settings } from '../icons/LucideLocal';
import { useLocalFile } from '../../hooks/useLocalFile';
import { Tooltip } from '../common/Tooltip';
import { DEFAULT_SHORTCUT_LABELS } from '../../store/keyboardShortcuts';
import './TitleBar.css';

// Les boutons de fenêtre sont dessinés dans un viewBox 16 au trait de 1,5 px ; les icônes lucide
// (viewBox 24, rendues à 16 px) donnent le même trait avec 1,5 x 24 / 16.
const LUCIDE_STROKE = 2.25;

function AppMark() {
  return (
    <span className="chrome-app-mark" aria-hidden="true">
      <img src="/favicon.svg" alt="" className="chrome-app-mark-img" />
    </span>
  );
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="chrome-icon" aria-hidden="true">
      <path d="M3 8.75h10v1.5H3z" fill="currentColor" />
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

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" className="chrome-titlebar-chevron-icon" aria-hidden="true">
      <path d="M4.25 2.25 7.75 6 4.25 9.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// `packRecap` remplace la lecture directe de `packMetadata` : le
// bandeau est commun aux deux éditeurs, et ceux-ci ne portent pas les mêmes
// champs. Composer la ligne ici obligerait à replier l'âge minimum sur « 3+ »
// pour un projet graphe, qui n'en a pas — une valeur d'auteur inventée. La
// ligne est donc calculée par l'appelant, qui sait ce que sa structure porte.
// `section` remplace la méta projet par le nom d'un écran hors projet (le
// Catalogue) : « Story Studio › Catalogue ».
export function TitleBar({ section = null, projectName, packRecap = null, packCoverImage = null, isDirty, hasSavePath = false, saveState = null, showProjectMeta = true, onOpenPackMetadata = null, onOpenCredits = null, onOpenPreferences = null, preferencesShortcut = DEFAULT_SHORTCUT_LABELS.tabOptions }) {
  const { t } = useCommonTranslation();
  const currentWindow = useMemo(() => (isTauriRuntime() ? getCurrentWindow() : null), []);
  const [isMaximizing, setIsMaximizing] = useState(false);
  const packCoverUrl = useLocalFile(packCoverImage);
  const displayProjectName = hasSavePath ? (projectName || t('common:project.new.fallback')) : t('common:project.unsaved.label');
  const packStoryName = packRecap?.title || '';
  const packDisplayName = packStoryName || t('common:titleBar.pack.fallback');
  const packMetaLine = packRecap?.line ?? '';
  const projectTooltip = t('common:titleBar.project.tooltip', { name: displayProjectName });
  const packTooltip = packStoryName
    ? t('common:titleBar.pack.namedTooltip', { name: packStoryName })
    : t('common:titleBar.pack.tooltip');
  const showSaveIndicator = isDirty || hasSavePath || saveState === 'ok';
  const saveIndicatorClass = (isDirty && saveState !== 'ok')
    ? 'chrome-titlebar-status is-dirty'
    : 'chrome-titlebar-status is-saved';
  const saveIndicatorTitle = !hasSavePath
    ? t('common:titleBar.save.neverSaved')
    : (isDirty && saveState !== 'ok') ? t('common:saveBeforeLeave.dirty.title') : t('common:titleBar.save.saved');

  const preferencesLabel = t('common:titleBar.preferences.tooltip');
  const preferencesTooltip = preferencesShortcut
    ? t('common:toolbar.shortcut.tooltip', { label: preferencesLabel, shortcut: preferencesShortcut })
    : preferencesLabel;

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
              <Tooltip text={projectTooltip} className="chrome-titlebar-project-tip">
                <span className="chrome-titlebar-project">{displayProjectName}</span>
              </Tooltip>
              {showSaveIndicator && (
                <Tooltip text={saveIndicatorTitle}>
                  <span className={saveIndicatorClass} />
                </Tooltip>
              )}
            </>
          ) : section ? (
            <>
              <span className="chrome-titlebar-chevron"><ChevronIcon /></span>
              <span className="chrome-titlebar-project">{section}</span>
            </>
          ) : null}
        </div>
        {showProjectMeta && packRecap ? (
          <>
            <span className="chrome-titlebar-chevron chrome-titlebar-pack-chevron" aria-hidden="true"><ChevronIcon /></span>
            <Tooltip text={packTooltip} className="chrome-titlebar-pack-tip">
              <button
                type="button"
                className="chrome-titlebar-pack-recap"
                onClick={onOpenPackMetadata}
                disabled={!onOpenPackMetadata}
                aria-label={packTooltip}
              >
              <span className="chrome-titlebar-pack-thumb">
                {packCoverUrl ? <img src={packCoverUrl} alt="" /> : <ImageIcon className="chrome-icon" strokeWidth={1.8} absoluteStrokeWidth />}
              </span>
              <span className="chrome-titlebar-pack-text">
                <span className="chrome-titlebar-pack-title">{packDisplayName}</span>
                <span className="chrome-titlebar-pack-meta">{packMetaLine}</span>
              </span>
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>

      <div className="chrome-titlebar-spacer" data-tauri-drag-region />

      <div className="chrome-window-controls">
        {onOpenPreferences ? (
          <Tooltip text={preferencesTooltip}>
            <button type="button" className="chrome-window-btn chrome-titlebar-preferences" onClick={onOpenPreferences} aria-label={preferencesTooltip}>
              <Settings className="chrome-icon" aria-hidden="true" strokeWidth={LUCIDE_STROKE} />
            </button>
          </Tooltip>
        ) : null}
        {onOpenCredits ? (
          <button type="button" className="chrome-window-btn" onClick={onOpenCredits} title={t('common:titleBar.help.tooltip')} aria-label={t('common:titleBar.help.tooltip')}>
            <CircleHelp className="chrome-icon" aria-hidden="true" strokeWidth={LUCIDE_STROKE} />
          </button>
        ) : null}
        {currentWindow && (onOpenPreferences || onOpenCredits) ? <span className="chrome-window-separator" aria-hidden="true" /> : null}
        {currentWindow ? (
          <>
            <button type="button" className="chrome-window-btn" onClick={() => currentWindow.minimize()} title={t('common:window.minimize.label')}>
              <MinimizeIcon />
            </button>
            <button type="button" className="chrome-window-btn" onClick={handleToggleMaximize} title={t('common:window.maximize.label')} disabled={isMaximizing}>
              <MaximizeIcon />
            </button>
            <button type="button" className="chrome-window-btn chrome-window-btn-close" onClick={() => currentWindow.close()} title={t('common:window.close.label')}>
              <CloseIcon />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
