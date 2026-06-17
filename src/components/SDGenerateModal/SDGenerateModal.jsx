import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pickSdReferenceImage } from '../../hooks/useFileDialog';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { Dices } from '../icons/LucideLocal';
import { basename } from '../../utils/fileUtils';
import './SDGenerateModal.css';

function randomSeed() {
  return Math.floor(Math.random() * 0xFFFFFFFF);
}

const DEFAULT_PARAMS = {
  positivePrompt: 'lunii_style, simple illustration, black and white line art, grayscale, children book style, ',
  negativePrompt: 'color, photo, realistic, watermark, text',
  seed: randomSeed(),
  steps: 20,
  cfg: 2.5,
  loraStrength: 0.85,
};

export function SDGenerateModal({
  sdSettings,
  onGenerate,
  onClose,
  currentImagePath = null,
  currentImageLabel = null,
  rootImagePath = null,
  initialJob = null,
}) {
  const [workflows, setWorkflows] = useState([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [referenceImagePath, setReferenceImagePath] = useState(null);
  const [useCurrentImageAsReference, setUseCurrentImageAsReference] = useState(false);
  const [useRootImageAsReference, setUseRootImageAsReference] = useState(false);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [variants, setVariants] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    invoke('comfyui_list_workflows')
      .then(wfs => {
        setWorkflows(wfs);
        const initialWorkflow = initialJob
          ? wfs.find(wf => wf.id === initialJob.workflowId)
          : null;
        const nextWorkflow = initialWorkflow || wfs[0] || null;
        if (nextWorkflow) {
          setSelectedId(nextWorkflow.id);
          if (initialJob?.params) {
            setParams({
              ...DEFAULT_PARAMS,
              ...initialJob.params,
              seed: randomSeed(),
              referenceImagePath: undefined,
            });
            setReferenceImagePath(initialJob.params.referenceImagePath || null);
          } else {
            applyWorkflowDefaults(nextWorkflow);
          }
        }
        if (initialJob && !initialWorkflow) {
          setError('Le workflow utilisé par cette génération n’est plus disponible.');
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoadingWorkflows(false));
  // reason: chargement one-shot des workflows ComfyUI au montage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setUseCurrentImageAsReference(false);
    setUseRootImageAsReference(false);
    setReferenceImagePath(null);
  }, [currentImagePath]);

  useEscapeKey(true, () => {
    if (!submitting) onClose?.();
  });

  const selected = workflows.find(w => w.id === selectedId) || null;
  const hasNegativeSlot = selected && 'negative_prompt' in selected.slots;
  const hasSeedSlot = selected && 'seed' in selected.slots;
  const hasStepsSlot = selected && 'steps' in selected.slots;
  const hasCfgSlot = selected && ('cfg' in selected.slots || 'guidance' in selected.slots);
  const hasLoraSlot = selected && ('lora_strength_model' in selected.slots || 'lora_strength_clip' in selected.slots);
  const canUseCurrentImage = !!currentImagePath;
  const canUseRootImage = !!rootImagePath && rootImagePath !== currentImagePath;
  const effectiveReferenceImagePath = useCurrentImageAsReference
    ? currentImagePath
    : useRootImageAsReference
      ? rootImagePath
      : referenceImagePath;

  function applyWorkflowDefaults(wf) {
    const dv = wf?.defaultValues;
    if (!dv) return;
    setParams(p => ({
      ...p,
      ...(dv.positive_prompt !== undefined && { positivePrompt: dv.positive_prompt }),
      ...(dv.negative_prompt !== undefined && { negativePrompt: dv.negative_prompt }),
      // seed intentionally NOT applied from defaults — always keep it random
      ...(dv.steps !== undefined && { steps: Number(dv.steps) || p.steps }),
      ...(dv.cfg !== undefined && { cfg: parseFloat(dv.cfg) || p.cfg }),
      ...(dv.lora_strength_model !== undefined && { loraStrength: parseFloat(dv.lora_strength_model) || p.loraStrength }),
    }));
  }

  function handleWorkflowSelect(id) {
    setParams(p => ({ ...p, seed: randomSeed() }));
    applyWorkflowDefaults(workflows.find(w => w.id === id));
    setSelectedId(id);
    setReferenceImagePath(null);
    setError(null);
  }

  async function handlePickReference() {
    const path = await pickSdReferenceImage();
    if (path) setReferenceImagePath(path);
  }

  async function handleSubmit() {
    if (!selected) return;
    if (selected.requiresReferenceImage && !effectiveReferenceImagePath) {
      setError('Une image de référence est requise pour ce workflow.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      for (let i = 0; i < variants; i++) {
        onGenerate(selected.id, selected.name, {
          positivePrompt: params.positivePrompt,
          negativePrompt: params.negativePrompt,
          seed: params.seed + i,
          steps: params.steps,
          cfg: params.cfg,
          loraStrength: params.loraStrength,
          referenceImagePath: effectiveReferenceImagePath || null,
        });
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  const refName = effectiveReferenceImagePath
    ? basename(effectiveReferenceImagePath)
    : null;

  return (
    <div className="modal-overlay">
      <div className="modal-box sd-generate-box">
        <div className="modal-header">
          <span>Générer une image avec ComfyUI</span>
          <Button variant="icon" className="modal-close" onClick={onClose}>✕</Button>
        </div>

        <div className="sd-generate-body">
          {/* Sélecteur de workflow */}
          <div className="sd-section-label">Workflow</div>
          {loadingWorkflows ? (
            <div className="sd-loading">Chargement des workflows…</div>
          ) : workflows.length === 0 ? (
            <div className="sd-empty">Aucun workflow disponible.</div>
          ) : (
            <div className="sd-workflow-cards">
              {workflows.map(wf => (
                <button
                  key={wf.id}
                  className={`sd-workflow-card ${selectedId === wf.id ? 'selected' : ''}`}
                  onClick={() => handleWorkflowSelect(wf.id)}
                >
                  <div className="sd-workflow-name">{wf.name}</div>
                  <div className="sd-workflow-desc">{wf.description}</div>
                  {wf.requiresReferenceImage && (
                    <div className="sd-workflow-tag">Image requise</div>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Image de référence */}
          {selected?.requiresReferenceImage && (
            <div className="sd-field">
              <div className="sd-section-label">Image de référence</div>
              {canUseRootImage && (
                <label className="sd-ref-toggle">
                  <input
                    type="checkbox"
                    checked={useRootImageAsReference}
                    onChange={e => {
                      setUseRootImageAsReference(e.target.checked);
                      if (e.target.checked) { setUseCurrentImageAsReference(false); setReferenceImagePath(null); }
                    }}
                  />
                  <span>Utiliser l'image de couverture du menu racine</span>
                </label>
              )}
              {canUseCurrentImage && (
                <label className="sd-ref-toggle">
                  <input
                    type="checkbox"
                    checked={useCurrentImageAsReference}
                    onChange={e => {
                      setUseCurrentImageAsReference(e.target.checked);
                      if (e.target.checked) { setUseRootImageAsReference(false); setReferenceImagePath(null); }
                    }}
                  />
                  <span>Utiliser l'image déjà présente dans {currentImageLabel || 'ce champ'}</span>
                </label>
              )}
              <div className="sd-ref-row">
                <Button
                  size="sm"
                  variant="secondary-violet"
                  onClick={handlePickReference}
                  disabled={useCurrentImageAsReference || useRootImageAsReference}
                >
                  Choisir une image…
                </Button>
                {refName && <span className="sd-ref-name">{refName}</span>}
              </div>
            </div>
          )}

          {/* Prompt positif */}
          <div className="sd-field">
            <div className="sd-section-label">Prompt</div>
            <textarea
              className="sd-textarea"
              value={params.positivePrompt}
              onChange={e => setParams(p => ({ ...p, positivePrompt: e.target.value }))}
              rows={7}
              placeholder="lunii_style, simple illustration…"
            />
          </div>

          {/* Prompt négatif */}
          {hasNegativeSlot && (
            <div className="sd-field">
              <div className="sd-section-label">Prompt négatif</div>
              <textarea
                className="sd-textarea"
                value={params.negativePrompt}
                onChange={e => setParams(p => ({ ...p, negativePrompt: e.target.value }))}
                rows={3}
                placeholder="color, photo, realistic…"
              />
            </div>
          )}

          {/* Variantes */}
          <div className="sd-field sd-variants-row">
            <div className="sd-section-label">Variantes</div>
            <div className="sd-variants-toggle">
              {[1, 2].map(n => (
                <Button
                  key={n}
                  size="sm"
                  variant={variants === n ? 'secondary-violet' : 'secondary'}
                  onClick={() => setVariants(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>

          {/* Section avancée */}
          {(hasSeedSlot || hasStepsSlot || hasCfgSlot || hasLoraSlot) && (
            <div className="sd-advanced">
              <button
                className="sd-advanced-toggle"
                onClick={() => setShowAdvanced(v => !v)}
              >
                {showAdvanced ? '▾' : '▸'} Paramètres avancés
              </button>
              {showAdvanced && (
                <div className="sd-advanced-body">
                  {hasSeedSlot && (
                    <div className="sd-param-row">
                      <label className="sd-param-label">Seed</label>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="number"
                          className="sd-seed-input"
                          value={params.seed}
                          onChange={e => setParams(p => ({ ...p, seed: parseInt(e.target.value, 10) || 0 }))}
                        />
                        <Tooltip text="Seed aléatoire">
                          <Button
                            size="sm"
                            variant="secondary-violet"
                            onClick={() => setParams(p => ({ ...p, seed: randomSeed() }))}
                          ><Dices style={{ width: 12, height: 12, verticalAlign: '-2px' }} /></Button>
                        </Tooltip>
                      </div>
                    </div>
                  )}
                  {hasStepsSlot && (
                    <div className="sd-param-row">
                      <label className="sd-param-label">Steps <span className="sd-param-value">{params.steps}</span></label>
                      <input
                        type="range" min={1} max={50}
                        value={params.steps}
                        onChange={e => setParams(p => ({ ...p, steps: parseInt(e.target.value) }))}
                        className="sd-slider"
                      />
                    </div>
                  )}
                  {hasCfgSlot && (
                    <div className="sd-param-row">
                      <label className="sd-param-label">CFG <span className="sd-param-value">{params.cfg.toFixed(1)}</span></label>
                      <input
                        type="range" min={0.1} max={20} step={0.1}
                        value={params.cfg}
                        onChange={e => setParams(p => ({ ...p, cfg: parseFloat(e.target.value) }))}
                        className="sd-slider"
                      />
                    </div>
                  )}
                  {hasLoraSlot && (
                    <div className="sd-param-row">
                      <label className="sd-param-label">LoRA <span className="sd-param-value">{params.loraStrength.toFixed(2)}</span></label>
                      <input
                        type="range" min={0} max={2} step={0.05}
                        value={params.loraStrength}
                        onChange={e => setParams(p => ({ ...p, loraStrength: parseFloat(e.target.value) }))}
                        className="sd-slider"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <div className="sd-error">{error}</div>}
        </div>

        <div className="modal-footer">
          <Button size="sm" onClick={onClose} disabled={submitting}>
            Annuler
          </Button>
          <Button
            variant="primary-violet"
            onClick={handleSubmit}
            disabled={submitting || !selected || loadingWorkflows}
          >
            {submitting ? 'Envoi…' : `Générer${variants > 1 ? ` ×${variants}` : ''}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
