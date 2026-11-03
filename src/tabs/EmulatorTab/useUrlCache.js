import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

// MIME : source unique dans utils/mimeTypes. Re-exporte ici pour les
// consommateurs historiques (ProjectSimulator, FlatSimulator) qui l'importaient
// depuis ce module, et utilise en interne (getLocalUrl / get_pack_asset).
import { MIME } from '../../utils/mimeTypes';
import { FILE_CHANGED_EVENT } from '../../store/fileMetadataCache';

export { MIME };

/**
 * Un cache d'URL blob et son propriétaire : seul celui qui le crée le révoque.
 * Le simulateur d'une consultation du catalogue a le sien, révoqué à sa
 * fermeture, et ne touche jamais au cache partagé ci-dessous.
 */
export function createUrlCache() {
  const urls = new Map();
  return {
    has: (key) => urls.has(key),
    get: (key) => urls.get(key),
    set(key, url) {
      // Concurrent reads can finish after an earlier caller displayed this key.
      // Keep that URL alive; the new, unused URL can be revoked immediately.
      if (urls.has(key)) {
        const current = urls.get(key);
        if (current !== url) {
          try { URL.revokeObjectURL(url); } catch {}
        }
        return current;
      }
      urls.set(key, url);
      return url;
    },
    delete(key) {
      if (!urls.has(key)) return;
      try { URL.revokeObjectURL(urls.get(key)); } catch {}
      urls.delete(key);
    },
    values: () => urls.values(),
    revokeAll() {
      for (const url of urls.values()) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      urls.clear();
    },
  };
}

// Cache blob URLs partagé (chemin fichier → url, ou "zip:path:asset" → url)
const urlCache = createUrlCache();

export function revokeUrlCache() {
  urlCache.revokeAll();
}

// Un fichier a changé sur disque sans changer de chemin (ex : édition audio en
// place) : on purge son blob en cache pour relire le contenu au prochain accès.
if (typeof window !== 'undefined') {
  window.addEventListener(FILE_CHANGED_EVENT, (event) => {
    const path = event?.detail?.path;
    if (!path || !urlCache.has(path)) return;
    urlCache.delete(path);
  });
}

export async function getLocalUrl(path) {
  if (!path) return null;
  if (urlCache.has(path)) return urlCache.get(path);
  try {
    const ext = path.split('.').pop().toLowerCase();
    const data = await readFile(path);
    const url = URL.createObjectURL(new Blob([data], { type: MIME[ext] || 'application/octet-stream' }));
    return urlCache.set(path, url);
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
    return urlCache.set(key, url);
  } catch { return null; }
}

