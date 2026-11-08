import { Trans, useTranslation } from 'react-i18next';
import { useProjectMediaDirectory } from '../../hooks/useProjectMediaDirectory';
import { useState } from 'react';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';
import { useAudioLevelAlerts } from '../../hooks/useAudioLevelAlerts';
import { writeAudioLevelAlerts } from '../../store/audioLevelAlertSettings';

export function ProjectsMediaSection({
  className,
  sectionRef,
  useWorkspaceForNewProjects,
  onUseWorkspaceForNewProjectsChange,
  displayedWorkspaceDir,
  onPickWorkspaceDir,
  copyFilesEnabled,
  onCopyFilesChange,
  onConsolidateProject,
  project,
}) {
  const { t } = useTranslation('settings');
  const importDirectory = useProjectMediaDirectory('fichiers-importes', { root: displayedWorkspaceDir, storage: project?.storage, ephemeral: false });
  const audioLevelAlerts = useAudioLevelAlerts();
  const [consolidating, setConsolidating] = useState(false);
  const [consolidationResult, setConsolidationResult] = useState(null);

  async function handleConsolidate() {
    setConsolidating(true);
    setConsolidationResult(null);
    try {
      const result = await onConsolidateProject?.();
      if (result) setConsolidationResult(result);
    } finally {
      setConsolidating(false);
    }
  }

  const copiedMediaLabel = consolidationResult?.copiedCount === 0
    ? t('settings:projects.consolidate.noCopiedMedia')
    : t('settings:projects.consolidate.copied', { count: consolidationResult?.copiedCount ?? 0 });

  return (
    <section id="projects-media" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:projects.section.title')}</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:projects.workspace.label')}</div>
          <div className="opts-row-sub">{t('settings:projects.workspace.description')}</div>
        </div>
        <Toggle on={!!useWorkspaceForNewProjects} onChange={onUseWorkspaceForNewProjectsChange} />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:projects.location.label')}</div>
          <div className="opts-row-sub">{t('settings:projects.location.description')}</div>
          <div className="opts-path-value" title={displayedWorkspaceDir || ''}>
            {displayedWorkspaceDir || t('settings:projects.location.progress')}
          </div>
        </div>
        <Button onClick={onPickWorkspaceDir}>{t('settings:projects.choose.action')}</Button>
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:projects.copy.label')}</div>
          <div className="opts-row-sub">
            <Trans i18nKey="settings:projects.copy.description" components={{ strong: <strong /> }} values={{ directory: importDirectory }} />
          </div>
        </div>
        <Toggle on={copyFilesEnabled} onChange={(v) => onCopyFilesChange?.(v)} />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:projects.levelAlerts.label')}</div>
          <div className="opts-row-sub">{t('settings:projects.levelAlerts.description')}</div>
        </div>
        <Toggle on={audioLevelAlerts} onChange={writeAudioLevelAlerts} ariaLabel={t('settings:projects.levelAlerts.label')} />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:projects.consolidate.label')}</div>
          <div className="opts-row-sub">{t('settings:projects.consolidate.description')}</div>
        </div>
        <Button onClick={handleConsolidate} disabled={consolidating || !project?.projectType}>
          {consolidating ? t('settings:projects.consolidate.progress') : t('settings:projects.consolidate.action')}
        </Button>
      </div>
      {consolidationResult && (
        <div className={`info-box info-box--spaced ${consolidationResult.errors?.length ? 'warn' : ''}`}>
          {consolidationResult.errors?.length
            ? t('settings:projects.consolidate.warning', { copied: copiedMediaLabel, missing: t('settings:projects.consolidate.missing', { count: consolidationResult.errors.length }) })
            : t('settings:projects.consolidate.success', { copied: copiedMediaLabel })}
        </div>
      )}
    </section>
  );
}
