// Harnais lancé par le test Rust : le seul double est la WebView. Les requêtes
// invoke sont acheminées au vrai handler Tauri, jamais validées par un DTO JS.
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { mockIPC } from '@tauri-apps/api/mocks';
import { decodeProjectFile, encodeProjectFile } from '../src/store/projectModel/codec.js';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => JSON.parse((await lines.next()).value);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
globalThis.window = { crypto: globalThis.crypto };
mockIPC(async (cmd, args) => {
  send({ kind: 'invoke', cmd, args });
  const response = await receive();
  if ('error' in response) throw response.error;
  return response.result;
});
const { payload } = await receive();
let project = {
  schemaVersion: 4, authoringMode: 'advanced', projectType: 'advanced', rootEntries: [],
  authoring: { payload, editorState: { version: 1 }, mediaBindings: [] },
};
for (let cycle = 0; cycle < 2; cycle++) {
  const decoded = await decodeProjectFile(encodeProjectFile(project));
  assert.equal(decoded.project.authoring.payload, payload);
  assert.equal(decoded.summary.payloadVersion, 1);
  project = structuredClone(decoded.project);
}
const invalid = structuredClone(project);
invalid.authoring.payload = '{';
await assert.rejects(decodeProjectFile(encodeProjectFile(invalid), { fileName: 'broken.mbah' }),
  error => error.code === 'INVALID_PAYLOAD_JSON' && error.fileName === 'broken.mbah');
send({ kind: 'done', payload: project.authoring.payload });
process.stdin.destroy();
