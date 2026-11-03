// Médias déclarés par un fichier projet (simulation depuis le catalogue) : le
// moteur relit lui-même le fichier et ne sert, hors du dossier du projet et des
// espaces de travail, que les fichiers qu'il nomme. Cette fixture partagée fixe
// ce que le chargeur de projets de l'interface parcourt et résout ; le test
// Rust `declared_references_match_the_interface_loader` vérifie la même.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { walkProjectMediaReferences } from '../src/store/projectModel.js';
import { fromProjectRelativeMediaPath } from '../src/store/projectMediaPaths.js';
import fixture from './fixtures/catalogue/declared-media.json' with { type: 'json' };

// Chemin POSIX sans `.` ni `..`, comme la comparaison du moteur.
function lexical(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function readCase(entry) {
  if (!entry.file) return entry.project;
  return JSON.parse(readFileSync(new URL(`../${entry.file}`, import.meta.url), 'utf8'));
}

for (const entry of fixture.cases) {
  test(`références déclarées : ${entry.name}`, () => {
    const found = new Set();
    for (const ref of walkProjectMediaReferences(readCase(entry))) {
      if (typeof ref.path !== 'string' || !ref.path.trim()) continue;
      found.add(lexical(fromProjectRelativeMediaPath(ref.path, fixture.projectFolder)));
    }
    assert.deepEqual([...found].sort(), [...new Set(entry.expected)].sort());
  });
}

test('les ajouts du moteur ne recouvrent pas les références du chargeur', () => {
  for (const entry of fixture.cases) {
    for (const path of entry.rustOnly) assert.equal(entry.expected.includes(path), false, `${entry.name} : ${path}`);
  }
});
