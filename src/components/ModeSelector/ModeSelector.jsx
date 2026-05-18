import { useState } from 'react';
import './ModeSelector.css';
import { FilePen, FolderOpen, ListTodo, SlidersHorizontal, SwatchBook } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';

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

export function ModeSelector({
  onSelect,
  onOpen,
  onOpenPreferences,
  recentProjects = [],
  onOpenRecent,
}) {
  const [documentationOpen, setDocumentationOpen] = useState(false);
  const visibleRecentProjects = recentProjects.slice(0, 5);
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
        </div>
      </section>

      <section className="mode-home-panel mode-home-right">
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
                <span className={`mode-recent-dot tone-${index % 5}`} />
                <span className="mode-recent-copy">
                  <span className="mode-recent-name">{project.name}</span>
                  <span className="mode-recent-type">{projectTypeLabel(project.projectType)}</span>
                </span>
                <span className="mode-recent-date">{formatRecentDate(project.updatedAt)}</span>
              </button>
              </Tooltip>
            ))
          )}
        </div>

        <div className="mode-secondary-actions">
          <button className="mode-secondary-button" onClick={onOpen}>
            <ActionIcon Icon={FolderOpen} />
            <span>Ouvrir un projet</span>
          </button>
          <button className="mode-secondary-button" onClick={onOpenPreferences}>
            <ActionIcon Icon={SlidersHorizontal} />
            <span>Préférences</span>
          </button>
          <button className="mode-secondary-button" onClick={() => setDocumentationOpen(true)}>
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
            <button className="btn" onClick={() => setDocumentationOpen(false)}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}
