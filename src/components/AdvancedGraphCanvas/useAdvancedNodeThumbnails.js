// Miniatures locales des Écrans avancés.
//
// La liste et le résumé des connexions montrent les mêmes nœuds : ils doivent
// donc acquérir leurs images par la même cache locale, avec la même validation
// de liaison média et la même libération des URL temporaires.

import { useEffect, useState } from 'react';

import { acquireLocalFileUrl } from '../../store/localFileUrlCache.js';
import { MEDIA_BINDING_RESOLVED, mediaBindingsByAssetRef } from '../../store/projectModel/mediaBindings.js';
import { MIME } from '../../utils/mimeTypes.js';

export function useAdvancedNodeThumbnails(project, entries) {
  const [thumbnailUrls, setThumbnailUrls] = useState(() => new Map());

  useEffect(() => {
    if (!project) {
      setThumbnailUrls(new Map());
      return undefined;
    }
    const bindings = mediaBindingsByAssetRef(project);
    const pathsByAssetRef = new Map();
    for (const entry of entries ?? []) {
      const assetRef = entry.kind === 'stage' && entry.node.image?.presence === 'value'
        ? entry.node.image.assetRef
        : null;
      if (!assetRef) continue;
      const paths = pathsByAssetRef.get(assetRef) ?? [];
      paths.push(entry.path);
      pathsByAssetRef.set(assetRef, paths);
    }

    let cancelled = false;
    const releases = [];
    const pending = [];
    for (const [assetRef, paths] of pathsByAssetRef) {
      const binding = bindings.get(assetRef);
      if (!binding?.path || binding.status !== MEDIA_BINDING_RESOLVED) continue;
      const extension = binding.path.split('.').pop()?.toLowerCase() ?? '';
      const acquisition = acquireLocalFileUrl({
        path: binding.path,
        mime: MIME[extension] || 'application/octet-stream',
        version: binding.status,
      });
      releases.push(acquisition.release);
      pending.push(acquisition.promise.then((url) => ({ paths, url })).catch(() => null));
    }
    void Promise.all(pending).then((resolved) => {
      if (cancelled) return;
      const next = new Map();
      for (const item of resolved) {
        if (!item) continue;
        for (const path of item.paths) next.set(path, item.url);
      }
      setThumbnailUrls(next);
    });
    return () => {
      cancelled = true;
      for (const release of releases) release();
    };
  }, [entries, project]);

  return thumbnailUrls;
}
