// Le transport média du simulateur de graphe à plat — la moitié qui touche au
// disque et à l'archive, tenue à l'écart de `flatGraph.js` pour que celui-ci
// reste éprouvable sans Tauri.
//
// Une requête média dit d'où viennent les octets, jamais ce qu'ils valent : le
// choix du média appartient au graphe, et il est le même quelle que soit la
// source.

import { invoke } from '@tauri-apps/api/core';

import { MEDIA_FROM_CONSULTATION, MEDIA_FROM_PACK, mediaRequestKey } from './flatGraph.js';
import { createAudioPlayer } from '../../utils/audioPlayer';
import { createUrlCache, getLocalUrl, getZipAssetUrl, MIME } from './useUrlCache';

export async function loadFlatMedia(request) {
  if (request.kind === MEDIA_FROM_PACK) {
    const bytes = await invoke('get_pack_asset', {
      zipPath: request.zipPath,
      assetName: request.assetName,
    });
    return { kind: MEDIA_FROM_PACK, assetName: request.assetName, bytes };
  }
  // Un fichier introuvable rend `null` plutôt que de jeter : c'est l'état d'un
  // média que l'auteur a déplacé, et il se joue en silence sans interrompre
  // l'écoute. Le bandeau l'a déjà annoncé, compté depuis la vue.
  return { kind: request.kind, url: await getLocalUrl(request.path) };
}

export function createFlatAudio(loaded) {
  if (loaded.kind === MEDIA_FROM_CONSULTATION) {
    if (!loaded.bytes) return null;
    const blob = new Blob([loaded.bytes], { type: loaded.mime || 'audio/mpeg' });
    return createAudioPlayer(URL.createObjectURL(blob), { revokeSourceOnDestroy: true });
  }
  if (loaded.kind !== MEDIA_FROM_PACK) {
    return loaded.url ? createAudioPlayer(loaded.url) : null;
  }
  const ext = String(loaded.assetName).split('.').pop().toLowerCase();
  const blob = new Blob([new Uint8Array(loaded.bytes)], { type: MIME[ext] || 'audio/mpeg' });
  return createAudioPlayer(URL.createObjectURL(blob), { revokeSourceOnDestroy: true });
}

// Les object URLs d'image restent détenues par `useUrlCache`, qui les révoque à
// la fermeture du simulateur. Aucun consommateur isolé ne les révoque.
export function loadFlatImageUrl(request) {
  return request.kind === MEDIA_FROM_PACK
    ? getZipAssetUrl(request.zipPath, request.assetName)
    : getLocalUrl(request.path);
}

/**
 * Le transport d'une consultation du catalogue : les octets sont lus par
 * `readAsset` (commande du moteur, aucun chemin), le type vient de la table
 * publiée avec la consultation. Les URL d'image appartiennent à ce chargeur
 * seul et sont révoquées par `dispose`, sans toucher au cache partagé.
 *
 * Un refus (consultation expirée, fichier changé) rend `null` — l'Écran se joue
 * en silence — et prévient `onFailure`, qui propose de relancer.
 */
export function createConsultationMediaLoader({ mediaTypes = {}, readAsset, onFailure = () => {} }) {
  const cache = createUrlCache();
  let disposed = false;
  const typeOf = (request) => (Object.hasOwn(mediaTypes, request.mediaId) ? mediaTypes[request.mediaId] : 'application/octet-stream');
  async function bytes(request) {
    if (disposed) return null;
    try {
      return await readAsset(request);
    } catch (error) {
      if (!disposed) onFailure(error);
      return null;
    }
  }
  return {
    async loadAudio(request) {
      return { kind: MEDIA_FROM_CONSULTATION, mime: typeOf(request), bytes: await bytes(request) };
    },
    async loadImageUrl(request) {
      const key = mediaRequestKey(request);
      if (cache.has(key)) return cache.get(key);
      const data = await bytes(request);
      if (!data || disposed) return null;
      const url = URL.createObjectURL(new Blob([data], { type: typeOf(request) }));
      return cache.set(key, url);
    },
    dispose() {
      disposed = true;
      cache.revokeAll();
    },
  };
}
