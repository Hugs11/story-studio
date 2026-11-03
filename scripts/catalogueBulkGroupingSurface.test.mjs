import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
test('bulk and undo surfaces in FR/EN/IT', async () => {
 const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
 try {
  const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
  const load = async name => (await server.ssrLoadModule(`/src/components/Catalogue/${name}.jsx`))[name.split('/').at(-1)];
  const Bulk = await (await server.ssrLoadModule('/src/components/Catalogue/selection/SelectionControls.jsx')).SelectionMetadataControls; const Undo = await load('UndoNotice');
  const render = (Component, props) => { const html = renderToStaticMarkup(React.createElement(Component, props)); assert.doesNotMatch(html, /catalogue:|\[object Object\]/); return html; };
  for (const lang of ['fr', 'en', 'it']) {
   await engine.changeLanguage(lang);
   const controls = render(Bulk, { cards: [], busy: true });
   assert.doesNotMatch(controls, /<fieldset|<legend/);
   assert.equal((controls.match(/disabled=""/g) ?? []).length, 7, 'all six age buttons and the free-age button stay disabled while busy');
   for (const status of ['empty', 'expired', 'conflict', 'ready']) assert.equal(render(Undo, { state: { status } }), '');
  }
 } finally { await server.close(); }
});
