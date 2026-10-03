import assert from 'node:assert/strict';
import test from 'node:test';

import { autoPanVelocity, linkDropCandidate } from '../src/store/advancedAuthoring/graphLinkDrag.js';
import {
  GRAPH_LINK_PORTS,
  moveGraphLinkDraft,
  startGraphLinkDraft,
} from '../src/store/advancedAuthoring/graphLinkDraft.js';
import { action, sampleView, stage } from './advancedViewFixtures.mjs';
import { nodePortOffsets, PORT_OVERHANG } from '../src/components/AdvancedGraphCanvas/engines/engineContract.js';
import { linkHandlePx, REVEALED_HANDLE, revealedHandleOffset } from '../src/components/AdvancedGraphCanvas/nodeOverlayMetrics.js';
import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';

const card = (path, kind, x, y) => ({ path, kind, x, y, width: 104, height: 80 });

test('la cible visée est la plus proche, pas la première du document', () => {
  // Deux cartes qui se recouvrent : l'ordre du document n'a aucun rapport avec
  // ce que l'auteur vise. C'est la distance au centre qui tranche.
  const nodes = [card('/a', 'stage', 100, 100), card('/b', 'stage', 140, 100)];
  assert.equal(linkDropCandidate(nodes, { x: 135, y: 100 }, '/source').path, '/b');
  assert.equal(linkDropCandidate(nodes, { x: 105, y: 100 }, '/source').path, '/a');
});

test('la source de son propre raccord n’est jamais une cible', () => {
  const nodes = [card('/a', 'stage', 100, 100)];
  assert.equal(linkDropCandidate(nodes, { x: 100, y: 100 }, '/a'), null);
});

test('au-dessus du vide, aucune cible', () => {
  const nodes = [card('/a', 'stage', 100, 100)];
  assert.equal(linkDropCandidate(nodes, { x: 100, y: 200 }, '/source'), null);
  // Le bord compte : une carte fait 104 × 80, donc 52 et 40 de demi-course.
  assert.ok(linkDropCandidate(nodes, { x: 151, y: 100 }, '/source'));
  assert.equal(linkDropCandidate(nodes, { x: 153, y: 100 }, '/source'), null);
});

test('la zone d’attrape couvre le débord des prises', () => {
  // Les prises sont peintes aux deux tiers hors du contour. Relâcher sur la
  // prise d'arrivée d'un Écran, c'est viser cet Écran — la silhouette nue
  // concluait au vide et proposait d'en créer un autre.
  const nodes = [card('/a', 'stage', 100, 100)];
  assert.equal(linkDropCandidate(nodes, { x: 156, y: 100 }, '/source'), null,
    'sans tolérance, le bord reste le bord');
  assert.ok(linkDropCandidate(nodes, { x: 156, y: 100 }, '/source', 6),
    'avec le débord, la pastille appartient au nœud');
  assert.equal(linkDropCandidate(nodes, { x: 159, y: 100 }, '/source', 6), null,
    'et la tolérance s’arrête au débord, elle ne l’étend pas');

  // Elle joue sur les deux axes : la prise HOME d'un Écran est sous lui.
  assert.ok(linkDropCandidate(nodes, { x: 100, y: 144 }, '/source', 6));
  assert.equal(linkDropCandidate(nodes, { x: 100, y: 147 }, '/source', 6), null);
});

test('entre deux zones élargies qui se recouvrent, la distance tranche encore', () => {
  const nodes = [card('/a', 'stage', 100, 100), card('/b', 'stage', 210, 100)];
  // Les bords se touchent à 155 : de 152 à 158, le pointeur tombe dans le
  // débord de /a **comme** dans celui de /b. C'est la distance qui tranche,
  // de part et d'autre du milieu.
  assert.equal(linkDropCandidate(nodes, { x: 153, y: 100 }, '/source', 6).path, '/a');
  assert.equal(linkDropCandidate(nodes, { x: 157, y: 100 }, '/source', 6).path, '/b');
});

test('la caméra suit le pointeur aux bords, et d’autant plus qu’il s’y enfonce', () => {
  const size = { width: 1200, height: 800 };
  assert.deepEqual(autoPanVelocity({ x: 600, y: 400 }, size), { x: 0, y: 0 });

  const frolé = autoPanVelocity({ x: 50, y: 400 }, size);
  const enfoncé = autoPanVelocity({ x: 4, y: 400 }, size);
  assert.ok(frolé.x > 0 && enfoncé.x > frolé.x,
    'on frôle pour ajuster, on pousse pour traverser');

  // Le signe dit le sens : à gauche la vue découvre ce qui est à gauche, donc
  // le contenu se déplace vers la droite.
  assert.ok(autoPanVelocity({ x: 1196, y: 400 }, size).x < 0);
  assert.ok(autoPanVelocity({ x: 600, y: 4 }, size).y > 0);
  assert.ok(autoPanVelocity({ x: 600, y: 796 }, size).y < 0);

  // Bornée : un pointeur hors surface n'emballe pas la caméra.
  const dehors = autoPanVelocity({ x: -400, y: 400 }, size);
  assert.equal(dehors.x, autoPanVelocity({ x: 0, y: 400 }, size).x);
});

test('sur une surface étroite, les deux bandes ne se rejoignent pas', () => {
  // Deux bandes qui se touchent feraient défiler en permanence, y compris au
  // centre de la fenêtre — le geste deviendrait impossible à arrêter.
  const étroite = { width: 120, height: 800 };
  assert.deepEqual(autoPanVelocity({ x: 60, y: 400 }, étroite), { x: 0, y: 0 });
});

test('le brouillon retient son ancre en coordonnées de graphe', () => {
  // C'est ce qui permet de dézoomer pendant le tirage : la vue tourne autour
  // de l'ancre au lieu de l'emporter.
  const view = sampleView();
  view.stages = [stage('s1', {
    controls: {
      presence: 'value',
      complete: true,
      ok: { presence: 'value', value: true },
      home: { presence: 'value', value: false },
      autoplay: { presence: 'value', value: false },
    },
  }), stage('s2')];
  view.actions = [action('a1', ['s2'])];
  view.edges = [];
  const index = buildGraphIndex(view);
  const draft = startGraphLinkDraft(
    index, '/stageNodes/@uuid=s1#0', GRAPH_LINK_PORTS.STAGE_OK, { x: 53.5, y: 0 },
  );
  assert.deepEqual(draft.anchor, { x: 53.5, y: 0 });
  assert.deepEqual(draft.pointer, { x: 53.5, y: 0 });
  const moved = moveGraphLinkDraft(draft, { x: -9000, y: 2400 });
  assert.deepEqual(moved.anchor, { x: 53.5, y: 0 }, 'l’ancre ne suit pas le pointeur');
  assert.deepEqual(moved.pointer, { x: -9000, y: 2400 });
});

// Géométrie réelle des prises, telle que le moteur la publie (pixels écran
// relatifs au centre) : un Écran en haut à gauche, une Liste très fournie.
const withPorts = (node, kind, slots, zoom) => ({
  ...node,
  ports: nodePortOffsets(kind, slots).map((port) => ({
    id: port.id, role: port.role, ordinal: port.ordinal, dx: port.x * zoom, dy: port.y * zoom, revealed: false,
  })),
});

test('lâcher sur n’importe quelle prise d’un nœud vise ce nœud', () => {
  for (const zoom of [1, 0.55, 0.3]) {
    const handleHalf = linkHandlePx(zoom) / 2;
    const reach = PORT_OVERHANG * zoom;
    const stage = withPorts({ path: '/s', kind: 'stage', x: 400, y: 300, width: 104 * zoom, height: 80 * zoom }, 'stage', 1, zoom);
    const list = withPorts({ path: '/l', kind: 'action', x: 900, y: 300, width: 52 * zoom, height: 52 * zoom }, 'action', 11, zoom);
    const nodes = [stage, list];
    for (const node of nodes) {
      // La prise d'arrivée n'a pas de bouton : seule sa pastille compte.
      for (const port of node.ports.filter((candidate) => candidate.role !== 'arrival')) {
        // Le bord extérieur de la zone de saisie du bouton, sur chaque axe.
        for (const [ox, oy] of [[0, 0], [handleHalf - 0.5, 0], [-(handleHalf - 0.5), 0], [0, handleHalf - 0.5], [0, -(handleHalf - 0.5)]]) {
          const pointer = { x: node.x + port.dx + ox, y: node.y + port.dy + oy };
          const found = linkDropCandidate(nodes, pointer, '/source', reach, handleHalf);
          assert.equal(found?.path, node.path,
            `zoom ${zoom} : prise ${port.id}#${port.ordinal} de ${node.path} décalée de ${ox},${oy}`);
        }
      }
    }
  }
});

test('une prise révélée sous 30 % désigne aussi son nœud', () => {
  const zoom = 0.2;
  const node = {
    path: '/s', kind: 'stage', x: 400, y: 300, width: 104 * zoom, height: 80 * zoom,
    ports: [{ id: 'ok', role: 'ok', ordinal: null, dx: 52 * zoom, dy: 0, revealed: true }],
  };
  const centre = revealedHandleOffset(node, node.ports[0]);
  const pointer = { x: node.x + centre.x + (REVEALED_HANDLE.SIZE / 2) - 0.5, y: node.y };
  assert.equal(linkDropCandidate([node], pointer, '/source', PORT_OVERHANG * zoom, linkHandlePx(zoom) / 2)?.path, '/s');
});

test('hors de toute prise et de toute carte, toujours le vide', () => {
  const zoom = 1;
  const stage = withPorts({ path: '/s', kind: 'stage', x: 400, y: 300, width: 104, height: 80 }, 'stage', 1, zoom);
  assert.equal(linkDropCandidate([stage], { x: 400 + 52 + 1.5 + 14, y: 300 }, '/source', PORT_OVERHANG, linkHandlePx(1) / 2), null);
});
