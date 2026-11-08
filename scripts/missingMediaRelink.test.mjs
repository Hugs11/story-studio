import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatePathsForRelinkRoot,
  collectMissingMedia,
  relinkMediaLibraryPaths,
  relinkMediaTags,
  relinkProjectMedia,
  refreshRelinkRows,
  shouldProposeMissingMediaRelink,
} from '../src/store/missingMediaRelink.js';
import {
  chooseCompatibleProjectPath,
  workspaceFallbackForProjectRelativePath,
} from '../src/store/projectPathCompatibility.js';

test('collectMissingMedia groups repeated missing media references', () => {
  const project = {
    rootAudio: 'D:/moved/fichiers-importes/intro.mp3',
    rootEntries: [
      {
        id: 'story-1',
        type: 'story',
        name: 'Story',
        audio: 'D:/moved/fichiers-importes/story.mp3',
        itemAudio: 'D:/moved/fichiers-importes/intro.mp3',
      },
    ],
  };
  const missing = collectMissingMedia(project, {
    'D:/moved/fichiers-importes/intro.mp3': false,
    'D:/moved/fichiers-importes/story.mp3': true,
  });

  assert.equal(missing.length, 1);
  assert.equal(missing[0].fileName, 'intro.mp3');
  assert.equal(missing[0].count, 2);
  assert.deepEqual(missing[0].labels, ['Audio de couverture', 'Titre audio : Story']);
});

test('relinkProjectMedia replaces every matching project media path', () => {
  const project = {
    rootAudio: 'D:/moved/fichiers-importes/intro.mp3',
    rootEntries: [
      {
        id: 'story-1',
        type: 'story',
        name: 'Story',
        audio: 'D:/moved/fichiers-importes/story.mp3',
        itemAudio: 'D:/moved/fichiers-importes/intro.mp3',
      },
    ],
  };

  const relinked = relinkProjectMedia(project, {
    'D:/moved/fichiers-importes/intro.mp3': 'C:/project/fichiers-importes/intro.mp3',
  });

  assert.equal(relinked.rootAudio, 'C:/project/fichiers-importes/intro.mp3');
  assert.equal(relinked.rootEntries[0].itemAudio, 'C:/project/fichiers-importes/intro.mp3');
  assert.equal(relinked.rootEntries[0].audio, 'D:/moved/fichiers-importes/story.mp3');
  assert.equal(project.rootAudio, 'D:/moved/fichiers-importes/intro.mp3');
});

test('relink helpers update media tags and library paths', () => {
  const replacements = {
    'D:/moved/fichiers-importes/intro.mp3': 'C:/project/fichiers-importes/intro.mp3',
  };

  assert.deepEqual(
    relinkMediaTags({
      'D:/moved/fichiers-importes/intro.mp3': ['voix'],
      'C:/project/fichiers-importes/intro.mp3': ['favori'],
      'D:/moved/fichiers-importes/story.mp3': ['histoire'],
    }, replacements),
    {
      'C:/project/fichiers-importes/intro.mp3': ['voix', 'favori'],
      'D:/moved/fichiers-importes/story.mp3': ['histoire'],
    },
  );

  assert.deepEqual(
    relinkMediaLibraryPaths([
      'D:/moved/fichiers-importes/intro.mp3',
      'D:/moved/fichiers-importes/story.mp3',
    ], replacements),
    [
      'C:/project/fichiers-importes/intro.mp3',
      'D:/moved/fichiers-importes/story.mp3',
    ],
  );
});

test('candidatePathsForRelinkRoot tries managed folder suffix then basename', () => {
  assert.deepEqual(
    candidatePathsForRelinkRoot('D:/lost/fichiers-importes/story.mp3', 'C:/project'),
    [
      'C:/project/fichiers-importes/story.mp3',
      'C:/project/story.mp3',
    ],
  );
});

test('candidatePathsForRelinkRoot follows native case rules for managed folders', () => {
  assert.deepEqual(
    candidatePathsForRelinkRoot('D:\\LOST\\FICHIERS-IMPORTES\\story.mp3', 'C:/project'),
    [
      'C:/project/fichiers-importes/story.mp3',
      'C:/project/story.mp3',
    ],
  );
  assert.deepEqual(
    candidatePathsForRelinkRoot('/tmp/LOST/FICHIERS-IMPORTES/story.mp3', '/project'),
    ['/project/story.mp3'],
  );
});

test('workspaceFallbackForProjectRelativePath maps managed relative paths to workspace root', () => {
  assert.equal(
    workspaceFallbackForProjectRelativePath('./fichiers-importes/story.mp3', 'C:/workspace'),
    'C:/workspace/fichiers-importes/story.mp3',
  );
  assert.equal(
    workspaceFallbackForProjectRelativePath('../voix-generees/voice.wav', 'C:/workspace'),
    'C:/workspace/voix-generees/voice.wav',
  );
  assert.equal(
    workspaceFallbackForProjectRelativePath('./custom-assets/story.mp3', 'C:/workspace'),
    null,
  );
});

test('chooseCompatibleProjectPath prefers workspace media when the project-relative target is missing', () => {
  assert.equal(
    chooseCompatibleProjectPath(
      './fichiers-importes/story.mp3',
      'C:/workspace/sauvegardes/fichiers-importes/story.mp3',
      'C:/workspace',
      { projectExists: false, workspaceExists: true },
    ),
    'C:/workspace/fichiers-importes/story.mp3',
  );

  assert.equal(
    chooseCompatibleProjectPath(
      './fichiers-importes/story.mp3',
      'C:/workspace/sauvegardes/fichiers-importes/story.mp3',
      'C:/workspace',
      { projectExists: true, workspaceExists: true },
    ),
    'C:/workspace/sauvegardes/fichiers-importes/story.mp3',
  );
});

// Le retour d'une boîte native (choix du dossier, choix d'un fichier) redonne
// le focus à la fenêtre, et ce focus relance l'audit des chemins. Une
// proposition déjà ouverte ne doit pas se fermer pendant cette relecture : sa
// fermeture démontait la boîte et effaçait les fichiers que l'auteur venait de
// relier.
test('une proposition ouverte reste ouverte pendant un nouvel audit', () => {
  const inputs = {
    projectOpen: true,
    savePath: 'C:/projets/pack.mbah',
    missingMedia: [{ path: 'C:/projets/fichiers-importes/a.mp3' }],
    missingMediaSignature: 'a',
    dismissedMissingMediaSignature: '',
  };
  // Premier audit : la liste n'est pas encore stable, rien ne s'ouvre.
  assert.equal(shouldProposeMissingMediaRelink({ ...inputs, pathAuditPending: true }), false);
  // Proposition ouverte, audit relancé par le retour de focus : elle reste.
  assert.equal(shouldProposeMissingMediaRelink({ ...inputs, pathAuditPending: true, proposalOpen: true }), true);
  // Rejet ou liste vidée : elle se ferme, audit en cours ou non.
  assert.equal(shouldProposeMissingMediaRelink({
    ...inputs, pathAuditPending: true, proposalOpen: true, dismissedMissingMediaSignature: 'a',
  }), false);
  assert.equal(shouldProposeMissingMediaRelink({
    ...inputs, pathAuditPending: true, proposalOpen: true, missingMedia: [],
  }), false);
});

test('une liste rafraîchie garde les fichiers déjà reliés', () => {
  const rows = [
    { path: 'C:/p/fichiers-importes/a.mp3', fileName: 'a.mp3', status: 'found', replacementPath: 'D:/bureau/a.mp3', matches: ['D:/bureau/a.mp3'] },
    { path: 'C:/p/fichiers-importes/b.png', fileName: 'b.png', status: 'found', replacementPath: 'D:/bureau/b.png', matches: ['D:/bureau/b.png'] },
  ];
  // `b.png` est revenu à sa place, `c.mp3` vient de disparaître.
  const refreshed = refreshRelinkRows(rows, [
    { path: 'C:\\p\\fichiers-importes\\a.mp3', fileName: 'a.mp3', labels: ['Accueil'], count: 1 },
    { path: 'C:/p/fichiers-importes/c.mp3', fileName: 'c.mp3', labels: [], count: 1 },
  ]);
  assert.deepEqual(refreshed.map((row) => [row.fileName, row.status, row.replacementPath]), [
    ['a.mp3', 'found', 'D:/bureau/a.mp3'],
    ['c.mp3', 'missing', ''],
  ]);
  // Les métadonnées viennent de la liste à jour.
  assert.deepEqual(refreshed[0].labels, ['Accueil']);
});

// Exécute les fonctions de production de la modale sans son rendu JSX ni Tauri.
const { readFileSync } = await import('node:fs');
const modalSource = readFileSync(new URL('../src/components/MissingMediaRelink/MissingMediaRelinkModal.jsx', import.meta.url), 'utf8');
const scanSource = modalSource.slice(modalSource.indexOf('async function scanFolderByName('), modalSource.indexOf('function mergeResolvedRows('));
function scanner(readDir) {
  return new Function('readDir', 'joinPath', 'basename', 'MAX_SCAN_FILES', `${scanSource}; return scanFolderByName;`)(
    readDir, (dir, name) => `${dir}/${name}`, (path) => path.split('/').pop(), 12000,
  );
}

test('recherche : correspondances conservées et dossiers illisibles signalés, y compris la racine', async () => {
  const scan = scanner(async (dir) => {
    if (dir !== '/workspace') throw new Error('access denied');
    return [
      { name: 'closed', isDirectory: true },
      { name: 'a.wav', isFile: true },
      { name: 'nested', isDirectory: true },
    ];
  });
  const result = await scan('/workspace', new Set(['a.wav']));
  assert.deepEqual(result.matches.get('a.wav'), ['/workspace/a.wav']);
  assert.deepEqual(result.unreadableFolders, ['/workspace/closed', '/workspace/nested']);
  assert.equal(result.truncated, false);
  assert.equal(result.scanned, 1);
  assert.deepEqual((await scan('/closed', new Set())).unreadableFolders, ['/closed']);
});

test('recherche : plafond de 12 000 conservé et troncature signalée', async () => {
  const scan = scanner(async () => Array.from({ length: 12001 }, (_, i) => ({ name: `${i}.wav`, isFile: true })));
  const result = await scan('/workspace', new Set(['0.wav', '12000.wav']));
  assert.equal(result.scanned, 12000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.matches.get('0.wav'), ['/workspace/0.wav']);
  assert.deepEqual(result.matches.get('12000.wav'), []);
  assert.deepEqual(result.unreadableFolders, []);
});

test('application : une recherche en vol bloque le handler et le bouton malgré les anciens résultats', async () => {
  const applySource = modalSource.slice(modalSource.indexOf('  async function handleApply()'), modalSource.indexOf('  const progressPct'));
  let calls = 0;
  const run = (scanningKey) => new Function('resolvedCount', 'applying', 'scanningKey', 'setApplying', 'onApply', 'replacements', `${applySource}; return handleApply();`)(
    1, false, scanningKey, () => {}, async () => { calls += 1; }, { '/old': '/new' },
  );
  await run('__workspace__');
  await run('/group');
  assert.equal(calls, 0);
  await run('');
  assert.equal(calls, 1);
  assert.match(modalSource, /onClick=\{handleApply\}\s+disabled=\{resolvedCount === 0 \|\| applying \|\| Boolean\(scanningKey\)\}/);
  assert.match(modalSource, /scanResult.truncated \|\| scanResult.unreadableFolders.length > 0/);
  assert.match(modalSource, /setScanWarning\(scanResult\)/);
});

function folderScanHarness(initialRows, findFirstExisting) {
  let rows = initialRows;
  const helpers = modalSource.slice(modalSource.indexOf('function mergeResolvedRows('), modalSource.indexOf('// Rôle représentatif'));
  const scan = modalSource.slice(modalSource.indexOf('  async function runFolderScan('), modalSource.indexOf('  async function handleChooseGroupFolder('));
  const run = new Function('pathKey', 'isResolved', 'candidatePathsForRelinkRoot', 'findFirstExisting', 'scanFolderByName', 'setRows', 'setScanWarning', `${helpers}\n${scan}\nreturn runFolderScan;`)(
    (path) => path, (row) => row.status === 'found' && Boolean(row.replacementPath),
    candidatePathsForRelinkRoot, findFirstExisting,
    async () => ({ matches: new Map(), truncated: false, unreadableFolders: [] }),
    (update) => { rows = update(rows); }, () => {},
  );
  return { run, rows: () => rows, setRows: (next) => { rows = next; } };
}

for (const folder of ['/workspace', '/chosen-group']) {
  test(`recherche ${folder} : choix manuel conservé sans revérification`, async () => {
    const manual = { path: '/old/a.wav', fileName: 'a.wav', status: 'found', replacementPath: '/manual/a.wav', matches: ['/manual/a.wav'] };
    const pending = { path: '/old/b.wav', fileName: 'b.wav', status: 'missing' };
    const checked = [];
    const f = folderScanHarness([manual, pending], async (paths) => { checked.push(...paths); return null; });
    await f.run(folder, f.rows());
    assert.strictEqual(f.rows()[0], manual);
    assert.ok(checked.every((path) => !path.endsWith('/a.wav')));
    assert.ok(checked.some((path) => path.endsWith('/b.wav')));
  });

  test(`recherche ${folder} : résultat trouvé conservé lors de la seconde recherche sans correspondance`, async () => {
    let available = true;
    const f = folderScanHarness([{ path: '/old/a.wav', fileName: 'a.wav', status: 'missing' }], async () => available ? '/found/a.wav' : null);
    await f.run(folder, f.rows());
    const found = f.rows()[0];
    assert.equal(found.status, 'found');
    available = false;
    await f.run(folder, f.rows());
    assert.strictEqual(f.rows()[0], found);
    assert.equal(f.rows()[0].replacementPath, '/found/a.wav');
  });
}

test('un choix manuel effectué pendant une recherche reste prioritaire sur son résultat tardif', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const original = { path: '/old/a.wav', fileName: 'a.wav', status: 'missing' };
  const f = folderScanHarness([original], async () => pending);
  const scan = f.run('/workspace', f.rows());
  const manual = { ...original, status: 'found', replacementPath: '/manual/a.wav', matches: ['/manual/a.wav'] };
  f.setRows([manual]);
  release(null);
  await scan;
  assert.strictEqual(f.rows()[0], manual);
});
