import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSteps, canVisitAggregateStep, landAggregate, prepareAggregateLanding } from '../src/components/AggregatePacks/aggregateLanding.js';
import { defaultMetadataForPacks } from '../src/components/AggregatePacks/aggregateProject.js';
import { assemblyPacks } from '../src/store/catalogue/assemblySelection.js';
import preparation from './fixtures/catalogue/assembly-preparation.json' with { type: 'json' };

test('fixed steps follow Packs → Audio → Image → Metadata', () => {
  assert.deepEqual(aggregateSteps().map(step => step.key), ['packs', 'audio', 'image', 'metadata']);
  const draft = { packs: [{ path: '/pack.zip' }] };
  assert.equal(canVisitAggregateStep({ ...draft, index: 1 }), true);
  assert.equal(canVisitAggregateStep({ ...draft, index: 2 }), false);
  assert.equal(canVisitAggregateStep({ ...draft, index: 2, rootAudio: '/menu.mp3' }), true);
  assert.equal(canVisitAggregateStep({ ...draft, index: 3, rootAudio: '/menu.mp3' }), false);
  assert.equal(canVisitAggregateStep({ ...draft, index: 3, rootAudio: '/menu.mp3', rootImage: '/menu.png' }), true);
  assert.equal(canVisitAggregateStep({ ...draft, index: 1, packs: [] }), false);
});

for (const origin of ['home', 'catalogue']) {
  test(`${origin}: editor lands from Packs with no root audio or image`, async () => {
    const packs = origin === 'catalogue' ? assemblyPacks(preparation) : [{ name: 'Premier', path: '/first.zip' }, { name: 'Second', path: '/second.zip' }];
    packs[0] = { ...packs[0], name: 'Renommé' };
    const draft = { packs, metadata: defaultMetadataForPacks(packs, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') };
    assert.equal(canVisitAggregateStep({ ...draft, index: 1 }), true);
    assert.equal(canVisitAggregateStep({ ...draft, index: 2 }), false);
    const copied = [];
    let installed;
    assert.equal(await landAggregate({
      confirmBackgroundWork: async () => true,
      confirmSave: async () => true,
      runLanding: async (_, prepare) => prepare('/session'),
      prepare: workspaceDir => prepareAggregateLanding({
        draft, workspaceDir,
        preparation: origin === 'catalogue' ? preparation : null,
        transfer: async () => ({ preparationId: preparation.preparationId, ownerSessionId: workspaceDir, transferred: true,
          assets: preparation.entries.flatMap(entry => [entry.zipPath, entry.coverPath].filter(Boolean).map(sourcePath => ({ sourcePath, sessionPath: `/session/${sourcePath.split('/').at(-1)}` }))),
        }),
        copy: async path => { copied.push(path); return `/session/${path.split('/').at(-1)}`; },
      }),
      install: project => { installed = project; },
    }), true);
    assert.equal(installed.rootAudio, null);
    assert.equal(installed.rootImage, null);
    assert.equal(installed.thumbnailImage, null);
    assert.equal(installed.rootEntries.length, packs.length);
    assert.equal(installed.rootEntries[0].name, 'Renommé');
    assert.ok(copied.every(Boolean), 'absent media never reaches the copier');
  });
}
