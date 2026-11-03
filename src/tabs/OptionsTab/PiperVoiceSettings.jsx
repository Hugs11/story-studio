import { Select } from '../../components/common/Select.jsx';
import { TechnicalDetail } from '../../components/common/UserMessage.jsx';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/common/Button';
import { PIPER_LANGUAGE_OPTIONS } from '../../store/xttsSettings';

export function PiperVoiceSettings({
  piperVoices,
  piperProvision,
  piperLanguage,
  piperVoice,
  piperSpeed,
  updatePiperLanguage,
  updatePiperVoice,
  updatePiperSpeed,
  preparePiperVoice,
}) {
  const { t } = useTranslation('settings');
  const visibleVoices = piperVoices.filter((voice) => voice.language === piperLanguage);
  const voiceOptions = visibleVoices.length > 0
    ? visibleVoices
    : [{ id: piperVoice, label: piperVoice, installed: false }];

  return (
    <div className="xtts-settings">
      <div className="opts-row-sub" style={{ marginBottom: 8 }}>{t('settings:piper.help.description')}</div>
      <div className="xtts-grid">
        <label className="xtts-label">{t('settings:voice.language.label')} <Select
            className="xtts-input"
            value={piperLanguage}
            onChange={updatePiperLanguage}
            disabled={piperVoices.length === 0}
            aria-label={t('settings:voice.language.label')}
            options={PIPER_LANGUAGE_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
          />
        </label>

        <label className="xtts-label">{t('settings:voice.voice.label')} <Select
            className="xtts-input"
            value={piperVoice}
            onChange={updatePiperVoice}
            disabled={piperVoices.length === 0}
            aria-label={t('settings:voice.voice.label')}
            options={voiceOptions.map(voice => ({
              value: voice.id,
              label: voice.installed ? voice.label : t('settings:piper.voice.download', { name: voice.label }),
            }))}
          />
        </label>

        <label className="xtts-label">
          {t('settings:piper.speed.label', { speed: piperSpeed.toFixed(2) })}
          <input
            className="xtts-input"
            type="number"
            min="0.5"
            max="1.5"
            step="0.05"
            value={piperSpeed}
            onChange={(e) => updatePiperSpeed(e.target.value)}
          />
        </label>
      </div>

      <div className="xtts-actions">
        <Button
          onClick={preparePiperVoice}
          disabled={piperProvision.state === 'loading' || piperVoices.length === 0}
        >
          {piperProvision.state === 'loading' ? t('settings:piper.download.progress') : t('settings:piper.prepare.action')}
        </Button>
        <span className="opts-row-sub">{t('settings:piper.prepare.description')}</span>
      </div>

      {piperProvision.state !== 'idle' && (
        <div className={`info-box ${piperProvision.state === 'error' ? 'warn' : ''}`}>
          {piperProvision.message}<TechnicalDetail value={piperProvision.technicalDetail} />
        </div>
      )}
    </div>
  );
}
