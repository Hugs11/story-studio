import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useMemo, useState } from 'react';
import './ModeSelector.css';
import { BookOpenText, FilePen, FolderOpen, Layers, Package, Rss, ShieldCheck, SlidersHorizontal, SwatchBook, Waypoints, X, Youtube } from '../icons/LucideLocal';
import { useErrorDialog } from '../common/Dialog';
import { Tooltip } from '../common/Tooltip';
import { useLocalFile } from '../../hooks/useLocalFile';
import { previewProjectFromPath } from '../../store/projectIO';
import { isTauriRuntime } from '../../utils/tauriRuntime';

const DOCUMENTATION_URL = 'https://hugs11.github.io/story-studio/docs/';

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

// Le nom exact de l'éditeur qui rouvrira le projet, comme sur ses cartes.
// Un type inconnu ne se devine pas : aucun libellé plutôt qu'un faux.
function projectTypeLabel(type) {
  if (type === 'advanced') return 'Éditeur graphe';
  if (type === 'simple') return 'Éditeur simplifié';
  if (type === 'pack') return 'Éditeur par menus';
  return null;
}

function recoverySubtitle(recovery) {
  return [
    projectTypeLabel(recovery.projectType),
    'Non enregistré',
    formatRecentDate(recovery.modifiedAtMs),
  ].filter(Boolean).join(' · ');
}

function ProjectThumb({ project, index, loadedThumbnail = undefined }) {
  // La source de vérité est le `.mbah` enregistré. L'entrée des récents
  // sert seulement pendant sa relecture : son chemin peut dater d'avant une
  // promotion de session ou une copie d'image temporaire.
  const thumbnailPath = loadedThumbnail === undefined
    ? (project.thumbnailImage || null)
    : loadedThumbnail;
  const thumbnailUrl = useLocalFile(thumbnailPath);

  if (thumbnailUrl) {
    return (
      <span className="mode-proj-thumb">
        <img src={thumbnailUrl} alt="" />
      </span>
    );
  }

  return <span className={`mode-proj-dot mode-proj-dot--tone-${index % 5}`} />;
}

export function ModeSelector({
  onSelect,
  onSelectGraph,
  onEditPack,
  onPodcastFunnel,
  onYoutubeFunnel,
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
  const { showErrorDialog } = useErrorDialog();
  const [loadedThumbnails, setLoadedThumbnails] = useState({});
  const visibleRecentProjects = useMemo(() => recentProjects.slice(0, 6), [recentProjects]);
  const visibleRecoveries = useMemo(() => sessionRecoveries.slice(0, 2), [sessionRecoveries]);
  const hasProjects = visibleRecentProjects.length > 0 || visibleRecoveries.length > 0;

  async function handleDocumentationClick(event) {
    // En développement web, laisser le lien HTTPS suivre son comportement natif.
    if (!isTauriRuntime()) return;
    event.preventDefault();
    try {
      await openUrl(DOCUMENTATION_URL);
    } catch (error) {
      showErrorDialog({
        title: 'Documentation inaccessible',
        message: `Impossible d’ouvrir la documentation dans le navigateur : ${error}`,
      });
    }
  }

  const editors = [
    {
      key: 'pack',
      Icon: SwatchBook,
      name: 'Éditeur par menus',
      desc: 'Menus et dossiers imbriqués, agrégation de ZIP',
      note: 'Anciennement Éditeur libre',
      onClick: () => onSelect('pack'),
    },
    {
      key: 'advanced',
      // L'Action est la notion propre à cet éditeur ; `Network` désigne déjà
      // les vues de diagramme et la structure d'un pack.
      Icon: Waypoints,
      name: 'Éditeur graphe',
      desc: 'Navigation libre : Écrans, listes de choix et raccords avancés',
      onClick: onSelectGraph,
    },
    {
      key: 'simple',
      Icon: FilePen,
      name: 'Éditeur simplifié',
      desc: 'Un menu, une histoire',
      onClick: () => onSelect('simple'),
    },
  ];

  const actions = [
    onEditPack && {
      key: 'edit',
      Icon: Package,
      name: 'Modifier un pack existant',
      desc: 'Modifie un .zip / .7z ou un dossier d’histoire',
      onClick: onEditPack,
    },
    onPodcastFunnel && {
      key: 'podcast',
      Icon: Rss,
      name: 'Créer un pack depuis un podcast',
      desc: 'Importe les épisodes d’un flux RSS',
      onClick: onPodcastFunnel,
    },
    onYoutubeFunnel && {
      key: 'youtube',
      Icon: Youtube,
      name: 'Créer un pack depuis YouTube',
      desc: 'Importe l’audio d’une URL, playlist ou chaîne',
      onClick: onYoutubeFunnel,
    },
    onAggregatePacks && {
      key: 'aggregate',
      Icon: Layers,
      name: 'Agréger des packs',
      desc: 'Fusionne plusieurs .zip ou .7z',
      onClick: onAggregatePacks,
    },
    onCheckPack && {
      key: 'check',
      Icon: ShieldCheck,
      name: 'Vérifier un pack',
      desc: 'Repère et corrige les erreurs d’un pack existant.',
      onClick: onCheckPack,
    },
    {
      key: 'open',
      Icon: FolderOpen,
      name: 'Ouvrir un projet',
      desc: 'Reprends un projet enregistré',
      onClick: onOpen,
    },
  ].filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    const projectsToLoad = visibleRecentProjects.filter((project) => project?.path);
    if (!projectsToLoad.length) return undefined;

    Promise.all(projectsToLoad.map((project) => (
      previewProjectFromPath(project.path)
        .then((preview) => [project.path, preview?.thumbnailImage || null])
        .catch(() => [project.path, null])
    ))).then((entries) => {
      if (cancelled) return;
      setLoadedThumbnails((prev) => {
        const next = { ...prev };
        for (const [path, thumbnail] of entries) {
          // Le même `.mbah` peut revenir dans les récents après une nouvelle
          // sauvegarde avec une autre vignette : sa relecture remplace alors le
          // cache précédent au lieu de conserver une absence ou un ancien chemin.
          next[path] = thumbnail;
        }
        return next;
      });
    });

    return () => { cancelled = true; };
  }, [visibleRecentProjects]);

  return (
    <div className="mode-selector">
      <div className="mode-home">
        <header className="mode-home-header">
          <Tooltip text="Créé pour Armand, pour que les histoires prennent vie." placement="below">
            <span className="mode-home-mark" role="img" aria-label="Story Studio" />
          </Tooltip>
          <div className="mode-home-brand">
            <div className="mode-home-wordmark">Story Studio</div>
            <div className="mode-home-tagline">
              Crée, organise et génère des histoires audio pour ta Boîte à Histoires Lunii.
            </div>
          </div>
        </header>

        <div className="mode-home-body">
          <div className="mode-home-create">
            <div className="mode-editor-grid">
              {editors.map((tile) => (
                <button
                  key={tile.key}
                  type="button"
                  className="mode-tile mode-tile--editor"
                  onClick={tile.onClick}
                >
                  <span className="mode-tile-icon"><tile.Icon className="mode-tile-icon-svg" strokeWidth={1.9} /></span>
                  <span className="mode-tile-name">{tile.name}</span>
                  <span className="mode-tile-desc">{tile.desc}</span>
                  {tile.note && <span className="mode-tile-note">{tile.note}</span>}
                </button>
              ))}
            </div>

            <div className="mode-home-separator" />

            <div className="mode-action-grid">
              {actions.map((tile) => (
                <button
                  key={tile.key}
                  type="button"
                  className="mode-tile"
                  onClick={tile.onClick}
                >
                  <span className="mode-tile-icon"><tile.Icon className="mode-tile-icon-svg" strokeWidth={1.9} /></span>
                  <span className="mode-tile-name">{tile.name}</span>
                  <span className="mode-tile-desc">{tile.desc}</span>
                </button>
              ))}
            </div>

            <div className="mode-home-links">
              <button type="button" className="mode-ghost-button" onClick={onOpenPreferences}>
                <SlidersHorizontal className="mode-ghost-icon" strokeWidth={1.9} />
                <span>Préférences</span>
              </button>
              <a
                className="mode-ghost-button"
                href={DOCUMENTATION_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleDocumentationClick}
              >
                <BookOpenText className="mode-ghost-icon" strokeWidth={1.9} />
                <span>Documentation</span>
              </a>
            </div>
          </div>

          {hasProjects && (
            <aside className="mode-projects-pane">
              <div className="mode-projects-eyebrow">Projets récents</div>
              <div className="mode-projects-list">
                {visibleRecoveries.map((recovery, index) => (
                  <div
                    className="mode-proj-row mode-proj-row--recovery"
                    key={recovery.sessionDir || recovery.snapshotPath}
                  >
                    <button
                      type="button"
                      className="mode-proj-open"
                      onClick={() => onRecoverSession?.(recovery)}
                    >
                      <ProjectThumb
                        project={recovery}
                        index={index}
                      />
                      <span className="mode-proj-copy">
                        <span className="mode-proj-name">{recovery.projectName || 'Projet récupérable'}</span>
                        <span className="mode-proj-sub">{recoverySubtitle(recovery)}</span>
                      </span>
                    </button>
                    <Tooltip
                      text="Ignorer cette reprise"
                      placement="above"
                      className="mode-proj-dismiss-tooltip"
                    >
                      <button
                        type="button"
                        className="mode-proj-dismiss"
                        aria-label="Ignorer cette reprise"
                        onClick={() => onIgnoreSessionRecovery?.(recovery)}
                      >
                        <X className="mode-proj-dismiss-icon" strokeWidth={2} />
                      </button>
                    </Tooltip>
                  </div>
                ))}

                {visibleRecentProjects.map((project, index) => (
                  <Tooltip key={project.path} text={project.path} placement="above" multiline>
                    <button
                      type="button"
                      className="mode-proj-row"
                      onClick={() => onOpenRecent?.(project.path)}
                    >
                      <ProjectThumb
                        project={project}
                        index={visibleRecoveries.length + index}
                        loadedThumbnail={loadedThumbnails[project.path]}
                      />
                      <span className="mode-proj-copy">
                        <span className="mode-proj-name">{project.projectName || project.name}</span>
                        <span className="mode-proj-sub">{projectTypeLabel(project.projectType)}</span>
                      </span>
                      <span className="mode-proj-date">{formatRecentDate(project.updatedAt)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
