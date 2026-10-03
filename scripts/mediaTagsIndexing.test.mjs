// Les étiquettes de médias ne s'indexent que par `store/mediaTags.js`.
//
// Un chemin n'a pas une forme unique dans le projet : les champs médias racines
// passent par `normalizeWindowsPath` et portent des antislashs derrière une
// lettre de lecteur, tandis qu'un chemin relatif résolu porte des `/`. Sous
// Linux les deux coïncident, ce qui rend le défaut invisible ; sous Windows, un
// `mediaTags[chemin]` direct perd les étiquettes du média de couverture.
//
// La correction ne tient que si l'accès direct ne revient pas. C'est ce que ce
// fichier vérifie, sur la source elle-même : le test de trajet disque, lui, vit
// dans `projectDiskPersistence.test.mjs` et prouve que l'étiquette suit son
// média après un aller-retour réel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = nodePath.resolve(fileURLToPath(new URL('../src', import.meta.url)));

// Le seul module autorisé à indexer la carte : c'est lui qui compare par
// `pathKey`, et tout le reste passe par ses fonctions.
const OWNER = 'store/mediaTags.js';

const repoPath = (file) => nodePath.relative(SOURCE_ROOT, file).split(nodePath.sep).join('/');

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function codeWithoutComments(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// `mediaTags[x]`, `mediaTags?.[x]`, et les mêmes sur `nextMediaTags`,
// `mediaTagsOverride` ou tout identifiant qui finit par `mediaTags`.
const DIRECT_INDEXING = /\b\w*[mM]ediaTags\s*\??\.?\s*\[/;

test('les étiquettes de médias ne sont jamais indexées par un chemin brut', async () => {
  const offenders = [];
  for (const file of await sourceFiles(SOURCE_ROOT)) {
    const name = repoPath(file);
    if (name === OWNER) continue;
    const contents = codeWithoutComments(await fs.readFile(file, 'utf8'));
    for (const [index, line] of contents.split('\n').entries()) {
      if (DIRECT_INDEXING.test(line)) offenders.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'passer par mediaTagsFor, createMediaTagLookup ou mediaTagKeyFor : '
      + `un accès direct perd les étiquettes sous Windows. Trouvé dans ${offenders.join(', ')}`,
  );
});

test('le module propriétaire expose lecture, écriture et lecteur préparé', async () => {
  const module = await import('../src/store/mediaTags.js');
  for (const name of [
    'mediaTagsFor', 'createMediaTagLookup', 'selectionTagStates', 'withMediaTag', 'withoutMediaTag',
  ]) {
    assert.equal(typeof module[name], 'function', `${name} doit rester exporté`);
  }

  // Les deux formes d'un même chemin Windows désignent la même entrée, et une
  // carte qui porterait déjà les deux ne perd aucune étiquette.
  const tags = { 'C:/Medias/intro.mp3': ['pref'], 'C:\\Medias\\intro.mp3': ['autre'] };
  const lookup = module.createMediaTagLookup(tags);
  assert.deepEqual(lookup('C:/Medias/intro.mp3'), ['pref', 'autre']);
  assert.deepEqual(lookup('C:\\MEDIAS\\INTRO.MP3'), ['pref', 'autre'],
    'la casse ne sépare pas deux chemins Windows');
  assert.deepEqual(module.mediaTagsFor(tags, 'C:/Autre/x.mp3'), [],
    'un média sans étiquette rend un tableau vide, jamais undefined');
});

// ── Une carte héritée portant deux alias du même fichier ─────────────────────
//
// La correction Windows réglait la lecture d'une clé unique écrite avec l'autre
// séparateur. Elle laissait un cas entier : une carte qui porte **déjà** les
// deux formes, chacune avec ses étiquettes. La liste rendait l'union, le panneau
// la première entrée seule, et un retrait ne vidait que celle-là.

const LEGACY = Object.freeze({
  'C:/Medias/intro.mp3': ['premier'],
  'C:\\Medias\\intro.mp3': ['second'],
});

test('la liste, le panneau et la lecture directe voient les mêmes étiquettes', async () => {
  const { createMediaTagLookup, mediaTagsFor, selectionTagStates } = await import('../src/store/mediaTags.js');

  const fromList = createMediaTagLookup(LEGACY)('C:/Medias/intro.mp3');
  const fromRead = mediaTagsFor(LEGACY, 'C:/Medias/intro.mp3');
  assert.deepEqual(fromRead, fromList, 'la vignette et la lecture directe ne se contredisent pas');
  assert.deepEqual(fromRead, ['premier', 'second']);

  // Le panneau est la troisième surface : il décidait sur la première entrée
  // seule, et cochait donc « premier » sans voir « second ».
  const states = selectionTagStates(LEGACY, ['C:\\Medias\\intro.mp3'], ['premier', 'second', 'absent']);
  assert.deepEqual(states.map((state) => [state.tag, state.active]), [
    ['premier', true],
    ['second', true],
    ['absent', false],
  ]);
});

test('un retrait vide tous les alias, et une pose ne recrée pas la seconde clé', async () => {
  const { mediaTagsFor, withMediaTag, withoutMediaTag } = await import('../src/store/mediaTags.js');

  // Retrait par la première clé : l'étiquette de l'autre alias ne survit pas.
  const removed = withoutMediaTag(LEGACY, 'C:/Medias/intro.mp3', 'second');
  assert.deepEqual(mediaTagsFor(removed, 'C:\\Medias\\intro.mp3'), ['premier']);
  assert.deepEqual(Object.keys(removed), ['C:/Medias/intro.mp3'],
    'les alias sont regroupés sur la clé déjà connue');

  // Retirer la dernière étiquette retire le média de la carte, sans laisser
  // l'autre alias derrière.
  const emptied = withoutMediaTag(removed, 'C:\\Medias\\intro.mp3', 'premier');
  assert.deepEqual(Object.keys(emptied), []);

  // Pose : la clé existante est réemployée, et rien n'est perdu au regroupement.
  const added = withMediaTag(LEGACY, 'C:\\MEDIAS\\INTRO.MP3', 'troisième');
  assert.deepEqual(Object.keys(added), ['C:/Medias/intro.mp3']);
  assert.deepEqual(mediaTagsFor(added, 'C:/Medias/intro.mp3'), ['premier', 'second', 'troisième']);

  // Une écriture sans effet rend la carte **identique**, pour que React n'y
  // voie pas une modification.
  const stable = { 'C:/Medias/intro.mp3': ['premier'] };
  assert.equal(withMediaTag(stable, 'C:\\Medias\\intro.mp3', 'premier'), stable);
  assert.equal(withoutMediaTag(stable, 'C:/Medias/intro.mp3', 'inconnue'), stable);
});

test('deux chemins POSIX que la casse sépare restent deux fichiers', async () => {
  const { mediaTagsFor, withoutMediaTag } = await import('../src/store/mediaTags.js');
  const posix = { '/medias/Intro.mp3': ['haut'], '/medias/intro.mp3': ['bas'] };
  assert.deepEqual(mediaTagsFor(posix, '/medias/Intro.mp3'), ['haut']);
  assert.deepEqual(
    withoutMediaTag(posix, '/medias/Intro.mp3', 'haut'),
    { '/medias/intro.mp3': ['bas'] },
    'retirer l’un ne touche pas l’autre',
  );
});
