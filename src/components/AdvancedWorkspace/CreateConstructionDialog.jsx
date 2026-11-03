import { useTranslation } from 'react-i18next';
import { translateGraph as t, graphTranslationEngine } from '../../i18n/graphPresentation.js';
import { useState } from 'react';
import { AdvancedDialog } from './AdvancedDialog.jsx';
import { NodePicker } from './NodePicker.jsx';
import { Button } from '../common/Button';
import { Toggle } from '../common/Toggle';
import { Select } from '../common/Select';
import { CreationControlGroups } from './NewStageDefaultsDialog.jsx';
import {
  buildConstructionGesture, CONSTRUCTION_LABELS, NARRATIVE_CONTROLS, CHOICE_CONTROLS,
} from '../../store/advancedAuthoring/constructions.js';

// Les interrupteurs et les libellés du panneau d'un Écran.
function ConstructionControls({ title, value, onChange }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  return (
    <fieldset className="advanced-field">
      <legend>{title}</legend>
      <CreationControlGroups
        renderControl={(key, label) => (
          <label key={key} className="sequence-control">
            <span>{label}</span>
            <Toggle
              on={value[key]}
              onChange={(next) => onChange({ ...value, [key]: next })}
              ariaLabel={label}
            />
          </label>
        )}
      />
    </fieldset>
  );
}

export function CreateConstructionDialog({ index, busy, onCancel, onConfirm }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [kind, setKind] = useState('scene');
  const [name, setName] = useState('');
  const [items, setItems] = useState([{ key: 0, name: '', targetPath: null }, { key: 1, name: '', targetPath: null }]);
  const [nextKey, setNextKey] = useState(2);
  const [controls, setControls] = useState({ ...NARRATIVE_CONTROLS });
  const [optionControls, setOptionControls] = useState({ ...CHOICE_CONTROLS });
  const [question, setQuestion] = useState(true);
  const [sourcePath, setSourcePath] = useState(null);
  const [destinationPath, setDestinationPath] = useState(null);
  const [trigger, setTrigger] = useState('autoplay');
  const setItem = (key, change) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item));
  const moveItem = (position, delta) => setItems((current) => {
    const next = [...current];
    [next[position], next[position + delta]] = [next[position + delta], next[position]];
    return next;
  });
  let gesture = null;
  let error = null;
  try {
    gesture = buildConstructionGesture(index, { kind, name, items, controls, optionControls, question, sourcePath, destinationPath, trigger });
  } catch (cause) { error = cause.message; }

  return (
    <AdvancedDialog
      title={t("graph:construction.derivedConstructions.label")}
      description={t("graph:construction.theseShortcutsCreateOrdinaryStagesAndChoiceListsThat.label")}
      busy={busy} onCancel={onCancel} onConfirm={() => onConfirm(gesture)}
      confirmLabel={{ scene: t("graph:construction.creerLaScene.label"), choice: t("graph:construction.creerLeChoix.label"), sequence: t("graph:construction.createSequence.label"), random: t("graph:construction.createRandomDraw.label") }[kind]}
      confirmDisabled={!gesture}
    >
      <fieldset disabled={busy} className="advanced-field">
        <label className="advanced-field__label" htmlFor="construction-kind">{t("graph:construction.construction.label")}</label>
        <Select
          id="construction-kind"
          value={kind}
          onChange={setKind}
          options={Object.entries(CONSTRUCTION_LABELS).map(([value, label]) => ({ value, label: t(label) }))}
        />
        {kind !== 'sequence' && (
          <>
            <label className="advanced-field__label" htmlFor="construction-name">{kind === 'choice' && question ? t('graph:construction.name.question') : t("graph:construction.nom.label")}</label>
            <input id="construction-name" value={name} onChange={(event) => setName(event.target.value)} />
          </>
        )}
        {kind === 'choice' && (
          <label className="advanced-controls__row">
            <span>{t("graph:construction.aQuestionStageBeforeTheAnswers.label")}</span>
            <input type="checkbox" checked={question} onChange={(event) => setQuestion(event.target.checked)} />
          </label>
        )}
        {kind !== 'scene' && (
          <fieldset className="advanced-field">
            <legend>{kind === 'choice' ? t('graph:construction.items.choices') : kind === 'sequence' ? t('graph:construction.items.passages') : t('graph:construction.items.destinations')}</legend>
            <ol className="advanced-options">
              {items.map((item, position) => (
                <li key={item.key} className="advanced-field">
                  <label className="advanced-field__label" htmlFor={`construction-item-${item.key}`}>{position + 1}. {kind === 'random' ? t("graph:construction.newStageNameIfNoExistingTarget.label") : t("graph:construction.nom.label")}</label>
                  <input id={`construction-item-${item.key}`} value={item.name} onChange={(event) => setItem(item.key, { name: event.target.value })} disabled={kind === 'random' && !!item.targetPath} />
                  {kind !== 'sequence' && (
                    <>
                      <label className="advanced-field__label" htmlFor={`construction-target-${item.key}`}>{kind === 'choice' ? t("graph:construction.afterConfirmingGoTo.label") : t("graph:construction.orReuseThisStage.label")}</label>
                      <NodePicker id={`construction-target-${item.key}`} index={index} kind="stage" forChoice value={item.targetPath}
                        onChange={(targetPath) => setItem(item.key, { targetPath })}
                        emptyLabel={kind === 'choice' ? t('graph:construction.destination.placeholder') : t("graph:construction.createANewStage.label")} />
                    </>
                  )}
                  <div className="advanced-dialog__footer">
                    <Button size="sm" disabled={position === 0} onClick={() => moveItem(position, -1)}>{t("graph:construction.monter.label")}</Button>
                    <Button size="sm" disabled={position === items.length - 1} onClick={() => moveItem(position, 1)}>{t("graph:construction.descendre.label")}</Button>
                    <Button size="sm" onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}>{t("graph:construction.retirer.label")}</Button>
                  </div>
                </li>
              ))}
            </ol>
            <Button size="sm" onClick={() => {
              setItems((current) => [...current, { key: nextKey, name: '', targetPath: null }]);
              setNextKey((current) => current + 1);
            }}>{kind === 'choice' ? t('graph:construction.items.addChoice') : kind === 'sequence' ? t('graph:construction.items.addPassage') : t('graph:construction.items.addDestination')}</Button>
          </fieldset>
        )}
        <fieldset className="advanced-field">
          <legend>{kind === 'choice' ? t('graph:construction.destination.commonTitle') : t('graph:construction.destination.title')}</legend>
          <label className="advanced-field__label" htmlFor="construction-destination">{t("graph:construction.finalDestination.label")}</label>
          <NodePicker id="construction-destination" index={index} kind="stage" forChoice value={destinationPath} onChange={setDestinationPath} emptyLabel={t("graph:construction.connectLater.label")} />
          <p className="advanced-field__note">{kind === 'random' ? t("graph:construction.thisContinuationOnlyAppliesToNewStagesReusedStages.label") : kind === 'sequence' ? t("graph:construction.onlyTheLastSceneReachesThisDestination.label") : t("graph:construction.withoutADestinationExitsStillNeedToBeConnected.label")}</p>
        </fieldset>
        {(kind !== 'choice' || question) && <ConstructionControls title={t("graph:construction.playbackStageButtons.label")} value={controls} onChange={setControls} />}
        {kind === 'choice' && <ConstructionControls title={t("graph:construction.choiceStageButtons.label")} value={optionControls} onChange={setOptionControls} />}
        <fieldset className="advanced-field">
          <legend>{kind === 'random' ? t('graph:construction.source.requiredTitle') : t('graph:construction.source.optionalTitle')}</legend>
          <label className="advanced-field__label" htmlFor="construction-source">{t("graph:construction.ecranDeDepart.label")}</label>
          <NodePicker id="construction-source" index={index} kind="stage" value={sourcePath} onChange={setSourcePath} emptyLabel={t("graph:construction.createWithoutAnIncomingLink.label")} />
          {sourcePath && (
            <>
              <label className="advanced-field__label" htmlFor="construction-trigger">{t("graph:construction.depuisCetEcran.label")}</label>
              <Select
                id="construction-trigger"
                value={trigger}
                onChange={setTrigger}
                options={[
                  { value: 'autoplay', label: t("graph:construction.continueThePathWhenAudioEnds.label") },
                  { value: 'ok', label: t("graph:construction.continueThePathWithTheOKButton.label") },
                  { value: 'home', label: t("graph:construction.boutonAccueil.label") },
                ]}
              />
              <p className="advanced-field__warning">
                {trigger === 'home' ? t('graph:construction.trigger.homeWarning') : trigger === 'ok' ? t('graph:construction.trigger.okWarning') : t('graph:construction.trigger.autoplayWarning')}
              </p>
              <p className="advanced-field__note">{kind === 'random' ? t("graph:construction.theTransitionWillDrawARandomChoiceEachTime.label") : t('graph:construction.connection.firstChoice')}</p>
            </>
          )}
        </fieldset>
        <p className="advanced-field__note">{t("graph:construction.imagesAndAudioCanBeAddedToEachStage.label")}</p>
        {error && <p className="advanced-field__note" role="status">{error}</p>}
      </fieldset>
    </AdvancedDialog>
  );
}
