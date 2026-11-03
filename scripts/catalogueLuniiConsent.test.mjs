import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLuniiPermission } from '../src/store/catalogue/luniiConsent.js';
import { createCatalogueApi } from '../src/store/catalogue/catalogueApi.js';

test('question closes without response; either durable answer prevents another question', async () => {
  let permission = null, questions = 0, writes = 0;
  const api = { luniiPermission: async () => permission, setLuniiPermission: async value => { permission = value; writes++; } };
  const ask = value => async () => { questions++; return value; };
  await askLuniiPermission(api, ask(null));
  assert.equal(writes, 0);
  await askLuniiPermission(api, ask(false));
  await askLuniiPermission(api, ask(true));
  assert.equal(questions, 2);
  assert.equal(permission, false);
  await api.setLuniiPermission(true);
  await askLuniiPermission(api, ask(false));
  assert.equal(questions, 2);
  assert.equal(permission, true);
});

test('settings sends both checkbox directions to the durable Rust boundary', async () => {
  const calls = [];
  const api = createCatalogueApi({ invoke: async (command, args) => { calls.push([command, args]); return null; }, listen: async () => () => {} });
  await api.setLuniiPermission(true);
  await api.setLuniiPermission(false);
  assert.deepEqual(calls.map(([command, args]) => [command, args.allowed]), [['catalogue_lunii_set_permission', true], ['catalogue_lunii_set_permission', false]]);
});

test('mounted settings toggle reads and persists both directions', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { installMountedDom } = await import('./treeMountedDom.mjs');
  const { createServer } = await import('./viteTestServer.mjs');
  const { default: react } = await import('@vitejs/plugin-react');
  const dom = installMountedDom();
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); initializeI18n('fr');
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { LuniiPermission } = await server.ssrLoadModule('/src/tabs/OptionsTab/LuniiPermission.jsx');
    let permission = false;
    const calls = [];
    const api = { luniiPermission: async () => permission, setLuniiPermission: async value => { permission = value; calls.push(value); } };
    await React.act(async () => root.render(React.createElement(ErrorDialogProvider, null, React.createElement(LuniiPermission, { api }))));
    const input = host.querySelector('.tog');
    assert.equal(input.getAttribute('aria-pressed'), 'false'); assert.equal(input.disabled, false);
    for (const checked of [true, false]) {
      const props = input[Object.keys(input).find(key => key.startsWith('__reactProps$'))];
      await React.act(async () => props.onClick());
      assert.equal(input.getAttribute('aria-pressed'), String(checked)); assert.equal(permission, checked);
    }
    assert.deepEqual(calls, [true, false]);
  } finally { await React.act(async () => root.unmount()); await server.close(); dom.restore(); }
});
