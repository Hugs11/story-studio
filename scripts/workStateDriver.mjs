// Pilote des transitions réelles de `useProjectStore`, hors React.
//
// Il n'ajoute aucune règle : il enchaîne `normalizeWorkProject` et les trois
// transitions d'historique dans l'ordre exact où le store les appelle, en
// remplaçant seulement `useState`/`useRef` par des variables. Le double est
// donc React, jamais la décision testée.

import {
  normalizeWorkProject,
  pushWorkHistory,
  redoWorkHistory,
  undoWorkHistory,
} from '../src/store/projectWorkState.js';

export function workState(initial) {
  let state = { project: normalizeWorkProject(initial), history: [], redo: [], epoch: 0 };
  return {
    get project() { return state.project; },
    get history() { return state.history; },
    get redo() { return state.redo; },
    get epoch() { return state.epoch; },
    // Installation : l'historique est vidé, comme `store.loadProject`.
    install(next) {
      state = {
        project: normalizeWorkProject(next), history: [], redo: [], epoch: state.epoch + 1,
      };
    },
    mutate(build) {
      const next = normalizeWorkProject(build(state.project));
      state = {
        project: next,
        history: pushWorkHistory(state.history, state.project),
        redo: [],
        epoch: state.epoch,
      };
    },
    undo() {
      const step = undoWorkHistory({ ...state, current: state.project });
      if (step) state = { ...state, ...step };
      return !!step;
    },
    redo() {
      const step = redoWorkHistory({ ...state, current: state.project });
      if (step) state = { ...state, ...step };
      return !!step;
    },
  };
}
