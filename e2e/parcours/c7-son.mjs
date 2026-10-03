import { join } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome, generatePack, clickButton } from '../lib/actions.mjs';
import {
  dropOnTree, dropOnMediaExplorer, assignMediaToGraphStage,
  pickAudioField, pickImageField, editorCard, treeRoot, setPackTitle,
} from '../lib/c2-helpers.mjs';
import { createGraphStage, createGraphAction, repairGraphEndings, selectGraphNode, renameSelectedNode,
  selectNodePickerOption, wireStageOkToSelectedAction } from '../lib/c4-helpers.mjs';
import { readStoryJson } from '../lib/oracles.mjs';
import {
  createAudioSources, ffmpeg, extractArchive, measureAudio, matchAudio, audioChecks,
  LEVEL_TOLERANCE_LU, PEAK_TOLERANCE_DB, EDGE_TOLERANCE_SEC,
} from '../lib/audio-oracles.mjs';

const CASES = [
  { name: 'A', harmonize: true, silence: 'Ajuster' },
  { name: 'B', harmonize: true, silence: 'Ajouter' },
  { name: 'C', harmonize: false, silence: 'Ne rien faire' },
  { name: 'D', harmonize: false, silence: 'Ajuster' },
];

async function options(page, testCase) {
  await page.locator('[data-toolbar-id="pack-options"]').click();
  const drawer = page.locator('.pack-options-popover');
  await drawer.waitFor({ state: 'visible' });
  const toggle = drawer.getByRole('button', { name: 'Harmoniser le volume des audios vers -14 LUFS à la génération.', exact: true });
  if ((await toggle.getAttribute('aria-pressed') === 'true') !== testCase.harmonize) await toggle.click();
  const mode = drawer.locator('button.pack-options-segment').filter({ hasText: new RegExp(`^${testCase.silence}$`) });
  await mode.click();
  const state = {
    harmonize: await toggle.getAttribute('aria-pressed') === 'true',
    silenceSelected: await mode.getAttribute('aria-pressed') === 'true',
    durations: await drawer.locator('.pack-options-silence-duration').innerText(),
  };
  await page.keyboard.press('Escape');
  return state;
}

async function buildMenus(page, sources, image) {
  await newProject(page, 'pack');
  await treeRoot(page).click();
  const root = page.locator('.root-identity-card').first();
  if (!await pickAudioField(page, root, 'Titre audio', sources[0].path)) throw new Error('Titre audio racine absent');
  if (!await pickImageField(page, root, image)) throw new Error('JPEG renommé refusé sur la racine');
  // Deux histoires avec titre et récit portent les quatre sources sans
  // inventer de fichier audio supplémentaire dans l'archive.
  for (let index = 0; index < 2; index += 1) {
    await dropOnTree(page, sources[index * 2 + 1].path);
    const card = editorCard(page, "L'histoire");
    if (!await pickAudioField(page, card, 'Audio de sélection', sources[index * 2].path)) throw new Error('Titre audio histoire absent');
    if (!await pickImageField(page, card, image)) throw new Error('JPEG renommé refusé sur une histoire');
  }
  if (!await setPackTitle(page, 'Sons synthétiques')) throw new Error('Titre pack absent');
}

async function buildGraph(page, events, sources, image) {
  await newProject(page, 'advanced');
  // Les noms explicites évitent de dépendre de la numérotation des nouvelles
  // listes : chaque chaîne entrée → titre → récit est construite par l'UI.
  await selectGraphNode(page, 'Écran 1', 'stage');
  await renameSelectedNode(page, 'Entrée son');
  const names = ['Entrée son', 'Titre son', 'Histoire son', 'Fin son'];
  for (let index = 1; index < 4; index += 1) {
    if (!await createGraphStage(page)) throw new Error('Création Écran impossible');
    await renameSelectedNode(page, names[index]);
  }
  for (let index = 0; index < 4; index += 1) {
    await dropOnMediaExplorer(page, sources[index].path);
    const assigned = await assignMediaToGraphStage(page, events, { fileStem: sources[index].name, stageName: names[index] });
    if (!assigned.via) throw new Error(`Audio non posé : ${JSON.stringify(assigned)}`);
  }
  await dropOnMediaExplorer(page, image);
  const assigned = await assignMediaToGraphStage(page, events, { fileStem: 'jpeg-renomme', stageName: names[0] });
  if (!assigned.via) throw new Error(`Image non posée : ${JSON.stringify(assigned)}`);
  // Même formulaire de raccord que c2-helpers, avec le nom de la nouvelle
  // liste numérotée plutôt qu'un nom fixe pour les trois raccords.
  for (let index = 0; index < 3; index += 1) {
    if (!await createGraphAction(page)) throw new Error('Création liste impossible');
    if (!await selectGraphNode(page, `Liste ${index + 1}`, 'action')) throw new Error('Liste créée introuvable');
    await page.getByRole('button', { name: 'Gestes du choix 1' }).first().click();
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /^Modifier/ }).first().click();
    await selectNodePickerOption(page.locator('#advanced-retarget-target'), names[index + 1]);
    await clickButton(page, /Changer l.Écran/);
    await page.waitForTimeout(400);
    await wireStageOkToSelectedAction(page, names[index]);
  }
  const endings = await repairGraphEndings(page);
  if (endings.remaining) throw new Error(`Diagnostics non résolus : ${JSON.stringify(endings)}`);
  if (!await setPackTitle(page, 'Sons synthétiques')) throw new Error('Titre pack absent');
}

export async function run() {
  const ctx = createRun('c7-son');
  const records = [];
  let app;
  let sources = [];
  let limiterReference = null;
  try {
    sources = createAudioSources(ctx.dir('sources'));
    ctx.check('sources mesurées : niveaux et crête chaude',
      sources.every(source => Math.abs(source.contentLufs - source.target) < 0.4)
      && Math.abs(sources[3].samplePeak) < 0.05, { sources });
    const limiterPath = join(ctx.dir('sources'), 'limiteur-reference.wav');
    ffmpeg(['-i', sources[3].path, '-af', 'alimiter=limit=0.794328:level=disabled', '-c:a', 'pcm_f32le', limiterPath]);
    limiterReference = measureAudio(limiterPath, join(ctx.dir('sources'), 'limiteur-reference'));
    ctx.check('plafond échantillon du limiteur mesuré à -2 dBFS', Math.abs(limiterReference.samplePeak + 2) < 0.05, { limiterReference });
    const jpeg = join(ctx.dir('sources'), 'jpeg-renomme.jpg');
    const image = join(ctx.dir('sources'), 'jpeg-renomme.png');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:s=320x240:d=1', '-frames:v', '1', jpeg]);
    renameSync(jpeg, image);
    // Contre-épreuve de l'oracle : un son faible non traité ne satisfait
    // jamais la demande d'harmonisation.
    ctx.check('contre-épreuve : faible brut rejeté en A', !audioChecks(sources[1], sources[1], CASES[0]).bande);
    app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
    const { page, events } = app;
    await page.evaluate(() => {
      localStorage.setItem('storyStudio.packLeadingSilenceSeconds', '0.7');
      localStorage.setItem('storyStudio.packTrailingSilenceSeconds', '2.3');
    });
    await page.reload();
    for (const editor of ['menus', 'graphe']) {
      events.setStep(`${editor}-construction`);
      if (editor === 'menus') await buildMenus(page, sources, image);
      else await buildGraph(page, events, sources, image);
      await ctx.shot(page, `${editor}-construit`);
      for (const testCase of CASES) {
        events.setStep(`${editor}-${testCase.name}`);
        const state = await options(page, testCase);
        ctx.check(`${editor} ${testCase.name} options par le tiroir`, state.harmonize === testCase.harmonize && state.silenceSelected
          && /0,7/.test(state.durations) && /2,3/.test(state.durations), state);
        await ctx.shot(page, `${editor}-${testCase.name}-options`);
        const generation = await generatePack(page, ctx.dir(editor, testCase.name, 'export'), { events, timeout: 120_000 });
        ctx.check(`${editor} ${testCase.name} archive produite`, !!generation.zip, generation);
        if (!generation.zip) continue;
        const dir = ctx.dir(editor, testCase.name, 'extrait');
        const story = extractArchive(generation.zip, dir);
        const readback = await readStoryJson(page, generation.zip);
        ctx.check(`${editor} ${testCase.name} archive relue par l'app`, !!readback.storyJson, { error: readback.error });
        const audioNames = [...new Set(story.stageNodes.map(stage => stage.audio).filter(Boolean))];
        const measures = audioNames.map((name, index) => measureAudio(join(dir, 'assets', name), join(dir, `mesure-${index}`)));
        const matched = matchAudio(measures, sources);
        for (const source of sources) {
          const measure = matched[source.name];
          const checks = audioChecks(measure, source, testCase, limiterReference.samplePeak);
          records.push({ editor, case: testCase.name, source: source.name, ...measure, checks });
          ctx.check(`${editor} ${testCase.name} ${source.name}`, Object.values(checks).every(Boolean), { measure, checks });
        }
        const images = [...new Set(story.stageNodes.map(stage => stage.image).filter(Boolean))];
        ctx.check(`${editor} ${testCase.name} image présente`, images.length > 0);
        for (const [index, name] of images.entries()) {
          ffmpeg(['-v', 'error', '-i', join(dir, 'assets', name), '-f', 'null', '-'], join(dir, `image-${index}.log`));
        }
        ctx.check(`${editor} ${testCase.name} JPEG renommé décodé dans l'archive`, images.length > 0);
      }
      await returnHome(page);
    }
    for (const testCase of CASES) for (const source of sources) {
      const pair = records.filter(record => record.case === testCase.name && record.source === source.name);
      const fields = { lufs: LEVEL_TOLERANCE_LU, contentLufs: LEVEL_TOLERANCE_LU, truePeak: PEAK_TOLERANCE_DB,
        samplePeak: PEAK_TOLERANCE_DB, leading: EDGE_TOLERANCE_SEC, trailing: EDGE_TOLERANCE_SEC };
      ctx.check(`parité ${testCase.name} ${source.name}`, pair.length === 2
        && Object.entries(fields).every(([key, tolerance]) => Math.abs(pair[0][key] - pair[1][key]) <= tolerance), { pair });
    }
    for (const editor of ['menus', 'graphe']) for (const source of sources) {
      const pair = records.filter(record => record.editor === editor && record.source === source.name && ['C', 'D'].includes(record.case));
      ctx.check(`silences et niveau découplés ${editor} ${source.name}`, pair.length === 2
        && Math.abs(pair[0].contentLufs - pair[1].contentLufs) <= LEVEL_TOLERANCE_LU
        && Math.abs(pair[0].samplePeak - pair[1].samplePeak) <= PEAK_TOLERANCE_DB
        && Math.abs(pair[0].truePeak - pair[1].truePeak) <= PEAK_TOLERANCE_DB, { pair });
    }
    ctx.check('aucune exception console', events.faults().length === 0, { faults: events.faults() });
  } catch (error) {
    ctx.check('parcours terminé sans interruption', false, { error: String(error.stack || error) });
    if (app) await ctx.shot(app.page, 'interruption').catch(() => {});
  } finally {
    writeFileSync(join(ctx.runDir, 'mesures.json'), JSON.stringify({ sources, limiterReference, records }, null, 2));
    if (app) {
      const stopped = await app.stop();
      ctx.check('workspace personnel intact', stopped.polluted.length === 0, { polluted: stopped.polluted });
    }
  }
  return ctx.finish({ sources, limiterReference, records });
}
