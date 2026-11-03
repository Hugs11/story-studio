import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCatalogueFixtures } from './catalogue-fixtures.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ss-catalogue-fixtures-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const corpusDir = join(root, 'corpus');
  for (const category of ['exemples', 'synthetiques', 'reels']) {
    mkdirSync(join(corpusDir, category), { recursive: true });
    for (let n = 1; n <= 5; n++) writeFileSync(join(corpusDir, category, `${n}.zip`), 'x'.repeat(n));
  }
  const demoDir = join(root, 'demo');
  mkdirSync(join(demoDir, 'dossier'), { recursive: true });
  for (const name of ['projet.mbah', 'pack.zip', 'pack.7z', 'dossier/story.json']) writeFileSync(join(demoDir, name), '{}');
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  return { corpusDir, demoDir, runDir };
}

test('tirage varié, copies indépendantes et doublon, sans modification des sources', t => {
  const options = fixture(t);
  const result = prepareCatalogueFixtures(options);
  assert.equal(result.archiveCount, 10);
  assert.equal(result.manifest.length, 12);
  const copied = result.manifest[0];
  const duplicate = result.manifest.find(item => item.duplicate);
  assert.equal(readFileSync(copied.copy, 'utf8'), readFileSync(duplicate.copy, 'utf8'));
  writeFileSync(copied.copy, 'modification dans le run');
  assert.equal(readFileSync(copied.source, 'utf8'), 'x');
  assert.equal(readFileSync(duplicate.copy, 'utf8'), 'x');
  assert.equal(readdirSync(join(options.corpusDir, 'exemples')).length, 5);
  assert.equal(readFileSync(join(result.directory, 'demo-quatre-formats/dossier/story.json'), 'utf8'), '{}');
});

test('refuse une démo incomplète et un run à l’intérieur des sources', t => {
  const options = fixture(t);
  assert.throws(() => prepareCatalogueFixtures({ ...options, runDir: join(options.demoDir, 'run') }), /en dehors/);
  rmSync(join(options.demoDir, 'pack.7z'));
  assert.throws(() => prepareCatalogueFixtures(options), /format .7z absent/);
});

test('refuse les liens pour ne jamais indexer indirectement les originaux', t => {
  const options = fixture(t);
  symlinkSync(join(options.corpusDir, 'exemples/1.zip'), join(options.demoDir, 'lien.zip'));
  assert.throws(() => prepareCatalogueFixtures(options), /Lien symbolique refusé/);
});
