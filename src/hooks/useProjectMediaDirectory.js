import { useTreeTranslation } from "../i18n/useTreeTranslation.jsx";
import { presentTree } from "../i18n/treePresentation.js";
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectContext } from '../store/ProjectContext';
import { joinPath } from '../utils/fileUtils';

// Display the backend's collision resolution without creating folders or markers.
export function useProjectMediaDirectoryValue(category, fallback = null) {
  const { mediaStorage } = useProjectContext();
  const context = mediaStorage ?? fallback;
  const root = context?.root ?? '';
  const workId = context?.storage?.workId;
  const folder = context?.storage?.folder;
  const ephemeral = context?.ephemeral;
  const key = JSON.stringify([root, workId, folder, ephemeral, category]);
  const [resolved, setResolved] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!root || ephemeral || !workId) return undefined;
    invoke('resolve_project_folder', { root, folder, workId, create: false })
      .then(name => { if (!cancelled) setResolved({ key, value: joinPath(root, category, name) }); })
      .catch(() => { if (!cancelled) setResolved({ key, value: { key: "tree:directory.destination.failed" } }); });
    return () => { cancelled = true; };
  }, [root, workId, folder, ephemeral, category, key]);
  if (!root) return { key: "tree:directory.workspace.pending" };
  if (ephemeral || !workId) return joinPath(root, category);
  return resolved?.key === key ? resolved.value : { key: "tree:directory.destination.pending" };
}

export function useProjectMediaDirectory(category, fallback = null) {
  useTreeTranslation();
  return presentTree(useProjectMediaDirectoryValue(category, fallback));
}
