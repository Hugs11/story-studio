const WEB_PATH_PATTERN = /^[a-z]+:\/\//i;
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH_PATTERN = /^(?:\\\\|\/\/)/;

function withPortableSeparators(path) {
  const value = String(path || '').replace(/\\/g, '/');
  if (WINDOWS_UNC_PATH_PATTERN.test(path)) {
    return `//${value.slice(2).replace(/\/+/g, '/')}`;
  }
  return value.replace(/\/+/g, '/');
}

export function stripWindowsLongPathPrefix(path) {
  const value = String(path || '');
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  return value.replace(/^\\\\\?\\/i, '');
}

export function pathKey(path) {
  const value = stripWindowsLongPathPrefix(path).trim();
  if (!value) return '';
  if (WEB_PATH_PATTERN.test(value) || value.startsWith('blob:') || value.startsWith('data:')) {
    return value;
  }

  const normalized = withPortableSeparators(value);
  return WINDOWS_DRIVE_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value)
    ? normalized.toLowerCase()
    : normalized;
}

export function normalizeWindowsPath(path) {
  if (typeof path !== 'string') return path ?? null;
  const trimmed = stripWindowsLongPathPrefix(path).trim();
  if (!trimmed) return null;
  if (WEB_PATH_PATTERN.test(trimmed) || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  if (WINDOWS_DRIVE_PATH_PATTERN.test(trimmed)) {
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

// Comparaison d'appartenance pour des chemins natifs. La casse est ignorée
// uniquement pour les chemins Windows (lecteur ou UNC), jamais pour POSIX.
export function isPathInside(path, directory) {
  const pathValue = pathKey(path);
  const directoryValue = pathKey(directory);
  if (!pathValue || !directoryValue) return false;
  const normalizedPath = pathValue.length > 1 ? pathValue.replace(/\/+$/, '') : pathValue;
  const normalizedDirectory = directoryValue.length > 1
    ? directoryValue.replace(/\/+$/, '')
    : directoryValue;
  return normalizedPath === normalizedDirectory
    || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

// Forme portable sauvegardée dans un projet. Un chemin externe est conservé
// tel quel ; un chemin interne devient `./...` avec des séparateurs `/`.
export function toProjectRelativePath(path, directory) {
  if (typeof path !== 'string' || typeof directory !== 'string') return path;
  const nativePath = withPortableSeparators(stripWindowsLongPathPrefix(path));
  const nativeDirectory = withPortableSeparators(stripWindowsLongPathPrefix(directory))
    .replace(/\/+$/, '');
  if (
    !nativePath
    || !nativeDirectory
    || !isPathInside(nativePath, nativeDirectory)
    || pathKey(nativePath) === pathKey(nativeDirectory)
  ) {
    return path;
  }
  return `./${nativePath.slice(nativeDirectory.length + 1)}`;
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
