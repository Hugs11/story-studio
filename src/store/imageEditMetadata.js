import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';

export const IMAGE_EDIT_METADATA_DIR = '.story-studio-image-edits';
const METADATA_SUFFIX = '.edit.json';
const METADATA_VERSION = 1;

export function imageEditMetadataPath(imagePath) {
  if (!imagePath) return null;
  const normalized = String(imagePath);
  const splitIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (splitIndex < 0) return `${IMAGE_EDIT_METADATA_DIR}/${normalized}${METADATA_SUFFIX}`;
  const dir = normalized.slice(0, splitIndex);
  const name = normalized.slice(splitIndex + 1);
  return `${dir}/${IMAGE_EDIT_METADATA_DIR}/${name}${METADATA_SUFFIX}`;
}

export function withImageEditSourcePath(metadata, sourcePath) {
  if (!metadata || !sourcePath) return metadata;
  return {
    version: METADATA_VERSION,
    sourcePath,
    transform: metadata.transform ?? null,
    filters: metadata.filters ?? null,
  };
}

export async function readImageEditMetadata(imagePath, { strict = false } = {}) {
  const metadataPath = imageEditMetadataPath(imagePath);
  if (!metadataPath) return null;

  try {
    const bytes = await readFile(metadataPath);
    const text = new TextDecoder().decode(bytes);
    const data = JSON.parse(text);
    if (data?.version !== METADATA_VERSION || !data.sourcePath) {
      if (strict) throw new Error(`Sidecar d’image invalide : ${metadataPath}`);
      return null;
    }
    return data;
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export async function writeImageEditMetadata(imagePath, metadata, { strict = false } = {}) {
  const metadataPath = imageEditMetadataPath(imagePath);
  if (!metadataPath || !metadata?.sourcePath) return;

  try {
    const dir = metadataPath.slice(0, Math.max(metadataPath.lastIndexOf('/'), metadataPath.lastIndexOf('\\')));
    if (dir) await mkdir(dir, { recursive: true });
    const payload = withImageEditSourcePath(metadata, metadata.sourcePath);
    await writeFile(metadataPath, new TextEncoder().encode(JSON.stringify(payload, null, 2)));
  } catch (error) {
    import('../utils/logger.js')
      .then(({ logger }) => logger.warn('image-editor:metadata-write-failed', error))
      .catch(() => {});
    if (strict) throw error;
  }
}
