const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'webm']);

export function isLocalAudioPath(path) {
  const cleanPath = String(path || '').replace(/[?#].*$/, '');
  const filename = cleanPath.split(/[\\/]/).pop() || '';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0) return false;
  return AUDIO_EXTENSIONS.has(filename.slice(dotIndex + 1).toLowerCase());
}

export function versionLocalAssetUrl(url, version) {
  if (!version) return url;
  const separator = String(url).includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(version)}`;
}
