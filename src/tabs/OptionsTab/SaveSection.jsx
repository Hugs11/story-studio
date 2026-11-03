import { Trans, useTranslation } from 'react-i18next';
import { Toggle } from '../../components/common/Toggle';
import { getShortcutLabelMap } from '../../store/keyboardShortcuts';

export function SaveSection({
  className,
  sectionRef,
  autoSaveEnabled,
  onAutoSaveChange,
  autoSaveBackupLimit,
  onAutoSaveBackupLimitChange,
  shortcuts,
}) {
  const { t } = useTranslation('settings');
  // Raccourcis réels (personnalisés ou par défaut), touche de commande de la plateforme.
  const shortcutLabels = getShortcutLabelMap(shortcuts);
  return (
    <section id="save" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:save.section.title')}</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:save.auto.label')}</div>
          <div className="opts-row-sub">{t('settings:save.auto.description')}</div>
        </div>
        <Toggle on={autoSaveEnabled} onChange={onAutoSaveChange} />
      </div>
      {autoSaveEnabled && (
        <div className="opts-row">
          <div className="opts-row-info">
            <div className="opts-row-label">{t('settings:save.backups.label')}</div>
            <div className="opts-row-sub">{t('settings:save.backups.description')}</div>
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
        <Trans i18nKey="settings:save.shortcuts.description" values={{ save: shortcutLabels.saveProject, saveAs: shortcutLabels.saveAs }} components={{ save: <strong />, saveAs: <strong /> }} />
      </div>
    </section>
  );
}
