import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { presence, action as makeAction } from './advancedViewFixtures.mjs';
import { graphSurfaceHarness } from './i18nGraphSurfaceHarness.mjs';
export async function editingHarness(originalSources = null) {
  const h = await graphSurfaceHarness({ originalSources });
  const noop = () => {};
  const stage = h.view.stages[0];
  const list = h.view.actions[0];
  const props = {
    NodeNameEditor: { kind: 'stage', node: stage, onGesture: noop },
    NodePicker: { index: h.index, kind: 'stage', onChange: noop },
    SquareOneRepairForm: { index: h.index, onGesture: noop, onClose: noop },
    LandingSelect: { id: 'landing', landing: { unknown: true }, choices: [{ key: 'a', rank: 0, label: null }, { key: 'b', rank: 1, label: '_AUTHOR_' }], onChange: noop },
    ActionSelectionFields: { id: 'selection', options: [{ optionId: 'a', target: {} }, { optionId: 'b', target: {} }], index: h.index, selection: '0', onChange: noop },
    ListenFromActionDialog: { inspected: h.index.byPath.get(list.path), index: h.index, onCancel: noop, onListen: noop },
    GraphLinkDialog: { index: h.index, intent: { sourcePath: stage.path, sourceKind: 'stage', slot: 'ok', activateControl: true, graphPoint: { x: 0, y: 0 } }, onCancel: noop, onConfirm: noop },
    ControlsCompletion: { stage, onGesture: noop },
    ControlRow: { stage, control: 'home', label: '_AUTHOR_LABEL_', onGesture: noop },
    GroupedControls: { renderControl: (key, label) => React.createElement('p', { key }, label) },
  };
  const cases = {};
  for (const [name, p] of Object.entries(props)) {
    const file = ['GroupedControls', 'ControlRow', 'ControlsCompletion'].includes(name) ? 'ControlsEditor' : name;
    const exports = await h.load(`src/components/AdvancedWorkspace/${file}.jsx`);
    cases[name] = [exports[name], p];
  }
  const { MediaSlotEditor } = await h.load('src/components/AdvancedWorkspace/MediaSlotEditor.jsx');
  // ImageField a besoin du contexte de projet ; le rendu du média complet reste couvert par les tests arbre.
  const { ProjectContext } = await h.load('src/store/ProjectContext.js');
  function MediaImage() { return React.createElement(ProjectContext.Provider, { value: { pathAudit: {}, workspaceDir: '', xttsSettings: {}, sdSettings: {}, sdJobs: [] } }, React.createElement(MediaSlotEditor, { stage, field: 'image', usage: new Map(), onGesture: noop })); }
  cases.MediaSlotEditor = [MediaImage, {}];
  const { ErrorDialogProvider } = await h.load('src/components/common/Dialog.jsx');
  const { buildGraphIndex, inspectNode } = await h.load('src/store/advancedGraphView/graphViewModel.js');
  const shared = { index: h.index, onCancel: noop, onConfirm: noop, onGesture: noop, onClose: noop, onDismiss: noop, onFocusPath: noop, thumbnails: new Map() };
  async function add(name, file, component, props) { const exports = await h.load(`src/components/AdvancedWorkspace/${file}.jsx`); cases[name] = [exports[component], props]; }
  cases.LandingMissing = [cases.LandingSelect[0], { ...props.LandingSelect, landing: { rank: 8, missing: true } }];
  cases.LandingRandom = [cases.LandingSelect[0], { ...props.LandingSelect, landing: { random: true } }];
  cases.SelectionRandom = [cases.ActionSelectionFields[0], { ...props.ActionSelectionFields, selection: 'random' }];
  const duplicateView = structuredClone(h.view); duplicateView.stages[1].uniqueId = false;
  const duplicateIndex = buildGraphIndex(duplicateView);
  cases.PickerDuplicate = [cases.NodePicker[0], { ...props.NodePicker, index: duplicateIndex, value: duplicateView.stages[1].path }];
  cases.ControlEnabled = [cases.ControlRow[0], { ...props.ControlRow, stage: { ...stage, controls: { home: presence(true) } } }];
  cases.ControlDisabled = [cases.ControlRow[0], { ...props.ControlRow, stage: { ...stage, controls: { home: presence(false) } } }];
  cases.ControlPartial = [cases.ControlsCompletion[0], { ...props.ControlsCompletion, stage: { ...stage, controls: { ...stage.controls, presence: 'value', complete: false } } }];
  cases.LinkFromList = [cases.GraphLinkDialog[0], { ...props.GraphLinkDialog, intent: { sourcePath: list.path, sourceKind: 'action', graphPoint: { x: 0, y: 0 }, missingOptionIndex: null } }];
  cases.LinkMissingChoice = [cases.GraphLinkDialog[0], { ...props.GraphLinkDialog, intent: { sourcePath: list.path, sourceKind: 'action', graphPoint: { x: 0, y: 0 }, missingOptionIndex: 1 } }];
  cases.LinkStale = [cases.GraphLinkDialog[0], { ...props.GraphLinkDialog, intent: { sourcePath: '_ABSENT_', sourceKind: 'stage', slot: 'home' } }];
  const emptyList = makeAction('_LIST_', []);
  const emptyView = { ...h.view, actions: [emptyList], edges: [] };
  const emptyIndex = buildGraphIndex(emptyView);
  cases.ListenEmpty = [cases.ListenFromActionDialog[0], { ...props.ListenFromActionDialog, index: emptyIndex, inspected: emptyIndex.byPath.get(emptyList.path) }];
  const brokenView = { ...h.view, edges: [{ kind: 'action-option', edgeId: '_EMPTY_', from: list.path, to: null, ordinal: 0 }, { kind: 'action-option', edgeId: '_DANGLING_', from: list.path, to: '_ABSENT_', ordinal: 1, dangling: true }] };
  cases.ListenMissing = [cases.ListenFromActionDialog[0], { ...props.ListenFromActionDialog, index: buildGraphIndex(brokenView) }];
  function MediaAudio() { return React.createElement(ProjectContext.Provider, { value: { pathAudit: {}, workspaceDir: '', xttsSettings: {}, sdSettings: {}, sdJobs: [] } }, React.createElement(MediaSlotEditor, { stage, field: 'audio', usage: new Map(), onGesture: noop })); }
  cases.MediaAudio = [MediaAudio, {}];
  await add('DeleteStage', 'DeleteNodeDialog', 'DeleteNodeDialog', { ...shared, kind: 'stage', path: h.view.stages[1].path });
  await add('DeleteAction', 'DeleteNodeDialog', 'DeleteNodeDialog', { ...shared, kind: 'action', path: list.path });
  await add('DeleteSelection', 'DeleteSelectionDialog', 'DeleteSelectionDialog', { ...shared, paths: [stage.path, list.path] });
  await add('DeleteSelectionAllowed', 'DeleteSelectionDialog', 'DeleteSelectionDialog', { ...shared, paths: [h.view.stages[1].path, list.path] });
  await add('RemoveOption', 'RemoveOptionDialog', 'RemoveOptionDialog', { ...shared, actionPath: list.path, ordinal: 0 });
  await add('Refusal', 'GestureFeedback', 'RefusalNotice', { ...shared, refusal: { error: { code: 'ENTRY_STAGE_AS_OPTION', params: {}, path: '_PATH_', references: [] } } });
  const { applyAdvancedGesture } = await h.load('src/store/projectModel/authoring.js');
  let payloadError;
  try { await applyAdvancedGesture({ authoring: {} }, {}, { invokeCommand: noop }); } catch (error) { payloadError = error; }
  await add('RefusalPayload', 'GestureFeedback', 'RefusalNotice', { ...shared, refusal: { error: payloadError } });
  const { planStageMediaAssignment } = await h.load('src/store/advancedAuthoring/mediaDrop.js');
  const refusedDrop = planStageMediaAssignment({ project: {}, stageUuid: null, kind: 'audio', path: '_PATH_' });
  const dropError = Object.assign(new Error(refusedDrop.reason), { code: refusedDrop.code });
  await add('RefusalDrop', 'GestureFeedback', 'RefusalNotice', { ...shared, refusal: { error: dropError } });
  await add('RefusalUnknown', 'GestureFeedback', 'RefusalNotice', { ...shared, refusal: { error: { code: '_UNKNOWN_', params: {}, detail: 'RAW_DETAIL_TRACE', path: '_PATH_', references: [] } } });
  await add('Report', 'GestureFeedback', 'ReportNotice', { ...shared, entry: { report: { references: { selections: [{ decided: false }, { decided: true, after: null }, { decided: true, after: {} }] }, positions: { staleDecisions: [{}] }, media: { released: [{}], missing: [{}] } } } });
  const entries = [h.index.byPath.get(stage.path), h.index.byPath.get(list.path)];
  const selectedStages = entries.map(entry => entry.kind === 'stage' ? { ...entry, node: { ...entry.node, controls: { ...entry.node.controls, presence: 'value' } } } : entry);
  const { GraphSelectionEditor } = await h.load('src/components/AdvancedWorkspace/GraphSelectionEditor.jsx');
  function SelectionPanel() { return React.createElement(ProjectContext.Provider, { value: { workspaceDir: '', xttsSettings: { backend: 'piper', piperVoice: '_AUTHOR_VOICE_' }, sdSettings: {}, sdJobs: [] } }, React.createElement(ErrorDialogProvider, null, React.createElement(GraphSelectionEditor, { entries: selectedStages, onSetColor: noop, onSetControls: noop, onAssignMedia: noop, onDelete: noop }))); }
  cases.SelectionPanel = [SelectionPanel, {}];
  await add('ActionPanel', 'ActionEditor', 'ActionEditor', { ...shared, project: null, inspected: inspectNode(h.index, list.path), onDelete: noop, onRemoveOption: noop, onViewConnections: noop });
  await add('StagePanel', 'StageEditor', 'StageEditor', { ...shared, project: null, usage: new Map(), inspected: inspectNode(h.index, h.view.stages[1].path), onDelete: noop, onRemoveOption: noop, onViewConnections: noop });
  await add('ArrivalsEmpty', 'StageArrivals', 'StageArrivals', { ...shared, stage: h.view.stages[1], memberships: [] });
  await add('WheelEmpty', 'StageWheel', 'StageWheel', { ...shared, stage: h.view.stages[1], memberships: [] });
  const actionEntry = h.index.byPath.get(list.path);
  const membership = { key: '_MEMBER_', action: actionEntry, actionPath: list.path, count: 2, rank: 0, direct: [{ key: '_OPENER_', source: h.index.byPath.get(stage.path), sourcePath: stage.path, slot: 'home', random: true }], neighbours: [{ key: '_NEIGHBOUR_', side: 'both', rank: 1, stagePath: null, label: null, wheel: true, wraps: true }] };
  await add('ArrivalsReachable', 'StageArrivals', 'StageArrivals', { ...shared, stage: h.view.stages[1], memberships: [membership], onRemoveOption: noop });
  await add('WheelNeighbours', 'StageWheel', 'StageWheel', { ...shared, stage: h.view.stages[1], memberships: [membership] });
  const rows = ['ok', 'home'].map(slot => ({ slot, presence: 'absent', options: [], actionPath: null, landing: {} }));
  await add('DestinationsAbsent', 'StageDestinations', 'StageDestinations', { ...shared, stage: h.view.stages[1], rows });
  await add('DestinationsEntry', 'StageDestinations', 'StageDestinations', { ...shared, stage, rows });
  const wired = rows.map(row => ({ ...row, presence: 'value', action: actionEntry, actionPath: list.path, actionLabel: actionEntry.label.label, landing: { random: true }, options: list.options.map((option, rank) => ({ key: option.optionId, rank, stagePath: option.target.stagePath, label: h.index.byPath.get(option.target.stagePath)?.label?.label ?? null })) }));
  await add('DestinationsWired', 'StageDestinations', 'StageDestinations', { ...shared, stage: h.view.stages[1], rows: wired });
  await add('ArrivalsFolded', 'StageArrivals', 'StageArrivals', { ...shared, stage: h.view.stages[1], memberships: [{ ...membership, direct: Array.from({ length: 5 }, (_, ordinal) => ({ ...membership.direct[0], key: '_OPENER_' + ordinal, random: ordinal % 2 === 0, slot: ordinal % 2 === 0 ? 'home' : 'ok' })) }], onRemoveOption: noop });
  const allCases = { ...cases };
  for (const [name, [Component, componentProps]] of Object.entries(allCases)) {
    function Provided() { return React.createElement(ProjectContext.Provider, { value: { pathAudit: {}, workspaceDir: '', xttsSettings: {}, sdSettings: {}, sdJobs: [] } }, React.createElement(ErrorDialogProvider, null, React.createElement(Component, componentProps))); }
    cases[name] = [Provided, {}];
  }
  function render(name) {
    const windowBefore = globalThis.window;
    if (!windowBefore) globalThis.window = { innerWidth: 1024, innerHeight: 768 };
    try { return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: h.engine }, React.createElement(...cases[name]))); }
    finally { if (!windowBefore) delete globalThis.window; }
  }
  function renderDetailed(name) {
    const translate = h.engine.t; const translations = [];
    h.engine.t = function(key, options) { const value = translate.call(this, key, options); translations.push({ key, options, value }); return value; };
    try { return { html: render(name), translations }; } finally { h.engine.t = translate; }
  }
  return { ...h, cases, rawCases: allCases, render, renderDetailed, stage };
}

// Injection de l’état initial uniquement dans le banc SSR ; les sources produit ne changent pas.
// Les parcours par clic et la persistance du dialogue sont vérifiés séparément avec React monté.
export function openedEditingSources(originalSources = null) {
  const files = ['ControlsEditor', 'ActionEditor', 'StageArrivals', 'StageDestinations', 'GraphSelectionEditor'];
  const result = { ...originalSources };
  for (const name of files) {
    const file = `src/components/AdvancedWorkspace/${name}.jsx`;
    let source = originalSources?.[file] ?? readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    if (name === 'ControlsEditor') source = source.replace('const [completion, setCompletion] = useState(null)', 'const [completion, setCompletion] = useState({ wheel: true, ok: true, home: false, pause: false, autoplay: false })');
    if (name === 'ActionEditor') source = source.replace('const [insertAt, setInsertAt] = useState(null)', 'const [insertAt, setInsertAt] = useState(0)').replace('const [retargeting, setRetargeting] = useState(null)', 'const [retargeting, setRetargeting] = useState(0)').replace('const [wiring, setWiring] = useState(null)', "const [wiring, setWiring] = useState('ok')").replace('const [menu, setMenu] = useState(null)', 'const [menu, setMenu] = useState({ rank: 0, x: 0, y: 0 })').replace('const [open, setOpen] = useState(false)', 'const [open, setOpen] = useState(true)');
    if (name === 'StageArrivals') source = source.replace('const [adding, setAdding] = useState(false)', 'const [adding, setAdding] = useState(true)').replace('const [open, setOpen] = useState(false)', 'const [open, setOpen] = useState(true)');
    if (name === 'StageDestinations') source = source.replace('const [editing, setEditing] = useState(null)', "const [editing, setEditing] = useState('ok')");
    if (name === 'GraphSelectionEditor') source = source.replace('const [imagesBusy, setImagesBusy] = useState(false)', 'const [imagesBusy, setImagesBusy] = useState(true)').replace('const [audiosBusy, setAudiosBusy] = useState(false)', 'const [audiosBusy, setAudiosBusy] = useState(true)');
    result[file] = source;
  }
  return result;
}
