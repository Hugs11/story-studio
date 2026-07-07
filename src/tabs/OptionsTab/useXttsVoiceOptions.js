import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function useXttsVoiceOptions({ xttsSettings, onUpdateXttsSettings }) {
  const [xttsProbe, setXttsProbe] = useState({ state: 'idle', message: '' });
  const [xttsVoices, setXttsVoices] = useState([]);
  const [xttsVoicesLoaded, setXttsVoicesLoaded] = useState(false);
  const [xttsLogs, setXttsLogs] = useState([]);

  const favoriteVoices = Array.isArray(xttsSettings.favoriteVoices) ? xttsSettings.favoriteVoices : [];

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;

    let cancelled = false;
    let unlisten = null;
    listen('xtts-log', (event) => {
      if (cancelled) return;
      setXttsLogs((prev) => [...prev, String(event.payload)].slice(-60));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  async function testXtts() {
    setXttsProbe({ state: 'loading', message: 'Connexion a XTTS en cours…' });
    setXttsLogs([`Test XTTS depuis ${xttsSettings.serverUrl}`]);
    try {
      const status = await invoke('xtts_get_status', { settings: xttsSettings });
      const voices = status.voices || [];
      setXttsVoices(voices);
      setXttsVoicesLoaded(true);
      const voicesLabel = voices.length === 0
        ? 'aucune voix detectee'
        : `${voices.length} voix detectee(s)`;
      const deviceLabel = status.device === 'cuda' ? 'GPU CUDA' : status.device === 'cpu' ? 'CPU' : 'device inconnu';
      setXttsProbe({ state: 'ok', message: `Serveur pret sur ${deviceLabel} • ${voicesLabel}` });
    } catch (e) {
      setXttsProbe({ state: 'error', message: String(e) });
    }
  }

  function toggleXttsFavorite(voiceName) {
    const nextFavorites = favoriteVoices.includes(voiceName)
      ? favoriteVoices.filter((voice) => voice !== voiceName)
      : [...favoriteVoices, voiceName];
    onUpdateXttsSettings({ favoriteVoices: nextFavorites });
  }

  function clearXttsFavorites() {
    onUpdateXttsSettings({ favoriteVoices: [] });
  }

  function updateServerUrl(serverUrl) {
    onUpdateXttsSettings({ serverUrl });
  }

  function updateXttsDir(xttsDir) {
    onUpdateXttsSettings({ xttsDir });
  }

  function updateLanguage(language) {
    onUpdateXttsSettings({ language });
  }

  function updateAutoStart(autoStart) {
    onUpdateXttsSettings({ autoStart });
  }

  function updateForceCpu(forceCpu) {
    onUpdateXttsSettings({ forceCpu });
  }

  return {
    xttsProbe,
    xttsVoices,
    xttsVoicesLoaded,
    xttsLogs,
    favoriteVoices,
    testXtts,
    toggleXttsFavorite,
    clearXttsFavorites,
    updateServerUrl,
    updateXttsDir,
    updateLanguage,
    updateAutoStart,
    updateForceCpu,
  };
}
