import { AudioField } from '../AudioField';
import { ImageField } from '../ImageField';
import { useErrorDialog } from '../../common/Dialog';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import {
  CONTROL_DEFS,
  SEQUENCE_CONTROL_DEFAULTS,
  NavigationTargetSelect,
  normalizeSequenceStep,
  resolveNavigationTargetId,
} from './storyUtils';

export function EndSequenceEditor({
  node,
  parentMenuId,
  steps,
  homeStep,
  allMenus,
  allStories,
  onUpdate,
}) {
  const { showConfirmDialog } = useErrorDialog();

  function updateSequence(nextSteps) {
    onUpdate({ afterPlaybackSequence: nextSteps.map((s, i) => normalizeSequenceStep(s, i)) });
  }

  function updateStep(index, fields) {
    updateSequence(steps.map((s, i) => i === index ? normalizeSequenceStep({ ...s, ...fields }, i) : s));
  }

  function updateStepControls(index, key, value) {
    const step = steps[index];
    if (!step) return;
    updateStep(index, {
      controlSettings: { ...SEQUENCE_CONTROL_DEFAULTS, ...(step.controlSettings ?? {}), [key]: value },
    });
  }

  function moveStep(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [step] = next.splice(index, 1);
    next.splice(target, 0, step);
    updateSequence(next);
  }

  async function deleteStep(index) {
    const step = steps[index];
    if (!step) return;
    const confirmed = await showConfirmDialog({
      title: 'Confirmer la suppression',
      message: `Supprimer l'étape "${step.name || `Étape ${index + 1}`}" ?`,
      okLabel: 'Supprimer',
    });
    if (!confirmed) return;
    updateSequence(steps.filter((_, i) => i !== index));
  }

  function addStep() {
    updateSequence([
      ...steps,
      normalizeSequenceStep({
        name: `Étape ${steps.length + 1}`,
        controlSettings: {
          ...SEQUENCE_CONTROL_DEFAULTS,
          autoplay: steps.length === 0,
          ok: true,
        },
      }, steps.length),
    ]);
  }

  function updateHomeStep(fields) {
    onUpdate({
      afterPlaybackHomeStep: normalizeSequenceStep({
        ...(homeStep ?? {
          name: "Écran d'attente",
          controlSettings: { ...SEQUENCE_CONTROL_DEFAULTS, ok: true },
        }),
        ...fields,
      }, 0),
    });
  }

  function updateHomeStepControls(key, value) {
    updateHomeStep({
      controlSettings: {
        ...SEQUENCE_CONTROL_DEFAULTS,
        ...(homeStep?.controlSettings ?? {}),
        [key]: value,
      },
    });
  }

  return (
    <div>
      <div className="sequence-list">
        {steps.map((step, index) => {
          const controls = { ...SEQUENCE_CONTROL_DEFAULTS, ...(step.controlSettings ?? {}) };
          const isLast = index === steps.length - 1;
          const homeSelectValue = step.homeNone ? '__none__' : (step.homeTarget ?? '');
          const okTargetId = resolveNavigationTargetId(step.okTarget, parentMenuId ?? null);
          const continuationMenu = isLast
            ? allMenus.find((m) => m.id === okTargetId && m.importedContinuation)
            : null;

          return (
            <div className="sequence-step" key={step.id}>
              <div className="sequence-step-head">
                <div className="sequence-step-index">{index + 1}</div>
                <input
                  className="field-input sequence-step-name"
                  value={step.name || ''}
                  onChange={(e) => updateStep(index, { name: e.target.value })}
                  placeholder={`Étape ${index + 1}`}
                />
                <div className="sequence-step-actions">
                  <Tooltip text="Monter">
                    <button
                      type="button"
                      className="btn-xs sequence-icon-btn"
                      disabled={index === 0}
                      onClick={() => moveStep(index, -1)}
                    >↑</button>
                  </Tooltip>
                  <Tooltip text="Descendre">
                    <button
                      type="button"
                      className="btn-xs sequence-icon-btn"
                      disabled={isLast}
                      onClick={() => moveStep(index, 1)}
                    >↓</button>
                  </Tooltip>
                  <Tooltip text="Supprimer cette étape">
                    <button
                      type="button"
                      className="btn-xs sequence-icon-btn sequence-icon-btn--danger"
                      onClick={() => deleteStep(index)}
                    >×</button>
                  </Tooltip>
                </div>
              </div>

              <AudioField
                accentLabel
                label={`Audio — étape ${index + 1}`}
                file={step.audio}
                ttsTextSuggestion={step.name || node.name || ''}
                ttsFilenameHint={`fin-${index + 1}-${node.name || 'histoire'}`}
                xttsTarget={{ kind: 'storySequence', entryId: node.id, stepId: step.id, field: 'audio' }}
                onPick={(file) => updateStep(index, { audio: file })}
                onClear={() => updateStep(index, { audio: null })}
              />

              <div className="sequence-controls">
                {CONTROL_DEFS.map(({ key, label, def }) => (
                  <label key={key} className="sequence-control">
                    <span>{label}</span>
                    <Toggle
                      on={controls[key] ?? def}
                      onChange={(v) => updateStepControls(index, key, v)}
                    />
                  </label>
                ))}
              </div>

              <div className="sequence-targets">
                {isLast ? (
                  <>
                    <div className="field-row" style={{ marginBottom: 0 }}>
                      <div style={{ flex: 1 }}>
                        <span className="field-label">Bouton OK (dernière étape)</span>
                        <div className="sequence-help">
                          Choisir l'option « Lecture directe » d'une histoire pour la lancer sans rejouer son audio de sélection.
                        </div>
                      </div>
                      <NavigationTargetSelect
                        value={step.okTarget ?? ''}
                        onChange={(value) => updateStep(index, { okTarget: value })}
                        allMenus={allMenus}
                        allStories={allStories}
                        currentStoryId={node.id}
                        emptyLabel="Même destination que la fin d'histoire"
                      />
                    </div>
                    {continuationMenu ? (
                      <div className="sequence-note">
                        Cette étape mène vers la continuation importée "{continuationMenu.name || 'Suite'}"
                        {continuationMenu.importedContinuation?.sourceStoryName
                          ? ` depuis ${continuationMenu.importedContinuation.sourceStoryName}`
                          : ''}.
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="sequence-next-note">Bouton OK enchaîne vers l'étape suivante.</div>
                )}
                <div className="field-row" style={{ marginBottom: 0 }}>
                  <div style={{ flex: 1 }}>
                    <span className="field-label">Bouton Accueil</span>
                    <div className="sequence-help">Suit la destination de fin d'histoire si rien n'est choisi ici.</div>
                  </div>
                  <NavigationTargetSelect
                    value={homeSelectValue}
                    onChange={(value) => {
                      if (value === '__none__') {
                        updateStep(index, { homeNone: true, homeTarget: null, homeFollowsOk: false });
                      } else {
                        updateStep(index, { homeNone: false, homeTarget: value, homeFollowsOk: false });
                      }
                    }}
                    allMenus={allMenus}
                    allStories={allStories}
                    currentStoryId={node.id}
                    includeNone
                    emptyLabel="Même destination que l'histoire"
                  />
                </div>
                <label className="sequence-control" style={{ justifyContent: 'flex-end' }}>
                  <span>Accueil vers la même destination que OK</span>
                  <Toggle
                    on={!!step.homeFollowsOk}
                    onChange={(v) => updateStep(index, {
                      homeFollowsOk: v,
                      homeNone: false,
                      homeTarget: v ? null : step.homeTarget,
                    })}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sequence-footer">
        <button type="button" className="btn btn-primary" onClick={addStep}>
          Ajouter une étape
        </button>
      </div>

      {/* Réaction au bouton Accueil (afterPlaybackHomeStep) */}
      <div className="end-summary" style={{ marginTop: 12 }}>
        <div>
          <div className="end-summary-title">Réaction au bouton Accueil</div>
          <div className="end-summary-copy">
            Étape jouée si l'enfant appuie sur le bouton Accueil pendant l'histoire, avant qu'elle ne se termine.
          </div>
        </div>
        <button
          type="button"
          className="btn-xs"
          onClick={() => homeStep
            ? onUpdate({ afterPlaybackHomeStep: null })
            : updateHomeStep({})}
        >
          {homeStep ? 'Retirer' : 'Ajouter'}
        </button>
      </div>

      {homeStep ? (
        <div className="sequence-step" style={{ marginTop: 10 }}>
          <div className="sequence-step-head">
            <div className="sequence-step-index">⏸</div>
            <input
              className="field-input sequence-step-name"
              value={homeStep.name || ''}
              onChange={(e) => updateHomeStep({ name: e.target.value })}
              placeholder="Réaction au bouton Accueil"
            />
          </div>
          <AudioField
            accentLabel
            label="Audio joué quand l'enfant appuie sur Accueil"
            file={homeStep.audio}
            ttsTextSuggestion={homeStep.name || node.name || ''}
            ttsFilenameHint={`attente-${node.name || 'histoire'}`}
            xttsTarget={{ kind: 'storyHomeStep', entryId: node.id, field: 'audio' }}
            onPick={(file) => updateHomeStep({ audio: file })}
            onClear={() => updateHomeStep({ audio: null })}
          />
          <ImageField
            accentLabel
            fieldId={`${node.id}:homeStep:image`}
            label="Image affichée pendant la réaction Accueil"
            file={homeStep.image}
            onPick={(file) => updateHomeStep({ image: file })}
            onClear={() => updateHomeStep({ image: null })}
          />
          <div className="sequence-controls">
            {CONTROL_DEFS.map(({ key, label, def }) => (
              <label key={key} className="sequence-control">
                <span>{label}</span>
                <Toggle
                  on={homeStep.controlSettings?.[key] ?? def}
                  onChange={(v) => updateHomeStepControls(key, v)}
                />
              </label>
            ))}
          </div>
          <div className="field-row" style={{ marginBottom: 0 }}>
            <div style={{ flex: 1 }}>
              <span className="field-label">Bouton Accueil</span>
            </div>
            <NavigationTargetSelect
              value={homeStep.homeNone ? '__none__' : (homeStep.homeTarget ?? '')}
              onChange={(value) => {
                if (value === '__none__') {
                  updateHomeStep({ homeNone: true, homeTarget: null, homeFollowsOk: false });
                } else {
                  updateHomeStep({ homeNone: false, homeTarget: value, homeFollowsOk: false });
                }
              }}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              includeNone
              emptyLabel="Même destination que l'histoire"
            />
          </div>
          <label className="sequence-control" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <span>Accueil vers la même destination que OK</span>
            <Toggle
              on={!!homeStep.homeFollowsOk}
              onChange={(v) => updateHomeStep({
                homeFollowsOk: v,
                homeNone: false,
                homeTarget: v ? null : homeStep.homeTarget,
              })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
