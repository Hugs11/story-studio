import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Download,
  FilePlus,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Mic,
  Package,
  Save,
  SlidersHorizontal,
} from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { DEFAULT_SHORTCUT_LABELS } from '../../store/keyboardShortcuts';
import { ValidationPill } from './ValidationPill';
import { PackOptionsPopover } from './PackOptionsPopover';
import { GenerateMenuPopover } from './GenerateMenuPopover';

function ToolbarIcon({ Icon, className = 'chrome-icon' }) {
  return <Icon className={className} aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function withShortcut(label, shortcut) {
  return `${label} (${shortcut})`;
}

function ToolbarButton({
  id,
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
        data-toolbar-id={id}
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
  canImportFolder,
  canAddFolder,
  saveState,
  generateDisabled,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onImportStories,
  onImportFolder,
  onAddFolder,
  onRecord,
  canRecord,
  packOptionsOpen = false,
  onPackOptionsOpenChange,
  projectType,
  globalOptions,
  onUpdateGlobalOption,
  onGenerate,
  onOpenPackMetadata,
  onOpenExportFolder,
  exportPackName = '',
  generateShortcut = '',
  validationIssues = [],
  pathAuditPending = false,
  validationOpen = false,
  onValidationOpenChange,
  onSelectIssue,
}) {
  const [generateMenuOpen, setGenerateMenuOpen] = useState(false);
  const [successToast, setSuccessToast] = useState(false);
  const successToastTimerRef = useRef(null);

  useEffect(() => () => {
    if (successToastTimerRef.current) clearTimeout(successToastTimerRef.current);
  }, []);

  function handleCountZeroTransition() {
    setSuccessToast(true);
    if (successToastTimerRef.current) clearTimeout(successToastTimerRef.current);
    successToastTimerRef.current = setTimeout(() => setSuccessToast(false), 2200);
  }

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
      id: 'import-folder',
      title: 'Importer un dossier et son contenu',
      label: 'Importer dossier',
      onClick: onImportFolder,
      disabled: !canImportFolder,
      icon: <ToolbarIcon Icon={FolderInput} />,
    },
    {
      id: 'folder',
      title: withShortcut('Créer un dossier', shortcutLabels.addFolder),
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
          <ToolbarButton key={item.id} id={item.id} title={item.title} label={item.label} onClick={item.onClick} active={item.active}>
            {item.icon}
          </ToolbarButton>
        ))}
        <span className="chrome-toolbar-sep" />
        {projectGroup.map((item) => (
          <ToolbarButton key={item.id} id={item.id} title={item.title} label={item.label} onClick={item.onClick} disabled={item.disabled}>
            {item.icon}
          </ToolbarButton>
        ))}
      </div>

      <div className="chrome-toolbar-right">
        {showProjectActions ? (
          <>
            <span className="chrome-toolbar-sep" />
            <ValidationPill
              validationIssues={validationIssues}
              pathAuditPending={pathAuditPending}
              open={validationOpen}
              onOpenChange={onValidationOpenChange}
              onSelectIssue={onSelectIssue}
              onCountZeroTransition={handleCountZeroTransition}
              shortcutLabel={shortcutLabels.toggleValidation}
            />
            <span className="chrome-toolbar-sep" />
            <PackOptionsPopover
              open={packOptionsOpen}
              projectType={projectType}
              globalOptions={globalOptions}
              onOpenChange={onPackOptionsOpenChange}
              onUpdateOption={onUpdateGlobalOption}
              trigger={(
                <ToolbarButton
                  id="pack-options"
                  title={withShortcut('Options du pack', shortcutLabels.storySettings)}
                  label="Options du pack"
                  onClick={() => onPackOptionsOpenChange?.(true)}
                  active={packOptionsOpen}
                  trailing={<span className="chrome-pack-options-caret" aria-hidden="true">▾</span>}
                >
                  <ToolbarIcon Icon={SlidersHorizontal} />
                </ToolbarButton>
              )}
            />
            <span className="chrome-toolbar-sep" />
            <div className="chrome-generate-split">
              {successToast ? (
                <div className="validation-success-toast" role="status" aria-live="polite">
                  <CircleCheck width={13} height={13} aria-hidden="true" />
                  <span>Pack prêt à générer</span>
                </div>
              ) : null}
              <Tooltip text={generateDisabled ? `Complète les éléments manquants avant de générer (${shortcutLabels.generate})` : withShortcut('Générer le pack', shortcutLabels.generate)}>
                <button
                  className="chrome-toolbar-cta chrome-generate-main"
                  onClick={onGenerate}
                  disabled={generateDisabled}
                  aria-label={generateDisabled ? `Complète les éléments manquants avant de générer (${shortcutLabels.generate})` : withShortcut('Générer le pack', shortcutLabels.generate)}
                >
                  <ToolbarIcon Icon={Package} />
                  <span className="chrome-generate-main-label">Générer le pack</span>
                </button>
              </Tooltip>
              <GenerateMenuPopover
                open={generateMenuOpen}
                onOpenChange={setGenerateMenuOpen}
                generateDisabled={generateDisabled}
                onGenerate={onGenerate}
                onOpenPackMetadata={onOpenPackMetadata}
                onOpenExportFolder={onOpenExportFolder}
                exportPackName={exportPackName}
                generateShortcut={generateShortcut}
                trigger={({ openPopover }) => (
                  <button
                    className="chrome-toolbar-cta chrome-generate-caret"
                    onClick={openPopover}
                    aria-label="Options de génération"
                    aria-haspopup="menu"
                    aria-expanded={generateMenuOpen}
                  >
                    <span className="chrome-generate-caret-glyph" aria-hidden="true">▾</span>
                  </button>
                )}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
