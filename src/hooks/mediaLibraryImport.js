const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm']);

function extension(path) {
  return (String(path).split('.').pop() || '').toLowerCase();
}

function isAudioPath(path) {
  return AUDIO_EXTENSIONS.has(extension(path));
}

function basename(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export async function importFilesToMediaLibrary({
  files,
  maybeCopyToProject,
  copyGeneratedMediaToProject,
  extractAudioEmbeddedImage,
  setImporting,
  getImportDisplayName = (path) => basename(path) || path,
}) {
  const nextPaths = [];
  const total = files.length;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const displayName = getImportDisplayName(file);
    setImporting({ name: displayName, index: i + 1, total, phase: 'Copie dans le projet...' });
    const copiedPath = await maybeCopyToProject(file);
    nextPaths.push(copiedPath);

    if (!extractAudioEmbeddedImage || !isAudioPath(copiedPath)) continue;
    setImporting({ name: displayName, index: i + 1, total, phase: 'Extraction de la jaquette...' });
    const embeddedImage = await extractAudioEmbeddedImage(copiedPath);
    if (embeddedImage) {
      const persistExtractedImage = copyGeneratedMediaToProject ?? maybeCopyToProject;
      nextPaths.push(await persistExtractedImage(embeddedImage));
    }
  }
  return nextPaths;
}
