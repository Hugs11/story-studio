import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { KEYS, write } from '../../store/persistentSettings';
import {
  PIPER_DEFAULT_LANGUAGE,
  PIPER_DEFAULT_VOICE,
  piperDefaultVoiceForLanguage,
  piperLanguageForVoice,
} from '../../store/xttsSettings';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function usePiperVoiceOptions({ xttsSettings, onUpdateXttsSettings }) {
  const [piperVoices, setPiperVoices] = useState([]);
  const [piperProvision, setPiperProvision] = useState({ state: 'idle', message: '' });

  const piperLanguage = xttsSettings.piperLanguage || PIPER_DEFAULT_LANGUAGE;
  const piperVoice = xttsSettings.piperVoice || PIPER_DEFAULT_VOICE;
  const piperSpeed = Number.isFinite(Number(xttsSettings.piperSpeed)) && Number(xttsSettings.piperSpeed) > 0
    ? Number(xttsSettings.piperSpeed)
    : 1.0;

  // Catalogue Piper (voix installées + à télécharger). Aucun réseau : lecture
  // locale de l'état d'installation.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke('piper_list_voices')
      .then((status) => {
        const voices = status?.voices || [];
        setPiperVoices(voices);
        const selected = voices.find((voice) => voice.id === piperVoice);
        const language = selected?.language || piperLanguage;
        const voice = selected?.language === language
          ? selected.id
          : piperDefaultVoiceForLanguage(voices, language);
        if (language !== piperLanguage || voice !== piperVoice) {
          write(KEYS.PIPER_LAST_VOICE, voice);
          onUpdateXttsSettings({ piperLanguage: language, piperVoice: voice });
        }
      })
      .catch(() => {});
    // Le catalogue est chargé une fois ; les valeurs initiales servent uniquement
    // à réconcilier une ancienne préférence avec le nouveau catalogue multilingue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function updatePiperLanguage(language) {
    const voice = piperDefaultVoiceForLanguage(piperVoices, language);
    write(KEYS.PIPER_LAST_VOICE, voice);
    onUpdateXttsSettings({ piperLanguage: language, piperVoice: voice });
  }

  function updatePiperVoice(voice) {
    const language = piperLanguageForVoice(piperVoices, voice, piperLanguage);
    write(KEYS.PIPER_LAST_VOICE, voice);
    onUpdateXttsSettings({ piperLanguage: language, piperVoice: voice });
  }

  function updatePiperSpeed(rawValue) {
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      onUpdateXttsSettings({ piperSpeed: Math.max(0.5, Math.min(1.5, value)) });
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
    piperLanguage,
    piperVoice,
    piperSpeed,
    updatePiperLanguage,
    updatePiperVoice,
    updatePiperSpeed,
    preparePiperVoice,
  };
}
