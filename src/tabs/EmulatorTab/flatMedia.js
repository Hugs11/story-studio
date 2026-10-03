// Le transport média du simulateur de graphe à plat — la moitié qui touche au
// disque et à l'archive, tenue à l'écart de `flatGraph.js` pour que celui-ci
// reste éprouvable sans Tauri.
//
// Une requête média dit d'où viennent les octets, jamais ce qu'ils valent : le
// choix du média appartient au graphe, et il est le même quelle que soit la
// source.

import { invoke } from '@tauri-apps/api/core';

import { MEDIA_FROM_PACK } from './flatGraph.js';
import { createAudioPlayer } from '../../utils/audioPlayer';
import { getLocalUrl, getZipAssetUrl, MIME } from './useUrlCache';

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
