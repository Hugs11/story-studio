import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { normalizeProjectData, deepCloneEntry, findEntryById } = await import('../src/store/projectModel.js');

function chainedProject() {
  return normalizeProjectData({
    projectType: 'pack',
    projectName: 'Tomes',
    packMetadata: { uuid: '77777777-7777-4777-8777-777777777777' },
    rootEntries: [{
      id: 'tome', type: 'menu', name: 'Tome 1',
      children: [
        {
          id: 'chap1', type: 'story', name: 'Chapitre 1', audio: 'C:/sons/chap1.mp3',
          // « Après la lecture : Chapitre 2 », Accueil : retour au dossier.
          returnAfterPlay: 'story:chap2', returnOnHome: 'menu:tome',
        },
        {
          id: 'chap2', type: 'story', name: 'Chapitre 2', audio: 'C:/sons/chap2.mp3',
          returnAfterPlay: 'menu:tome',
          afterPlaybackSequence: [{ id: 'etape', name: 'Encore ?', okTarget: 'story_play:chap1', okChoiceTargets: ['story:chap1', 'story:chap2'] }],
        },
      ],
    }, { id: 'ailleurs', type: 'story', name: 'Bonus', audio: 'C:/sons/bonus.mp3' }],
  });
}

function loaded() {
  const storeRunner = runner(() => useProjectStore());
  let store = storeRunner.render();
  store.loadProject(chainedProject());
  store = storeRunner.render();
  return { storeRunner, store };
}

function assertCopyIsSelfContained(project, copy) {
  assert.notEqual(copy.id, 'tome');
  const [copy1, copy2] = copy.children;
  assert.notEqual(copy1.id, 'chap1');
  assert.notEqual(copy2.id, 'chap2');
  assert.equal(copy1.returnAfterPlay, `story:${copy2.id}`, 'la copie du chapitre 1 enchaîne sur la copie du chapitre 2');
  assert.equal(copy1.returnOnHome, `menu:${copy.id}`, 'Accueil revient au dossier copié');
  assert.equal(copy2.returnAfterPlay, `menu:${copy.id}`, 'la fin revient au dossier copié');
  assert.equal(copy2.afterPlaybackSequence[0].okTarget, `story_play:${copy1.id}`);
  assert.deepEqual(copy2.afterPlaybackSequence[0].okChoiceTargets, [`story:${copy1.id}`, `story:${copy2.id}`]);
  // L'original n'a pas bougé.
  assert.equal(findEntryById(project, 'chap1').returnAfterPlay, 'story:chap2');
}

test('dupliquer un dossier garde ses renvois internes dans la copie', () => {
  const { storeRunner, store } = loaded();
  const outcome = store.duplicateEntry('tome');
  assert.equal(outcome.allowed, true);
  const project = storeRunner.render().project;
  assert.equal(project.rootEntries.length, 3);
  assertCopyIsSelfContained(project, project.rootEntries[1]);
});

test('copier-coller un dossier garde ses renvois internes dans la copie', () => {
  const { storeRunner, store } = loaded();
  // Séquence exacte de `useTreeClipboard` : clone à la copie, clone au collage.
  const clipboard = [deepCloneEntry(findEntryById(store.project, 'tome'))];
  const outcome = store.pasteEntriesToMenu(null, clipboard.map((entry) => deepCloneEntry(entry)));
  assert.equal(outcome.allowed, true);
  const project = storeRunner.render().project;
  assertCopyIsSelfContained(project, project.rootEntries.at(-1));
});

test('témoin — un renvoi vers l’extérieur de la copie reste tel quel', () => {
  const storeRunner = runner(() => useProjectStore());
  let store = storeRunner.render();
  const base = chainedProject();
  base.rootEntries[0].children[0].returnAfterPlay = 'story:ailleurs';
  store.loadProject(normalizeProjectData(base));
  store = storeRunner.render();
  store.duplicateEntry('tome');
  const project = storeRunner.render().project;
  assert.equal(project.rootEntries[1].children[0].returnAfterPlay, 'story:ailleurs');
});

test('le clonage remappe aussi titres, invites et étapes Accueil sans modifier la source', () => {
  const original = {
    id: 'dossier', type: 'menu', returnOnHome: 'menu:dossier', children: [{
      id: 'histoire', type: 'story', titleReturnOnHome: 'menu:dossier',
      afterPlaybackPromptOkTarget: 'story_play:histoire',
      afterPlaybackPromptHomeTarget: 'story_home_step:histoire',
      afterPlaybackSequence: [{ id: 'step', homeTarget: 'menu:dossier', okTarget: 'story:externe' }],
      afterPlaybackHomeStep: {
        id: 'home', okTarget: 'story_play:histoire', homeTarget: 'menu:dossier',
        okChoiceTargets: ['story:histoire', 'story:externe'],
      },
    }],
  };
  const before = structuredClone(original);
  const copy = deepCloneEntry(original);
  const story = copy.children[0];
  assert.equal(copy.returnOnHome, `menu:${copy.id}`);
  assert.equal(story.titleReturnOnHome, `menu:${copy.id}`);
  assert.equal(story.afterPlaybackPromptOkTarget, `story_play:${story.id}`);
  assert.equal(story.afterPlaybackPromptHomeTarget, `story_home_step:${story.id}`);
  assert.equal(story.afterPlaybackSequence[0].homeTarget, `menu:${copy.id}`);
  assert.equal(story.afterPlaybackSequence[0].okTarget, 'story:externe');
  assert.equal(story.afterPlaybackHomeStep.okTarget, `story_play:${story.id}`);
  assert.equal(story.afterPlaybackHomeStep.homeTarget, `menu:${copy.id}`);
  assert.deepEqual(story.afterPlaybackHomeStep.okChoiceTargets, [`story:${story.id}`, 'story:externe']);
  assert.deepEqual(original, before);
});
