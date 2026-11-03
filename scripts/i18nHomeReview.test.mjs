import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentStoredError, presentUserMessage } from '../src/i18n/userMessage.js';
import { presentImportError } from '../src/components/EditPack/importErrorPresentation.js';
const { useProjectLifecycle } = await import('../src/hooks/useProjectLifecycle.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const resources = createTestI18n().options.resources;
i18next.init({ lng: 'fr', resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
const noop = () => {};
function mount({ transformed = null, depth = true, creationError = null } = {}) {
  const previous = window.__TAURI_INTERNALS__.invoke;
  const commands = [];
  window.__TAURI_INTERNALS__.invoke = async (command, params) => {
    commands.push({ command, params });
    if (command === 'create_session_workspace') { if (creationError) throw creationError; return '/tmp/home-review-session'; }
    if (command === 'cleanup_session_workspace') return null;
    throw new Error(`unexpected command ${command}`);
  };
  const refs = Object.fromEntries(['workspaceDirRef', 'savedSnapshotRef', 'autoSavePathRef', 'autoSaveSnapshotRef', 'importedPackPendingMetaRef'].map((key) => [key, { current: null }]));
  let resets = 0; let dialog; let lifecycle;
  const store = { project: {}, setSavePath: noop, setProjectType: noop, resetProject: () => resets++, loadProject: () => ({ allowed: depth, message: '' }), markPristine: noop, isPristine: () => true };
  const app = runner(() => {
    const session = useWorkSession({ store, ...refs, useWorkspaceForNewProjects: false, configuredWorkspaceDir: '', setWorkspaceDirState: noop, setAutoSavedPath: noop, mediaLibraryPaths: [], mediaTags: {}, currentWorkSnapshot: null });
    lifecycle = useProjectLifecycle({ store, ...refs, prepareNewWorkSession: session.prepareNewWorkSession, runFunnelLanding: session.runFunnelLanding, unpackZipIntoBlankProject: async () => transformed, showErrorDialog: (value) => { dialog = value; }, setImportNotice: noop });
  });
  app.render();
  return { get lifecycle() { return lifecycle; }, get dialog() { return dialog; }, get resets() { return resets; }, commands, close() { app.unmount(); window.__TAURI_INTERNALS__.invoke = previous; } };
}

test('refus traversent les vrais lifecycle et runFunnelLanding, conservés au rendu FR → EN → IT', async () => {
  for (const [key, options] of [['noStories', {}], ['depthLimit', { transformed: { project: {} }, depth: false }]]) {
    const c = mount(options);
    try {
      let cause;
      await assert.rejects(c.lifecycle.handleLandEditablePack({ zipPath: 'author.zip', packLabel: 'Auteur' }), (error) => { cause = error; return true; });
      assert.deepEqual(cause, { key: `home:project.landing.${key}`, params: {} });
      assert.equal(c.resets, 1);
      assert.deepEqual(c.commands.map(({ command }) => command), ['create_session_workspace', 'cleanup_session_workspace']);
      const stored = presentImportError(cause);
      const messages = [];
      for (const language of ['fr', 'en', 'it']) {
        await i18next.changeLanguage(language);
        assert.equal(stored.message, resources[language].home[cause.key.slice(5)]);
        assert.equal(presentUserMessage(cause).fallback, false);
        assert.equal(presentUserMessage(cause).code, null);
        assert.doesNotMatch(stored.message, /\[object Object\]|home:|UNEXPECTED_ERROR/);
        messages.push(stored.message);
      }
      assert.equal(new Set(messages).size, 3);
    } finally { c.close(); }
  }
});

test('dialogue de création conservé : code/params intacts et diagnostic séparé pour cause codée ou inconnue', async () => {
  for (const cause of [{ code: 'FILES_SESSION_FOLDER_CREATE_FAILED', params: { error: 'EACCES' }, detail: 'OS_ACCESS_DENIED' }, { code: 'UNKNOWN_SESSION_FIXTURE', params: {}, detail: 'RAW_UNKNOWN_CAUSE' }]) {
    const copy = structuredClone(cause); const c = mount({ creationError: cause });
    try {
      await c.lifecycle.handleSelectProjectType('pack');
      const dialog = c.dialog;
      assert.equal(dialog.message.userMessage, cause);
      assert.equal(dialog.message.codedOnly, true);
      assert.equal(dialog.technicalDetail, cause.detail);
      assert.equal(dialog.title.props.messageKey, 'home:project.creation.title');
      const titles = runner(() => dialog.title.type(dialog.title.props));
      const messages = [];
      try {
        for (const language of ['fr', 'en', 'it']) {
          await i18next.changeLanguage(language);
          assert.equal(titles.render(), resources[language].home['project.creation.title']);
          const presented = presentUserMessage(cause, { allowLegacyFrench: false });
          assert.equal(presented.code, cause.code);
          assert.equal(presented.fallback, cause.code === 'UNKNOWN_SESSION_FIXTURE');
          assert.notEqual(presented.code, 'UNEXPECTED_ERROR');
          const message = presentStoredError(dialog.message); messages.push(message);
          assert.equal(message, resources[language].home['project.landing.preparePrefix'] + presented.message);
          assert.doesNotMatch(message, /OS_ACCESS_DENIED|RAW_UNKNOWN_CAUSE|\[object Object\]/);
          assert.equal(dialog.technicalDetail, cause.detail);
        }
      } finally { titles.unmount(); }
      assert.equal(new Set(messages).size, 3); assert.deepEqual(cause, copy);
    } finally { c.close(); }
  }
});

test('résultat agrégation : pluriels explicites, français historique invariant', async () => {
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const count of [0, 1, 2, 1_000_000]) {
      const expected = language === 'fr' ? `${count} ${count <= 1 ? 'pack agrégé' : 'packs agrégés'}` : language === 'en' ? `${count} audiobook${count === 1 ? '' : 's'} combined` : `${count} ${count === 1 ? 'audiolibro unito' : 'audiolibri uniti'}`;
      assert.equal(i18next.t('home:aggregate.done.packCount', { count }), expected);
    }
  }
});
