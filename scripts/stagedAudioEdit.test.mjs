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
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountEditor(t, { strict = false } = {}) {
  const requests = [];
  const discarded = [];
  const errors = [];
  const confirmed = [];
  globalThis.__audioEditTestInvoke = async (command, args) => {
    if (command === 'audio_edit_info') return { source_path: args.inputPath };
    if (command === 'preview_audio_edit') {
      const request = { ...deferred(), args };
      requests.push(request);
      return request.promise;
    }
    if (command === 'discard_audio_preview') { discarded.push(args.previewPath); return null; }
    throw new Error(`Commande inattendue : ${command}`);
  };
  let filePath = '/travail/source.wav';
  const stableProps = {
    savePath: null, workspaceDir: '/travail', duration: 10, durationRef: { current: 10 },
    trimStart: 1, trimEnd: 4, wsRef: { current: { stop() {} } },
    stopShuttle() {}, rememberWaveViewport() {},
    setError: (error) => { if (error) errors.push(error); },
    onConfirm: (result) => { confirmed.push(result); },
  };
  const hook = runner(() => useStagedAudioEdit({ ...stableProps, filePath }));
  t.after(() => hook.unmount());
  hook.render();
  hook.flush();
  if (strict) hook.replayEffects();
  await settle();
  assert.equal(hook.render().editInfo.source_path, filePath);
  return {
    hook, requests, discarded, errors, confirmed,
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
