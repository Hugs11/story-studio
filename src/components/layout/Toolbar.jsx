import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Network,
  Package,
  PanelLeft,
  SlidersHorizontal,
} from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { DEFAULT_SHORTCUT_LABELS } from '../../store/keyboardShortcuts';
import { ValidationPill } from './ValidationPill';
import { PackOptionsPopover } from './PackOptionsPopover';
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

// Bouton segmenté du pill « Arbre / Réglages / Diagramme ».
// `inert` : la bascule est bloquée (Réglages seul panneau central) → clic no-op côté
// hook, on signale seulement l'état verrouillé visuellement.
function PanelToggle({ id, title, Icon, active, inert = false, onClick }) {
  return (
    <Tooltip text={title}>
      <button
        type="button"
        data-toolbar-id={id}
        className={`chrome-panel-toggle ${active ? 'is-active' : ''} ${inert ? 'is-inert' : ''}`}
        onClick={onClick}
        aria-pressed={active}
        aria-disabled={inert || undefined}
        aria-label={title}
      >
        <ToolbarIcon Icon={Icon} className="chrome-icon" />
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
  panels = { showTree: true, showSettings: true, showDiagram: false },
  onToggleTree,
  onToggleSettings,
  onToggleDiagram,
  packOptionsOpen = false,
  onPackOptionsOpenChange,
  projectType,
  globalOptions,
  onUpdateGlobalOption,
  onOpenPreferences,
  onGenerate,
  validationIssues = [],
  pathAuditPending = false,
  validationOpen = false,
  onValidationOpenChange,
  onSelectIssue,
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
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

      <div className="chrome-toolbar-center">
        <div className="chrome-panel-pill" role="group" aria-label="Panneaux affichés">
          <PanelToggle
            id="toggle-tree"
            title={withShortcut('Afficher/masquer l’arbre', shortcutLabels.toggleTree)}
            Icon={PanelLeft}
            active={panels.showTree}
            onClick={onToggleTree}
          />
          <PanelToggle
            id="toggle-settings"
            title={withShortcut('Afficher/masquer les réglages', shortcutLabels.toggleSettings)}
            Icon={SlidersHorizontal}
            active={panels.showSettings}
            inert={panels.showSettings && !panels.showDiagram}
            onClick={onToggleSettings}
          />
          <PanelToggle
            id="toggle-diagram"
            title={withShortcut('Afficher/masquer le diagramme', shortcutLabels.toggleDiagram)}
            Icon={Network}
            active={panels.showDiagram}
            onClick={onToggleDiagram}
          />
        </div>
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
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
