// Filesystem IPC doubles for hook tests. Collision/name rules come from the
// production JS mirror; native security and rollback are tested in Rust.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_MEDIA_CATEGORIES, resolveProjectFolderName, sanitizeProjectFolder } from '../src/store/projectStorage.js';
import { remapStoragePath } from '../src/store/projectStorageSave.js';
const marker = '.story-studio-dossier.json';
const exists = async (target) => fs.access(target).then(() => true, () => false);
const collisionKey = (name) => Array.from(name.normalize('NFC'), c => c.toLowerCase()).join('').replaceAll('ς', 'σ');
function candidateRanks(base) {
  return new Map(Array.from({ length: 1000 }, (_, i) => [collisionKey(i === 0 ? base : `${base} (${i + 1})`), i + 1]));
}
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
  async resolve_project_folder({ root, folder, workId, create, category }) {
    const categories = await Promise.all(PROJECT_MEDIA_CATEGORIES.map(async (category) => {
      const directory = path.join(root, category);
      const entries = await fs.readdir(directory).catch(() => []);
      return Object.fromEntries(await Promise.all(entries.map(async (name) => [name, await owner(path.join(directory, name))])));
    }));
    let name = resolveProjectFolderName(folder, workId, categories);
    if (category) {
      const target = PROJECT_MEDIA_CATEGORIES.indexOf(category);
      const ranks = candidateRanks(sanitizeProjectFolder(folder));
      const owned = categories.flatMap((entries, index) => Object.entries(entries)
        .filter(([entry, owner]) => owner === workId && ranks.has(collisionKey(entry)))
        .map(([entry]) => ({ entry, index, rank: ranks.get(collisionKey(entry)) })))
        .sort((a, b) => a.rank - b.rank || a.index - b.index);
      const inTarget = owned.find(item => item.index === target);
      const available = owned.filter(item => !Object.keys(categories[target])
        .some(entry => collisionKey(entry) === collisionKey(item.entry)));
      const reusable = inTarget ?? available.findLast(item => item.rank === available[0].rank);
      if (reusable) name = reusable.entry;
    }
    if (create && category) {
      const directory = path.join(root, category, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, marker), JSON.stringify({ version:1, workId }));
    }
    return name;
  },
  async rename_project_folder({ root, old, new: next, workId, originalFolders }) {
    const moves = [];
    const ranks = candidateRanks(old);
    for (const category of PROJECT_MEDIA_CATEGORIES) {
      if (originalFolders && !Object.hasOwn(originalFolders, category)) continue;
      const parent = path.join(root, category);
      const entries = await fs.readdir(parent).catch(() => []);
      const owned = [];
      for (const name of entries) {
        if (ranks.has(collisionKey(name)) && (!originalFolders || name === old)
          && await owner(path.join(parent, name)) === workId) owned.push(name);
      }
      if (!owned.length && entries.some(name => collisionKey(name) === collisionKey(old))) throw new Error('Destination de renommage refusée');
      for (const name of owned) {
        const from = path.join(parent, name); const to = path.join(parent, originalFolders?.[category] ?? next);
        if (from === to) continue;
        if (await exists(to)) throw new Error('Destination de renommage refusée');
        moves.push({from,to});
      }
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
      const folder = projectDestination ? await projectStorageDiskCommands.resolve_project_folder({
        root, ...projectDestination, create: true, category: cat,
      }) : null;
      const directory = path.join(root,cat,...(folder ? [folder] : []));
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
