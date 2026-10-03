// « Consolider le projet » sans projet ouvert (accueil : type de projet nul).
//
// Le hook `useAppPreferences` et le vrai `projectIO` sont exécutés sur un
// disque temporaire ; seuls la WebView et les dialogues sont doublés. À
// l'accueil, le store porte le projet par défaut : il n'y a rien à consolider.
// Le bouton est inactif, et l'action ne choisit aucun dossier ni n'écrit rien.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useAppPreferences } = await import('../src/hooks/useAppPreferences.js');

const noop = () => {};

test('sans projet ouvert, consolider ne choisit aucun dossier et n’écrit rien', async () => {
  const harness = await createDiskHarness();
  try {
    const destination = await harness.mkdirp('consolidation');
    harness.answerOpen(destination);
    const recents = [];
    const app = runner(() => {
      const store = useProjectStore();
      return useAppPreferences({
        store,
        sessionMode: null,
        setConfiguredWorkspaceDir: noop,
        setWorkspaceDirState: noop,
        setVerboseLoggingState: noop,
        setSaveProgress: noop,
        setRecentProjects: (value) => recents.push(value),
        setXttsSettings: noop,
        showErrorDialog: noop,
        showConfirmDialog: noop,
      });
    });
    const preferences = app.render();
    const result = await preferences.handleConsolidateProject();
    assert.equal(result, null);
    assert.equal(harness.countCalls('plugin:dialog|open'), 0, 'aucun dossier demandé');
    assert.deepEqual(await fs.readdir(destination), [], 'aucun fichier consolidé');
    assert.deepEqual(recents, [], 'rien ajouté aux projets récents');
  } finally {
    await harness.dispose();
  }
});

test('le bouton « Consolider » est inactif tant qu’aucun type de projet n’est choisi', async () => {
  const source = await readFile(
    new URL('../src/tabs/OptionsTab/ProjectsMediaSection.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /<Button onClick=\{handleConsolidate\} disabled=\{consolidating \|\| !project\?\.projectType\}>/);
});
