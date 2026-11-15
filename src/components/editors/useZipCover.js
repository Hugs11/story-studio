// Charge une jaquette fichier via useLocalFile, ou un asset du ZIP via Tauri
// `get_pack_asset` et retourne une object URL Blob. Revoque l'URL au demontage
// ou au changement de zipPath/coverImage.
// Extrait de FullDiagramTree.jsx.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MIME } from '../diagram/flowDiagramLayout';
import { isAbsoluteFilePath } from '../../utils/fileUtils.js';
import { useLocalFile } from '../../hooks/useLocalFile.js';
import { toPackAssetName } from '../../utils/zipAssetName';

export function useZipCover(zipPath, coverImage) {
  const [url, setUrl] = useState(null);
  const localCover = isAbsoluteFilePath(coverImage);
  const fileUrl = useLocalFile(localCover ? coverImage : null);

  useEffect(() => {
    if (!zipPath || !coverImage || localCover) {
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
  }, [zipPath, coverImage, localCover]);

  return localCover ? fileUrl : url;
}
