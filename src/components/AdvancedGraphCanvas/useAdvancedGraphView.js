// Le raccord React de la session de vue avancée.
//
// Il ne contient **aucune règle** : la fraîcheur, la cadence du cache, les
// ancrages et le focus vivent dans `advancedViewSession.js`, qui ne dépend pas
// de React et qui est éprouvé sans lui. Ce hook ne fait que trois choses :
// s'abonner à la session, la piloter depuis les gestes de l'interface, et la
// vider proprement au démontage.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAdvancedViewSession, DOCUMENT_EVENTS, VIEW_EVENTS } from '../../store/advancedGraphView/advancedViewSession.js';
import { createAdvancedViewBridge } from '../../store/advancedGraphView/advancedViewBridge.js';
import { searchGraph, SEARCH_SCOPES } from '../../store/advancedGraphView/graphSearch.js';
import { nodeRoles } from '../../store/advancedGraphView/graphRoles.js';
import { inspectNode, layoutExtent } from '../../store/advancedGraphView/graphViewModel.js';
import { fitViewport } from '../../store/advancedGraphView/graphGeometry.js';

export function useAdvancedGraphView({
  payload,
  projectDescriptor,
  projectEpoch,
  bridge = null,
}) {
  const transport = useMemo(() => bridge ?? createAdvancedViewBridge(), [bridge]);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const session = useMemo(() => createAdvancedViewSession({
    readGraphView: () => transport.readGraphView(payloadRef.current),
    readViewCache: transport.readViewCache,
    writeViewCache: transport.writeViewCache,
  }), [transport]);
  const previousInput = useRef(null);
  const [state, setState] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const { packIdentity = null, savePath = null, sessionDir = null } = projectDescriptor ?? {};

  useEffect(() => session.subscribe(setState), [session]);

  useEffect(() => {
    let cancelled = false;
    if (payload === null || payload === undefined) {
      previousInput.current = null;
      void session.close();
      setState(null);
      setStatus('idle');
      setError(null);
      return undefined;
    }
    const previous = previousInput.current;
    const project = { packIdentity, savePath, sessionDir };
    previousInput.current = { session, projectEpoch, payload };
    setError(null);
    let pending;
    if (!previous || previous.session !== session || previous.projectEpoch !== projectEpoch) {
      pending = session.open({ projectEpoch, project });
    } else {
      // Save As est neutre pour le document et conserve la caméra courante.
      session.rebindProject(project);
      pending = previous.payload !== payload || !session.state.index
        ? session.noteDocumentEvent(DOCUMENT_EVENTS.REINSTALLED)
        : Promise.resolve({ installed: true });
    }
    setStatus('loading');
    pending.then(outcome => {
      if (!cancelled) setStatus(outcome.installed ? 'ready' : 'superseded');
    }).catch(failure => {
      if (cancelled) return;
      setError(failure);
      setStatus('failed');
    });
    return () => { cancelled = true; };
  }, [session, payload, packIdentity, savePath, sessionDir, projectEpoch]);

  useEffect(() => () => {
    previousInput.current = null;
    void session.close();
  }, [session]);

  const noteViewport = useCallback((viewport) => {
    session.noteViewEvent(VIEW_EVENTS.PAN, { viewport });
  }, [session]);

  const noteSelection = useCallback((paths, index, options = {}) => {
    // La sélection est rangée par collection : les deux natures de nœud sont
    // distinctes dans le document comme dans la vue.
    const stages = [];
    const actions = [];
    for (const path of paths) {
      const entry = index?.byPath.get(path);
      if (!entry) continue;
      (entry.kind === 'stage' ? stages : actions).push(path);
    }
    const patch = { selection: { stages, actions } };
    if (Object.hasOwn(options, 'focus')) patch.focus = options.focus;
    session.noteViewEvent(VIEW_EVENTS.SELECTION, patch);
  }, [session]);

  const noteFocus = useCallback((path) => {
    session.noteViewEvent(VIEW_EVENTS.FOCUS, { focus: path });
  }, [session]);

  const search = useCallback(
    (options) => (state?.index ? searchGraph(state.index, options) : { results: [], total: 0, truncated: false }),
    [state?.index],
  );

  const inspected = useMemo(
    () => (state?.index && state?.focus ? inspectNode(state.index, state.focus) : null),
    [state?.index, state?.focus],
  );

  // Les rôles de l'index — entrée, doublon, cul-de-sac, sans entrée, isolé,
  // inaccessible, diagnostiqué. Un seul calcul, mémorisé sur l'index, lu par
  // le canvas, la liste et les filtres : c'est ce qui les empêche de dire
  // trois choses différentes du même nœud.
  const roles = useMemo(() => nodeRoles(state?.index ?? null), [state?.index]);

  const initialViewport = useCallback((size) => {
    const current = session.state;
    if (!current.index) return null;
    // Le cadrage d'ouverture est calculé sur l'étendue **mesurée**, jamais sur
    // une limite de zoom reprise d'une autre surface.
    return current.viewport ?? fitViewport(layoutExtent(current.index), size);
  }, [session]);

  return {
    status,
    error,
    view: state?.view ?? null,
    index: state?.index ?? null,
    viewport: state?.viewport ?? null,
    selection: state?.selection ?? { stages: [], actions: [] },
    focus: state?.focus ?? null,
    notices: state?.notices ?? [],
    ticket: state?.ticket ?? null,
    inspected,
    roles,
    search,
    scopes: SEARCH_SCOPES,
    noteViewport,
    noteSelection,
    noteFocus,
    initialViewport,
    session,
  };
}
