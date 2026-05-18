import { Toggle } from '../common/Toggle';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import '../../tabs/OptionsTab.css';
import './StorySettingsModal.css';

const AUDIO_OPTIONS = [
  { key: 'convertFormat', label: 'Convertir + normaliser le volume', sub: 'Convertit en mp3 44100 Hz mono et normalise le volume' },
  { key: 'addSilence', label: 'Silence début / fin', sub: 'Ajoute 1 sec de silence au début et à la fin' },
];

export function StorySettingsModal({
  open,
  projectType,
  globalOptions,
  onClose,
  onUpdateOption,
}) {
  const isSimpleProject = projectType === 'simple';

  useEscapeKey(open, onClose);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box story-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Réglages de l'histoire</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="story-settings-body">
          <div className="story-settings-lead">
            Ces réglages s'appliquent à l'histoire en cours et seront enregistrés dans le projet.
          </div>

          <div className="opts-card">
            <div className="opts-card-title">Traitement audio du pack</div>
            {AUDIO_OPTIONS.map(({ key, label, sub }) => (
              <div key={key} className="opts-row">
                <div className="opts-row-info">
                  <div className="opts-row-label">{label}</div>
                  <div className="opts-row-sub">{sub}</div>
                </div>
                <Toggle on={globalOptions[key]} onChange={(value) => onUpdateOption(key, value)} />
              </div>
            ))}
          </div>

          <div className="opts-card">
            <div className="opts-card-title">Comportement de lecture global</div>
            <div className="opts-row" style={isSimpleProject ? { opacity: 0.45, pointerEvents: 'none' } : {}}>
              <div className="opts-row-info">
                <div className="opts-row-label">
                  Auto-next
                  {isSimpleProject && <span className="story-settings-inline-note">(mode pack uniquement)</span>}
                </div>
                <div className="opts-row-sub">Enchaîner automatiquement les histoires</div>
              </div>
              <Toggle on={globalOptions.autoNext} onChange={(value) => onUpdateOption('autoNext', value)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
