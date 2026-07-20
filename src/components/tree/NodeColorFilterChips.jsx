import './NodeColorFilterChips.css';

export function NodeColorFilterChips({ colors, selectedColors, onToggle }) {
  if (!colors?.length) return null;

  return (
    <div className="node-color-filter-row" role="group" aria-label="Filtrer par couleur">
      {colors.map(({ color, count, label }) => (
        <button
          key={color}
          type="button"
          className={`node-color-filter-chip${selectedColors.has(color) ? ' is-active' : ''}`}
          style={{ '--node-filter-color': color }}
          aria-label={`${label}, ${count} élément${count > 1 ? 's' : ''}`}
          aria-pressed={selectedColors.has(color)}
          title={`${label} · ${count} élément${count > 1 ? 's' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onToggle(color)}
        />
      ))}
    </div>
  );
}
