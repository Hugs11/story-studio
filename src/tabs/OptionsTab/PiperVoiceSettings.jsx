import { Button } from '../../components/common/Button';

export function PiperVoiceSettings({
  piperVoices,
  piperProvision,
  piperVoice,
  piperSpeed,
  piperSentenceSilence,
  updatePiperVoice,
  updatePiperSpeed,
  updatePiperSentenceSilence,
  preparePiperVoice,
}) {
  return (
    <div className="xtts-settings">
      <div className="opts-row-sub" style={{ marginBottom: 8 }}>
        Piper ajoute un bouton texte → audio dans tous les champs audio. La voix est téléchargée
        automatiquement au premier usage.
      </div>
      <div className="xtts-grid">
        <label className="xtts-label">
          Voix
          <select
            className="xtts-input"
            value={piperVoice}
            onChange={(e) => updatePiperVoice(e.target.value)}
          >
            {(piperVoices.length > 0 ? piperVoices : [{ id: piperVoice, label: piperVoice, installed: false }]).map((voice) => (
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

        <label className="xtts-label">
          Pause phrase ({piperSentenceSilence.toFixed(2)}s)
          <input
            className="xtts-input"
            type="number"
            min="0"
            max="1.5"
            step="0.05"
            value={piperSentenceSilence}
            onChange={(e) => updatePiperSentenceSilence(e.target.value)}
          />
        </label>
      </div>

      <div className="xtts-actions">
        <Button onClick={preparePiperVoice} disabled={piperProvision.state === 'loading'}>
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
