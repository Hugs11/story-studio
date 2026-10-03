// Ordonnanceur React de test : le seul double des tests de hooks.
//
// Il remplace `useState`/`useRef`/`useCallback`/`useEffect` par des variables et
// un rendu déclenché explicitement — aucune règle métier n'est recopiée, les
// hooks de production sont importés intacts. Importer ce module installe deux
// résolutions : `react` pointe ici, et `import.meta.env.DEV` du logger devient
// `false`, puisque Node n'a pas la variable d'environnement de Vite.
//
// Importer ce module **avant** les hooks à éprouver : la résolution doit être
// installée avant que leur graphe ne soit chargé.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react') return { url: import.meta.url, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith('/src/utils/logger.js')) return result;
    const source = typeof result.source === 'string'
      ? result.source
      : new TextDecoder().decode(result.source);
    return { ...result, source: source.replaceAll('import.meta.env.DEV', 'false') };
  },
});

let active = null;

export function runner(component, { doubleInvokeStateUpdaters = false } = {}) {
  const state = {
    slots: [], cursor: 0, effects: [], mountedEffects: new Map(), doubleInvokeStateUpdaters,
  };
  return {
    render() {
      active = state;
      state.cursor = 0;
      try {
        return component();
      } finally {
        active = null;
      }
    },
    flush() {
      state.effects.splice(0).forEach((effect) => effect());
    },
    replayEffects() {
      for (const effect of state.mountedEffects.values()) effect.cleanup?.();
      for (const effect of state.mountedEffects.values()) effect.cleanup = effect.setup();
    },
    unmount() {
      for (const [slot, effect] of state.mountedEffects) {
        effect.cleanup?.();
        state.slots[slot] = undefined;
      }
      state.mountedEffects.clear();
      state.effects = [];
    },
  };
}

export function useState(initial) {
  const state = active;
  const slot = state.cursor++;
  if (!(slot in state.slots)) {
    state.slots[slot] = typeof initial === 'function' ? initial() : initial;
  }
  return [
    state.slots[slot],
    (next) => {
      if (typeof next !== 'function') {
        state.slots[slot] = next;
        return;
      }
      if (state.doubleInvokeStateUpdaters) next(state.slots[slot]);
      state.slots[slot] = next(state.slots[slot]);
    },
  ];
}

export function useRef(initial) {
  const state = active;
  const slot = state.cursor++;
  state.slots[slot] ??= { current: initial };
  return state.slots[slot];
}

export function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

export function useMemo(factory, deps) {
  const state = active;
  const slot = state.cursor++;
  const previous = state.slots[slot];
  if (!previous || depsChanged(previous.deps, deps)) {
    state.slots[slot] = { value: factory(), deps };
  }
  return state.slots[slot].value;
}

function depsChanged(previous, next) {
  return !previous || !next || previous.length !== next.length
    || next.some((dep, index) => !Object.is(dep, previous[index]));
}

export function useEffect(fn, deps) {
  const state = active;
  const slot = state.cursor++;
  const previous = state.slots[slot];
  if (depsChanged(previous, deps)) {
    state.effects.push(() => {
      state.mountedEffects.get(slot)?.cleanup?.();
      state.mountedEffects.set(slot, { setup: fn, cleanup: fn() });
    });
  }
  state.slots[slot] = deps;
}
