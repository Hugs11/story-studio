import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';

test('Lunii surfaces render FR/EN/IT and expanded labels with accessible writing guards', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const { pseudoResources } = await server.ssrLoadModule('/src/i18n/pseudo.js');
    const { LuniiPanel } = await server.ssrLoadModule('/src/components/Catalogue/lunii/LuniiPanel.jsx');
    const { FicheDialog } = await server.ssrLoadModule('/src/components/Catalogue/fiche/FicheDialog.jsx');
    const { luniiRows } = await server.ssrLoadModule('/src/store/catalogue/luniiDevices.js');
    const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
    const device = { id: 'device', name: 'Lunii du salon', metadataVersion: 9, state: 'readOnly', stories: [
      { key: 'visible', title: 'La forêt', kind: 'creation' }, { key: 'hidden', title: 'La mer', hidden: true, kind: 'official' }, { key: 'unknown', kind: 'unknown', parkingPending: true },
    ], orphans: [{ key: 'parked:recovered', parked: true, complete: true }, { key: 'incomplete', complete: false }], banner: ['damagedTruncated', 'resume', 'readOnly', 'orphans'], totalBytes: 1000, freeBytes: 400 };
    const state = { luniiDevices: [device], activeLuniiId: device.id, luniiPanelWidth: 330, selection: { side: 'lunii', ids: ['visible'] }, store: {} };
    const original = structuredClone(engine.getResourceBundle('fr', 'catalogue'));
    for (const language of ['fr', 'en', 'it', 'expanded']) {
      if (language === 'expanded') { engine.addResourceBundle('fr', 'catalogue', pseudoResources(original), true, true); await engine.changeLanguage('fr'); }
      else await engine.changeLanguage(language);
      const panel = render(LuniiPanel, { lunii: state });
      assert.doesNotMatch(panel, /catalogue:|\[object Object\]|parkingPending/);
      assert.match(panel, /role="grid"/); assert.match(panel, /aria-selected="true"/);
      assert.match(panel, /<progress[^>]*aria-label=/);
      assert.match(panel, /aria-disabled="true"/);
      const ejectLabel = engine.t('catalogue:lunii.eject').replaceAll('"', '&quot;');
      const eject = panel.match(new RegExp(`<button[^>]*aria-label="${ejectLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`))?.[0];
      assert.ok(eject); assert.doesNotMatch(eject, /disabled=/);
      for (const status of ['detected', 'opening', 'unsupported', 'ejected', 'disconnected']) {
        assert.doesNotMatch(render(LuniiPanel, { lunii: { ...state, luniiDevices: [{ ...device, state: status }] } }), /catalogue:|\[object Object\]/);
      }
      const rows = luniiRows(device);
      const fiche = render(FicheDialog, { card: { id: 'visible' }, lunii: { device, story: rows[0], rows } });
      assert.doesNotMatch(fiche, /catalogue:|\[object Object\]/);
      assert.match(fiche, /role="separator"/);
    }
    engine.addResourceBundle('fr', 'catalogue', original, true, true);
  } finally { await server.close(); }
});
