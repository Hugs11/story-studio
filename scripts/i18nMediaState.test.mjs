import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { runner } from './reactHookDriver.mjs';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';

// Résolution Vite (imports sans extension) et plugin fs Tauri absent de Node.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tauri-apps/plugin-fs') return { url: `data:text/javascript,${encodeURIComponent('export const readFile = async () => { throw new Error("absent"); }; export const writeFile = async () => {}; export const mkdir = async () => {};')}`, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.includes('/src/')) {
      return { url: new URL(`${specifier}.js`, context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// Hooks de production chargés après l'ordonnanceur de test (seul double).
const { useMediaToolBridge } = await import('../src/hooks/useMediaToolBridge.js');
const { useMediaImageEdit } = await import('../src/components/MediaExplorer/useMediaImageEdit.js');
const { presentMedia } = await import('../src/i18n/mediaPresentation.js');

const project = { projectType: 'pack', rootEntries: [
  { id: 'm1', type: 'menu', name: '_AUTHOR_MENU_', children: [{ id: 's1', type: 'story', name: '_AUTHOR_S1_', audio: '/a.wav' }] },
], globalOptions: {} };

test('outil audio refusé : dialogue ouvert relu FR → EN → IT, code et projet intacts', async () => {
  i18next.init(createTestI18n().options);
  const dialogs = [];
  const before = JSON.stringify(project);
  const hook = runner(() => useMediaToolBridge({ project, statusByPath: {}, openMediaTab: () => assert.fail('aucun onglet'), mutations: {}, showErrorDialog: (dialog) => dialogs.push(dialog) }));
  const bridge = hook.render();
  const built = bridge.openMediaAudioTool({ entryIds: ['m1'], origin: 'tree', tool: 'split' });
  assert.equal(built.valid, false); assert.equal(built.code, 'mixed-selection'); assert.notEqual(built.code, 'split-count');
  assert.equal(dialogs.length, 1);
  const seen = {};
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    // Même objet de dialogue : seuls ses accesseurs relisent la langue.
    seen[lng] = [dialogs[0].title, dialogs[0].message];
    assert.equal(dialogs[0].title, i18next.t('media:tool.unavailable.title'));
    assert.equal(dialogs[0].message, i18next.t('media:tool.refusal.mixedSelection'));
  }
  assert.equal(seen.fr[0], 'Outil audio indisponible');
  assert.notEqual(seen.en[0], seen.fr[0]); assert.notEqual(seen.it[1], seen.fr[1]);
  const validation = bridge.validateRequest({ requestId: 'absent' });
  assert.equal(validation.code, 'inactive-request');
  assert.deepEqual(validation.reasonRef, { key: 'media:tool.refusal.inactiveRequest' });
  assert.equal(JSON.stringify(project), before);
  await i18next.changeLanguage('fr');
});

test('édition d’image : avertissement et toast retenus en descripteurs', async () => {
  i18next.init(createTestI18n().options);
  const dialogs = [];
  const hook = runner(() => useMediaImageEdit({ workspaceDir: '', mediaTags: {}, onAddMediaTag: () => {}, onMediaCreated: null, onCreated: () => {}, showErrorDialog: (dialog) => dialogs.push(dialog) }));
  const edit = hook.render();
  await edit.openImageEditor({ kind: 'image', exists: true, path: '/_AUTHOR_.png' });
  assert.equal(dialogs.length, 1); assert.equal(edit.editSession, null);
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    assert.equal(dialogs[0].title, i18next.t('media:imageEdit.unavailable.title'));
    assert.equal(dialogs[0].message, i18next.t('media:imageEdit.unavailable.message'));
    assert.equal(presentMedia({ key: 'media:imageEdit.created.notice' }), i18next.t('media:imageEdit.created.notice'));
  }
  assert.equal(dialogs[0].variant, 'warning');
  await i18next.changeLanguage('fr');
});
