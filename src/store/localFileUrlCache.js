// Chargement mutualise des fichiers locaux en object URLs.
//
// Deux roles :
//  - Plafonner le nombre de lectures disque simultanees. Quand beaucoup de
//    vignettes deviennent visibles d'un coup (typiquement au dezoom du
//    diagramme complet), on evite de saturer le pont IPC Tauri et le thread
//    principal avec des dizaines de `readFile` + decodages en parallele.
//  - Mutualiser les object URLs par couple (chemin, version) avec comptage de
//    references : chaque fichier n'est lu/decode qu'une fois tant que sa
//    version ne change pas, et son URL n'est revoquee qu'apres le dernier
//    consommateur.

import { readFile } from '@tauri-apps/plugin-fs';
import { pathKey } from '../utils/fileUtils';

const MAX_CONCURRENT_READS = 6;
const REVOKE_DELAY_MS = 1000;

let activeReads = 0;
const pendingReads = [];

function pumpReads() {
  while (activeReads < MAX_CONCURRENT_READS && pendingReads.length > 0) {
    const job = pendingReads.shift();
    activeReads += 1;
    job();
  }
}

// Lecture disque passee par une file d'attente bornee a MAX_CONCURRENT_READS.
function readFileLimited(path) {
  return new Promise((resolve, reject) => {
    pendingReads.push(() => {
      readFile(path).then(resolve, reject).finally(() => {
        activeReads -= 1;
        pumpReads();
      });
    });
    pumpReads();
  });
}

function revokeSoon(url) {
  if (!url) return;
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

// cle "chemin\u0000version" -> { refCount, objectUrl, promise }
const entries = new Map();

function entryKey(path, version) {
  return `${pathKey(path)}\u0000${version ?? ''}`;
}

// Acquiert l'object URL d'un fichier. Retourne la promesse de l'URL et une
// fonction `release` (idempotente) a appeler quand le consommateur n'en a plus
// besoin. L'URL est partagee entre consommateurs ayant la meme (chemin, version)
// et revoquee une fois le compteur de references retombe a zero.
export function acquireLocalFileUrl({ path, mime, version }) {
  const key = entryKey(path, version);
  let entry = entries.get(key);

  if (!entry) {
    entry = { refCount: 0, objectUrl: null, promise: null };
    entry.promise = readFileLimited(path)
      .then((data) => {
        const url = URL.createObjectURL(new Blob([data], { type: mime || 'application/octet-stream' }));
        entry.objectUrl = url;
        return url;
      })
      .catch((error) => {
        // On retire l'entree fautive pour autoriser une nouvelle tentative.
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    entries.set(key, entry);
  }

  entry.refCount += 1;

  let released = false;
  function release() {
    if (released) return;
    released = true;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    if (entries.get(key) === entry) entries.delete(key);
    if (entry.objectUrl) revokeSoon(entry.objectUrl);
    else if (entry.promise) entry.promise.then(revokeSoon).catch(() => {});
  }

  return { promise: entry.promise, release };
}
