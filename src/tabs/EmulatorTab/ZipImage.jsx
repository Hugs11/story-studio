import { useEffect, useState } from 'react';
import { getZipAssetUrl } from './useUrlCache';

export function ZipImage({ zipPath, assetName }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!zipPath || !assetName) { setUrl(null); return; }
    let cancelled = false;
    getZipAssetUrl(zipPath, assetName)
      .then(nextUrl => {
        if (cancelled) return;
        setUrl(nextUrl);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [zipPath, assetName]);
  return url
    ? <img src={url} alt="" className="lunii-story-img" />
    : <div className="lunii-story-img lunii-story-img--empty" />;
}
