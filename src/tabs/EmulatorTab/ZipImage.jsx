import { useEffect, useState } from 'react';
import { getZipAssetUrl } from './useUrlCache';
import { createMediaRequestLifecycle } from './mediaRequestLifecycle';

export function ZipImage({ zipPath, assetName }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const lifecycle = createMediaRequestLifecycle({
      clearCurrent() { setUrl(null); },
      load(request) { return getZipAssetUrl(request.zipPath, request.assetName); },
      applyResource(nextUrl) { setUrl(nextUrl); },
      // Les object URLs sont détenues par useUrlCache et révoquées à la fermeture
      // du simulateur, jamais par un consommateur ZipImage isolé.
      discardResource() {},
    });
    lifecycle.request(zipPath && assetName ? { zipPath, assetName } : null);
    return () => lifecycle.invalidate({ clear: false });
  }, [zipPath, assetName]);
  return url
    ? <img src={url} alt="" className="lunii-story-img" />
    : <div className="lunii-story-img lunii-story-img--empty" />;
}
