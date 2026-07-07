import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';
import { pickComfyWorkflowApiJson, pickComfyWorkflowConfigJson } from '../../hooks/useFileDialog';
import { isTauriRuntime } from '../../utils/tauriRuntime';

export function AiImagesSection({ className, sectionRef, sdSettings, onUpdateSdSettings }) {
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
    const launching = sdSettings?.autoStart && sdSettings?.batPath;
    setSdProbe({
      state: 'loading',
      message: launching ? 'Démarrage de ComfyUI en cours… (peut prendre jusqu\'à 60s)' : 'Connexion à ComfyUI en cours…',
    });
    try {
      await invoke('comfyui_check', { settings: sdSettings });
      setSdProbe({ state: 'ok', message: 'ComfyUI accessible et prêt.' });
    } catch (e) {
      setSdProbe({ state: 'error', message: String(e) });
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
      setSdProbe({ state: 'error', message: `Import échoué : ${e}` });
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteWorkflow(workflowId) {
    try {
      await invoke('comfyui_delete_workflow', { workflowId });
      setSdWorkflows(prev => prev.filter(w => w.id !== workflowId));
    } catch (e) {
      setSdProbe({ state: 'error', message: `Suppression échouée : ${e}` });
    }
  }

  return (
    <section id="comfyui" className={className} ref={sectionRef}>
      <div className="opts-card-title">Génération d'images IA — ComfyUI</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Activer la génération d'images IA</div>
          <div className="opts-row-sub">
            Ajoute un bouton ✨ Générer IA sous chaque image dans l'éditeur.
          </div>
        </div>
        <Toggle on={sdSettings?.aiImageGen} onChange={(v) => onUpdateSdSettings?.({ aiImageGen: v })} />
      </div>

      {sdSettings?.aiImageGen && (
        <div className="xtts-settings">
          <div className="xtts-grid">
            <label className="xtts-label">
              URL du serveur ComfyUI
              <input
                className="xtts-input"
                value={sdSettings?.serverUrl ?? ''}
                onChange={(e) => onUpdateSdSettings?.({ serverUrl: e.target.value })}
                placeholder="http://127.0.0.1:8188"
              />
            </label>
            <label className="xtts-label">
              Fichier de démarrage (.bat)
              <input
                className="xtts-input"
                value={sdSettings?.batPath ?? ''}
                onChange={(e) => onUpdateSdSettings?.({ batPath: e.target.value })}
                placeholder="C:\chemin\vers\start_comfyui.bat"
              />
            </label>
          </div>

          <div className="opts-row opts-row--pt">
            <div className="opts-row-info">
              <div className="opts-row-label">Démarrer ComfyUI automatiquement</div>
              <div className="opts-row-sub">
                Lance le fichier .bat si ComfyUI ne répond pas au moment de générer.
              </div>
            </div>
            <Toggle on={sdSettings?.autoStart} onChange={(v) => onUpdateSdSettings?.({ autoStart: v })} />
          </div>

          <div className="xtts-actions">
            <Button onClick={handleTestSd} disabled={sdProbe.state === 'loading'}>
              {sdProbe.state === 'loading'
                ? (sdSettings?.autoStart && sdSettings?.batPath ? 'Démarrage…' : 'Test en cours…')
                : 'Tester ComfyUI'}
            </Button>
          </div>

          {sdProbe.state !== 'idle' && (
            <div className={`info-box ${sdProbe.state === 'error' ? 'warn' : ''}`}>
              {sdProbe.message}
            </div>
          )}

          {/* Gestion des workflows */}
          <div className="sd-workflows-section">
            <div className="opts-row-label" style={{ marginBottom: 8 }}>Workflows disponibles</div>
            {sdWorkflows.length === 0 ? (
              <div className="opts-row-sub">Aucun workflow chargé.</div>
            ) : (
              <div className="sd-workflow-list">
                {sdWorkflows.map(wf => (
                  <div key={wf.id} className="sd-workflow-item">
                    <div>
                      <span className="sd-workflow-item-name">{wf.name}</span>
                      {!wf.isCustom && <span className="sd-workflow-item-tag">intégré</span>}
                    </div>
                    {wf.isCustom && (
                      <Button
                        size="sm"
                        onClick={() => handleDeleteWorkflow(wf.id)}
                      >
                        Supprimer
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="sd-import-section">
              <div className="opts-row-label" style={{ marginBottom: 6 }}>Importer un workflow custom</div>
              <div className="sd-import-row">
                <Button size="sm" onClick={handlePickApiJson}>
                  {importApiPath ? '✓ API JSON' : 'Choisir *-api.json…'}
                </Button>
                <Button size="sm" onClick={handlePickConfigJson}>
                  {importConfigPath ? '✓ Config JSON' : 'Choisir *.config.json…'}
                </Button>
                <Button
                  size="sm"
                  variant="primary-violet"
                  onClick={handleImportWorkflow}
                  disabled={!importApiPath || !importConfigPath || importing}
                >
                  {importing ? 'Import…' : 'Importer'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
