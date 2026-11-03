// Déclaration des enregistrements de projet au catalogue des packs.
//
// Le harnais disque sert les vraies écritures ; seules les deux commandes de
// déclaration sont doublées. On vérifie l'ordre réel des appels IPC : la
// déclaration précède toute mutation et la clôture suit le renommage final.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const io = await import('../src/store/projectIO.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

const project = () => normalizeProjectData({
  projectName: 'projet-catalogue',
  rootEntries: [{ id: 'story-1', type: 'story', name: 'Une histoire' }],
});

function declarationCommands(declarations) {
  return {
    catalogue_begin_write: (args) => {
      declarations.push({ begin: args });
      return `op-${declarations.length}`;
    },
    catalogue_finish_write: (args) => {
      declarations.push({ finish: args });
      return null;
    },
  };
}

async function withHarness(commands, run) {
  const harness = await createDiskHarness({ commands });
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

test('un enregistrement est déclaré avant toute mutation et clos après le renommage', async () => {
  const declarations = [];
  await withHarness(declarationCommands(declarations), async (harness) => {
    const dir = await harness.mkdirp('projets');
    const savePath = `${dir}/projet.mbah`;
    await io.saveProject(project(), savePath, null, { backupLimit: 2 });
    await io.saveProject(project(), savePath, null, { backupLimit: 2 });

    const commands = harness.calls.map((call) => call.cmd);
    const begin = commands.indexOf('catalogue_begin_write');
    const firstMutation = commands.findIndex((cmd) => /plugin:fs\|(write_text_file|rename|copy_file|remove|mkdir)/.test(cmd));
    const lastRename = commands.lastIndexOf('plugin:fs|rename');
    assert.ok(begin >= 0 && begin < firstMutation, 'déclaration avant la première mutation');
    assert.ok(commands.lastIndexOf('catalogue_finish_write') > lastRename, 'clôture après le renommage');

    const begins = declarations.filter((entry) => entry.begin).map((entry) => entry.begin);
    assert.equal(begins.length, 2);
    for (const declared of begins) {
      assert.equal(declared.kind, 'projectSave');
      assert.deepEqual(declared.paths.map((p) => p.replace(/\\/g, '/')), [savePath]);
      assert.equal(declared.temporaries.length, 1);
      assert.match(declared.temporaries[0], /projet\.mbah\.tmp-/);
      assert.equal(declared.subtrees.length, 1, 'dossier de rotation des versions déclaré');
    }
    const finishes = declarations.filter((entry) => entry.finish).map((entry) => entry.finish);
    assert.deepEqual(finishes, [
      { operationId: 'op-1', succeeded: true },
      { operationId: 'op-3', succeeded: true },
    ]);
  });
});

test('un échec d\'écriture clôt la déclaration en échec', async () => {
  const declarations = [];
  await withHarness(declarationCommands(declarations), async (harness) => {
    const dir = await harness.mkdirp('projets');
    const savePath = `${dir}/projet.mbah`;
    harness.injectFailure({ cmd: 'plugin:fs|rename', match: 'projet.mbah' });
    await assert.rejects(io.saveProject(project(), savePath));
    assert.deepEqual(declarations.at(-1), { finish: { operationId: 'op-1', succeeded: false } });
    assert.equal(await harness.exists(savePath), false);
  });
});

test('sans catalogue disponible, l\'enregistrement se fait quand même', async () => {
  await withHarness({}, async (harness) => {
    const dir = await harness.mkdirp('projets');
    const savePath = `${dir}/projet.mbah`;
    await io.saveProject(project(), savePath);
    assert.equal(await harness.exists(savePath), true);
    assert.equal(harness.countCalls('catalogue_finish_write'), 0);
  });
});
