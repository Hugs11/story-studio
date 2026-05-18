let _audio = null;
let _image = null;

function normalizeEntry(kind, pathOrPaths, options = {}) {
  const paths = Array.isArray(pathOrPaths)
    ? pathOrPaths.filter((path) => typeof path === 'string' && path.trim())
    : (pathOrPaths ? [pathOrPaths] : []);
  if (paths.length === 0) return null;
  return {
    kind,
    path: paths[0],
    paths,
    mode: options.mode === 'cut' ? 'cut' : 'copy',
  };
}

export const audioClipboard = {
  get: () => _audio?.path ?? null,
  getEntry: () => _audio,
  set: (path, options = {}) => { _audio = normalizeEntry('audio', path, options); },
  clear: () => { _audio = null; },
};

export const imageClipboard = {
  get: () => _image?.path ?? null,
  getEntry: () => _image,
  set: (path, options = {}) => { _image = normalizeEntry('image', path, options); },
  clear: () => { _image = null; },
};
