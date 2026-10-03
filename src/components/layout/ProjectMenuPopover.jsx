import { useEffect, useRef } from 'react';
import { FilePen, FolderOpen, House, Package, Save, Waypoints } from '../icons/LucideLocal';
import './ProjectMenuPopover.css';

function ToolbarIcon({ Icon, className = 'chrome-icon' }) {
  return <Icon className={className} aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

// Une entrée du menu, pilotée par l'inventaire de la barre : libellé,
// raccourci et disponibilité viennent de la même source que le clavier. Une
// commande tenue par un export reste **listée** et dit pourquoi, au lieu de
// disparaître du menu.
function ProjectMenuItem({ entry, fallbackLabel, fallbackShortcut, Icon, onClick }) {
  const label = entry?.label ?? fallbackLabel;
  const available = entry ? entry.available : true;
  return (
    <button
      data-toolbar-id={entry?.id}
      className="project-menu-item"
      role="menuitem"
      onClick={available ? onClick : undefined}
      disabled={!available}
      title={available ? undefined : entry.unavailableReason}
    >
      <ToolbarIcon Icon={Icon} />
      <span>
        <strong>{label}</strong>
        <small>{available ? (entry?.shortcut ?? fallbackShortcut) : entry.unavailableReason}</small>
      </span>
    </button>
  );
}

export function ProjectMenuPopover({
  open,
  onOpenChange,
  trigger,
  shortcutLabels,
  // Les entrées du groupe « fichier » de l'inventaire, dans son ordre.
  commands = [],
  onNewProject,
  onOpenProject,
  onOpenPack,
  onSaveProject,
  onSaveProjectAs,
  onContinueInGraph,
}) {
  const find = (id) => commands.find((entry) => entry.id === id) ?? null;
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
      className={`project-menu-wrap ${open ? 'is-open' : ''}`}
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
          <div className="project-menu-bridge" aria-hidden="true" />
          <div className="project-menu" role="menu">
            <div className="project-menu-head">
              {/* L'état d'enregistrement n'est plus dit ici : il est affiché à
                  un seul endroit, la barre de titre, commune aux deux éditeurs. */}
              <strong>Projet</strong>
              <span>Fichier et enregistrement</span>
            </div>
            <ProjectMenuItem
              entry={find('newProject')}
              fallbackLabel="Retour à l’accueil"
              fallbackShortcut={shortcutLabels.newProject}
              Icon={House}
              onClick={() => handleAction(onNewProject)}
            />
            <ProjectMenuItem
              entry={find('openProject')}
              fallbackLabel="Ouvrir un projet"
              fallbackShortcut={shortcutLabels.openProject}
              Icon={FolderOpen}
              onClick={() => handleAction(onOpenProject)}
            />
            <ProjectMenuItem
              entry={find('openPack')}
              fallbackLabel="Ouvrir un pack"
              Icon={Package}
              onClick={() => handleAction(onOpenPack)}
            />
            <span className="project-menu-sep" />
            <ProjectMenuItem
              entry={find('saveProject')}
              fallbackLabel="Enregistrer"
              fallbackShortcut={shortcutLabels.saveProject}
              Icon={Save}
              onClick={() => handleAction(onSaveProject)}
            />
            <ProjectMenuItem
              entry={find('saveProjectAs')}
              fallbackLabel="Enregistrer sous..."
              fallbackShortcut={shortcutLabels.saveAs}
              Icon={FilePen}
              onClick={() => handleAction(onSaveProjectAs)}
            />
            {find('continueInGraph') ? (
              <>
                <span className="project-menu-sep" />
                <ProjectMenuItem
                  entry={find('continueInGraph')}
                  fallbackLabel="Continuer dans l’éditeur graphe…"
                  Icon={Waypoints}
                  onClick={() => handleAction(onContinueInGraph)}
                />
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
