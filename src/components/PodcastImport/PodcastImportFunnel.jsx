import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  FunnelFooter,
  FunnelGenerationState,
  FunnelSectionHeader,
  FunnelShell,
  FunnelStepper,
} from '../funnels';
import { Check, Loader2, Rss, Search } from '../icons/LucideLocal';
import './PodcastImportFunnel.css';

const STEPS = [
  { key: 'feed', label: 'Flux RSS' },
  { key: 'episodes', label: 'Épisodes' },
];

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

/**
 * Funnel accueil « Pack depuis un podcast » (plan 06).
 * Réutilise les commandes podcast et délègue l'import réel à App/useImportSession,
 * qui crée les histoires dans l'éditeur après préparation de session.
 */
export function PodcastImportFunnel({ onClose, onImport }) {
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState('');
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [importing, setImporting] = useState(false);
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
    if (!trimmed || loadingFeed) return;
    setLoadingFeed(true);
    setError('');
    try {
      const result = await invoke('fetch_podcast_feed', { url: trimmed });
      setFeed(result);
      setSelected(new Set());
      setQuery('');
      setStep(1);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingFeed(false);
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

  async function handleImport() {
    if (selected.size === 0 || importing) return;
    const chosen = episodes.filter((ep) => selected.has(ep.id));
    setImporting(true);
    setError('');
    try {
      await onImport(chosen, feed);
      onClose();
    } catch (err) {
      setError(`Le podcast n'a pas pu être importé : ${err?.message ?? err}`);
      setImporting(false);
      setStep(1);
    }
  }

  const canOpenEpisodes = !!feed;
  const canUseStepper = !loadingFeed && !importing;
  const primaryDisabled = step === 0
    ? loadingFeed || !url.trim()
    : selected.size === 0 || importing;
  const primaryLabel = step === 0
    ? (loadingFeed ? 'Chargement…' : 'Charger les épisodes')
    : (selected.size > 0
      ? `Importer ${selected.size} épisode${selected.size > 1 ? 's' : ''}`
      : 'Importer');

  return (
    <FunnelShell
      icon={<Rss />}
      title="Pack depuis un podcast"
      subtitle="Choisis un flux RSS, puis les épisodes à transformer en histoires."
      onClose={importing ? () => {} : onClose}
      showChrome={!importing}
      ariaLabel="Créer un pack depuis un podcast"
      stepper={(
        <FunnelStepper
          steps={STEPS}
          current={step}
          onStepClick={(index) => {
            if (index === 1 && !canOpenEpisodes) return;
            setStep(index);
          }}
          disabled={!canUseStepper}
        />
      )}
      footer={(
        <FunnelFooter
          onBack={() => setStep(0)}
          backDisabled={step === 0 || !canUseStepper}
          stepLabel={`Étape ${step + 1} / ${STEPS.length}`}
          onPrimary={step === 0 ? handleLoadFeed : handleImport}
          primaryLabel={primaryLabel}
          primaryIcon={loadingFeed ? <Loader2 className="podcast-funnel-spin" /> : null}
          primaryDisabled={primaryDisabled}
        />
      )}
    >
      {importing ? (
        <FunnelGenerationState
          title="Téléchargement des épisodes…"
          hint="Les histoires arrivent dans l'éditeur."
          phases={[
            { label: 'Session de travail prête', status: 'done' },
            { label: 'Téléchargement des médias', status: 'active' },
            { label: 'Création des histoires', status: 'todo' },
          ]}
        />
      ) : step === 0 ? (
        <div className="funnel-step-content podcast-funnel-step">
          <FunnelSectionHeader
            icon={<Rss />}
            title="Adresse du podcast"
            description="Colle l'URL du flux RSS pour afficher les épisodes disponibles."
          />
          <form className="podcast-funnel-form" onSubmit={handleLoadFeed}>
            <label className="podcast-funnel-field" htmlFor="podcast-funnel-url">
              <Rss />
              <input
                id="podcast-funnel-url"
                type="url"
                inputMode="url"
                placeholder="https://exemple.com/podcast/feed.xml"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={loadingFeed}
                autoFocus
              />
            </label>
          </form>
          <p className="podcast-funnel-hint">
            Tu pourras filtrer et sélectionner les épisodes avant qu'ils soient ajoutés dans l'arbre.
          </p>
          {error && <div className="funnel-error" role="alert">{error}</div>}
        </div>
      ) : (
        <div className="funnel-step-content podcast-funnel-step podcast-funnel-step--episodes">
          <FunnelSectionHeader
            icon={<Rss />}
            title={feed?.title || 'Podcast'}
            description="Sélectionne les épisodes à importer dans le pack."
            trailing={<span className="funnel-badge">{episodes.length} épisode{episodes.length > 1 ? 's' : ''}</span>}
          />
          <div className="podcast-funnel-toolbar">
            <label className="podcast-funnel-field podcast-funnel-field--filter">
              <Search />
              <input
                type="text"
                placeholder="Filtrer les épisodes…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="podcast-funnel-bulk">
              <button type="button" className="podcast-funnel-seg" onClick={selectAllVisible}>
                Tout sélectionner
              </button>
              <button type="button" className="podcast-funnel-seg" onClick={clearSelection} disabled={selected.size === 0}>
                Tout désélectionner
              </button>
            </div>
          </div>
          <div className="podcast-funnel-list">
            {visibleEpisodes.length === 0 ? (
              <div className="podcast-funnel-empty">
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
                    className={`podcast-funnel-row${checked ? ' is-selected' : ''}`}
                    aria-pressed={checked}
                    onClick={() => toggleEpisode(ep.id)}
                  >
                    <span className="podcast-funnel-check">{checked ? <Check /> : null}</span>
                    <span className="podcast-funnel-row-main">
                      <span className="podcast-funnel-row-name" title={ep.title}>{ep.title}</span>
                      {meta && <span className="podcast-funnel-row-meta">{meta}</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {error && <div className="funnel-error" role="alert">{error}</div>}
        </div>
      )}
    </FunnelShell>
  );
}
