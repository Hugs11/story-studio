// Normalisation des fiches du catalogue (valeurs de référence, âge, formats,
// exemplaires, disponibilité).

import test from 'node:test';
import assert from 'node:assert/strict';
import page from './fixtures/catalogue/entries-page.json' with { type: 'json' };
import { FORMAT_ORDER, normalizeAge, normalizeEntry, normalizeEntries } from '../src/store/catalogue/entryModel.js';
import { card } from './catalogueFixtures.mjs';

test('la fixture de contrat se normalise sans perte des valeurs de référence', () => {
  const [lune, ours] = normalizeEntries(page.items);
  assert.equal(lune.title, 'La Lune et le Hérisson');
  assert.equal(lune.description, 'Une œuvre douce pour s\'endormir');
  assert.equal(lune.author, 'Camille');
  assert.equal(lune.language, null);
  assert.equal(lune.durationSeconds, null);
  assert.equal(lune.favorite, true);
  assert.equal(lune.addedAt, 1_760_000_000_000, 'secondes converties en millisecondes');
  assert.deepEqual(lune.age, { min: 3, max: null, kind: 'partial', reason: null, origin: 'file', conflict: false });
  assert.equal(ours.age.origin, 'name');
  assert.equal(ours.referenceUnavailable, true);
});

test('formats dans l’ordre fixe et exemplaires du plus récent au plus ancien', () => {
  const [lune, ours] = normalizeEntries(page.items);
  assert.deepEqual(lune.formats, ['project', 'zip']);
  assert.deepEqual(lune.exemplars.map((e) => e.id), ['ex-lune-project', 'ex-lune-zip-new', 'ex-lune-zip-old']);
  assert.deepEqual(lune.exemplarsByFormat.map((group) => [group.format, group.exemplars.length]), [['project', 1], ['zip', 2]]);
  assert.deepEqual(ours.formats, ['zip', 'folder']);
  const child = ours.exemplars.find((e) => e.id === 'ex-ours-child');
  assert.equal(child.containerPath, '/packs/A/compilation.zip');
  assert.equal(child.fileName, '5+ours', 'nom du pack dans l’archive');
  assert.equal(child.available, false);
  assert.equal(child.sizeBytes, null);
  assert.deepEqual(FORMAT_ORDER, ['project', 'zip', 'sevenZip', 'folder']);
});

test('ordre complet : Projet, ZIP, 7z, Dossier ; même date départagée par le chemin', () => {
  const entry = card({ exemplars: [
    { format: 'fs', path: '/z/FS', modifiedAt: 9 },
    { format: 'sevenZip', path: '/a.7z', modifiedAt: 9 },
    { format: 'zip', path: '/b.zip', modifiedAt: 5 },
    { format: 'zip', path: '/a.zip', modifiedAt: 5 },
    { format: 'project', path: '/p.mbah', modifiedAt: 1 },
    { format: 'folder', path: '/dir', modifiedAt: 10 },
  ] });
  assert.deepEqual(entry.formats, ['project', 'zip', 'sevenZip', 'folder']);
  assert.deepEqual(entry.exemplars.map((e) => e.path), ['/p.mbah', '/a.zip', '/b.zip', '/a.7z', '/dir', '/z/FS']);
});

test('fiche indisponible : aucun exemplaire disponible ; exemplaires retirés non présentés', () => {
  const unavailable = card({ exemplars: [{ available: false }, { available: false, state: 'missing' }] });
  assert.equal(unavailable.available, false);
  const mixed = card({ exemplars: [{ available: false }, { available: true }] });
  assert.equal(mixed.available, true);
  const retired = card({ exemplars: [{ retired: true }, { id: 'kept' }] });
  assert.deepEqual(retired.exemplars.map((e) => e.id), ['kept']);
});

test('âge : inconnu, partiel, tranche, invalide et conflit de préfixes', () => {
  assert.equal(normalizeAge({}).kind, 'unknown');
  assert.deepEqual(normalizeAge({ ageMin: 3 }), { min: 3, max: null, kind: 'partial', reason: null, origin: 'file', conflict: false });
  assert.equal(normalizeAge({ ageMax: 8 }).kind, 'partial');
  assert.equal(normalizeAge({ ageMin: 3, ageMax: 6 }).kind, 'range');
  assert.deepEqual(normalizeAge({ ageMin: 7, ageMax: 3 }), { min: 7, max: 3, kind: 'invalid', reason: 'minAboveMax', origin: 'file', conflict: false });
  assert.equal(normalizeAge({ ageMin: 40 }).reason, 'outOfRange');
  const conflict = card({ ageConflict: true });
  assert.equal(conflict.age.kind, 'invalid');
  assert.equal(conflict.age.reason, 'nameConflict');
  assert.equal(conflict.age.conflict, true);
  const fromName = card({ ageMin: 5, ageFromName: 5 });
  assert.equal(fromName.age.origin, 'name');
});

test('types de projet et UUID fiables extraits des observations', () => {
  const entry = card({ exemplars: [
    { format: 'project', projectType: 'simple' },
    { format: 'project', authoringMode: 'advanced', projectType: 'advanced', uuid: 'aaaa' },
    { format: 'zip', uuid: 'aaaa' },
  ] });
  assert.deepEqual(entry.projectTypes, ['simple', 'graph']);
  assert.deepEqual(entry.uuids, ['aaaa']);
});

test('un ZIP appareil garde la famille ZIP et les capacités d’un dossier appareil', async () => {
  const { formatFamily } = await import('../src/store/catalogue/entryModel.js');
  assert.equal(formatFamily('fsZip'), 'zip');
  const exemplar = { id: 'device', technicalFormat: 'fsZip', format: 'zip', state: 'available' };
  const { trashAvailability } = await import('../src/store/catalogue/trashPlan.js');
  const { checkerAvailability } = await import('../src/store/catalogue/duplicateModel.js');
  for (const availability of [trashAvailability, checkerAvailability]) {
    assert.deepEqual(availability(exemplar), availability({ ...exemplar, technicalFormat: 'fsDirectory' }));
  }

});

test('offline reason is explicit and one available exemplar keeps the card online', () => {
  const missing = { id: 'offline', offlineReason: 'missing', exemplars: [{ id: 'a', format: 'zip', state: 'missing', availability: 'unavailable' }] };
  assert.equal(normalizeEntry(missing).offlineReason, 'missing');
  assert.equal(normalizeEntry({ ...missing, offlineReason: 'unavailable' }).offlineReason, 'unavailable');
  const online = normalizeEntry({ ...missing, exemplars: [...missing.exemplars, { id: 'b', format: '7z', state: 'available', availability: 'available' }] });
  assert.equal(online.available, true);
  assert.equal(online.offlineReason, null);
});

test('LIGNES preserves per-file listening figures independently of fiche values', () => {
  const raw = structuredClone(page.items[0]);
  raw.exemplars[0].observation = { fields: {
    '/packMetadata/storyCount': { validity: 'valid', rawValue: 45 },
    '/packMetadata/durationSeconds': { validity: 'valid', rawValue: 3900 },
  } };
  raw.exemplars[1].observation = { fields: {
    '/packMetadata/storyCount': { validity: 'invalid', rawValue: 7 },
  } };
  const c = normalizeEntry(raw);
  const first = c.exemplars.find(e => e.id === raw.exemplars[0].id);
  const second = c.exemplars.find(e => e.id === raw.exemplars[1].id);
  assert.equal(first.storyCount, 45); assert.equal(first.durationSeconds, 3900);
  assert.equal(second.storyCount, null); assert.equal(second.durationSeconds, null);
  assert.equal(c.durationSeconds, null);
});


test('producer and bonus use effective fiche values, including explicit absence, independently of exemplars', () => {
  for (const [value, expected] of [['Studio Lune', 'Studio Lune'], ['', null], [null, null], [42, null]]) {
    const entry = normalizeEntry({ id: 'metadata', values: { producer: value, bonus: value }, exemplars: [] });
    assert.equal(entry.producer, expected);
    assert.equal(entry.bonus, expected);
  }
});

// Forme IPC de catalogue_list_entries : locator porte le conteneur et son membre.
test('un membre 7z nommé par son UUID porte le nom du conteneur dans la fiche et la recherche', async () => {
  const { exemplarRow } = await import('../src/store/catalogue/detailsRow.js');
  const { matchCard, searchWords } = await import('../src/store/catalogue/search.js');
  const name = '7+ Émile et Irma, Architectes extraordinaires.7z';
  const member = '9ea2d8eb-617a-44cd-b174-6915bd700d42';
  for (const path of [`/packs/Lunii.Pack11/${name}`, `C:\\packs\\Lunii.Pack11\\${name}`]) {
    const entry = normalizeEntry({ id: 'fiche', exemplars: [{
      id: 'exemplar', format: '7z', locator: { path, member, memberKey: `pack-root:${member}` },
      container: { path }, state: 'available', availability: 'available',
      modifiedAt: 1726854660000, versionDeclared: 1,
    }] });
    const [exemplar] = entry.exemplars;
    assert.equal(exemplar.fileName, name);
    const row = exemplarRow(exemplar);
    assert.deepEqual(row.name, { kind: 'text', value: name });
    assert.equal(exemplar.member, member);
    assert.equal(exemplar.path, path);
    assert.deepEqual(row.member, { kind: 'text', value: member });
    assert.equal(matchCard(entry, searchWords('architectes'))[0].params.name, name);
    assert.equal(matchCard(entry, searchWords(member)), null);
  }
});

test('un pack dossier nommé par son UUID porte le nom de son dossier parent', async () => {
  const { exemplarRow } = await import('../src/store/catalogue/detailsRow.js');
  const uuid = '17f0da97-7db8-4f66-b9c1-a8e6d154a67d';
  for (const [path, parent, grandParent] of [
    [`/packs/Lunii.Pack14/3+ Les histoires de Passe-Partout/${uuid}`, '3+ Les histoires de Passe-Partout', '/packs/Lunii.Pack14'],
    [`C:\\packs\\3+ Passe-Partout\\${uuid}\\`, '3+ Passe-Partout', 'C:\\packs'],
  ]) {
    const [exemplar] = normalizeEntry({ id: 'fiche', exemplars: [{ id: 'e', format: 'fsDirectory', locator: { path }, state: 'available', availability: 'available' }] }).exemplars;
    assert.equal(exemplar.fileName, parent);
    assert.equal(exemplar.path, path, 'le chemin réel reste celui du dossier UUID');
    assert.deepEqual(exemplarRow(exemplar).folder, { kind: 'text', value: grandParent });
  }
  const [named] = normalizeEntry({ id: 'f', exemplars: [{ id: 'e', format: 'fsDirectory', locator: { path: '/packs/Lune' }, state: 'available', availability: 'available' }] }).exemplars;
  assert.equal(named.fileName, 'Lune');
});

test('archive removal evidence survives list normalization for the trash surface', () => {
  const [, ours] = normalizeEntries(page.items);
  const member = ours.exemplars.find(exemplar => exemplar.member);
  assert.deepEqual(member.archiveRemoval, { enabled: false, reason: 'unavailable', packCount: 2 });
});
