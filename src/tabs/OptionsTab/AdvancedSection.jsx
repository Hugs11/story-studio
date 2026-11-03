import { useTranslation } from 'react-i18next';
import {
  PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS,
  PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS,
  PACK_AUDIO_EDGE_SILENCE_SECONDS,
  normalizePackAudioEdgeSilence,
} from '../../config/audioProcessing.js';
import { usePersistentState } from '../../hooks/usePersistentState';
import { KEYS } from '../../store/persistentSettings';

const SILENCE_CODEC = {
  decode: (raw) => normalizePackAudioEdgeSilence(raw),
  encode: (value) => String(normalizePackAudioEdgeSilence(value)),
};

function SilenceDurationRow({ value, onChange, label }) {
  const { t } = useTranslation('settings');
  return (
    <div className="opts-row">
      <div className="opts-row-info">
        <div className="opts-row-label">{label}</div>
        <div className="opts-row-sub">
          {t('settings:silence.duration.description', { min: PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS, max: PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS })}
        </div>
      </div>
      <input
        className="xtts-input opts-number"
        type="number"
        min={PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS}
        max={PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS}
        step="0.1"
        value={value}
        onChange={(event) => onChange(normalizePackAudioEdgeSilence(event.target.value))}
      />
    </div>
  );
}

export function AdvancedSection({ className, sectionRef }) {
  const { t } = useTranslation('settings');
  const [leadingSilenceSeconds, setLeadingSilenceSeconds] = usePersistentState(
    KEYS.PACK_LEADING_SILENCE_SECONDS,
    PACK_AUDIO_EDGE_SILENCE_SECONDS,
    SILENCE_CODEC,
  );
  const [trailingSilenceSeconds, setTrailingSilenceSeconds] = usePersistentState(
    KEYS.PACK_TRAILING_SILENCE_SECONDS,
    PACK_AUDIO_EDGE_SILENCE_SECONDS,
    SILENCE_CODEC,
  );

  return (
    <section id="advanced" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:silence.section.title')}</div>
      <SilenceDurationRow
        label={t('settings:silence.leading.label')}
        value={leadingSilenceSeconds}
        onChange={setLeadingSilenceSeconds}
      />
      <SilenceDurationRow
        label={t('settings:silence.trailing.label')}
        value={trailingSilenceSeconds}
        onChange={setTrailingSilenceSeconds}
      />
    </section>
  );
}
