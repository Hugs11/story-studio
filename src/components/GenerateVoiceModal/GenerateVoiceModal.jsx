import { useTranslation, Trans } from 'react-i18next';
import { translateAi as t, aiRef } from '../../i18n/aiPresentation.js';
import {rustMessageEnvelope, presentUserMessage, presentTechnicalMessage, presentStoredError } from '../../i18n/userMessage.js';
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import {
  PIPER_DEFAULT_LANGUAGE,
  PIPER_DEFAULT_VOICE,
  PIPER_LANGUAGE_OPTIONS,
  piperDefaultVoiceForLanguage,
} from '../../store/xttsSettings';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { releaseTauriListener } from '../../utils/tauriListener';
import './GenerateVoiceModal.css';

const LANGUAGE_OPTIONS = [
  { value: 'fr', label: 'ai:voice.language.fr' },
  { value: 'en', label: 'ai:voice.language.en' },
  { value: 'es', label: 'ai:voice.language.es' },
  { value: 'de', label: 'ai:voice.language.de' },
  { value: 'it', label: 'ai:voice.language.it' },
  { value: 'pt', label: 'ai:voice.language.pt' },
];

const PIPER_LANGUAGE_KEYS = {
  fr_FR: 'ai:voice.language.fr',
  en_GB: 'ai:voice.language.enGB',
  en_US: 'ai:voice.language.enUS',
  it_IT: 'ai:voice.language.it',
};

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
  labelRef = null,
  onClose,
  children,
}) {
  useTranslation();
  const textLength = text.trim().length;
  return (
    <div className="modal-overlay">
      <div className="modal-box tts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("ai:voice.generation.title")}</span>
          <Button variant="icon" className="modal-close" onClick={onClose} disabled={submitting}>×</Button>
        </div>

        <div className="tts-body">
          <div className="tts-hero">
            <div className="tts-hero-main">
              <div className="tts-context-label">{labelRef ? presentStoredError(labelRef) : label}</div>
              <div className="tts-context-sub">{contextSub}</div>
            </div>
            <div className="tts-badges">{badges}</div>
          </div>

          <label className="tts-field">
            <span>{t("ai:voice.text.label")}</span>
            <textarea
              className="tts-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("ai:voice.text.placeholder")}
              disabled={submitting}
            />
            <div className="tts-field-row">
              <span className="tts-helper">
                {initialText ? t("ai:voice.text.prefilled") : t("ai:voice.text.help")}
              </span>
              <span className="tts-count">
                {textLength === 0
                  ? t("ai:voice.text.emptyCount", { count: textLength })
                  : t("ai:voice.text.count", { count: textLength })}
              </span>
            </div>
          </label>

          {children}

          {statusMessage && <div className="tts-status">{!statusMessage?.key && !rustMessageEnvelope(statusMessage)?.code ? <details><summary>{t("common:error.technicalDetails.summary")}</summary><pre>{presentTechnicalMessage(statusMessage)}</pre></details> : presentTechnicalMessage(statusMessage)}</div>}
          {error && <div className="tts-error">{presentStoredError(error)}{presentUserMessage(error?.userMessage ?? error).technicalDetail && <details><summary>{t("common:error.technicalDetails.summary")}</summary><pre>{presentUserMessage(error?.userMessage ?? error).technicalDetail}</pre></details>}</div>}
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
  labelRef = null,
  initialText = '',
  filenameHint = 'tts',
  target = null,
  onUpdateXttsSettings,
  onQueueGenerate,
  onClose,
}) {
  useTranslation();
  const [text, setText] = useState(initialText);
  const [voices, setVoices] = useState([]);
  const [binaryInstalled, setBinaryInstalled] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState(
    xttsSettings.piperLanguage || PIPER_DEFAULT_LANGUAGE,
  );
  const [selectedVoice, setSelectedVoice] = useState(() => (
    xttsSettings.piperVoice || read(KEYS.PIPER_LAST_VOICE) || PIPER_DEFAULT_VOICE
  ));
  const [speed, setSpeed] = useState(() => {
    const value = Number(xttsSettings.piperSpeed);
    return Number.isFinite(value) && value > 0 ? value : 1.0;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState(aiRef("ai:voice.piper.ready"));

  const selectedVoiceInfo = useMemo(
    () => voices.find((voice) => voice.id === selectedVoice) || null,
    [voices, selectedVoice],
  );
  const visibleVoices = useMemo(
    () => voices.filter((voice) => voice.language === selectedLanguage),
    [voices, selectedLanguage],
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
        const currentVoice = list.find((voice) => voice.id === selectedVoice);
        const language = currentVoice?.language
          || xttsSettings.piperLanguage
          || status?.defaultLanguage
          || PIPER_DEFAULT_LANGUAGE;
        setSelectedLanguage(language);
        setSelectedVoice(currentVoice?.language === language
          ? currentVoice.id
          : piperDefaultVoiceForLanguage(list, language));
      })
      .catch((e) => {
        if (!cancelled) setError({ userMessage: e, codedOnly: true });
      });
    return () => { cancelled = true; };
  }, []);

  // Pendant le provisionnement, refléter les messages discrets émis par le backend.
  useEffect(() => {
    if (!submitting) return undefined;
    let unlisten = null;
    let cancelled = false;
    listen('piper-log', (event) => {
      if (!cancelled) setStatusMessage(event.payload);
    }).then((fn) => {
      if (cancelled) releaseTauriListener(fn);
      else unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; releaseTauriListener(unlisten); };
  }, [submitting]);

  useEscapeKey(true, () => { if (!submitting) onClose?.(); });

  async function handleGenerate() {
    if (!text.trim()) { setError(aiRef("ai:voice.text.empty")); return; }
    if (text.trim().length > PIPER_MAX_TEXT_CHARS) {
      setError(aiRef("ai:voice.text.tooLong", { length: text.trim().length, maximum: PIPER_MAX_TEXT_CHARS }));
      return;
    }
    if (!selectedVoice) { setError(aiRef("ai:voice.selection.required")); return; }

    setSubmitting(true);
    setError('');
    try {
      // Provision (téléchargement unique) AVANT la mise en file, pour donner un
      // feedback discret « Préparation de la voix… » au 1er usage. Idempotent :
      // sans effet si déjà installé.
      if (needsProvision) {
        setStatusMessage(aiRef("ai:voice.piper.preparing"));
        await invoke('piper_ensure_voice', { voice: selectedVoice });
        setBinaryInstalled(true);
        setVoices((prev) => prev.map((voice) => (
          voice.id === selectedVoice ? { ...voice, installed: true } : voice
        )));
      }
      await onQueueGenerate?.({
        target,
        targetLabel: labelRef ? '' : label,
        targetLabelRef: labelRef,
        voiceLabel: selectedVoiceInfo?.label || selectedVoice,
        request: { text, voice: selectedVoice, speed, savePath, filenameHint },
      });
      write(KEYS.PIPER_LAST_VOICE, selectedVoice);
      onUpdateXttsSettings?.({
        piperLanguage: selectedLanguage,
        piperVoice: selectedVoice,
        piperSpeed: speed,
      });
      onClose();
    } catch (e) {
      setError({ userMessage: e, codedOnly: true, suffix: aiRef("ai:voice.piper.retry") });
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
      labelRef={labelRef}
      contextSub={<Trans i18nKey="ai:voice.output.help" components={{ strong: <strong /> }} />}
      onClose={onClose}
      footerActions={(
        <Button variant="primary-violet" onClick={handleGenerate} disabled={submitting || voices.length === 0}>
          {submitting ? (needsProvision ? t("ai:voice.preparation.action") : t("ai:voice.queue.action")) : t("ai:generation.submit.action")}
        </Button>
      )}
    >
      <div className="tts-grid">
        <div className="tts-field">
          <span id="tts-piper-language-label">{t("ai:voice.language.label")}</span>
          <Select
            aria-labelledby="tts-piper-language-label"
            value={selectedLanguage}
            onChange={(language) => {
              const voice = piperDefaultVoiceForLanguage(voices, language);
              setSelectedLanguage(language);
              setSelectedVoice(voice);
              write(KEYS.PIPER_LAST_VOICE, voice);
              onUpdateXttsSettings?.({ piperLanguage: language, piperVoice: voice });
            }}
            disabled={submitting || voices.length === 0}
            options={PIPER_LANGUAGE_OPTIONS.map(({ value }) => ({ value, label: t(PIPER_LANGUAGE_KEYS[value]) }))}
          />
        </div>

        <div className="tts-field">
          <span id="tts-piper-voice-label">{t("ai:voice.selection.label")}</span>
          <Select
            aria-labelledby="tts-piper-voice-label"
            value={selectedVoice}
            onChange={(voiceId) => {
              setSelectedVoice(voiceId);
              write(KEYS.PIPER_LAST_VOICE, voiceId);
              onUpdateXttsSettings?.({
                piperLanguage: selectedLanguage,
                piperVoice: voiceId,
              });
            }}
            disabled={submitting || visibleVoices.length === 0}
            placeholder={visibleVoices.length === 0 ? t("ai:voice.catalog.loading") : ''}
            options={visibleVoices.map((voice) => ({
              value: voice.id,
              label: voice.installed ? voice.label : t("ai:voice.option.download", { voice: voice.label }),
            }))}
          />
        </div>

        <label className="tts-field">
          <span>{t("ai:voice.speed.label", { speed: speed.toFixed(2) })}</span>
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
      </div>
      <span className="tts-helper">
        {t("ai:voice.piper.help")}
      </span>
    </VoiceModalShell>
  );
}

// ── Backend XTTS (opt-in, avancé) ────────────────────────────────────────────

function XttsVoiceModal({
  savePath,
  xttsSettings,
  label,
  labelRef = null,
  initialText = '',
  filenameHint = 'tts',
  target = null,
  onQueueGenerate,
  onClose,
}) {
  useTranslation();
  const [text, setText] = useState(initialText);
  const [language, setLanguage] = useState(xttsSettings.language || 'fr');
  const [availableVoices, setAvailableVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(() => (
    read(KEYS.XTTS_LAST_VOICE) || read(KEYS.XTTS_LAST_SPEAKER) || ''
  ));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [device, setDevice] = useState(null);
  const [statusMessage, setStatusMessage] = useState(aiRef("ai:voice.xtts.connecting"));
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
  const selectedVoiceLabel = selectedVoice || t("ai:voice.selection.empty");

  async function loadStatus() {
    setLoading(true);
    setError('');
    setStatusMessage(aiRef("ai:voice.xtts.connecting"));
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
      setStatusMessage(voices.length > 0 ? aiRef("ai:voice.xtts.ready") : aiRef("ai:voice.xtts.noVoices"));
    } catch (e) {
      setError({ userMessage: e, codedOnly: true });
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
    if (!text.trim()) { setError(aiRef("ai:voice.text.empty")); return; }
    if (!selectedVoice) { setError(aiRef("ai:voice.xtts.required")); return; }

    setSubmitting(true);
    setError('');
    try {
      await onQueueGenerate?.({
        target,
        targetLabel: labelRef ? '' : label,
        targetLabelRef: labelRef,
        voiceLabel: selectedVoiceLabel,
        request: { text, language, speaker: null, voice: selectedVoice, savePath, filenameHint },
      });
      write(KEYS.XTTS_LAST_VOICE, selectedVoice);
      write(KEYS.XTTS_LAST_SPEAKER, selectedVoice);
      onClose();
    } catch (e) {
      setError({ userMessage: e, codedOnly: true });
    } finally {
      setSubmitting(false);
    }
  }

  const badges = (
    <>
      <span className={`tts-badge ${loading ? '' : device === 'cuda' ? 'gpu' : 'cpu'}`}>
        {loading ? t("ai:voice.xtts.initializing") : device === 'cuda' ? 'GPU CUDA' : device === 'cpu' ? 'CPU' : 'XTTS'}
      </span>
      <span className="tts-badge">{t("ai:voice.xtts.badge")}</span>
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
      labelRef={labelRef}
      contextSub={<Trans i18nKey="ai:voice.output.help" components={{ strong: <strong /> }} />}
      onClose={onClose}
      footerLeft={(
        <Button variant="secondary-violet" onClick={loadStatus} disabled={loading || submitting}>
          {t("ai:voice.xtts.refresh")}
        </Button>
      )}
      footerActions={(
        <Button
          variant="primary-violet"
          onClick={handleGenerate}
          disabled={loading || submitting || visibleVoices.length === 0}
        >
          {submitting ? t("ai:voice.queue.action") : t("ai:generation.submit.action")}
        </Button>
      )}
    >
      <div className="tts-grid">
        <div className="tts-field">
          <span id="tts-xtts-language-label">{t("ai:voice.language.label")}</span>
          <Select
            aria-labelledby="tts-xtts-language-label"
            value={language}
            onChange={setLanguage}
            disabled={submitting}
            options={LANGUAGE_OPTIONS.map(({ value, label: optionLabel }) => ({ value, label: t(optionLabel) }))}
          />
        </div>

        <div className="tts-field">
          <span>{t("ai:voice.selection.current")}</span>
          <div className="tts-device">{selectedVoiceLabel}</div>
        </div>
      </div>

      <div className="tts-field">
        <span id="tts-xtts-voice-label">{t("ai:voice.selection.label")}</span>
        <Select
          aria-labelledby="tts-xtts-voice-label"
          value={selectedVoice}
          onChange={(voiceName) => {
            setSelectedVoice(voiceName);
            write(KEYS.XTTS_LAST_VOICE, voiceName);
            write(KEYS.XTTS_LAST_SPEAKER, voiceName);
          }}
          disabled={submitting || visibleVoices.length === 0}
          placeholder={visibleVoices.length === 0 ? t("ai:voice.xtts.empty") : ''}
          options={visibleVoices.map((voiceName) => ({ value: voiceName, label: voiceName }))}
        />
        <span className="tts-helper">
          {favoriteVoices.length > 0 && !favoritesUnavailable
            ? t("ai:voice.favorites.limited")
            : favoritesUnavailable
              ? t("ai:voice.favorites.unavailable")
              : t("ai:voice.favorites.help")}
        </span>
      </div>
    </VoiceModalShell>
  );
}
