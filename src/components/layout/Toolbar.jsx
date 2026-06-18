import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  FilePen,
  Network,
  Package,
  PanelLeft,
  SlidersHorizontal,
} from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { DEFAULT_SHORTCUT_LABELS } from '../../store/keyboardShortcuts';
import { ValidationPill } from './ValidationPill';
import { PackOptionsPopover } from './PackOptionsPopover';
import { GenerateMenuPopover } from './GenerateMenuPopover';
import { ProjectMenuPopover } from './ProjectMenuPopover';
import './Toolbar.css';

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
  saveState,
  generateDisabled,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  activeTab = 'edit',
  onActiveTabChange,
  packOptionsOpen = false,
  onPackOptionsOpenChange,
  projectType,
  globalOptions,
  onUpdateGlobalOption,
  onOpenPreferences,
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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
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

  const panelTabs = [
    {
      id: 'edit',
      label: 'Éditeur',
      title: withShortcut('Éditeur', shortcutLabels.tabEdit),
      Icon: FilePen,
    },
    {
      id: 'diagram',
      label: 'Diagramme',
      title: withShortcut('Diagramme', shortcutLabels.tabDiagram),
      Icon: Network,
    },
  ];

  return (
    <div className="chrome-toolbar">
      <div className="chrome-toolbar-left">
        <ProjectMenuPopover
          open={projectMenuOpen}
          onOpenChange={setProjectMenuOpen}
          shortcutLabels={shortcutLabels}
          onNewProject={onNewProject}
          onOpenProject={onOpenProject}
          onSaveProject={onSaveProject}
          onSaveProjectAs={onSaveProjectAs}
          saveState={saveState}
          trigger={({ openPopover }) => (
            <ToolbarButton
              id="project-menu"
              title="Actions du projet"
              label="Projet"
              onClick={openPopover}
              active={projectMenuOpen}
              trailing={<span className="chrome-project-caret" aria-hidden="true">▾</span>}
            >
              <ToolbarIcon Icon={PanelLeft} />
            </ToolbarButton>
          )}
        />
      </div>

      <div className="chrome-toolbar-center" role="tablist" aria-label="Vue principale">
        {panelTabs.map(({ id, label, title, Icon }) => (
          <ToolbarButton
            key={id}
            id={`tab-${id}`}
            title={title}
            label={label}
            onClick={() => onActiveTabChange?.(id)}
            active={activeTab === id}
          >
            <ToolbarIcon Icon={Icon} />
          </ToolbarButton>
        ))}
      </div>

      <div className="chrome-toolbar-right">
        {showProjectActions ? (
          <>
            <PackOptionsPopover
              open={packOptionsOpen}
              projectType={projectType}
              globalOptions={globalOptions}
              onOpenChange={onPackOptionsOpenChange}
              onUpdateOption={onUpdateGlobalOption}
              onOpenPreferences={onOpenPreferences}
              onOpenPackMetadata={onOpenPackMetadata}
              preferencesShortcut={shortcutLabels.tabOptions}
              trigger={(
                <ToolbarButton
                  id="pack-options"
                  title={withShortcut('Options', shortcutLabels.storySettings)}
                  label="Options"
                  onClick={() => onPackOptionsOpenChange?.(true)}
                  active={packOptionsOpen}
                  trailing={<span className="chrome-pack-options-caret" aria-hidden="true">▾</span>}
                >
                  <ToolbarIcon Icon={SlidersHorizontal} />
                </ToolbarButton>
              )}
            />
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
            <div className="chrome-generate-split">
              {successToast ? (
                <div className="validation-success-toast" role="status" aria-live="polite">
                  <CircleCheck width={13} height={13} aria-hidden="true" />
                  <span>Pack prêt à générer</span>
                </div>
              ) : null}
              <Tooltip text={generateDisabled ? `Passe par « à corriger » avant de générer (${shortcutLabels.generate})` : withShortcut('Générer le pack', shortcutLabels.generate)}>
                <button
                  className="chrome-toolbar-cta chrome-generate-main"
                  onClick={onGenerate}
                  disabled={generateDisabled}
                  aria-label={generateDisabled ? `Passe par « à corriger » avant de générer (${shortcutLabels.generate})` : withShortcut('Générer le pack', shortcutLabels.generate)}
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
