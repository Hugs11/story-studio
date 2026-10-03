import assert from 'node:assert/strict';
import test from 'node:test';
import {
  followSystemChange,
  isPristineWork,
  normalizeWorkProject,
  workBaseline,
} from '../src/store/projectWorkState.js';
import { hasUnsavedWork } from '../src/store/projectHelpers.js';
import { reconcileMediaLibraryPaths } from '../src/store/mediaLibrary.js';

const blankPack = normalizeWorkProject({ projectType: 'pack', rootEntries: [] });

test('un projet neuf intact ne demande pas d’enregistrement', () => {
  const baseline = workBaseline(blankPack);
  const pristine = isPristineWork(baseline, blankPack);
  assert.equal(pristine, true);
  assert.equal(hasUnsavedWork({ project: blankPack, pristine }), false);
});

test('sans état de départ, un projet ouvert jamais enregistré reste du travail', () => {
  assert.equal(isPristineWork(null, blankPack), false);
  assert.equal(hasUnsavedWork({ project: blankPack, pristine: false }), true);
});

test('le premier geste de l’auteur rend la question', () => {
  const baseline = workBaseline(blankPack);
  const edited = normalizeWorkProject({ ...blankPack, projectName: 'Toudou' });
  const pristine = isPristineWork(baseline, edited);
  assert.equal(pristine, false);
  assert.equal(hasUnsavedWork({ project: edited, pristine }), true);
});

test('revenir exactement à l’état de départ ne laisse rien à perdre', () => {
  const baseline = workBaseline(blankPack);
  const undone = normalizeWorkProject(JSON.parse(JSON.stringify(blankPack)));
  assert.equal(isPristineWork(baseline, undone), true);
});

test('un média ajouté à la médiathèque ou une étiquette suffit à rendre la question', () => {
  const pristine = isPristineWork(workBaseline(blankPack), blankPack);
  assert.equal(hasUnsavedWork({ project: blankPack, pristine, mediaLibraryPaths: ['C:/sons/a.mp3'] }), true);
  assert.equal(hasUnsavedWork({ project: blankPack, pristine, mediaTags: { 'C:/sons/a.mp3': ['voix'] } }), true);
});

test('un ajustement automatique sur un travail intact le garde intact', () => {
  const baseline = workBaseline(blankPack);
  const arranged = normalizeWorkProject({ ...blankPack, projectName: 'rangé automatiquement' });
  const next = followSystemChange(baseline, blankPack, arranged);
  assert.equal(isPristineWork(next, arranged), true);
});

test('un ajustement automatique après un geste de l’auteur ne l’efface pas', () => {
  const baseline = workBaseline(blankPack);
  const edited = normalizeWorkProject({ ...blankPack, projectName: 'Toudou' });
  const arranged = normalizeWorkProject({ ...edited, projectName: 'Toudou rangé' });
  const next = followSystemChange(baseline, edited, arranged);
  assert.equal(next, baseline);
  assert.equal(isPristineWork(next, arranged), false);
});

test('sans état de départ, un ajustement automatique n’en invente pas', () => {
  assert.equal(followSystemChange(null, blankPack, blankPack), null);
});

test('un projet enregistré reste jugé sur sa dernière sauvegarde', () => {
  const pristine = isPristineWork(workBaseline(blankPack), blankPack);
  assert.equal(hasUnsavedWork({ project: blankPack, pristine, savedSnapshot: 'autre' }), true);
});

// L'effet de `useMediaLibraryPaths` repeuple le catalogue Médias avec les médias
// du pack après l'atterrissage : ce ne sont pas des travaux de l'auteur.
const importedPack = () => normalizeWorkProject({
  projectType: 'pack',
  rootAudio: 'C:/ws/zips-extraits/Pack/titre.mp3',
  rootImage: 'C:/ws/zips-extraits/Pack/titre.png',
  rootEntries: [{ id: 's1', type: 'story', name: 'Première', audio: 'C:/ws/zips-extraits/Pack/un.mp3' }],
});

test('un pack importé intact reste intact malgré le catalogue Médias que le projet alimente', () => {
  const imported = importedPack();
  const pristine = isPristineWork(workBaseline(imported), imported);
  assert.equal(pristine, true);
  const library = reconcileMediaLibraryPaths(imported, []);
  assert.ok(library.length > 0);
  assert.equal(hasUnsavedWork({ project: imported, pristine, mediaLibraryPaths: library }), false);
});

test('un média ajouté au catalogue d’un pack importé intact reste du travail', () => {
  const imported = importedPack();
  const pristine = isPristineWork(workBaseline(imported), imported);
  const library = reconcileMediaLibraryPaths(imported, []);
  assert.equal(hasUnsavedWork({ project: imported, pristine, mediaLibraryPaths: [...library, 'C:/sons/ajoute.mp3'] }), true);
});

test('une vraie modification d’un pack importé demande l’enregistrement', () => {
  const imported = importedPack();
  const baseline = workBaseline(imported);
  const edited = normalizeWorkProject({
    ...imported,
    rootEntries: [{ ...imported.rootEntries[0], name: 'Renommée' }],
  });
  const pristine = isPristineWork(baseline, edited);
  assert.equal(pristine, false);
  const library = reconcileMediaLibraryPaths(edited, []);
  assert.equal(hasUnsavedWork({ project: edited, pristine, mediaLibraryPaths: library }), true);
});
