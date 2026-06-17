import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import { Button } from '../common/Button';
import './GenerateVoiceModal.css';

const LANGUAGE_OPTIONS = [
  { value: 'fr', label: 'Francais' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Espanol' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Portugues' },
];

export function GenerateVoiceModal({
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
  const [statusMessage, setStatusMessage] = useState('Connexion a XTTS…');
  const [error, setError] = useState('');
  const textLength = text.trim().length;
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
    setStatusMessage('Connexion a XTTS…');
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
      setStatusMessage(voices.length > 0 ? 'XTTS est pret.' : 'XTTS est pret, mais aucune voix n’a ete retournee.');
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

  useEscapeKey(true, () => {
    if (!submitting) onClose?.();
  });

  async function handleGenerate() {
    if (!text.trim()) {
      setError('Le texte a generer est vide.');
      return;
    }
    if (!selectedVoice) {
      setError('Choisissez une voix XTTS.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await onQueueGenerate?.({
        target,
        targetLabel: label,
        voiceLabel: selectedVoiceLabel,
        request: {
          text,
          language,
          speaker: null,
          voice: selectedVoice,
          savePath,
          filenameHint,
        },
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

  return (
    <div className="modal-overlay">
      <div className="modal-box tts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Generer une voix</span>
          <Button variant="icon" className="modal-close" onClick={onClose} disabled={submitting}>×</Button>
        </div>

        <div className="tts-body">
          <div className="tts-hero">
            <div className="tts-hero-main">
              <div className="tts-context-label">{label}</div>
              <div className="tts-context-sub">
                Le fichier sera stocke dans <strong>voix-generees/</strong> dans l’emplacement de travail.
              </div>
            </div>
            <div className="tts-badges">
              <span className={`tts-badge ${loading ? '' : device === 'cuda' ? 'gpu' : 'cpu'}`}>
                {loading ? 'Initialisation…' : device === 'cuda' ? 'GPU CUDA' : device === 'cpu' ? 'CPU' : 'XTTS'}
              </span>
              <span className="tts-badge">Voix XTTS</span>
            </div>
          </div>

          <label className="tts-field">
            <span>Texte a lire</span>
            <textarea
              className="tts-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Tape ici le texte a transformer en voix…"
              disabled={submitting}
            />
            <div className="tts-field-row">
              <span className="tts-helper">
                {initialText ? 'Le texte est pre-rempli d’apres le champ audio actuel.' : 'Saisis le texte exact a lire par la voix.'}
              </span>
              <span className="tts-count">{textLength} caractere(s)</span>
            </div>
          </label>

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
              <span>Voix selectionnee</span>
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
              {visibleVoices.length === 0 && <option value="">Aucune voix detectee par XTTS</option>}
              {visibleVoices.map((voiceName) => (
                <option key={voiceName} value={voiceName}>{voiceName}</option>
              ))}
            </select>
            <span className="tts-helper">
              {favoriteVoices.length > 0 && !favoritesUnavailable
                ? 'Liste limitee aux voix favorites configurees dans les preferences.'
                : favoritesUnavailable
                  ? 'Les voix favorites sont indisponibles ; toutes les voix XTTS detectees sont affichees.'
                  : 'Toutes les voix retournees par XTTS sont disponibles. Ajoute des favorites dans les preferences pour reduire cette liste.'}
            </span>
          </label>

          {statusMessage && (
            <div className="tts-status">{statusMessage}</div>
          )}

          {error && (
            <div className="tts-error">{error}</div>
          )}
        </div>

        <div className="tts-footer">
          <Button variant="secondary-violet" onClick={loadStatus} disabled={loading || submitting}>
            Actualiser XTTS
          </Button>
          <div className="tts-footer-actions">
            <Button
              variant="primary-violet"
              onClick={handleGenerate}
              disabled={loading || submitting || visibleVoices.length === 0}
            >
              {submitting ? 'Ajout…' : 'Generer'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
