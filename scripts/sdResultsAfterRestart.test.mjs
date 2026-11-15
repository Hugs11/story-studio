// H9 — la file des images IA survit au redémarrage, pas le projet qui les portait.
//
// Les images terminées sont gardées dans le stockage local (`sdJobResults`) et
// relues au lancement (`loadPersistedJobs`). Tout changement de projet dans
// l'application vide les travaux terminés (`clearDone` : retour à l'accueil,
// ouverture, reprise de session), mais ni la fermeture ni le lancement ne le
// font. Après « Quitter sans enregistrer », le dossier de session est supprimé :
// au lancement suivant, la file d'un nouveau projet montre des images dont les
// fichiers n'existent plus.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useSdStore } = await import('../src/store/sdStore.js');

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function launch() {
  let store;
  const app = runner(() => { store = useSdStore(); });
  const refresh = () => { app.render(); app.flush(); };
  refresh();
  return { app, refresh, read: () => store };
}

async function generateImageThenQuit(disk, imagePath) {
  await fs.mkdir(imagePath.slice(0, imagePath.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(imagePath, 'png');
  const first = launch();
  const jobId = first.read().addJob('workflow', 'Images', { positivePrompt: 'un renard' }, { targetLabel: 'Couverture' });
  first.refresh();
  first.read().updateJob(jobId, { status: 'done', resultPaths: [imagePath] });
  first.refresh();
  await settle();
  // Fermeture de l'application : aucun `clearDone`, la file reste dans le stockage local.
  first.app.unmount();
}

test('h9 : au relancement, la file IA ne propose pas une image dont le dossier de session a été supprimé', async () => {
  const disk = await createDiskHarness();
  try {
    const sessionDir = disk.dir('cache', 'sessions', 'story_studio_session_1_1_0');
    const imagePath = `${sessionDir}/images-generees/renard.png`;
    await generateImageThenQuit(disk, imagePath);
    // « Quitter sans enregistrer » : `cleanup_session_workspace` supprime la session.
    await fs.rm(sessionDir, { recursive: true, force: true });

    const second = launch();
    await settle();
    second.refresh();
    const dead = [];
    for (const job of second.read().jobs) {
      for (const path of job.resultPaths ?? []) {
        if (!await disk.exists(path)) dead.push(path);
      }
    }
    second.app.unmount();
    assert.deepEqual(dead, [], 'la file relancée désigne des images qui n’existent plus');
  } finally { await disk.dispose(); }
});

test('h9 : au relancement, un nouveau projet ne reçoit pas la file IA du projet précédent', async () => {
  const disk = await createDiskHarness();
  try {
    // Projet enregistré : l'image existe toujours, mais elle appartient au projet d'hier.
    const imagePath = `${disk.workspace}/images-generees/Projet d'hier/renard.png`;
    await generateImageThenQuit(disk, imagePath);

    const second = launch();
    await settle();
    second.refresh();
    const jobs = second.read().jobs;
    second.app.unmount();
    // Même règle que `leaveProject`, `applyLoadedProject` et `handleRecoverSession`,
    // qui vident tous les travaux terminés au changement de projet.
    assert.equal(jobs.length, 0, 'les travaux terminés d’un autre projet restent dans la file');
  } finally { await disk.dispose(); }
});
