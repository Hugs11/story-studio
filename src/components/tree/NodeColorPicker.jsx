import { useTreeTranslation } from '../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../i18n/treePresentation.js';
import { TREE_COLOR_PALETTE } from './treeOperations.js';

// Palette partagée par le menu du Libre et l'éditeur Graphe. L'état mixte est
// un état d'affichage : cliquer une couleur l'applique à toute la sélection,
// cliquer × efface toute la sélection.
export function NodeColorPicker({
  currentColor = null,
  label = t("tree:multi.color.label"),
  disabled = false,
  onChange,
}) {
  useTreeTranslation();
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
            aria-label={t("tree:color.choose.aria", { color })}
            aria-pressed={currentColor === color}
            disabled={disabled}
            onClick={() => onChange(color)}
          />
        ))}
        <button
          type="button"
          className={`ctx-color-clear${currentColor === null ? ' is-active' : ''}`}
          title={currentColor === '__mixed__' ? t("tree:multi.color.clearMixed") : t("tree:multi.color.none")}
          aria-label={t("tree:color.clear.aria")}
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
