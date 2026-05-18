import { useState } from 'react';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  findShortcutConflict,
  formatShortcut,
  resetKeyboardShortcuts,
  shortcutFromEvent,
} from '../../store/keyboardShortcuts';
import './KeyboardShortcutsModal.css';

const AUDIO_EDITOR_SHORTCUTS = [
  { label: 'Play / Pause',                         keys: ['Espace'] },
  { label: 'Lecture arrière jog/shuttle',           keys: ['J'] },
  { label: 'Pause jog/shuttle',                     keys: ['K'] },
  { label: 'Lecture avant jog/shuttle',             keys: ['L'] },
  { label: 'Augmenter la vitesse de navette',       keys: ['J répété', 'L répété'] },
  { label: 'Avancer / reculer de 50 ms avec écoute', keys: ['←', '→'] },
  { label: 'Aller au début / à la fin',             keys: ['Home', 'End'] },
  { label: 'Marquer le point d\'entrée',            keys: ['I'] },
  { label: 'Marquer le point de sortie',            keys: ['O'] },
  { label: 'Effacer le point d\'entrée',            keys: ['Ctrl+I'] },
  { label: 'Effacer le point de sortie',            keys: ['Ctrl+O'] },
  { label: 'Lire depuis le point d\'entrée',        keys: ['Shift+I'] },
  { label: 'Lire depuis le point de sortie',        keys: ['Shift+O'] },
  { label: 'Garder la sélection',                   keys: ['Ctrl+G'] },
  { label: 'Supprimer la sélection',                keys: ['Ctrl+X'] },
  { label: 'Annuler la modification en attente',    keys: ['Ctrl+Z'] },
  { label: 'Fermer l\'éditeur audio',               keys: ['Échap'] },
  { label: 'Zoomer autour de la souris',            keys: ['Ctrl+Molette'] },
  { label: 'Zoomer / dézoomer autour du curseur',    keys: ['Ctrl++', 'Ctrl+-'] },
];

export function KeyboardShortcutsModal({
  shortcuts,
  onChange,
  onClose,
}) {
  const [captureId, setCaptureId] = useState(null);
  const [message, setMessage] = useState('');

  function handleKeyDown(event, definition) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setCaptureId(null);
      setMessage('');
      return;
    }

    const nextShortcut = shortcutFromEvent(event);
    if (!nextShortcut) return;
    event.preventDefault();
    event.stopPropagation();

    const conflict = findShortcutConflict(shortcuts, definition.id, nextShortcut);
    if (conflict) {
      setMessage(`Déjà utilisé par "${conflict.label}".`);
      return;
    }

    onChange({ ...shortcuts, [definition.id]: nextShortcut });
    setCaptureId(null);
    setMessage('');
  }

  function handleReset() {
    const defaults = resetKeyboardShortcuts();
    onChange(defaults);
    setCaptureId(null);
    setMessage('');
  }

  function handleOverlayKeyDown(event) {
    if (captureId) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={handleOverlayKeyDown}
    >
      <div
        className="modal-box keyboard-shortcuts-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>Raccourcis clavier</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="keyboard-shortcuts-body">
          <div className="story-settings-lead">
            Clique sur un raccourci puis presse la nouvelle combinaison. Les raccourcis doivent utiliser Ctrl.
          </div>

          <div className="keyboard-shortcuts-list">
            {SHORTCUT_DEFINITIONS.map((definition) => (
              <div key={definition.id} className="keyboard-shortcut-row">
                <div className="keyboard-shortcut-info">
                  <div className="opts-row-label">{definition.label}</div>
                  <div className="opts-row-sub">Défaut : {formatShortcut(DEFAULT_SHORTCUTS[definition.id])}</div>
                </div>
                <button
                  type="button"
                  className={`keyboard-shortcut-capture ${captureId === definition.id ? 'is-capturing' : ''}`}
                  onClick={() => {
                    setCaptureId(definition.id);
                    setMessage('');
                  }}
                  onKeyDown={(event) => captureId === definition.id && handleKeyDown(event, definition)}
                >
                  {captureId === definition.id ? 'Appuie sur un raccourci...' : formatShortcut(shortcuts[definition.id])}
                </button>
              </div>
            ))}
          </div>

          {message ? <div className="keyboard-shortcuts-message">{message}</div> : null}

          <div className="keyboard-shortcuts-section-title">
            Éditeur audio
            <span className="keyboard-shortcuts-fixed-badge">fixe</span>
          </div>
          <div className="keyboard-shortcuts-fixed-note">
            Ces raccourcis sont contextuels à la fenêtre audio. Ils ne sont pas modifiables pour l'instant :
            le système de personnalisation actuel ne gère que les raccourcis globaux avec Ctrl.
          </div>
          <div className="keyboard-shortcuts-list">
            {AUDIO_EDITOR_SHORTCUTS.map(({ label, keys }) => (
              <div key={label} className="keyboard-shortcut-row">
                <div className="keyboard-shortcut-info">
                  <div className="opts-row-label">{label}</div>
                </div>
                <div className="keyboard-shortcut-keys">
                  {keys.map((k) => <kbd key={k} className="kbd">{k}</kbd>)}
                </div>
              </div>
            ))}
          </div>

          <div className="keyboard-shortcuts-actions">
            <button className="btn" type="button" onClick={handleReset}>Réinitialiser</button>
            <button className="btn btn-primary" type="button" onClick={onClose}>Fermer</button>
          </div>
        </div>
      </div>
    </div>
  );
}
