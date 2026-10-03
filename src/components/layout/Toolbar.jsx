// La barre d'outils — **une seule**, pour les deux éditeurs.
//
// Un projet graphe n'a pas d'arbre : la séparation entre l'universel et le
// structurel vit dans `store/toolbarModel.js`, pas dans une seconde barre.
//
// Ce composant **peint** cet inventaire, il ne le décide pas. La règle qui
// compte se lit donc ailleurs et s'éprouve sans monter React ; ici il ne reste
// que le rendu, et la garantie que les groupes universels occupent les mêmes
// rangs des deux côtés — parce qu'ils viennent du même inventaire, dans son
// ordre.
//
// L'état d'enregistrement n'est **pas** ici : il est dit une seule fois, dans
// la barre de titre, présente elle aussi dans les deux éditeurs.

import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Network,
  Package,
  PanelLeft,
  SlidersHorizontal,
  Undo2,
} from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { DEFAULT_SHORTCUT_LABELS, withShortcut } from '../../store/keyboardShortcuts';
import { TOOLBAR_GROUPS, toolbarGroup } from '../../store/toolbarModel';
import { ValidationPill } from './ValidationPill';
import { PackOptionsPopover } from './PackOptionsPopover';
import { ProjectMenuPopover } from './ProjectMenuPopover';
import { PanelSortContext, SortablePanelItem } from '../../workspace/PanelSortContext';
import {
  ADVANCED_WORKSPACE_PANEL_IDS,
  DEFAULT_WORKSPACE_PANEL_ORDER,
  WORKSPACE_PANEL_IDS,
} from '../../workspace/panelLayout';
import './Toolbar.css';

function ToolbarIcon({ Icon, className = 'chrome-icon' }) {
  return <Icon className={className} aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

// L'infobulle d'une commande : son libellé et son raccourci quand elle répond,
// **la raison** quand elle ne répond pas. Une commande suspendue reste visible
// et dit pourquoi ; c'est le comportement acquis de la barre avancée.
function commandTitle(entry) {
  if (!entry) return '';
  const label = withShortcut(entry.label, entry.shortcut);
  return entry.available ? label : `${label} — ${entry.unavailableReason}`;
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

// Un bouton piloté par une entrée d'inventaire : libellé, raccourci,
// disponibilité et raison viennent tous de la même source que le clavier.
// Exporté : l'en-tête du panneau Graphe porte désormais les commandes de
// création, et elles doivent rester **le même bouton** que dans cette barre.
// Les réimiter ailleurs les aurait fait diverger au premier changement de style.
export function CommandButton({ entry, onClick, Icon, iconOnly = false, className = null }) {
  if (!entry) return null;
  const title = commandTitle(entry);
  return (
    <Tooltip text={title}>
      <button
        type="button"
        data-toolbar-id={entry.id}
        className={`chrome-toolbar-btn ${iconOnly ? 'is-icon-only' : ''} ${className ?? ''}`}
        onClick={onClick}
        disabled={!entry.available}
        aria-label={title}
      >
        <span className="chrome-toolbar-btn-icon"><ToolbarIcon Icon={Icon} /></span>
        {!iconOnly ? <span className="chrome-toolbar-btn-label">{entry.label}</span> : null}
      </button>
    </Tooltip>
  );
}

// Bouton segmenté du pill « Arbre / Réglages / Diagramme ».
function PanelToggle({
  id,
  panelId,
  panelOrder,
  title,
  Icon,
  active,
  onClick,
  onMovePanel,
  fixed = false,
  dragHandleProps = {},
  isDragging = false,
}) {
  const {
    ref: dragHandleRef,
    ...sortableProps
  } = dragHandleProps;

  function handleKeyDown(event) {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const currentIndex = panelOrder.indexOf(panelId);
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const targetId = panelOrder[currentIndex + offset];
      if (!targetId) return;
      event.preventDefault();
      onMovePanel?.(panelId, targetId);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const toggles = [...(event.currentTarget.closest('.chrome-panel-pill')?.querySelectorAll('.chrome-panel-toggle') ?? [])];
      const currentIndex = toggles.indexOf(event.currentTarget);
      if (currentIndex < 0) return;
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      toggles[(currentIndex + offset + toggles.length) % toggles.length]?.focus();
    }
  }

  return (
    <Tooltip text={title} disabled={isDragging}>
      <button
        ref={dragHandleRef}
        {...sortableProps}
        type="button"
        data-toolbar-id={id}
        className={`chrome-panel-toggle ${active ? 'is-active' : ''} ${fixed ? 'is-fixed' : ''}`}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        aria-pressed={active}
        aria-disabled={fixed || undefined}
        aria-label={title}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      >
        <ToolbarIcon Icon={Icon} className="chrome-icon" />
      </button>
    </Tooltip>
  );
}

export function Toolbar({
  // L'inventaire décide de tout ce qui est commande : ce qui existe dans cet
  // éditeur, ce qui répond, et pourquoi quand ça ne répond pas.
  inventory = [],
  shortcutLabels = DEFAULT_SHORTCUT_LABELS,
  // La raison de suspension, dite **à côté** des commandes tenues et non à
  // leur place. `null` quand rien n'est suspendu.
  suspensionNotice = null,
  onNewProject,
  onOpenProject,
  onOpenPack,
  onSaveProject,
  onSaveProjectAs,
  onContinueInGraph,
  onUndo,
  onRedo,
  onOpenPreferences,
  // ── Groupes structurels de l'éditeur libre ──────────────────────────────
  panels = { showTree: true, showSettings: true, showDiagram: false },
  panelOrder = DEFAULT_WORKSPACE_PANEL_ORDER,
  onMovePanel,
  onToggleTree,
  onToggleSettings,
  onToggleDiagram,
  onToggleNodeList,
  onToggleInspector,
  packOptionsOpen = false,
  onPackOptionsOpenChange,
  projectType,
  globalOptions,
  // La commande de production, **une seule** : elle achemine elle-même vers la
  // chaîne du projet ouvert. La barre ne sait pas laquelle, et n'a pas à le
  // savoir.
  onGenerate,
  issueKind = 'hierarchical',
  validationIssues = [],
  advancedIssues = null,
  pathAuditPending = false,
  validationOpen = false,
  onValidationOpenChange,
  onSelectIssue,
  onUpdateGlobalOption,
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

  const find = (id) => inventory.find((entry) => entry.id === id) ?? null;
  const fileGroup = toolbarGroup(inventory, TOOLBAR_GROUPS.FILE);
  const hasPanels = toolbarGroup(inventory, TOOLBAR_GROUPS.PANELS).length > 0;
  const packOptions = find('openPackOptions');
  const generate = find('generate');
  const undo = find('undo');
  const redo = find('redo');

  if (inventory.length === 0) return null;

  return (
    <div className="chrome-toolbar">
      <div className="chrome-toolbar-left">
        <ProjectMenuPopover
          open={projectMenuOpen}
          onOpenChange={setProjectMenuOpen}
          shortcutLabels={shortcutLabels}
          commands={fileGroup}
          onNewProject={onNewProject}
          onOpenProject={onOpenProject}
          onOpenPack={onOpenPack}
          onSaveProject={onSaveProject}
          onSaveProjectAs={onSaveProjectAs}
          onContinueInGraph={onContinueInGraph}
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

        <span className="chrome-toolbar-sep" />

        {/* Annuler / Rétablir : universels, donc au même rang des
            deux côtés. L'éditeur libre ne les avait pas. */}
        <CommandButton entry={undo} onClick={onUndo} Icon={Undo2} iconOnly />
        <CommandButton entry={redo} onClick={onRedo} Icon={Undo2} iconOnly className="chrome-toolbar-btn--mirrored" />
      </div>

      <div className="chrome-toolbar-center">
        {hasPanels ? (
          <PanelSortContext items={panelOrder} onMove={onMovePanel}>
            <div className="chrome-panel-pill" role="group" aria-label="Panneaux visibles et réorganisables">
              {panelOrder.map((panelId) => {
                const panel = {
                  [WORKSPACE_PANEL_IDS.STRUCTURE]: {
                    id: 'toggle-tree',
                    title: commandTitle(find('toggleTree')),
                    Icon: PanelLeft,
                    active: panels.showTree,
                    onClick: onToggleTree,
                  },
                  [WORKSPACE_PANEL_IDS.SETTINGS]: {
                    id: 'toggle-settings',
                    title: commandTitle(find('toggleSettings')),
                    Icon: SlidersHorizontal,
                    active: panels.showSettings,
                    onClick: onToggleSettings,
                  },
                  [WORKSPACE_PANEL_IDS.DIAGRAM]: {
                    id: 'toggle-diagram',
                    title: commandTitle(find('toggleDiagram')),
                    Icon: Network,
                    active: panels.showDiagram,
                    onClick: onToggleDiagram,
                  },
                  [ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST]: {
                    id: 'toggle-node-list',
                    title: commandTitle(find('toggleNodeList')),
                    Icon: PanelLeft,
                    active: panels.showNodeList,
                    onClick: onToggleNodeList,
                  },
                  [ADVANCED_WORKSPACE_PANEL_IDS.GRAPH]: {
                    id: 'advanced-graph',
                    title: 'Graphe — surface principale toujours visible',
                    Icon: Network,
                    active: true,
                    fixed: true,
                  },
                  [ADVANCED_WORKSPACE_PANEL_IDS.INSPECTOR]: {
                    id: 'toggle-inspector',
                    title: commandTitle(find('toggleInspector')),
                    Icon: SlidersHorizontal,
                    active: panels.showInspector,
                    onClick: onToggleInspector,
                  },
                }[panelId];
                if (!panel) return null;
                return (
                  <SortablePanelItem key={panelId} id={panelId} className="chrome-panel-sortable">
                    {({ dragHandleProps, isDragging }) => (
                      <PanelToggle
                        {...panel}
                        panelId={panelId}
                        panelOrder={panelOrder}
                        onMovePanel={onMovePanel}
                        dragHandleProps={dragHandleProps}
                        isDragging={isDragging}
                      />
                    )}
                  </SortablePanelItem>
                );
              })}
            </div>
          </PanelSortContext>
        ) : null}

        {/* La raison de la suspension, à côté des commandes tenues. */}
        {suspensionNotice ? (
          <span className="chrome-toolbar-notice" role="status" aria-live="polite">{suspensionNotice}</span>
        ) : null}
      </div>

      <div className="chrome-toolbar-right">
        {packOptions ? (
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
                  title={commandTitle(packOptions)}
                  label={packOptions.label}
                  onClick={() => onPackOptionsOpenChange?.(true)}
                  active={packOptionsOpen}
                  trailing={<span className="chrome-pack-options-caret" aria-hidden="true">▾</span>}
                >
                  <ToolbarIcon Icon={SlidersHorizontal} />
                </ToolbarButton>
              )}
            />
            <span className="chrome-toolbar-sep" />
          </>
        ) : null}

        {find('toggleValidation') ? (
          <>
            <ValidationPill
              issueKind={issueKind}
              validationIssues={validationIssues}
              advancedIssues={advancedIssues}
              pathAuditPending={pathAuditPending}
              open={validationOpen}
              onOpenChange={onValidationOpenChange}
              onSelectIssue={onSelectIssue}
              onCountZeroTransition={handleCountZeroTransition}
              shortcutLabel={shortcutLabels.toggleValidation}
            />
            <span className="chrome-toolbar-sep" />
          </>
        ) : null}

        {/* Un seul bouton de production, au même rang et sous le même
            libellé des deux côtés. `data-toolbar-id` porte son identifiant :
            c'est par lui que la recette de sortie contrôle à l'œil que les deux
            éditeurs montrent bien la même commande. */}
        {generate ? (
          <div className="chrome-generate-split">
            {successToast ? (
              <div className="validation-success-toast" role="status" aria-live="polite">
                <CircleCheck width={13} height={13} aria-hidden="true" />
                <span>Aucun élément à corriger</span>
              </div>
            ) : null}
            <Tooltip text={commandTitle(generate)}>
              <button
                className="chrome-toolbar-cta chrome-generate-main"
                data-toolbar-id={generate.id}
                onClick={onGenerate}
                disabled={!generate.available}
                aria-label={commandTitle(generate)}
              >
                <ToolbarIcon Icon={Package} />
                <span className="chrome-generate-main-label">{generate.label}</span>
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}
