import { useEffect, useState } from 'react';
import { createMediaRequestLifecycle } from './mediaRequestLifecycle';
import { mediaRequestKey } from './flatGraph.js';
import { loadFlatImageUrl } from './flatMedia.js';

// L'image d'un Écran, quelle que soit la provenance de ses octets. Un seul
// composant pour les deux sources : deux composants d'image feraient diverger
// le cycle de vie des requêtes, qui est précisément ce qui empêche une image
// arrivée trop tard de s'afficher sur l'Écran suivant.
export function FlatImage({ request }) {
  const [url, setUrl] = useState(null);
  const key = mediaRequestKey(request);
  useEffect(() => {
    const lifecycle = createMediaRequestLifecycle({
      clearCurrent() { setUrl(null); },
      load(input) { return loadFlatImageUrl(input); },
      applyResource(nextUrl) { setUrl(nextUrl); },
      discardResource() {},
    });
    lifecycle.request(request ?? null);
    return () => lifecycle.invalidate({ clear: false });
  // reason: `mediaRequestKey` porte les primitives de la requête ; l'objet est
  // reconstruit à chaque assemblage de graphe et son identité ne prouve rien.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url
    ? <img src={url} alt="" className="lunii-story-img" />
    : <div className="lunii-story-img lunii-story-img--empty" />;
}
