import { TechnicalDetail } from '../common/UserMessage';
import { Trans } from 'react-i18next';
import { translateImport as t, importFollowStatusText as followStatusText } from '../../i18n/importPresentation.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import {presentUserMessage, presentStoredError } from '../../i18n/userMessage.js';
import { getIntlLocale } from '../../i18n/language.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppModalPortal } from '../common/AppModalPortal';
import { Check, Loader2, Rss, Search, X } from '../icons/LucideLocal';
import { FollowedSourceNotice, FollowedSourceChoices } from '../MediaSubscriptions/FollowedImportSource.jsx';
import { useFollowedImportSource, useSubscriptionFollow } from '../MediaSubscriptions/useSubscriptionFollow';
import './PodcastImportModal.css';

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

export function PodcastImportModal({ onImport, onClose, toLibrary = false, initialSource = null, onManageSubscriptions = null }) {
  useMessageLanguage();
  const [phase, setPhase] = useState('url');
  const { url, setUrl, sources: followedSources, followed } = useFollowedImportSource('podcast');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feed, setFeed] = useState(null);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const subscriptionFollow = useSubscriptionFollow('podcast', initialSource);
  const { follow, sourceLoaded: followSourceLoaded, reset: resetFollow, toggle: toggleFollow } = subscriptionFollow;
  const followEnabled = follow.enabled;
  const feedLoadRequestRef = useRef(0);
  const loadingRef = useRef(false);
  const loadedUrlRef = useRef('');
  loadedUrlRef.current = loadedUrl;

  const initialSourceUrl = initialSource?.url?.trim() ?? '';

  useEffect(() => () => {
    feedLoadRequestRef.current += 1;
    loadingRef.current = false;
  }, []);

  const loadFeed = useCallback(async (sourceUrl) => {
    const trimmed = sourceUrl.trim();
    if (!trimmed) return;
    const requestId = ++feedLoadRequestRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await invoke('fetch_podcast_feed', { url: trimmed, proposedEpisodeName: t('import:names.episode.numbered', { number: '{{number}}' }) });
      if (requestId !== feedLoadRequestRef.current) return;
      setFeed(result);
      setLoadedUrl(trimmed);
      setSelected(new Set());
      setQuery('');
      setPhase('episodes');
      followSourceLoaded(trimmed, loadedUrlRef.current);
    } catch (err) {
      if (requestId === feedLoadRequestRef.current) setError(err);
    } finally {
      if (requestId === feedLoadRequestRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [followSourceLoaded]);

  useEffect(() => {
    if (!initialSourceUrl) return;
    setUrl(initialSourceUrl);
    void loadFeed(initialSourceUrl);
  }, [initialSourceUrl, loadFeed]);

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
    if (!trimmed || loadingRef.current) return;
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

  function handleImport() {
    if (selected.size === 0 && !subscriptionFollow.canSubmitAlone) return;
    const chosen = episodes.filter((ep) => selected.has(ep.id));
    const subscriptionRequest = {
      ...subscriptionFollow.requestFields(),
      source: 'podcast',
      url: loadedUrl || url.trim(),
      title: feed?.title || t('import:podcast.default.title'),
      baselineIds: [...new Set(episodes.map((episode) => episode.id).filter(Boolean))],
      baselineComplete: true,
    };
    onImport(chosen, feed, undefined, subscriptionRequest);
    onClose();
  }

  return (
    <AppModalPortal>
      <div
        className="podcast-modal"
        role="dialog"
        aria-label={t('import:podcast.modal.title')}
        onClick={(event) => event.stopPropagation()}
      >
        {phase === 'url' ? (
          <>
            <header className="podcast-head">
              <span className="podcast-head-icon"><Rss /></span>
              <span className="podcast-head-title">{t('import:podcast.modal.title')}</span>
              <span className="podcast-spacer" />
              <button type="button" className="podcast-icon-btn" aria-label={t('common:dialog.close.label')} onClick={onClose} disabled={loading}>
                <X />
              </button>
            </header>

            <div className="podcast-body">
              <form onSubmit={handleLoadFeed}>
                <label className="podcast-field-label" htmlFor="podcast-url-input">{t('import:podcast.feedAddress.label')}</label>
                <label className="podcast-search">
                  <Rss />
                  <input
                    id="podcast-url-input"
                    type="url"
                    inputMode="url"
                    placeholder={t('import:podcast.url.placeholder')}
                    value={url}
                    onChange={(event) => {
                      const nextUrl = event.target.value;
                      if (loadedUrlRef.current && nextUrl.trim() !== loadedUrlRef.current) resetFollow();
                      setUrl(nextUrl);
                    }}
                    disabled={loading}
                    autoFocus
                  />
                </label>
              </form>
              <FollowedSourceChoices id="podcast-followed-sources" sources={followedSources} onChoose={(value) => { resetFollow(); setUrl(value); }} disabled={loading} />
              <p className="podcast-hint">
                {toLibrary ? t('import:podcast.modal.libraryHint') : t('import:podcast.modal.storyHint')}
              </p>
              {followed ? <FollowedSourceNotice followed={followed} onManage={onManageSubscriptions} /> : (
                <label className="podcast-follow-toggle">
                <input
                  type="checkbox"
                  checked={followEnabled}
                  disabled={loading}
                  onChange={(event) => toggleFollow(event.target.checked)}
                />
              <span>
                <strong>{t('import:podcast.follow.label')}</strong>
                <small>{t('import:podcast.follow.hint')}</small>
                <small>{followStatusText(follow)}</small>
              </span>
              </label>
              )}
              {error && <div className="podcast-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={presentUserMessage(error).technicalDetail} /></div>}
            </div>

            <footer className="podcast-foot">
              <button type="button" className="podcast-btn podcast-btn-ghost" onClick={onClose} disabled={loading}>{t('common:dialog.cancel.label')}</button>
              <span className="podcast-spacer" />
              <button
                type="button"
                className="podcast-btn podcast-btn-primary"
                onClick={handleLoadFeed}
                disabled={loading || !url.trim()}
              >
                {loading && <Loader2 className="podcast-spin" />}
                {loading ? t('import:podcast.loading.progress') : t('import:podcast.load.action')}
              </button>
            </footer>
          </>
        ) : (
          <>
            <header className="podcast-head">
              <span className="podcast-head-icon"><Rss /></span>
              <span className="podcast-head-title" title={feed?.title}>{feed?.title || t('import:podcast.default.title')}</span>
              <span className="podcast-head-count">
                {t('import:podcast.episodes.count', { count: episodes.length })}
              </span>
              <span className="podcast-spacer" />
              <button type="button" className="podcast-icon-btn" aria-label={t('common:dialog.close.label')} onClick={onClose}>
                <X />
              </button>
            </header>

            <div className="podcast-subhead">
              {followed ? <FollowedSourceNotice followed={followed} onManage={null} /> : (
                <label className="podcast-follow-toggle">
                <input
                  type="checkbox"
                  checked={followEnabled}
                  disabled={loading}
                  onChange={(event) => toggleFollow(event.target.checked)}
                />
              <span>
                <strong>{t('import:podcast.follow.label')}</strong>
                <small>{t('import:podcast.follow.hint')}</small>
                <small>{followStatusText(follow)}</small>
              </span>
              </label>
              )}
              <div className="podcast-toolbar">
                <label className="podcast-search">
                  <Search />
                  <input
                    type="text"
                    placeholder={t('import:podcast.filter.placeholder')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="podcast-bulk">
                  <button type="button" className="podcast-seg" onClick={selectAllVisible}>{t('import:media.selectAll.action')}</button>
                  <button type="button" className="podcast-seg" onClick={clearSelection} disabled={selected.size === 0}>{t('import:media.clearSelection.action')}</button>
                </div>
              </div>
            </div>

            <div className="podcast-scroll">
              {visibleEpisodes.length === 0 ? (
                <div className="podcast-empty">
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
                      className={`podcast-row${checked ? ' is-selected' : ''}${isNew ? ' is-new' : ''}`}
                      aria-pressed={checked}
                      onClick={() => toggleEpisode(ep.id)}
                    >
                      <span className="podcast-row-check">{checked ? <Check /> : null}</span>
                      <div className="podcast-row-main">
                        <div className="podcast-row-title-line">
                          <div className="podcast-row-name" title={ep.title}>{ep.title}</div>
                          {isNew && <span className="podcast-new-badge">{t('import:media.new.badge')}</span>}
                        </div>
                        {meta && <div className="podcast-row-meta">{meta}</div>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <footer className="podcast-foot">
              <button type="button" className="podcast-btn podcast-btn-ghost" onClick={() => setPhase('url')}>{t('import:media.back.action')}</button>
              <span className="podcast-spacer" />
              <span className="podcast-foot-status"><Trans i18nKey="import:media.selected.count" count={selected.size} components={{ strong: <b /> }} /></span>
              <button
                type="button"
                className="podcast-btn podcast-btn-primary"
                onClick={handleImport}
                disabled={selected.size === 0 && !subscriptionFollow.canSubmitAlone}
              >
                {selected.size > 0
                  ? t('import:podcast.import.action', { count: selected.size })
                  : (subscriptionFollow.canSubmitAlone ? (follow.subscriptionId ? t('import:media.follow.save') : t('import:media.follow.enable')) : t('import:media.import.action'))}
              </button>
            </footer>
          </>
        )}
      </div>
    </AppModalPortal>
  );
}
