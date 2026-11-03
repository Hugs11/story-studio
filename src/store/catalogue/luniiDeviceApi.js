// Injectable headless Lunii facade; selections always designate catalogue entries.
import { convertFileSrc } from '@tauri-apps/api/core';
import { coverAddress } from './coverAddress.js';
import { toCatalogueError } from './catalogueApi.js';
import { releaseTauriListener } from '../../utils/tauriListener.js';
import { getPackAudioEdgeSilenceSettings } from '../../config/audioProcessing.js';

export function luniiCoverAddress(path, convert = convertFileSrc) {
  return typeof path === 'string' && /^\/[a-f0-9-]+\/[a-f0-9-]+$/i.test(path)
    ? `${convert('', 'lunii-cover').replace(/\/+$/, '')}${path}` : null;
}
export function luniiStoryCover(story, convert = convertFileSrc) {
  return luniiCoverAddress(story?.coverPath, convert) ?? coverAddress(story?.catalogueFicheId, story?.catalogueCoverSignature, convert);
}
export function createLuniiDeviceApi(bridge = {}) {
  async function call(command, args) {
    try {
      const invoke = bridge.invoke ?? (await import('@tauri-apps/api/core')).invoke;
      return await invoke(command, args);
    } catch (error) { throw toCatalogueError(error); }
  }
  return {
    list: () => call('lunii_device_list'),
    open: deviceId => call('lunii_device_open', { deviceId }),
    inspect: (deviceId, { readOnly } = {}) => call('lunii_device_inspect', { deviceId, ...(readOnly === undefined ? {} : { readOnly }) }),
    // A requestId identifies one attempt, including reservation failures. After
    // rejection, retry with a new requestId; reusing it only retrieves its receipt.
    send: ({ deviceId, selection, position = null, requestId }) => call('lunii_device_send', {
      deviceId, selection, position, requestId, audioEdgeSilence: getPackAudioEdgeSilenceSettings(),
    }),
    cancel: operationId => call('lunii_device_cancel', { operationId }),
    remove: (deviceId, keys) => call('lunii_device_remove', { deviceId, keys }),
    reorder: (deviceId, keys) => call('lunii_device_reorder', { deviceId, keys }),
    hide: (deviceId, key, hidden) => call('lunii_device_hide', { deviceId, key, hidden }),
    nameStory: (deviceId, key, title) => call('lunii_device_name_story', { deviceId, key, title }),
    rename: (deviceId, name) => call('lunii_device_rename', { deviceId, name }),
    repair: deviceId => call('lunii_device_repair', { deviceId }),
    restore: deviceId => call('lunii_device_restore', { deviceId }),
    orphan: ({ deviceId, key, restore, knownUuid = null }) => call('lunii_device_orphan', { deviceId, key, restore, knownUuid }),
    restoreOrphans: (deviceId, items) => call('lunii_device_orphans_restore', { deviceId, items }),
    repatriate: (deviceId, key, requestId) => call('lunii_device_repatriate', { deviceId, key, requestId }),
    eject: deviceId => call('lunii_device_eject', { deviceId }),
    async onDevicesChanged(callback) {
      const listen = bridge.listen ?? (await import('@tauri-apps/api/event')).listen;
      const unlisten = await listen('lunii-devices-changed', event => callback(event.payload));
      return () => releaseTauriListener(unlisten);
    },
    async onCatalogueChanged(callback) {
      const listen = bridge.listen ?? (await import('@tauri-apps/api/event')).listen;
      const unlisten = await listen('catalogue-changed', event => callback(event.payload));
      return () => releaseTauriListener(unlisten);
    },
  };
}
export const luniiDeviceApi = createLuniiDeviceApi();
