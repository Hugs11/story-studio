// Filesystem IPC doubles for hook tests. Collision/name rules come from the
// production JS mirror; native security and rollback are tested in Rust.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_MEDIA_CATEGORIES, resolveProjectFolderName } from '../src/store/projectStorage.js';
import { remapStoragePath } from '../src/store/projectStorageSave.js';
const marker = '.story-studio-dossier.json';
const exists = async (target) => fs.access(target).then(() => true, () => false);
async function owner(directory) {
  try { return JSON.parse(await fs.readFile(path.join(directory, marker), 'utf8')).workId; } catch { return null; }
}
async function sidecars(directory, transform) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await sidecars(target, transform);
    else if (entry.name.endsWith('.edit.json')) {
      const data = JSON.parse(await fs.readFile(target, 'utf8'));
      for (const key of ['sourcePath', 'original_path', 'originalPath']) if (typeof data[key] === 'string') data[key] = transform(data[key]);
      await fs.writeFile(target, JSON.stringify(data, null, 2));
    }
  }
}
export const projectStorageDiskCommands = {
  async resolve_project_folder({ root, folder, workId, create }) {
    const categories = await Promise.all(PROJECT_MEDIA_CATEGORIES.map(async (category) => {
      const directory = path.join(root, category);
      const entries = await fs.readdir(directory).catch(() => []);
      return Object.fromEntries(await Promise.all(entries.map(async (name) => [name, await owner(path.join(directory, name))])));
    }));
    const name = resolveProjectFolderName(folder, workId, categories);
    if (create) for (const category of PROJECT_MEDIA_CATEGORIES) {
      const directory = path.join(root, category, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, marker), JSON.stringify({ version:1, workId }));
    }
    return name;
  },
  async rename_project_folder({ root, old, new: next, workId }) {
    if (old === next) return [];
    const moves = [];
    for (const category of PROJECT_MEDIA_CATEGORIES) {
      const from = path.join(root, category, old); const to = path.join(root, category, next);
      if (!(await exists(from))) continue;
      if (await owner(from) !== workId || await exists(to)) throw new Error('Destination de renommage refusée');
      moves.push({from,to});
    }
    for (const {from,to} of moves) await fs.rename(from,to);
    for (const {to} of moves) await sidecars(to, (source) => remapStoragePath(source,moves));
    return moves;
  },
  async copy_project_media({ sourcePath, root, category, projectDestination, sessionRoot }) {
    const copies = [];
    const copy = async (source, requestedCategory) => {
      const known = copies.find(({from}) => from === source); if (known) return known.to;
      const relative = sessionRoot ? path.relative(sessionRoot,source).split(path.sep) : [];
      const cat = PROJECT_MEDIA_CATEGORIES.includes(relative[0]) ? relative[0] : requestedCategory;
      const directory = path.join(root,cat,...(projectDestination ? [projectDestination.folder] : []));
      if (source.startsWith(directory+path.sep)) return source;
      await fs.mkdir(directory,{recursive:true});
      const parsed = path.parse(source); let rank=1; let target=path.join(directory,parsed.base);
      while (await exists(target)) target=path.join(directory,`${parsed.name}_${++rank}${parsed.ext}`);
      await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL); copies.push({from:source,to:target});
      for (const sidecarDir of ['.story-studio-image-edits','.story-studio-audio-edits']) {
        const origin = path.join(parsed.dir,sidecarDir,`${parsed.base}.edit.json`);
        if (!(await exists(origin))) continue;
        const data = JSON.parse(await fs.readFile(origin,'utf8'));
        // Like Rust: a deleted re-edit dependency drops the sidecar, never the media.
        const dependencies = ['sourcePath','original_path','originalPath'].map((key) => data[key]).filter(Boolean);
        if (!(await Promise.all(dependencies.map(exists))).every(Boolean)) continue;
        for (const key of ['sourcePath','original_path','originalPath']) if (data[key]) data[key] = await copy(data[key],'fichiers-importes');
        const dest = path.join(directory,sidecarDir,`${path.basename(target)}.edit.json`);
        await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,JSON.stringify(data));
        copies.push({from:origin,to:dest});
      }
      return target;
    };
    return {path:await copy(sourcePath,category),copies};
  },
};
