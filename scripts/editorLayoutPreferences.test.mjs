import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_LAYOUT_SCOPE,
  KEYS,
  editorLayoutKeys,
  runSettingsMigrations,
} from '../src/store/persistentSettings.js';
import {
  clampFloatingSimulatorGeometry,
  decodeFloatingSimulatorGeometry,
  encodeFloatingSimulatorGeometry,
} from '../src/hooks/useFloatingSimulator.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    snapshot: () => Object.fromEntries(values),
  };
}

test('la migration duplique la disposition inférieure historique vers les deux éditeurs une seule fois', () => {
  const previousStorage = globalThis.localStorage;
  const storage = memoryStorage({
    bottomPanelOpen: 'true',
    bottomPanelTab: 'queue',
    bottomPanelHeight: '412',
  });
  globalThis.localStorage = storage;
  try {
    runSettingsMigrations();
    const free = editorLayoutKeys(EDITOR_LAYOUT_SCOPE.FREE);
    const advanced = editorLayoutKeys(EDITOR_LAYOUT_SCOPE.ADVANCED);
    const migrated = storage.snapshot();

    assert.equal(migrated[free.bottomPanelOpen], 'true');
    assert.equal(migrated[free.bottomPanelTab], 'queue');
    assert.equal(migrated[free.bottomPanelHeight], '412');
    assert.equal(migrated[advanced.bottomPanelOpen], 'true');
    assert.equal(migrated[advanced.bottomPanelTab], 'queue');
    assert.equal(migrated[advanced.bottomPanelHeight], '412');
    assert.equal(migrated.bottomPanelOpen, undefined);
    assert.equal(migrated.bottomPanelTab, undefined);
    assert.equal(migrated.bottomPanelHeight, undefined);

    storage.setItem(free.bottomPanelTab, 'media');
    runSettingsMigrations();
    assert.equal(storage.getItem(free.bottomPanelTab), 'media');
    assert.equal(storage.getItem(advanced.bottomPanelTab), 'queue');
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test('toutes les préférences de disposition sont explicitement séparées par éditeur', () => {
  const free = editorLayoutKeys(EDITOR_LAYOUT_SCOPE.FREE);
  const advanced = editorLayoutKeys(EDITOR_LAYOUT_SCOPE.ADVANCED);

  for (const field of [
    'panelOrder',
    'primaryPanelWidth',
    'secondaryPanelWidth',
    'bottomPanelOpen',
    'bottomPanelTab',
    'bottomPanelHeight',
    'floatingSimulatorGeometry',
  ]) {
    assert.equal(typeof free[field], 'string', field);
    assert.equal(typeof advanced[field], 'string', field);
    assert.notEqual(free[field], advanced[field], field);
  }

  assert.equal(free.panelOrder, KEYS.WORKSPACE_PANEL_ORDER);
  assert.equal(advanced.panelOrder, KEYS.ADVANCED_WORKSPACE_PANEL_ORDER);
});

test('la géométrie du simulateur se sérialise et refuse les valeurs corrompues', () => {
  const geometry = { x: 123, y: 45, width: 520 };
  assert.deepEqual(
    decodeFloatingSimulatorGeometry(encodeFloatingSimulatorGeometry(geometry)),
    geometry,
  );
  for (const raw of [null, '', 'null', '{}', '{"x":-1,"y":0,"width":400}', '{malforme']) {
    assert.equal(decodeFloatingSimulatorGeometry(raw), null, raw);
  }
});

test('une géométrie mémorisée est ramenée dans l’hôte courant', () => {
  assert.deepEqual(
    clampFloatingSimulatorGeometry(
      { x: 900, y: 600, width: 700 },
      { width: 800, height: 500 },
      { aspectRatio: 0.62, minWidth: 360, maxWidth: 760, hostPadding: 24 },
    ),
    { x: 100, y: 66, width: 700, height: 434 },
  );

  assert.deepEqual(
    clampFloatingSimulatorGeometry(
      { x: 40, y: 30, width: 900 },
      { width: 500, height: 300 },
      { aspectRatio: 0.62, minWidth: 360, maxWidth: 760, hostPadding: 24 },
    ),
    { x: 40, y: 24, width: 445, height: 276 },
  );
});
