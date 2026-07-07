import { Button } from '../../components/common/Button';
import { THEME_OPTIONS } from '../../store/themePreference';

export function InterfaceSection({
  className,
  sectionRef,
  themePreference,
  onThemePreferenceChange,
  onOpenShortcuts,
}) {
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
