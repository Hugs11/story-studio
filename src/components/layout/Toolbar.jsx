import {
  Download,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Mic,
  Save,
  SlidersHorizontal,
  Target,
} from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { DEFAULT_SHORTCUT_LABELS } from '../../store/keyboardShortcuts';

function ToolbarIcon({ Icon, className = 'chrome-icon' }) {
  return <Icon className={className} aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function withShortcut(label, shortcut) {
  return `${label} (${shortcut})`;
}

function ToolbarButton({
  title,
  label,
  onClick,
  disabled,
  active = false,
  children,
  trailing = null,
  iconOnly = false,
}) {
  return (
    <Tooltip text={title}>
      <button
        className={`chrome-toolbar-btn ${active ? 'is-active' : ''} ${iconOnly ? 'is-icon-only' : ''}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
      >
        <span className="chrome-toolbar-btn-icon">{children}</span>
        {!iconOnly ? <span className="chrome-toolbar-btn-label">{label}</span> : null}
        {trailing ? <span className="chrome-toolbar-btn-trailing">{trailing}</span> : null}
      </button>
    </Tooltip>
  );
}

export function Toolbar({
  showProjectActions,
  shortcutLabels = DEFAULT_SHORTCUT_LABELS,
  canImportStories,
  canAddFolder,
  saveState,
  generateDisabled,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onImportStories,
  onAddFolder,
  onRecord,
  canRecord,
  onOpenStorySettings,
  onGenerate,
}) {
  const primaryGroup = [
    {
      id: 'new',
      title: withShortcut('Nouveau projet', shortcutLabels.newProject),
      label: 'Nouveau',
      onClick: onNewProject,
      icon: <ToolbarIcon Icon={FilePlus} />,
    },
    {
      id: 'open',
      title: withShortcut('Ouvrir un projet', shortcutLabels.openProject),
      label: 'Ouvrir',
      onClick: onOpenProject,
      icon: <ToolbarIcon Icon={FolderOpen} />,
    },
    {
      id: 'save',
      title: withShortcut('Sauvegarder le projet', shortcutLabels.saveProject),
      label: 'Sauvegarder',
      onClick: onSaveProject,
      active: saveState === 'ok',
      icon: <ToolbarIcon Icon={Save} />,
    },
  ];

  const projectGroup = [
    {
      id: 'import',
      title: withShortcut('Importer des histoires audio / zip / 7z', shortcutLabels.importStories),
      label: 'Importer',
      onClick: onImportStories,
      disabled: !canImportStories,
      icon: <ToolbarIcon Icon={Download} />,
    },
    {
      id: 'folder',
      title: withShortcut('Ajouter un dossier', shortcutLabels.addFolder),
      label: 'Dossier',
      onClick: onAddFolder,
      disabled: !canAddFolder,
      icon: <ToolbarIcon Icon={FolderPlus} />,
    },
    {
      id: 'record',
      title: 'Enregistrer une histoire',
      label: 'Enregistrer',
      onClick: onRecord,
      disabled: !canRecord,
      icon: <ToolbarIcon Icon={Mic} />,
    },
  ];

  return (
    <div className="chrome-toolbar">
      <div className="chrome-toolbar-left">
        {primaryGroup.map((item) => (
          <ToolbarButton key={item.id} title={item.title} label={item.label} onClick={item.onClick} active={item.active}>
            {item.icon}
          </ToolbarButton>
        ))}
        <span className="chrome-toolbar-sep" />
        {projectGroup.map((item) => (
          <ToolbarButton key={item.id} title={item.title} label={item.label} onClick={item.onClick} disabled={item.disabled}>
            {item.icon}
          </ToolbarButton>
        ))}
        {showProjectActions ? (
          <>
            <span className="chrome-toolbar-sep" />
            <ToolbarButton
              title={withShortcut("Réglages de l'histoire", shortcutLabels.storySettings)}
              label="Réglages"
              onClick={onOpenStorySettings}
            >
              <ToolbarIcon Icon={SlidersHorizontal} />
            </ToolbarButton>
          </>
        ) : null}
      </div>

      <div className="chrome-toolbar-right">
        {showProjectActions ? (
          <>
            <span className="chrome-toolbar-sep" />
            <Tooltip text={generateDisabled ? `Corrige les erreurs avant de générer (${shortcutLabels.generate})` : withShortcut('Générer le pack', shortcutLabels.generate)}>
              <button
                className="chrome-toolbar-cta"
                onClick={onGenerate}
                disabled={generateDisabled}
                aria-label={generateDisabled ? `Corrige les erreurs avant de générer (${shortcutLabels.generate})` : withShortcut('Générer le pack', shortcutLabels.generate)}
              >
                <ToolbarIcon Icon={Target} />
                Générer le pack
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  );
}
