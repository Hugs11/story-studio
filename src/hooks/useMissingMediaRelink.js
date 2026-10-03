import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  buildRelinkSignature,
  collectMissingMedia,
  planAdvancedRelink,
  relinkMediaLibraryPaths,
  relinkMediaTags,
  relinkProjectMedia,
} from '../store/missingMediaRelink';
import { GESTURE_APPLIED } from '../store/advancedAuthoring/authoringSession';
import { advancedGestures } from '../store/projectModel/advancedGestures';
import { readMediaBindings } from '../store/projectModel/mediaBindings';
import { createMediaTagLookup, withMediaTag } from '../store/mediaTags';
import { isAdvancedProject } from '../store/projectWorkState';
import { pathKey } from '../utils/fileUtils';
import { logger } from '../utils/logger';

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
// Côté graphe, relier un fichier déplacé est un **geste d'auteur** : il part par
// `repoint-media`, il entre dans l'historique, et il est annulable. Rien n'est
// réécrit dans le document par JavaScript, qui ne l'ouvre pas.
//
// Les gestes partent **un par un et dans l'ordre** : la session n'en accepte
// qu'un en vol et refuserait les suivants par `busy`. Un pas refusé arrête la
// série — les pas déjà appliqués restent, chacun avec son pas d'annulation, et
// l'auteur voit le refus par la notice de l'espace graphe.
//
// Conséquence assumée, faute de geste groupé dans le dialecte : **relier N
// fichiers produit N pas d'annulation**, pas un seul.
async function applyAdvancedRelink(project, replacements, advancedAuthoring) {
  const plan = planAdvancedRelink(project, replacements);
  const appliedReplacements = new Map();
  if (plan.length === 0) return { applied: 0, replacements: appliedReplacements, project: null, refusal: null };
  let latest = null;
  let applied = 0;
  for (const step of plan) {
    // `present: true` : le modal ne propose que des fichiers qu'il a vus sur le
    // disque, et c'est cette présence qui rend la liaison `resolved` plutôt que
    // `missing`.
    const gesture = advancedGestures.repointMedia(step.assetRef, { path: step.path, present: true });
    const outcome = await advancedAuthoring.runGesture(gesture);
    if (outcome?.status !== GESTURE_APPLIED) {
      logger.warn(`relink:advanced-stopped assetRef=${step.assetRef} status=${outcome?.status ?? 'inconnu'}`);
      return { applied, replacements: appliedReplacements, project: latest, refusal: outcome ?? null };
    }
    latest = outcome.project;
    applied += 1;
    appliedReplacements.set(step.previousPath, step.path);
  }
  return { applied, replacements: appliedReplacements, project: latest, refusal: null };
}

export function useMissingMediaRelink({
  store,
  advancedAuthoring,
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
    const advanced = isAdvancedProject(store.project);
    let nextProject;
    let appliedReplacements = replacements;
    let partiallyApplied = false;
    if (advanced) {
      const outcome = await applyAdvancedRelink(store.project, replacements, advancedAuthoring);
      // Les gestes ont déjà installé le projet par la session. Un refus au
      // premier pas ne laisse rien : on n'écrit alors ni étiquettes, ni
      // catalogue, ni signature, pour que la proposition se represente.
      if (outcome.applied === 0) return;
      nextProject = outcome.project;
      appliedReplacements = outcome.replacements;
      partiallyApplied = outcome.refusal !== null;
    } else {
      nextProject = relinkProjectMedia(store.project, replacements);
      store.setProject(nextProject);
    }

    // Étiquettes et catalogue suivent uniquement les fichiers effectivement
    // reliés. Une liaison refusée peut encore utiliser le même ancien fichier.
    let nextMediaTags = relinkMediaTags(store.mediaTags, appliedReplacements);
    const nextMediaLibraryPaths = relinkMediaLibraryPaths(mediaLibraryPathsRef.current, appliedReplacements);
    if (advanced && partiallyApplied) {
      const remainingBindings = readMediaBindings(nextProject);
      const remainingPaths = new Set(remainingBindings.map((binding) => pathKey(binding.path)));
      const originalTagsFor = createMediaTagLookup(store.mediaTags);
      for (const { path } of remainingBindings) {
        for (const tag of originalTagsFor(path)) nextMediaTags = withMediaTag(nextMediaTags, path, tag);
      }
      const libraryKeys = new Set(nextMediaLibraryPaths.map(pathKey));
      for (const path of mediaLibraryPathsRef.current) {
        if (remainingPaths.has(pathKey(path)) && !libraryKeys.has(pathKey(path))) {
          nextMediaLibraryPaths.push(path);
          libraryKeys.add(pathKey(path));
        }
      }
    }
    store.setMediaTags(nextMediaTags);
    setMediaLibraryPaths(nextMediaLibraryPaths);
    mediaLibraryPathsRef.current = nextMediaLibraryPaths;
    setDismissedMissingMediaSignature(partiallyApplied ? '' : buildRelinkSignature(collectMissingMedia(nextProject, pathAudit)));
    if (saveAfter) {
      await handleSaveProject({
        projectOverride: nextProject,
        mediaTagsOverride: nextMediaTags,
        mediaLibraryPathsOverride: nextMediaLibraryPaths,
      });
    }
  }, [
    advancedAuthoring,
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
