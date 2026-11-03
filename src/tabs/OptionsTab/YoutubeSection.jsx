import { TechnicalDetail } from '../../components/common/UserMessage.jsx';
import { Trans, useTranslation } from 'react-i18next';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { presentUserMessage, presentStoredError } from '../../i18n/userMessage.js';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../components/common/Button';
import { KEYS, read as readSetting, write } from '../../store/persistentSettings';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { releaseTauriListener } from '../../utils/tauriListener';

export function YoutubeSection({ className, sectionRef }) {
  const { t } = useTranslation('settings');
  useMessageLanguage();
  const [ytDlpPath, setYtDlpPath] = useState(() => readSetting(KEYS.YTDLP_CUSTOM_PATH, { defaultValue: '' }));
  const [ytDlpUpdate, setYtDlpUpdate] = useState({ state: 'idle', message: '' });

  // Reflète la progression de mise à jour de yt-dlp (téléchargement).
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let cancelled = false;
    let unlisten = null;
    listen('youtube-log', (event) => {
      if (cancelled) return;
      setYtDlpUpdate((prev) => (prev.state === 'loading' ? { ...prev, message: event.payload } : prev));
    }).then((fn) => {
      if (cancelled) releaseTauriListener(fn);
      else unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; releaseTauriListener(unlisten); };
  }, []);

  function handleYtDlpPathChange(value) {
    setYtDlpPath(value);
    write(KEYS.YTDLP_CUSTOM_PATH, value);
  }

  async function handleUpdateYtDlp() {
    setYtDlpUpdate({ state: 'loading', message: { key: 'settings:youtube.update.progress' } });
    try {
      await invoke('update_ytdlp');
      setYtDlpUpdate({ state: 'ok', message: { key: 'settings:youtube.update.success' } });
    } catch (e) {
      setYtDlpUpdate({ state: 'error', message: { userMessage: e, codedOnly: true } });
    }
  }

  return (
    <section id="youtube" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:youtube.section.title')}</div>
      <div className="opts-help">{t('settings:youtube.help.description')}</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:youtube.update.label')}</div>
          <div className="opts-row-sub">{t('settings:youtube.update.description')}</div>
        </div>
        <Button onClick={handleUpdateYtDlp} disabled={ytDlpUpdate.state === 'loading'} style={{ flexShrink: 0 }}>
          {ytDlpUpdate.state === 'loading' ? t('settings:youtube.update.busy') : t('settings:youtube.update.action')}
        </Button>
      </div>
      {ytDlpUpdate.state !== 'idle' && (
        <div className={`info-box ${ytDlpUpdate.state === 'error' ? 'warn' : ''}`}>
          {presentStoredError(ytDlpUpdate.message)}
              {ytDlpUpdate.state === 'error' && <TechnicalDetail value={presentUserMessage(ytDlpUpdate.message?.params?.message?.userMessage ?? ytDlpUpdate.message?.userMessage).technicalDetail} />}
        </div>
      )}
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:youtube.path.label')}</div>
          <div className="opts-row-sub">
            <Trans i18nKey="settings:youtube.path.description" components={{ windows: <code />, unix: <code /> }} />
          </div>
        </div>
        <input
          className="xtts-input"
          type="text"
          spellCheck={false}
          placeholder={t('settings:youtube.path.placeholder')}
          value={ytDlpPath}
          onChange={(event) => handleYtDlpPathChange(event.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
    </section>
  );
}
