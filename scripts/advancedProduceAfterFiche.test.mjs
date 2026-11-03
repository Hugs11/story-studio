// « Appliquer & générer » côté graphe : l'archive part avec ce que la fiche
// vient d'écrire.
//
// La fiche écrit les réglages audio par `setProject`, puis enchaîne sans rendu
// sur la production. La fonction de production appelée est celle du rendu
// précédent : tout ce qu'elle lit dans `store.project` est donc l'état d'avant
// la fiche. Le défaut faisait partir l'archive avec les anciens réglages.
//
// Le vrai `useProjectStore` est monté, et le parcours de production est le vrai
// `runAdvancedProduction`, câblé comme l'hôte le câble. Une garde sur la source
// de `App.jsx` vérifie ensuite que l'hôte lit bien le projet courant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);

const { useProjectStore } = await import('../src/store/projectStore.js');
const { createAdvancedProject } = await import('../src/store/projectModel/authoring.js');
const { ADVANCED_PRODUCTION, runAdvancedProduction } = await import('../src/store/production/advancedProduction.js');
const { advancedPackAudioOptions } = await import('../src/store/production/packAudioOptions.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';
const PREFERENCES = { leading: 0.4, trailing: 0.4 };
const HEALTHY = { blocked: false, blocking: [], advisory: [], diagnostics: [] };

// La production telle que l'hôte la câble, sur le store **du rendu capturé**.
function produce(store, trace) {
  return runAdvancedProduction({
    readProject: store.readProject,
    assessReadiness: async (project) => {
      trace.assessed = project;
      return HEALTHY;
    },
    readReferencedMedia: async () => ['media/a.mp3'],
    chooseFolder: async () => '/sorties',
    start: async ({ options }) => {
      trace.options = options;
      return { outcome: 'prepared' };
    },
    refuse: (refusal) => { trace.refusal = refusal; },
    options: advancedPackAudioOptions(store.readProject()?.globalOptions, PREFERENCES),
  });
}

test('Appliquer & générer : la production lit les réglages que la fiche vient d’écrire', async (t) => {
  const storeRunner = runner(() => useProjectStore());
  t.after(() => storeRunner.unmount());
  let store = storeRunner.render();
  const loaded = createAdvancedProject({ payload: PAYLOAD, projectName: 'Graphe' });
  // Un média lié, pour que la vérification des fichiers laisse passer.
  store.loadProject({
    ...loaded,
    authoring: { ...loaded.authoring, mediaBindings: [{ assetRef: 'media/a.mp3', path: '/m/a.mp3', status: 'resolved' }] },
  });
  store = storeRunner.render();
  // Le rendu dont la fiche et la production ont capturé le store.
  const captured = store;

  // Ce que fait la fiche : une écriture d'enveloppe, aucun rendu ensuite.
  captured.setProject((project) => ({
    ...project,
    globalOptions: {
      ...(project.globalOptions ?? {}),
      harmonizeLoudness: false,
      silenceMode: 'add',
      leadingSilenceSec: 1.5,
      trailingSilenceSec: 2,
    },
  }));
  assert.equal(captured.project.globalOptions?.silenceMode, undefined,
    'le piège : le store capturé porte encore le projet d’avant la fiche');

  const trace = {};
  const result = await produce(captured, trace);
  assert.equal(result.outcome, ADVANCED_PRODUCTION.STARTED, JSON.stringify(trace.refusal ?? null));
  assert.equal(trace.assessed.globalOptions.silenceMode, 'add', 'la qualification porte sur le projet courant');
  assert.deepEqual(trace.options, {
    silenceMode: 'add',
    harmonizeLoudness: false,
    leadingSilenceSec: 1.5,
    trailingSilenceSec: 2,
  });
});

// Extrait le code d'un `useCallback` nommé de l'hôte, jusqu'à ses dépendances,
// sans ses commentaires : ils ont le droit de nommer le piège.
function hostCallback(source, name) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.ok(start >= 0, `${name} introuvable dans App.jsx`);
  const end = source.indexOf('\n  }, [', start);
  assert.ok(end > start, `fin de ${name} introuvable`);
  return source.slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('l’hôte relit le projet courant dans la production graphe et dans la fiche', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const produceBody = hostCallback(source, 'handleAdvancedProduce');
  assert.doesNotMatch(produceBody, /store\.project\b/,
    'la production ne doit rien lire dans le projet du rendu capturé');
  assert.match(produceBody, /readProject:\s*store\.readProject\b/);
  assert.match(produceBody, /advancedPackAudioOptions\(store\.readProject\(\)\?\.globalOptions\)/);

  const ficheBody = hostCallback(source, 'handleSaveAdvancedPackMetadata');
  assert.doesNotMatch(ficheBody, /store\.project\b/,
    'la fiche compare au projet courant, pas à celui du rendu capturé');
});
