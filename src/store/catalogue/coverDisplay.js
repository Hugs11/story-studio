// Affichage d'une adresse de jaquette quand la page ne peut pas la mettre
// directement dans <img>.
//
// WebKitGTK refuse d'afficher dans <img> une ressource d'un schéma
// personnalisé depuis une page servie en http(s) (« Unsafe attempt to load
// URL catalogue-cover://… from origin http://127.0.0.1:1420. Domains,
// protocols and ports must match. ») ; `fetch` vers la même adresse, lui,
// aboutit. C'est le cas de `npm run tauri dev` (page Vite en http, schéma
// `catalogue-cover://`), pas de la production (page `tauri://localhost`) ni de
// Windows (schéma servi en `http://catalogue-cover.localhost`). Le critère est
// donc la paire d'origines, pas le système : page http(s) et schéma non http.
// Dans ce seul cas les octets passent par `fetch` puis une URL blob, gardée
// pour la session dans une table bornée.
import { coverOrigin } from './coverAddress.js';

const HTTP = /^https?:/i;
const MAX_BLOBS = 512;
const urls = new Map();
const pending = new Map();

// `address` : une adresse ou une origine de jaquette, de n'importe quel schéma
// personnalisé (`catalogue-cover:`, `lunii-cover:`) ; `blob:` et `data:` sont
// déjà affichables.
export function coverNeedsBlob(address, pageProtocol) {
  return HTTP.test(pageProtocol ?? '') && /^[a-z][a-z0-9+.-]*:/i.test(address ?? '')
    && !/^(https?|blob|data):/i.test(address);
}

let mode = null;
// Calculé une fois : ni l'origine de la page ni celle du schéma ne changent.
export function coverBlobMode() {
  if (mode === null) {
    let origin = null;
    try { origin = coverOrigin(); } catch { origin = null; }
    mode = coverNeedsBlob(origin, globalThis.location?.protocol);
  }
  return mode;
}

export function cachedCoverBlob(address) {
  return urls.get(address) ?? null;
}

// `true` quand l'URL blob est prête ; `false` sur toute autre réponse, que
// l'appelant traite comme une erreur d'image (diagnostic HEAD habituel).
export function loadCoverBlob(address, {
  request = (...args) => fetch(...args),
  create = blob => URL.createObjectURL(blob),
  revoke = url => URL.revokeObjectURL(url),
} = {}) {
  if (urls.has(address)) return Promise.resolve(true);
  if (!pending.has(address)) {
    pending.set(address, (async () => {
      try {
        const response = await request(address);
        if (response.status !== 200) return false;
        urls.set(address, create(await response.blob()));
        if (urls.size > MAX_BLOBS) {
          const [oldest, url] = urls.entries().next().value;
          urls.delete(oldest);
          revoke(url);
        }
        return true;
      } catch {
        return false;
      } finally {
        pending.delete(address);
      }
    })());
  }
  return pending.get(address);
}
