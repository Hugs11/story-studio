import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { logger } from '../../utils/logger';

const METADATA_DIR = '.story-studio-image-edits';
const METADATA_SUFFIX = '.edit.json';
const METADATA_VERSION = 1;

function imageEditMetadataPath(imagePath) {
  if (!imagePath) return null;
  const normalized = String(imagePath);
  const splitIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (splitIndex < 0) return `${METADATA_DIR}/${normalized}${METADATA_SUFFIX}`;
  const dir = normalized.slice(0, splitIndex);
  const name = normalized.slice(splitIndex + 1);
  return `${dir}/${METADATA_DIR}/${name}${METADATA_SUFFIX}`;
}

export async function readImageEditMetadata(imagePath) {
  const metadataPath = imageEditMetadataPath(imagePath);
  if (!metadataPath) return null;

  try {
    const bytes = await readFile(metadataPath);
    const text = new TextDecoder().decode(bytes);
    const data = JSON.parse(text);
    if (data?.version !== METADATA_VERSION || !data.sourcePath) return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeImageEditMetadata(imagePath, metadata) {
  const metadataPath = imageEditMetadataPath(imagePath);
  if (!metadataPath || !metadata?.sourcePath) return;

  try {
    const dir = metadataPath.slice(0, Math.max(metadataPath.lastIndexOf('/'), metadataPath.lastIndexOf('\\')));
    if (dir) await mkdir(dir, { recursive: true });
    const payload = {
      version: METADATA_VERSION,
      sourcePath: metadata.sourcePath,
      transform: metadata.transform ?? null,
      filters: metadata.filters ?? null,
    };
    await writeFile(metadataPath, new TextEncoder().encode(JSON.stringify(payload, null, 2)));
  } catch (error) {
    logger.warn('image-editor:metadata-write-failed', error);
  }
}
