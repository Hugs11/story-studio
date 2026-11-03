import { useTreeTranslation } from '../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../i18n/treePresentation.js';
import './NodeColorFilterChips.css';

export function NodeColorFilterChips({ colors, selectedColors, onToggle }) {
  useTreeTranslation();
  if (!colors?.length) return null;

  return (
    <div className="node-color-filter-row" role="group" aria-label={t("tree:color.filter.aria")}>
      {colors.map(({ color, count, label }) => (
        <button
          key={color}
          type="button"
          className={`node-color-filter-chip${selectedColors.has(color) ? ' is-active' : ''}`}
          style={{ '--node-filter-color': color }}
          aria-label={t('tree:color.filter.itemsAria', { label, count })}
          aria-pressed={selectedColors.has(color)}
          title={t('tree:color.filter.itemsTitle', { label, count })}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onToggle(color)}
        />
      ))}
    </div>
  );
}
