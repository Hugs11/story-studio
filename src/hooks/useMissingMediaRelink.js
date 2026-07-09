import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  buildRelinkSignature,
  collectMissingMedia,
  relinkMediaLibraryPaths,
  relinkMediaTags,
  relinkProjectMedia,
} from '../store/missingMediaRelink';

// Grappe « média manquant » extraite d'AppContent. Détecte les médias introuvables
// (dérivés mémoïsés du projet + audit disque),
// calcule une signature de déduplication et applique le relink (projet + tags +
// chemins de bibliothèque), avec sauvegarde optionnelle.
//
// La signature `dismissed*` évite de re-proposer le même relink après un rejet :
// on masque le prompt tant que la liste de manquants (donc la signature) est
// identique à celle rejetée, et on la ré-arme dès qu'elle change. Le reset sur
// changement de `store.savePath` accompagne le changement de projet courant.
//
// Fournisseurs en amont : handleSaveProject (useSaveProgress) pour `saveAfter` —
// ce hook doit donc être appelé APRÈS useSaveProgress ; pathAudit vient de
// useProjectFileAudit ; mediaLibraryPathsRef/setMediaLibraryPaths de
// useMediaLibraryPaths.
//
// HORS de ce hook (restent dans App.jsx) : le calcul de `showMissingMediaRelink`
// (mêle projectType/savePath/pathAuditPending, propres à l'hôte) et le rendu de
// MissingMediaRelinkModal.
export function useMissingMediaRelink({
  store,
  mediaLibraryPathsRef,
  setMediaLibraryPaths,
  pathAudit,
  handleSaveProject,
}) {
  const [dismissedMissingMediaSignature, setDismissedMissingMediaSignature] = useState('');

  useEffect(() => {
    setDismissedMissingMediaSignature('');
  }, [store.savePath]);

  const missingMedia = useMemo(
    () => collectMissingMedia(store.project, pathAudit),
    [store.project, pathAudit],
  );
  const missingMediaSignature = useMemo(
    () => buildRelinkSignature(missingMedia),
    [missingMedia],
  );

  const handleApplyMissingMediaRelinks = useCallback(async (replacements, { saveAfter = false } = {}) => {
    const nextProject = relinkProjectMedia(store.project, replacements);
    const nextMediaTags = relinkMediaTags(store.mediaTags, replacements);
    const nextMediaLibraryPaths = relinkMediaLibraryPaths(mediaLibraryPathsRef.current, replacements);
    store.setProject(nextProject);
    store.setMediaTags(nextMediaTags);
    setMediaLibraryPaths(nextMediaLibraryPaths);
    mediaLibraryPathsRef.current = nextMediaLibraryPaths;
    setDismissedMissingMediaSignature(buildRelinkSignature(collectMissingMedia(nextProject, pathAudit)));
    if (saveAfter) {
      await handleSaveProject({
        projectOverride: nextProject,
        mediaTagsOverride: nextMediaTags,
        mediaLibraryPathsOverride: nextMediaLibraryPaths,
      });
    }
  }, [
    handleSaveProject,
    mediaLibraryPathsRef,
    pathAudit,
    setMediaLibraryPaths,
    store,
  ]);

  return {
    missingMedia,
    missingMediaSignature,
    dismissedMissingMediaSignature,
    setDismissedMissingMediaSignature,
    handleApplyMissingMediaRelinks,
  };
}
