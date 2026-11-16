import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';
import { normalizeProjectData } from '../src/store/projectModel.js';
import { updateGlobalEndMessageProject, removeGlobalEndMessageProject } from '../src/store/endMessageMutations.js';
import { collectEndMessagePresentations, hasVisibleEndNode } from '../src/store/generatedNavigation.js';
import { getCompleteNavigationEdges } from '../src/components/diagram/flowDiagramLayout.js';
import { getStructureLevelLayout } from '../src/components/diagram/diagram/structureLevelLayout.js';

register('./nodeSourceResolver.mjs', import.meta.url);
const { useProjectStore } = await import('../src/store/projectStore.js');

function attachedProject(autoNext) {
  const attached = (id) => ({
    id, type: 'story', name: id,
    audio: `C:/message-fin/${id}.mp3`, itemAudio: `C:/message-fin/${id}-t.mp3`, itemImage: `C:/message-fin/${id}.png`,
    // « Rattacher au message global » (attachStoryEndToGlobalProject) ou import d'un pack
    // à écran de fin par histoire (Bestioles : 154 invites rattachées).
    afterPlaybackPromptAudio: 'C:/message-fin/fin.mp3',
    afterPlaybackPromptOkTarget: null,
    afterPlaybackPromptHomeTarget: null,
    afterPlaybackPromptHomeNone: true,
  });
  return normalizeProjectData({
    projectType: 'pack',
    projectName: 'Message de fin',
    packMetadata: { title: 'Message de fin', uuid: '11111111-2222-4333-8444-555566667777' },
    rootAudio: 'C:/message-fin/root.mp3',
    rootImage: 'C:/message-fin/root.png',
    nightModeAudio: 'C:/message-fin/fin.mp3',
    globalOptions: { endNode: true, autoNext },
    rootEntries: [attached('a'), attached('b')],
  });
}

test('p4 témoin : sans enchaînement auto, changer le son global le recopie dans les invites rattachées', () => {
  const next = updateGlobalEndMessageProject(attachedProject(false), { nightModeAudio: 'C:/message-fin/fin2.mp3' });
  assert.deepEqual(next.rootEntries.map((e) => e.afterPlaybackPromptAudio), ['C:/message-fin/fin2.mp3', 'C:/message-fin/fin2.mp3']);
});

test('p4 enchaînement auto actif : le nœud « Message de fin » du diagramme reste éditable alors que l\'arbre le masque', () => {
  const project = attachedProject(true);
  assert.equal(hasVisibleEndNode(project), false, 'arbre : nœud masqué');
  const layout = getStructureLevelLayout(project, {
    nodeWidth: 100, rootWidth: 120, nodeHeight: 96, nodeVisualHeight: 82, colGap: 12, rowGap: 92, padX: 32, padY: 20,
  });
  assert.equal(layout.hasEndNode, false, 'diagramme : le nœud « Message de fin » est affiché (et sélectionnable) malgré l\'enchaînement auto');
});

// L'éditeur du message de fin reste
// accessible après Annuler ou par le menu contextuel de l'arbre, même quand
// l'enchaînement automatique masque le nœud ; une voix peut aussi arriver après son activation.
test('p4 enchaînement auto actif : changer le son global (éditeur du message de fin) propage aux invites rattachées', () => {
  // Geste : éditeur du message de fin resté ouvert → nouveau son ; puis désactiver l'enchaînement automatique.
  let project = updateGlobalEndMessageProject(attachedProject(true), { nightModeAudio: 'C:/message-fin/fin2.mp3' });
  project = { ...project, globalOptions: { ...project.globalOptions, autoNext: false } };
  const kinds = collectEndMessagePresentations(project).map((item) => `${item.entry.id}:${item.presentationKind}:${item.entry.afterPlaybackPromptAudio === project.nightModeAudio}`);
  assert.deepEqual(kinds, ['a:global:true', 'b:global:true'],
    'les histoires rattachées gardent l\'ancien son et deviennent des messages personnels');
});

test('p4 enchaînement auto actif : supprimer le message global (éditeur du message de fin) retire les invites rattachées', () => {
  let project = removeGlobalEndMessageProject(attachedProject(true));
  project = { ...project, globalOptions: { ...project.globalOptions, autoNext: false } };
  assert.deepEqual(project.rootEntries.map((e) => e.afterPlaybackPromptAudio), [null, null],
    'les invites rattachées survivent à la suppression du message global');
});

test('Annuler réactive l’enchaînement avec end-node sélectionné : le nouveau son reste rattaché', () => {
  const hook = runner(() => useProjectStore());
  let store = hook.render();
  store.loadProject(attachedProject(true));
  store = hook.render();
  store.updateGlobalOption('autoNext', false);
  store = hook.render();
  assert.equal(hasVisibleEndNode(store.project), true);
  store.setSelectedId('end-node');
  store = hook.render();

  store.undo();
  store = hook.render();
  assert.equal(store.project.globalOptions.autoNext, true);
  assert.equal(hasVisibleEndNode(store.project), false);
  assert.equal(store.selectedId, 'end-node');
  store.updateGlobalEndMessage({ nightModeAudio: 'C:/message-fin/fin2.mp3' });
  store = hook.render();
  store.updateGlobalOption('autoNext', false);
  store = hook.render();

  assert.deepEqual(store.project.rootEntries.map((entry) => entry.afterPlaybackPromptAudio.replaceAll('\\', '/')),
    ['C:/message-fin/fin2.mp3', 'C:/message-fin/fin2.mp3']);
  assert.deepEqual(collectEndMessagePresentations(store.project).map((item) => item.presentationKind),
    ['global', 'global']);
});

// Suppression depuis l'arbre : même mutation que le menu du nœud global.
test('message de fin désactivé depuis l’arbre : absent du diagramme et de ses liens', () => {
  const project = removeGlobalEndMessageProject(attachedProject(false));
  assert.equal(hasVisibleEndNode(project), false);
  const layout = getStructureLevelLayout(project, {
    nodeWidth: 100, rootWidth: 120, nodeHeight: 96, nodeVisualHeight: 82, colGap: 12, rowGap: 92, padX: 32, padY: 20,
  });
  assert.equal(layout.hasEndNode, false);
  assert.equal(layout.nodes.some(({ entry }) => entry.id === 'end-node'), false);
  assert.equal(getCompleteNavigationEdges(project, layout).some((edge) => edge.from === 'end-node' || edge.to === 'end-node'), false);
});

test('enchaînement auto actif : aucun nœud ni lien de fin dans le diagramme', () => {
  const project = attachedProject(true);
  const layout = getStructureLevelLayout(project, {
    nodeWidth: 100, rootWidth: 120, nodeHeight: 96, nodeVisualHeight: 82, colGap: 12, rowGap: 92, padX: 32, padY: 20,
  });
  assert.equal(layout.nodes.some(({ entry }) => entry.id === 'end-node'), false);
  assert.equal(layout.bands.some((band) => band.kind === 'after-reading'), false);
  assert.equal(getCompleteNavigationEdges(project, layout).some((edge) => edge.from === 'end-node' || edge.to === 'end-node'), false);
});
