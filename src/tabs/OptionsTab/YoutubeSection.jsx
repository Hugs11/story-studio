import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../components/common/Button';
import { KEYS, read as readSetting, write } from '../../store/persistentSettings';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function YoutubeSection({ className, sectionRef }) {
  const [ytDlpPath, setYtDlpPath] = useState(() => readSetting(KEYS.YTDLP_CUSTOM_PATH, { defaultValue: '' }));
  const [ytDlpUpdate, setYtDlpUpdate] = useState({ state: 'idle', message: '' });

  // Reflète la progression de mise à jour de yt-dlp (téléchargement).
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let cancelled = false;
    let unlisten = null;
    listen('youtube-log', (event) => {
      if (cancelled) return;
      setYtDlpUpdate((prev) => (prev.state === 'loading' ? { ...prev, message: String(event.payload) } : prev));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, []);

  function handleYtDlpPathChange(value) {
    setYtDlpPath(value);
    write(KEYS.YTDLP_CUSTOM_PATH, value);
  }

  async function handleUpdateYtDlp() {
    setYtDlpUpdate({ state: 'loading', message: 'Mise à jour de yt-dlp…' });
    try {
      await invoke('update_ytdlp');
      setYtDlpUpdate({ state: 'ok', message: 'yt-dlp est à jour.' });
    } catch (e) {
      setYtDlpUpdate({ state: 'error', message: `${e}` });
    }
  }

  return (
    <section id="youtube" className={className} ref={sectionRef}>
      <div className="opts-card-title">YouTube (yt-dlp)</div>
      <div className="opts-help">
        Le funnel « Pack depuis YouTube » télécharge automatiquement yt-dlp au premier usage et le
        garde à jour. YouTube bloquant les versions périmées, ces réglages ne servent qu'en cas de souci.
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Mettre à jour yt-dlp maintenant</div>
          <div className="opts-row-sub">
            Force le téléchargement de la dernière version. Utile si un import échoue avec un message
            de version obsolète.
          </div>
        </div>
        <Button onClick={handleUpdateYtDlp} disabled={ytDlpUpdate.state === 'loading'} style={{ flexShrink: 0 }}>
          {ytDlpUpdate.state === 'loading' ? 'Mise à jour…' : 'Mettre à jour'}
        </Button>
      </div>
      {ytDlpUpdate.state !== 'idle' && (
        <div className={`info-box ${ytDlpUpdate.state === 'error' ? 'warn' : ''}`}>
          {ytDlpUpdate.message}
        </div>
      )}
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Chemin yt-dlp personnalisé</div>
          <div className="opts-row-sub">
            Laisse vide pour utiliser la version gérée automatiquement. Renseigne le chemin complet
            d'un <code>yt-dlp.exe</code> pour l'utiliser à la place (le téléchargement auto est alors ignoré).
          </div>
        </div>
        <input
          className="xtts-input"
          type="text"
          spellCheck={false}
          placeholder="C:\\chemin\\vers\\yt-dlp.exe"
          value={ytDlpPath}
          onChange={(event) => handleYtDlpPathChange(event.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
    </section>
  );
}
