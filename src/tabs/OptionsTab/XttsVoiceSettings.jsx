import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';
import { isTauriRuntime } from '../../utils/tauriRuntime';

const LANGUAGE_OPTIONS = [
  { value: 'fr', label: 'Francais' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Espanol' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Portugues' },
];

export function XttsVoiceSettings({ xttsSettings, onUpdateXttsSettings }) {
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

  async function handleTestXtts() {
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

  function handleToggleXttsFavorite(voiceName) {
    const nextFavorites = favoriteVoices.includes(voiceName)
      ? favoriteVoices.filter((voice) => voice !== voiceName)
      : [...favoriteVoices, voiceName];
    onUpdateXttsSettings({ favoriteVoices: nextFavorites });
  }

  function handleClearXttsFavorites() {
    onUpdateXttsSettings({ favoriteVoices: [] });
  }

  return (
    <div className="xtts-settings">
      <div className="xtts-grid">
        <label className="xtts-label">
          URL du serveur XTTS
          <input
            className="xtts-input"
            value={xttsSettings.serverUrl}
            onChange={(e) => onUpdateXttsSettings({ serverUrl: e.target.value })}
            placeholder="http://127.0.0.1:8020"
          />
        </label>

        <label className="xtts-label">
          Dossier XTTS
          <input
            className="xtts-input"
            value={xttsSettings.xttsDir}
            onChange={(e) => onUpdateXttsSettings({ xttsDir: e.target.value })}
            placeholder="C:\\chemin\\vers\\XTTS"
          />
        </label>

        <label className="xtts-label">
          Langue par defaut
          <select
            className="xtts-input"
            value={xttsSettings.language}
            onChange={(e) => onUpdateXttsSettings({ language: e.target.value })}
          >
            {LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="opts-row opts-row--pt">
        <div className="opts-row-info">
          <div className="opts-row-label">Demarrer XTTS automatiquement si le serveur est arrete</div>
          <div className="opts-row-sub">
            Story Studio lancera `server.py` depuis ton dossier XTTS si besoin.
          </div>
        </div>
        <Toggle on={xttsSettings.autoStart} onChange={(v) => onUpdateXttsSettings({ autoStart: v })} />
      </div>

      <div className="opts-row opts-row--pt">
        <div className="opts-row-info">
          <div className="opts-row-label">Forcer le CPU (compatible ComfyUI simultané)</div>
          <div className="opts-row-sub">
            XTTS s'exécute sur CPU — plus lent (~3×) mais libère le GPU pour ComfyUI.
          </div>
        </div>
        <Toggle on={xttsSettings.forceCpu} onChange={(v) => onUpdateXttsSettings({ forceCpu: v })} />
      </div>

      <div className="xtts-actions">
        <Button onClick={handleTestXtts} disabled={xttsProbe.state === 'loading'}>
          {xttsProbe.state === 'loading' ? 'Test en cours…' : 'Tester et actualiser les voix'}
        </Button>
        <span className="opts-row-sub">
          {favoriteVoices.length > 0
            ? `${favoriteVoices.length} voix favorite(s) affichee(s) dans le modal.`
            : 'Aucune favorite : toutes les voix XTTS detectees seront proposees.'}
        </span>
      </div>

      {xttsProbe.state !== 'idle' && (
        <div className={`info-box ${xttsProbe.state === 'error' ? 'warn' : ''}`}>
          {xttsProbe.message}
        </div>
      )}

      {xttsLogs.length > 0 && (
        <div className="xtts-log-panel" aria-label="Journal XTTS">
          {xttsLogs.map((line, index) => (
            <div key={`${index}-${line}`} className="xtts-log-line">{line}</div>
          ))}
        </div>
      )}

      <div className="xtts-voices-panel">
        <div className="xtts-voices-header">
          <div>
            <div className="opts-row-label">Voix favorites</div>
            <div className="opts-row-sub">
              Coche uniquement les voix que tu veux voir dans le modal de generation.
            </div>
          </div>
          <Button onClick={handleClearXttsFavorites} disabled={favoriteVoices.length === 0}>
            Tout afficher
          </Button>
        </div>

        {!xttsVoicesLoaded ? (
          <div className="xtts-voices-empty">
            Actualise les voix XTTS pour choisir tes favorites.
          </div>
        ) : xttsVoices.length === 0 ? (
          <div className="xtts-voices-empty">
            Aucune voix retournee par XTTS.
          </div>
        ) : (
          <div className="xtts-voice-list">
            {xttsVoices.map((voiceName) => (
              <label key={voiceName} className="xtts-voice-item">
                <input
                  type="checkbox"
                  checked={favoriteVoices.includes(voiceName)}
                  onChange={() => handleToggleXttsFavorite(voiceName)}
                />
                <span>{voiceName}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
