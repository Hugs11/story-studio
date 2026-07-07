import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { KEYS, write } from '../../store/persistentSettings';
import { PIPER_DEFAULT_SENTENCE_SILENCE, PIPER_DEFAULT_VOICE } from '../../store/xttsSettings';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function usePiperVoiceOptions({ xttsSettings, onUpdateXttsSettings }) {
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

  function updatePiperVoice(voice) {
    write(KEYS.PIPER_LAST_VOICE, voice);
    onUpdateXttsSettings({ piperVoice: voice });
  }

  function updatePiperSpeed(rawValue) {
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      onUpdateXttsSettings({ piperSpeed: Math.max(0.5, Math.min(1.5, value)) });
    }
  }

  function updatePiperSentenceSilence(rawValue) {
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      onUpdateXttsSettings({ piperSentenceSilence: Math.max(0, Math.min(1.5, value)) });
    }
  }

  async function preparePiperVoice() {
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

  return {
    piperVoices,
    piperProvision,
    piperVoice,
    piperSpeed,
    piperSentenceSilence,
    updatePiperVoice,
    updatePiperSpeed,
    updatePiperSentenceSilence,
    preparePiperVoice,
  };
}
