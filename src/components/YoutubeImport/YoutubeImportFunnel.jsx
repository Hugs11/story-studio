import { TechnicalDetail } from '../common/UserMessage';
import { Trans } from 'react-i18next';
import { translateImport as t, importFollowStatusText as followStatusText } from '../../i18n/importPresentation.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import {presentUserMessage, presentTechnicalMessage, presentStoredError } from '../../i18n/userMessage.js';
import { getIntlLocale } from '../../i18n/language.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  FunnelDoneState,
  FunnelFooter,
  FunnelGenerationState,
  FunnelSectionHeader,
  FunnelShell,
  FunnelStepper,
} from '../funnels';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Search,
  TriangleAlert,
  Youtube,
} from '../icons/LucideLocal';
import { KEYS, read as readSetting, write as writeSetting } from '../../store/persistentSettings';
import { collectPendingEntries, youtubeSubscriptionKind } from '../../store/mediaSubscriptionSource.js';
import { useSubscriptionFollow } from '../MediaSubscriptions/useSubscriptionFollow';
import { isYoutubeBlocked } from '../../utils/youtubeErrors.js';
import { releaseTauriListener } from '../../utils/tauriListener';
import './YoutubeImportFunnel.css';

const STEPS = [
  { key: 'url', labelKey: 'import:youtube.address.step' },
  { key: 'videos', labelKey: 'import:youtube.videos.step' },
];
const LANGUAGE_STEP = { key: 'language', labelKey: 'import:youtube.audio.step' };

// Garde-fou de sélection : au-delà, on avertit (ton friendly, non bloquant).
const SELECTION_SOFT_CAP = 50;

function videoMeta(video) {
  return [video.duration].filter(Boolean).join(' · ');
}

function videoKey(video) {
  return video.selectionKey || video.id || video.audioUrl;
}

function areYoutubePagesComplete(pageCache) {
  let pageNumber = 1;
  while (true) {
    const page = pageCache.get(pageNumber);
    if (!page) return false;
    if (!page.hasNext) return true;
    pageNumber += 1;
  }
}

function languageLabel(code) {
  const descriptive = /-desc$/i.test(code);
  const languageCode = descriptive ? code.replace(/-desc$/i, '') : code;
  let label = languageCode;
  try {
    label = new Intl.DisplayNames([getIntlLocale()], { type: 'language' }).of(languageCode) || languageCode;
  } catch {
    // Les codes privés ou futurs de YouTube restent lisibles tels quels.
  }
  const normalized = label.charAt(0).toLocaleUpperCase(getIntlLocale()) + label.slice(1);
  return descriptive ? t('import:youtube.language.description', { language: normalized }) : normalized;
}

function hasMultipleLanguages(languages) {
  const families = new Set(
    languages.map((language) => language.replace(/-desc$/i, '').toLowerCase()),
  );
  return families.size > 1;
}

/**
 * Funnel « Pack depuis YouTube » — jumeau du funnel podcast, source
 * yt-dlp. Sert l'entrée accueil (`mode="home"`, session éphémère créée par le
 * parent) **et** l'import dans l'éditeur libre (`mode="editor"`, projet courant) :
 * le composant est identique, seul `onImport` change côté parent.
 *
 * Premier usage : avertissement CGU (accepté une fois) puis téléchargement
 * automatique de yt-dlp, reflété par l'écran « Préparation… ».
 */
export function YoutubeImportFunnel({ onClose, onImport, mode = 'home', toLibrary = false, initialSource = null }) {
  const ytDlpPath = useMemo(() => readSetting(KEYS.YTDLP_CUSTOM_PATH, { defaultValue: '' }), []);
  const cguAccepted = useMemo(() => readSetting(KEYS.YOUTUBE_CGU_ACCEPTED) === 'true', []);

  const [step, setStep] = useState(0);
  const [url, setUrl] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');
  const subscriptionFollow = useSubscriptionFollow('youtube', initialSource);
  const { follow, sourceLoaded: followSourceLoaded, reset: resetFollow, toggle: toggleFollow } = subscriptionFollow;
  const followEnabled = follow.enabled;
  const subscriptionId = follow.subscriptionId;
  // cgu | collect | loading (provisioning + listing) | analyzing | importing | error
  const [phase, setPhase] = useState(cguAccepted ? 'collect' : 'cgu');
  const [list, setList] = useState(null);
  // La valeur complète est conservée afin que l'import couvre toutes les
  // pages sélectionnées, pas seulement celle qui est affichée.
  const [selected, setSelected] = useState(() => new Map());
  // Nouveautés signalées, cherchées dans toutes les pages utiles (en fin de
  // playlist le plus souvent) pour être présentées avant la page affichée.
  const [pendingVideos, setPendingVideos] = useState([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [importError, setImportError] = useState('');
  const [progress, setProgress] = useState(null);
  useMessageLanguage();
  const [logMessage, setLogMessage] = useState('');
  const [audioLanguageOptions, setAudioLanguageOptions] = useState([]);
  const [audioLanguage, setAudioLanguage] = useState('');
  const pageCacheRef = useRef(new Map());
  const listingBusyRef = useRef(false);
  const listingRequestRef = useRef(0);
  const analysisRequestRef = useRef(0);
  const importRequestRef = useRef(0);
  const loadedUrlRef = useRef('');
  const initialSourceRef = useRef(initialSource);
  initialSourceRef.current = initialSource;
  loadedUrlRef.current = loadedUrl;
  const initialSourceUrl = initialSource?.url?.trim() ?? '';

  useEffect(() => () => {
    listingRequestRef.current += 1;
    analysisRequestRef.current += 1;
    importRequestRef.current += 1;
    listingBusyRef.current = false;
  }, []);

  const busy = phase === 'loading' || phase === 'analyzing' || phase === 'importing';
  const steps = audioLanguageOptions.length > 1 ? [...STEPS, LANGUAGE_STEP] : STEPS;

  // Progression de provisionnement/téléchargement émise par le backend.
  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    listen('youtube-log', (event) => {
      if (!disposed) setLogMessage(event.payload);
    }).then((fn) => {
      if (disposed) void releaseTauriListener(fn);
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      void releaseTauriListener(unlisten);
    };
  }, []);

  const loadPage = useCallback(async (targetPage, sourceUrl, { initial = false } = {}) => {
    const trimmed = sourceUrl.trim();
    if (!trimmed || listingBusyRef.current || targetPage < 1) return;
    const requestId = ++listingRequestRef.current;
    const cached = initial ? null : pageCacheRef.current.get(targetPage);
    if (cached) {
      setError('');
      setLogMessage('');
      setList(cached);
      setLoadedUrl(trimmed);
      setQuery('');
      setStep(1);
      setPhase('collect');
      return;
    }
    listingBusyRef.current = true;
    setError('');
    setLogMessage('');
    setPhase('loading');
    try {
      const result = await invoke('fetch_youtube_list', {
        url: trimmed,
        ytdlpPath: ytDlpPath,
        page: targetPage,
        proposedVideoName: t('import:names.video.fallback'),
      });
      if (requestId !== listingRequestRef.current) return;
      pageCacheRef.current.set(targetPage, result);
      const source = initialSourceRef.current;
      if (initial && targetPage === 1 && trimmed === source?.url?.trim() && source.pendingIds?.length) {
        const found = await collectPendingEntries({
          firstPage: result,
          pendingIds: source.pendingIds,
          fetchPage: async (pageNumber) => {
            setLogMessage({ key: 'import:youtube.search.progress', params: { page: pageNumber } });
            const cachedPage = pageCacheRef.current.get(pageNumber);
            if (cachedPage) return cachedPage;
            return invoke('fetch_youtube_list', { url: trimmed, ytdlpPath: ytDlpPath, page: pageNumber, proposedVideoName: t('import:names.video.fallback') });
          },
          onPage: (pageNumber, pageResult) => pageCacheRef.current.set(pageNumber, pageResult),
          isCurrent: () => requestId === listingRequestRef.current,
        });
        if (requestId !== listingRequestRef.current || !found) return;
        setPendingVideos(found);
      } else if (initial) {
        setPendingVideos([]);
      }
      setList(result);
      setLoadedUrl(trimmed);
      setQuery('');
      setStep(1);
      setPhase('collect');
      if (initial) {
        if (!youtubeSubscriptionKind(trimmed)) resetFollow();
        else followSourceLoaded(trimmed, loadedUrlRef.current);
      }
    } catch (err) {
      if (requestId !== listingRequestRef.current) return;
      setError(err);
      setPhase('collect');
      setStep(initial ? 0 : 1);
    } finally {
      if (requestId === listingRequestRef.current) listingBusyRef.current = false;
    }
  }, [followSourceLoaded, resetFollow, ytDlpPath]);

  const beginSourceLoad = useCallback((sourceUrl) => {
    listingRequestRef.current += 1;
    analysisRequestRef.current += 1;
    importRequestRef.current += 1;
    listingBusyRef.current = false;
    pageCacheRef.current.clear();
    setList(null);
    setSelected(new Map());
    setAudioLanguageOptions([]);
    setAudioLanguage('');
    void loadPage(1, sourceUrl, { initial: true });
  }, [loadPage]);

  useEffect(() => {
    if (!initialSourceUrl) return;
    setUrl(initialSourceUrl);
    if (cguAccepted) beginSourceLoad(initialSourceUrl);
  }, [beginSourceLoad, cguAccepted, initialSourceUrl]);

  const videos = list?.videos ?? [];
  const pendingIds = useMemo(() => (
    loadedUrl && loadedUrl === initialSourceUrl
      ? new Set(initialSource?.pendingIds ?? [])
      : new Set()
  ), [initialSource?.pendingIds, initialSourceUrl, loadedUrl]);
  const normalizedQuery = query.trim().toLowerCase();
  const currentSourceKind = youtubeSubscriptionKind(step === 0 ? url : loadedUrl);
  const canFollowSource = Boolean(currentSourceKind);
  const matchesQuery = useCallback(
    (video) => !normalizedQuery || video.title.toLowerCase().includes(normalizedQuery),
    [normalizedQuery],
  );
  // Les nouveautés retrouvées sont listées une seule fois, en tête ; la page
  // affichée garde les autres vidéos.
  const highlightedVideos = useMemo(
    () => (loadedUrl && loadedUrl === initialSourceUrl ? pendingVideos : []),
    [initialSourceUrl, loadedUrl, pendingVideos],
  );
  const visiblePendingVideos = useMemo(
    () => highlightedVideos.filter(matchesQuery),
    [highlightedVideos, matchesQuery],
  );
  const visibleVideos = useMemo(() => {
    const highlighted = new Set(highlightedVideos.map(videoKey));
    return videos.filter((video) => !highlighted.has(videoKey(video)) && matchesQuery(video))
      .sort((left, right) => Number(pendingIds.has(right.id)) - Number(pendingIds.has(left.id)));
  }, [videos, highlightedVideos, matchesQuery, pendingIds]);

  function handleAcceptCgu() {
    writeSetting(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');
    setPhase('collect');
    if (initialSourceUrl) beginSourceLoad(initialSourceUrl);
  }

  async function handleLoadList(event) {
    event?.preventDefault();
    const sourceUrl = url.trim();
    if (!sourceUrl || busy || listingBusyRef.current) return;
    pageCacheRef.current.clear();
    setList(null);
    setSelected(new Map());
    setAudioLanguageOptions([]);
    setAudioLanguage('');
    await loadPage(1, sourceUrl, { initial: true });
  }

  function invalidateAudioChoice() {
    setAudioLanguageOptions([]);
    setAudioLanguage('');
  }

  function toggleVideo(video) {
    const key = videoKey(video);
    invalidateAudioChoice();
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, video);
      return next;
    });
  }

  function selectAllVisible() {
    invalidateAudioChoice();
    setSelected((current) => {
      const next = new Map(current);
      for (const video of [...visiblePendingVideos, ...visibleVideos]) {
        next.set(videoKey(video), video);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Map());
    invalidateAudioChoice();
  }

  function chosenVideos() {
    return [...selected.values()].sort(
      (left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0),
    );
  }

  function buildSubscriptionRequest() {
    const sourceUrl = loadedUrl || url.trim();
    const sourceKind = youtubeSubscriptionKind(sourceUrl);
    const baselineIds = [...new Set(
      [...pageCacheRef.current.values()]
        .flatMap((page) => page.videos ?? [])
        .map((video) => video.id)
        .filter(Boolean),
    )];
    return {
      ...subscriptionFollow.requestFields(),
      source: 'youtube',
      ...(sourceKind ? { sourceKind } : {}),
      url: sourceUrl,
      title: list?.title || 'YouTube',
      baselineIds,
      baselineComplete: areYoutubePagesComplete(pageCacheRef.current),
    };
  }

  async function resolveAudioLanguageOptions(chosen) {
    const languagesById = new Map();
    const unresolvedUrls = [];
    for (const video of chosen) {
      const languages = Array.isArray(video.audioLanguages)
        ? [...new Set(video.audioLanguages.filter(Boolean))]
        : [];
      if (video.audioLanguagesResolved) languagesById.set(video.id, languages);
      else unresolvedUrls.push(video.audioUrl);
    }

    if (unresolvedUrls.length > 0) {
      const resolved = await invoke('fetch_youtube_audio_languages', {
        videoUrls: unresolvedUrls,
        ytdlpPath: ytDlpPath,
      });
      for (const video of resolved ?? []) {
        if (video?.id && Array.isArray(video.languages)) {
          languagesById.set(video.id, [...new Set(video.languages.filter(Boolean))]);
        }
      }
    }

    const options = new Set();
    for (const video of chosen) {
      const languages = languagesById.get(video.id) ?? [];
      if (!hasMultipleLanguages(languages)) continue;
      for (const language of languages) options.add(language);
    }
    return [...options].sort((left, right) => (
      languageLabel(left).localeCompare(languageLabel(right), getIntlLocale())
    ));
  }

  async function runImport(chosen, selectedLanguage = '') {
    if (chosen.length === 0 && !subscriptionFollow.canSubmitAlone) return;
    const requestId = ++importRequestRef.current;
    setError('');
    setImportError('');
    setLogMessage('');
    setProgress({
      name: list?.title || 'YouTube',
      index: 0,
      total: chosen.length,
      get phase() { return chosen.length ? t('import:media.preparation.progress') : (subscriptionId ? t('import:media.followSave.progress') : t('import:media.followEnable.progress')); },
    });
    setPhase('importing');
    try {
      // Le parent gère l'import et, si besoin, complète la baseline YouTube paginée.
      const videosToImport = selectedLanguage
        ? chosen.map((video) => ({ ...video, audioLanguage: selectedLanguage }))
        : chosen;
      await onImport(videosToImport, list, setProgress, buildSubscriptionRequest());
      if (requestId !== importRequestRef.current) return;
      onClose();
    } catch (err) {
      if (requestId !== importRequestRef.current) return;
      setImportError(err);
      setPhase('error');
    }
  }

  async function handlePrepareImport() {
    if ((selected.size === 0 && !subscriptionFollow.canSubmitAlone) || busy) return;
    const chosen = chosenVideos();
    if (chosen.length === 0) {
      await runImport(chosen);
      return;
    }
    if (audioLanguageOptions.length > 1) {
      setStep(2);
      return;
    }

    setError('');
    setLogMessage('');
    setPhase('analyzing');
    const requestId = ++analysisRequestRef.current;
    try {
      const options = await resolveAudioLanguageOptions(chosen);
      if (requestId !== analysisRequestRef.current) return;
      if (options.length > 1) {
        setAudioLanguageOptions(options);
        setAudioLanguage('');
        setStep(2);
        setPhase('collect');
        return;
      }
    } catch (err) {
      if (requestId !== analysisRequestRef.current) return;
      // Un blocage de YouTube empêcherait aussi les téléchargements : insister
      // ne ferait que le prolonger.
      if (isYoutubeBlocked(err)) {
        setError(err);
        setPhase('collect');
        return;
      }
      // Métadonnées absentes/incomplètes : l'import historique reste utilisable.
    }
    await runImport(chosen);
  }

  function handleImport() {
    if ((selected.size === 0 && !subscriptionFollow.canSubmitAlone) || busy) return;
    return runImport(chosenVideos(), audioLanguage);
  }

  function renderVideoRow(video) {
    const currentVideoKey = videoKey(video);
    const checked = selected.has(currentVideoKey);
    const isNew = pendingIds.has(video.id);
    const meta = videoMeta(video);
    return (
      <button
        type="button"
        key={currentVideoKey}
        className={`youtube-funnel-row${checked ? ' is-selected' : ''}${isNew ? ' is-new' : ''}`}
        aria-pressed={checked}
        onClick={() => toggleVideo(video)}
      >
        <span className="youtube-funnel-check">{checked ? <Check /> : null}</span>
        <span className="youtube-funnel-row-main">
          <span className="youtube-funnel-row-title-line">
            <span className="youtube-funnel-row-name" title={video.title}>{video.title}</span>
            {isNew && <span className="youtube-funnel-new-badge">{t('import:media.new.badge')}</span>}
          </span>
          {meta && <span className="youtube-funnel-row-meta">{meta}</span>}
        </span>
      </button>
    );
  }

  const canOpenVideos = !!list;
  const currentPage = list?.page ?? 1;
  const pageSize = list?.pageSize ?? 400;
  const firstVisibleIndex = ((currentPage - 1) * pageSize) + 1;
  const lastVisibleIndex = firstVisibleIndex + Math.max(videos.length - 1, 0);
  const overCap = selected.size > SELECTION_SOFT_CAP;
  const canSubmitWithoutVideos = subscriptionFollow.canSubmitAlone;
  const primaryDisabled = busy || (step === 0
    ? !url.trim()
    : (selected.size === 0 && !canSubmitWithoutVideos));
  const primaryLabel = step === 0
    ? t('import:youtube.load.action')
    : (selected.size > 0
      ? t('import:youtube.import.action', { count: selected.size })
      : (canSubmitWithoutVideos ? (follow.subscriptionId ? t('import:media.follow.save') : t('import:media.follow.enable')) : t('import:media.import.action')));

  const subtitle = mode === 'editor'
    ? (toLibrary
      ? t('import:youtube.editorMedia.subtitle')
      : t('import:youtube.editorStories.subtitle'))
    : t('import:youtube.funnel.subtitle');

  return (
    <FunnelShell
      icon={<Youtube />}
      title={t('import:youtube.funnel.title')}
      subtitle={subtitle}
      onClose={busy ? () => {} : onClose}
      showChrome={phase === 'collect'}
      ariaLabel={t('import:youtube.funnel.aria')}
      stepper={(
        <FunnelStepper
          steps={steps.map((step) => ({ ...step, label: t(step.labelKey) }))}
          current={step}
          onStepClick={(index) => {
            if (index === 1 && !canOpenVideos) return;
            if (index === 2 && audioLanguageOptions.length <= 1) return;
            setStep(index);
          }}
        />
      )}
      footer={(
        <FunnelFooter
          onBack={() => setStep((current) => Math.max(0, current - 1))}
          backDisabled={step === 0}
          stepLabel={t('import:media.step.caption', { step: step + 1, total: steps.length })}
          onPrimary={step === 0 ? handleLoadList : (step === 1 ? handlePrepareImport : handleImport)}
          primaryLabel={primaryLabel}
          primaryDisabled={primaryDisabled}
        />
      )}
    >
      {phase === 'cgu' ? (
        <div className="funnel-step-content youtube-funnel-step youtube-funnel-cgu">
          <FunnelSectionHeader
            icon={<Info />}
            title={t('import:youtube.terms.title')}
            description={t('import:youtube.terms.description')}
          />
          <p className="youtube-funnel-cgu-text">
            <Trans i18nKey="import:youtube.terms.message" components={{ strong: <strong /> }} />
          </p>
          <p className="youtube-funnel-hint">{t('import:youtube.tool.hint')}</p>
          <div className="youtube-funnel-cgu-actions">
            <button type="button" className="funnel-btn funnel-btn-primary" onClick={handleAcceptCgu}>{t('import:youtube.accept.action')}</button>
          </div>
        </div>
      ) : phase === 'loading' ? (
        <FunnelGenerationState
          title={t('import:youtube.preparation.progress')}
          hint={presentTechnicalMessage(logMessage) || t('import:youtube.reading.hint')}
        />
      ) : phase === 'analyzing' ? (
        <FunnelGenerationState
          title={t('import:youtube.audioAnalysis.progress')}
          hint={presentTechnicalMessage(logMessage) || t('import:youtube.audioAnalysis.hint')}
        />
      ) : phase === 'importing' ? (
        <FunnelGenerationState
          title={progress?.total === 0
            ? (subscriptionId ? t('import:media.followSave.progress') : t('import:media.followEnable.progress'))
            : t('import:youtube.import.progress')}
          hint={progress?.phase
            ? (progress.name ? `${progress.name} — ${progress.phase}` : progress.phase)
            : (presentTechnicalMessage(logMessage) || t('import:media.import.hint'))}
          progress={progress && progress.total ? progress.index / progress.total : null}
        />
      ) : phase === 'error' ? (
        <FunnelDoneState
          tone="error"
          icon={<TriangleAlert />}
          title={t('import:media.import.failure')}
          meta={presentStoredError(importError)}
        >
          <TechnicalDetail value={presentUserMessage(importError).technicalDetail} />
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={onClose}>{t('common:dialog.close.label')}</button>
        </FunnelDoneState>
      ) : step === 0 ? (
        <div className="funnel-step-content youtube-funnel-step">
          <FunnelSectionHeader
            icon={<Youtube />}
            title={t('import:youtube.address.title')}
            description={t('import:youtube.address.description')}
          />
          <form className="youtube-funnel-form" onSubmit={handleLoadList}>
            <label className="youtube-funnel-field" htmlFor="youtube-funnel-url">
              <Youtube />
              <input
                id="youtube-funnel-url"
                type="url"
                inputMode="url"
                placeholder={t('import:youtube.url.placeholder')}
                value={url}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  if (loadedUrlRef.current && nextUrl.trim() !== loadedUrlRef.current) resetFollow();
                  setUrl(nextUrl);
                }}
                autoFocus
              />
            </label>
          </form>
          <p className="youtube-funnel-hint">
            {toLibrary ? t('import:youtube.selection.libraryHint') : t('import:youtube.selection.treeHint')}
          </p>
          <label className={`youtube-follow-toggle${canFollowSource ? '' : ' is-disabled'}`}>
            <input
              type="checkbox"
              checked={followEnabled}
              disabled={!canFollowSource}
              onChange={(event) => toggleFollow(event.target.checked)}
            />
            <span>
              <strong>{t('import:youtube.follow.label')}</strong>
              <small>{canFollowSource
                ? t('import:youtube.follow.hint')
                : t('import:youtube.follow.unavailable')}
              </small>
              {canFollowSource && <small>{followStatusText(follow)}</small>}
            </span>
          </label>
          {error && <div className="funnel-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={presentUserMessage(error).technicalDetail} /></div>}
        </div>
      ) : step === 1 ? (
        <div className="funnel-step-content youtube-funnel-step youtube-funnel-step--videos">
          <FunnelSectionHeader
            icon={<Youtube />}
            title={list?.title || 'YouTube'}
            description={toLibrary
              ? t('import:youtube.selection.media')
              : t('import:youtube.selection.stories')}
            trailing={(
              <span className="funnel-badge">
                {videos.length > 0
                  ? `${firstVisibleIndex}–${lastVisibleIndex}`
                  : t('import:youtube.videos.empty')}
              </span>
            )}
          />
          <label className={`youtube-follow-toggle${canFollowSource ? '' : ' is-disabled'}`}>
            <input
              type="checkbox"
              checked={followEnabled}
              disabled={!canFollowSource}
              onChange={(event) => toggleFollow(event.target.checked)}
            />
            <span>
              <strong>{t('import:youtube.follow.label')}</strong>
              <small>{canFollowSource
                ? t('import:youtube.follow.hint')
                : t('import:youtube.follow.unavailable')}
              </small>
              {canFollowSource && <small>{followStatusText(follow)}</small>}
            </span>
          </label>
          <div className="youtube-funnel-toolbar">
            <label className="youtube-funnel-field youtube-funnel-field--filter">
              <Search />
              <input
                type="text"
                placeholder={t('import:youtube.filter.placeholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              </label>
            <div className="youtube-funnel-bulk">
              <button type="button" className="youtube-funnel-seg" onClick={selectAllVisible}>{t('import:youtube.selectAll.action')}</button>
              <button type="button" className="youtube-funnel-seg" onClick={clearSelection} disabled={selected.size === 0}>{t('import:media.clearSelection.action')}</button>
            </div>
          </div>
          {overCap && (
            <div className="youtube-funnel-notice" role="status">
              <Info />
              <span>{t('import:youtube.selection.notice', { count: selected.size })}</span>
            </div>
          )}
          <div className="youtube-funnel-list">
            {visiblePendingVideos.length === 0 && visibleVideos.length === 0 ? (
              <div className="youtube-funnel-empty">
                <Search />
                <span>{t('import:youtube.filter.empty')}</span>
              </div>
            ) : (
              <>
                {visiblePendingVideos.length > 0 && (
                  <>
                    <div className="youtube-funnel-list-heading">{t('import:youtube.new.heading')}</div>
                    {visiblePendingVideos.map(renderVideoRow)}
                    {visibleVideos.length > 0 && (
                      <div className="youtube-funnel-list-heading">{t('import:youtube.page.heading', { page: currentPage })}</div>
                    )}
                  </>
                )}
                {visibleVideos.map(renderVideoRow)}
              </>
            )}
          </div>
          <nav className="youtube-funnel-pagination" aria-label={t('import:youtube.pagination.aria')}>
            <button
              type="button"
              className="youtube-funnel-page-btn"
              onClick={() => loadPage(currentPage - 1, loadedUrl)}
              disabled={currentPage <= 1 || busy}
            >
              <ChevronLeft />
              <span>{t('import:youtube.previous.action')}</span>
            </button>
            <span className="youtube-funnel-page-label">{t('import:youtube.page.label', { page: currentPage })}</span>
            <button
              type="button"
              className="youtube-funnel-page-btn"
              onClick={() => loadPage(currentPage + 1, loadedUrl)}
              disabled={!list?.hasNext || busy}
            >
              <span>{t('import:youtube.next.action')}</span>
              <ChevronRight />
            </button>
          </nav>
          {error && <div className="funnel-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={presentUserMessage(error).technicalDetail} /></div>}
        </div>
      ) : (
        <div className="funnel-step-content youtube-funnel-step youtube-funnel-step--audio">
          <FunnelSectionHeader
            icon={<Youtube />}
            title={t('import:youtube.audio.title')}
            description={t('import:youtube.audio.description')}
          />
          <div className="youtube-funnel-language-list" role="radiogroup" aria-label={t('import:youtube.audio.aria')}>
            <label className={`youtube-funnel-language${audioLanguage === '' ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="youtube-audio-language"
                value=""
                checked={audioLanguage === ''}
                onChange={() => setAudioLanguage('')}
              />
              <span>
                <strong>{t('import:youtube.audioDefault.label')}</strong>
                <small>{t('import:youtube.audioDefault.hint')}</small>
              </span>
            </label>
            {audioLanguageOptions.map((language) => (
              <label
                key={language}
                className={`youtube-funnel-language${audioLanguage === language ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="youtube-audio-language"
                  value={language}
                  checked={audioLanguage === language}
                  onChange={() => setAudioLanguage(language)}
                />
                <span>
                  <strong>{languageLabel(language)}</strong>
                  <small>{language}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="youtube-funnel-hint">{t('import:youtube.audio.hint')}</p>
        </div>
      )}
    </FunnelShell>
  );
}
