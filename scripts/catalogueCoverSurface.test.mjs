import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { card } from './catalogueFixtures.mjs';
const { CoverImage } = await import('../src/components/Catalogue/views/CoverImage.jsx');
const { CardCover } = await import('../src/components/Catalogue/views/CardCover.jsx');
const { FicheOverview } = await import('../src/components/Catalogue/fiche/FicheOverview.jsx');
const { FicheModal } = await import('../src/components/Catalogue/fiche/FicheModal.jsx');
const { FicheSelectionSummary } = await import('../src/components/Catalogue/fiche/SelectionPanel.jsx');

function tauri(run) {
  const saved = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { convertFileSrc: (path, protocol) => `${protocol}://localhost/${path}` } };
  try { return run(); } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
}

test('fiche key preserves the surface across fingerprints and metadata edits', () => tauri(() => {
  const props = { ficheId: 'a', coverSignature: 'a'.repeat(64) };
  const original = CoverImage(props);
  assert.equal(CoverImage({ ...props, favorite: true }).key, original.key);
  assert.notEqual(CoverImage({ ...props, ficheId: 'b' }).key, original.key);
  assert.equal(CoverImage({ ...props, coverSignature: 'b'.repeat(64) }).key, original.key);
  assert.equal(CoverImage({ ...props, coverSignature: null }).key, original.key);
  assert.equal(original.key, 'a');
}));

test('grid/list, inspector, modal and selection mosaic emit direct async images with silent placeholders', async () => {
  i18next.use(initReactI18next);
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  tauri(() => {
    const a = { ...card({ id: 'a', title: 'A' }), coverSignature: 'a'.repeat(64) };
    const b = { ...card({ id: 'b', title: 'B' }), coverSignature: 'b'.repeat(64) };
    const surfaces = [
      [CardCover, { card: a, view: {} }, [a]],
      [CardCover, { card: a, size: 'small', view: {} }, [a]],
      [FicheOverview, { card: a, age: { kind: 'missing' } }, [a]],
      [FicheModal, { card: a }, [a]],
      [FicheSelectionSummary, { cards: [a, b] }, [a, b]],
    ];
    for (const [Component, props, expected] of surfaces) {
      const surface = mountSurface(React.createElement(Component, props));
      const images = surface.elements.filter(element => element.type === 'img');
      assert.deepEqual(images.map(image => image.props.src), expected.map(item => `catalogue-cover://localhost/v1/${item.id}/${item.coverSignature}.jpg`));
      for (const image of images) {
        assert.equal(image.props.decoding, 'async');
        assert.equal(image.props.className, 'catalogue-cover-pending');
        assert.equal(typeof image.props.onLoad, 'function');
        assert.equal(typeof image.props.onError, 'function');
        assert.equal(image.props.loading, undefined, 'mounted neighbours load immediately');
      }
      assert.ok(!surface.html.includes(i18next.t('catalogue:cover.loading.label')));
      assert.ok(!surface.html.includes(i18next.t('catalogue:cover.missing.label')));
    }
  });
});

for (const phase of ['absent', 'unreadable', 'tooLarge', 'offline']) test(`remembered ${phase} renders its terminal label without an img`, async () => {
  const { createCoverLoading } = await import('../src/store/catalogue/coverLoading.js');
  const signature = 'c'.repeat(64), id = `remembered-${phase}`;
  const address = `catalogue-cover://localhost/v1/${id}/${signature}.jpg`;
  const loader = createCoverLoading({ address, changed() {}, request: async () => ({
    status: phase === 'offline' ? 503 : 422, headers: new Headers({ 'x-cover-state': phase }),
  }) });
  try { await loader.failed(); } finally { loader.dispose(); }
  tauri(() => {
    const surface = mountSurface(React.createElement(CoverImage, { ficheId: id, coverSignature: signature }));
    assert.equal(surface.elements.filter(element => element.type === 'img').length, 0);
    const label = { absent: 'missing', unreadable: 'unreadable', tooLarge: 'tooLarge', offline: 'missing' }[phase];
    assert.ok(surface.html.includes(i18next.t(`catalogue:cover.${label}.label`)));
    if (phase === 'offline') assert.ok(!surface.html.includes(i18next.t('catalogue:cover.unreadable.label')));
  });
});
