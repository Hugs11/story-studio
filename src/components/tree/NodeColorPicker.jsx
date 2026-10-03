import { TREE_COLOR_PALETTE } from './treeOperations.js';

// Palette partagée par le menu du Libre et l'éditeur Graphe. L'état mixte est
// un état d'affichage : cliquer une couleur l'applique à toute la sélection,
// cliquer × efface toute la sélection.
export function NodeColorPicker({
  currentColor = null,
  label = 'Couleur',
  disabled = false,
  onChange,
}) {
  return (
    <div className="ctx-color-section">
      {label && <div className="ctx-color-header">{label}</div>}
      <div className="ctx-color-row">
        {TREE_COLOR_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className={`ctx-color-dot${currentColor === color ? ' is-active' : ''}`}
            style={{ backgroundColor: color }}
            title={color}
            aria-label={`Choisir la couleur ${color}`}
            aria-pressed={currentColor === color}
            disabled={disabled}
            onClick={() => onChange(color)}
          />
        ))}
        <button
          type="button"
          className={`ctx-color-clear${currentColor === null ? ' is-active' : ''}`}
          title={currentColor === '__mixed__' ? 'Couleurs différentes — cliquer pour effacer' : 'Aucune couleur'}
          aria-label="Retirer la couleur"
          aria-pressed={currentColor === null}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
