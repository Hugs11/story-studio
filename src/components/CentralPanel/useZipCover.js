// Charge l'image de couverture d'un ZIP importe via la commande Tauri
// `get_pack_asset` et retourne une object URL Blob. Revoque l'URL au demontage
// ou au changement de zipPath/coverImage.
// Extrait de FullDiagramTree.jsx.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MIME } from './flowDiagramLayout';
import { toPackAssetName } from '../../utils/zipAssetName';

export function useZipCover(zipPath, coverImage) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!zipPath || !coverImage) {
      setUrl(null);
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    const assetName = toPackAssetName(coverImage);

    invoke('get_pack_asset', { zipPath, assetName })
      .then((bytes) => {
        if (cancelled) return;
        const ext = coverImage.split('.').pop().toLowerCase();
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'image/png' }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [zipPath, coverImage]);

  return url;
}
