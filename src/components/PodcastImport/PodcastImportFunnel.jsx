import { TechnicalDetail } from '../common/UserMessage';
import { translateImport as t, importFollowStatusText as followStatusText } from '../../i18n/importPresentation.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import {presentUserMessage, presentStoredError } from '../../i18n/userMessage.js';
import { getIntlLocale } from '../../i18n/language.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  FunnelDoneState,
  FunnelFooter,
  FunnelGenerationState,
  FunnelSectionHeader,
  FunnelShell,
  FunnelStepper,
} from '../funnels';
import { Check, Loader2, Rss, Search, TriangleAlert } from '../icons/LucideLocal';
import { useSubscriptionFollow } from '../MediaSubscriptions/useSubscriptionFollow';
import './PodcastImportFunnel.css';

const STEPS = [
  { key: 'feed', labelKey: 'import:podcast.feed.step' },
  { key: 'episodes', labelKey: 'import:podcast.episodes.step' },
];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return t('import:bundle.size.megabytes', { size: mb.toFixed(mb >= 10 ? 0 : 1) });
  return t('import:bundle.size.kilobytes', { size: Math.max(1, Math.round(bytes / 1024)) });
}

function formatDate(pubDate) {
  if (!pubDate) return '';
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(getIntlLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

function episodeMeta(ep) {
  return [formatDate(ep.pubDate), ep.duration, formatBytes(ep.sizeBytes)]
    .map((value) => (value || '').trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * Funnel accueil « Pack depuis un podcast ».
 * Réutilise les commandes podcast et délègue l'import réel à App/useImportSession,
 * qui crée les histoires dans l'éditeur après préparation de session.
 */
export function PodcastImportFunnel({ onClose, onImport, initialSource = null }) {
  useMessageLanguage();
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState('');
  const [loadingFeed, setLoadingFeed] = useState(false);
  // collect (saisie) | importing (téléchargement) | error (échec total → accueil)
  const [importPhase, setImportPhase] = useState('collect');
  const [progress, setProgress] = useState(null);
  const [importError, setImportError] = useState('');
  const [error, setError] = useState('');
  const [feed, setFeed] = useState(null);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const subscriptionFollow = useSubscriptionFollow('podcast', initialSource);
  const { follow, sourceLoaded: followSourceLoaded, reset: resetFollow, toggle: toggleFollow } = subscriptionFollow;
  const followEnabled = follow.enabled;
  const subscriptionId = follow.subscriptionId;
  const feedLoadRequestRef = useRef(0);
  const importRequestRef = useRef(0);
  const loadingFeedRef = useRef(false);
  const loadedUrlRef = useRef('');
  loadedUrlRef.current = loadedUrl;

  const initialSourceUrl = initialSource?.url?.trim() ?? '';

  useEffect(() => () => {
    feedLoadRequestRef.current += 1;
    importRequestRef.current += 1;
    loadingFeedRef.current = false;
  }, []);

  const loadFeed = useCallback(async (sourceUrl) => {
    const trimmed = sourceUrl.trim();
    if (!trimmed) return;
    importRequestRef.current += 1;
    const requestId = ++feedLoadRequestRef.current;
    loadingFeedRef.current = true;
    setLoadingFeed(true);
    setError('');
    try {
      const result = await invoke('fetch_podcast_feed', { url: trimmed, proposedEpisodeName: t('import:names.episode.numbered', { number: '{{number}}' }) });
      if (requestId !== feedLoadRequestRef.current) return;
      setFeed(result);
      setLoadedUrl(trimmed);
      setSelected(new Set());
      setQuery('');
      followSourceLoaded(trimmed, loadedUrlRef.current);
      setStep(1);
    } catch (err) {
      if (requestId === feedLoadRequestRef.current) setError(err);
    } finally {
      if (requestId === feedLoadRequestRef.current) {
        loadingFeedRef.current = false;
        setLoadingFeed(false);
      }
    }
  }, [followSourceLoaded]);

  useEffect(() => {
    if (!initialSourceUrl) return;
    setUrl(initialSourceUrl);
    void loadFeed(initialSourceUrl);
  }, [initialSourceUrl, loadFeed]);

  const importing = importPhase === 'importing';

  const episodes = feed?.episodes ?? [];
  const pendingIds = useMemo(() => (
    loadedUrl && loadedUrl === initialSourceUrl
      ? new Set(initialSource?.pendingIds ?? [])
      : new Set()
  ), [initialSource?.pendingIds, initialSourceUrl, loadedUrl]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEpisodes = useMemo(
    () => [...(normalizedQuery
      ? episodes.filter((ep) => ep.title.toLowerCase().includes(normalizedQuery))
      : episodes)].sort((left, right) => Number(pendingIds.has(right.id)) - Number(pendingIds.has(left.id))),
    [episodes, normalizedQuery, pendingIds],
  );

  async function handleLoadFeed(event) {
    event?.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || loadingFeedRef.current) return;
    await loadFeed(trimmed);
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
    if ((selected.size === 0 && !subscriptionFollow.canSubmitAlone) || importing) return;
    const requestId = ++importRequestRef.current;
    const chosen = episodes.filter((ep) => selected.has(ep.id));
    setError('');
    setImportError('');
    setProgress({
      name: feed?.title || t('import:podcast.default.title'),
      index: 0,
      total: chosen.length,
      get phase() { return chosen.length ? t('import:media.preparation.progress') : (subscriptionId ? t('import:media.followSave.progress') : t('import:media.followEnable.progress')); },
    });
    setImportPhase('importing');
    try {
      // onImport route la progression dans cet écran (et non dans la modale
      // globale d'import) ; il lève en cas d'échec total → écran d'erreur.
      const subscriptionRequest = {
        ...subscriptionFollow.requestFields(),
        source: 'podcast',
        url: loadedUrl || url.trim(),
        title: feed?.title || t('import:podcast.default.title'),
        baselineIds: [...new Set(episodes.map((episode) => episode.id).filter(Boolean))],
        baselineComplete: true,
      };
      await onImport(chosen, feed, setProgress, subscriptionRequest);
      if (requestId !== importRequestRef.current) return;
      onClose();
    } catch (err) {
      if (requestId !== importRequestRef.current) return;
      setImportError(err);
      setImportPhase('error');
    }
  }

  const canOpenEpisodes = !!feed;
  const canUseStepper = !loadingFeed && !importing;
  const canSubmitWithoutEpisodes = subscriptionFollow.canSubmitAlone;
  const primaryDisabled = step === 0
    ? loadingFeed || !url.trim()
    : (selected.size === 0 && !canSubmitWithoutEpisodes) || importing;
  const primaryLabel = step === 0
    ? (loadingFeed ? t('import:podcast.loading.progress') : t('import:podcast.load.action'))
    : (selected.size > 0
      ? t('import:podcast.import.action', { count: selected.size })
      : (canSubmitWithoutEpisodes ? (follow.subscriptionId ? t('import:media.follow.save') : t('import:media.follow.enable')) : t('import:media.import.action')));

  return (
    <FunnelShell
      icon={<Rss />}
      title={t('import:podcast.funnel.title')}
      subtitle={t('import:podcast.funnel.subtitle')}
      onClose={importing ? () => {} : onClose}
      showChrome={importPhase === 'collect'}
      ariaLabel={t('import:podcast.funnel.aria')}
      stepper={(
        <FunnelStepper
          steps={STEPS.map((step) => ({ ...step, label: t(step.labelKey) }))}
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
          stepLabel={t('import:media.step.caption', { step: step + 1, total: STEPS.length })}
          onPrimary={step === 0 ? handleLoadFeed : handleImport}
          primaryLabel={primaryLabel}
          primaryIcon={loadingFeed ? <Loader2 className="podcast-funnel-spin" /> : null}
          primaryDisabled={primaryDisabled}
        />
      )}
    >
      {importPhase === 'importing' ? (
        <FunnelGenerationState
          title={progress?.total === 0
            ? (subscriptionId ? t('import:media.followSave.progress') : t('import:media.followEnable.progress'))
            : t('import:podcast.import.progress')}
          hint={progress?.phase
            ? (progress.name ? `${progress.name} — ${progress.phase}` : progress.phase)
            : t('import:media.import.hint')}
          progress={progress && progress.total ? progress.index / progress.total : null}
        />
      ) : importPhase === 'error' ? (
        <FunnelDoneState
          tone="error"
          icon={<TriangleAlert />}
          title={t('import:media.import.failure')}
          meta={presentStoredError(importError)}
        >
          <TechnicalDetail value={presentUserMessage(importError).technicalDetail} />
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={onClose}>{t('import:podcast.home.action')}</button>
        </FunnelDoneState>
      ) : step === 0 ? (
        <div className="funnel-step-content podcast-funnel-step">
          <FunnelSectionHeader
            icon={<Rss />}
            title={t('import:podcast.address.title')}
            description={t('import:podcast.address.description')}
          />
          <form className="podcast-funnel-form" onSubmit={handleLoadFeed}>
            <label className="podcast-funnel-field" htmlFor="podcast-funnel-url">
              <Rss />
              <input
                id="podcast-funnel-url"
                type="url"
                inputMode="url"
                placeholder={t('import:podcast.url.placeholder')}
                value={url}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  if (loadedUrlRef.current && nextUrl.trim() !== loadedUrlRef.current) resetFollow();
                  setUrl(nextUrl);
                }}
                disabled={loadingFeed}
                autoFocus
              />
            </label>
          </form>
          <p className="podcast-funnel-hint">{t('import:podcast.selection.hint')}</p>
          <label className="podcast-follow-toggle">
            <input
              type="checkbox"
              checked={followEnabled}
              disabled={loadingFeed || importing}
              onChange={(event) => toggleFollow(event.target.checked)}
            />
            <span>
              <strong>{t('import:podcast.follow.label')}</strong>
              <small>{t('import:podcast.follow.hint')}</small>
              <small>{followStatusText(follow)}</small>
            </span>
          </label>
          {error && <div className="funnel-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={presentUserMessage(error).technicalDetail} /></div>}
        </div>
      ) : (
        <div className="funnel-step-content podcast-funnel-step podcast-funnel-step--episodes">
          <FunnelSectionHeader
            icon={<Rss />}
            title={feed?.title || t('import:podcast.default.title')}
            description={t('import:podcast.selection.description')}
            trailing={<span className="funnel-badge">{t('import:podcast.episodes.count', { count: episodes.length })}</span>}
          />
          <label className="podcast-follow-toggle">
            <input
              type="checkbox"
              checked={followEnabled}
              disabled={loadingFeed || importing}
              onChange={(event) => toggleFollow(event.target.checked)}
            />
            <span>
              <strong>{t('import:podcast.follow.label')}</strong>
              <small>{t('import:podcast.follow.hint')}</small>
              <small>{followStatusText(follow)}</small>
            </span>
          </label>
          <div className="podcast-funnel-toolbar">
            <label className="podcast-funnel-field podcast-funnel-field--filter">
              <Search />
              <input
                type="text"
                placeholder={t('import:podcast.filter.placeholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="podcast-funnel-bulk">
              <button type="button" className="podcast-funnel-seg" onClick={selectAllVisible}>{t('import:media.selectAll.action')}</button>
              <button type="button" className="podcast-funnel-seg" onClick={clearSelection} disabled={selected.size === 0}>{t('import:media.clearSelection.action')}</button>
            </div>
          </div>
          <div className="podcast-funnel-list">
            {visibleEpisodes.length === 0 ? (
              <div className="podcast-funnel-empty">
                <Search />
                <span>{t('import:podcast.filter.empty')}</span>
              </div>
            ) : (
              visibleEpisodes.map((ep) => {
                const checked = selected.has(ep.id);
                const isNew = pendingIds.has(ep.id);
                const meta = episodeMeta(ep);
                return (
                  <button
                    type="button"
                    key={ep.id}
                    className={`podcast-funnel-row${checked ? ' is-selected' : ''}${isNew ? ' is-new' : ''}`}
                    aria-pressed={checked}
                    onClick={() => toggleEpisode(ep.id)}
                  >
                    <span className="podcast-funnel-check">{checked ? <Check /> : null}</span>
                    <span className="podcast-funnel-row-main">
                      <span className="podcast-funnel-row-title-line">
                        <span className="podcast-funnel-row-name" title={ep.title}>{ep.title}</span>
                        {isNew && <span className="podcast-funnel-new-badge">{t('import:media.new.badge')}</span>}
                      </span>
                      {meta && <span className="podcast-funnel-row-meta">{meta}</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {error && <div className="funnel-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={presentUserMessage(error).technicalDetail} /></div>}
        </div>
      )}
    </FunnelShell>
  );
}
