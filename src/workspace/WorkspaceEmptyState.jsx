import { useCommonTranslation } from '../i18n/commonPresentation.js';
export function WorkspaceEmptyState({ onShowTree, onShowSettings, onShowDiagram }) {
  const { t } = useCommonTranslation();
  return (
    <div className="workspace-empty-state">
      <p>{t('common:workspace.empty.title')}</p>
      <span>{t('common:workspace.empty.description')}</span>
      <div className="workspace-empty-state-actions">
        <button type="button" onClick={onShowTree}>{t('common:workspace.tree.label')}</button>
        <button type="button" onClick={onShowSettings}>{t('common:workspace.settings.label')}</button>
        <button type="button" onClick={onShowDiagram}>{t('common:workspace.diagram.label')}</button>
      </div>
    </div>
  );
}
