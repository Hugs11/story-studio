// Le nœud sous le pointeur, tel que l'adaptateur du moteur le rend.
//
// Le canvas du graphe n'expose aucun nœud au DOM : la médiathèque ne peut donc
// pas viser un Écran par `elementsFromPoint`, comme elle le fait sur l'arbre et
// le diagramme Libre. Elle demande au moteur le nœud qu'il a lui-même criblé.
//
// Ce que ces tests éprouvent est la **tenue du registre**, pas le rendu : le
// survol est noté, il est rendu, il est oublié quand le pointeur quitte le
// nœud, et la destruction ne laisse pas un nœud survolé derrière elle — ce qui
// ferait déposer un média sur l'Écran d'un document déjà fermé.
//
// Le moteur est simulé : aucune bibliothèque de rendu n'est chargée, et c'est
// la démonstration que la frontière du contrat tient.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCytoscapeEngine } from '../src/components/AdvancedGraphCanvas/engines/cytoscapeEngine.js';
import { ENGINE_CONTRACT_METHODS } from '../src/components/AdvancedGraphCanvas/engines/engineContract.js';

// Un Cytoscape d'essai : il n'enregistre que ce dont l'adaptateur se sert ici —
// les écouteurs, et de quoi rendre `mount`.
function fakeCytoscape() {
  const listeners = [];
  let options;
  const instance = {
    on(event, selectorOrHandler, maybeHandler) {
      const selector = typeof selectorOrHandler === 'string' ? selectorOrHandler : null;
      const handler = maybeHandler ?? selectorOrHandler;
      for (const name of event.split(' ')) listeners.push({ name, selector, handler });
    },
    nodes: () => ({ length: 0, addClass() {}, removeClass() {} }),
    edges: () => ({ length: 0 }),
    batch(run) { run(); },
    $id: () => ({
      length: 0, select() {}, unselect() {}, addClass() {}, removeClass() {},
      source: () => ({ addClass() {}, removeClass() {} }),
      target: () => ({ addClass() {}, removeClass() {} }),
    }),
    pan: () => ({ x: 0, y: 0 }),
    zoom: () => 1,
    viewport() {},
    center() {},
    fit() {},
    png: () => null,
    resize() {},
    destroy() { instance.destroyed = true; },
    destroyed: false,
  };
  const factory = (received) => {
    options = received;
    return instance;
  };
  factory.version = 'essai';
  return { factory, instance, listeners, get options() { return options; } };
}

function emit(listeners, name, selector, target, extra = {}) {
  for (const entry of listeners) {
    if (entry.name === name && entry.selector === selector) entry.handler({ target, ...extra });
  }
}

const node = (id) => ({ id: () => id });
const edge = (id) => {
  const endpoint = { addClass() {}, removeClass() {} };
  return {
    id: () => id,
    addClass() {},
    removeClass() {},
    source: () => endpoint,
    target: () => endpoint,
  };
};

async function mountedEngine() {
  const { factory, instance, listeners } = fakeCytoscape();
  const engine = createCytoscapeEngine({ container: {}, cytoscape: factory });
  await engine.mount({ nodes: [], edges: [] });
  return { engine, instance, listeners };
}

test('l’adaptateur remplit tout le contrat, survol nœud et lien compris', () => {
  const { factory } = fakeCytoscape();
  const engine = createCytoscapeEngine({ container: {}, cytoscape: factory });
  for (const method of ENGINE_CONTRACT_METHODS) {
    assert.equal(typeof engine[method], 'function', `méthode manquante : ${method}`);
  }
});

test('la molette utilise la normalisation native de Cytoscape', async () => {
  const cytoscape = fakeCytoscape();
  const engine = createCytoscapeEngine({ container: {}, cytoscape: cytoscape.factory });
  await engine.mount({ nodes: [], edges: [] });
  assert.equal(Object.hasOwn(cytoscape.options, 'wheelSensitivity'), false);
  engine.destroy();
});

// Un conteneur d'essai qui garde les événements qu'on lui adresse, avec une
// `WheelEvent` minimale : Node n'en fournit pas.
function wheelContainer() {
  const received = [];
  class FakeWheelEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
      this.defaultPrevented = false;
    }

    preventDefault() { this.defaultPrevented = true; }
  }
  const container = {
    ownerDocument: { defaultView: { WheelEvent: FakeWheelEvent } },
    dispatchEvent(event) {
      received.push(event);
      // Cytoscape retient le défilement de la page quand il zoome.
      event.preventDefault();
      return true;
    },
  };
  return { container, received };
}

test('forwardWheel rejoue la molette chez le moteur, point et modificateurs conservés', async () => {
  const { factory } = fakeCytoscape();
  const { container, received } = wheelContainer();
  const engine = createCytoscapeEngine({ container, cytoscape: factory });
  await engine.mount({ nodes: [], edges: [] });
  let prevented = false;
  const forwarded = engine.forwardWheel({
    clientX: 120, clientY: 80, screenX: 300, screenY: 400,
    deltaX: 0, deltaY: -240, deltaZ: 0, deltaMode: 0,
    ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
    preventDefault() { prevented = true; },
  });
  assert.equal(forwarded, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'wheel');
  assert.equal(received[0].bubbles, true);
  assert.deepEqual(
    [received[0].clientX, received[0].clientY, received[0].deltaY, received[0].ctrlKey],
    [120, 80, -240, true],
  );
  assert.equal(prevented, true, 'la molette d’origine est retenue comme celle du moteur');
});

test('forwardWheel ne fait rien avant le montage', () => {
  const { factory } = fakeCytoscape();
  const { container, received } = wheelContainer();
  const engine = createCytoscapeEngine({ container, cytoscape: factory });
  assert.equal(engine.forwardWheel({ deltaY: 1, preventDefault() {} }), false);
  assert.equal(received.length, 0);
});

test('avant tout montage, aucun nœud n’est sous le pointeur', () => {
  const { factory } = fakeCytoscape();
  const engine = createCytoscapeEngine({ container: {}, cytoscape: factory });
  assert.equal(engine.nodeAtPointer(), null);
});

test('le survol d’un nœud est noté, et rendu tel quel', async () => {
  const { engine, listeners } = await mountedEngine();
  assert.equal(engine.nodeAtPointer(), null);
  emit(listeners, 'mouseover', 'node', node('/stageNodes/@uuid=entry#0'));
  assert.equal(engine.nodeAtPointer(), '/stageNodes/@uuid=entry#0');
});

test('quitter le nœud l’oublie : le vide du canvas n’est pas une cible', async () => {
  const { engine, listeners } = await mountedEngine();
  emit(listeners, 'mouseover', 'node', node('/stageNodes/@uuid=entry#0'));
  emit(listeners, 'mouseout', 'node', node('/stageNodes/@uuid=entry#0'));
  assert.equal(engine.nodeAtPointer(), null);
});

test('le survol d’un lien publie son identité sans changer le nœud survolé', async () => {
  const { factory, listeners } = fakeCytoscape();
  const changes = [];
  const engine = createCytoscapeEngine({
    container: {}, cytoscape: factory, onHoverChange: value => changes.push(value),
  });
  await engine.mount({ nodes: [], edges: [] });
  emit(listeners, 'mouseover', 'edge', edge('option-2'), { renderedPosition: { x: 40, y: 12 } });
  assert.equal(engine.edgeAtPointer(), 'option-2');
  assert.equal(engine.nodeAtPointer(), null);
  // Le point d'entrée du pointeur accompagne le lien : l'étiquette qui nomme
  // ses deux bouts s'y pose.
  assert.deepEqual(changes.at(-1), { nodePath: null, edgeId: 'option-2', edgePoint: { x: 40, y: 12 } });
  emit(listeners, 'mouseout', 'edge', edge('option-2'));
  assert.equal(engine.edgeAtPointer(), null);
});

test('un `mouseout` tardif ne retire pas le nœud survolé entre-temps', async () => {
  // Passer d'un nœud à son voisin émet `mouseover` du second avant le
  // `mouseout` du premier. Sans la comparaison, la cible disparaissait au
  // moment précis où l'auteur venait de l'atteindre.
  const { engine, listeners } = await mountedEngine();
  emit(listeners, 'mouseover', 'node', node('/stageNodes/@uuid=a#0'));
  emit(listeners, 'mouseover', 'node', node('/stageNodes/@uuid=b#0'));
  emit(listeners, 'mouseout', 'node', node('/stageNodes/@uuid=a#0'));
  assert.equal(engine.nodeAtPointer(), '/stageNodes/@uuid=b#0');
});

test('la destruction ne laisse pas un nœud survolé derrière elle', async () => {
  // Un document fermé pendant un glisser : sans cet oubli, le relâchement
  // suivant aurait désigné un Écran d'un projet qui n'est plus ouvert.
  const { engine, listeners, instance } = await mountedEngine();
  emit(listeners, 'mouseover', 'node', node('/stageNodes/@uuid=entry#0'));
  engine.destroy();
  assert.equal(instance.destroyed, true);
  assert.equal(engine.nodeAtPointer(), null);
});
