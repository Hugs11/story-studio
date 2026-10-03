// Extraction d'un pack inclus (ZIP) dans un projet par menus.
//
// Le hook `useImportSession` et le vrai store sont exécutés intacts ; seuls
// l'ordonnanceur React et la réponse native `unpack_zip_to_entries` sont doublés.
// La réponse décrit un pack dont les histoires finissent par un message partagé.
//
// Dans un parent non vierge, ce message ne doit pas devenir le message
// de fin de tout le parent ; la promotion d'un projet vierge, elle, le garde.
// Deux extractions du même pack ne produisent aucun identifiant en
// double, gardent leurs cibles internes, et une modification ne touche qu'une
// copie.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { normalizeProjectData, buildProjectIndex } = await import('../src/store/projectModel.js');

const noop = () => {};

// Pack synthétique : un menu, deux histoires ; la première renvoie vers la
// seconde, le menu vise la seconde à l'Accueil. Message de fin partagé.
function unpackResult() {
  return {
    rootId: 'pack-root',
    title: 'Inclus',
    entries: [
      {
        id: 'menu-pack',
        type: 'menu',
        name: 'Menu du pack',
        children: [
          { id: 'story-1', type: 'story', name: 'Un', audio: 'C:/ws/zips-extraits/Inclus/un.wav', returnAfterPlay: 'story:story-2' },
          { id: 'story-2', type: 'story', name: 'Deux', audio: 'C:/ws/zips-extraits/Inclus/deux.wav', returnOnHome: 'menu:menu-pack' },
          { id: 'ref-1', type: 'ref', target: 'story:story-1', refKind: 'continue' },
        ],
      },
    ],
    nightModeAudio: 'C:/ws/zips-extraits/Inclus/fin.wav',
    nightModeReturn: null,
    nightModeHomeReturn: null,
    nightMode: false,
    endMessageAutoplay: true,
  };
}

function mount(initialProject, result = unpackResult()) {
  const previousInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command) => {
    if (command === 'unpack_zip_to_entries') return result;
    throw new Error(`commande non doublée : ${command}`);
  };
  const errors = [];
  const notices = [];
  let store; let session;
  const app = runner(() => {
    store = useProjectStore();
    session = useImportSession({
      store,
      projectIndex: buildProjectIndex(store.project),
      setImporting: noop,
      setUnpacking: noop,
      setImportNotice: (notice) => notices.push(notice),
      persistProjectSnapshot: async () => null,
      workspaceDirRef: { current: 'C:/ws' },
      showErrorDialog: (error) => errors.push(error),
      onImportedPackPromoted: noop,
    });
  });
  app.render();
  store.loadProject(initialProject);
  app.render();
  return {
    parent: initialProject,
    get store() { return store; },
    get session() { return session; },
    render: () => app.render(),
    errors,
    notices,
    restore: () => { window.__TAURI_INTERNALS__.invoke = previousInvoke; },
  };
}

function parentWithZips(zipIds) {
  return normalizeProjectData({
    projectType: 'pack',
    projectName: 'Parent',
    rootEntries: [
      { id: 'C', type: 'story', name: 'C', audio: 'C:/medias/c.wav' },
      ...zipIds.map((id) => ({ id, type: 'zip', name: 'Inclus', zipPath: 'C:/medias/inclus.zip' })),
    ],
  });
}

function allIds(entries, out = []) {
  for (const entry of entries ?? []) {
    out.push(entry.id);
    allIds(entry.children, out);
  }
  return out;
}

for (const autoNext of [false, true]) {
  test(`N-02 : extraire un pack enchaîné conserve autoNext=${autoNext} du parent et prévient l’auteur`, async () => {
    const parent = parentWithZips(['zip-1']);
    parent.globalOptions = { ...parent.globalOptions, autoNext, nightMode: true };
    const c = mount(parent, { ...unpackResult(), autoNext: true });
    try {
      const before = c.store.project;
      await c.session.handleUnpackZip('zip-1');
      c.render();
      assert.deepEqual(c.errors, []);
      assert.deepEqual(c.store.project.globalOptions, before.globalOptions);
      assert.deepEqual(c.notices, ["Ce pack enchaînait ses histoires ; ce réglage n'a pas été repris."]);
    } finally {
      c.restore();
    }
  });
}

test('N-02 : la note d’enchaînement conserve aussi l’avertissement de transitions', async () => {
  const c = mount(parentWithZips(['zip-1']), {
    ...unpackResult(), autoNext: true, advancedTransitionsDetected: true,
    unresolvedTransitions: [{ message: 'Retour à vérifier' }],
  });
  try {
    await c.session.handleUnpackZip('zip-1');
    assert.deepEqual(c.errors, []);
    assert.equal(c.notices.length, 1);
    assert.match(c.notices[0], /Certaines transitions/);
    assert.match(c.notices[0], /Retour à vérifier/);
    assert.ok(c.notices[0].includes("Ce pack enchaînait ses histoires ; ce réglage n'a pas été repris."));
  } finally {
    c.restore();
  }
});

test('N-02 : la promotion vierge et Modifier un pack reprennent l’enchaînement sans note', async () => {
  const blank = normalizeProjectData({
    projectType: 'pack', projectName: '',
    rootEntries: [{ id: 'zip-1', type: 'zip', name: 'Inclus', zipPath: 'C:/medias/inclus.zip' }],
  });
  const c = mount(blank, { ...unpackResult(), autoNext: true });
  try {
    await c.session.handleUnpackZip('zip-1');
    c.render();
    assert.deepEqual(c.errors, []);
    assert.equal(c.store.project.globalOptions.autoNext, true);
    assert.equal(c.store.project.globalOptions.nightMode, false);
    assert.deepEqual(c.notices, []);
    const transformed = await c.session.unpackZipIntoBlankProject({
      zipPath: 'C:/medias/inclus.zip', zipName: 'Inclus', workspaceDir: 'C:/ws',
      baseProject: normalizeProjectData({ projectType: 'pack', rootEntries: [] }),
    });
    assert.equal(transformed.promoted, true);
    assert.equal(transformed.project.globalOptions.autoNext, true);
  } finally {
    c.restore();
  }
});

test('extraire dans un parent non vierge ne pose pas le message de fin sur tout le parent', async () => {
  const c = mount(parentWithZips(['zip-1']));
  try {
    const before = c.store.project;
    await c.session.handleUnpackZip('zip-1');
    c.render();
    assert.deepEqual(c.errors, []);
    const after = c.store.project;
    assert.equal(after.nightModeAudio, before.nightModeAudio, 'aucun message de fin global ajouté au parent');
    assert.deepEqual(after.globalOptions, before.globalOptions);
    assert.deepEqual(after.rootEntries.find((e) => e.id === 'C'), before.rootEntries.find((e) => e.id === 'C'));
    assert.ok(allIds(after.rootEntries).includes('story-1'), 'le pack est bien extrait');
  } finally {
    c.restore();
  }
});

test('la promotion d’un projet vierge garde le message de fin du pack', async () => {
  const c = mount(normalizeProjectData({
    projectType: 'pack',
    projectName: '',
    rootEntries: [{ id: 'zip-1', type: 'zip', name: 'Inclus', zipPath: 'C:/medias/inclus.zip' }],
  }));
  try {
    await c.session.handleUnpackZip('zip-1');
    c.render();
    assert.deepEqual(c.errors, []);
    assert.equal(c.store.project.nightModeAudio?.replace(/\\/g, '/'), 'C:/ws/zips-extraits/Inclus/fin.wav');
  } finally {
    c.restore();
  }
});

function findIn(entries, predicate) {
  for (const entry of entries ?? []) {
    if (predicate(entry)) return entry;
    const nested = findIn(entry.children, predicate);
    if (nested) return nested;
  }
  return null;
}

test('deux extractions du même pack, identifiants uniques et cibles internes conservées', async () => {
  const c = mount(parentWithZips(['zip-1', 'zip-2']));
  try {
    await c.session.handleUnpackZip('zip-1');
    c.render();
    await c.session.handleUnpackZip('zip-2');
    c.render();
    assert.deepEqual(c.errors, []);
    const project = c.store.project;
    const ids = allIds(project.rootEntries);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicated, [], 'aucun identifiant en double');
    assert.deepEqual(project.rootEntries.find((e) => e.id === 'C'), c.parent.rootEntries.find((e) => e.id === 'C'), 'le parent est intact');

    const copies = project.rootEntries.filter((e) => e.type === 'menu');
    assert.equal(copies.length, 2);
    for (const menu of copies) {
      const un = findIn(menu.children, (e) => e.name === 'Un');
      const deux = findIn(menu.children, (e) => e.name === 'Deux');
      const ref = findIn(menu.children, (e) => e.type === 'ref');
      assert.equal(un.returnAfterPlay, `story:${deux.id}`, 'la fin de « Un » vise « Deux » de la même copie');
      assert.equal(deux.returnOnHome, `menu:${menu.id}`, 'l’Accueil de « Deux » vise son propre menu');
      assert.equal(ref.target, `story:${un.id}`, 'le ref vise « Un » de la même copie');
    }

    // Une modification ne touche qu'une copie.
    const [first, second] = copies;
    const firstUn = findIn(first.children, (e) => e.name === 'Un');
    c.store.updateItem(firstUn.id, { name: 'Un modifié' });
    c.render();
    const after = c.store.project.rootEntries.filter((e) => e.type === 'menu');
    assert.ok(findIn(after[0].children, (e) => e.name === 'Un modifié'));
    assert.ok(findIn(after[1].children, (e) => e.name === 'Un'), 'la seconde copie est inchangée');
    assert.equal(second.id !== first.id, true);
  } finally {
    c.restore();
  }
});
