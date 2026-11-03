import { translateHome as t } from '../i18n/homePresentation.js';
// Local work identity, independent of pack UUIDs and save locations.
export const PROJECT_MEDIA_CATEGORIES = Object.freeze([
  'voix-generees', 'images-generees', 'fichiers-importes', 'enregistrements', 'zips-extraits',
]);
export const UNTITLED_PROJECT_FOLDER = 'Projet sans titre';

function storageError(key) {
  return Object.assign(new Error(t(key)), { key, params: {} });
}

export function sanitizeProjectFolder(value) {
  let name = Array.from(String(value ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/^\.+/, '').replace(/[. ]+$/, '')).slice(0, 60).join('')
    .replace(/[. ]+$/, '');
  if (!name.trim()) return UNTITLED_PROJECT_FOLDER;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
    const dot = name.indexOf('.');
    const stemEnd = dot < 0 ? name.length : dot;
    name = Array.from(`${name.slice(0, stemEnd)}_${name.slice(stemEnd)}`).slice(0, 60).join('')
      .replace(/[. ]+$/, '');
  }
  return name;
}

export function createProjectStorage({ folder = UNTITLED_PROJECT_FOLDER, provisional = true } = {}) {
  return { version: 1, workId: crypto.randomUUID(), folder: sanitizeProjectFolder(folder), provisional };
}

const isWorkId = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function isValidProjectStorage(storage) {
  return storage?.version === 1 && isWorkId(storage.workId);
}

// Fields still readable in an invalid descriptor (hand edit, future version):
// only an unreadable workId justifies a new identity.
export function readableProjectStorageFields(storage) {
  if (!storage || typeof storage !== 'object') return {};
  return {
    ...(isWorkId(storage.workId) ? { workId: storage.workId.toLowerCase() } : {}),
    ...(typeof storage.folder === 'string' ? { folder: sanitizeProjectFolder(storage.folder) } : {}),
    ...(typeof storage.provisional === 'boolean' ? { provisional: storage.provisional } : {}),
  };
}

export function normalizeProjectStorage(storage) {
  if (!isValidProjectStorage(storage)) throw storageError('home:project.storage.invalid');
  return { version: 1, workId: storage.workId.toLowerCase(), folder: sanitizeProjectFolder(storage.folder), provisional: storage.provisional === true };
}

export function ensureProjectStorage(project, { saved = false } = {}) {
  if (project.storage) return project;
  return { ...project, storage: createProjectStorage(saved ? { folder: project.projectName, provisional: false } : {}) };
}

// Pure mirror of the backend collision contract; each category maps names to work IDs (null = unmarked).
// A rank already holding our folder (and no foreign one) wins over the first free rank.
export function resolveProjectFolderName(folder, workId, categories) {
  const base = sanitizeProjectFolder(folder);
  // Same folding as Rust collision_key: per character, final sigma folded.
  const key = (name) => Array.from(name.normalize('NFC'), (c) => c.toLowerCase()).join('').replaceAll('ς', 'σ');
  const candidate = (rank) => (rank === 1 ? base : `${base} (${rank})`);
  const ranks = new Map();
  for (let rank = 1; rank <= 1000; rank += 1) ranks.set(key(candidate(rank)), rank);
  const found = new Map();
  categories.forEach((entries, category) => {
    for (const [name, owner] of Object.entries(entries)) {
      const rank = ranks.get(key(name));
      if (rank) found.set(rank, [...(found.get(rank) ?? []), { category, name, owner }]);
    }
  });
  for (const rank of [...found.keys()].sort((a, b) => a - b)) {
    const entries = found.get(rank);
    if (entries.some(({ owner }) => owner !== workId)) continue;
    if (new Set(entries.map(({ category }) => category)).size !== entries.length) {
      throw storageError('home:project.storage.duplicate');
    }
    return entries.at(-1).name;
  }
  for (let rank = 1; rank <= 1000; rank += 1) if (!found.has(rank)) return candidate(rank);
  throw storageError('home:project.storage.exhausted');
}
