// Le réglage des boutons des nouveaux Écrans : une préférence de
// l'application, retenue depuis un Écran réglé comme l'auteur le veut.

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};

const { KEYS } = await import('../src/store/persistentSettings.js');
const {
  DEFAULT_NEW_STAGE_CONTROLS,
  completeStageControls,
  readNewStageControls,
  resetNewStageControlsCache,
  writeNewStageControls,
} = await import('../src/store/advancedAuthoring/newStageControls.js');
const { mountSurface } = await import('./chromeBench.mjs');
const { NewStageDefaultsForm } = await import('../src/components/AdvancedWorkspace/NewStageDefaultsDialog.jsx');

const STORY = { wheel: false, ok: false, home: true, pause: true, autoplay: true };

function fresh() {
  memory.clear();
  resetNewStageControlsCache();
}

test('sans réglage retenu, un nouvel Écran naît avec Molette, OK et HOME', () => {
  fresh();
  assert.deepEqual(readNewStageControls(), DEFAULT_NEW_STAGE_CONTROLS);
  assert.deepEqual(DEFAULT_NEW_STAGE_CONTROLS, {
    wheel: true, ok: true, home: true, pause: false, autoplay: false,
  });
});

test('un réglage retenu survit à une relecture', () => {
  fresh();
  writeNewStageControls(STORY);
  resetNewStageControlsCache();
  assert.deepEqual(readNewStageControls(), STORY);
});

test('un réglage stocké partiel ou illisible est complété, jamais transmis tel quel', () => {
  fresh();
  memory.set(KEYS.ADVANCED_NEW_STAGE_CONTROLS, '{"pause":true}');
  assert.deepEqual(readNewStageControls(), { ...DEFAULT_NEW_STAGE_CONTROLS, pause: true });
  fresh();
  memory.set(KEYS.ADVANCED_NEW_STAGE_CONTROLS, 'pas du JSON');
  assert.deepEqual(readNewStageControls(), DEFAULT_NEW_STAGE_CONTROLS);
});

const value = (on) => ({ presence: 'value', value: on });
const stageWith = (controls) => ({
  uuid: 's1',
  path: '/stageNodes/@uuid=s1#0',
  controls: {
    presence: 'value',
    complete: true,
    ...Object.fromEntries(Object.entries(controls).map(([key, on]) => [key, value(on)])),
  },
});

test('seul un Écran aux cinq boutons posés peut servir de modèle', () => {
  assert.deepEqual(completeStageControls(stageWith(STORY).controls), STORY);
  assert.equal(completeStageControls({ ...stageWith(STORY).controls, ok: { presence: 'absent' } }), null);
});

test('la fenêtre du modèle part du réglage retenu et propose de reprendre l’Écran sélectionné', () => {
  fresh();
  const render = (selectedStage) => mountSurface(React.createElement(NewStageDefaultsForm, {
    draft: { ...readNewStageControls() }, onChange: () => {}, selectedStage,
  })).html;
  const alone = render(null);
  assert.match(alone, /Boutons du modèle/);
  assert.match(alone, /Suite du parcours.*Bouton Accueil.*Pendant la lecture/s);
  assert.doesNotMatch(alone, /Reprendre les boutons/);
  assert.doesNotMatch(alone, /Revenir au réglage d’origine/, 'le réglage d’origine est déjà celui du modèle');
  const story = render({ label: { label: 'Histoire' }, node: stageWith(STORY) });
  assert.match(story, /Reprendre les boutons de « Histoire »/);
  writeNewStageControls(STORY);
  assert.match(render(null), /Revenir au réglage d’origine/);
});
