import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import React from 'react';
import i18next from 'i18next';
import { mountSurface, elementByClass } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import preparation from './fixtures/catalogue/assembly-preparation.json' with { type: 'json' };
import { DndContext, KeyboardSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { prepareAggregateLanding } from '../src/components/AggregatePacks/aggregateLanding.js';

// Set only the initial UI state; every handler remains the production handler.
registerHooks({ load(url, context, next) {
  if (url.endsWith('/AppModalPortal.jsx')) return { format: 'module', source: 'export function AppModalPortal({ children }) { return children; }', shortCircuit: true };
  if (!url.endsWith('/AggregatePacksFunnel.jsx')) return next(url, context);
  const code = readFileSync(fileURLToPath(url), 'utf8')
    .replace('useState(0)', 'useState(globalThis.__aggregateFixture.step)')
    .replace('useState(() => preparation ? assemblyPacks(preparation) : [])', 'useState(() => globalThis.__aggregateFixture.packs ?? assemblyPacks(preparation))')
    .replace("useState('');\n  const [rootImage, setRootImage] = useState('')", "useState(globalThis.__aggregateFixture.audio);\n  const [rootImage, setRootImage] = useState(globalThis.__aggregateFixture.image)")
    .replace("const [error, setError] = useState('')", 'const [error, setError] = useState(globalThis.__aggregateFixture.error ?? \'\')')
    .replace('useState(false);\n  const [rootAudio', 'useState(globalThis.__aggregateFixture.loading ?? false);\n  const [rootAudio');
  const withMetadata = code.replace('...defaultMetadataForPacks([], generateUuid())', '...(globalThis.__aggregateFixture.metadata ?? defaultMetadataForPacks([], generateUuid()))');
  return { format: 'module', source: transformSync(fileURLToPath(url), withMetadata, { jsx: { runtime: 'automatic', importSource: 'story-studio/chrome-bench' } }).code, shortCircuit: true };
} });
const { AggregatePacksFunnel } = await import('../src/components/AggregatePacks/AggregatePacksFunnel.jsx');
const engine = createTestI18n();
await i18next.init({ ...engine.options, resources: engine.options.resources });

for (const origin of ['home', 'catalogue']) {
  for (const step of [0, 1, 2]) {
    for (const media of [{ audio: '', image: '' }, { audio: '/previous.mp3', image: '/previous.png' }, { audio: '/previous.mp3', image: '' }, { audio: '', image: '/previous.png' }]) {
      test(`${origin}: step ${step + 1} secondary action preserves chosen root media ${JSON.stringify(media)}`, async () => {
        const packs = [{ id: 'a', name: 'First', path: '/first.zip' }, { id: 'b', name: 'Second', path: '/second.zip' }];
        const metadata = { title: 'Titre choisi', uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', author: 'Auteur' };
        globalThis.__aggregateFixture = { step, metadata, packs: origin === 'home' ? packs : null, ...media };
        let landed;
        const surface = mountSurface(React.createElement(AggregatePacksFunnel, {
          preparation: origin === 'catalogue' ? preparation : null,
          onLand: async args => { landed = args; return false; },
        }));
        assert.equal(surface.elements.some(element => element.props?.onSaveAndGenerate), false);
        assert.equal(elementByClass(surface.elements, 'funnel-btn-primary').props.children[0].props.children, i18next.t('home:funnel.footer.continue'));
        assert.ok(surface.html.includes(i18next.t('home:aggregate.editor.continue')));
        await elementByClass(surface.elements, 'funnel-btn-secondary').props.onClick();
        assert.deepEqual(landed.draft.metadata, { ...metadata, minAge: origin === 'catalogue' ? String(preparation.suggestedAgeMin) : '' });
        assert.equal(elementByClass(surface.elements, 'funnel-btn-secondary').props.disabled, false);
        assert.equal(landed.draft.rootAudio || null, media.audio || null);
        assert.equal(landed.draft.rootImage || null, media.image || null);
        const project = await prepareAggregateLanding({ draft: landed.draft, workspaceDir: '/editor', copy: async source => `/editor/${source.split('/').at(-1)}` });
        assert.equal(project.rootAudio, media.audio ? '/editor/previous.mp3' : null);
        assert.equal(project.rootImage, media.image ? '/editor/previous.png' : null);
        assert.equal(landed.draft.packs.length, origin === 'home' ? 2 : preparation.entries.length);
        assert.equal(landed.preparation, origin === 'catalogue' ? preparation : null);
      });
    }
  }
}

for (const step of [0, 1, 2]) {
  for (const [packs, loading] of [[[], false], [[{ id: 'a', path: '/first.zip' }], true]]) {
    test(`step ${step + 1}: secondary disabled with ${packs.length} packs and loading=${loading}`, () => {
      globalThis.__aggregateFixture = { step, packs, loading };
      const surface = mountSurface(React.createElement(AggregatePacksFunnel, {}));
      assert.equal(elementByClass(surface.elements, 'funnel-btn-secondary').props.disabled, true);
    });
  }
}

for (const step of [1, 2]) {
  test(`step ${step + 1}: landing errors remain visible`, async () => {
    const error = { code: 'CATALOG_ASSEMBLY_TRANSFER_FAILED', params: {} };
    globalThis.__aggregateFixture = { step, packs: [{ id: 'a', path: '/first.zip' }], error };
    const surface = mountSurface(React.createElement(AggregatePacksFunnel, { onLand: async () => { throw error; } }));
    const alert = surface.elements.find(element => element.props?.role === 'alert');
    assert.ok(alert);
    assert.match(surface.html, /role="alert"/);
    assert.doesNotMatch(surface.html, /\[object Object\]/);
    await assert.doesNotReject(elementByClass(surface.elements, 'funnel-btn-secondary').props.onClick());
  });
}

test('English stepper labels its second step Audio', async () => {
  await i18next.changeLanguage('en');
  globalThis.__aggregateFixture = { step: 1, packs: [{ id: 'a', name: 'First', path: '/first.zip' }] };
  const surface = mountSurface(React.createElement(AggregatePacksFunnel, {}));
  assert.equal(i18next.t('home:aggregate.step.audio'), 'Audio');
  assert.match(surface.html, /Audio/);
  assert.doesNotMatch(surface.html, /Destination/);
  assert.doesNotMatch(surface.html, /Next step/);
  await i18next.changeLanguage('fr');
});

test('pack sorting enables the keyboard sensor and translated instructions and announcements', async () => {
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    globalThis.__aggregateFixture = { step: 0, packs: [{ id: 'a', name: 'First', path: '/first.zip' }] };
    const surface = mountSurface(React.createElement(AggregatePacksFunnel, {}));
    const dnd = surface.elements.find(element => element.type === DndContext);
    const keyboard = dnd.props.sensors.find(({ sensor }) => sensor === KeyboardSensor);
    assert.ok(keyboard);
    assert.equal(keyboard.options.coordinateGetter, sortableKeyboardCoordinates);
    assert.equal(dnd.props.accessibility.screenReaderInstructions.draggable, i18next.t('home:aggregate.packs.dragInstructions'));
    for (const [event, key] of [['onDragStart', 'pickedUp'], ['onDragEnd', 'dropped'], ['onDragCancel', 'cancelled']]) {
      assert.equal(dnd.props.accessibility.announcements[event]({ active: { id: 'a' } }), i18next.t(`home:aggregate.packs.${key}`, { name: 'First' }));
    }
  }
  await i18next.changeLanguage('fr');
});

test('metadata primary chooses the folder and immediately invokes generation; cancelling starts nothing', async () => {
  let generated;
  const harness = await createDiskHarness({ commands: {
    create_session_workspace: () => harness.mkdirp('session'),
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => {},
    generate_pack: args => { generated = args; return '/output/pack.zip'; },
  } });
  window.setInterval = setInterval;
  window.clearInterval = clearInterval;
  window.__TAURI_INTERNALS__.transformCallback = () => 1;
  window.__TAURI_INTERNALS__.unregisterCallback = () => {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  try {
    globalThis.__aggregateFixture = { step: 3,
      packs: [{ id: 'a', name: 'First', path: await harness.writeFile('input/first.zip', 'zip') }],
      audio: await harness.writeFile('input/menu.mp3', 'audio'), image: await harness.writeFile('input/menu.png', 'image'),
    };
    const surface = mountSurface(React.createElement(AggregatePacksFunnel, {}));
    assert.equal(elementByClass(surface.elements, 'funnel-btn-secondary'), null);
    assert.equal(surface.elements.some(element => element.type === 'footer' && element.props.className === 'funnel-foot'), false);
    const sheet = surface.elements.find(element => element.props?.onSaveAndGenerate);
    assert.equal(sheet.props.primaryActionLabel, i18next.t('home:aggregate.generation.action'));
    harness.answerOpen(null);
    await sheet.props.onSaveAndGenerate({ title: 'Aggregate' });
    assert.equal(harness.countCalls('create_session_workspace'), 0);
    assert.equal(generated, undefined);
    harness.answerOpen('/output');
    await sheet.props.onSaveAndGenerate({ title: 'Aggregate' });
    assert.ok(generated, `no intermediate review or second click: ${JSON.stringify(harness.calls)}`);
    assert.equal(generated.outputFolder, '/output');
    assert.equal(JSON.parse(generated.projectJson).rootEntries.length, 1);
  } finally {
    delete globalThis.__aggregateFixture;
    await harness.dispose();
  }
});
