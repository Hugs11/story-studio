import { useEffect, useMemo, useState } from 'react';
import './ModeSelector.css';
import { FilePen, FolderOpen, ListTodo, Package, RotateCcw, Rss, SlidersHorizontal, SwatchBook, Wrench, X } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { useLocalFile } from '../../hooks/useLocalFile';
import { loadProjectFromPath } from '../../store/projectIO';

function formatRecentDate(updatedAt) {
  if (!updatedAt) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (date.toDateString() === yesterday.toDateString()) return 'Hier';
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function projectTypeLabel(type) {
  return type === 'simple' ? 'Histoire' : 'Pack';
}

function ActionIcon({ Icon }) {
  return <Icon className="mode-action-icon-svg" strokeWidth={1.9} />;
}

function RecentProjectThumb({ project, index, loadedThumbnail = null }) {
  const thumbnailPath = project.thumbnailImage || loadedThumbnail || null;
  const thumbnailUrl = useLocalFile(thumbnailPath);

  if (thumbnailUrl) {
    return (
      <span className="mode-recent-thumb">
        <img src={thumbnailUrl} alt="" />
      </span>
    );
  }

  return <span className={`mode-recent-dot tone-${index % 5}`} />;
}

export function ModeSelector({
  onSelect,
  onEditPack,
  onPodcastFunnel,
  onAggregatePacks,
  onCheckPack,
  onOpen,
  onOpenPreferences,
  recentProjects = [],
  onOpenRecent,
  sessionRecoveries = [],
  onRecoverSession,
  onIgnoreSessionRecovery,
}) {
  const [documentationOpen, setDocumentationOpen] = useState(false);
  const [loadedThumbnails, setLoadedThumbnails] = useState({});
  const visibleRecentProjects = useMemo(() => recentProjects.slice(0, 5), [recentProjects]);
  const visibleRecoveries = useMemo(() => sessionRecoveries.slice(0, 2), [sessionRecoveries]);

  useEffect(() => {
    let cancelled = false;
    const projectsToLoad = visibleRecentProjects.filter((project) => (
      project?.path
      && !project.thumbnailImage
    ));
    if (!projectsToLoad.length) return undefined;

    Promise.all(projectsToLoad.map((project) => (
      loadProjectFromPath(project.path)
        .then((result) => [project.path, result?.data?.thumbnailImage || result?.data?.rootImage || null])
        .catch(() => [project.path, null])
    ))).then((entries) => {
      if (cancelled) return;
      setLoadedThumbnails((prev) => {
        const next = { ...prev };
        for (const [path, thumbnail] of entries) {
          if (next[path] === undefined) next[path] = thumbnail;
        }
        return next;
      });
    });

    return () => { cancelled = true; };
  }, [visibleRecentProjects]);

  return (
    <div className="mode-selector">
      <section className="mode-home-panel mode-home-left">
        <div className="mode-brand-block">
          <Tooltip text="Créé pour Armand, pour que les histoires prennent vie." placement="above">
            <img
              src="/logostory.svg"
              alt="Story Studio"
              className="mode-selector-logo"
            />
          </Tooltip>
          <div className="mode-selector-intro">
            Crée, organise et génère des histoires audio pour ta Boîte à Histoires Lunii.
          </div>
        </div>

        <div className="mode-section-title">Nouveau projet</div>
        <div className="mode-action-list">
          <button className="mode-action-card" onClick={() => onSelect('pack')}>
            <span className="mode-action-icon"><ActionIcon Icon={SwatchBook} /></span>
            <span className="mode-action-copy">
              <span className="mode-action-name">Créer un pack d'histoires</span>
              <span className="mode-action-desc">Menus multiples, agrégation de ZIP et navigation personnalisée</span>
            </span>
            <span className="mode-action-arrow">›</span>
          </button>

          <button className="mode-action-card" onClick={() => onSelect('simple')}>
            <span className="mode-action-icon"><ActionIcon Icon={FilePen} /></span>
            <span className="mode-action-copy">
              <span className="mode-action-name">Créer une histoire simple</span>
              <span className="mode-action-desc">Un menu, une histoire</span>
            </span>
            <span className="mode-action-arrow">›</span>
          </button>

          {onEditPack && (
            <button className="mode-action-card" onClick={onEditPack}>
              <span className="mode-action-icon"><ActionIcon Icon={Package} /></span>
              <span className="mode-action-copy">
                <span className="mode-action-name">Modifier un pack</span>
                <span className="mode-action-desc">Ouvre un .zip ou un dossier Lunii et édite-le tout de suite, sans projet</span>
              </span>
              <span className="mode-action-arrow">›</span>
            </button>
          )}

          {onPodcastFunnel && (
            <button className="mode-action-card" onClick={onPodcastFunnel}>
              <span className="mode-action-icon"><ActionIcon Icon={Rss} /></span>
              <span className="mode-action-copy">
                <span className="mode-action-name">Pack depuis un podcast</span>
                <span className="mode-action-desc">Choisis un flux RSS et importe les épisodes comme histoires</span>
              </span>
              <span className="mode-action-arrow">›</span>
            </button>
          )}

          {onAggregatePacks && (
            <button className="mode-action-card" onClick={onAggregatePacks}>
              <span className="mode-action-icon"><ActionIcon Icon={Package} /></span>
              <span className="mode-action-copy">
                <span className="mode-action-name">Agréger des packs</span>
                <span className="mode-action-desc">Fusionne plusieurs .zip ou .7z dans un nouveau pack généré directement</span>
              </span>
              <span className="mode-action-arrow">›</span>
            </button>
          )}
        </div>
      </section>

      <section className="mode-home-panel mode-home-right">
        {visibleRecoveries.length > 0 && (
          <div className="mode-recovery-block">
            <div className="mode-section-heading">
              <div className="mode-section-title">Reprise de session</div>
            </div>
            <div className="mode-recovery-list">
              {visibleRecoveries.map((recovery, index) => (
                <div className="mode-recovery-item" key={recovery.sessionDir || recovery.snapshotPath}>
                  <RecentProjectThumb project={recovery} index={index} />
                  <span className="mode-recent-copy">
                    <span className="mode-recent-name">{recovery.projectName || 'Projet récupérable'}</span>
                    <span className="mode-recent-type">Projet non enregistré · {formatRecentDate(recovery.modifiedAtMs)}</span>
                  </span>
                  <button
                    type="button"
                    className="mode-recovery-action"
                    onClick={() => onRecoverSession?.(recovery)}
                  >
                    <RotateCcw className="mode-action-icon-svg" strokeWidth={2} />
                    <span>Reprendre</span>
                  </button>
                  <Tooltip text="Ignorer cette reprise" placement="above">
                    <button
                      type="button"
                      className="mode-recovery-dismiss"
                      aria-label="Ignorer cette reprise"
                      onClick={() => onIgnoreSessionRecovery?.(recovery)}
                    >
                      <X className="mode-action-icon-svg" strokeWidth={2} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mode-section-heading">
          <div className="mode-section-title">Projets récents</div>
        </div>

        <div className="mode-recent-list">
          {visibleRecentProjects.length === 0 ? (
            <div className="mode-recent-empty">
              Aucun projet récent pour le moment.
            </div>
          ) : (
            visibleRecentProjects.map((project, index) => (
              <Tooltip key={project.path} text={project.path} placement="above" multiline>
              <button
                className="mode-recent-item"
                onClick={() => onOpenRecent?.(project.path)}
              >
                <RecentProjectThumb
                  project={project}
                  index={index}
                  loadedThumbnail={loadedThumbnails[project.path] ?? null}
                />
                <span className="mode-recent-copy">
                  <span className="mode-recent-name">{project.projectName || project.name}</span>
                  <span className="mode-recent-type">{projectTypeLabel(project.projectType)}</span>
                </span>
                <span className="mode-recent-date">{formatRecentDate(project.updatedAt)}</span>
              </button>
              </Tooltip>
            ))
          )}
        </div>

        <div className="mode-secondary-actions">
          <button className="mode-secondary-button mode-secondary-button--open" onClick={onOpen}>
            <ActionIcon Icon={FolderOpen} />
            <span>Ouvrir un projet</span>
          </button>
          {onCheckPack && (
            <button className="mode-secondary-button mode-secondary-button--tool" onClick={onCheckPack}>
              <ActionIcon Icon={Wrench} />
              <span>Vérifier un pack</span>
            </button>
          )}
          <button className="mode-secondary-button mode-secondary-button--tool" onClick={onOpenPreferences}>
            <ActionIcon Icon={SlidersHorizontal} />
            <span>Préférences</span>
          </button>
          <button className="mode-secondary-button mode-secondary-button--tool" onClick={() => setDocumentationOpen(true)}>
            <ActionIcon Icon={ListTodo} />
            <span>Documentation</span>
          </button>
        </div>
      </section>

      {documentationOpen && (
        <div className="mode-doc-overlay" onMouseDown={() => setDocumentationOpen(false)}>
          <div className="mode-doc-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mode-doc-title">Documentation</div>
            <div className="mode-doc-text">
              Je n'ai pas encore eu le temps de m'en occuper. Si tu es volontaire, une contribution sera la bienvenue.
            </div>
            <div className="mode-doc-link">Lien GitHub à ajouter plus tard.</div>
            <Button onClick={() => setDocumentationOpen(false)}>Fermer</Button>
          </div>
        </div>
      )}
    </div>
  );
}
