import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { classifyOsDroppedFiles } from '../src/store/projectHelpers.js';
import { keepFolderPackInProject } from '../src/utils/packFolder.js';
import { deleteWorkspaceMediaDiskDouble } from './workspaceDeletionDiskDouble.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('dépôt : le type réel prime sur l’extension, un dossier de pack est à part', () => {
  const kinds = new Map([
    ['/a/Histoire.mp3', 'folder'], ['/a/Pack', 'folder'], ['/a/Vrai.zip', 'file'],
    ['/a/voix.mp3', 'file'], ['/a/Faux.zip', 'folder'], ['/a/img.png', 'file'],
  ]);
  const result = classifyOsDroppedFiles([...kinds.keys()], kinds);
  assert.deepEqual(result.audio, ['/a/voix.mp3']);
  assert.deepEqual(result.archives, ['/a/Vrai.zip']);
  assert.deepEqual(result.images, ['/a/img.png']);
  assert.deepEqual(result.folders, ['/a/Histoire.mp3', '/a/Pack', '/a/Faux.zip']);
});

test('dépôt sans moteur (kinds absent) : classement par extension, aucun dossier', () => {
  const result = classifyOsDroppedFiles(['/a/x.mp3', '/a/y.zip', '/a/Dossier']);
  assert.deepEqual(result.audio, ['/a/x.mp3']);
  assert.deepEqual(result.archives, ['/a/y.zip']);
  assert.deepEqual(result.folders, []);
});

test('routage : chaque entrée a deux boutons (archive / dossier) et aucun écart silencieux', async () => {
  const zipEditor = await read('../src/components/editors/ZipEditor.jsx');
  assert.match(zipEditor, /pickZip\(\)/);
  assert.match(zipEditor, /pickFolder\(\)/);
  assert.match(zipEditor, /onKeepFolderPack\(folder, \{\s*destination: mediaStorage,\s*isCurrent: stillHere,\s*apply: zipPath => onUpdate/);
  const checker = await read('../src/components/CommunityPackChecker/useCommunityPackChecker.js');
  assert.match(checker, /pickFolder\(\)/);
  assert.match(checker, /convertFolderPackToZip/);
  const funnel = await read('../src/components/CommunityPackChecker/CommunityPackCheckerFunnel.jsx');
  assert.match(funnel, /pickFolderPack/);
  const aggregate = await read('../src/components/AggregatePacks/AggregatePacksFunnel.jsx');
  assert.match(aggregate, /pickFolder\(\{ multiple: true \}\)/);
  assert.match(aggregate, /convertFolderPackToZip\(sourcePath\)/);
  const session = await read('../src/hooks/useImportSession.js');
  assert.match(session, /keepFolderPackInProject\(f, \(staged\) => copyGeneratedMediaToProject\(staged/);
  assert.match(checker, /sourceLabel: sourceFolder/);
  const drop = await read('../src/hooks/useOsFileDrop.js');
  assert.match(drop, /dispatchFiles\(null, relevant, null, \{ folders \}\)/);
});

function fakeEngine() {
  const calls = [];
  const call = async (command, args) => {
    calls.push([command, args]);
    return command === 'convert_folder_pack_to_named_zip' ? '/cache/sessions/abc/Histoire_v1.2.zip' : null;
  };
  return { calls, call };
}

test('copie réussie : chemin du projet rendu, dossier de travail libéré', async () => {
  const { calls, call } = fakeEngine();
  const kept = await keepFolderPackInProject('/d/Histoire v1.2', async () => '/projet/Histoire_v1.2.zip', { call });
  assert.equal(kept, '/projet/Histoire_v1.2.zip');
  assert.deepEqual(calls.at(-1), ['cleanup_session_workspace', { path: '/cache/sessions/abc' }]);
});

test('copie ratée (le copieur rend le chemin source) : erreur, jamais un chemin mort', async () => {
  await i18next.init(createTestI18n().options);
  for (const failed of [(staged) => staged, () => undefined, () => '']) {
    const { calls, call } = fakeEngine();
    await assert.rejects(keepFolderPackInProject('/d/x', async (staged) => failed(staged), { call }), /copi/i);
    assert.equal(calls.at(-1)[0], 'cleanup_session_workspace');
  }
  const { call } = fakeEngine();
  await assert.rejects(keepFolderPackInProject('/d/x', async () => { throw new Error('boum'); }, { call }), /boum/);
});

test('conversion périmée : aucune copie, même si le moteur termine après le changement de projet', async () => {
  const { call, calls } = fakeEngine();
  let current = true;
  const delayedCall = async (command, args) => {
    const result = await call(command, args);
    if (command === 'convert_folder_pack_to_named_zip') current = false;
    return result;
  };
  const kept = await keepFolderPackInProject('/d/Été en forêt', assert.fail, {
    call: delayedCall, isCurrent: () => current, discard: assert.fail,
  });
  assert.equal(kept, null);
  assert.equal(calls.at(-1)[0], 'cleanup_session_workspace');
});

test('projet remplacé pendant le nettoyage du staging : la copie est aussi retirée', async () => {
  let current = true;
  const discarded = [];
  const call = async command => {
    if (command === 'convert_folder_pack_to_named_zip') return '/cache/sessions/abc/Été.zip';
    current = false;
  };
  const kept = await keepFolderPackInProject('/d/Été', async () => '/projet/Été.zip', {
    call, isCurrent: () => current, discard: async path => discarded.push(path),
  });
  assert.equal(kept, null);
  assert.deepEqual(discarded, ['/projet/Été.zip']);
});

test('projet remplacé pendant la copie : la nouvelle archive est supprimée du disque', async () => {
  const { createDiskHarness } = await import('./tauriDiskHarness.mjs');
  const harness = await createDiskHarness({ commands: {
    delete_workspace_media_file: async args => {
      const { path, workspaceDir } = args;
      assert.equal(workspaceDir, harness.workspace);
      assert.equal(path, harness.dir('workspace/fichiers-importes/.Été en forêt.zip'));
      await deleteWorkspaceMediaDiskDouble(args);
    },
  } });
  try {
    let current = true;
    const { call, calls } = fakeEngine();
    const target = harness.dir('workspace/fichiers-importes/.Été en forêt.zip');
    const original = await harness.writeFile('workspace/fichiers-importes/.Été en forêt.original.zip', 'préexistant');
    harness.injectFailure({ cmd: 'plugin:fs|remove', match: '.Été en forêt.zip' });
    const kept = await keepFolderPackInProject('/d/Été en forêt', async () => {
      await harness.writeFile('workspace/fichiers-importes/.Été en forêt.zip', 'archive produite');
      current = false;
      return target;
    }, {
      call: (command, args) => command === 'delete_workspace_media_file'
        ? window.__TAURI_INTERNALS__.invoke(command, args) : call(command, args),
      workspaceDir: harness.workspace, isCurrent: () => current,
    });
    assert.equal(kept, null);
    assert.equal(await harness.exists(target), false);
    assert.equal(await readFile(original, 'utf8'), 'préexistant');
    assert.equal(harness.countCalls('delete_workspace_media_file'), 1);
    assert.equal(calls.at(-1)[0], 'cleanup_session_workspace');
  } finally { await harness.dispose(); }
});

test('le double IPC reproduit la cascade ZIP par défaut et protège les voisins en mode fichier seul', async () => {
  const { createDiskHarness } = await import('./tauriDiskHarness.mjs');
  const harness = await createDiskHarness();
  try {
    for (const cascade of [undefined, false]) {
      const target = await harness.writeFile('workspace/fichiers-importes/.Histoire.zip', 'créé');
      const original = await harness.writeFile('workspace/fichiers-importes/.Histoire.original.zip', 'préexistant');
      await deleteWorkspaceMediaDiskDouble({ path: target, workspaceDir: harness.workspace, cascade });
      assert.equal(await harness.exists(target), false);
      assert.equal(await harness.exists(original), cascade === false);
    }
  } finally { await harness.dispose(); }
});

test('dépôt mixte : l’ordre de l’utilisateur est gardé, plusieurs échecs = un seul message', async () => {
  const drop = await read('../src/hooks/useOsFileDrop.js');
  assert.match(drop, /paths\.filter\(\(path\) => wanted\.has\(path\)\)/);
  const session = await read('../src/hooks/useImportSession.js');
  assert.match(session, /folderFailures\.push/);
  assert.equal((session.match(/folder\.pack\.invalid\.message/g) ?? []).length, 1);
  const zip = await read('../src/components/editors/ZipEditor.jsx');
  assert.match(zip, /stillHere\(\)/);
});
