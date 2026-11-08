import assert from 'node:assert/strict';
import test from 'node:test';
const memory = new Map();
globalThis.localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
};
const { KEYS } = await import('../src/store/persistentSettings.js');
const releaseUrl = 'https://github.com/Hugs11/story-studio/releases/tag/v0.9.11';
async function fresh() {
  memory.clear();
  return import(`../src/store/releaseNotice.js?test=${Math.random()}`);
}
test('préférence absente : question initiale, après les dialogues ; refus mémorisé', async () => {
  const m = await fresh();
  assert.equal(m.readReleaseConsent(), null);
  assert.equal(m.shouldAskReleaseConsent(m.readReleaseConsent(), false), true);
  assert.equal(m.shouldAskReleaseConsent(m.readReleaseConsent(), true), false);
  m.writeReleaseConsent(false);
  assert.equal(m.readReleaseConsent(), false);
  assert.equal(m.shouldAskReleaseConsent(m.readReleaseConsent(), false), false);
  assert.equal(memory.get(KEYS.RELEASE_CHECK_ENABLED), 'false');
  assert.equal(await m.checkReleaseOnce(() => assert.fail('requête sans accord')), null);
  memory.set(KEYS.RELEASE_CHECK_ENABLED, 'true');
  const reloaded = await import(`../src/store/releaseNotice.js?reload=${Math.random()}`);
  assert.equal(reloaded.shouldAskReleaseConsent(reloaded.readReleaseConsent(), false), false);
});
test('interrupteur : suit les changements et persiste le choix', async () => {
  const m = await fresh();
  let calls = 0;
  const stop = m.subscribeReleaseConsent(() => calls++);
  m.writeReleaseConsent(true);
  assert.equal(m.readReleaseConsent(), true);
  assert.equal(memory.get(KEYS.RELEASE_CHECK_ENABLED), 'true');
  m.writeReleaseConsent(false);
  assert.equal(calls, 2);
  stop();
});
test('24 h : lancement, doublons simultanés, limite exacte et échecs silencieux', async () => {
  const m = await fresh();
  const now = 1_000_000;
  let requests = 0;
  const invoke = async (command, args) => {
    requests++;
    assert.equal(command, 'check_stable_release');
    assert.deepEqual(args, { enabled: true });
    return { version: '0.9.11', url: releaseUrl };
  };
  assert.equal(await m.checkReleaseOnce(invoke, now), null);
  assert.equal(requests, 0);
  m.writeReleaseConsent(true);
  const first = m.checkReleaseOnce(invoke, now);
  assert.equal(m.checkReleaseOnce(invoke, now), first);
  assert.equal((await first).version, '0.9.11');
  assert.equal(memory.get(KEYS.RELEASE_CHECK_AT), String(now));
  assert.equal(await m.checkReleaseOnce(invoke, now + m.RELEASE_CHECK_INTERVAL - 1), null);
  await m.checkReleaseOnce(invoke, now + m.RELEASE_CHECK_INTERVAL);
  assert.equal(requests, 2);
  const reload = await import(`../src/store/releaseNotice.js?reload=${Math.random()}`);
  assert.equal(await reload.checkReleaseOnce(invoke, now + m.RELEASE_CHECK_INTERVAL + 1), null);
  assert.equal(await m.checkReleaseOnce(async () => { throw Error('offline'); }, now + 2 * m.RELEASE_CHECK_INTERVAL), null);
  assert.equal(await m.checkReleaseOnce(invoke, now + 2 * m.RELEASE_CHECK_INTERVAL + 1), null);
});
test('horloge reculée : une date future déclenche une vérification et revient au délai normal', async () => {
  const m = await fresh();
  m.writeReleaseConsent(true);
  const now = 1_000_000;
  memory.set(KEYS.RELEASE_CHECK_AT, String(now + m.RELEASE_CHECK_INTERVAL));
  assert.equal(m.releaseCheckDue(true, now + 1, now), true);
  let requests = 0;
  const invoke = async () => { requests++; return null; };
  await m.checkReleaseOnce(invoke, now);
  assert.equal(requests, 1);
  assert.equal(memory.get(KEYS.RELEASE_CHECK_AT), String(now));
  await m.checkReleaseOnce(invoke, now - 1);
  assert.equal(requests, 2);
  await m.checkReleaseOnce(invoke, now);
  assert.equal(requests, 2);
});
test('un avis par version, conservé après fermeture et relancement', async () => {
  const m = await fresh();
  m.writeReleaseConsent(true);
  const notice = { version: '0.9.11', url: releaseUrl };
  assert.equal(m.claimReleaseNotice(notice), true);
  assert.equal(m.claimReleaseNotice(notice), false);
  const reload = await import(`../src/store/releaseNotice.js?reload=${Math.random()}`);
  assert.equal(reload.claimReleaseNotice(notice), false);
  assert.equal(reload.claimReleaseNotice({ ...notice, version: '0.10.0' }), true);
});
test('refus pendant une requête et réponses non autorisées : aucun avis', async () => {
  const m = await fresh();
  m.writeReleaseConsent(true);
  let resolve;
  const pending = m.checkReleaseOnce(() => new Promise(r => { resolve = r; }));
  await Promise.resolve();
  m.writeReleaseConsent(false);
  resolve({ version: '1.0.0', url: releaseUrl });
  assert.equal(await pending, null);
  assert.equal(m.claimReleaseNotice({ version: '1.0.0', url: releaseUrl }), false);
  for (const url of ['http://github.com/Hugs11/story-studio/releases/tag/v1', 'https://github.com.evil/Hugs11/story-studio/', 'https://github.com/Hugs11/other/releases/tag/v1', 'https://github.com/Hugs11/story-studio/../other', 'https://github.com/Hugs11/story-studio/releases/../../other', 'invalid']) {
    assert.equal(m.allowedReleaseUrl(url), false);
  }
  assert.equal(m.allowedReleaseUrl(releaseUrl), true);
});

test('Préférences > Interface et attente des dialogues de démarrage', async t => {
  const { createServer } = await import('./viteTestServer.mjs');
  const { default: react } = await import('@vitejs/plugin-react');
  const { default: React } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const server = await createServer({ configFile: false, plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    memory.clear();
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    initializeI18n('fr');
    const { InterfaceSection } = await server.ssrLoadModule('/src/tabs/OptionsTab/InterfaceSection.jsx');
    const state = await server.ssrLoadModule('/src/store/releaseNotice.js');
    const render = () => renderToStaticMarkup(React.createElement(InterfaceSection, { themePreference: 'system' }));
    assert.match(render(), /aria-pressed="false" aria-label="Prévenir des nouvelles versions"/);
    state.writeReleaseConsent(true);
    assert.match(render(), /aria-pressed="true" aria-label="Prévenir des nouvelles versions"/);
    state.writeReleaseConsent(false);
    const html = render();
    assert.match(html, /aria-pressed="false" aria-label="Prévenir des nouvelles versions"/);
    assert.ok(html.indexOf('ui-language') < html.indexOf('Prévenir des nouvelles versions'));
    assert.ok(html.indexOf('Raccourcis') < html.indexOf('Prévenir des nouvelles versions'));
    assert.ok(html.includes("Rien n&#x27;est téléchargé ni installé automatiquement."));
    await t.test('la question attend la fermeture ; les mises à jour sans dialogue ne la retardent pas', async () => {
      const { waitForDialogSpace } = await server.ssrLoadModule('/src/components/ReleaseNotice.jsx');
      const saved = Object.fromEntries(['document', 'MutationObserver', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
      let modalOpen = true, changed, ready = 0, id = 0;
      const timers = new Map();
      try {
        globalThis.document = { querySelector: () => modalOpen ? {} : null };
        globalThis.MutationObserver = class {
          constructor(callback) { changed = callback; }
          observe() {}
          disconnect() {}
        };
        globalThis.setTimeout = callback => { timers.set(++id, callback); return id; };
        globalThis.clearTimeout = key => timers.delete(key);
        const stop = waitForDialogSpace(() => ready++);
        assert.equal(timers.size, 0);
        modalOpen = false; changed();
        assert.equal(timers.size, 1);
        const firstId = id;
        changed();
        assert.equal(id, firstId);
        modalOpen = true; changed();
        assert.equal(timers.size, 0);
        assert.equal(ready, 0);
        modalOpen = false; changed();
        timers.get(id)();
        assert.equal(ready, 1);
        stop();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
      }
    });
  } finally { await server.close(); }
});

test('avis : ouvrir ferme le toast ; question décrite et refus par Échap conservé', async () => {
  const { createServer } = await import('./viteTestServer.mjs');
  const { default: react } = await import('@vitejs/plugin-react');
  const notice = { version: '0.9.11', url: releaseUrl };
  const slots = [true, notice];
  let cursor = 0, consent = true;
  const opened = [], answers = [];
  globalThis.__releaseNoticeTest = {
    useEffect() {},
    useState: () => { const index = cursor++; return [slots[index], value => { slots[index] = value; }]; },
    useTranslation: () => ({ t: key => key }),
    useReleaseConsent: () => consent,
    openUrl: url => { opened.push(url); return Promise.resolve(); },
    writeReleaseConsent: value => answers.push(value),
  };
  const server = await createServer({ configFile: false, plugins: [{
    name: 'release-notice-controlled-runtime', enforce: 'pre',
    transform(source, id) {
      if (!id.endsWith('/src/components/ReleaseNotice.jsx')) return;
      return source
        .replace("import { useEffect, useState } from 'react';", 'const { useEffect, useState } = globalThis.__releaseNoticeTest;')
        .replace("import { useTranslation } from 'react-i18next';", 'const { useTranslation } = globalThis.__releaseNoticeTest;')
        .replace("import { openUrl } from '@tauri-apps/plugin-opener';", 'const { openUrl } = globalThis.__releaseNoticeTest;')
        .replace("import { useReleaseConsent } from '../hooks/useReleaseConsent.js';", 'const { useReleaseConsent } = globalThis.__releaseNoticeTest;')
        .replace(', writeReleaseConsent }', ' }')
        .replace('// Wait for the startup', 'const { writeReleaseConsent } = globalThis.__releaseNoticeTest;\n// Wait for the startup');
    },
  }, react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { ReleaseNotice } = await server.ssrLoadModule('/src/components/ReleaseNotice.jsx');
    const render = () => { cursor = 0; return ReleaseNotice().props.children; };
    render()[1].props.onAction();
    assert.deepEqual(opened, [releaseUrl]);
    assert.equal(render()[1].props.visible, false);
    consent = null;
    const dialog = render()[0];
    const description = dialog.props.children[1];
    const attributes = {};
    description.props.ref({ closest: selector => {
      assert.equal(selector, 'dialog');
      return { setAttribute: (key, value) => { attributes[key] = value; } };
    } });
    assert.equal(attributes['aria-describedby'], description.props.id);
    assert.equal(dialog.props.children[2].props.children[0].props.id, 'release-check-decline');
    dialog.props.onClose();
    assert.deepEqual(answers, [false]);
    assert.equal(render()[0], false);
  } finally {
    await server.close();
    delete globalThis.__releaseNoticeTest;
  }
});
