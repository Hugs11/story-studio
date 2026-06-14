// Sous-composant slider de la modale d'edition d'image. Extrait de
// ImageEditorModal.jsx pour reduire la surface du composant orchestrateur.
//
// step + format permettent les valeurs flottantes (ex. gamma des niveaux,
// step 0.01 affiché « 1.20 »).

export function FilterSlider({ label, value, min, max, step = 1, unit = '', signed = true, format, onChange }) {
  const displayValue = format
    ? format(value)
    : (signed && value > 0 ? `+${value}` : value);

  return (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="filter-slider"
      />
      <span className="filter-value">{displayValue}{unit}</span>
    </div>
  );
}
