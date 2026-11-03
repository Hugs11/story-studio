import { Select } from '../../components/common/Select.jsx';
import { TechnicalDetail } from '../../components/common/UserMessage.jsx';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';

const LANGUAGE_OPTIONS = [
  { value: 'fr', labelKey: 'ai:voice.language.fr' },
  { value: 'en', labelKey: 'ai:voice.language.en' },
  { value: 'es', labelKey: 'ai:voice.language.es' },
  { value: 'de', labelKey: 'ai:voice.language.de' },
  { value: 'it', labelKey: 'ai:voice.language.it' },
  { value: 'pt', labelKey: 'ai:voice.language.pt' },
];

export function XttsVoiceSettings({
  xttsSettings,
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
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="xtts-settings">
      <div className="xtts-grid">
        <label className="xtts-label">{t('settings:xtts.server.label')} <input
            className="xtts-input"
            value={xttsSettings.serverUrl}
            onChange={(e) => updateServerUrl(e.target.value)}
            placeholder="http://127.0.0.1:8020"
          />
        </label>

        <label className="xtts-label">{t('settings:xtts.folder.label')} <input
            className="xtts-input"
            value={xttsSettings.xttsDir}
            onChange={(e) => updateXttsDir(e.target.value)}
            placeholder={t('settings:xtts.folder.placeholder')}
          />
        </label>

        <label className="xtts-label">{t('settings:xtts.language.label')} <Select
            className="xtts-input"
            value={xttsSettings.language}
            onChange={updateLanguage}
            aria-label={t('settings:xtts.language.label')}
            options={LANGUAGE_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
          />
        </label>
      </div>

      <div className="opts-row opts-row--pt">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:xtts.autoStart.label')}</div>
          <div className="opts-row-sub">{t('settings:xtts.autoStart.description')}</div>
        </div>
        <Toggle on={xttsSettings.autoStart} onChange={updateAutoStart} />
      </div>

      <div className="opts-row opts-row--pt">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:xtts.cpu.label')}</div>
          <div className="opts-row-sub">{t('settings:xtts.cpu.description')}</div>
        </div>
        <Toggle on={xttsSettings.forceCpu} onChange={updateForceCpu} />
      </div>

      <div className="xtts-actions">
        <Button onClick={testXtts} disabled={xttsProbe.state === 'loading'}>
          {xttsProbe.state === 'loading' ? t('settings:voice.test.progress') : t('settings:xtts.test.action')}
        </Button>
        <span className="opts-row-sub">
          {favoriteVoices.length > 0
            ? t('settings:xtts.favorites.count', { count: favoriteVoices.length })
            : t('settings:xtts.favorites.empty')}
        </span>
      </div>

      {xttsProbe.state !== 'idle' && (
        <div className={`info-box ${xttsProbe.state === 'error' ? 'warn' : ''}`}>
          {xttsProbe.message}<TechnicalDetail value={xttsProbe.technicalDetail} />
        </div>
      )}

      {xttsLogs.length > 0 && (
        <div className="xtts-log-panel" aria-label={t('settings:xtts.log.label')}>
          {xttsLogs.map((line, index) => (
            <div key={index} className="xtts-log-line">{line.message}<TechnicalDetail value={line.technicalDetail} /></div>
          ))}
        </div>
      )}

      <div className="xtts-voices-panel">
        <div className="xtts-voices-header">
          <div>
            <div className="opts-row-label">{t('settings:xtts.favorites.title')}</div>
            <div className="opts-row-sub">{t('settings:xtts.favorites.description')}</div>
          </div>
          <Button onClick={clearXttsFavorites} disabled={favoriteVoices.length === 0}>{t('settings:xtts.favorites.showAll')}</Button>
        </div>

        {!xttsVoicesLoaded ? (
          <div className="xtts-voices-empty">{t('settings:xtts.voices.refresh')}</div>
        ) : xttsVoices.length === 0 ? (
          <div className="xtts-voices-empty">{t('settings:xtts.voices.empty')}</div>
        ) : (
          <div className="xtts-voice-list">
            {xttsVoices.map((voiceName) => (
              <label key={voiceName} className="xtts-voice-item">
                <input
                  type="checkbox"
                  checked={favoriteVoices.includes(voiceName)}
                  onChange={() => toggleXttsFavorite(voiceName)}
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
