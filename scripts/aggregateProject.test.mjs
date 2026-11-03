import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAggregateProject,
  defaultMetadataForPacks,
} from '../src/components/AggregatePacks/aggregateProject.js';
import { projectToRustExport } from '../src/store/projectModel.js';

const IDENTITY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const packs = [
  { name: '3+]Premier', path: '/packs/premier.zip' },
  { name: '6+]Second', path: '/packs/second.zip' },
];

function exported(metadata) {
  return projectToRustExport(buildAggregateProject({
    packs,
    rootAudio: '/session/menu.mp3',
    rootImage: '/session/menu.png',
    metadata,
  }));
}

test('the aggregated pack carries the identity drawn when the assistant opened', () => {
  const metadata = defaultMetadataForPacks([], IDENTITY);
  assert.equal(exported(metadata).packUuid, IDENTITY);
  assert.equal(exported(metadata).packUuid, exported(metadata).packUuid, 'deux générations, un seul pack');
});

test('refreshing the defaults when packs are added keeps the identity', () => {
  const opened = defaultMetadataForPacks([], IDENTITY);
  const refreshed = { ...opened, ...defaultMetadataForPacks(packs, opened.uuid) };
  assert.equal(refreshed.uuid, IDENTITY);
  assert.equal(refreshed.minAge, '6');
  assert.equal(exported(refreshed).packUuid, IDENTITY);
});

test('an identity chosen in the metadata step is the one exported', () => {
  const chosen = '11111111-2222-4333-8444-555566667777';
  const metadata = { ...defaultMetadataForPacks(packs, IDENTITY), uuid: chosen };
  assert.equal(exported(metadata).packUuid, chosen);
});

// The minimum age suggestion follows the strictest known entry.
test('age suggestion preserves zero and leaves unknown ages empty', () => {
  assert.equal(defaultMetadataForPacks([], IDENTITY).minAge, '');
  assert.equal(defaultMetadataForPacks([{ ageMin: 0 }], IDENTITY).minAge, '0');
  assert.equal(defaultMetadataForPacks([{ ageMin: 0 }, { ageMin: 7 }, { ageMin: null }], IDENTITY).minAge, '7');
});
test('effective corrections and intentional clearing supersede filenames', () => {
  assert.equal(defaultMetadataForPacks([{ name: '3+]Titre', ageMin: 9 }], IDENTITY).minAge, '9');
  assert.equal(defaultMetadataForPacks([{ name: '8+]Titre', ageMin: null, ageMax: 12 }], IDENTITY).minAge, '');
  assert.equal(defaultMetadataForPacks([{ name: '8+]Titre', ageMin: '' }], IDENTITY).minAge, '');
  assert.equal(defaultMetadataForPacks([{ ageMin: -1 }, { ageMin: 'bad' }, { ageMax: 10 }], IDENTITY).minAge, '');
});

test('home objects retain age prefixes in fileName after display name normalization', () => {
  assert.equal(defaultMetadataForPacks([{name:'Second',fileName:'6+]Second.zip'}], 'id').minAge, '6');
  assert.equal(defaultMetadataForPacks([{name:'Second',fileName:'6+]Second.zip',ageMin:null}], 'id').minAge, '');
});
