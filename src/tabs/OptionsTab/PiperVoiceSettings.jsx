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
  const visibleVoices = piperVoices.filter((voice) => voice.language === piperLanguage);
  const voiceOptions = visibleVoices.length > 0
    ? visibleVoices
    : [{ id: piperVoice, label: piperVoice, installed: false }];

  return (
    <div className="xtts-settings">
      <div className="opts-row-sub" style={{ marginBottom: 8 }}>
        Piper ajoute un bouton texte → audio dans tous les champs audio. La voix est téléchargée
        automatiquement au premier usage.
      </div>
      <div className="xtts-grid">
        <label className="xtts-label">
          Langue
          <select
            className="xtts-input"
            value={piperLanguage}
            onChange={(e) => updatePiperLanguage(e.target.value)}
            disabled={piperVoices.length === 0}
          >
            {PIPER_LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label className="xtts-label">
          Voix
          <select
            className="xtts-input"
            value={piperVoice}
            onChange={(e) => updatePiperVoice(e.target.value)}
            disabled={piperVoices.length === 0}
          >
            {voiceOptions.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}{voice.installed ? '' : ' — à télécharger'}
              </option>
            ))}
          </select>
        </label>

        <label className="xtts-label">
          Vitesse ({piperSpeed.toFixed(2)}×)
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
          {piperProvision.state === 'loading' ? 'Téléchargement…' : 'Préparer la voix maintenant'}
        </Button>
        <span className="opts-row-sub">
          Optionnel : prépare la voix sélectionnée à l’avance pour éviter l’attente au 1er usage.
        </span>
      </div>

      {piperProvision.state !== 'idle' && (
        <div className={`info-box ${piperProvision.state === 'error' ? 'warn' : ''}`}>
          {piperProvision.message}
        </div>
      )}
    </div>
  );
}
