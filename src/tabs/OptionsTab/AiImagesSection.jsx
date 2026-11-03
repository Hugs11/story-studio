import { TechnicalDetail } from '../../components/common/UserMessage.jsx';
import { useTranslation } from 'react-i18next';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { presentUserMessage, presentStoredError } from '../../i18n/userMessage.js';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';
import { pickComfyWorkflowApiJson, pickComfyWorkflowConfigJson } from '../../hooks/useFileDialog';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function AiImagesSection({ className, sectionRef, sdSettings, onUpdateSdSettings }) {
  const { t } = useTranslation('settings');
  useMessageLanguage();
  const [sdProbe, setSdProbe] = useState({ state: 'idle', message: '' });
  const [sdWorkflows, setSdWorkflows] = useState([]);
  const [importApiPath, setImportApiPath] = useState(null);
  const [importConfigPath, setImportConfigPath] = useState(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    invoke('comfyui_list_workflows')
      .then(setSdWorkflows)
      .catch(() => {});
  }, []);

  async function handleTestSd() {
    const launching = sdSettings?.autoStart && sdSettings?.launcherPath;
    setSdProbe({
      state: 'loading',
      message: launching ? { key: 'settings:images.start.progress' } : { key: 'settings:images.connect.progress' },
    });
    try {
      await invoke('comfyui_check', { settings: sdSettings });
      setSdProbe({ state: 'ok', message: { key: 'settings:images.ready.message' } });
    } catch (e) {
      setSdProbe({ state: 'error', message: { userMessage: e, codedOnly: true } });
    }
  }

  async function handlePickApiJson() {
    const result = await pickComfyWorkflowApiJson();
    if (result) setImportApiPath(result);
  }

  async function handlePickConfigJson() {
    const result = await pickComfyWorkflowConfigJson();
    if (result) setImportConfigPath(result);
  }

  async function handleImportWorkflow() {
    if (!importApiPath || !importConfigPath) return;
    setImporting(true);
    try {
      const wf = await invoke('comfyui_import_workflow', {
        apiJsonPath: importApiPath,
        configJsonPath: importConfigPath,
      });
      setSdWorkflows(prev => [...prev.filter(w => w.id !== wf.id), wf]);
      setImportApiPath(null);
      setImportConfigPath(null);
    } catch (e) {
      setSdProbe({ state: 'error', message: { key: 'settings:images.import.error', params: { message: { userMessage: e, codedOnly: true } } } });
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteWorkflow(workflowId) {
    try {
      await invoke('comfyui_delete_workflow', { workflowId });
      setSdWorkflows(prev => prev.filter(w => w.id !== workflowId));
    } catch (e) {
      setSdProbe({ state: 'error', message: { key: 'settings:images.delete.error', params: { message: { userMessage: e, codedOnly: true } } } });
    }
  }

  return (
    <section id="comfyui" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:images.section.title')}</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:images.enable.label')}</div>
          <div className="opts-row-sub">{t('settings:images.enable.description')}</div>
        </div>
        <Toggle on={sdSettings?.aiImageGen} onChange={(v) => onUpdateSdSettings?.({ aiImageGen: v })} />
      </div>

      {sdSettings?.aiImageGen && (
        <div className="xtts-settings">
          <div className="xtts-grid">
            <label className="xtts-label">{t('settings:images.server.label')} <input
                className="xtts-input"
                value={sdSettings?.serverUrl ?? ''}
                onChange={(e) => onUpdateSdSettings?.({ serverUrl: e.target.value })}
                placeholder="http://127.0.0.1:8188"
              />
            </label>
            <label className="xtts-label">{t('settings:images.launcher.label')} <input
                className="xtts-input"
                value={sdSettings?.launcherPath ?? ''}
                onChange={(e) => onUpdateSdSettings?.({ launcherPath: e.target.value })}
                placeholder={t('settings:images.launcher.placeholder')}
              />
            </label>
          </div>

          <div className="opts-row opts-row--pt">
            <div className="opts-row-info">
              <div className="opts-row-label">{t('settings:images.autoStart.label')}</div>
              <div className="opts-row-sub">{t('settings:images.autoStart.description')}</div>
            </div>
            <Toggle on={sdSettings?.autoStart} onChange={(v) => onUpdateSdSettings?.({ autoStart: v })} />
          </div>

          <div className="xtts-actions">
            <Button onClick={handleTestSd} disabled={sdProbe.state === 'loading'}>
              {sdProbe.state === 'loading'
                ? (sdSettings?.autoStart && sdSettings?.launcherPath ? t('settings:images.start.action') : t('settings:voice.test.progress'))
                : t('settings:images.test.action')}
            </Button>
          </div>

          {sdProbe.state !== 'idle' && (
            <div className={`info-box ${sdProbe.state === 'error' ? 'warn' : ''}`}>
              {presentStoredError(sdProbe.message)}
              {sdProbe.state === 'error' && <TechnicalDetail value={presentUserMessage(sdProbe.message?.params?.message?.userMessage ?? sdProbe.message?.userMessage).technicalDetail} />}
            </div>
          )}

          {/* Gestion des workflows */}
          <div className="sd-workflows-section">
            <div className="opts-row-label" style={{ marginBottom: 8 }}>{t('settings:images.workflows.title')}</div>
            {sdWorkflows.length === 0 ? (
              <div className="opts-row-sub">{t('settings:images.workflows.empty')}</div>
            ) : (
              <div className="sd-workflow-list">
                {sdWorkflows.map(wf => (
                  <div key={wf.id} className="sd-workflow-item">
                    <div>
                      <span className="sd-workflow-item-name">{wf.name}</span>
                      {!wf.isCustom && <span className="sd-workflow-item-tag">{t('settings:images.workflow.badge')}</span>}
                    </div>
                    {wf.isCustom && (
                      <Button
                        size="sm"
                        onClick={() => handleDeleteWorkflow(wf.id)}
                      >{t('common:dialog.delete.label')}</Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="sd-import-section">
              <div className="opts-row-label" style={{ marginBottom: 6 }}>{t('settings:images.import.title')}</div>
              <div className="sd-import-row">
                <Button size="sm" onClick={handlePickApiJson}>
                  {importApiPath ? t('settings:images.api.selected') : t('settings:images.api.action')}
                </Button>
                <Button size="sm" onClick={handlePickConfigJson}>
                  {importConfigPath ? t('settings:images.config.selected') : t('settings:images.config.action')}
                </Button>
                <Button
                  size="sm"
                  variant="primary-violet"
                  onClick={handleImportWorkflow}
                  disabled={!importApiPath || !importConfigPath || importing}
                >
                  {importing ? t('settings:images.import.progress') : t('settings:images.import.action')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
