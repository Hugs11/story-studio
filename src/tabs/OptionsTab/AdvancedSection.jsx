import { Toggle } from '../../components/common/Toggle';
import {
  PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS,
  PACK_AUDIO_EDGE_SILENCE_SECONDS,
  normalizePackAudioEdgeSilence,
} from '../../config/audioProcessing.js';
import { usePersistentState } from '../../hooks/usePersistentState';
import { KEYS } from '../../store/persistentSettings';

const BOOL_CODEC = {
  decode: (raw) => raw === 'true',
  encode: (value) => String(!!value),
};

const SILENCE_CODEC = {
  decode: (raw) => normalizePackAudioEdgeSilence(raw),
  encode: (value) => String(normalizePackAudioEdgeSilence(value)),
};

function SilenceDurationRow({ value, onChange, label }) {
  return (
    <div className="opts-row">
      <div className="opts-row-info">
        <div className="opts-row-label">{label}</div>
        <div className="opts-row-sub">
          Durée en secondes, à partir de {PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS}.
        </div>
      </div>
      <input
        className="xtts-input opts-number"
        type="number"
        min={PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS}
        step="0.1"
        value={value}
        onChange={(event) => onChange(normalizePackAudioEdgeSilence(event.target.value))}
      />
    </div>
  );
}

export function AdvancedSection({ className, sectionRef }) {
  const [allowUnsupportedPackExtraction, setAllowUnsupportedPackExtraction] = usePersistentState(
    KEYS.ALLOW_UNSUPPORTED_PACK_EXTRACTION,
    false,
    BOOL_CODEC,
  );
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
      <div className="opts-card-title">Import et traitement audio avancés</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Autoriser l’extraction des packs non supportés</div>
          <div className="opts-row-sub">
            Permet de tenter une projection incomplète pour récupérer des médias ou des histoires.
            La fidélité du pack et sa capacité à être régénéré ne sont pas garanties. Les protections de sécurité des fichiers restent actives.
          </div>
        </div>
        <Toggle on={allowUnsupportedPackExtraction} onChange={setAllowUnsupportedPackExtraction} />
      </div>
      {allowUnsupportedPackExtraction && (
        <div className="info-box info-box--spaced warn">
          Mode risqué activé : Story Studio demandera une confirmation avant d’extraire un pack déclaré non supporté.
        </div>
      )}
      <SilenceDurationRow
        label="Silence au début"
        value={leadingSilenceSeconds}
        onChange={setLeadingSilenceSeconds}
      />
      <SilenceDurationRow
        label="Silence à la fin"
        value={trailingSilenceSeconds}
        onChange={setTrailingSilenceSeconds}
      />
    </section>
  );
}
