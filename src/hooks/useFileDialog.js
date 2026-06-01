import { open } from '@tauri-apps/plugin-dialog';
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
    multiple: false,
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  }, [DIR_KEYS.image, LEGACY_IMPORT_KEY], DIR_KEYS.image);
}

export async function pickSdReferenceImage() {
  return openRememberedFile({
    multiple: false,
    filters: [{ name: 'Image de reference', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  }, [DIR_KEYS.sdReferenceImage, DIR_KEYS.image, LEGACY_IMPORT_KEY], DIR_KEYS.sdReferenceImage);
}

export async function pickAudio() {
  return openRememberedFile({
    multiple: false,
    filters: [{ name: 'Audio', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac'] }],
  }, [DIR_KEYS.audio, LEGACY_IMPORT_KEY], DIR_KEYS.audio);
}

export async function pickZip() {
  return openRememberedFile({
    multiple: false,
    filters: [{ name: 'Archive Lunii', extensions: ['zip', '7z'] }],
  }, [DIR_KEYS.zip, LEGACY_IMPORT_KEY], DIR_KEYS.zip);
}

export async function pickMultipleAudioOrZip() {
  const result = await open({
    multiple: true,
    filters: [{ name: 'Audio (mp3, wav, ogg, flac) ou archive Lunii (.zip, .7z)', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac', 'zip', '7z'] }],
    defaultPath: getLastDir([DIR_KEYS.multiAudioZip, DIR_KEYS.audioZip, DIR_KEYS.audio, DIR_KEYS.zip, LEGACY_IMPORT_KEY]),
  });
  const files = Array.isArray(result) ? result : (result ? [result] : []);
  if (files.length > 0) saveLastDir(DIR_KEYS.multiAudioZip, files[0]);
  return files;
}

export async function pickMultipleMediaFiles() {
  const result = await open({
    multiple: true,
    filters: [{
      name: 'Médias Story Studio',
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
    multiple: false,
    filters: [{ name: 'ComfyUI API workflow', extensions: ['json'] }],
  }, [DIR_KEYS.comfyWorkflowApi, LEGACY_IMPORT_KEY], DIR_KEYS.comfyWorkflowApi);
}

export async function pickComfyWorkflowConfigJson() {
  return openRememberedFile({
    multiple: false,
    filters: [{ name: 'Workflow config', extensions: ['json'] }],
  }, [DIR_KEYS.comfyWorkflowConfig, DIR_KEYS.comfyWorkflowApi, LEGACY_IMPORT_KEY], DIR_KEYS.comfyWorkflowConfig);
}

export async function pickFolder() {
  const result = await open({
    directory: true,
    multiple: false,
    defaultPath: getLastDir([DIR_KEYS.multiAudioZip, DIR_KEYS.audio, LEGACY_IMPORT_KEY]),
  });
  if (result) saveLastDir(DIR_KEYS.multiAudioZip, result, { directory: true });
  return result ?? null;
}

export function getLastExportDir() {
  return getLastDir(EXPORT_KEYS);
}

export function saveLastExportDir(folderPath) {
  if (folderPath) write(EXPORT_KEYS[0], folderPath);
}
