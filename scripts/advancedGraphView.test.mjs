// Modèle de lecture, fraîcheur, cadence et sélection de l'éditeur avancé.
//
// Tout est **pur** : aucun moteur d'affichage n'est chargé, et c'est la
// démonstration que la frontière tient. Si l'un de ces tests avait besoin de
// Cytoscape ou de G6 pour passer, le DTO ne serait pas indépendant du moteur et
// le banc d'essai reviendrait à construire deux fois l'interface.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceTicket,
  createGestureQueue,
  createTicket,
  documentTicket,
  DOCUMENT_EVENTS,
  isDocumentTicketCurrent,
  isForeignProject,
  NEUTRAL_EVENTS,
  replacedTicket,
  VIEW_EVENTS,
} from '../src/store/advancedGraphView/viewTicket.js';
import {
  ANNOUNCED_LOSS_WINDOW_MS,
  createViewCacheWriter,
  MOVEMENT_CEILING_MS,
  REST_DELAY_MS,
} from '../src/store/advancedGraphView/viewCacheCadence.js';
import {
  buildGraphIndex,
  detachedPaths,
  inspectNode,
  layoutExtent,
  nodeLabel,
} from '../src/store/advancedGraphView/graphViewModel.js';
import {
  moveListFocus,
  searchGraph,
  SEARCH_SCOPES,
} from '../src/store/advancedGraphView/graphSearch.js';
import {
  applyCachedView,
  focusAfterGraphSelection,
  resolveFocus,
  resolveSelection,
} from '../src/store/advancedGraphView/graphSelection.js';
import {
  centerOnNode,
  clampAuthoredPosition,
  fitViewport,
  zoomViewportAt,
  isNodeOnScreen,
  isUsableViewport,
  NODE_HALF_HEIGHT,
  NODE_HALF_WIDTH,
  SHORT_MAX,
  SHORT_MIN,
  viewportCenter,
} from '../src/store/advancedGraphView/graphGeometry.js';
import { action, presence, sampleView, stage } from './advancedViewFixtures.mjs';

// ── Fraîcheur ────────────────────────────────────────────────────────────────

test('un panoramique ou un zoom ne fait avancer que la révision de vue', () => {
  let ticket = createTicket(3);
  const before = documentTicket(ticket);
  for (const event of [VIEW_EVENTS.PAN, VIEW_EVENTS.ZOOM, VIEW_EVENTS.SELECTION, VIEW_EVENTS.FOCUS, VIEW_EVENTS.DRAG_PREVIEW]) {
    ticket = advanceTicket(ticket, event);
  }
  assert.equal(ticket.viewRevision, 5);
  // Le ticket de document est intact : aucune relecture, aucune readiness,
  // aucune revalidation n'est déclenchée par la navigation.
  assert.deepEqual(documentTicket(ticket), before);
  assert.ok(isDocumentTicketCurrent(before, documentTicket(ticket)));
});

test('un geste d\'auteur et un glisser confirmé font avancer le document', () => {
  let ticket = createTicket(1);
  ticket = advanceTicket(ticket, DOCUMENT_EVENTS.AUTHOR_GESTURE);
  ticket = advanceTicket(ticket, DOCUMENT_EVENTS.DRAG_COMMITTED);
  ticket = advanceTicket(ticket, DOCUMENT_EVENTS.UNDO);
  assert.equal(ticket.documentRevision, 3);
  assert.equal(ticket.viewRevision, 0);
});

test('un relevé de disque et une sauvegarde ne font avancer aucun compteur', () => {
  const ticket = createTicket(1);
  for (const event of Object.values(NEUTRAL_EVENTS)) {
    assert.deepEqual(advanceTicket(ticket, event), ticket);
  }
  // Un événement que personne n'a écrit ne fait rien non plus.
  assert.deepEqual(advanceTicket(ticket, 'inventé'), ticket);
});

test('un changement de projet périme tout ce qui est en vol', () => {
  let ticket = createTicket(1);
  ticket = advanceTicket(ticket, DOCUMENT_EVENTS.AUTHOR_GESTURE);
  const inFlight = documentTicket(ticket);
  const next = replacedTicket(2);
  assert.equal(next.documentRevision, 0);
  assert.equal(next.viewRevision, 0);
  assert.ok(!isDocumentTicketCurrent(inFlight, documentTicket(next)));
  assert.ok(isForeignProject(inFlight, documentTicket(next)));
});

test('une réponse d\'un état antérieur du même projet est périmée sans être étrangère', () => {
  let ticket = createTicket(1);
  const captured = documentTicket(ticket);
  ticket = advanceTicket(ticket, DOCUMENT_EVENTS.UNDO);
  const current = documentTicket(ticket);
  assert.ok(!isDocumentTicketCurrent(captured, current));
  assert.ok(!isForeignProject(captured, current));
});

test('un seul geste est en vol, et la file porte une intention, pas un payload', () => {
  const queue = createGestureQueue();
  assert.deepEqual(queue.enqueue({ gesture: 'a' }), { send: { gesture: 'a' } });
  assert.ok(queue.busy);
  // La seconde demande attend. La troisième remplace la seconde : l'auteur veut
  // le dernier état demandé, pas une rediffusion des états intermédiaires.
  assert.deepEqual(queue.enqueue({ gesture: 'b' }), { send: null, queued: true });
  assert.deepEqual(queue.enqueue({ gesture: 'c' }), { send: null, queued: true });
  assert.deepEqual(queue.settle(), { send: { gesture: 'c' } });
  assert.deepEqual(queue.settle(), { send: null });
  assert.ok(!queue.busy);
  // Aucune intention mise en file ne porte de payload : elles n'en ont pas.
  assert.equal(queue.pendingIntent, null);
});

// ── Cadence ──────────────────────────────────────────────────────────────────

function fakeClock() {
  let currentTime = 0;
  const timers = new Map();
  let nextHandle = 1;
  return {
    now: () => currentTime,
    setTimer(callback, delay) {
      const handle = nextHandle++;
      timers.set(handle, { at: currentTime + delay, callback });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    async advance(milliseconds) {
      const target = currentTime + milliseconds;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due || (guard += 1) > 1000) break;
        const [handle, timer] = due;
        timers.delete(handle);
        currentTime = timer.at;
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      currentTime = target;
      await Promise.resolve();
    },
  };
}

test('une écriture attend le repos de navigation et porte la dernière révision', async () => {
  const clock = fakeClock();
  const written = [];
  let revision = 0;
  const writer = createViewCacheWriter({
    write: async (value) => { written.push(value); },
    snapshot: () => ({ revision }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  revision = 1;
  writer.noteChange();
  await clock.advance(REST_DELAY_MS - 1);
  assert.deepEqual(written, [], 'rien n\'est écrit avant le repos');
  revision = 2;
  writer.noteChange();
  await clock.advance(REST_DELAY_MS);
  // La valeur écrite est celle du moment de l'écriture, pas celle qui avait
  // déclenché l'attente.
  assert.deepEqual(written, [{ revision: 2 }]);
});

test('un mouvement continu finit par écrire au plafond', async () => {
  const clock = fakeClock();
  const written = [];
  const writer = createViewCacheWriter({
    write: async (value) => { written.push(value); },
    snapshot: () => ({ at: clock.now() }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  // Un changement toutes les 100 ms : le repos de 800 ms n'est jamais atteint.
  for (let step = 0; step < 60; step += 1) {
    writer.noteChange();
    await clock.advance(100);
    if (written.length > 0) break;
  }
  assert.equal(written.length, 1, 'le plafond force une écriture');
  assert.ok(written[0].at <= MOVEMENT_CEILING_MS + REST_DELAY_MS);
});

test('la fenêtre de perte annoncée vaut 800 ms au repos et 5 s en mouvement continu', () => {
  assert.deepEqual(ANNOUNCED_LOSS_WINDOW_MS, {
    atRest: 800,
    duringContinuousMovement: 5000,
  });
});

test('la fermeture n\'est jamais bloquée par le cache', async () => {
  const clock = fakeClock();
  const writer = createViewCacheWriter({
    // Une écriture qui ne se termine jamais : le disque est plein, le dossier
    // est verrouillé, peu importe.
    write: () => new Promise(() => {}),
    snapshot: () => ({}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  writer.noteChange();
  const closing = writer.flushNow({ timeoutMs: 1000 });
  await clock.advance(1000);
  assert.deepEqual(await closing, { flushed: false, reason: 'timeout' });
});

test('deux pannes consécutives désarment l\'écrivain pour la session', async () => {
  const clock = fakeClock();
  const failures = [];
  const writer = createViewCacheWriter({
    write: async () => { throw new Error('disque plein'); },
    snapshot: () => ({}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFailure: (error, state) => failures.push(state),
  });
  writer.noteChange();
  await clock.advance(REST_DELAY_MS);
  assert.equal(failures.length, 1);
  assert.ok(!failures[0].disarmed);
  writer.noteChange();
  await clock.advance(REST_DELAY_MS);
  assert.equal(failures.length, 2);
  assert.ok(failures[1].disarmed);
  assert.ok(writer.disarmed);
  // Désarmé, il n'écrit plus et n'échoue plus : la vue reste utilisable.
  writer.noteChange();
  await clock.advance(REST_DELAY_MS * 4);
  assert.equal(failures.length, 2);
});

// ── Index, recherche, inspecteur ─────────────────────────────────────────────

test('un repli d\'affichage est exposé comme repli, jamais comme un nom d\'auteur', () => {
  assert.deepEqual(nodeLabel({ name: presence('Entrée'), fallbackLabel: '', uuid: 'entry' }), {
    label: 'Entrée',
    isFallback: false,
  });
  // Une Action sans nom porte `"Action node"` — un repli de comportement —,
  // lu « Liste sans nom ». Le nom d'office de STUdio aussi : ce n'en est pas un.
  assert.deepEqual(nodeLabel({ name: presence(undefined), fallbackLabel: 'Action node', id: 'a1' }), {
    label: 'Liste sans nom',
    isFallback: true,
  });
  assert.deepEqual(nodeLabel({ name: presence('Action node'), fallbackLabel: 'Action node', id: 'a1' }), {
    label: 'Liste sans nom',
    isFallback: true,
  });
  assert.deepEqual(nodeLabel({ name: presence('Toudou ActionNode'), fallbackLabel: 'Action node', id: 'a1' }), {
    label: 'Toudou ActionNode',
    isFallback: false,
  }, 'un nom d’auteur reste tel quel');
  // Un Écran sans nom a pour repli la chaîne vide : l'identifiant prend alors
  // le relais, plutôt qu'une ligne vide dans une liste de 9 121 entrées.
  assert.deepEqual(nodeLabel({ name: presence(null), fallbackLabel: '', uuid: 'entry' }), {
    label: 'entry',
    isFallback: true,
  });
});

test('l\'index numérote les listes sans nom dans l\'ordre du document', () => {
  const view = {
    stages: [],
    actions: [
      action('a', []),
      action('b', [], { name: presence('Menu') }),
      action('c', [], { name: presence('Action node') }),
      action('d', []),
    ],
    edges: [],
  };
  const index = buildGraphIndex(view);
  assert.deepEqual(index.entries.map((entry) => entry.label), [
    { label: 'Liste sans nom 1', isFallback: true },
    { label: 'Menu', isFallback: false },
    { label: 'Liste sans nom 2', isFallback: true },
    { label: 'Liste sans nom 3', isFallback: true },
  ]);
  // La recherche trouve le numéro affiché.
  assert.match(index.byPath.get('/actionNodes/@id=d#0').haystack, /liste sans nom 3/);
});

test('l\'index range les arêtes dans les deux sens sans dédupliquer', () => {
  const index = buildGraphIndex(sampleView());
  const choix = '/actionNodes/@id=choix#0';
  const cible = '/stageNodes/@uuid=cible#0';
  assert.equal(index.outgoing.get(choix).length, 2);
  // Deux occurrences vers la même cible : deux arêtes entrantes distinctes.
  assert.equal(index.incoming.get(cible).length, 2);
  assert.notEqual(
    index.incoming.get(cible)[0].edgeId,
    index.incoming.get(cible)[1].edgeId,
  );
});

test('un nœud détaché est trouvable comme les autres', () => {
  const index = buildGraphIndex(sampleView());
  assert.deepEqual(detachedPaths(index), ['/stageNodes/@uuid=isole#0']);
  const found = searchGraph(index, { scope: SEARCH_SCOPES.DETACHED });
  assert.equal(found.total, 1);
  assert.equal(found.results[0].path, '/stageNodes/@uuid=isole#0');
  // Il figure aussi dans la recherche générale : rien ne le met à part.
  assert.equal(searchGraph(index, { query: 'isolé' }).total, 1);
});

test('la recherche porte sur le nom, l\'identifiant, le type et le groupe', () => {
  const index = buildGraphIndex(sampleView());
  assert.equal(searchGraph(index, { query: 'entrée' }).total, 1);
  // Un nœud est trouvé sur **ses propres** attributs. Les Actions qui le
  // visent ne remontent pas dans la recherche : leurs références sont des
  // arêtes, et c'est l'inspecteur qui les montre, par les entrants du nœud.
  assert.equal(searchGraph(index, { query: 'cible' }).total, 1);
  assert.equal(searchGraph(index, { query: 'CIBLE' }).total, 1, 'la recherche ignore la casse');
  assert.equal(searchGraph(index, { query: 'choix' }).total, 1, 'une Action est trouvée par son identifiant');
  const index2 = buildGraphIndex(sampleView());
  assert.equal(
    inspectNode(index2, '/stageNodes/@uuid=cible#0').incoming.length,
    2,
    'les référents se lisent dans les entrants, pas dans la recherche',
  );
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.ACTIONS }).total, 1);
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.DIAGNOSED }).total, 1);
});

test('la recherche du graphe partage la normalisation française du Libre', () => {
  const stages = [
    stage('ete', { name: presence('Été au cœur de l’Œuvre') }),
    stage('ecole', { name: presence('École des garçons') }),
  ];
  const index = buildGraphIndex({ ...sampleView(), stages, actions: [], edges: [], mediaRefs: [], diagnostics: [] });

  for (const query of ['ete', 'ÉTÉ', 'coeur', 'oeuvre']) {
    assert.equal(searchGraph(index, { query }).results[0]?.node.uuid, 'ete');
  }
  for (const query of ['ecole', 'garcons']) {
    assert.equal(searchGraph(index, { query }).results[0]?.node.uuid, 'ecole');
  }
  assert.equal(searchGraph(index, { query: 'college' }).total, 0);
});

test('une liste tronquée annonce son total réel', () => {
  const stages = Array.from({ length: 500 }, (_, position) => stage(`s${position}`, { name: presence(`Écran ${position}`) }));
  const index = buildGraphIndex({ ...sampleView(), stages, actions: [], edges: [], mediaRefs: [], diagnostics: [] });
  const found = searchGraph(index, { query: 'écran', limit: 50 });
  assert.equal(found.results.length, 50);
  assert.equal(found.total, 500);
  assert.ok(found.truncated);
});

test('le clavier parcourt la liste sans sortir de ses bornes', () => {
  const index = buildGraphIndex(sampleView());
  const { results } = searchGraph(index, {});
  assert.equal(moveListFocus(results, null, 1), results[0].path);
  assert.equal(moveListFocus(results, results[0].path, -1), results[0].path);
  assert.equal(moveListFocus(results, results.at(-1).path, 1), results.at(-1).path);
  assert.equal(moveListFocus([], null, 1), null);
});

test('l\'inspecteur montre les usages d\'un média avant tout geste', () => {
  const index = buildGraphIndex(sampleView());
  const inspected = inspectNode(index, '/stageNodes/@uuid=entry#0');
  assert.equal(inspected.media.length, 1);
  assert.equal(inspected.media[0].assetRef, 'commun.mp3');
  // Remplacer ce fichier affecterait deux écrans : l'UI doit le montrer avant.
  assert.equal(inspected.media[0].usageCount, 2);
  assert.equal(inspected.diagnostics.length, 1);
  assert.ok(inspected.editableByIdentifier);
});

test('l\'inspecteur annonce qu\'un identifiant dupliqué refusera les gestes', () => {
  const view = sampleView();
  view.stages[0] = { ...view.stages[0], uniqueId: false };
  const index = buildGraphIndex(view);
  const inspected = inspectNode(index, '/stageNodes/@uuid=entry#0');
  assert.ok(!inspected.editableByIdentifier);
});

test('l\'inspecteur reste consultable pour un nœud que le viewport ne dessine pas', () => {
  // L'index ne connaît pas le viewport : il ne peut pas dépendre de ce que le
  // moteur a rendu. C'est ce qui rend la sélection exploitable hors écran.
  const index = buildGraphIndex(sampleView());
  const loin = inspectNode(index, '/stageNodes/@uuid=isole#0');
  assert.ok(loin);
  assert.equal(loin.label.label, 'Isolé');
});

// ── Sélection, focus ─────────────────────────────────────────────────────────

test('une entrée de sélection qui ne désigne plus rien est ignorée, pas purgée', () => {
  const index = buildGraphIndex(sampleView());
  const stored = {
    stages: ['/stageNodes/@uuid=entry#0', '/stageNodes/@uuid=supprime#0'],
    actions: [],
  };
  const resolved = resolveSelection(index, stored);
  assert.deepEqual(resolved.stages, ['/stageNodes/@uuid=entry#0']);
  assert.equal(resolved.ignored, 1);
  // L'entrée stockée est intacte : c'est ce qui fait qu'un undo la restaure.
  assert.equal(stored.stages.length, 2);
});

test('le focus suit une règle déterministe', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  // 1. `lastFocusedPath` s'il existe encore.
  assert.equal(
    resolveFocus(index, { lastFocusedPath: '/stageNodes/@uuid=cible#0', stages: [] }, view.entry),
    '/stageNodes/@uuid=cible#0',
  );
  // 2. Sinon la première entrée de sélection survivante.
  assert.equal(
    resolveFocus(index, { lastFocusedPath: '/stageNodes/@uuid=disparu#0', stages: ['/stageNodes/@uuid=isole#0'] }, view.entry),
    '/stageNodes/@uuid=isole#0',
  );
  // 3. Sinon l'Écran d'entrée.
  assert.equal(
    resolveFocus(index, { lastFocusedPath: null, stages: [] }, view.entry),
    '/stageNodes/@uuid=entry#0',
  );
  // 4. Sinon rien — et sur une entrée ambiguë, aucun candidat n'est choisi à
  // la place de l'auteur.
  assert.equal(
    resolveFocus(index, { lastFocusedPath: null, stages: [] }, { status: 'ambiguous', stagePath: null, candidates: [] }),
    null,
  );
});

test('un clic simple synchronise sélection et focus sans casser la sélection multiple', () => {
  assert.equal(focusAfterGraphSelection(['/s1'], '/ancien'), '/s1');
  assert.equal(focusAfterGraphSelection(['/s1', '/s2'], '/s2'), '/s2');
  assert.equal(focusAfterGraphSelection(['/s1', '/s2'], '/ancien'), '/s1');
  assert.equal(focusAfterGraphSelection([], '/s1'), null);
});

test('une caméra relue survit à une modification externe du document', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const applied = applyCachedView({
    index,
    entry: view.entry,
    cached: {
      fingerprintMatches: false,
      viewportRejected: false,
      view: {
        viewport: { x: -240, y: 118.5, zoom: 0.75 },
        selection: { stages: ['/stageNodes/@uuid=entry#0', '/stageNodes/@uuid=parti#0'], actions: [] },
        lastFocusedPath: '/stageNodes/@uuid=parti#0',
      },
    },
  });
  // La caméra ne s'ancre à aucun nœud : elle est appliquée telle quelle.
  assert.deepEqual(applied.viewport, { x: -240, y: 118.5, zoom: 0.75 });
  assert.ok(applied.documentChangedSinceWrite);
  // Les ancrages, eux, sont revalidés : un seul survit, l'autre est ignoré.
  assert.deepEqual(applied.selection.stages, ['/stageNodes/@uuid=entry#0']);
  assert.equal(applied.ignoredAnchors, 1);
  assert.equal(applied.focus, '/stageNodes/@uuid=entry#0');
});

test('un viewport écarté laisse la sélection utilisable', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const applied = applyCachedView({
    index,
    entry: view.entry,
    cached: {
      fingerprintMatches: true,
      viewportRejected: true,
      view: { viewport: null, selection: { stages: ['/stageNodes/@uuid=cible#0'], actions: [] }, lastFocusedPath: null },
    },
  });
  assert.equal(applied.viewport, null);
  assert.ok(applied.viewportRejected);
  assert.deepEqual(applied.selection.stages, ['/stageNodes/@uuid=cible#0']);
});

// ── Géométrie ────────────────────────────────────────────────────────────────

test('le domaine numérique du viewport refuse les valeurs non finies et un zoom nul ou négatif', () => {
  assert.ok(isUsableViewport({ x: 0, y: 0, zoom: 1 }));
  assert.ok(!isUsableViewport({ x: Number.NaN, y: 0, zoom: 1 }));
  assert.ok(!isUsableViewport({ x: 0, y: Infinity, zoom: 1 }));
  assert.ok(!isUsableViewport({ x: 0, y: 0, zoom: 0 }));
  assert.ok(!isUsableViewport({ x: 0, y: 0, zoom: -1 }));
  assert.ok(!isUsableViewport(null));
});

test('un glisser est borné au domaine sûr et la butée est visible', () => {
  assert.deepEqual(clampAuthoredPosition({ x: 120, y: -40 }), {
    x: 120, y: -40, clamped: false, axes: { x: false, y: false },
  });
  const loin = clampAuthoredPosition({ x: 400_000, y: -99_999 });
  assert.equal(loin.x, SHORT_MAX);
  assert.equal(loin.y, SHORT_MIN);
  assert.ok(loin.clamped);
  assert.deepEqual(loin.axes, { x: true, y: true });
  // Une seule coordonnée hors domaine ne borne que son axe.
  assert.deepEqual(clampAuthoredPosition({ x: 0, y: 40_000 }).axes, { x: false, y: true });
});

test('un glisser produit une position entière, pas un défaut à corriger', () => {
  // Le moteur rend une position flottante à la fin du geste. Écrite telle
  // quelle, elle faisait poser au moteur natif un `POSITION_FRACTIONAL` sur le
  // nœud que l'auteur venait de déplacer, qui passait aussitôt « à corriger ».
  const posé = clampAuthoredPosition({ x: 342.7331, y: -118.5 });
  assert.equal(posé.x, 343);
  assert.equal(posé.y, -118);
  assert.equal(posé.clamped, false, 'arrondir n’est pas buter');
  // L'arrondi ne fait jamais sortir du domaine sûr.
  assert.equal(clampAuthoredPosition({ x: SHORT_MAX - 0.4, y: 0 }).x, SHORT_MAX);
  assert.equal(clampAuthoredPosition({ x: SHORT_MIN + 0.4, y: 0 }).x, SHORT_MIN);
});

test('le cadrage est calculé sur l\'étendue mesurée, pas sur une limite supposée', () => {
  const index = buildGraphIndex(sampleView());
  const extent = layoutExtent(index);
  assert.deepEqual(
    { minX: extent.minX, maxX: extent.maxX, width: extent.width },
    { minX: 0, maxX: 480, width: 480 },
  );
  const fitted = fitViewport(extent, { width: 800, height: 600 });
  assert.ok(fitted.zoom > 0 && Number.isFinite(fitted.zoom));

  // Le quadrillage FS atteint `x = 376 960` : le cadrage doit y répondre par un
  // zoom mesuré, pas par un plancher inventé qui le rendrait illisible.
  const large = fitViewport(
    { empty: false, minX: 0, minY: 0, maxX: 376_960, maxY: 160, width: 376_960, height: 160 },
    { width: 1200, height: 800 },
  );
  assert.ok(large.zoom < 0.01, `zoom mesuré ${large.zoom}`);
  assert.ok(Number.isFinite(large.x) && Number.isFinite(large.y));
});

test('un graphe d\'un seul nœud ne produit ni division par zéro ni zoom infini', () => {
  const fitted = fitViewport(
    { empty: false, minX: 10, minY: 10, maxX: 10, maxY: 10, width: 0, height: 0 },
    { width: 800, height: 600 },
  );
  assert.ok(Number.isFinite(fitted.zoom) && fitted.zoom > 0);
  assert.ok(Number.isFinite(fitted.x) && Number.isFinite(fitted.y));
});

test('cadrer un nœud ne change pas le zoom choisi par l\'auteur', () => {
  const index = buildGraphIndex(sampleView());
  const node = index.byPath.get('/stageNodes/@uuid=cible#0').node;
  const centered = centerOnNode({ x: 0, y: 0, zoom: 0.4 }, node, { width: 800, height: 600 });
  assert.equal(centered.zoom, 0.4);
  assert.equal(centered.x, 400 - 240 * 0.4);
});

test('le centre de la vue et le cadrage d’un nœud sont deux questions inverses', () => {
  // C'est là que naît un nœud créé depuis l'en-tête du panneau, qui ne désigne
  // aucun point : le seul endroit que l'auteur puisse prévoir est celui qu'il
  // regarde. L'aller-retour vérifie que les deux fonctions parlent bien de la
  // même caméra.
  const size = { width: 800, height: 600 };
  const index = buildGraphIndex(sampleView());
  const node = index.byPath.get('/stageNodes/@uuid=cible#0').node;
  const centered = centerOnNode({ x: 0, y: 0, zoom: 0.4 }, node, size);
  assert.deepEqual(viewportCenter(centered, size), { x: node.layout.x, y: node.layout.y });

  // Sans déplacement ni zoom, le centre de la surface est le centre du graphe.
  assert.deepEqual(viewportCenter({ x: 400, y: 300, zoom: 1 }, size), { x: 0, y: 0 });
});

test('une caméra hors domaine ne rend aucun centre plutôt qu’un point inventé', () => {
  // La création se fera alors sans position, comme avant, au lieu de poser le
  // nœud à un endroit tiré d'une valeur dont on sait qu'elle est fausse.
  const size = { width: 800, height: 600 };
  assert.equal(viewportCenter({ x: 0, y: 0, zoom: 0 }, size), null);
  assert.equal(viewportCenter({ x: Number.NaN, y: 0, zoom: 1 }, size), null);
  assert.equal(viewportCenter(null, size), null);
});

test('le pincement du graphe garde son point sous les doigts dans les deux sens', () => {
  const start = { x: 80, y: -20, zoom: 0.5 };
  const point = { x: 200, y: 150 };
  const enlarged = zoomViewportAt(start, 1.5, point);
  assert.equal(enlarged.zoom, 0.75);
  assert.equal((point.x - enlarged.x) / enlarged.zoom, (point.x - start.x) / start.zoom);
  assert.equal((point.y - enlarged.y) / enlarged.zoom, (point.y - start.y) / start.zoom);
  const restored = zoomViewportAt(enlarged, 2 / 3, point);
  assert.deepEqual(restored, start);
  assert.equal(zoomViewportAt(start, 1, point), null);
  assert.equal(zoomViewportAt(start, Number.NaN, point), null);
});

// ── Un nœud est-il déjà sous les yeux de l'auteur ? ──────────────────────────

const WINDOW = { width: 1000, height: 600 };
const at = (x, y) => ({ layout: { x, y } });
// Une caméra à l'identité : l'origine du graphe est le coin de la fenêtre.
const CAMERA = { x: 0, y: 0, zoom: 1 };

test('un nœud entièrement dans la fenêtre est vu comme présent', () => {
  assert.equal(isNodeOnScreen(CAMERA, at(500, 300), WINDOW), true);
});

test('un nœud sorti de la fenêtre demande un recadrage', () => {
  for (const node of [at(-400, 300), at(1400, 300), at(500, -300), at(500, 900)]) {
    assert.equal(isNodeOnScreen(CAMERA, node, WINDOW), false);
  }
});

test('une carte à cheval sur le bord compte comme absente', () => {
  // C'est la carte **peinte** qui doit tenir, pas seulement son centre : un
  // nœud à demi coupé est illisible là où il est.
  const centre = NODE_HALF_WIDTH + 24;
  assert.equal(isNodeOnScreen(CAMERA, at(centre, 300), WINDOW), true);
  assert.equal(isNodeOnScreen(CAMERA, at(centre - 1, 300), WINDOW), false);
  const bas = 600 - NODE_HALF_HEIGHT - 24;
  assert.equal(isNodeOnScreen(CAMERA, at(500, bas), WINDOW), true);
  assert.equal(isNodeOnScreen(CAMERA, at(500, bas + 1), WINDOW), false);
});

test('la visibilité emploie le gabarit plus étroit d’une Action', () => {
  const action = { kind: 'action', layout: { x: 50, y: 300 } };
  const stage = { kind: 'stage', layout: { x: 50, y: 300 } };
  assert.equal(isNodeOnScreen(CAMERA, action, WINDOW), true);
  assert.equal(isNodeOnScreen(CAMERA, stage, WINDOW), false);
});

test('la caméra est prise en compte, pas seulement la position du nœud', () => {
  const node = at(5000, 300);
  assert.equal(isNodeOnScreen(CAMERA, node, WINDOW), false);
  // Le même nœud, la caméra déplacée sur lui.
  assert.equal(isNodeOnScreen({ x: -4500, y: 0, zoom: 1 }, node, WINDOW), true);
  // Et le zoom compte : dézoomer ramène dans la fenêtre ce qui en sortait.
  assert.equal(isNodeOnScreen({ x: 0, y: 0, zoom: 0.1 }, node, WINDOW), true);
});

test('une fenêtre ou une position inutilisable fait recadrer', () => {
  // Le sens le plus sûr : au pire la caméra bouge, au mieux elle ne laisse
  // pas l'auteur devant un nœud qu'il ne trouve pas.
  assert.equal(isNodeOnScreen(null, at(500, 300), WINDOW), false);
  assert.equal(isNodeOnScreen({ x: 0, y: 0, zoom: 0 }, at(500, 300), WINDOW), false);
  assert.equal(isNodeOnScreen(CAMERA, at(500, 300), { width: 0, height: 600 }), false);
  assert.equal(isNodeOnScreen(CAMERA, at(Number.NaN, 300), WINDOW), false);
  assert.equal(isNodeOnScreen(CAMERA, null, WINDOW), false);
});
