import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { mountSurface } from './chromeBench.mjs';
const { SelectionMetadataControls } = await import('../src/components/Catalogue/selection/SelectionControls.jsx');
test('mutation refusals appear inside the immediate controls in all languages', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const error = { code: 'CATALOG_REVISION_CONFLICT' };
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const surfaces = [[SelectionMetadataControls, { cards: [] }]];
    for (const [Component, props] of surfaces) {
      const { html } = mountSurface(React.createElement(Component, { ...props, error, busy: false, mutate() {}, onClose() {} }));
      assert.match(html, /<div[^>]*>.*<p role="alert">[^<]+<\/p>.*<\/div>/s);
      assert.doesNotMatch(html, /catalogue:|rust:|\[object Object\]/);
    }
  }
});
