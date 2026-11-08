import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { installMountedDom, click } from './treeMountedDom.mjs';

test('import notices share the stack, preserve paragraphs and dismiss through a named close button', async () => {
  const dom = installMountedDom();
  dom.document.getElementById = id => dom.document.body.querySelectorAll('*').find(node => node.id === id || node.getAttribute('id') === id) ?? null;
  const server = await createServer({ configFile: false, plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  let root;
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const runtime = initializeI18n('fr');
    const { AppModals } = await server.ssrLoadModule('/src/components/AppModals.jsx');
    const { NotificationToast } = await server.ssrLoadModule('/src/components/common/NotificationToast.jsx');
    const { presentStoredError } = await server.ssrLoadModule('/src/i18n/userMessage.js');
    const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
    root = createRoot(host);
    const structured = { parts: [{ key: 'import:pack.transitions.notice' }, { key: 'import:pack.autoNext.notice' }], separator: '\n\n' };
    let actions = 0;
    for (const language of ['fr', 'en', 'it']) {
      await act(async () => runtime.changeLanguage(language));
      for (const message of [structured, 'Premier paragraphe.\n\nDeuxième paragraphe.\nUne autre ligne.']) {
        let showNotice;
        function Surface() {
          const [notice, setNotice] = React.useState(null);
          showNotice = () => setNotice(message);
          return React.createElement(React.Fragment, null,
            React.createElement(NotificationToast, { visible: true, title: 'Episodes', actionLabel: 'Open', onAction: () => actions++, onClose() {} }),
            React.createElement(AppModals, { modals: { isOpen: () => false }, project: {}, packMetadata: {}, sdGenerate: {},
              importNotice: notice, setImportNotice: setNotice }));
        }
        await act(async () => root.render(React.createElement(Surface, { key: language + JSON.stringify(message) })));
        const stack = dom.document.getElementById('notification-toast-stack');
        const region = stack.querySelectorAll('.media-subscriptions-toast-region')[1];
        assert.equal(region.getAttribute('role'), 'status');
        assert.equal(region.getAttribute('aria-live'), 'polite');
        assert.equal(region.textContent, '');
        await act(async () => showNotice());
        assert.equal(stack.querySelectorAll('.media-subscriptions-toast-region')[1], region, 'live region exists before content appears');
        assert.equal(stack.querySelectorAll('.media-subscriptions-toast').length, 2);
        assert.equal(host.querySelector('.media-subscriptions-toast'), null, 'notices are portalled into the common stack');
        assert.equal(dom.document.body.querySelector('.import-notice'), null);
        const notice = stack.querySelectorAll('.media-subscriptions-toast')[1];
        assert.equal(notice.querySelector('strong').textContent, runtime.t('common:appModals.importNotice.title'));
        assert.equal(notice.querySelector('span').textContent, presentStoredError(message));
        assert.ok(notice.querySelector('span').textContent.includes('\n\n'));
        const detail = notice.querySelector('span');
        assert.equal(detail.getAttribute('tabindex'), '0');
        assert.equal(detail.getAttribute('role'), 'region');
        assert.equal(detail.getAttribute('aria-labelledby'), notice.querySelector('strong').getAttribute('id'));
        assert.ok(notice.getAttribute('class').includes('notification-toast-long-detail'));
        assert.ok(!stack.querySelector('.media-subscriptions-toast').getAttribute('class').includes('notification-toast-long-detail'));
        assert.equal(notice.querySelectorAll('button').length, 1, 'no empty action button');
        const close = notice.querySelector('button');
        assert.equal(close.getAttribute('aria-label'), runtime.t('common:dialog.close.label'));
        await act(async () => click(close));
        assert.equal(stack.querySelectorAll('.media-subscriptions-toast').length, 1);
        assert.equal(stack.querySelectorAll('.media-subscriptions-toast-region')[1], region, 'live region remains mounted after dismissal');
        await act(async () => click(stack.querySelector('button')));
      }
    }
    assert.equal(actions, 6, 'existing action callers still work');
    const css = readFileSync(new URL('../src/components/common/NotificationToast.css', import.meta.url), 'utf8');
    assert.match(css, /max-height:\s*min\(50vh, 360px\)/);
    assert.match(css, /overflow-y:\s*auto/);
    assert.match(css, /white-space:\s*pre-wrap/);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.restore();
  }
});
