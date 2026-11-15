import test from 'node:test';
import assert from 'node:assert/strict';
import './chromeBench.mjs';
import { runner } from './reactHookDriver.mjs';
import { openNotebook, closeNotebook } from './chromeBenchJsx.mjs';
import './tauriDiskHarness.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';

const { setI18n } = await import('react-i18next');
const i18n = createTestI18n();
setI18n(i18n);
const { NativeGraphEditor } = await import('../src/components/editors/NativeGraphEditor.jsx');
const { MediaSlotEditor } = await import('../src/components/AdvancedWorkspace/MediaSlotEditor.jsx');
const { AudioField } = await import('../src/components/editors/AudioField.jsx');
const { ImageField } = await import('../src/components/editors/ImageField.jsx');
const { MediaTransferProvider } = await import('../src/store/MediaTransferContext.js');
const { ProjectContext } = await import('../src/store/ProjectContext.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { findEntryById } = await import('../src/store/projectModel.js');
const { audioClipboard, imageClipboard } = await import('../src/store/fieldClipboard.js');
const noop = () => {};

function renderElements(component) {
  openNotebook();
  try {
    component.render();
    return closeNotebook();
  } catch (error) {
    closeNotebook();
    throw error;
  }
}

async function contextAction(field, label) {
  const elements = renderElements(field);
  elements.find(element => element.props.onContextMenu).props.onContextMenu({
    preventDefault: noop, stopPropagation: noop, clientX: 0, clientY: 0,
  });
  const menu = renderElements(field).find(element => element.props.actions);
  const action = menu.props.actions.find(action => action.label === i18n.t(label));
  assert.ok(action, label);
  await action.fn();
  // AudioField lance le collage asynchrone depuis une action synchrone.
  await new Promise(resolve => setImmediate(resolve));
}

function mounted() {
  let store; let transfers;
  const app = runner(() => {
    store = useProjectStore();
    transfers = useMediaTransferHandlers({ store, copyImportedFilesEnabled: false,
      workspaceDirRef: { current: null }, savePathRef: { current: null },
    });
  });
  app.render();
  const provider = runner(() => MediaTransferProvider({ notifyCutPaste: transfers.notifyCutPaste }));
  const context = provider.render();
  context.type._currentValue = context.props.value;
  return { read() {
    app.render();
    ProjectContext._currentValue = { ...ProjectContext._currentValue, mediaStorage: { storage: store.project.storage } };
    return store;
  } };
}

for (const [field, Field, clipboard, path] of [
  ['audio', AudioField, audioClipboard, '/sons/partage.mp3'],
  ['image', ImageField, imageClipboard, '/images/partage.png'],
]) {
  for (const entryId of [undefined, 'menu']) {
    test(`couper ${field} de A vers B préserve le collage (${entryId ?? 'racine'})`, async () => {
      const app = mounted();
      const nativeGraph = { preserveForRoundTrip: true, document: { stageNodes: [
        { uuid: 'a', audio: null, image: null, [field]: path },
        { uuid: 'b', audio: null, image: null },
        { uuid: 'c', audio: null, image: null, [field]: path },
      ], actionNodes: [] } };
      app.read().loadProject({ projectType: 'pack',
        ...(entryId ? { rootEntries: [{ id: entryId, type: 'menu', nativeGraph, children: [] }] } : { nativeGraph }),
      });
      const store = app.read();
      const owner = () => entryId ? findEntryById(store.readProject(), entryId) : store.readProject();
      const editor = runner(() => NativeGraphEditor.type({
        entryId, graph: owner().nativeGraph,
        onChange: graph => entryId ? store.updateMenu(entryId, { nativeGraph: graph })
          : store.updateRootMedia('nativeGraph', graph),
      }));
      const media = () => renderElements(editor).find(element => element.type === Field).props;
      const sourceProps = media();
      const source = runner(() => Field(sourceProps));
      await contextAction(source, 'tree:media.clipboard.cut');
      const rows = renderElements(editor).filter(element => element.props.className?.startsWith('native-graph-row '));
      rows[1].props.onClick();
      const destinationProps = media();
      const destination = runner(() => Field(destinationProps));
      await contextAction(destination, 'tree:media.clipboard.move');
      const stages = owner().nativeGraph.document.stageNodes;
      assert.equal(stages[0][field], null, 'seul A est vidé');
      assert.equal(stages[1][field], path, 'B conserve le collage');
      assert.equal(stages[2][field], path, 'C conserve le média partagé');
      assert.equal(clipboard.getEntry(), null);
    });
  }

  test(`recoller ${field} dans son champ source natif le conserve`, async () => {
    const app = mounted();
    app.read().loadProject({ projectType: 'pack', nativeGraph: { preserveForRoundTrip: true, document: {
      stageNodes: [{ uuid: 'a', [field]: path }], actionNodes: [],
    } } });
    const store = app.read();
    const editor = runner(() => NativeGraphEditor.type({ graph: store.readProject().nativeGraph,
      onChange: graph => store.updateRootMedia('nativeGraph', graph),
    }));
    const props = renderElements(editor).find(element => element.type === Field).props;
    const component = runner(() => Field(props));
    await contextAction(component, 'tree:media.clipboard.cut');
    await contextAction(component, 'tree:media.clipboard.move');
    assert.equal(app.read().project.nativeGraph.document.stageNodes[0][field], path);
  });

  test(`recoller ${field} dans son champ source avancé ne déclenche aucun retrait`, async () => {
    mounted();
    const assigned = []; const removed = [];
    const editor = runner(() => MediaSlotEditor({
      stage: { uuid: 'a', [field]: { assetRef: 'asset' } }, field, projectEpoch: 7,
      usage: new Map([['asset', { path }]]),
      onAssignMedia: async (...args) => assigned.push(args), onGesture: gesture => removed.push(gesture),
    }));
    const props = renderElements(editor).find(element => element.type === Field).props;
    const component = runner(() => Field(props));
    await contextAction(component, 'tree:media.clipboard.cut');
    await contextAction(component, 'tree:media.clipboard.move');
    assert.deepEqual(assigned, [['a', field, path]]);
    assert.deepEqual(removed, []);
    assert.equal(clipboard.getEntry(), null);
  });
}
