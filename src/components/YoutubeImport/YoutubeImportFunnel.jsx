import { useEffect, useMemo, useState } from 'react';
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
import { Check, Info, Search, TriangleAlert, Youtube } from '../icons/LucideLocal';
import { KEYS, read as readSetting, write as writeSetting } from '../../store/persistentSettings';
import './YoutubeImportFunnel.css';

const STEPS = [
  { key: 'url', label: 'Adresse' },
  { key: 'videos', label: 'Vidéos' },
];

// Garde-fou de sélection (D23) : au-delà, on avertit (ton friendly, non bloquant).
const SELECTION_SOFT_CAP = 50;

function videoMeta(video) {
  return [video.duration].filter(Boolean).join(' · ');
}

/**
 * Funnel « Pack depuis YouTube » (plan 09) — jumeau du funnel podcast, source
 * yt-dlp. Sert l'entrée accueil (`mode="home"`, session éphémère créée par le
 * parent) **et** l'import dans l'éditeur libre (`mode="editor"`, projet courant) :
 * le composant est identique, seul `onImport` change côté parent.
 *
 * Premier usage : avertissement CGU (D24, accepté une fois) puis téléchargement
 * automatique de yt-dlp (D22), reflété par l'écran « Préparation… ».
 */
export function YoutubeImportFunnel({ onClose, onImport, mode = 'home' }) {
  const ytDlpPath = useMemo(() => readSetting(KEYS.YTDLP_CUSTOM_PATH, { defaultValue: '' }), []);
  const cguAccepted = useMemo(() => readSetting(KEYS.YOUTUBE_CGU_ACCEPTED) === 'true', []);

  const [step, setStep] = useState(0);
  const [url, setUrl] = useState('');
  // cgu | collect | loading (provisioning + listing) | importing | error
  const [phase, setPhase] = useState(cguAccepted ? 'collect' : 'cgu');
  const [list, setList] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [importError, setImportError] = useState('');
  const [progress, setProgress] = useState(null);
  const [logMessage, setLogMessage] = useState('');

  const busy = phase === 'loading' || phase === 'importing';

  // Progression de provisionnement/téléchargement émise par le backend.
  useEffect(() => {
    let unlisten = null;
    listen('youtube-log', (event) => setLogMessage(String(event.payload ?? ''))).then((fn) => {
      unlisten = fn;
    });
    return () => { unlisten?.(); };
  }, []);

  const videos = list?.videos ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleVideos = useMemo(
    () => (normalizedQuery
      ? videos.filter((video) => video.title.toLowerCase().includes(normalizedQuery))
      : videos),
    [videos, normalizedQuery],
  );

  function handleAcceptCgu() {
    writeSetting(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');
    setPhase('collect');
  }

  async function handleLoadList(event) {
    event?.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setError('');
    setLogMessage('');
    setPhase('loading');
    try {
      const result = await invoke('fetch_youtube_list', { url: trimmed, ytdlpPath: ytDlpPath });
      setList(result);
      setSelected(new Set());
      setQuery('');
      setStep(1);
      setPhase('collect');
    } catch (err) {
      setError(String(err?.message ?? err));
      setPhase('collect');
      setStep(0);
    }
  }

  function toggleVideo(id) {
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
      for (const video of visibleVideos) next.add(video.selectionKey || video.id || video.audioUrl);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleImport() {
    if (selected.size === 0 || busy) return;
    const chosen = videos.filter((video) => selected.has(video.selectionKey || video.id || video.audioUrl));
    setError('');
    setImportError('');
    setLogMessage('');
    setProgress({ name: list?.title || 'YouTube', index: 0, total: chosen.length, phase: "Préparation de l'import…" });
    setPhase('importing');
    try {
      // onImport route la progression dans cet écran et lève en cas d'échec total.
      await onImport(chosen, list, setProgress);
      onClose();
    } catch (err) {
      setImportError(String(err?.message ?? err));
      setPhase('error');
    }
  }

  const canOpenVideos = !!list;
  const overCap = selected.size > SELECTION_SOFT_CAP;
  const primaryDisabled = step === 0 ? !url.trim() : selected.size === 0;
  const primaryLabel = step === 0
    ? 'Charger les vidéos'
    : (selected.size > 0
      ? `Importer ${selected.size} vidéo${selected.size > 1 ? 's' : ''}`
      : 'Importer');

  const subtitle = mode === 'editor'
    ? 'Importe des vidéos YouTube comme histoires dans ce projet.'
    : 'Colle une URL YouTube, puis choisis les vidéos à transformer en histoires.';

  return (
    <FunnelShell
      icon={<Youtube />}
      title="Pack depuis YouTube"
      subtitle={subtitle}
      onClose={busy ? () => {} : onClose}
      showChrome={phase === 'collect'}
      ariaLabel="Créer un pack depuis YouTube"
      stepper={(
        <FunnelStepper
          steps={STEPS}
          current={step}
          onStepClick={(index) => {
            if (index === 1 && !canOpenVideos) return;
            setStep(index);
          }}
        />
      )}
      footer={(
        <FunnelFooter
          onBack={() => setStep(0)}
          backDisabled={step === 0}
          stepLabel={`Étape ${step + 1} / ${STEPS.length}`}
          onPrimary={step === 0 ? handleLoadList : handleImport}
          primaryLabel={primaryLabel}
          primaryDisabled={primaryDisabled}
        />
      )}
    >
      {phase === 'cgu' ? (
        <div className="funnel-step-content youtube-funnel-step youtube-funnel-cgu">
          <FunnelSectionHeader
            icon={<Info />}
            title="Avant de commencer"
            description="Une dernière chose, une seule fois."
          />
          <p className="youtube-funnel-cgu-text">
            Cette fonction télécharge l'audio de vidéos YouTube pour un <strong>usage personnel
            uniquement</strong>. Tu restes responsable du respect des conditions d'utilisation de
            YouTube et des droits d'auteur des contenus que tu importes.
          </p>
          <p className="youtube-funnel-hint">
            Au premier usage, Story Studio télécharge automatiquement l'outil yt-dlp (et le garde
            à jour) pour récupérer l'audio.
          </p>
          <div className="youtube-funnel-cgu-actions">
            <button type="button" className="funnel-btn funnel-btn-primary" onClick={handleAcceptCgu}>
              J'ai compris, continuer
            </button>
          </div>
        </div>
      ) : phase === 'loading' ? (
        <FunnelGenerationState
          title="Préparation…"
          hint={logMessage || 'Lecture des vidéos (yt-dlp se prépare au premier usage).'}
        />
      ) : phase === 'importing' ? (
        <FunnelGenerationState
          title="Import depuis YouTube…"
          hint={progress?.phase
            ? (progress.name ? `${progress.name} — ${progress.phase}` : progress.phase)
            : (logMessage || "Les histoires arrivent dans l'éditeur.")}
          progress={progress && progress.total ? progress.index / progress.total : null}
        />
      ) : phase === 'error' ? (
        <FunnelDoneState
          tone="error"
          icon={<TriangleAlert />}
          title="L'import a échoué"
          meta={importError}
        >
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={onClose}>
            Fermer
          </button>
        </FunnelDoneState>
      ) : step === 0 ? (
        <div className="funnel-step-content youtube-funnel-step">
          <FunnelSectionHeader
            icon={<Youtube />}
            title="Adresse YouTube"
            description="Colle l'URL d'une vidéo, d'une playlist ou d'une chaîne."
          />
          <form className="youtube-funnel-form" onSubmit={handleLoadList}>
            <label className="youtube-funnel-field" htmlFor="youtube-funnel-url">
              <Youtube />
              <input
                id="youtube-funnel-url"
                type="url"
                inputMode="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </label>
          </form>
          <p className="youtube-funnel-hint">
            Tu pourras filtrer et sélectionner les vidéos avant qu'elles soient ajoutées dans l'arbre.
          </p>
          {error && <div className="funnel-error" role="alert">{error}</div>}
        </div>
      ) : (
        <div className="funnel-step-content youtube-funnel-step youtube-funnel-step--videos">
          <FunnelSectionHeader
            icon={<Youtube />}
            title={list?.title || 'YouTube'}
            description="Sélectionne les vidéos à importer dans le pack."
            trailing={<span className="funnel-badge">{videos.length} vidéo{videos.length > 1 ? 's' : ''}</span>}
          />
          {list?.truncated && (
            <div className="youtube-funnel-notice" role="status">
              <TriangleAlert />
              <span>Cette source est volumineuse : seules les {videos.length} premières vidéos sont affichées.</span>
            </div>
          )}
          <div className="youtube-funnel-toolbar">
            <label className="youtube-funnel-field youtube-funnel-field--filter">
              <Search />
              <input
                type="text"
                placeholder="Filtrer les vidéos…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="youtube-funnel-bulk">
              <button type="button" className="youtube-funnel-seg" onClick={selectAllVisible}>
                Tout sélectionner
              </button>
              <button type="button" className="youtube-funnel-seg" onClick={clearSelection} disabled={selected.size === 0}>
                Tout désélectionner
              </button>
            </div>
          </div>
          {overCap && (
            <div className="youtube-funnel-notice" role="status">
              <Info />
              <span>{selected.size} vidéos sélectionnées : un pack plus léger reste plus agréable à parcourir.</span>
            </div>
          )}
          <div className="youtube-funnel-list">
            {visibleVideos.length === 0 ? (
              <div className="youtube-funnel-empty">
                <Search />
                <span>Aucune vidéo ne correspond à ce filtre.</span>
              </div>
            ) : (
              visibleVideos.map((video) => {
                const videoKey = video.selectionKey || video.id || video.audioUrl;
                const checked = selected.has(videoKey);
                const meta = videoMeta(video);
                return (
                  <button
                    type="button"
                    key={videoKey}
                    className={`youtube-funnel-row${checked ? ' is-selected' : ''}`}
                    aria-pressed={checked}
                    onClick={() => toggleVideo(videoKey)}
                  >
                    <span className="youtube-funnel-check">{checked ? <Check /> : null}</span>
                    <span className="youtube-funnel-row-main">
                      <span className="youtube-funnel-row-name" title={video.title}>{video.title}</span>
                      {meta && <span className="youtube-funnel-row-meta">{meta}</span>}
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

export default YoutubeImportFunnel;
