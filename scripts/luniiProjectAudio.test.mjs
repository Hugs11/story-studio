import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectToRustExport } from '../src/store/projectModel/schema.js';
import { advancedPackAudioOptions } from '../src/store/production/packAudioOptions.js';
import { buildExportRequest } from '../src/store/advancedExport/exportRequest.js';
import { createLuniiDeviceApi } from '../src/store/catalogue/luniiDeviceApi.js';
import { KEYS } from '../src/store/persistentSettings.js';

// The inline Rust oracle was captured from the editor at commit 93aa045a,
// using git show, before changing the send path. Keep the live editor aligned.
const source = readFileSync(new URL('../src-tauri/src/services/storyteller/send.rs', import.meta.url), 'utf8');
const cases = JSON.parse(source.match(/const EDITOR_AUDIO_CASES: &str = r#"([\s\S]*?)"#;/)[1]);

for (const { name, project, defaults, expected } of cases) {
  test(`saved editor audio reference: ${name}`, () => {
    let actual;
    if (project.authoringMode === 'advanced') {
      const { options } = buildExportRequest({
        project: { ...project, authoring: { payload: '{}' } }, outputFolder: '/export',
        options: advancedPackAudioOptions(project.globalOptions, defaults),
      });
      actual = [options.silenceMode, options.harmonizeLoudness,
        options.leadingSilenceSec ?? 0.4, options.trailingSilenceSec ?? 0.4];
    } else {
      const { globalOptions: options } = projectToRustExport(project, defaults);
      actual = [options.silenceMode, options.harmonizeLoudness,
        options.addSilenceDurationSec.start, options.addSilenceDurationSec.end];
    }
    assert.deepEqual(actual, expected);
  });
}

test('direct send carries current silence preferences for projects without overrides', async (t) => {
  const previous = globalThis.localStorage;
  const settings = new Map([[KEYS.PACK_LEADING_SILENCE_SECONDS, '1.25'], [KEYS.PACK_TRAILING_SILENCE_SECONDS, '2.5']]);
  globalThis.localStorage = { getItem: key => settings.get(key) ?? null };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  const calls = [];
  const api = createLuniiDeviceApi({ invoke: async (command, args) => { calls.push([command, args]); } });
  await api.send({ deviceId: 'd', selection: [{ exemplarId: 'saved', expectedRevision: 2 }], requestId: 'r' });
  assert.equal(calls[0][0], 'lunii_device_send');
  assert.deepEqual(calls[0][1].audioEdgeSilence, { leading: 1.25, trailing: 2.5 });
  settings.set(KEYS.PACK_LEADING_SILENCE_SECONDS, '0');
  await api.send({ deviceId: 'd', selection: [], requestId: 'r2' });
  assert.deepEqual(calls[1][1].audioEdgeSilence, { leading: 0, trailing: 2.5 });
});
