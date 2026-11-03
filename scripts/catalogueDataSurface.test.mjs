import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { createDraft, draftReducer, mergeDraft } from '../src/store/catalogue/metadataDraft.js';
import { fieldId } from '../src/store/catalogue/cardModel.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/catalogue/card-detail.json', import.meta.url)));
test('editable fiche FR/EN/IT: one title field and conflicts (FICHEC) without provenance or comparison', async () => {
 const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
 try {
  const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
  const { FicheEditSurface } = await server.ssrLoadModule('/src/components/Catalogue/fiche/FicheEditPanel.jsx');
  for (const language of ['fr', 'en', 'it']) {
   await engine.changeLanguage(language);
   const card = structuredClone(fixture); card.reference.state = 'unavailable'; card.exemplars.push({ ...card.exemplars[0], id: 'missing', path: '/missing.mbah', availability: 'unavailable', fields: null, stale: true });
   let draft = draftReducer(createDraft(card), { type: 'edit', id: fieldId({ field: 'title' }), patch: { state: 'defined', value: '<Draft>' } });
   draft.conflicts[fieldId({ field: 'title' })] = { theirs: { state: 'defined', value: '<Server>' } };
   const html = renderToStaticMarkup(React.createElement(FicheEditSurface, { card, field: 'title', draft, dirty: true, dispatch() {} }));
   assert.doesNotMatch(html, /catalogue:|\[object Object\]/); assert.doesNotMatch(html, /<caption>|missing.mbah/); assert.match(html, /&lt;Draft&gt;/); assert.match(html, /&lt;Server&gt;/);
   const fresh = structuredClone(card);
   fresh.fields[0].effective = { value: '<New reference>', origin: 'reference' };
   fresh.fields[0].referenceValue = { value: '<New reference>', provenanceId: 'new-reference' };
   fresh.provenance.push({ id: 'new-reference', kind: 'file', exemplarId: 'new' });
   fresh.exemplars.push({ id: 'new', path: '/new-reference.mbah', fields: {} });
   const merged = mergeDraft(draftReducer(createDraft(card), { type: 'edit', id: fieldId({ field: 'title' }), patch: { state: 'defined', value: '<Ours>' } }), fresh);
   const changed = renderToStaticMarkup(React.createElement(FicheEditSurface, { card: fresh, field: 'title', draft: merged, dirty: true, dispatch() {} }));
   assert.match(changed, /&lt;New reference&gt;/); assert.doesNotMatch(changed, /new-reference.mbah/);
   assert.match(changed, /&lt;Ours&gt;/);

  }
 } finally { await server.close(); }
});
