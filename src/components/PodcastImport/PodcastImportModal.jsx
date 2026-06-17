import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppModalPortal } from '../common/AppModalPortal';
import { Check, Loader2, Rss, Search, X } from '../icons/LucideLocal';
import './PodcastImportModal.css';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function formatDate(pubDate) {
  if (!pubDate) return '';
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('fr-FR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function episodeMeta(ep) {
  return [formatDate(ep.pubDate), ep.duration, formatBytes(ep.sizeBytes)]
    .map((value) => (value || '').trim())
    .filter(Boolean)
    .join(' · ');
}

export function PodcastImportModal({ onImport, onClose }) {
  const [phase, setPhase] = useState('url');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feed, setFeed] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');

  const episodes = feed?.episodes ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEpisodes = useMemo(
    () => (normalizedQuery
      ? episodes.filter((ep) => ep.title.toLowerCase().includes(normalizedQuery))
      : episodes),
    [episodes, normalizedQuery],
  );

  async function handleLoadFeed(event) {
    event?.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await invoke('fetch_podcast_feed', { url: trimmed });
      setFeed(result);
      setSelected(new Set());
      setQuery('');
      setPhase('episodes');
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleEpisode(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      for (const ep of visibleEpisodes) next.add(ep.id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function handleImport() {
    if (selected.size === 0) return;
    const chosen = episodes.filter((ep) => selected.has(ep.id));
    onImport(chosen, feed);
    onClose();
  }

  return (
    <AppModalPortal>
      <div
        className="podcast-modal"
        role="dialog"
        aria-label="Importer un podcast"
        onClick={(event) => event.stopPropagation()}
      >
        {phase === 'url' ? (
          <>
            <header className="podcast-head">
              <span className="podcast-head-icon"><Rss /></span>
              <span className="podcast-head-title">Importer un podcast</span>
              <span className="podcast-spacer" />
              <button type="button" className="podcast-icon-btn" aria-label="Fermer" onClick={onClose} disabled={loading}>
                <X />
              </button>
            </header>

            <div className="podcast-body">
              <form onSubmit={handleLoadFeed}>
                <label className="podcast-field-label" htmlFor="podcast-url-input">Adresse du flux RSS</label>
                <label className="podcast-search">
                  <Rss />
                  <input
                    id="podcast-url-input"
                    type="url"
                    inputMode="url"
                    placeholder="https://exemple.com/podcast/feed.xml"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    autoFocus
                  />
                </label>
              </form>
              <p className="podcast-hint">
                Collez l'URL du flux RSS du podcast. Vous pourrez choisir les épisodes à télécharger
                avant qu'ils ne deviennent des histoires.
              </p>
              {error && <div className="podcast-error" role="alert">{error}</div>}
            </div>

            <footer className="podcast-foot">
              <button type="button" className="podcast-btn podcast-btn-ghost" onClick={onClose} disabled={loading}>
                Annuler
              </button>
              <span className="podcast-spacer" />
              <button
                type="button"
                className="podcast-btn podcast-btn-primary"
                onClick={handleLoadFeed}
                disabled={loading || !url.trim()}
              >
                {loading && <Loader2 className="podcast-spin" />}
                {loading ? 'Chargement…' : 'Charger les épisodes'}
              </button>
            </footer>
          </>
        ) : (
          <>
            <header className="podcast-head">
              <span className="podcast-head-icon"><Rss /></span>
              <span className="podcast-head-title" title={feed?.title}>{feed?.title || 'Podcast'}</span>
              <span className="podcast-head-count">
                {episodes.length} épisode{episodes.length > 1 ? 's' : ''}
              </span>
              <span className="podcast-spacer" />
              <button type="button" className="podcast-icon-btn" aria-label="Fermer" onClick={onClose}>
                <X />
              </button>
            </header>

            <div className="podcast-subhead">
              <div className="podcast-toolbar">
                <label className="podcast-search">
                  <Search />
                  <input
                    type="text"
                    placeholder="Filtrer les épisodes…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="podcast-bulk">
                  <button type="button" className="podcast-seg" onClick={selectAllVisible}>Tout sélectionner</button>
                  <button type="button" className="podcast-seg" onClick={clearSelection} disabled={selected.size === 0}>
                    Tout désélectionner
                  </button>
                </div>
              </div>
            </div>

            <div className="podcast-scroll">
              {visibleEpisodes.length === 0 ? (
                <div className="podcast-empty">
                  <Search />
                  <span>Aucun épisode ne correspond à ce filtre.</span>
                </div>
              ) : (
                visibleEpisodes.map((ep) => {
                  const checked = selected.has(ep.id);
                  const meta = episodeMeta(ep);
                  return (
                    <button
                      type="button"
                      key={ep.id}
                      className={`podcast-row${checked ? ' is-selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() => toggleEpisode(ep.id)}
                    >
                      <span className="podcast-row-check">{checked ? <Check /> : null}</span>
                      <div className="podcast-row-main">
                        <div className="podcast-row-name" title={ep.title}>{ep.title}</div>
                        {meta && <div className="podcast-row-meta">{meta}</div>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <footer className="podcast-foot">
              <button type="button" className="podcast-btn podcast-btn-ghost" onClick={() => setPhase('url')}>
                Retour
              </button>
              <span className="podcast-spacer" />
              <span className="podcast-foot-status"><b>{selected.size}</b> sélectionné{selected.size > 1 ? 's' : ''}</span>
              <button
                type="button"
                className="podcast-btn podcast-btn-primary"
                onClick={handleImport}
                disabled={selected.size === 0}
              >
                {selected.size > 0
                  ? `Importer ${selected.size} épisode${selected.size > 1 ? 's' : ''}`
                  : 'Importer'}
              </button>
            </footer>
          </>
        )}
      </div>
    </AppModalPortal>
  );
}
