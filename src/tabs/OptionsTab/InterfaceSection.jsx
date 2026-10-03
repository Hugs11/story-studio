import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';
import { useSelectionOpensSettings } from '../../hooks/useSelectionOpensSettings';
import { writeSelectionOpensSettings } from '../../store/selectionOpensSettings';
import { THEME_OPTIONS } from '../../store/themePreference';

export function InterfaceSection({
  className,
  sectionRef,
  themePreference,
  onThemePreferenceChange,
  onOpenShortcuts,
}) {
  const selectionOpensSettings = useSelectionOpensSettings();
  return (
    <section id="interface" className={className} ref={sectionRef}>
      <div className="opts-card-title">Interface</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Thème</div>
          <div className="opts-row-sub">Système suit l'apparence configurée dans Windows/macOS</div>
        </div>
        <select
          className="xtts-input opts-select"
          value={themePreference}
          onChange={(event) => onThemePreferenceChange?.(event.target.value)}
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Ouvrir les réglages quand on sélectionne un nœud</div>
          <div className="opts-row-sub">Dans les deux éditeurs : un clic dans l'arbre, le diagramme, la liste ou le graphe rouvre les Réglages ou l'Inspecteur s'ils sont fermés.</div>
        </div>
        <Toggle
          on={selectionOpensSettings}
          onChange={writeSelectionOpensSettings}
          ariaLabel="Ouvrir les réglages quand on sélectionne un nœud"
        />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Raccourcis clavier</div>
          <div className="opts-row-sub">Voir et modifier les raccourcis de l'application</div>
        </div>
        <Button onClick={onOpenShortcuts}>
          Modifier
        </Button>
      </div>
    </section>
  );
}
