import test from 'node:test';
import assert from 'node:assert/strict';
import { register, registerHooks } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tauri-apps/api/core') {
      return {
        url: 'data:text/javascript,export function invoke(command,args){return globalThis.__audioEditTestInvoke(command,args);}',
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
const { useStagedAudioEdit } = await import('../src/components/AudioEditorModal/useStagedAudioEdit.js');
const { useProjectContextValue } = await import('../src/hooks/useProjectContextValue.js');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountEditor(t, { strict = false, isAudioShared } = {}) {
  const requests = [];
  const discarded = [];
  const errors = [];
  const confirmed = [];
  const writes = [];
  globalThis.__audioEditTestInvoke = async (command, args) => {
    if (command === 'audio_edit_info') return { source_path: args.inputPath };
    if (command === 'preview_audio_edit') {
      const request = { ...deferred(), args };
      requests.push(request);
      return request.promise;
    }
    if (command === 'discard_audio_preview') { discarded.push(args.previewPath); return null; }
    if (['apply_audio_edit', 'commit_audio_preview', 'restore_audio_original'].includes(command)) {
      writes.push({ command, args });
      return { output_path: args.preserveInput ? '/travail/copie.flac' : args.inputPath, path_changed: args.preserveInput };
    }
    throw new Error(`Commande inattendue : ${command}`);
  };
  let filePath = '/travail/source.wav';
  const stableProps = {
    savePath: null, workspaceDir: '/travail', duration: 10, durationRef: { current: 10 },
    trimStart: 1, trimEnd: 4, wsRef: { current: { stop() {} } },
    stopShuttle() {}, rememberWaveViewport() {},
    setError: (error) => { if (error) errors.push(error); },
    onConfirm: (result) => { confirmed.push(result); },
    isAudioShared,
  };
  const hook = runner(() => useStagedAudioEdit({ ...stableProps, filePath }));
  t.after(() => hook.unmount());
  hook.render();
  hook.flush();
  if (strict) hook.replayEffects();
  await settle();
  assert.equal(hook.render().editInfo.source_path, filePath);
  return {
    hook, requests, discarded, errors, confirmed, writes,
    changeFile(path) { filePath = path; hook.render(); hook.flush(); },
  };
}

for (const strict of [false, true]) {
  for (const mode of ['cut', 'trim']) {
    test(`${mode} puis fondu restent validables après ${strict ? 'rejeu StrictMode' : 'montage ordinaire'}`, async (t) => {
      const f = await mountEditor(t, { strict });
      const action = f.hook.render().handleStageAction(mode);
      f.requests[0].resolve('/travail/apercu-1.flac');
      assert.equal((await action).status, 'applied');
      assert.equal(f.hook.render().previewPath, '/travail/apercu-1.flac');
      assert.equal(f.hook.render().canValidate, true);
      const fade = f.hook.render().regenerateFadePreview({ fadeInSec: 0.25 });
      assert.equal(f.requests[1].args.fadeInSec, 0.25);
      f.requests[1].resolve('/travail/apercu-2.flac');
      assert.equal((await fade).status, 'applied');
      assert.equal(f.hook.render().previewPath, '/travail/apercu-2.flac');
      assert.equal(f.hook.render().canValidate, true);
      assert.deepEqual(f.discarded, ['/travail/apercu-1.flac']);
      assert.deepEqual(f.errors, []);
    });
  }
}

test('un vrai démontage jette la réponse tardive après le rejeu des effets', async (t) => {
  const f = await mountEditor(t, { strict: true });
  const action = f.hook.render().handleStageAction('cut');
  f.hook.unmount();
  f.requests[0].resolve('/travail/tardif.flac');
  assert.equal((await action).status, 'stale');
  assert.deepEqual(f.discarded, ['/travail/tardif.flac']);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.confirmed, []);
});

function sharingFor(project, advancedMediaUsages = null) {
  return useProjectContextValue({
    project, advancedMediaUsages, sdStore: {}, xttsStore: {},
  }).isAudioShared;
}

const sharedPath = '/travail/source.wav';
const sharedProjects = [
  ['histoires dupliquées', { rootEntries: [
    { type: 'story', id: 'a', audio: sharedPath },
    { type: 'story', id: 'b', audio: sharedPath },
  ] }],
  ['deux champs du même écran', { rootEntries: [
    { type: 'story', id: 'a', audio: sharedPath, itemAudio: sharedPath },
  ] }],
  ['voix de deux dossiers', { rootEntries: [
    { type: 'menu', id: 'a', audio: sharedPath },
    { type: 'menu', id: 'b', audio: sharedPath },
  ] }],
  ['deux écrans du graphe', {
    authoringMode: 'advanced', authoring: { mediaBindings: [{ assetRef: 'voice', path: sharedPath }] },
  }, [{ assetRef: 'voice', usages: [{ nodePath: 'a', field: 'audio' }, { nodePath: 'b', field: 'audio' }] }]],
  ['deux liaisons du graphe vers le même fichier', {
    authoringMode: 'advanced', authoring: { mediaBindings: [
      { assetRef: 'voice-a', path: sharedPath }, { assetRef: 'voice-b', path: sharedPath },
    ] },
  }, [{ assetRef: 'voice-a', usages: [{ nodePath: 'a', field: 'audio' }] },
    { assetRef: 'voice-b', usages: [{ nodePath: 'b', field: 'audio' }] }]],
];

for (const [label, project, usages] of sharedProjects) {
  for (const chained of [false, true]) {
    test(`${label} : ${chained ? 'commit' : 'apply'} protège le fichier partagé`, async (t) => {
      const f = await mountEditor(t, { isAudioShared: sharingFor(project, usages) });
      const action = f.hook.render().handleStageAction('trim');
      f.requests[0].resolve('/travail/preview-1.wav');
      await action;
      if (chained) {
        const next = f.hook.render().handleStageAction('cut');
        f.requests[1].resolve('/travail/preview-2.wav');
        await next;
      }
      await f.hook.render().handleApply();
      assert.equal(f.writes[0].command, chained ? 'commit_audio_preview' : 'apply_audio_edit');
      assert.equal(f.writes[0].args.inputPath, sharedPath);
      assert.equal(f.writes[0].args.preserveInput, true);
      assert.equal(f.confirmed[0].output_path, '/travail/copie.flac');
      assert.deepEqual(f.errors, []);
    });
  }
}

test('un seul emploi conserve la retouche sur place', async (t) => {
  const f = await mountEditor(t, { isAudioShared: sharingFor({ rootAudio: sharedPath }) });
  const action = f.hook.render().handleStageAction('trim');
  f.requests[0].resolve('/travail/preview.wav');
  await action;
  await f.hook.render().handleApply();
  assert.equal(f.writes[0].args.preserveInput, false);
  assert.equal(f.confirmed[0].output_path, sharedPath);
});

test('restaurer un son partagé protège les autres champs', async (t) => {
  const f = await mountEditor(t, { isAudioShared: sharingFor(sharedProjects[0][1]) });
  await f.hook.render().handleRestoreOriginal();
  assert.equal(f.writes[0].command, 'restore_audio_original');
  assert.equal(f.writes[0].args.preserveInput, true);
  assert.equal(f.confirmed[0].output_path, '/travail/copie.flac');
});

test('changer de fichier invalide la réponse de l’ancien fichier et permet le nouvel aperçu', async (t) => {
  const f = await mountEditor(t, { strict: true });
  const oldAction = f.hook.render().handleStageAction('trim');
  f.changeFile('/travail/autre.wav');
  await settle();
  const newAction = f.hook.render().handleStageAction('cut');
  f.requests[1].resolve('/travail/courant.flac');
  assert.equal((await newAction).status, 'applied');
  f.requests[0].resolve('/travail/obsolete.flac');
  assert.equal((await oldAction).status, 'stale');
  assert.equal(f.hook.render().previewPath, '/travail/courant.flac');
  assert.equal(f.hook.render().canValidate, true);
  assert.deepEqual(f.discarded, ['/travail/obsolete.flac']);
});
