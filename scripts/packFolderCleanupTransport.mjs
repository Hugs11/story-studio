// Test JS piloté par folder_pack_cleanup_js_uses_the_real_native_file_only_deletion.
// Le helper est intact ; sa demande de suppression est relayée à la vraie
// commande Rust. Aucune doublure unlink ne représente le nettoyage natif.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { keepFolderPackInProject } from '../src/utils/packFolder.js';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => JSON.parse((await lines.next()).value);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const { root, target, preserved } = await receive();
const staging = path.join(root, 'staging');
const staged = path.join(staging, '.Histoire.zip');
await fs.mkdir(staging);
await fs.writeFile(staged, 'created archive');
let current = true;

const kept = await keepFolderPackInProject('/source/.Histoire', async source => {
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  current = false;
  return target;
}, {
  workspaceDir: root,
  isCurrent: () => current,
  call: async (command, args) => {
    if (command === 'convert_folder_pack_to_named_zip') return staged;
    if (command === 'cleanup_session_workspace') {
      assert.equal(args.path, staging);
      await fs.rm(staging, { recursive: true });
      return;
    }
    assert.equal(command, 'delete_workspace_media_file');
    send({ command, args });
    const response = await receive();
    if (response.error) throw response.error;
    return response.result;
  },
});

assert.equal(kept, null);
await assert.rejects(fs.access(target), { code: 'ENOENT' });
for (const neighbor of preserved) assert.equal(await fs.readFile(neighbor, 'utf8'), 'preexisting');
send({ kind: 'done' });
