// Sous-composant slider de la modale d'edition d'image. Extrait de
// ImageEditorModal.jsx pour reduire la surface du composant orchestrateur.

export function FilterSlider({ label, value, min, max, unit = '', signed = true, onChange }) {
  const displayValue = signed && value > 0 ? `+${value}` : value;

  return (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="filter-slider"
      />
      <span className="filter-value">{displayValue}{unit}</span>
    </div>
  );
}
