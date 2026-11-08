import { TreeText, useTreeTranslation } from "../../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../../i18n/treePresentation.js";
import { AudioField } from '../AudioField';
import { ImageField } from '../ImageField';
import { useErrorDialog } from '../../common/Dialog';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import { Button } from '../../common/Button';
import { MoveDown, MoveUp, Trash2 } from '../../icons/LucideLocal';
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
  packStartReturnLabel = t("tree:navigation.start.return"),
  onUpdate,
}) {
  useTreeTranslation();
  const { showConfirmDialog } = useErrorDialog();

  function updateSequence(nextSteps) {
    onUpdate({ afterPlaybackSequence: nextSteps });
  }

  function updateStep(index, fields) {
    updateSequence(steps.map((s, i) => i === index ? { ...s, ...fields } : s));
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
      title: <TreeText messageKey="tree:story.delete.confirmTitle" />,
      message: { key: "tree:story.sequence.confirmDelete", params: { name: step.name || { key: "tree:story.sequence.stepName", params: { number: index + 1 } } } },
      okLabel: <TreeText messageKey="common:dialog.delete.label" />,
      okKind: 'danger',
    });
    if (!confirmed) return;
    updateSequence(steps.filter((_, i) => i !== index));
  }

  function addStep() {
    updateSequence([
      ...steps,
      normalizeSequenceStep({
        name: t("tree:story.sequence.stepName", { number: steps.length + 1 }),
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
          name: t("tree:story.home.creationName"),
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
                  placeholder={t("tree:story.sequence.stepName", { number: index + 1 })}
                />
                <div className="sequence-step-actions">
                  <Tooltip text={t("tree:story.sequence.moveUp")}>
                    <Button
                      size="sm"
                      className="sequence-icon-btn"
                      disabled={index === 0}
                      onClick={() => moveStep(index, -1)}
                    >
                      <MoveUp className="sequence-icon" />
                    </Button>
                  </Tooltip>
                  <Tooltip text={t("tree:story.sequence.moveDown")}>
                    <Button
                      size="sm"
                      className="sequence-icon-btn"
                      disabled={isLast}
                      onClick={() => moveStep(index, 1)}
                    >
                      <MoveDown className="sequence-icon" />
                    </Button>
                  </Tooltip>
                  <Tooltip text={t("tree:story.sequence.deleteStep")}>
                    <Button
                      size="sm"
                      className="sequence-icon-btn sequence-icon-btn--danger"
                      onClick={() => deleteStep(index)}
                    >
                      <Trash2 className="sequence-icon" />
                    </Button>
                  </Tooltip>
                </div>
              </div>

              <AudioField
                levelLabel={{ entry: node.name, step: step.name }}
                label={t("tree:story.sequence.audioLabel", { number: index + 1 })}
                labelRef={{ key: "tree:story.sequence.audioLabel", params: { number: index + 1 } }}
                file={step.audio}
                ttsTextSuggestion={step.name || node.name || ''}
                // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
                ttsFilenameHint={`fin-${index + 1}-${node.name || 'histoire'}`}
                xttsTarget={{ kind: 'storySequence', entryId: node.id, stepId: step.id, field: 'audio' }}
                onPick={(file) => updateStep(index, { audio: file })}
                onClear={() => updateStep(index, { audio: null })}
              />

              <div className="sequence-controls">
                {CONTROL_DEFS.map(({ key, label, def }) => (
                  <label key={key} className="sequence-control sequence-control--toggle-left">
                    <Toggle
                      on={controls[key] ?? def}
                      onChange={(v) => updateStepControls(index, key, v)}
                    />
                    <span className="sequence-control-title">{t(label)}</span>
                  </label>
                ))}
              </div>

              <div className="sequence-targets">
                {isLast ? (
                  <>
                    <div className="sequence-destination-row">
                      <div className="sequence-destination-copy">
                        <span className="sequence-destination-title">{t("tree:story.sequence.destination")}</span>
                      </div>
                      <NavigationTargetSelect
                        value={step.okTarget ?? ''}
                        onChange={(value) => updateStep(index, { okTarget: value })}
                        allMenus={allMenus}
                        allStories={allStories}
                        currentStoryId={node.id}
                        emptyLabel={t("tree:story.destination.inherited")}
                      />
                    </div>
                    {continuationMenu ? (
                      <div className="sequence-note">
                        {t("tree:story.sequence.continuation", { name: continuationMenu.name || t("tree:story.sequence.continuationFallback"), source: continuationMenu.importedContinuation?.sourceStoryName ? t("tree:story.sequence.source", { name: continuationMenu.importedContinuation.sourceStoryName }) : "" })}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="sequence-next-note">{t("tree:story.sequence.okDescription")}</div>
                )}
                <div className="sequence-destination-row">
                  <div className="sequence-destination-copy">
                    <span className="sequence-destination-title">{t("tree:story.home.destination")}</span>
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
                    noneLabel={packStartReturnLabel}
                    emptyLabel={t("tree:story.destination.inherited")}
                    includeStoryPlay={false}
                  />
                </div>
                <label className="sequence-control sequence-control--toggle-left">
                  <Toggle
                    on={!!step.homeFollowsOk}
                    onChange={(v) => updateStep(index, {
                      homeFollowsOk: v,
                      homeNone: false,
                      homeTarget: v ? null : step.homeTarget,
                    })}
                  />
                  <span className="sequence-control-title">{t("tree:story.home.sameAsOk")}</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sequence-footer">
        <Button onClick={addStep}>{t("tree:story.sequence.addStep")}</Button>
      </div>

      {/* Réaction au bouton Accueil (afterPlaybackHomeStep) */}
      <div className="end-summary" style={{ marginTop: 12 }}>
        <div>
          <div className="end-summary-title">{t("tree:story.home.reaction")}</div>
          <div className="end-summary-copy">{t("tree:story.home.description")}</div>
          {homeStep && node.controlSettings?.home === false && (
            <div className="end-summary-copy">{t("tree:story.home.disabledDescription")}</div>
          )}
        </div>
        {homeStep ? (
          <Tooltip text={t("tree:story.home.remove")}>
            <button
              type="button"
              className="story-prompt-trash"
              onClick={() => onUpdate({ afterPlaybackHomeStep: null })}
              aria-label={t("tree:story.home.remove")}
            >
              <Trash2 className="card-danger-icon" />
            </button>
          </Tooltip>
        ) : (
          <Button size="sm" onClick={() => updateHomeStep({})}>{t("tree:story.home.add")}</Button>
        )}
      </div>

      {homeStep ? (
        <div className="sequence-step" style={{ marginTop: 10 }}>
          <div className="sequence-step-head">
            <div className="sequence-step-index">⏸</div>
            <input
              className="field-input sequence-step-name"
              value={homeStep.name || ''}
              onChange={(e) => updateHomeStep({ name: e.target.value })}
              placeholder={t("tree:story.home.reaction")}
            />
          </div>
          <AudioField
            levelLabel={{ entry: node.name, step: homeStep.name }}
            label={t("tree:story.home.audioLabel")}
            labelRef={{ key: "tree:story.home.audioLabel" }}
            file={homeStep.audio}
            ttsTextSuggestion={homeStep.name || node.name || ''}
            // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
            ttsFilenameHint={`attente-${node.name || 'histoire'}`}
            xttsTarget={{ kind: 'storyHomeStep', entryId: node.id, field: 'audio' }}
            onPick={(file) => updateHomeStep({ audio: file })}
            onClear={() => updateHomeStep({ audio: null })}
          />
          <ImageField
            fieldId={`${node.id}:homeStep:image`}
            label={{ key: "tree:story.home.imageLabel" }}
            file={homeStep.image}
            onPick={(file) => updateHomeStep({ image: file })}
            onClear={() => updateHomeStep({ image: null })}
          />
          <div className="sequence-controls">
            {CONTROL_DEFS.map(({ key, label, def }) => (
              <label key={key} className="sequence-control sequence-control--toggle-left">
                <Toggle
                  on={homeStep.controlSettings?.[key] ?? def}
                  onChange={(v) => updateHomeStepControls(key, v)}
                />
                <span className="sequence-control-title">{t(label)}</span>
              </label>
            ))}
          </div>
          <div className="sequence-destination-row">
            <div className="sequence-destination-copy">
              <span className="sequence-destination-title">{t("tree:story.home.destination")}</span>
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
              noneLabel={packStartReturnLabel}
              emptyLabel={t("tree:story.destination.inherited")}
              includeStoryPlay={false}
            />
          </div>
          <label className="sequence-control sequence-control--toggle-left" style={{ marginTop: 8 }}>
            <Toggle
              on={!!homeStep.homeFollowsOk}
              onChange={(v) => updateHomeStep({
                homeFollowsOk: v,
                homeNone: false,
                homeTarget: v ? null : homeStep.homeTarget,
              })}
            />
            <span className="sequence-control-title">{t("tree:story.home.sameAsOk")}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
