import { sanitizeProjectPrefix } from './projectPrefix.js';

export { sanitizeProjectPrefix };

const WEB_PATH_PATTERN = /^[a-z]+:\/\//i;

export function stripWindowsLongPathPrefix(path) {
  const value = String(path || '');
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  return value.replace(/^\\\\\?\\/, '');
}

export function pathKey(path) {
  return stripWindowsLongPathPrefix(path)
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

export function normalizeWindowsPath(path) {
  if (typeof path !== 'string') return path ?? null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (WEB_PATH_PATTERN.test(trimmed) || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  if (/^[a-z]:[\\/]/i.test(trimmed)) {
    const drive = trimmed.slice(0, 2);
    const rest = trimmed
      .slice(2)
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\');
    return `${drive}${rest}`;
  }

  if (trimmed.startsWith('\\\\')) {
    const rest = trimmed
      .slice(2)
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\');
    return `\\\\${rest}`;
  }

  return trimmed;
}

// Dernier segment d'un chemin (fichier ou dossier), supporte `/` et `\`.
export function basename(path) {
  const value = String(path || '');
  if (!value) return '';
  const normalised = value.replace(/[\\/]+$/, '');
  const match = /[\\/]([^\\/]+)$/.exec(normalised);
  return match ? match[1] : normalised;
}

// Parent d'un chemin (sans le dernier segment), supporte `/` et `\`.
// Retourne `''` si le chemin n'a pas de séparateur.
export function dirname(path) {
  const value = String(path || '');
  if (!value) return '';
  const normalised = value.replace(/[\\/]+$/, '');
  const match = /^(.*)[\\/][^\\/]+$/.exec(normalised);
  return match ? match[1] : '';
}

// Joint des segments avec `/` en preservant le ou les prefixes UNC / drive.
// Pas une normalisation absolue : c'est juste un remplacement sur des concats
// `${dir}/${file}` susceptibles de produire des doubles separateurs.
export function joinPath(...parts) {
  const segments = parts
    .map((part) => String(part ?? ''))
    .filter((part) => part.length > 0);
  if (segments.length === 0) return '';
  const [head, ...rest] = segments;
  const trimmedHead = head.replace(/[\\/]+$/, '');
  if (rest.length === 0) return trimmedHead;
  const tail = rest
    .map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
  return tail.length === 0 ? trimmedHead : `${trimmedHead}/${tail}`;
}

export function basenameNoExt(path) {
  return basename(path).replace(/\.[^/.]+$/, '');
}

export async function addProjectPrefix(path, projectName) {
  const prefix = sanitizeProjectPrefix(projectName);
  if (!prefix || !path) return path;
  const dir = dirname(path);
  const name = basename(path);
  if (name.startsWith(`${prefix}__`)) return path;
  const newPath = joinPath(dir, `${prefix}__${name}`);
  const { rename } = await import('@tauri-apps/plugin-fs');
  await rename(path, newPath);
  return newPath;
}
