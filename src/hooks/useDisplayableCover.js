import { useEffect, useState } from 'react';
import { cachedCoverBlob, coverNeedsBlob, loadCoverBlob } from '../store/catalogue/coverDisplay.js';

// Adresse de jaquette affichable dans <img> : telle quelle, sauf page http(s) +
// schéma personnalisé (WebKitGTK en dev, voir coverDisplay.js) où elle devient
// une URL blob. `null` tant que l'image n'est pas prête ou en cas d'échec :
// l'appelant affiche alors son icône de repli.
export function useDisplayableCover(address, { protocol = globalThis.location?.protocol, load = loadCoverBlob } = {}) {
  const [, setReady] = useState(0);
  const blob = Boolean(address) && coverNeedsBlob(address, protocol);
  const pending = blob && !cachedCoverBlob(address) ? address : null;
  useEffect(() => {
    if (!pending) return undefined;
    let live = true;
    void load(pending).then(ready => { if (live && ready) setReady(n => n + 1); });
    return () => { live = false; };
  }, [pending, load]);
  if (!address) return null;
  return blob ? cachedCoverBlob(address) : address;
}
