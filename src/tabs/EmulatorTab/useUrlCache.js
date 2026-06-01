import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

// MIME : source unique dans utils/mimeTypes. Re-exporte ici pour les
// consommateurs historiques (ProjectSimulator, ZipSimulator) qui l'importaient
// depuis ce module, et utilise en interne (getLocalUrl / get_pack_asset).
import { MIME } from '../../utils/mimeTypes';

export { MIME };

// Cache blob URLs partagé (chemin fichier → url, ou "zip:path:asset" → url)
const urlCache = new Map();

export function revokeUrlCache() {
  for (const url of urlCache.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  urlCache.clear();
}

export async function getLocalUrl(path) {
  if (!path) return null;
  if (urlCache.has(path)) return urlCache.get(path);
  try {
    const ext = path.split('.').pop().toLowerCase();
    const data = await readFile(path);
    const url = URL.createObjectURL(new Blob([data], { type: MIME[ext] || 'application/octet-stream' }));
    urlCache.set(path, url);
    return url;
  } catch { return null; }
}

export async function getZipAssetUrl(zipPath, assetName) {
  if (!zipPath || !assetName) return null;
  const key = `zip:${zipPath}:${assetName}`;
  if (urlCache.has(key)) return urlCache.get(key);
  try {
    const bytes = await invoke('get_pack_asset', { zipPath, assetName });
    const ext = assetName.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'application/octet-stream' }));
    urlCache.set(key, url);
    return url;
  } catch { return null; }
}

