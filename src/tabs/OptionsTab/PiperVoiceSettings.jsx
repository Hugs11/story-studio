import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../components/common/Button';
import { KEYS, write } from '../../store/persistentSettings';
import { PIPER_DEFAULT_SENTENCE_SILENCE, PIPER_DEFAULT_VOICE } from '../../store/xttsSettings';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function PiperVoiceSettings({ xttsSettings, onUpdateXttsSettings }) {
  const [piperVoices, setPiperVoices] = useState([]);
  const [piperProvision, setPiperProvision] = useState({ state: 'idle', message: '' });

  const piperVoice = xttsSettings.piperVoice || PIPER_DEFAULT_VOICE;
  const piperSpeed = Number.isFinite(Number(xttsSettings.piperSpeed)) && Number(xttsSettings.piperSpeed) > 0
    ? Number(xttsSettings.piperSpeed)
    : 1.0;
  const piperSentenceSilence = Number.isFinite(Number(xttsSettings.piperSentenceSilence))
    ? Math.max(0, Math.min(1.5, Number(xttsSettings.piperSentenceSilence)))
    : PIPER_DEFAULT_SENTENCE_SILENCE;

  // Catalogue Piper (voix installées + à télécharger). Aucun réseau : lecture
  // locale de l'état d'installation.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke('piper_list_voices')
      .then((status) => setPiperVoices(status?.voices || []))
      .catch(() => {});
  }, []);

  // Reflète les messages discrets du provisionnement Piper (téléchargement).
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let cancelled = false;
    let unlisten = null;
    listen('piper-log', (event) => {
      if (cancelled) return;
      setPiperProvision((prev) => (prev.state === 'loading' ? { ...prev, message: String(event.payload) } : prev));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, []);

  async function handlePreparePiperVoice() {
    setPiperProvision({ state: 'loading', message: 'Préparation de la voix…' });
    try {
      await invoke('piper_ensure_voice', { voice: piperVoice });
      setPiperVoices((prev) => prev.map((voice) => (
        voice.id === piperVoice ? { ...voice, installed: true } : voice
      )));
      setPiperProvision({ state: 'ok', message: 'Voix prête.' });
    } catch (e) {
      setPiperProvision({ state: 'error', message: `${e}` });
    }
  }

  return (
    <div className="xtts-settings">
      <div className="opts-row-sub" style={{ marginBottom: 8 }}>
        Piper ajoute un bouton texte → audio dans tous les champs audio. La voix est téléchargée
        automatiquement au premier usage.
      </div>
      <div className="xtts-grid">
        <label className="xtts-label">
          Voix
          <select
            className="xtts-input"
            value={piperVoice}
            onChange={(e) => {
              write(KEYS.PIPER_LAST_VOICE, e.target.value);
              onUpdateXttsSettings({ piperVoice: e.target.value });
            }}
          >
            {(piperVoices.length > 0 ? piperVoices : [{ id: piperVoice, label: piperVoice, installed: false }]).map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}{voice.installed ? '' : ' — à télécharger'}
              </option>
            ))}
          </select>
        </label>

        <label className="xtts-label">
          Vitesse ({piperSpeed.toFixed(2)}×)
          <input
            className="xtts-input"
            type="number"
            min="0.5"
            max="1.5"
            step="0.05"
            value={piperSpeed}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) onUpdateXttsSettings({ piperSpeed: Math.max(0.5, Math.min(1.5, value)) });
            }}
          />
        </label>

        <label className="xtts-label">
          Pause phrase ({piperSentenceSilence.toFixed(2)}s)
          <input
            className="xtts-input"
            type="number"
            min="0"
            max="1.5"
            step="0.05"
            value={piperSentenceSilence}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) onUpdateXttsSettings({ piperSentenceSilence: Math.max(0, Math.min(1.5, value)) });
            }}
          />
        </label>
      </div>

      <div className="xtts-actions">
        <Button onClick={handlePreparePiperVoice} disabled={piperProvision.state === 'loading'}>
          {piperProvision.state === 'loading' ? 'Téléchargement…' : 'Préparer la voix maintenant'}
        </Button>
        <span className="opts-row-sub">
          Optionnel : prépare la voix sélectionnée à l’avance pour éviter l’attente au 1er usage.
        </span>
      </div>

      {piperProvision.state !== 'idle' && (
        <div className={`info-box ${piperProvision.state === 'error' ? 'warn' : ''}`}>
          {piperProvision.message}
        </div>
      )}
    </div>
  );
}
