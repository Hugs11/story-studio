import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocalEndDraftFields,
  createLocalEndDraft,
  getLocalEndDraftApplicability,
  materializeLocalEndDraftFields,
  selectLocalEndDraftAudio,
} from '../src/store/localEndDraft.js';

function story(id, fields = {}) {
  return {
    id,
    type: 'story',
    name: id.toUpperCase(),
    audio: `${id}.mp3`,
    itemAudio: `${id}-title.mp3`,
    controlSettings: {},
    ...fields,
  };
}

function createFixture() {
  const first = story('first');
  const second = story('second');
  const project = {
    projectType: 'pack',
    rootEntries: [first, second],
    nightModeAudio: 'global.mp3',
    nightModeReturn: 'next_story',
    nightModeHomeReturn: null,
    globalOptions: { nightMode: true },
  };
  return { first, second, project };
}

function applicability(draft, fixture) {
  return getLocalEndDraftApplicability({
    draft,
    entry: fixture.first,
    parentMenu: null,
    project: fixture.project,
  });
}

test('le brouillon initial equivalent a la fin globale n est pas applicable', () => {
  const fixture = createFixture();
  const result = applicability(createLocalEndDraft(fixture.project), fixture);

  assert.equal(result.applicable, false);
  assert.equal(result.presentationKind, 'global');
});

test('un audio different rend la fin locale applicable sans importer le fichier', () => {
  const fixture = createFixture();
  const draft = selectLocalEndDraftAudio(createLocalEndDraft(fixture.project), 'source-externe.mp3');

  const result = applicability(draft, fixture);

  assert.equal(result.applicable, true);
  assert.equal(result.presentationKind, 'local_prompt');
  assert.equal(result.fields.afterPlaybackPromptAudio, 'source-externe.mp3');
});

test('le calcul pur et un brouillon non applicable n appellent aucun import de fichier', async () => {
  const fixture = createFixture();
  const draft = selectLocalEndDraftAudio(createLocalEndDraft(fixture.project), 'global.mp3');
  const importedSources = [];
  const importFile = async (source) => {
    importedSources.push(source);
    return 'workspace.mp3';
  };

  const result = applicability(draft, fixture);
  const fields = await materializeLocalEndDraftFields({
    draft,
    entry: fixture.first,
    project: fixture.project,
    importFile,
  });

  assert.equal(result.fields.afterPlaybackPromptAudio, 'global.mp3');
  assert.equal(fields, null);
  assert.deepEqual(importedSources, []);
});

test('une destination OK differente rend la fin locale applicable', () => {
  const fixture = createFixture();
  const draft = { ...createLocalEndDraft(fixture.project), okTarget: 'root' };

  assert.equal(applicability(draft, fixture).applicable, true);
});

test('une destination explicite equivalente a next_story reste globale', () => {
  const fixture = createFixture();
  const draft = { ...createLocalEndDraft(fixture.project), okTarget: 'story:second' };
  const result = applicability(draft, fixture);

  assert.equal(result.applicable, false);
  assert.equal(result.presentationKind, 'global');
});

test('une destination Home differente rend la fin locale applicable', () => {
  const fixture = createFixture();
  const draft = {
    ...createLocalEndDraft(fixture.project),
    homeNone: false,
    homeTarget: 'root',
  };

  assert.equal(applicability(draft, fixture).applicable, true);
});

test('revenir aux valeurs globales rend de nouveau le brouillon non applicable', () => {
  const fixture = createFixture();
  const initial = createLocalEndDraft(fixture.project);
  const modified = { ...initial, okTarget: 'root' };
  const restored = { ...modified, okTarget: initial.okTarget };

  assert.equal(applicability(modified, fixture).applicable, true);
  assert.equal(applicability(restored, fixture).applicable, false);
});

test('le calcul d applicabilite ne mute ni le projet ni le brouillon', () => {
  const fixture = createFixture();
  const draft = selectLocalEndDraftAudio(createLocalEndDraft(fixture.project), 'choisi.mp3');
  const snapshot = structuredClone(fixture.project);
  const draftSnapshot = structuredClone(draft);

  applicability(draft, fixture);

  assert.deepEqual(fixture.project, snapshot);
  assert.deepEqual(draft, draftSnapshot);
  assert.deepEqual(buildLocalEndDraftFields(draft, draft.audio), {
    afterPlaybackPromptAudio: 'choisi.mp3',
    afterPlaybackPromptOkTarget: 'next_story',
    afterPlaybackPromptHomeTarget: null,
    afterPlaybackPromptHomeNone: true,
    afterPlaybackSequence: [],
    afterPlaybackHomeStep: null,
  });
});
