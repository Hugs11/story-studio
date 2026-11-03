import { Select } from '../../components/common/Select.jsx';
import { Trans, useTranslation } from 'react-i18next';
import { PiperVoiceSettings } from './PiperVoiceSettings';
import { XttsVoiceSettings } from './XttsVoiceSettings';
import { usePiperVoiceOptions } from './usePiperVoiceOptions';
import { useXttsVoiceOptions } from './useXttsVoiceOptions';

export function VoiceSection({ className, sectionRef, xttsSettings, onUpdateXttsSettings }) {
  const { t } = useTranslation('settings');
  const ttsBackend = xttsSettings.backend || 'piper';
  const piperOptions = usePiperVoiceOptions({ xttsSettings, onUpdateXttsSettings });
  const xttsOptions = useXttsVoiceOptions({ xttsSettings, onUpdateXttsSettings });

  function handleTtsBackendChange(backend) {
    // Sélectionner XTTS l'active (le moteur remplace l'ancien toggle d'activation).
    onUpdateXttsSettings(backend === 'xtts' ? { backend, enabled: true } : { backend });
  }

  return (
    <section id="xtts" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:voice.section.title')}</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:voice.backend.label')}</div>
          <div className="opts-row-sub">
            <Trans i18nKey="settings:voice.backend.description" components={{ piper: <strong />, xtts: <strong /> }} />
          </div>
        </div>
        <Select
          className="xtts-input opts-select"
          value={ttsBackend}
          onChange={handleTtsBackendChange}
          aria-label={t('settings:voice.backend.label')}
          options={[
            { value: 'piper', label: t('settings:voice.backend.piper') },
            { value: 'xtts', label: t('settings:voice.backend.xtts') },
          ]}
        />
      </div>

      {ttsBackend === 'piper' && (
        <PiperVoiceSettings {...piperOptions} />
      )}

      {ttsBackend === 'xtts' && (
        <XttsVoiceSettings
          xttsSettings={xttsSettings}
          {...xttsOptions}
        />
      )}
    </section>
  );
}
