import { presentUserMessage } from '../../i18n/userMessage.js';
import { translateHome as t } from '../../i18n/homePresentation.js';
import { useHomeTranslation } from '../../i18n/useHomeTranslation.js';
import { getIntlLocale } from '../../i18n/language.js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useMemo, useState } from 'react';
import './ModeSelector.css';
import { LanguageAnnouncement } from './LanguageAnnouncement.jsx';
import { BookOpenText, FilePen, FolderOpen, Layers, Rss, ShieldCheck, SlidersHorizontal, SquarePen, SwatchBook, Waypoints, X, Youtube } from '../icons/LucideLocal';
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
  if (date.toDateString() === today.toDateString()) return t('home:modeSelector.date.today');
  if (date.toDateString() === yesterday.toDateString()) return t('home:modeSelector.date.yesterday');
  return date.toLocaleDateString(getIntlLocale(), { day: 'numeric', month: 'short' });
}

// Le nom exact de l'éditeur qui rouvrira le projet, comme sur ses cartes.
// Un type inconnu ne se devine pas : aucun libellé plutôt qu'un faux.
function projectTypeLabel(type) {
  if (type === 'advanced') return t('home:modeSelector.graph.label');
  if (type === 'simple') return t('home:modeSelector.simple.label');
  if (type === 'pack') return t('home:modeSelector.menu.label');
  return null;
}

function recoverySubtitle(recovery) {
  return [
    projectTypeLabel(recovery.projectType),
    t('home:modeSelector.recovery.unsaved'),
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
  onOpenCatalogue,
  onOpen,
  onOpenPreferences,
  recentProjects = [],
  onOpenRecent,
  sessionRecoveries = [],
  onRecoverSession,
  onIgnoreSessionRecovery,
}) {
  const { t } = useHomeTranslation();
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
        get title() { return t('home:modeSelector.documentation.errorTitle'); },
        message: { key: 'home:modeSelector.documentation.errorMessage', params: { error: { userMessage: error, codedOnly: true } } },
        technicalDetail: presentUserMessage(error).technicalDetail,
      });
    }
  }

  const editors = [
    {
      key: 'pack',
      Icon: SwatchBook,
      name: t('home:modeSelector.menu.label'),
      desc: t('home:modeSelector.menu.description'),
      note: t('home:modeSelector.menu.previousName'),
      onClick: () => onSelect('pack'),
    },
    {
      key: 'advanced',
      // L'Action est la notion propre à cet éditeur ; `Network` désigne déjà
      // les vues de diagramme et la structure d'un pack.
      Icon: Waypoints,
      name: t('home:modeSelector.graph.label'),
      desc: t('home:modeSelector.graph.description'),
      onClick: onSelectGraph,
    },
    {
      key: 'simple',
      Icon: FilePen,
      name: t('home:modeSelector.simple.label'),
      desc: t('home:modeSelector.simple.description'),
      onClick: () => onSelect('simple'),
    },
  ];

  const actions = [
    onOpenCatalogue && {
      key: 'catalogue',
      Icon: BookOpenText,
      name: t('catalogue:screen.home.label'),
      desc: t('catalogue:screen.home.description'),
      onClick: onOpenCatalogue,
    },
    onEditPack && {
      key: 'edit',
      Icon: SquarePen,
      name: t('home:modeSelector.edit.label'),
      desc: t('home:modeSelector.edit.description'),
      onClick: onEditPack,
    },
    onPodcastFunnel && {
      key: 'podcast',
      Icon: Rss,
      name: t('home:modeSelector.podcast.label'),
      desc: t('home:modeSelector.podcast.description'),
      onClick: onPodcastFunnel,
    },
    onYoutubeFunnel && {
      key: 'youtube',
      Icon: Youtube,
      name: t('home:modeSelector.youtube.label'),
      desc: t('home:modeSelector.youtube.description'),
      onClick: onYoutubeFunnel,
    },
    onAggregatePacks && {
      key: 'aggregate',
      Icon: Layers,
      name: t('home:modeSelector.aggregate.label'),
      desc: t('home:modeSelector.aggregate.description'),
      onClick: onAggregatePacks,
    },
    onCheckPack && {
      key: 'check',
      Icon: ShieldCheck,
      name: t('home:modeSelector.checker.entryLabel'),
      desc: t('home:modeSelector.checker.description'),
      onClick: onCheckPack,
    },
    {
      key: 'open',
      Icon: FolderOpen,
      name: t('home:modeSelector.open.label'),
      desc: t('home:modeSelector.open.description'),
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
          <Tooltip text={t('home:modeSelector.brand.dedication')} placement="below">
            <span className="mode-home-mark" role="img" aria-label="Story Studio" />
          </Tooltip>
          <div className="mode-home-brand">
            <div className="mode-home-wordmark">Story Studio</div>
            <div className="mode-home-tagline">{t('home:modeSelector.brand.tagline')}</div>
          </div>
        </header>

        <LanguageAnnouncement onOpenPreferences={onOpenPreferences} />
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
                  id={tile.key === 'catalogue' ? 'mode-open-catalogue' : undefined}
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
                <span>{t('common:toolbar.preferences.label')}</span>
              </button>
              <a
                className="mode-ghost-button"
                href={DOCUMENTATION_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleDocumentationClick}
              >
                <BookOpenText className="mode-ghost-icon" strokeWidth={1.9} />
                <span>{t('home:modeSelector.documentation.label')}</span>
              </a>
            </div>
          </div>

          {hasProjects && (
            <aside className="mode-projects-pane">
              <div className="mode-projects-eyebrow">{t('home:modeSelector.recent.title')}</div>
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
                        <span className="mode-proj-name">{recovery.projectName || t('home:modeSelector.recovery.fallbackName')}</span>
                        <span className="mode-proj-sub">{recoverySubtitle(recovery)}</span>
                      </span>
                    </button>
                    <Tooltip
                      text={t('home:modeSelector.recovery.dismiss')}
                      placement="above"
                      className="mode-proj-dismiss-tooltip"
                    >
                      <button
                        type="button"
                        className="mode-proj-dismiss"
                        aria-label={t('home:modeSelector.recovery.dismiss')}
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
