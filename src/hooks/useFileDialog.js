import { translateImport as t } from '../i18n/importPresentation.js';
import { open, save, message } from '@tauri-apps/plugin-dialog';
import { KEYS, read, write } from '../store/persistentSettings';

const LEGACY_IMPORT_KEY = KEYS.LAST_IMPORT_DIR;
const EXPORT_KEYS = [KEYS.LAST_PACK_OUTPUT_DIR, KEYS.LAST_EXPORT_DIR];
const DIR_KEYS = {
  image: KEYS.LAST_IMAGE_IMPORT_DIR,
  audio: KEYS.LAST_AUDIO_IMPORT_DIR,
  zip: KEYS.LAST_ZIP_IMPORT_DIR,
  audioZip: KEYS.LAST_AUDIO_ZIP_IMPORT_DIR,
  multiAudio: KEYS.LAST_MULTI_AUDIO_IMPORT_DIR,
  multiZip: KEYS.LAST_MULTI_ZIP_IMPORT_DIR,
  multiAudioZip: KEYS.LAST_MULTI_AUDIO_ZIP_IMPORT_DIR,
  mediaLibrary: KEYS.LAST_MEDIA_LIBRARY_IMPORT_DIR,
  sdReferenceImage: KEYS.LAST_SD_REFERENCE_IMAGE_DIR,
  comfyWorkflowApi: KEYS.LAST_COMFY_WORKFLOW_API_DIR,
  comfyWorkflowConfig: KEYS.LAST_COMFY_WORKFLOW_CONFIG_DIR,
};

function getLastDir(keys) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    const value = read(key);
    if (value) return value;
  }
  return undefined;
}

function saveLastDir(key, filePath, { directory = false } = {}) {
  if (!key || !filePath) return;
  if (directory) {
    write(key, filePath);
    return;
  }
  const dir = filePath.replace(/[\\/][^\\/]+$/, '');
  if (dir) write(key, dir);
}

async function openRememberedFile(opts, keys, saveKey) {
  const result = await open({
    ...opts,
    defaultPath: getLastDir(keys),
  });
  if (result) saveLastDir(saveKey, Array.isArray(result) ? result[0] : result);
  return result;
}

export async function pickImage() {
  return openRememberedFile({
    title: t('native:file.image.title'),
    multiple: false,
    filters: [{ name: t('native:file.image.filterLabel'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  }, [DIR_KEYS.image, LEGACY_IMPORT_KEY], DIR_KEYS.image);
}

export async function pickSdReferenceImage() {
  return openRememberedFile({
    title: t('native:file.referenceImage.title'),
    multiple: false,
    filters: [{ name: t('native:file.referenceImage.filterLabel'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  }, [DIR_KEYS.sdReferenceImage, DIR_KEYS.image, LEGACY_IMPORT_KEY], DIR_KEYS.sdReferenceImage);
}

export async function pickAudio() {
  return openRememberedFile({
    title: t('native:file.audio.title'),
    multiple: false,
    filters: [{ name: t('native:file.audio.filterLabel'), extensions: ['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac'] }],
  }, [DIR_KEYS.audio, LEGACY_IMPORT_KEY], DIR_KEYS.audio);
}

export async function pickZip() {
  return openRememberedFile({
    title: t('native:file.archive.title'),
    multiple: false,
    filters: [{ name: t('native:file.archive.filterLabel'), extensions: ['zip', '7z'] }],
  }, [DIR_KEYS.zip, LEGACY_IMPORT_KEY], DIR_KEYS.zip);
}

export async function pickMultipleZip() {
  const result = await open({
    title: t('native:file.archives.title'),
    multiple: true,
    filters: [{ name: t('native:file.archives.filterLabel'), extensions: ['zip', '7z'] }],
    defaultPath: getLastDir([DIR_KEYS.multiZip, DIR_KEYS.zip, LEGACY_IMPORT_KEY]),
  });
  const files = Array.isArray(result) ? result : (result ? [result] : []);
  if (files.length > 0) saveLastDir(DIR_KEYS.multiZip, files[0]);
  return files;
}

export async function pickMultipleAudioOrZip() {
  const result = await open({
    title: t('native:file.audioArchive.title'),
    multiple: true,
    filters: [{ name: t('native:file.audioArchive.filterLabel'), extensions: ['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac', 'zip', '7z'] }],
    defaultPath: getLastDir([DIR_KEYS.multiAudioZip, DIR_KEYS.audioZip, DIR_KEYS.audio, DIR_KEYS.zip, LEGACY_IMPORT_KEY]),
  });
  const files = Array.isArray(result) ? result : (result ? [result] : []);
  if (files.length > 0) saveLastDir(DIR_KEYS.multiAudioZip, files[0]);
  return files;
}

export async function pickMultipleMediaFiles() {
  const result = await open({
    title: t('native:file.media.title'),
    multiple: true,
    filters: [{
      name: t('native:file.media.filterLabel'),
      extensions: ['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'zip', '7z'],
    }],
    defaultPath: getLastDir([DIR_KEYS.mediaLibrary, DIR_KEYS.multiAudioZip, DIR_KEYS.image, DIR_KEYS.audio, LEGACY_IMPORT_KEY]),
  });
  const files = Array.isArray(result) ? result : (result ? [result] : []);
  if (files.length > 0) saveLastDir(DIR_KEYS.mediaLibrary, files[0]);
  return files;
}

export async function pickComfyWorkflowApiJson() {
  return openRememberedFile({
    title: t('native:file.comfyApi.title'),
    multiple: false,
    filters: [{ name: t('native:file.comfyApi.filterLabel'), extensions: ['json'] }],
  }, [DIR_KEYS.comfyWorkflowApi, LEGACY_IMPORT_KEY], DIR_KEYS.comfyWorkflowApi);
}

export async function pickComfyWorkflowConfigJson() {
  return openRememberedFile({
    title: t('native:file.comfyConfig.title'),
    multiple: false,
    filters: [{ name: t('native:file.comfyConfig.filterLabel'), extensions: ['json'] }],
  }, [DIR_KEYS.comfyWorkflowConfig, DIR_KEYS.comfyWorkflowApi, LEGACY_IMPORT_KEY], DIR_KEYS.comfyWorkflowConfig);
}

export async function pickFolder({ multiple = false } = {}) {
  const result = await open({
    directory: true,
    title: t('native:file.folder.title'),
    multiple,
    defaultPath: getLastDir([DIR_KEYS.multiAudioZip, DIR_KEYS.audio, LEGACY_IMPORT_KEY]),
  });
  if (result) saveLastDir(DIR_KEYS.multiAudioZip, Array.isArray(result) ? result[0] : result, { directory: true });
  return result ?? null;
}

export function getLastExportDir() {
  return getLastDir(EXPORT_KEYS);
}

export function saveLastExportDir(folderPath) {
  if (folderPath) write(EXPORT_KEYS[0], folderPath);
}

// Reuses the native dialogue boundary for source-folder drops. Callers still
// validate the path in Rust; a dropped file is never imported or copied here.
export async function subscribeFolderDrops(callback) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const { releaseTauriListener } = await import('../utils/tauriListener.js');
  const stop = await getCurrentWindow().onDragDropEvent(({ payload }) => {
    if (payload.type === 'drop') callback(payload.paths ?? []);
  });
  return () => { void releaseTauriListener(stop); };
}

export async function pickCatalogueBackupDestination({ title, defaultPath, filterLabel }) {
  return save({
    title,
    defaultPath,
    filters: [{ name: filterLabel, extensions: ['zip'] }],
  });
}

export async function pickCatalogueBackupSource({ title, filterLabel }) {
  return open({ title, multiple: false, filters: [{ name: filterLabel, extensions: ['zip'] }] });
}

// Boot runs before any React provider; keep native dialogues at this boundary.
export function showAlreadyOpen() {
  return message(t('rust:CATALOG_ALREADY_OPEN'), { title: 'Story Studio', kind: 'info' });
}
