import { Toggle } from '../../components/common/Toggle';

export function SaveSection({
  className,
  sectionRef,
  autoSaveEnabled,
  onAutoSaveChange,
  autoSaveBackupLimit,
  onAutoSaveBackupLimitChange,
}) {
  return (
    <section id="save" className={className} ref={sectionRef}>
      <div className="opts-card-title">Enregistrement</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Enregistrement automatique</div>
          <div className="opts-row-sub">Activé par défaut : enregistre le projet toutes les 5 minutes si des modifications sont en attente. Un projet jamais enregistré est copié dans le dossier sauvegardes/ de l'emplacement de travail.</div>
        </div>
        <Toggle on={autoSaveEnabled} onChange={onAutoSaveChange} />
      </div>
      {autoSaveEnabled && (
        <div className="opts-row">
          <div className="opts-row-info">
            <div className="opts-row-label">Versions de sécurité</div>
            <div className="opts-row-sub">Nombre de copies `.mbah` conservées avant chaque enregistrement automatique.</div>
          </div>
          <input
            className="xtts-input opts-number"
            type="number"
            min="0"
            max="50"
            value={autoSaveBackupLimit}
            onChange={(event) => onAutoSaveBackupLimitChange?.(Math.max(0, Math.min(50, Number(event.target.value) || 0)))}
          />
        </div>
      )}
      <div className="opts-help">
        Raccourcis : <strong>Ctrl+S</strong> pour enregistrer, <strong>Ctrl+Maj+S</strong> pour enregistrer sous
      </div>
    </section>
  );
}
