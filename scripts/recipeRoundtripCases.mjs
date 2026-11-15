// Recipe roundtrip matrix (1440 DTO), adapted from the measured lot A bench.
// Run by src-tauri/src/native_pack/tests/recipe.rs; writes src-tauri/target/recipe/cases.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProjectData, projectToRustExport } from '../src/store/projectModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '../src-tauri/target/recipe');

const media = (name) => `C:/h10b/${name}`;

function story(id) {
  return {
    id, type: 'story', name: id, treeColor: '#2a6f97',
    audio: media(`${id}.mp3`), itemAudio: media(`${id}-t.mp3`), itemImage: media(`${id}.png`),
  };
}
function menu(id, children) {
  return { id, type: 'menu', name: id, treeColor: '#c8553d', audio: media(`${id}.mp3`), image: media(`${id}.png`), children };
}

const STRUCTURES = {
  root3: () => [story('a'), story('b'), story('c')],
  folder: () => [menu('m', [story('a'), story('b'), story('c')]), story('z')],
  nested: () => [menu('m', [menu('n', [story('a'), story('b')]), story('c')])],
  single: () => [menu('m', [story('a')])],
  rootsingle: () => [story('a')],
  // « Histoire seule » : une seule histoire, pas d'arbre.
  simple: () => [story('a')],
  // Dossiers portant une « Destination de fin d'histoire » (sélection multiple de dossiers).
  folderNext: () => [{ ...menu('m', [story('a'), story('b'), story('c')]), returnAfterPlay: 'next_story' }, story('z')],
  folderRoot: () => [{ ...menu('m', [story('a'), story('b')]), returnAfterPlay: 'root' }, menu('n', [story('c')])],
};

const GLOBALS = {
  g0: {},
  gEnd: { nightModeAudio: media('fin.mp3'), globalOptions: { endNode: true, endMessageAutoplay: false } },
  gEndAuto: { nightModeAudio: media('fin.mp3'), globalOptions: { endNode: true, endMessageAutoplay: true } },
  gNight: { nightModeAudio: media('fin.mp3'), globalOptions: { endNode: true, nightMode: true, endMessageAutoplay: false } },
  gNext: { nightModeAudio: media('fin.mp3'), nightModeReturn: 'next_story', globalOptions: { endNode: true, endMessageAutoplay: true } },
  gRoot: { nightModeAudio: media('fin.mp3'), nightModeReturn: 'root', globalOptions: { endNode: true, endMessageAutoplay: true } },
  gStoryB: { nightModeAudio: media('fin.mp3'), nightModeReturn: 'story:FIRST', globalOptions: { endNode: true, endMessageAutoplay: true } },
  gHomeNext: { nightModeAudio: media('fin.mp3'), nightModeHomeReturn: 'next_story', nightModeReturn: 'next_story', globalOptions: { endNode: true, nightMode: true, endMessageAutoplay: true } },
  gAutoNextEnd: { nightModeAudio: media('fin.mp3'), globalOptions: { autoNext: true, endNode: true } },
};

const seqStep = (id, fields = {}) => ({
  id, name: id, audio: media(`${id}.mp3`),
  controlSettings: { autoplay: true, ok: true, home: true, pause: false, wheel: false },
  ...fields,
});

const LOCALS = {
  l0: () => ({}),
  lPrompt: (s) => ({ afterPlaybackPromptAudio: media(`${s}-fin.mp3`) }),
  lPromptNext: (s) => ({ afterPlaybackPromptAudio: media(`${s}-fin.mp3`), afterPlaybackPromptOkTarget: 'next_story', afterPlaybackPromptHomeNone: true }),
  // « Rattacher au message global » (attachStoryEndToGlobalProject).
  lAttach: (s, global) => (global?.nightModeAudio ? {
    afterPlaybackPromptAudio: global.nightModeAudio,
    afterPlaybackPromptOkTarget: global.nightModeReturn ?? null,
    afterPlaybackPromptHomeTarget: global.nightModeHomeReturn ?? null,
    afterPlaybackPromptHomeNone: !global.nightModeHomeReturn,
  } : {}),
  lSeq2: (s) => ({
    afterPlaybackSequence: [seqStep(`${s}-e1`), seqStep(`${s}-e2`, { okTarget: 'next_story' })],
    afterPlaybackHomeStep: seqStep(`${s}-h`),
  }),
};

const CONTROLS = {
  c0: {},
  cStay: { controlSettings: { ok: true, autoplay: false } },
  cChainNext: { controlSettings: { ok: false, autoplay: true }, returnAfterPlay: 'next_story' },
  cHomeRoot: { returnOnHome: 'root' },
};

function mapStories(entries, fn) {
  return entries.map((entry) => (entry.type === 'menu'
    ? { ...entry, children: mapStories(entry.children, fn) }
    : fn(entry)));
}
function collectStories(entries, parent = null, out = []) {
  for (const entry of entries) {
    if (entry.type === 'menu') collectStories(entry.children, entry, out);
    else if (entry.type === 'story') out.push({ entry, parent });
  }
  return out;
}

function replaceTargets(value, id, ids) {
  const first = ids[0];
  const other = ids.find((candidate) => candidate !== id) ?? id;
  return JSON.parse(JSON.stringify(value)
    .replaceAll('story:FIRST', `story:${id === first ? other : first}`));
}

const cases = [];
for (const [sName, makeEntries] of Object.entries(STRUCTURES)) {
  for (const [gName, global] of Object.entries(GLOBALS)) {
    for (const [lName, local] of Object.entries(LOCALS)) {
      for (const [cName, controls] of Object.entries(CONTROLS)) {
        const base = makeEntries();
        const ids = collectStories(base).map(({ entry }) => entry.id);
        const rootEntries = mapStories(base, (entry) => replaceTargets(
          { ...entry, ...controls, ...local(entry.id, global) }, entry.id, ids,
        ));
        const raw = {
          projectType: sName === 'simple' ? 'simple' : 'pack',
          projectName: 'H10b',
          rootName: 'Racine auteur',
          endNodeName: 'Fin auteur',
          treeColor: '#7a4fa0',
          packMetadata: { title: 'H10b', uuid: '11111111-2222-4333-8444-555566667777' },
          rootAudio: media('root.mp3'),
          rootImage: media('root.png'),
          rootEntries,
          ...replaceTargets({ ...global, globalOptions: undefined }, '', ids),
          globalOptions: { ...(global.globalOptions ?? {}) },
        };
        const project = normalizeProjectData(raw);
        cases.push({
          name: `${sName}/${gName}/${lName}/${cName}`,
          dto: projectToRustExport(project, { leading: 0, trailing: 0 }),
        });
      }
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'cases.json'), JSON.stringify(cases));

// M-2: inputs available in the simplified editor, without title media,
// authored controls, local endings or auto-next. Apply the actual UI defaults.
const simpleCases = [];
for (const end of [false, true]) {
  for (const nightMode of [false, true]) {
    // The UI validation requires an end sound when night mode is enabled.
    if (nightMode && !end) continue;
    for (const endMessageAutoplay of [false, true]) {
      const project = normalizeProjectData({
        projectType: 'simple', projectName: 'Realistic simple',
        packMetadata: { title: 'Realistic simple', uuid: '11111111-2222-4333-8444-555566667777' },
        rootAudio: media('root.mp3'), rootImage: media('root.png'),
        nightModeAudio: end ? media('end.mp3') : null,
        globalOptions: { endNode: end, nightMode, endMessageAutoplay },
        rootEntries: [{ id: 's', type: 'story', name: 'Histoire seule', audio: media('story.mp3') }],
      });
      simpleCases.push(projectToRustExport(project, { leading: 0, trailing: 0 }));
    }
  }
}
fs.writeFileSync(path.join(outDir, 'simple-cases.json'), JSON.stringify(simpleCases));
