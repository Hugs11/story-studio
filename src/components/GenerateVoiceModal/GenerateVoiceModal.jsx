import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import { PIPER_DEFAULT_SENTENCE_SILENCE, PIPER_DEFAULT_VOICE } from '../../store/xttsSettings';
import { formatFrenchCount } from '../../utils/frenchText.js';
import { Button } from '../common/Button';
import './GenerateVoiceModal.css';

const LANGUAGE_OPTIONS = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
];

const PIPER_MAX_TEXT_CHARS = 5000;

export function GenerateVoiceModal(props) {
  const isPiper = (props.xttsSettings?.backend || 'piper') === 'piper';
  return isPiper ? <PiperVoiceModal {...props} /> : <XttsVoiceModal {...props} />;
}

// ── Châssis partagé ──────────────────────────────────────────────────────────

function VoiceModalShell({
  badges,
  text,
  setText,
  initialText,
  submitting,
  statusMessage,
  error,
  footerLeft,
  footerActions,
  contextSub,
  label,
  onClose,
  children,
}) {
  const textLength = text.trim().length;
  return (
    <div className="modal-overlay">
      <div className="modal-box tts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Générer une voix</span>
          <Button variant="icon" className="modal-close" onClick={onClose} disabled={submitting}>×</Button>
        </div>

        <div className="tts-body">
          <div className="tts-hero">
            <div className="tts-hero-main">
              <div className="tts-context-label">{label}</div>
              <div className="tts-context-sub">{contextSub}</div>
            </div>
            <div className="tts-badges">{badges}</div>
          </div>

          <label className="tts-field">
            <span>Texte à lire</span>
            <textarea
              className="tts-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Tape ici le texte à transformer en voix…"
              disabled={submitting}
            />
            <div className="tts-field-row">
              <span className="tts-helper">
                {initialText ? 'Le texte est prérempli d’après le champ audio actuel.' : 'Saisis le texte exact à lire par la voix.'}
              </span>
              <span className="tts-count">
                {formatFrenchCount(textLength, 'caractère', 'caractères')}
              </span>
            </div>
          </label>

          {children}

          {statusMessage && <div className="tts-status">{statusMessage}</div>}
          {error && <div className="tts-error">{error}</div>}
        </div>

        <div className="tts-footer">
          {footerLeft || <span />}
          <div className="tts-footer-actions">{footerActions}</div>
        </div>
      </div>
    </div>
  );
}

// ── Backend Piper (défaut, zéro-config) ──────────────────────────────────────

function PiperVoiceModal({
  savePath,
  xttsSettings,
  label,
  initialText = '',
  filenameHint = 'tts',
  target = null,
  onUpdateXttsSettings,
  onQueueGenerate,
  onClose,
}) {
  const [text, setText] = useState(initialText);
  const [voices, setVoices] = useState([]);
  const [binaryInstalled, setBinaryInstalled] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState(() => (
    xttsSettings.piperVoice || read(KEYS.PIPER_LAST_VOICE) || PIPER_DEFAULT_VOICE
  ));
  const [speed, setSpeed] = useState(() => {
    const value = Number(xttsSettings.piperSpeed);
    return Number.isFinite(value) && value > 0 ? value : 1.0;
  });
  const [sentenceSilence, setSentenceSilence] = useState(() => {
    const value = Number(xttsSettings.piperSentenceSilence);
    return Number.isFinite(value) ? Math.max(0, Math.min(1.5, value)) : PIPER_DEFAULT_SENTENCE_SILENCE;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('Voix prête à l’emploi, sans configuration.');

  const selectedVoiceInfo = useMemo(
    () => voices.find((voice) => voice.id === selectedVoice) || null,
    [voices, selectedVoice],
  );
  const needsProvision = !binaryInstalled || (selectedVoiceInfo ? !selectedVoiceInfo.installed : true);

  // reason: chargement one-shot du catalogue de voix Piper au montage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    invoke('piper_list_voices')
      .then((status) => {
        if (cancelled) return;
        const list = status?.voices || [];
        setVoices(list);
        setBinaryInstalled(!!status?.binaryInstalled);
        setSelectedVoice((current) => {
          if (list.some((voice) => voice.id === current)) return current;
          return status?.defaultVoice || list[0]?.id || PIPER_DEFAULT_VOICE;
        });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => { cancelled = true; };
  }, []);

  // Pendant le provisionnement, refléter les messages discrets émis par le backend.
  useEffect(() => {
    if (!submitting) return undefined;
    let unlisten = null;
    let cancelled = false;
    listen('piper-log', (event) => {
      if (!cancelled) setStatusMessage(String(event.payload));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, [submitting]);

  useEscapeKey(true, () => { if (!submitting) onClose?.(); });

  async function handleGenerate() {
    if (!text.trim()) { setError('Le texte à générer est vide.'); return; }
    if (text.trim().length > PIPER_MAX_TEXT_CHARS) {
      setError(`Le texte est trop long pour Piper (${text.trim().length} caractères, maximum ${PIPER_MAX_TEXT_CHARS}).`);
      return;
    }
    if (!selectedVoice) { setError('Choisis une voix.'); return; }

    setSubmitting(true);
    setError('');
    try {
      // Provision (téléchargement unique) AVANT la mise en file, pour donner un
      // feedback discret « Préparation de la voix… » au 1er usage. Idempotent :
      // sans effet si déjà installé.
      if (needsProvision) {
        setStatusMessage('Préparation de la voix… (téléchargement unique)');
        await invoke('piper_ensure_voice', { voice: selectedVoice });
        setBinaryInstalled(true);
        setVoices((prev) => prev.map((voice) => (
          voice.id === selectedVoice ? { ...voice, installed: true } : voice
        )));
      }
      await onQueueGenerate?.({
        target,
        targetLabel: label,
        voiceLabel: selectedVoiceInfo?.label || selectedVoice,
        request: { text, voice: selectedVoice, speed, sentenceSilence, savePath, filenameHint },
      });
      write(KEYS.PIPER_LAST_VOICE, selectedVoice);
      onUpdateXttsSettings?.({ piperVoice: selectedVoice, piperSpeed: speed, piperSentenceSilence: sentenceSilence });
      onClose();
    } catch (e) {
      setError(`${e}\nRéessaie, ou passe à XTTS dans les Préférences si le problème persiste.`);
      setStatusMessage('');
    } finally {
      setSubmitting(false);
    }
  }

  const badges = <span className="tts-badge gpu">Piper</span>;

  return (
    <VoiceModalShell
      badges={badges}
      text={text}
      setText={setText}
      initialText={initialText}
      submitting={submitting}
      statusMessage={statusMessage}
      error={error}
      label={label}
      contextSub={<>Le fichier sera stocké dans <strong>voix-générées/</strong> dans l’emplacement de travail.</>}
      onClose={onClose}
      footerActions={(
        <Button variant="primary-violet" onClick={handleGenerate} disabled={submitting || voices.length === 0}>
          {submitting ? (needsProvision ? 'Préparation…' : 'Ajout…') : 'Générer'}
        </Button>
      )}
    >
      <div className="tts-grid">
        <label className="tts-field">
          <span>Voix</span>
          <select
            className="tts-input"
            value={selectedVoice}
            onChange={(e) => {
              setSelectedVoice(e.target.value);
              write(KEYS.PIPER_LAST_VOICE, e.target.value);
              onUpdateXttsSettings?.({ piperVoice: e.target.value });
            }}
            disabled={submitting || voices.length === 0}
          >
            {voices.length === 0 && <option value="">Chargement des voix…</option>}
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}{voice.installed ? '' : ' — à télécharger'}
              </option>
            ))}
          </select>
        </label>

        <label className="tts-field">
          <span>Vitesse · {speed.toFixed(2)}×</span>
          <input
            className="tts-input"
            type="range"
            min="0.5"
            max="1.5"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            disabled={submitting}
          />
        </label>

        <label className="tts-field">
          <span>Pause phrase · {sentenceSilence.toFixed(2)}s</span>
          <input
            className="tts-input"
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={sentenceSilence}
            onChange={(e) => setSentenceSilence(Number(e.target.value))}
            disabled={submitting}
          />
        </label>
      </div>
      <span className="tts-helper">
        Piper fonctionne sans serveur ni configuration. La voix est téléchargée automatiquement au premier usage.
      </span>
    </VoiceModalShell>
  );
}

// ── Backend XTTS (opt-in, avancé) ────────────────────────────────────────────

function XttsVoiceModal({
  savePath,
  xttsSettings,
  label,
  initialText = '',
  filenameHint = 'tts',
  target = null,
  onQueueGenerate,
  onClose,
}) {
  const [text, setText] = useState(initialText);
  const [language, setLanguage] = useState(xttsSettings.language || 'fr');
  const [availableVoices, setAvailableVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(() => (
    read(KEYS.XTTS_LAST_VOICE) || read(KEYS.XTTS_LAST_SPEAKER) || ''
  ));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [device, setDevice] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Connexion à XTTS…');
  const [error, setError] = useState('');
  const favoriteVoices = Array.isArray(xttsSettings.favoriteVoices) ? xttsSettings.favoriteVoices : [];
  const visibleVoices = useMemo(() => {
    const available = availableVoices.filter(Boolean);
    if (favoriteVoices.length === 0) return available;
    const favoritesAvailable = favoriteVoices.filter((voice) => available.includes(voice));
    return favoritesAvailable.length > 0 ? favoritesAvailable : available;
  }, [availableVoices, favoriteVoices]);
  const favoritesUnavailable = favoriteVoices.length > 0
    && availableVoices.length > 0
    && favoriteVoices.every((voice) => !availableVoices.includes(voice));
  const selectedVoiceLabel = selectedVoice || 'Aucune voix disponible';

  async function loadStatus() {
    setLoading(true);
    setError('');
    setStatusMessage('Connexion à XTTS…');
    try {
      const status = await invoke('xtts_get_status', { settings: xttsSettings });
      const voices = status.voices || [];
      const nextVisibleVoices = favoriteVoices.length > 0
        ? favoriteVoices.filter((voice) => voices.includes(voice))
        : voices;
      const fallbackVoices = nextVisibleVoices.length > 0 ? nextVisibleVoices : voices;
      const lastVoice = read(KEYS.XTTS_LAST_VOICE) || read(KEYS.XTTS_LAST_SPEAKER) || '';
      setDevice(status.device || null);
      setAvailableVoices(voices);
      setSelectedVoice((current) => {
        if (fallbackVoices.includes(current)) return current;
        if (fallbackVoices.includes(lastVoice)) return lastVoice;
        return fallbackVoices[0] || '';
      });
      setStatusMessage(voices.length > 0 ? 'XTTS est prêt.' : 'XTTS est prêt, mais aucune voix n’a été retournée.');
    } catch (e) {
      setError(String(e));
      setStatusMessage('');
    } finally {
      setLoading(false);
    }
  }

  // reason: chargement one-shot du statut XTTS au montage de la modale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadStatus();
  }, []);

  useEscapeKey(true, () => { if (!submitting) onClose?.(); });

  async function handleGenerate() {
    if (!text.trim()) { setError('Le texte à générer est vide.'); return; }
    if (!selectedVoice) { setError('Choisis une voix XTTS.'); return; }

    setSubmitting(true);
    setError('');
    try {
      await onQueueGenerate?.({
        target,
        targetLabel: label,
        voiceLabel: selectedVoiceLabel,
        request: { text, language, speaker: null, voice: selectedVoice, savePath, filenameHint },
      });
      write(KEYS.XTTS_LAST_VOICE, selectedVoice);
      write(KEYS.XTTS_LAST_SPEAKER, selectedVoice);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const badges = (
    <>
      <span className={`tts-badge ${loading ? '' : device === 'cuda' ? 'gpu' : 'cpu'}`}>
        {loading ? 'Initialisation…' : device === 'cuda' ? 'GPU CUDA' : device === 'cpu' ? 'CPU' : 'XTTS'}
      </span>
      <span className="tts-badge">Voix XTTS</span>
    </>
  );

  return (
    <VoiceModalShell
      badges={badges}
      text={text}
      setText={setText}
      initialText={initialText}
      submitting={submitting}
      statusMessage={statusMessage}
      error={error}
      label={label}
      contextSub={<>Le fichier sera stocké dans <strong>voix-générées/</strong> dans l’emplacement de travail.</>}
      onClose={onClose}
      footerLeft={(
        <Button variant="secondary-violet" onClick={loadStatus} disabled={loading || submitting}>
          Actualiser XTTS
        </Button>
      )}
      footerActions={(
        <Button
          variant="primary-violet"
          onClick={handleGenerate}
          disabled={loading || submitting || visibleVoices.length === 0}
        >
          {submitting ? 'Ajout…' : 'Générer'}
        </Button>
      )}
    >
      <div className="tts-grid">
        <label className="tts-field">
          <span>Langue</span>
          <select
            className="tts-input"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={submitting}
          >
            {LANGUAGE_OPTIONS.map(({ value, label: optionLabel }) => (
              <option key={value} value={value}>{optionLabel}</option>
            ))}
          </select>
        </label>

        <div className="tts-field">
          <span>Voix sélectionnée</span>
          <div className="tts-device">{selectedVoiceLabel}</div>
        </div>
      </div>

      <label className="tts-field">
        <span>Voix</span>
        <select
          className="tts-input"
          value={selectedVoice}
          onChange={(e) => {
            setSelectedVoice(e.target.value);
            write(KEYS.XTTS_LAST_VOICE, e.target.value);
            write(KEYS.XTTS_LAST_SPEAKER, e.target.value);
          }}
          disabled={submitting || visibleVoices.length === 0}
        >
          {visibleVoices.length === 0 && <option value="">Aucune voix détectée par XTTS</option>}
          {visibleVoices.map((voiceName) => (
            <option key={voiceName} value={voiceName}>{voiceName}</option>
          ))}
        </select>
        <span className="tts-helper">
          {favoriteVoices.length > 0 && !favoritesUnavailable
            ? 'Liste limitée aux voix favorites configurées dans les préférences.'
            : favoritesUnavailable
              ? 'Les voix favorites sont indisponibles ; toutes les voix XTTS détectées sont affichées.'
              : 'Toutes les voix retournées par XTTS sont disponibles. Ajoute des favorites dans les préférences pour réduire cette liste.'}
        </span>
      </label>
    </VoiceModalShell>
  );
}
