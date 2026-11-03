import { Trans } from 'react-i18next';
import { useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../i18n/treePresentation.js";
import { memo, useEffect, useMemo, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
const CONTROL_LABELS = {"wheel": "tree:nativeGraph.control.wheel", "autoplay": "tree:nativeGraph.control.autoplay", "pause": "tree:nativeGraph.control.pause", "ok": "tree:nativeGraph.control.ok", "home": "tree:nativeGraph.control.home"};
import { Toggle } from '../common/Toggle';
import { basename } from '../../utils/fileUtils';
import { optionSelectionCandidates, parseOptionSelection } from '../../store/optionSelection.js';

function cloneGraph(graph) {
  return structuredClone(graph);
}

function stageId(stage) {
  return stage?.uuid || stage?.id || '';
}

function stageKind(stage) {
  const controls = stage?.controlSettings ?? {};
  if (stage?.squareOne) return t("tree:nativeGraph.kind.start");
  if (controls.wheel && !controls.autoplay) return t("tree:nativeGraph.kind.choice");
  if (controls.autoplay) return t("tree:nativeGraph.kind.play");
  return t("tree:nativeGraph.kind.stage");
}

function stageLabel(stage, index) {
  const name = typeof stage?.name === 'string' ? stage.name.trim() : '';
  const audio = basename(stage?.audio);
  const suffix = stageId(stage).slice(0, 8);
  if (name && name !== 'Stage title') return name;
  if (audio) return audio.replace(/\.(mp3|ogg|wav|m4a)$/i, '');
  return t("tree:nativeGraph.stage.name", { kind: stageKind(stage), number: index + 1, suffix: suffix ? ` · ${suffix}` : "" });
}

// Les destinations qu'une transition peut atteindre.
//
// La vue les represente toutes et n'en choisit aucune : une selection aleatoire
// (`optionIndex = -1`) designe toutes les options de l'Action, et
// n'est jamais rabattue vers l'option 0. Sur une Action a plusieurs options, la
// roue permet de parcourir toutes les destinations, quelle que soit la selection
// initiale : elles restent donc toutes affichees.
function transitionTargets(transition, actionById) {
  const actionId = transition?.actionNode;
  if (!actionId) return [];
  const options = actionById.get(actionId)?.options ?? [];
  if (!Array.isArray(options) || options.length === 0) return [];
  if (options.length > 1) return options.filter(Boolean);
  const selection = parseOptionSelection(transition?.optionIndex);
  return optionSelectionCandidates(selection, options.length)
    .map((index) => options[index])
    .filter(Boolean);
}

function updateStageInGraph(graph, selectedStageId, updater) {
  const next = cloneGraph(graph);
  const stages = next?.document?.stageNodes ?? [];
  const index = stages.findIndex((stage) => stageId(stage) === selectedStageId);
  if (index < 0) return graph;
  stages[index] = updater(stages[index]);
  return next;
}

export const NativeGraphEditor = memo(function NativeGraphEditor({ graph, onChange }) {
  useTreeTranslation();
  const stages = graph?.document?.stageNodes ?? [];
  const actions = graph?.document?.actionNodes ?? [];
  const [filter, setFilter] = useState('');
  const [selectedStageId, setSelectedStageId] = useState(() => stageId(stages.find((stage) => stage.squareOne) ?? stages[0]));

  const actionById = useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions],
  );
  const stageById = useMemo(
    () => new Map(stages.map((stage, index) => [stageId(stage), { stage, index }])),
    [stages],
  );
  const orderedStages = useMemo(
    () => [...stages]
      .map((stage, index) => ({ stage, index, id: stageId(stage), label: stageLabel(stage, index) }))
      .sort((a, b) => {
        if (a.stage.squareOne) return -1;
        if (b.stage.squareOne) return 1;
        const ay = a.stage.position?.y ?? 0;
        const by = b.stage.position?.y ?? 0;
        if (ay !== by) return ay - by;
        return (a.stage.position?.x ?? 0) - (b.stage.position?.x ?? 0);
      }),
    [stages, t("tree:nativeGraph.kind.stage")],
  );
  const visibleStages = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return orderedStages;
    return orderedStages.filter(({ stage, label, id }) => (
      label.toLowerCase().includes(q)
      || id.toLowerCase().includes(q)
      || basename(stage.audio).toLowerCase().includes(q)
      || basename(stage.image).toLowerCase().includes(q)
    ));
  }, [filter, orderedStages]);

  useEffect(() => {
    if (!selectedStageId || !stageById.has(selectedStageId)) {
      setSelectedStageId(stageId(stages.find((stage) => stage.squareOne) ?? stages[0]));
    }
  }, [selectedStageId, stageById, stages]);

  const selectedInfo = stageById.get(selectedStageId) ?? null;
  const selectedStage = selectedInfo?.stage ?? null;
  const selectedIndex = selectedInfo?.index ?? 0;
  const selectedLabel = selectedStage ? stageLabel(selectedStage, selectedIndex) : '';
  const okTargets = selectedStage ? transitionTargets(selectedStage.okTransition, actionById) : [];
  const homeTargets = selectedStage ? transitionTargets(selectedStage.homeTransition, actionById) : [];

  function updateSelectedStage(patch) {
    if (!selectedStage) return;
    onChange(updateStageInGraph(graph, selectedStageId, (stage) => ({ ...stage, ...patch })));
  }

  function updateControl(key, value) {
    updateSelectedStage({
      controlSettings: {
        ...(selectedStage.controlSettings ?? {}),
        [key]: value,
      },
    });
  }

  function targetName(targetId) {
    const info = stageById.get(targetId);
    return info ? stageLabel(info.stage, info.index) : (targetId || t("tree:nativeGraph.destination.unknown"));
  }

  if (!graph || stages.length === 0) return null;

  return (
    <div className="native-graph-editor">
      <div className="native-graph-toolbar">
        <div className="native-graph-stat"><Trans t={t} i18nKey="tree:nativeGraph.count.stages" count={stages.length} components={{ strong: <strong />, unit: <span /> }} /></div>
        <div className="native-graph-stat"><Trans t={t} i18nKey="tree:nativeGraph.count.actions" count={actions.length} components={{ strong: <strong />, unit: <span /> }} /></div>
        <input
          className="field-input native-graph-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("tree:nativeGraph.filter.placeholder")}
        />
      </div>

      <div className="native-graph-layout">
        <div className="native-graph-list" role="listbox" aria-label={t("tree:nativeGraph.list.aria")}>
          {visibleStages.map(({ stage, index, id, label }) => (
            <button
              key={id}
              className={`native-graph-row ${id === selectedStageId ? 'is-selected' : ''}`}
              onClick={() => setSelectedStageId(id)}
              type="button"
            >
              <span className="native-graph-row-kind">{stageKind(stage)}</span>
              <span className="native-graph-row-main">{label}</span>
              <span className="native-graph-row-meta">#{index + 1}</span>
            </button>
          ))}
        </div>

        {selectedStage ? (
          <div className="native-graph-detail">
            <div className="field-row">
              <span className="field-label">{t("tree:zip.name.label")}</span>
              <input
                className="field-input"
                value={selectedStage.name || ''}
                onChange={(event) => updateSelectedStage({ name: event.target.value })}
                placeholder={selectedLabel}
              />
              <span className="native-graph-id">{stageId(selectedStage).slice(0, 8)}</span>
            </div>

            <div className="sequence-controls">
              {['wheel', 'autoplay', 'pause', 'ok', 'home'].map((key) => (
                <div className="sequence-control" key={key}>
                  <span>{t(CONTROL_LABELS[key])}</span>
                  <Toggle
                    on={!!selectedStage.controlSettings?.[key]}
                    onChange={(value) => updateControl(key, value)}
                  />
                </div>
              ))}
            </div>

            <div className="native-graph-media">
              <div>
                <div className="media-col-header">{t("tree:media.image.label")}<span className="media-col-subtitle">{t("tree:nativeGraph.image.label")}</span>
                </div>
                <ImageField
                  compact
                  fieldId={`stage:${stageId(selectedStage)}:image`}
                  file={selectedStage.image}
                  onPick={(file) => updateSelectedStage({ image: file })}
                  onClear={() => updateSelectedStage({ image: null })}
                />
              </div>
              <div>
                <div className="media-col-header">{t("tree:media.sound.label")}<span className="media-col-subtitle">{t("tree:nativeGraph.audio.label")}</span>
                </div>
                <AudioField
                  label={t("tree:nativeGraph.audio.label")}
                  labelRef={{ key: "tree:nativeGraph.audio.label" }}
                  file={selectedStage.audio}
                  required={false}
                  ttsTextSuggestion={selectedStage.name || selectedLabel}
                  ttsFilenameHint={`graphe-${selectedLabel || 'stage'}`}
                  onPick={(file) => updateSelectedStage({ audio: file })}
                  onClear={() => updateSelectedStage({ audio: null })}
                />
              </div>
            </div>

            <div className="native-graph-targets">
              <div className="native-graph-target-group">
                <span className="native-graph-target-title">{t("tree:control.ok.short")}</span>
                {okTargets.length > 0
                  ? okTargets.map((target) => <span className="native-graph-target" key={target}>{targetName(target)}</span>)
                  : <span className="native-graph-target is-empty">{t("tree:navigation.destination.none")}</span>}
              </div>
              <div className="native-graph-target-group">
                <span className="native-graph-target-title">{t("tree:control.home.short")}</span>
                {homeTargets.length > 0
                  ? homeTargets.map((target) => <span className="native-graph-target" key={target}>{targetName(target)}</span>)
                  : <span className="native-graph-target is-empty">{t("tree:navigation.destination.none")}</span>}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});
