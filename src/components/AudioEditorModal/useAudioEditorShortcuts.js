// Hook : ecoute les raccourcis clavier de la modale d'edition audio et
// dispatch vers les actions fournies par l'orchestrateur AudioEditorModal.
// Extrait de AudioEditorModal.jsx.
//
// L'orchestrateur passe :
//   - un drapeau `isLoading` (le hook s'efface tant que la waveform charge)
//   - les conditions `canOperate` / `canCut` qui gardent trim/cut
//   - un objet `actions` regroupant les 17 callbacks (undo, zoom in/out,
//     clear in/out, keep selection, cut selection, play/pause, nudge -/+,
//     go start/end, shuttle back/stop/fwd, mark in/out, preview in/out)
//
// On garde l'eslint-disable react-hooks/exhaustive-deps : les actions sont
// definies dans le scope du composant et capturent les latest values via
// les deps listees. Lister tous les handlers re-attacherait l'event
// listener a chaque render.

import { useEffect } from 'react';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';

export function useAudioEditorShortcuts({
  isLoading,
  canOperate,
  canCut,
  stagedEdit,
  previewPath,
  actions,
}) {
  useEffect(() => {
    if (isLoading) return undefined;
    function handleKey(e) {
      const target = e.target;
      if (
        target?.tagName === 'TEXTAREA'
        || target?.tagName === 'INPUT'
        || target?.tagName === 'SELECT'
        || target?.isContentEditable
      ) return;
      const actionId = findShortcutAction(e, getCurrentShortcuts(), 'audioEditor');
      if (!actionId) return;
      e.preventDefault();
      switch (actionId) {
        case 'audioUndo':
          if (stagedEdit || previewPath) actions.undo();
          return;
        case 'audioZoomIn': actions.zoomIn(); return;
        case 'audioZoomOut': actions.zoomOut(); return;
        case 'audioClearIn': actions.clearStart(); return;
        case 'audioClearOut': actions.clearEnd(); return;
        case 'audioKeepSelection':
          if (canOperate) actions.trimSelection();
          return;
        case 'audioCutSelection':
          if (canCut) actions.cutSelection();
          return;
        case 'audioPlayPause': actions.playPause(); return;
        case 'audioNudgeBack': actions.nudgeBack(); return;
        case 'audioNudgeFwd': actions.nudgeForward(); return;
        case 'audioGoStart': actions.goToStart(); return;
        case 'audioGoEnd': actions.goToEnd(); return;
        case 'audioShuttleBack': actions.shuttleBack(); return;
        case 'audioShuttleStop': actions.shuttleStop(); return;
        case 'audioShuttleFwd': actions.shuttleForward(); return;
        case 'audioMarkIn': actions.markStart(); return;
        case 'audioMarkOut': actions.markEnd(); return;
        case 'audioPreviewIn': actions.previewIn(); return;
        case 'audioPreviewOut': actions.previewOut(); return;
        default: return;
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  // reason: handler clavier global, actions captures dans le scope du composant
  // appelant via deps listees. Lister tous les handlers re-attacherait l'event
  // listener a chaque render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, stagedEdit, previewPath, canOperate, canCut]);
}
