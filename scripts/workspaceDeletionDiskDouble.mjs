// Frontière IPC des tests JS : reproduit les cascades ZIP au lieu de remplacer
// toute suppression par unlink. Les gardes et la vraie commande sont éprouvées
// en Rust, y compris avec packFolderCleanupTransport.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function deleteWorkspaceMediaDiskDouble({ path: target, workspaceDir, preservePaths = [], cascade = true }) {
  const relative = path.relative(workspaceDir, target);
  const category = relative.split(path.sep)[0];
  assert.ok(['fichiers-importes', 'enregistrements', 'voix-generees', 'images-generees'].includes(category));
  await fs.unlink(target);
  if (cascade === false) return;

  const { dir, name, base, ext } = path.parse(target);
  const preserved = new Set(preservePaths.map(value => path.resolve(value)));
  for (const sibling of await fs.readdir(dir)) {
    if (!sibling.startsWith(`${name}.original`) || !sibling.endsWith(ext)) continue;
    const suffix = sibling.slice(name.length, sibling.length - ext.length);
    if (!/^\.original(?:-\d+)?$/.test(suffix)) continue;
    const candidate = path.join(dir, sibling);
    if (!preserved.has(path.resolve(candidate))) await fs.rm(candidate);
  }
  for (const folder of ['.story-studio-audio-edits', '.story-studio-image-edits']) {
    const directory = path.join(dir, folder);
    for (const artifact of await fs.readdir(directory).catch(() => [])) {
      if (artifact === `${base}.edit.json`
        || (folder === '.story-studio-audio-edits' && artifact.startsWith(`${base}.original`))) {
        await fs.rm(path.join(directory, artifact));
      }
    }
    await fs.rmdir(directory).catch(() => {});
  }
}
