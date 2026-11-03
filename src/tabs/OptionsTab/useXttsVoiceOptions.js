import { useTranslation } from 'react-i18next';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { rustMessageEnvelope, presentUserMessage, presentTechnicalMessage, presentStoredError } from '../../i18n/userMessage.js';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { releaseTauriListener } from '../../utils/tauriListener';

export function useXttsVoiceOptions({ xttsSettings, onUpdateXttsSettings }) {
  useTranslation('settings');
  useMessageLanguage();
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
      setXttsLogs((prev) => [...prev, event.payload].slice(-60));
    }).then((fn) => {
      if (cancelled) releaseTauriListener(fn);
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      releaseTauriListener(unlisten);
    };
  }, []);

  async function testXtts() {
    setXttsProbe({ state: 'loading', message: { key: 'settings:xtts.connect.progress' } });
    setXttsLogs([{ key: 'settings:xtts.test.log', params: { url: xttsSettings.serverUrl } }]);
    try {
      const status = await invoke('xtts_get_status', { settings: xttsSettings });
      const voices = status.voices || [];
      setXttsVoices(voices);
      setXttsVoicesLoaded(true);
      setXttsProbe({
        state: 'ok',
        message: { key: 'settings:xtts.ready.message', params: {
          model: status.model || { key: 'settings:xtts.model.fallback' },
          device: status.device === 'cuda' ? 'GPU CUDA' : status.device === 'cpu' ? 'CPU' : { key: 'settings:xtts.device.fallback' },
          voices: voices.length === 0
            ? { key: 'settings:xtts.voices.noneDetected' }
            : { key: 'settings:xtts.voices.count', params: { count: voices.length } },
          names: voices.length > 0 ? ` • ${voices.join(', ')}` : '',
        } },
      });
    } catch (e) {
      setXttsProbe({ state: 'error', message: { userMessage: e, codedOnly: true } });
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
    xttsProbe: { ...xttsProbe, message: presentStoredError(xttsProbe.message), technicalDetail: xttsProbe.state === 'error' ? presentUserMessage(xttsProbe.message?.userMessage).technicalDetail : '' },
    xttsVoices,
    xttsVoicesLoaded,
    xttsLogs: xttsLogs.map((line) => ({
      message: line?.key || rustMessageEnvelope(line)?.code ? presentTechnicalMessage(line) : '',
      technicalDetail: line?.key ? '' : presentUserMessage(line, { allowLegacyFrench: false }).technicalDetail,
    })),
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
