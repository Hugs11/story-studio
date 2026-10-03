// La session de vue de l'éditeur avancé : fraîcheur, cache et ancrages réunis.
//
// Elle est **sans framework** — aucun import React — pour que tout ce que le
// qu'on doit prouver soit éprouvable sans monter une interface.
// Le hook React qui l'enveloppe ne fait que la brancher sur un rendu.
//
// Elle ne touche jamais au projet : elle ne fait pas `setProject`, n'appelle
// pas `withEditorState`, n'écrit aucune position et ne marque rien de modifié.
// C'est ce qu'elle doit démontrer : **aucun chemin de l'éditeur avancé n'écrit
// dans `editorState` ni ne le fait entrer dans l'historique**.

import { buildGraphIndex } from './graphViewModel.js';
import { applyCachedView } from './graphSelection.js';
import { createViewCacheWriter } from './viewCacheCadence.js';
import { pathKey } from '../../utils/fileUtils.js';
import {
  advanceTicket, createTicket, documentTicket, DOCUMENT_EVENTS,
  isDocumentTicketCurrent, replacedTicket, VIEW_EVENTS,
} from './viewTicket.js';

const VIEW_EVENT_VALUES = new Set(Object.values(VIEW_EVENTS));

// Une entrée peut être revisitée avant la fin de son ancienne écriture, y
// compris après démontage. Sérialiser par ancrage sans bloquer les autres projets.
const cacheWrites = new Map();
const cacheRetirements = new Map();
function cacheAnchor(project) {
  return JSON.stringify([project?.packIdentity ?? null,
    pathKey(project?.savePath) || pathKey(project?.sessionDir)]);
}
function serializeCacheWrite(key, write) {
  const previous = cacheWrites.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(write);
  cacheWrites.set(key, pending);
  const clean = () => { if (cacheWrites.get(key) === pending) cacheWrites.delete(key); };
  pending.then(clean, clean);
  return pending;
}

export function createAdvancedViewSession({
  readGraphView, readViewCache, writeViewCache, now, setTimer, clearTimer,
  onCacheFailure = () => {},
} = {}) {
  let ticket = createTicket(0);
  // Deux descripteurs, et la distinction compte. `boundProject` est ce que
  // l'appelant a transmis — chemin de sauvegarde ou dossier de session ; c'est
  // lui que `rebindProject` compare, parce que c'est lui qui change à un
  // Save As. `descriptor` est celui qui **ancre le cache** : il porte en plus
  // l'identité du pack, que seul le DTO connaît et qui n'est donc lisible
  // qu'après la première lecture.
  let boundProject = null;
  let descriptor = null;
  let fingerprint = null;
  let index = null;
  let view = null;
  let viewport = null;
  let selection = { stages: [], actions: [] };
  let storedSelection = selection;
  let focus = null;
  let storedFocus = null;
  let notices = [];
  let writer = null;
  let readSequence = 0;
  let bindingSequence = 0;
  let pendingRebind = false;
  const listeners = new Set();

  function snapshotState() {
    return { ticket, view, index, viewport, selection, focus, notices: [...notices] };
  }
  function emit() {
    for (const listener of listeners) listener(snapshotState());
  }
  function cacheSnapshot() {
    return {
      viewport: viewport ? { ...viewport } : null,
      selection: { stages: [...storedSelection.stages], actions: [...storedSelection.actions] },
      lastFocusedPath: storedFocus,
    };
  }
  function resolveAnchors() {
    if (!index) return;
    const applied = applyCachedView({ index, entry: view.entry, cached: { view: cacheSnapshot() } });
    selection = applied.selection;
    focus = applied.focus;
  }

  // À la retraite, le fournisseur d'instantané devient une valeur figée avant
  // toute attente. Une écriture déjà partie ou encore en file ne lit plus B.
  function retireWriter() {
    if (!writer) return Promise.resolve({ flushed: false, reason: 'nothing-pending' });
    const previous = writer;
    writer = null;
    previous.freeze();
    // Une ancienne vidange peut avoir encore un dernier instantané à envoyer
    // après l'écriture en vol. Le prochain écrivain de cette clé l'attend aussi.
    const drained = Promise.all([previous.predecessor, previous.flushNow({ timeoutMs: null })]);
    cacheRetirements.set(previous.key, drained);
    void drained.finally(() => {
      if (cacheRetirements.get(previous.key) === drained) cacheRetirements.delete(previous.key);
    });
    return previous.flushNow();
  }
  function bindWriter(target) {
    const project = { ...target };
    const key = cacheAnchor(project);
    const retired = cacheRetirements.get(key) ?? Promise.resolve();
    let snapshot = () => ({ fingerprint, view: cacheSnapshot() });
    const bound = createViewCacheWriter({
      snapshot: () => snapshot(),
      // La valeur est capturée avant son entrée dans la file inter-sessions.
      write: async value => {
        await retired;
        return serializeCacheWrite(key, () => writeViewCache({ project, ...value }));
      },
      now, setTimer, clearTimer,
      onFailure: (error, state) => {
        if (writer !== bound) return;
        notices = [...notices, { kind: 'cache-failure', message: String(error?.message ?? error), disarmed: state.disarmed }];
        onCacheFailure(error, state);
        emit();
      },
    });
    bound.freeze = () => {
      const frozen = snapshot();
      snapshot = () => frozen;
    };
    bound.key = key;
    bound.predecessor = retired;
    return bound;
  }

  // L'identité de pack vient du document, jamais de l'appelant : JavaScript
  // n'ouvre pas le payload et ne saurait pas la lire. Tant qu'aucune lecture
  // n'a eu lieu, elle reste nulle — et la clé se réduit alors au chemin, ce que
  // prévoit explicitement la clé (`packIdentity ?? "-"`).
  function anchorDescriptor() {
    if (!boundProject) return null;
    return {
      ...boundProject,
      packIdentity: boundProject.packIdentity ?? view?.packIdentity?.value ?? null,
    };
  }

  async function loadGraph() {
    const sequence = ++readSequence;
    const captured = documentTicket(ticket);
    const current = () => sequence === readSequence
      && isDocumentTicketCurrent(captured, documentTicket(ticket));
    let loaded;
    try { loaded = await readGraphView(); }
    catch (error) {
      if (!current()) return { installed: false };
      throw error;
    }
    if (!current()) return { installed: false };
    view = loaded;
    fingerprint = loaded.documentFingerprint ?? null;
    index = buildGraphIndex(loaded);
    return { installed: true, current };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get state() { return snapshotState(); },

    async open({ projectEpoch, project }) {
      void retireWriter();
      const binding = ++bindingSequence;
      ticket = replacedTicket(projectEpoch);
      boundProject = { ...project };
      pendingRebind = false;
      // La vue précédente est oubliée **avant** que l'ancrage soit calculé :
      // sinon l'identité du document quitté ancrerait le suivant.
      view = index = fingerprint = viewport = null;
      descriptor = anchorDescriptor();
      selection = storedSelection = { stages: [], actions: [] };
      focus = storedFocus = null;
      notices = [];
      emit();
      const loaded = await loadGraph();
      if (!loaded.installed || !loaded.current() || binding !== bindingSequence) return { installed: false };
      // L'identité n'est connue qu'ici : l'ancrage est donc fixé **après** la
      // lecture et **avant** que le cache soit lu ou écrit, pour que les deux
      // portent la même clé.
      descriptor = anchorDescriptor();
      writer = bindWriter(descriptor);
      const viewRevision = ticket.viewRevision;
      const current = () => loaded.current() && binding === bindingSequence;
      let cached = null;
      try {
        cached = await readViewCache({ project: descriptor, fingerprint });
      } catch (error) {
        if (!current()) return { installed: false };
        notices = [...notices, { kind: 'cache-unreadable', message: String(error?.message ?? error) }];
      }
      if (!current()) return { installed: false };
      // Une interaction pendant l'ouverture prime sur le cache relu.
      if (ticket.viewRevision === viewRevision) {
        const applied = applyCachedView({ index, cached, entry: view.entry });
        viewport = applied.viewport;
        storedSelection = {
          stages: [...(cached?.view?.selection?.stages ?? [])],
          actions: [...(cached?.view?.selection?.actions ?? [])],
        };
        storedFocus = cached?.view?.lastFocusedPath ?? null;
        if (applied.viewportRejected) notices.push({ kind: 'viewport-rejected' });
        if (applied.ignoredAnchors) notices.push({ kind: 'anchors-ignored', count: applied.ignoredAnchors });
      }
      resolveAnchors();
      emit();
      return { installed: true, appliedFromCache: cached !== null && ticket.viewRevision === viewRevision };
    },

    noteViewEvent(event, patch = {}) {
      if (!VIEW_EVENT_VALUES.has(event)) throw new Error(`Événement de vue inconnu : ${event}`);
      ticket = advanceTicket(ticket, event);
      if (Object.hasOwn(patch, 'viewport')) viewport = patch.viewport ? { ...patch.viewport } : null;
      if (Object.hasOwn(patch, 'selection')) storedSelection = {
        stages: [...patch.selection.stages], actions: [...patch.selection.actions],
      };
      if (Object.hasOwn(patch, 'focus')) storedFocus = patch.focus;
      if (Object.hasOwn(patch, 'selection') || Object.hasOwn(patch, 'focus')) resolveAnchors();
      if (event !== VIEW_EVENTS.DRAG_PREVIEW) writer?.noteChange();
      emit();
      return ticket;
    },

    async noteDocumentEvent(event) {
      ticket = advanceTicket(ticket, event);
      const loaded = await loadGraph();
      if (!loaded.installed || !loaded.current()) return { installed: false };
      // Une révision peut avoir périmé l'ouverture avant son premier DTO.
      // Ne pas laisser la session sans écrivain, ni envoyer une empreinte nulle.
      if (!writer) writer = bindWriter(descriptor);
      if (pendingRebind) { writer.noteChange(); pendingRebind = false; }
      resolveAnchors();
      // La caméra et les ancrages stockés sont ceux du moment de l'installation.
      emit();
      return { installed: true };
    },

    rebindProject(project) {
      // La comparaison porte sur ce que l'appelant transmet : ajouter
      // l'identité des deux côtés ferait croire à un changement de projet au
      // premier rendu qui suit la lecture.
      if (cacheAnchor(project) === cacheAnchor(boundProject)) return descriptor;
      void retireWriter();
      ++bindingSequence;
      boundProject = { ...project };
      descriptor = anchorDescriptor();
      pendingRebind = true;
      if (index) {
        writer = bindWriter(descriptor);
        writer.noteChange();
        pendingRebind = false;
      }
      resolveAnchors();
      emit();
      return descriptor;
    },

    async flush(options) {
      if (!writer) return { flushed: false, reason: 'nothing-pending' };
      return writer.flushNow(options);
    },

    // StrictMode peut remonter la même instance : invalider aussi les lectures
    // et figer les écritures lors de son nettoyage, sans désactiver la session.
    close() {
      ++readSequence;
      ++bindingSequence;
      const pending = retireWriter();
      view = index = null;
      return pending;
    },
    get writerDisarmed() { return writer?.disarmed === true; },
  };
}

export { DOCUMENT_EVENTS, VIEW_EVENTS };
