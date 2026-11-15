// R2 : une étape écrite, une étape jouée seule. Aucun corpus personnel.
import assert from 'node:assert/strict';
import { renameSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { preferences, closePreferences, openCatalogue, addSource, settledScans, indexed, refreshAll, cards, operations, packFixture } from '../lib/c11-helpers.mjs';
import { until, json, hash, mediaFile, filesUnder, importGraphAudio } from '../lib/c10-helpers.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { synthImage, synthTone, probeAudio } from '../lib/fixtures.mjs';
import { newProject, generatePack, returnHome, openPackMetadata } from '../lib/actions.mjs';
import { selectGraphNode, repairGraphEndings } from '../lib/c4-helpers.mjs';
import { ffmpeg, extractArchive } from '../lib/audio-oracles.mjs';
import { dropOnTree, editorCard, pickAudioField, pickImageField, setPackTitle } from '../lib/c2-helpers.mjs';
import { convertToFsFolder } from '../studio/studio.mjs';
import { closeSimulator } from '../lib/simulator.mjs';
import { dropFiles } from '../lib/drop.mjs';
import { runPodcastImport, runYoutubeImport } from '../lib/c5-helpers.mjs';
import { reopenRecipePack } from '../lib/recipe-helpers.mjs';

async function recipeOpening(ctx, app) {
  for (const type of ['simple', 'pack']) {
    await reopenRecipePack(app.page, ctx, app.events, type, { catalogue: true });
  }
}

async function missing(ctx, app) {
  const { page } = app;
  const f = await indexed(ctx, app, 2, true);
  for (const path of f.paths) renameSync(path, path + '.absent');
  await refreshAll(page);
  await until(page, 'deux fiches introuvables', async () => (await cards(page)).every(c => c.offlineReason === 'missing' && c.exemplars.every(e => !e.available)));
  const rows = page.locator('[data-card-id]');
  await rows.first().click();
  await ctx.shot(page, '15-chemin-long');
  const text = await page.locator('#catalogue-fiche-panel').innerText();
  ctx.check('#15 dernier emplacement connu avec chemin long', text.includes('Dernier emplacement connu') && f.paths.some(p => text.includes(p)), { text });
  await rows.nth(1).click({ modifiers: ['Control'] });
  const panel = page.locator('#catalogue-fiche-panel');
  await panel.getByRole('button', { name: 'Retirer du catalogue', exact: true }).waitFor();
  ctx.check('#20 Assembler absent pour la sélection introuvable', await panel.getByRole('button', { name: /Assembler/ }).count() === 0);
  await ctx.shot(page, '20-selection');
  await panel.getByRole('button', { name: 'Retirer du catalogue', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  await ctx.shot(page, '20-confirmation');
  await dialog.getByRole('button', { name: /Retirer/ }).click();
  await until(page, 'retrait des deux fiches confirmé', async () => (await cards(page)).length === 0);
  ctx.check('#20 retrait groupé confirmé', true);
}

async function reopen(ctx, app) {
  const { page, events } = app;
  await openCatalogue(page);
  await preferences(page);
  await addSource(page, ctx.dir('source-vide'));
  const scans = await settledScans(page);
  assert(scans.length && scans.every(op => op.status === 'success'), 'Scan initial réussi');
  await closePreferences(page);
  await page.locator('[data-toolbar-id="catalogue-menu"]').click();
  await page.getByRole('menuitem', { name: 'Retour à l’accueil', exact: true }).click();
  const start = events.ipc().length;
  await openCatalogue(page);
  await page.waitForTimeout(3000);
  const scansAfter = events.ipc().slice(start).filter(e => e.cmd === 'catalogue_start_scan');
  ctx.check('#21 réouverture sans changement : aucun scan lancé', scansAfter.length === 0, { scansAfter });
}

async function noSend(ctx, app) {
  const { page, events } = app;
  const f = await indexed(ctx, app, 1);
  renameSync(f.paths[0], f.paths[0] + '.absent');
  await refreshAll(page);
  await until(page, 'fiche introuvable', async () => (await cards(page))[0]?.offlineReason === 'missing');
  const row = page.locator('[data-card-id]').first();
  await row.click();
  const blocked = async scope => {
    const actions = scope.getByRole('button', { name: /Envoyer.*Lunii/ });
    for (const action of await actions.all()) assert(await action.isDisabled() || await action.getAttribute('aria-disabled') === 'true', 'Envoi activé');
  };
  await blocked(page.locator('#catalogue-fiche-panel'));
  await ctx.shot(page, '33-panneau');
  await row.click({ button: 'right' });
  const menu = page.locator('[data-catalogue-menu="true"]').last();
  await menu.waitFor();
  const send = menu.getByRole('menuitem', { name: /Envoyer.*Lunii/ });
  for (const item of await send.all()) assert(await item.getAttribute('aria-disabled') === 'true', 'Menu envoi activé');
  await ctx.shot(page, '33-menu');
  await page.keyboard.press('Escape');
  const box = await row.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 100, { steps: 12 });
  await ctx.shot(page, '33-glisser');
  await page.mouse.up();
  assert(!events.ipc().some(e => /lunii.*(send|enqueue)/.test(e.cmd)), 'Aucun envoi IPC');
  ctx.check('#33 panneau, menu et glisser sans Lunii : aucun envoi proposé actif ni IPC', true);
}

async function moved(ctx, app) {
  const { page } = app;
  const f = await indexed(ctx, app, 1);
  const original = f.cards[0];
  assert(original.uuids.length > 0, 'Pack avec UUID');
  await page.locator('[data-card-id]').first().locator('.catalogue-star').click();
  await until(page, 'favori enregistré', async () => (await cards(page))[0]?.favorite === true);
  let previous = f.paths[0];
  for (const [label, target] of [['renommé', join(f.source, 'Nom différent.zip')], ['déplacé', join(ctx.dir('source', 'sous-dossier'), 'Nom différent.zip')]]) {
    renameSync(previous, target);
    await refreshAll(page);
    const actual = await cards(page);
    ctx.check(`#34 ${label} : une fiche, un exemplaire et favori gardé`, actual.length === 1 && actual[0].id === original.id && actual[0].favorite === true && actual[0].exemplars.length === 1 && actual[0].exemplars[0].available, { actual });
    assert(actual.length === 1 && actual[0].exemplars.length === 1, 'Doublon après déplacement');
    await page.locator('[data-card-id]').first().click();
    await ctx.shot(page, `34-${label}`);
    previous = target;
  }
}

async function selectionMenus(ctx, app) {
  const { page } = app;
  const f = await indexed(ctx, app, 3);
  for (const path of f.paths) renameSync(path, path + '.absent');
  await refreshAll(page);
  await until(page, 'trois fiches introuvables', async () => (await cards(page)).every(c => c.offlineReason === 'missing'));
  const rows = page.locator('[data-card-id]');
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['Control'] });
  const menu = page.locator('.catalogue-menu[role="menu"]');
  for (const keyboard of [false, true]) {
    for (const index of [0, 2]) {
      if (keyboard) { await rows.nth(index).focus(); await page.keyboard.press('Shift+F10'); }
      else await rows.nth(index).click({ button: 'right' });
      await menu.waitFor();
      const label = await menu.getAttribute('aria-label');
      const text = await menu.innerText();
      const isSelection = /2.*sélectionn/i.test(label);
      ctx.check(`#36 ${keyboard ? 'Maj+F10' : 'souris'} ${index === 0 ? 'dans' : 'hors'} sélection`, index === 0 ? isSelection && !text.includes('Copier l’UUID') : label.includes('Témoin_3') && !isSelection && text.includes('Copier l’UUID'), { menuLabel: label, text });
      await ctx.shot(page, `36-${keyboard ? 'clavier' : 'souris'}-${index}`);
      await page.keyboard.press('Escape');
    }
  }
  await rows.nth(0).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Retirer du catalogue', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  await ctx.shot(page, '36-retrait-confirme');
  await dialog.getByRole('button', { name: /Retirer/ }).click();
  await until(page, 'deux fiches retirées par menu de sélection', async () => (await cards(page)).length === 1);
  ctx.check('#36 Retirer dans le menu de sélection retire les deux fiches', true);
}

async function rapidScans(ctx, app) {
  const { page } = app;
  const zip = await packFixture(ctx, app);
  const sources = ['A', 'B', 'C'].map(name => ctx.dir('sources', name));
  for (const source of sources) for (let i = 0; i < 300; i++) copyFileSync(zip, join(source, `pack-${i}.zip`));
  await openCatalogue(page);
  await preferences(page);
  await answerNext(page, 'open', sources);
  await page.locator('#catalogue').getByRole('button', { name: 'Ajouter des dossiers', exact: true }).click();
  await until(page, 'trois dossiers ajoutés', () => page.locator('#catalogue .opts-catalogue-source').count().then(n => n === 3));
  const initial = await settledScans(page);
  assert(initial.length && initial.every(op => op.status !== 'failed'), 'Aucun scan échoué après ajouts rapides');
  ctx.check('#18 trois ajouts rapides sans scan en échec', true, { operations: initial });
  // Même adaptateur réel que les boutons : lancer les requêtes rapprochées,
  // sans verrou de test ni ralentissement artificiel du moteur.
  const queued = await page.evaluate(async () => {
    const { catalogueApi } = await import('/src/store/catalogue/catalogueApi.js');
    const api = catalogueApi();
    const list = await api.listSources(null);
    const request = sourceIds => api.startScan({ sourceIds, force: true, requestId: crypto.randomUUID(), expectedSourcesRevision: list.sourcesRevision });
    const active = await request(list.items.map(s => s.id));
    const pending = await request(list.items.map(s => s.id));
    const snapshot = await api.getOperation(pending.operationId);
    if (snapshot.status === 'queued') await api.cancelOperation(pending.operationId);
    return { active, pending, snapshot };
  });
  ctx.check('#18 annulation d’un scan réellement en attente (adaptateur IPC)', queued.snapshot.status === 'queued' ? true : null, queued);
  const during = await operations(page);
  const running = during.some(op => ['running', 'queued'].includes(op.status));
  await page.locator('#catalogue .opts-catalogue-source').nth(1).locator('button').last().click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  await ctx.shot(page, '18-retrait-pendant-scan');
  await dialog.getByRole('button', { name: /Retirer/ }).click();
  await until(page, 'deux sources restantes', () => page.locator('#catalogue .opts-catalogue-source').count().then(n => n === 2));
  const final = await settledScans(page);
  ctx.check('#18 retrait source pendant scan regroupé', running ? final.every(op => op.status !== 'failed') : null, { operations: final, running });
}

async function projectImageScan(ctx, app) {
  const { page, events } = app;
  const source = ctx.dir('source');
  const projectPath = join(source, 'Projet témoin.mbah');
  await packFixture(ctx, app, 'Projet témoin', null, projectPath);
  await openCatalogue(page);
  await preferences(page);
  await addSource(page, source);
  await settledScans(page);
  await closePreferences(page);
  const before = await until(page, 'projet indexé', async () => (await cards(page))[0]);
  assert(before.exemplars.some(e => e.format === 'project'));
  const projectHash = hash(projectPath);
  const p = json(projectPath);
  const imagePath = mediaFile(projectPath, p.thumbnailImage || p.rootImage);
  const imageBefore = hash(imagePath);
  synthImage(dirname(imagePath), basename(imagePath), 1);
  assert(hash(imagePath) !== imageBefore && hash(projectPath) === projectHash, 'Image changée sans changer le mbah');
  await refreshAll(page);
  const after = await cards(page);
  ctx.check('#22 image liée au .mbah réanalysée', after.length === 1 && after[0].coverSignature !== before.coverSignature, { before: before.coverSignature, after: after[0]?.coverSignature });
  const starts = events.ipc().filter(e => e.cmd === 'catalogue_start_scan' && e.body?.force === true);
  ctx.check('#22 bouton Forcer déclenche force=true et scan réussi', starts.length > 0 && (await operations(page))[0]?.status === 'success', { starts });
  await page.locator('[data-card-id]').first().click();
  await ctx.shot(page, '22-image-reanalysee');
}

async function scrollPreferences(ctx, app) {
  const { page } = app;
  await preferences(page);
  const nav = page.locator('.opts-nav');
  const read = () => page.evaluate(() => {
    const root = document.querySelector('.opts-screen');
    const buttons = [...document.querySelectorAll('.opts-nav-item')];
    return { top: root.scrollTop, max: root.scrollHeight - root.clientHeight,
      active: buttons.findIndex(b => b.classList.contains('is-active')), label: buttons.find(b => b.classList.contains('is-active'))?.textContent };
  });
  await nav.getByRole('button', { name: 'Enregistrement', exact: true }).click();
  await page.waitForTimeout(800);
  const box = await page.locator('.opts-screen').boundingBox();
  await page.mouse.move(box.x + box.width - 100, box.y + box.height / 2);
  const traces = {};
  for (const direction of [1, -1]) {
    const values = [await read()];
    for (let i = 0; i < 70; i++) {
      await page.mouse.wheel(0, direction * 220);
      await page.waitForTimeout(120);
      const next = await read();
      values.push(next);
      if (direction === 1 ? next.top >= next.max - 1 : next.top <= 1) break;
    }
    traces[direction] = values;
    ctx.check(`#19 molette ${direction === 1 ? 'bas' : 'haut'} : section active monotone et borne atteinte`, values.every((v, i) => i === 0 || direction * (v.active - values[i - 1].active) >= 0) && (direction === 1 ? values.at(-1).top >= values.at(-1).max - 1 && values.at(-1).active === 9 : values.at(-1).top <= 1 && values.at(-1).active === 0), { values });
    await ctx.shot(page, `19-${direction === 1 ? 'bas' : 'haut'}`);
  }
  await nav.getByRole('button', { name: 'Images IA', exact: true }).click();
  let lastTop = null;
  let stable = 0;
  await until(page, 'fin du défilement doux après clic', async () => {
    const { top } = await read();
    stable = lastTop !== null && Math.abs(top - lastTop) < 0.1 ? stable + 1 : 0;
    lastTop = top;
    return stable >= 3;
  });
  const target = await read();
  await page.mouse.move(box.x + box.width - 100, box.y + box.height / 2);
  await page.waitForTimeout(100);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(300);
  const after = await read();
  ctx.check('#19 clic Images IA puis molette : suivi repris sans retour au clic', target.active === 6 && after.top < target.top && after.active <= target.active, { target, after });
}

async function resourceCounts(ctx, app) {
  const { page, events } = app;
  for (const count of [3, 7]) {
    await newProject(page, 'pack');
    const image = synthImage(ctx.dir(`medias-${count}`), 'couverture.png');
    const title = synthTone(ctx.dir(`medias-${count}`), 'titre.wav', 220, 2);
    const root = page.locator('.root-identity-card');
    assert(await pickImageField(page, root, image));
    assert(await pickAudioField(page, root, 'Titre audio', title));
    for (let i = 1; i < count; i++) {
      const audio = synthTone(ctx.dir(`medias-${count}`), `histoire-${i}.wav`, 220 + 100 * i, 2);
      await dropOnTree(page, audio);
      const story = editorCard(page, "L'histoire");
      assert(await pickImageField(page, story, image));
      assert(await pickAudioField(page, story, 'Audio de sélection', title));
    }
    assert(await setPackTitle(page, `Ressources ${count}`));
    const generated = await generatePack(page, ctx.dir(`export-${count}`), { events });
    assert(generated.zip, JSON.stringify(generated));
    await returnHome(page);
    const source = ctx.dir(`source-${count}`);
    const folder = convertToFsFolder(generated.zip, source);
    const resources = filesUnder(join(folder, 'sf'));
    assert.equal(resources.length, count, 'Nombre réel de ressources audio FS');
    await openCatalogue(page);
    await preferences(page);
    await addSource(page, source);
    const scans = await settledScans(page);
    assert(scans.every(op => op.status === 'success'), 'FS accepté dans le catalogue');
    await closePreferences(page);
    const card = await until(page, `fiche FS ${count}`, async () => (await cards(page)).find(c => c.exemplars.some(e => e.format === 'folder' && e.path === folder)));
    const row = page.locator(`[data-card-id="${card.id}"]`);
    await row.click();
    await page.locator('#catalogue-fiche-panel').getByRole('button', { name: 'Simuler', exact: true }).click();
    await page.locator('.lunii-sim').waitFor({ timeout: 60_000 });
    await ctx.shot(page, `8-${count}-apercu`);
    ctx.check(`#8 ${count} ressources : aperçu FS sans faux refus`, true, { resources });
    await closeSimulator(page);
    await page.locator('[data-toolbar-id="catalogue-menu"]').click();
    await page.getByRole('menuitem', { name: 'Retour à l’accueil', exact: true }).click();
    await page.getByText('Modifier un pack existant', { exact: true }).click();
    await dropFiles(page, '[data-funnel-drop]', [folder]);
    const chooser = page.getByRole('button', { name: 'Éditeur graphe', exact: true });
    const editor = page.getByRole('button', { name: /Générer le pack/ }).first();
    await Promise.race([chooser.waitFor({ timeout: 60_000 }), editor.waitFor({ timeout: 60_000 })]);
    if (await chooser.isVisible()) await chooser.click();
    await editor.waitFor({ timeout: 60_000 });
    await page.locator('[data-funnel-drop]').waitFor({ state: 'hidden', timeout: 60_000 });
    ctx.check(`#8 ${count} ressources : import FS dans l’éditeur sans faux refus`, true);
    await ctx.shot(page, `8-${count}-importe`);
    await returnHome(page);
  }
}

async function longAudio(ctx, app) {
  const { page, events } = app;
  await page.evaluate(() => {
    localStorage.setItem('storyStudio.packLeadingSilenceSeconds', '0');
    localStorage.setItem('storyStudio.packTrailingSilenceSeconds', '0');
  });
  await page.reload();
  await page.locator('#mode-open-catalogue').waitFor();
  const audio = join(ctx.dir('medias'), 'son-25-minutes.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1499', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]', audio]);
  const source = probeAudio(audio);
  assert(source.readable && source.durationSec === 1500);
  await newProject(page, 'advanced');
  assert(await selectGraphNode(page, 'Écran 1', 'stage'));
  await importGraphAudio(page, page.locator('.advanced-media-field--audio [data-drop-kind="audio"]'), audio);
  assert(await pickImageField(page, page.locator('.advanced-media-field--image'), synthImage(ctx.dir('medias'), 'entree.png')));
  assert(await setPackTitle(page, 'Audio long synthétique'));
  // Les fins sont réparées comme l'utilisateur ; un éventuel diagnostic restant
  // est journalisé, et c'est le refus ou non de la génération qui tranche.
  const endings = await repairGraphEndings(page);
  ctx.check('#32 diagnostics de fin réparés (restant journalisé)', true, endings);
  if (endings.remaining) {
    await page.locator('[data-toolbar-id="toggleValidation"]').first().click();
    await page.waitForTimeout(800);
    await ctx.shot(page, '32-diagnostic-restant');
    await page.keyboard.press('Escape');
  }
  const sheet = await openPackMetadata(page);
  const controls = sheet.locator('.pack-meta-audio');
  const harmonize = controls.getByRole('button', { name: 'Harmoniser le volume des audios vers -14 LUFS à la génération.', exact: true });
  if (await harmonize.getAttribute('aria-pressed') !== 'true') await harmonize.click();
  const silence = controls.getByRole('button', { name: 'Activer le traitement des silences de début et de fin', exact: true });
  if (await silence.getAttribute('aria-pressed') !== 'true') await silence.click();
  await controls.locator('button.pack-meta-audio-segment').filter({ hasText: /^Ajuster$/ }).click();
  await sheet.getByRole('contentinfo').getByRole('button', { name: 'Appliquer', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
  const result = await generatePack(page, ctx.dir('export-long'), { events, timeout: 600_000 });
  assert(result.zip, JSON.stringify(result));
  const extracted = ctx.dir('archive-longue');
  extractArchive(result.zip, extracted);
  const sounds = filesUnder(join(extracted, 'assets')).filter(p => /\.(mp3|wav|ogg)$/i.test(p));
  assert.equal(sounds.length, 1, 'Un son exporté');
  const exported = probeAudio(sounds[0]);
  ctx.check('#32 son 25 min : durée conservée après export graphe', exported.readable && Math.abs(exported.durationSec - source.durationSec) <= 0.05, { source, exported, toleranceSec: 0.05, archive: result.zip });
  const tailLog = ffmpeg(['-sseof', '-0.2', '-i', sounds[0], '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-'], join(ctx.runDir, 'audio-fin.log'));
  const rms = [...tailLog.matchAll(/RMS level dB:\s*([-\d.]+)/g)].map(m => Number(m[1]));
  ctx.check('#32 fin du son exporté non silencieuse', rms.length > 0 && rms.every(n => n > -40), { rms });
  await ctx.shot(page, '32-export-long');
}

async function idleLog(ctx, app) {
  const { page, events } = app;
  await newProject(page, 'pack');
  const logPath = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_current_log_file'));
  assert(logPath.includes('com.hugs11.story-studio.e2e'), 'Journal du profil isolé seulement');
  await page.waitForTimeout(5000);
  const sample = () => ({ at: Date.now(), bytes: statSync(logPath).size, modified: statSync(logPath).mtimeMs, sha256: hash(logPath) });
  const samples = [sample()];
  for (let minute = 1; minute <= 11; minute++) {
    await page.waitForTimeout(55_500);
    samples.push(sample());
    writeFileSync(join(ctx.runDir, 'repos.json'), JSON.stringify({ logPath, samples }, null, 2));
    console.log(`Repos réel : ${Math.round((samples.at(-1).at - samples[0].at) / 1000)} s, journal ${samples.at(-1).bytes} octets`);
  }
  ctx.check('#23 repos > 10 min : aucune écriture périodique au journal', samples.at(-1).at - samples[0].at >= 600_000 && samples.every(s => s.sha256 === samples[0].sha256 && s.modified === samples[0].modified), { samples, logPath });
  await preferences(page);
  await page.locator('.opts-nav').getByRole('button', { name: 'Diagnostic', exact: true }).click();
  const toggle = page.locator('#diagnostic button.tog');
  assert(await toggle.getAttribute('aria-pressed') === 'false');
  const start = events.ipc().length;
  await toggle.click();
  await until(page, 'verbose activé', () => toggle.getAttribute('aria-pressed').then(v => v === 'true'));
  await ctx.shot(page, '23-verbose-actif');
  await toggle.click();
  await until(page, 'verbose désactivé', () => toggle.getAttribute('aria-pressed').then(v => v === 'false'));
  const levels = events.ipc().slice(start).filter(e => e.cmd === 'set_log_level').map(e => e.body.level);
  ctx.check('#23 verbose activé puis désactivé : info puis warn', levels.join(',') === 'info,warn', { levels, journal: readFileSync(logPath, 'utf8') });
}

async function importedTitles(ctx, app) {
  const { page } = app;
  await newProject(page, 'pack');
  const names = async () => (await page.locator('.tree-item').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  const feedUrl = 'http://rss.sciam.com/sciam/60secsciencepodcast/';
  let podcast = null;
  // L'apostrophe droite ou typographique : le premier épisode du flux qui en porte une.
  for (const query of ["'", '’']) {
    podcast = await runPodcastImport(page, { feedUrl, episodeQuery: query });
    if (podcast.ok) break;
    await page.keyboard.press('Escape');
  }
  await ctx.shot(page, '42-podcast');
  if (!podcast?.ok) return ctx.check('#42 podcast : import non concluant (réseau ou flux)', null, podcast);
  const flat = s => s.replace(/\s+/g, ' ').trim();
  const podcastNames = await names();
  ctx.check('#42 podcast : l’histoire porte le titre de l’épisode, apostrophes gardées', /['’]/.test(podcast.episodeTitle) && podcastNames.some(n => n.includes(flat(podcast.episodeTitle))), { episodeTitle: podcast.episodeTitle, podcastNames });
  const video = await runYoutubeImport(page, { videoUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', timeout: 120_000 });
  await ctx.shot(page, '42-youtube');
  if (!video.ok) return ctx.check('#42 YouTube : import non concluant (réseau ou YouTube)', null, video);
  const videoNames = await names();
  ctx.check('#42 YouTube : l’histoire porte le titre de la vidéo', videoNames.some(n => n.includes(flat(video.videoTitle))), { videoTitle: video.videoTitle, videoNames });
}

export async function run(args = []) {
  if (process.env.C11_STEPS) args = process.env.C11_STEPS.split(',').map(s => s.trim()).filter(Boolean);
  const ctx = createRun('c11-recette-0912-catalogue');
  const steps = [['#67', recipeOpening], ['#21', reopen], ['#20-15', missing], ['#33', noSend], ['#34', moved], ['#36', selectionMenus], ['#18', rapidScans], ['#22', projectImageScan], ['#19', scrollPreferences], ['#8', resourceCounts], ['#32', longAudio], ['#23', idleLog], ['#42', importedTitles]];
  assert(args.length === 1 && steps.some(([name]) => name === args[0]), 'Choisir une seule étape connue avec C11_STEPS');
  let app;
  try {
    app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
    await app.page.evaluate(() => localStorage.setItem('storyStudio.uiLanguage', 'fr'));
    await app.page.reload();
    await app.page.locator('#mode-open-catalogue').waitFor({ timeout: 60_000 });
    app.events.setStep(args[0]);
    await steps.find(([name]) => name === args[0])[1](ctx, app);
    await ctx.shot(app.page, `point-${args[0].slice(1)}`);
  } catch (error) {
    ctx.check(`${args[0]} : ${error.message}`, false, { stack: error.stack });
    if (app) await ctx.shot(app.page, 'echec').catch(() => {});
  } finally {
    if (app) {
      app.events.flush();
      const faults = app.events.faults();
      ctx.check('aucune exception JavaScript', !faults.some(e => e.kind === 'pageerror'), { faults });
      const stopped = await app.stop();
      ctx.check('aucune écriture dans le workspace réel', stopped.polluted.length === 0, { polluted: stopped.polluted });
    }
  }
  return ctx.finish({ selectedStep: args[0] });
}
