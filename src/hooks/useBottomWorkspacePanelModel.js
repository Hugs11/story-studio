import { useEffect, useMemo } from 'react';
import { KEYS } from '../store/persistentSettings';
import { collectMediaLibrary } from '../store/mediaLibrary';
import { usePersistentState } from './usePersistentState';

// Codec booléen privé du panneau bas (`bottomPanelOpen`). Copie locale : il n'y a
// pas de raison de partager un helper tant qu'un seul consommateur l'utilise.
const BOOL_CODEC = { decode: (raw) => raw === 'true', encode: (value) => String(!!value) };

// Modèle du panneau de travail bas et de la bottombar : état ouvert/onglet
// actif (persistés), ouverture automatique depuis la file de rendu, compteurs
// médias/IA. Déplacement pur du haut d'AppContent.
//
// Ordre d'appel critique dans l'hôte : `setOpen`/`setActiveTab` sont passés à
// `useAiGeneration` (ouverture de la file IA) — ce hook doit donc être appelé
// AVANT `useAiGeneration`. `mediaLibraryPaths` vient de `useMediaLibraryPaths`,
// qui doit précéder. `mediaLibraryCountRef` est fournie par l'hôte (consommée par
// useWorkSession/useAutosave) : le hook la synchronise à chaque rendu.
//
// Fidélité de persistance : `bottomPanelOpen` via le codec booléen ci-dessus,
// `bottomPanelTab` en string brute, sans codec (comportement historique).
// Ne pas ajouter de mémoïsation — seul le `useMemo` déjà présent
// (`mediaLibraryCount`) est déplacé tel quel.
export function useBottomWorkspacePanelModel({
  project,
  pathAudit,
  sdJobs,
  xttsJobs,
  sdPendingCount,
  xttsPendingCount,
  sdHasResults,
  xttsHasResults,
  mediaLibraryPaths,
  mediaLibraryCountRef,
  renderQueue,
}) {
  const [open, setOpen] = usePersistentState(KEYS.BOTTOM_PANEL_OPEN, false, BOOL_CODEC);
  const [activeTab, setActiveTab] = usePersistentState(KEYS.BOTTOM_PANEL_TAB, 'media');

  const aiQueueActiveCount = sdPendingCount + xttsPendingCount;
  const aiQueueHasResults = sdHasResults || xttsHasResults;

  useEffect(() => {
    if (renderQueue.panelOpen) {
      setOpen(true);
      setActiveTab('queue');
      renderQueue.setPanelOpen(false);
    }
  }, [renderQueue.panelOpen, renderQueue.setPanelOpen]);

  const mediaLibraryCount = useMemo(
    () => collectMediaLibrary({ project, statusByPath: pathAudit, sdJobs, xttsJobs, extraPaths: mediaLibraryPaths }).length,
    [project, pathAudit, sdJobs, xttsJobs, mediaLibraryPaths],
  );
  mediaLibraryCountRef.current = mediaLibraryCount;

  const openTab = (tab) => {
    setActiveTab(tab);
    setOpen(true);
  };
  const close = () => setOpen(false);

  return {
    open,
    activeTab,
    setOpen,
    setActiveTab,
    openTab,
    close,
    mediaLibraryCount,
    aiQueueActiveCount,
    aiQueueHasResults,
  };
}
