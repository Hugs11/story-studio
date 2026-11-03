import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { sampleView } from './advancedViewFixtures.mjs';

export const GRAPH_BASE = '92de5a35fa8417a392a6ca719d449aafefb7e801';
export const GRAPH_FILES = [
  ...['AdvancedGraphCanvas', 'GraphCanvasStage', 'GraphInspector', 'GraphNodeOverlays', 'GraphSearchPanel', 'GraphSurfaceControls'].map(f => `src/components/AdvancedGraphCanvas/${f}.jsx`),
  'src/components/AdvancedGraphCanvas/graphSurfaceCapture.js',
  ...['AdvancedDialog', 'AdvancedWorkspace', 'CreateConstructionDialog', 'NewStageDefaultsDialog'].map(f => `src/components/AdvancedWorkspace/${f}.jsx`),
  'src/components/AdvancedWorkspace/useGraphArrangement.js', 'src/hooks/graphCopyFlow.js', 'src/hooks/useAdvancedProjectEntry.js',
  'src/store/advancedAuthoring/constructions.js', 'src/store/advancedAuthoring/defaultNodeNames.js',
  ...['advancedViewSession', 'graphPresentation', 'graphViewModel'].map(f => `src/store/advancedGraphView/${f}.js`), 'src/store/graphCopy.js',
];
export async function graphSurfaceHarness({ originalSources = null } = {}) {
  const original = originalSources ? new Map(Object.entries(originalSources)) : null;
  const server = await createServer({ configFile: false, plugins: [{ name: 'graph-source-fixture', enforce: 'pre', transform(_code, id) {
    const file = id.split('?')[0].replaceAll('\\', '/').replace(`${process.cwd().replaceAll('\\', '/')}/`, '');
    // Le portail ne peut pas être rendu en SSR ; seul son conteneur est remplacé.
    if (file === 'src/components/common/AppModalPortal.jsx') return 'export function AppModalPortal({children}) { return <div className="app-modal-overlay">{children}</div>; }';
    if (original?.has(file)) return original.get(file);
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const load = file => server.ssrLoadModule('/' + file);
  const { initializeI18n } = await load('src/i18n/index.js'); const engine = initializeI18n('fr');
  const { buildGraphIndex, inspectNode } = await load('src/store/advancedGraphView/graphViewModel.js');
  const view = sampleView(); view.stages.forEach((n, i) => { n.name = { presence: 'value', value: `_AUTHOR_${i}_` }; });
  const index = buildGraphIndex(view);
  const { default: Inspector } = await load('src/components/AdvancedGraphCanvas/GraphInspector.jsx');
  const { GraphSurfaceControls: Controls } = await load('src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx');
  const { default: Search } = await load('src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx');
  const { NewStageDefaultsForm: Defaults, NewStageDefaultsDialog } = await load('src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx');
  const { CreateConstructionDialog: Construction } = await load('src/components/AdvancedWorkspace/CreateConstructionDialog.jsx');
  const { AdvancedDialog: Dialog } = await load('src/components/AdvancedWorkspace/AdvancedDialog.jsx');
  const { GraphNodeOverlays: Overlays } = await load('src/components/AdvancedGraphCanvas/GraphNodeOverlays.jsx');
  const { default: Canvas } = await load('src/components/AdvancedGraphCanvas/GraphCanvasStage.jsx');
  const noop = () => {};
  const scenarios = {
    inspectorEmpty: [Inspector, { inspected: null, onFocusPath: noop }],
    inspectorStage: [Inspector, { inspected: inspectNode(index, view.stages[0].path), onFocusPath: noop }],
    inspectorList: [Inspector, { inspected: inspectNode(index, view.actions[0].path), onFocusPath: noop }],
    controls: [Controls, { engineRef: { current: null }, index, viewport: { x: 0, y: 0, zoom: 1 }, hostRef: { current: null }, arrangement: { disabled: false, busy: false, failure: null, arrange: noop }, history: { canBack: false, canForward: true }, onToggleOverview: noop }],
    search: [Search, { search: () => ({ results: index.entries, total: index.entries.length }), onFocusPath: noop, counts: { stages: 2, actions: 1, edges: 2 }, searchActive: true }],
    defaults: [Defaults, { draft: { wheel: true, ok: true, home: false, pause: false, autoplay: false }, onChange: noop, selectedStage: index.entries[0] }],
    defaultsDialog: [NewStageDefaultsDialog, { onClose: noop }],
    construction: [Construction, { index, busy: false, onCancel: noop, onConfirm: noop }],
    dialog: [Dialog, { title: '_AUTHOR_TITLE_', onCancel: noop, onConfirm: noop }],
    overlay: [Overlays, { overlay: { detailLevel: 'full', zoom: 1, nodes: [{ path: '_PATH_', kind: 'stage', label: '_AUTHOR_', isEntry: true, x: 0, y: 0, width: 100, height: 100, linkPorts: [] }] } }],
    canvas: [Canvas, { view: { status: 'loading', index, viewport: { x: 0, y: 0, zoom: 1 }, selection: { stages: [], actions: [] }, notices: [{ kind: 'viewport-rejected' }, { kind: 'anchors-ignored', count: 2 }, { kind: 'cache-unreadable' }, { kind: 'cache-failure', disarmed: true }], noteViewport: noop, initialViewport: noop } }],
  };
  function render(name) { const [component, props] = scenarios[name]; return renderToStaticMarkup(React.createElement(component, props)); }
  return { server, engine, load, index, view, scenarios, render, close: () => server.close() };
}
export function graphVisibleSurface(html) {
  const attributes = [...html.matchAll(/\b(title|aria-label|alt|placeholder)="([^"]*)"/g)].map(m => [m[1], m[2]]);
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, attributes };
}
