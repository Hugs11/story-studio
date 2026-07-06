import { useEffect } from 'react';
import { isTextEditingTarget } from '../store/projectStore';
import { findShortcutAction } from '../store/keyboardShortcuts';
import { isModalSurfaceOpen } from '../utils/modalSurfaces';

export function useAppShortcuts({ actionsRef, keyboardShortcutsRef, saveHandlerRef, saveAsHandlerRef }) {
  useEffect(() => {
    function handleKeyDown(e) {
      const shouldBlockNativeFind = e.ctrlKey
        && !e.shiftKey
        && !e.altKey
        && !e.metaKey
        && (e.code === 'KeyF' || e.code === 'KeyG');
      const stopShortcut = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
      };
      // Sous une modale : aucun raccourci global. On neutralise seulement l'UI
      // de recherche native (preventDefault) sans stopper la propagation, pour
      // que les gestionnaires locaux de la modale reçoivent la touche (p. ex.
      // enregistrer Ctrl+F comme raccourci dans la modale dédiée).
      if (isModalSurfaceOpen()) {
        if (shouldBlockNativeFind) e.preventDefault();
        return;
      }

      if (shouldBlockNativeFind) stopShortcut();

      const actions = actionsRef.current;
      const actionId = findShortcutAction(e, keyboardShortcutsRef.current, 'general');
      if (!actionId) return;

      if (actionId === 'saveAs') {
        stopShortcut();
        saveAsHandlerRef.current?.();
        return;
      }

      if (actionId === 'saveProject') {
        stopShortcut();
        saveHandlerRef.current?.();
        return;
      }

      if (actionId === 'addFolder') {
        if (!actions.canAddFolder) return;
        stopShortcut();
        actions.addFolder?.();
        return;
      }

      if (actionId === 'newProject') {
        stopShortcut();
        actions.newProject?.();
        return;
      }

      if (actionId === 'openProject') {
        stopShortcut();
        actions.openProject?.();
        return;
      }

      if (actionId === 'importStories') {
        if (!actions.canImportStories) return;
        stopShortcut();
        actions.importStories?.();
        return;
      }

      if (actionId === 'storySettings') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.openPackOptions?.();
        return;
      }

      if (actionId === 'tabEdit') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.closeDiagram?.();
        return;
      }

      if (actionId === 'tabDiagram') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.toggleDiagram?.();
        return;
      }

      if (actionId === 'tabOptions') {
        if (!actions.projectActionsVisible) return;
        stopShortcut();
        actions.openPreferences?.();
        return;
      }

      if (actionId === 'generate') {
        if (!actions.canGenerate) return;
        stopShortcut();
        actions.generate?.();
        return;
      }

      if (actionId === 'treeSearch') {
        stopShortcut();
        if (!actions.projectActionsVisible || !actions.treeSearchVisible) return;
        actions.focusTreeSearch?.();
        return;
      }

      if (actionId === 'toggleValidation') {
        if (!actions.projectActionsVisible || !actions.hasValidationErrors) return;
        stopShortcut();
        actions.toggleValidation?.();
        return;
      }

      if (actionId === 'undo') {
        if (isTextEditingTarget(e.target)) return;
        if (!actions.canUndo) return;
        stopShortcut();
        actions.undo?.();
        return;
      }

      if (actionId === 'redo') {
        if (isTextEditingTarget(e.target)) return;
        if (!actions.canRedo) return;
        stopShortcut();
        actions.redo?.();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
