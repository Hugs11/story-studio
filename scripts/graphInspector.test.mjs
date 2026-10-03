import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';

const { mountSurface } = await import('./chromeBench.mjs');
const GraphInspector = (await import('../src/components/AdvancedGraphCanvas/GraphInspector.jsx')).default;

const presence = (value) => ({ presence: 'value', value });

function stageInspection() {
  return {
    kind: 'stage',
    path: '/stages/0',
    identifier: 'stage-0',
    label: { label: 'Accueil', isFallback: false },
    editableByIdentifier: false,
    node: {
      occurrence: 1,
      name: { presence: 'absent' },
      stageType: presence('story'),
      groupId: { presence: 'null' },
      squareOne: presence(true),
      audio: { presence: 'value', assetRef: 'welcome.mp3' },
      image: { presence: 'absent', assetRef: null },
      controls: {
        complete: false,
        wheel: presence(true),
        ok: presence(false),
        home: { presence: 'null' },
        pause: { presence: 'absent' },
        autoplay: presence(false),
      },
      okTransition: {
        presence: 'value',
        actionId: 'action-missing',
        actionPath: null,
        selection: { kind: 'fixed', index: 8 },
        withinBounds: false,
      },
      homeTransition: { presence: 'null' },
      layout: { x: 12, y: 34, source: 'derived' },
      sourcePosition: { xText: '9007199254740993', yText: '34', exactInDouble: false },
    },
    media: [{ field: 'audio', assetRef: 'welcome.mp3', usageCount: 3 }],
    diagnostics: [{ code: 'GVI-TEST', family: 'import', path: '/stages/0', message: 'Diagnostic lisible.' }],
    incoming: [],
    outgoing: [{ edgeId: 'edge-0', kind: 'stage-ok', from: '/stages/0', to: null }],
  };
}

test('GraphInspector rend la nature et le rôle d’entrée sans répéter les blocages', () => {
  const { html } = mountSurface(React.createElement(GraphInspector, {
    inspected: stageInspection(),
    onFocusPath() {},
  }));

  assert.match(html, /advanced-inspector__kind">Écran/);
  assert.match(html, /advanced-inspector__badge--entry">Racine/);
  assert.doesNotMatch(html, /1 à corriger/);
  assert.doesNotMatch(html, /Identifiant dupliqué/);
  assert.doesNotMatch(html, /GVI-TEST/);
});

test('GraphInspector préserve absent, null, valeur, provenance et occurrence', () => {
  const { html } = mountSurface(React.createElement(GraphInspector, {
    inspected: stageInspection(),
    onFocusPath() {},
  }));

  assert.match(html, /data-presence="absent">absent/);
  assert.match(html, /data-presence="null">null/);
  assert.match(html, /occurrence 1/);
  // Une seule position, sans étiquette de provenance.
  assert.match(html, /Position<\/span><span class="advanced-inspector__cell">12, 34<\/span>/);
  assert.doesNotMatch(html, /derived|authored|fallback/);
  assert.doesNotMatch(html, /hors domaine sûr/);
  assert.match(html, /utilisé par 3 écrans/);
});

test('GraphInspector rend un état vide explicatif', () => {
  const { html } = mountSurface(React.createElement(GraphInspector, {
    inspected: null,
    onFocusPath() {},
  }));

  assert.match(html, /Aucun nœud sélectionné/);
  assert.match(html, /Choisissez un nœud dans la liste/);
});

test('GraphInspector conserve l’ordre et les cibles nulles des options d’Action', () => {
  const inspected = {
    kind: 'action',
    path: '/actions/0',
    identifier: 'action-0',
    label: { label: 'Choix', isFallback: false },
    editableByIdentifier: true,
    node: {
      occurrence: 0,
      name: presence('Choix'),
      actionType: { presence: 'absent' },
      groupId: presence('ocean'),
      options: [
        { optionId: 'option-0', target: { presence: 'null', dangling: false } },
        {
          optionId: 'option-1',
          target: { presence: 'value', stagePath: null, stageUuid: 'stage-missing', dangling: true },
        },
      ],
      layout: { x: 0, y: 0, source: 'authored' },
      sourcePosition: null,
    },
    media: [],
    diagnostics: [],
    incoming: [],
    outgoing: [],
  };

  const { html } = mountSurface(React.createElement(GraphInspector, { inspected, onFocusPath() {} }));

  assert.match(html, /Options/);
  assert.match(html, /advanced-inspector__count">2/);
  assert.match(html, /data-presence="null">cible nulle/);
  assert.match(html, /stage-missing/);
  assert.doesNotMatch(html, /cible pendante/);
});

test('le shell donne aux Réglages la largeur du Libre et conserve les défilements indépendants', () => {
  const css = readFileSync(new URL('../src/components/AdvancedWorkspace/AdvancedWorkspace.css', import.meta.url), 'utf8');

  assert.match(css, /advanced-panel-slot--advanced-node-list[\s\S]*?flex:\s*0 1 var\(--advanced-node-list-panel-width, 240px\)/);
  assert.match(css, /advanced-panel-slot--advanced-inspector[\s\S]*?flex:\s*0 1 var\(--advanced-inspector-panel-width, 800px\)/);
  assert.match(css, /advanced-panel-slot--advanced-graph[\s\S]*?min-width:\s*360px/);
  assert.match(css, /advanced-inspector--editor[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /advanced-panel-header[\s\S]*?height:\s*38px/);
});
