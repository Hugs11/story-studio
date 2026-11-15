// R1w — sans corpus, réseau ni appareil. Exécution par l'orchestrateur Windows.
// Un argument peut filtrer une étape par son nom exact. Aucun lancement à l'import.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { appDataDirs } from '../lib/config.mjs';
import { newProject, returnHome, projectMenuButton, generatePack, enterGeneration, MODALS, clickButton } from '../lib/actions.mjs';
import { answerNext, dialogLog, discardPendingAnswer } from '../lib/dialogs.mjs';
import { synthTone, synthImage, probeAudio } from '../lib/fixtures.mjs';
import { ffmpeg } from '../lib/audio-oracles.mjs';
import {
  dropOnTree, treeRoot, treeNodeAction, editorCard, pickAudioField, pickImageField,
  setPackTitle, openProjectDialog, hasMissingMediaModal, missingMediaModal, openMediaExplorer,
} from '../lib/c2-helpers.mjs';
import { createGraphStage, renameSelectedNode, selectGraphNode, readGraphView } from '../lib/c4-helpers.mjs';
import {
  until, filesUnder, json, hash, mediaFile, save, contextAction, editAudio,
  sessionSnapshots, ageE2E, importGraphAudio, settledGesture,
} from '../lib/c10-helpers.mjs';

const graphField = page => page.locator('.advanced-media-field--audio [data-drop-kind="audio"]');
const treeStory = (page, name) => page.locator('[data-media-node-type="story"]').filter({ hasText: name }).first();
const treeName = page => page.locator('.card:visible input.field-input').first();
const storyField = page => editorCard(page, "L'histoire").locator('[data-drop-kind="audio"]').last();
const must = (ok, message) => assert(ok, message);

async function configured(app, { workspace = false, limit = 2 } = {}) {
  // Préparation du profil de test, avant création de projet. Ni store ni IPC mockés.
  await app.page.evaluate(({ workspace, limit }) => {
    localStorage.setItem('storyStudio.uiLanguage', 'fr');
    localStorage.setItem('storyStudio.useWorkspaceForNewProjects', String(workspace));
    localStorage.setItem('copyImportedFiles', 'true');
    localStorage.setItem('autoSaveEnabled', 'true');
    localStorage.setItem('autoSaveBackupLimit', String(limit));
  }, { workspace, limit });
  await app.page.reload();
  await app.page.getByText('Modifier un pack existant', { exact: true }).waitFor({ timeout: 60_000 });
}

async function open(page, path) {
  must(await openProjectDialog(page, path), 'Éditeur absent après ouverture');
  // Le helper historique attend la barre, qui peut précéder la fin de lecture.
  await until(page, 'nom du fichier ouvert dans le bandeau', async () =>
    (await page.locator('.chrome-titlebar-project').innerText()) === (json(path).projectName || basename(path, '.mbah')));
}

async function basicMenus(page, ctx, label, audio) {
  await newProject(page, 'pack');
  await dropOnTree(page, audio);
  const path = join(ctx.dir(label), 'Base.mbah');
  await save(page, path, { first: true });
  return path;
}

// Fixture issue d'un vrai projet UI enregistré. On fabrique seulement l'arbre
// d'entrée, jamais la sortie attendue du code de duplication.
async function menuFixture(page, ctx, label, audio) {
  const base = await basicMenus(page, ctx, label, audio);
  const p = json(base);
  const story = p.rootEntries.find(entry => entry.type === 'story');
  must(story, 'Histoire importée absente du fichier');
  await returnHome(page);
  const a = { ...story, id: randomUUID(), name: 'Histoire A' };
  const b = { ...story, id: randomUUID(), name: 'Histoire B' };
  const folderId = randomUUID();
  a.returnAfterPlay = `story:${b.id}`;
  a.returnOnHome = `menu:${folderId}`;
  b.returnAfterPlay = `story:${a.id}`;
  p.rootEntries = [{ type: 'menu', id: folderId, name: 'Dossier témoin', children: [a, b] }];
  const path = join(dirname(base), 'Fixture.mbah');
  writeFileSync(path, JSON.stringify(p));
  await open(page, path);
  // Canonicaliser la fixture avant la comparaison : les valeurs par défaut
  // ajoutées à l'ouverture ne doivent pas passer pour une mutation de copie.
  await save(page, path);
  return { path, a, b, folderId };
}

async function folders(ctx, app, audio, operation) {
  const { page } = app;
  const fixture = await menuFixture(page, ctx, `40-${operation}`, audio);
  const folder = page.locator(`[data-tree-node-id="${fixture.folderId}"]`);
  const before = json(fixture.path).rootEntries[0];
  if (operation === 'dupliquer') must(await treeNodeAction(page, folder, 'Dupliquer'), 'Dupliquer inaccessible');
  else {
    must(await treeNodeAction(page, folder, 'Copier'), 'Copier inaccessible');
    must(await treeNodeAction(page, treeRoot(page), 'Coller ici'), 'Coller inaccessible');
  }
  const after = await save(page, fixture.path);
  const copies = after.rootEntries.filter(entry => entry.id !== fixture.folderId);
  must(copies.length === 1, 'Une copie de dossier attendue');
  const copy = copies[0];
  must(copy.children.length === 2, 'Deux histoires attendues dans la copie');
  const [a, b] = copy.children;
  must(copy.id !== before.id && a.id !== fixture.a.id && b.id !== fixture.b.id, 'Identifiants distincts');
  must(a.returnAfterPlay === `story:${b.id}` && b.returnAfterPlay === `story:${a.id}`
    && a.returnOnHome === `menu:${copy.id}`, 'Renvois de la copie vers ses propres enfants et parent');
  assert.deepEqual(after.rootEntries.find(entry => entry.id === before.id), before, 'Original inchangé');
  ctx.check(`#40 ${operation} : renvois internes remappés, original intact`, true);
  if (operation === 'copier-coller') await settledGesture(page, () => page.keyboard.press('Control+z'));
  else await page.keyboard.press('Control+z');
  const undone = await save(page, fixture.path);
  assert.deepEqual(undone.rootEntries, [before], 'Annuler retire seulement la copie');
  ctx.check(`#40 ${operation} : Annuler restaure l’arbre`, true);
}

async function selectAudio(page, mode, name) {
  if (mode === 'menus') {
    await treeStory(page, name).click();
    return storyField(page);
  }
  must(await selectGraphNode(page, name, 'stage'), `Écran absent : ${name}`);
  return graphField(page);
}

async function sharedFixture(page, ctx, mode, audio) {
  if (mode === 'menus') {
    const f = await menuFixture(page, ctx, 'partage-menus', audio);
    // Déplier le dossier avec le geste de l'arbre si les enfants sont cachés.
    const a = treeStory(page, 'Histoire A');
    if (!await a.isVisible()) await page.locator(`[data-tree-node-id="${f.folderId}"] .tree-chevron`).click();
    return { path: f.path, names: ['Histoire A', 'Histoire B'], ids: [f.a.id, f.b.id] };
  }
  await newProject(page, 'advanced');
  await selectGraphNode(page, 'Écran 1', 'stage');
  await renameSelectedNode(page, 'Histoire A');
  await importGraphAudio(page, graphField(page), audio);
  await createGraphStage(page);
  await renameSelectedNode(page, 'Histoire B');
  // Copier le champ : les deux Écrans emploient exactement le même fichier.
  const a = await selectAudio(page, mode, 'Histoire A');
  await contextAction(page, a, 'Copier');
  await selectAudio(page, mode, 'Histoire B');
  await contextAction(page, graphField(page), 'Coller');
  const path = join(ctx.dir('partage-graphe'), 'Partage.mbah');
  await save(page, path, { first: true });
  return { path, names: ['Histoire A', 'Histoire B'] };
}

async function audioPaths(page, fixture, mode) {
  const p = json(fixture.path);
  if (mode === 'menus') {
    const children = p.rootEntries[0].children;
    return fixture.ids.map(id => {
      const ref = children.find(entry => entry.id === id).audio;
      return ref ? mediaFile(fixture.path, ref) : null;
    });
  }
  const { view } = await readGraphView(page, fixture.path);
  return fixture.names.map(name => {
    const stage = view.stages.find(stage => stage.name.value === name);
    must(stage, `Écran ${name} absent du fichier`);
    const ref = stage.audio.assetRef;
    if (!ref) return null;
    const binding = p.authoring.mediaBindings.find(binding => binding.assetRef === ref);
    must(binding?.path, `Liaison absente : ${ref}`);
    return mediaFile(fixture.path, binding.path);
  });
}

async function cutShared(ctx, app, audio, mode, sameField) {
  const { page } = app;
  const fixture = await sharedFixture(page, ctx, mode, audio);
  const before = await audioPaths(page, fixture, mode);
  must(before[0] && before[0] === before[1], 'Précondition : chemin audio partagé');
  const originalHash = hash(before[0]);
  const a = await selectAudio(page, mode, fixture.names[0]);
  await contextAction(page, a, 'Couper');
  const clipboard = await page.evaluate(async () => {
    const { audioClipboard } = await import('/src/store/fieldClipboard.js');
    const clip = audioClipboard.getEntry();
    return { ...clip, source: clip?.source ? { ...clip.source, clear: !!clip.source.clear } : null };
  });
  // Couper prépare un déplacement ; il n'efface aucun emploi avant collage.
  await save(page, fixture.path);
  assert.deepEqual(await audioPaths(page, fixture, mode), before, 'Couper seul conserve les deux emplois');
  const target = await selectAudio(page, mode, fixture.names[sameField ? 0 : 1]);
  await contextAction(page, target, 'Déplacer ici');
  await save(page, fixture.path);
  const after = await audioPaths(page, fixture, mode);
  writeFileSync(join(ctx.dir(`41-preuves-${mode}-${sameField ? 'meme' : 'ailleurs'}`), 'deplacement.json'),
    JSON.stringify({ clipboard, before, after, project: json(fixture.path) }, null, 2));
  assert.deepEqual(after, sameField ? before : [null, before[1]], 'Seul le champ source est vidé si la cible diffère');
  must(hash(before[1]) === originalHash, 'Le fichier partagé garde son contenu');
  ctx.check(`#41 ${mode} coller ${sameField ? 'dans le même champ' : 'ailleurs'} : emplois et contenu exacts`, true);
  // #41 garantit les emplois après collage sur soi, pas l'absence de
  // transaction d'historique. Annuler pourrait viser la mise en place.
  if (!sameField) {
    await settledGesture(page, () => page.keyboard.press('Control+z'));
    await save(page, fixture.path);
    assert.deepEqual(await audioPaths(page, fixture, mode), before, 'Annuler restaure les deux emplois');
    must(hash(before[0]) === originalHash);
    ctx.check(`#41 ${mode} Annuler : les deux emplois partagés restaurés`, true);
  }
}

async function renameTyping(page, field, text) {
  await field.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text, { delay: 45 });
  await page.keyboard.press('Tab');
}

async function names(ctx, app, audio) {
  const { page } = app;
  const f = await menuFixture(page, ctx, '43-inspecteurs', audio);
  await returnHome(page);
  const p = json(f.path);
  // Le quatrième inspecteur est ZipEditor : un pack non décompressé.
  // L'archive sera fabriquée par la génération de la fixture exportable.
  await exportable(page, ctx, audio, '43-archive');
  const generation = await generatePack(page, ctx.dir('43-zip'), { events: app.events });
  must(generation.zip, 'Archive synthétique non générée pour ZipEditor');
  await returnHome(page);
  const zipId = randomUUID();
  p.rootEntries.push({ id: zipId, type: 'zip', name: 'Pack témoin', zipPath: generation.zip });
  writeFileSync(f.path, JSON.stringify(p));
  await open(page, f.path);
  const targets = [
    ['racine', () => treeRoot(page).click()],
    ['dossier', () => page.locator(`[data-tree-node-id="${f.folderId}"]`).click()],
    ['histoire', async () => {
      if (!await page.locator(`[data-tree-node-id="${f.a.id}"]`).isVisible()) await page.locator(`[data-tree-node-id="${f.folderId}"] .tree-chevron`).click();
      await page.locator(`[data-tree-node-id="${f.a.id}"]`).click();
    }],
    ['pack', () => page.locator(`[data-tree-node-id="${zipId}"]`).click()],
  ];
  for (const [label, select] of targets) {
    app.events.setStep(`#43-nom-${label}`);
    await select();
    const field = treeName(page);
    const before = await field.inputValue();
    await renameTyping(page, field, `Nom complet ${label}`);
    await page.keyboard.press('Control+z');
    await until(page, `${label} Annuler en une étape`, async () => await field.inputValue() === before);
    await page.keyboard.press('Control+Shift+z');
    await until(page, `${label} Rétablir le nom entier`, async () => await field.inputValue() === `Nom complet ${label}`);
    ctx.check(`#43 ${label} : saisie caractère par caractère, Annuler/Rétablir en un geste`, true);
  }
  app.events.setStep('#43-A-B-A');
  const aNode = page.locator(`[data-tree-node-id="${f.a.id}"]`);
  const bNode = page.locator(`[data-tree-node-id="${f.b.id}"]`);
  await aNode.click();
  const a0 = await treeName(page).inputValue();
  await renameTyping(page, treeName(page), 'A première visite');
  await bNode.click();
  const b0 = await treeName(page).inputValue();
  await renameTyping(page, treeName(page), 'B visite');
  await aNode.click();
  await renameTyping(page, treeName(page), 'A seconde visite');
  await page.keyboard.press('Control+z');
  await until(page, 'A seconde visite annulée seule', async () => await treeName(page).inputValue() === 'A première visite');
  await page.keyboard.press('Control+z');
  await bNode.click();
  must(await treeName(page).inputValue() === b0, 'La deuxième annulation vise B');
  await page.keyboard.press('Control+z');
  await aNode.click();
  must(await treeName(page).inputValue() === a0, 'La troisième annulation vise la première visite de A');
  ctx.check('#43 A → B → A : trois transactions séparées', true);
}

async function audioCopy(ctx, app, audio, mode) {
  const { page } = app;
  // D'abord une histoire seule, retouchée ; la duplication doit partager ce dérivé.
  let fixture;
  if (mode === 'menus') {
    const path = await basicMenus(page, ctx, '44-menus', audio);
    const story = json(path).rootEntries[0];
    await treeStory(page, story.name).click();
    fixture = { path, names: [story.name], ids: [story.id] };
  } else {
    await newProject(page, 'advanced');
    await selectGraphNode(page, 'Écran 1', 'stage');
    await renameSelectedNode(page, 'Original');
    await importGraphAudio(page, graphField(page), audio);
    const path = join(ctx.dir('44-graphe'), 'Retouches.mbah');
    await save(page, path, { first: true });
    fixture = { path, names: ['Original'] };
  }
  const field = () => mode === 'menus' ? storyField(page) : graphField(page);
  await editAudio(page, field());
  await save(page, fixture.path);
  // Pour les histoires de premier niveau de ce test, lire directement l'audio.
  const paths = async () => {
    if (mode === 'graphe') return audioPaths(page, fixture, mode);
    const p = json(fixture.path);
    return fixture.ids.map(id => mediaFile(fixture.path, p.rootEntries.find(entry => entry.id === id).audio));
  };
  const firstPath = (await paths())[0];
  const firstHash = hash(firstPath);
  must(firstHash !== hash(audio), 'La première retouche change les octets');
  // Sortir du champ nom : Ctrl+D doit agir sur la sélection.
  if (mode === 'menus') await page.locator(`[data-tree-node-id="${fixture.ids[0]}"]`).click();
  else await selectGraphNode(page, 'Original', 'stage');
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(500);
  if (mode === 'menus') {
    const p = await save(page, fixture.path);
    const copy = p.rootEntries.find(entry => entry.id !== fixture.ids[0]);
    must(copy, 'Histoire dupliquée absente');
    fixture.ids.push(copy.id);
    await page.locator(`[data-tree-node-id="${copy.id}"]`).click();
  } else {
    await renameSelectedNode(page, 'Copie');
    fixture.names.push('Copie');
    await save(page, fixture.path);
  }
  const shared = await paths();
  must(shared.length === 2 && shared.every(path => path === firstPath), 'Dérivé partagé après duplication');
  await openMediaExplorer(page);
  await until(page, 'médiathèque : dérivé employé deux fois', async () =>
    (await page.locator('[data-media-id] .media-usage-badge').allTextContents()).some(text => text.trim() === '×2'));
  await ctx.shot(page, `44-${mode}-deux-emplois-avant-retouche`);
  writeFileSync(join(ctx.dir(`44-preuves-${mode}`), 'avant.json'), JSON.stringify({
    shared, firstHash, project: json(fixture.path), library: await page.locator('[data-media-id]').allInnerTexts(),
  }, null, 2));
  await editAudio(page, field(), { fade: 'out', cancel: true });
  must(hash(firstPath) === firstHash, 'Annuler une retouche ne change pas le fichier partagé');
  await editAudio(page, field(), { fade: 'out' });
  await save(page, fixture.path);
  const edited = await paths();
  writeFileSync(join(ctx.dir(`44-preuves-${mode}`), 'apres.json'), JSON.stringify({
    shared, edited, hashes: edited.map(hash), firstHash, project: json(fixture.path),
    apply: app.events.ipc().filter(entry => entry.cmd === 'apply_audio_edit'),
  }, null, 2));
  must(edited[0] === firstPath && edited[1] !== firstPath, 'La copie reçoit un nouveau chemin');
  must(hash(edited[0]) === firstHash && hash(edited[1]) !== firstHash, 'Original intact, copie effectivement retouchée');
  ctx.check(`#44 ${mode} : retouche initiale, duplication, Annuler puis retouche isolée (chemin + SHA-256)`, true);
  await settledGesture(page, () => page.keyboard.press('Control+z'));
  await save(page, fixture.path);
  assert.deepEqual(await paths(), shared, 'Annuler retrouve les deux références au premier dérivé');
  must(hash(firstPath) === firstHash, 'Annuler ne réécrit pas le premier dérivé');
  await settledGesture(page, () => page.keyboard.press('Control+Shift+z'));
  await save(page, fixture.path);
  assert.deepEqual(await paths(), edited, 'Rétablir retrouve les chemins édités');
  // Restaurer la copie retrouve la version courante du premier dérivé (contrat #44).
  await editAudio(page, field(), { restore: true });
  await save(page, fixture.path);
  let restored = await paths();
  must(hash(restored[0]) === firstHash && hash(restored[1]) === firstHash, 'Restaurer la copie ne modifie pas l’original');
  if (mode === 'menus') await page.locator(`[data-tree-node-id="${fixture.ids[0]}"]`).click();
  else await selectGraphNode(page, 'Original', 'stage');
  const copyBefore = hash(restored[1]);
  await editAudio(page, field(), { restore: true });
  await save(page, fixture.path);
  restored = await paths();
  must(hash(restored[0]) === hash(audio), 'Restaurer l’original retrouve les octets source');
  must(hash(restored[1]) === copyBefore, 'Restaurer un côté conserve le contenu de l’autre');
  ctx.check(`#44 ${mode} : Annuler/Rétablir et restauration des deux côtés sans modifier l’autre`, true);
}

async function exportable(page, ctx, audio, label) {
  await newProject(page, 'pack');
  const image = synthImage(ctx.dir(label, 'sources'), 'couverture.png');
  const root = page.locator('.root-identity-card');
  must(await pickAudioField(page, root, 'Titre audio', audio));
  must(await pickImageField(page, root, image));
  for (let i = 0; i < 3; i++) {
    // Sources distinctes : la déduplication de génération ne doit pas réduire la charge.
    const file = join(ctx.dir(label, 'sources'), `histoire-${i}.wav`);
    if (i === 0) copyFileSync(audio, file);
    else ffmpeg(['-i', audio, '-af', `volume=${1 - i * 0.1}`, file]);
    await dropOnTree(page, file);
    const card = editorCard(page, "L'histoire");
    must(await pickImageField(page, card, image));
    must(await pickAudioField(page, card, 'Audio de sélection', audio));
  }
  must(await setPackTitle(page, 'Recette synthétique'));
  return image;
}

async function generation(ctx, app, longAudio, action) {
  const { page, events } = app;
  // Fabriquer d'abord un autre projet ouvrable, sans en dépendre ensuite.
  const other = await basicMenus(page, ctx, `38-autre-${action}`, longAudio);
  await returnHome(page);
  await exportable(page, ctx, longAudio, `38-long-${action}`);
  const outDir = ctx.dir(`38-sortie-${action}`);
  const start = Date.now();
  await answerNext(page, 'open', outDir);
  const dialogCount = (await dialogLog(page)).length;
  // La readiness des gros médias peut encore être recalculée juste après la
  // fermeture de la fiche. Le bouton attend son activation ; le raccourci,
  // envoyé pendant ce calcul, peut être ignoré sans démarrer de génération.
  await page.getByRole('button', { name: 'Générer le pack (Ctrl+G)', exact: true }).click({ timeout: 60_000 });
  await enterGeneration(page, { dialogCount, outDir });
  const revision = page.locator(MODALS).filter({ hasText: 'Nouvelle révision' });
  if (await revision.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await clickButton(revision, /Garder l.UUID d.origine/);
  }
  const running = () => page.locator('.rq-job-running').count();
  {
    await until(page, 'génération native réellement engagée', () => events.ipc().some(entry =>
      entry.at >= start && /^(generate_pack|export_advanced)/.test(entry.cmd)), 60_000);
    must(await running() > 0, 'Charge trop courte : génération déjà terminée avant le geste concurrent');
    if (action === 'enregistrer') {
      const target = join(ctx.dir('38-projet'), 'Pendant génération.mbah');
      await answerNext(page, 'save', target);
      await page.keyboard.press('Control+s');
      await until(page, 'enregistrement pendant génération', () => existsSync(target), 120_000);
      await until(page, 'archive produite malgré l’enregistrement concurrent', () =>
        filesUnder(outDir).find(path => path.endsWith('.zip')), 600_000);
      await page.locator('.rq-job-done').waitFor({ timeout: 30_000 });
      must(!await page.locator('.rq-job-error').count(), 'Aucune génération en erreur');
      ctx.check('#38 génération longue + Enregistrer : projet et archive produits', true);
    } else {
      await answerNext(page, 'open', other);
      await page.keyboard.press('Control+o');
      const guard = page.locator(MODALS).filter({ hasText: 'Un travail est encore en cours.' });
      await guard.getByRole('button', { name: 'Rester', exact: true }).click();
      await discardPendingAnswer(page, 'open', other);
      must(await page.locator('[data-media-node-type="story"]').count() === 3, 'Rester conserve le projet de génération');
      must(await running() > 0, 'Charge trop courte après Rester : ouverture concurrente non exercée');
      await answerNext(page, 'open', other);
      await page.keyboard.press('Control+o');
      await guard.getByRole('button', { name: 'Quitter quand même', exact: true }).click();
      const unsaved = page.locator(MODALS).filter({ hasText: /Projet non enregistré|Modifications non enregistrées/ });
      await clickButton(unsaved, /Quitter sans enregistrer|Ne pas enregistrer/, { timeout: 10_000 });
      await until(page, 'autre projet ouvert après confirmation', async () =>
        (await page.locator('.chrome-titlebar').innerText()).includes('Base'), 60_000);
      ctx.check('#38 ouvrir pendant génération : Rester puis Quitter quand même, autre projet ouvert', true);
    }
  }
}

async function inaccessible(ctx, app, audio) {
  const { page } = app;
  const path = await basicMenus(page, ctx, '38-inaccessible', audio);
  const folder = dirname(path);
  const parked = `${folder}-deplace`;
  // Vraie erreur de chemin Windows (ENOTDIR), réversible, sans changer les ACL.
  renameSync(folder, parked);
  writeFileSync(folder, 'Dossier rendu inaccessible pour la recette E2E');
  try {
    await treeRoot(page).click();
    await renameTyping(page, treeName(page), 'Modification inaccessible');
    await page.keyboard.press('Control+s');
    const error = page.locator(MODALS).filter({ hasText: /Impossible|Erreur|inaccessible|enregistrement.*échoué/i });
    await error.first().waitFor({ timeout: 30_000 });
    const text = await error.first().innerText();
    must(!text.includes('[object Object]'), 'Erreur utilisateur lisible attendue');
    ctx.check('#38 dossier inaccessible : erreur visible et lisible', true, { text });
  } finally {
    rmSync(folder);
    renameSync(parked, folder);
  }
}

async function automaticCopy(ctx, life, audio, action) {
  let { page } = life.app;
  await configured(life.app, { workspace: true });
  await newProject(page, 'pack');
  await dropOnTree(page, audio);
  const backupRoot = join(life.workspace, 'sauvegardes');
  const copy = await until(page, 'copie au vrai palier autosave de cinq minutes', () =>
    filesUnder(backupRoot).find(path => dirname(path) === backupRoot && path.endsWith('.mbah')), 360_000);
  const copiedHash = hash(copy);
  await addCatalogueSource(page, backupRoot);
  const matchingCopies = async () => (await catalogueCards(page)).flatMap(card =>
    card.exemplars.filter(exemplar => exemplar.path && resolve(exemplar.path) === resolve(copy) && exemplar.available)
      .map(exemplar => ({ cardId: card.id, exemplarId: exemplar.id })));
  await until(page, 'copie automatique indexée une seule fois', async () => (await matchingCopies()).length === 1, 60_000);
  if (action === 'enregistrer') {
    await save(page, join(ctx.dir('39-explicite'), 'Enregistré.mbah'), { first: true });
    await until(page, 'copie automatique retirée après enregistrement', () => !existsSync(copy));
    await until(page, 'copie retirée du catalogue après enregistrement', async () => (await matchingCopies()).length === 0);
  } else if (action === 'abandonner') {
    await returnHome(page);
    await until(page, 'copie automatique retirée après abandon', () => !existsSync(copy));
    await until(page, 'copie retirée du catalogue après abandon', async () => (await matchingCopies()).length === 0);
  } else {
    await life.restart(false);
    ({ page } = life.app);
    must(existsSync(copy) && hash(copy) === copiedHash, 'Copie gardée intacte après app.stop()');
    await enterCatalogue(page);
    const copies = await until(page, 'un seul exemplaire au catalogue après crash', async () => {
      const matches = await matchingCopies();
      return matches.length === 1 ? matches : false;
    });
    writeFileSync(join(ctx.dir('39-preuves'), 'catalogue-apres-crash.json'), JSON.stringify(await catalogueCards(page), null, 2));
    const card = page.locator(`[data-card-id="${copies[0].cardId}"]`);
    await card.hover();
    await ctx.shot(page, '39-copie-catalogue-avant-ouverture');
    writeFileSync(join(ctx.dir('39-preuves'), 'boutons-carte.json'), JSON.stringify(
      await card.locator('button').evaluateAll(buttons => buttons.map(button => ({
        className: button.className, label: button.getAttribute('aria-label'), text: button.textContent,
      }))), null, 2));
    await card.locator('button.catalogue-card-edit').click();
    await projectMenuButton(page).waitFor({ timeout: 60_000 });
    await treeRoot(page).click();
    await renameTyping(page, treeName(page), 'Modification de la copie ouverte');
    await returnHome(page);
    must(existsSync(copy) && hash(copy) === copiedHash, 'Le fichier ouvert ne doit jamais être supprimé à l’abandon');
    must((await matchingCopies()).length === 1, 'Un seul exemplaire conservé après abandon du fichier ouvert');
  }
  ctx.check(`#39 ${action} : cycle de vie de la copie automatique vérifié sur disque`, true);
}

async function recovery(ctx, life, audio, action, cover = null) {
  let { page } = life.app;
  await newProject(page, 'pack');
  await dropOnTree(page, cover || audio);
  const snapshot = await until(page, 'snapshot anti-crash et médias importés', () => {
    const path = sessionSnapshots()[0];
    if (!path) return false;
    try {
      const story = json(path).rootEntries?.[0];
      return story?.audio && (!cover || story.itemImage) ? path : false;
    } catch { return false; }
  });
  const p = json(snapshot);
  const story = p.rootEntries[0];
  const audioPath = mediaFile(snapshot, story.audio);
  must(existsSync(audioPath), 'Audio de session présent avant arrêt');
  const audioHash = hash(audioPath);
  const imagePath = cover && mediaFile(snapshot, story.itemImage);
  if (cover) must(story.itemImage && existsSync(imagePath), 'Pochette MP3 importée dans le projet');
  const imageHash = cover && hash(imagePath);
  await life.stop();
  ageE2E(dirname(snapshot));
  if (cover) {
    // Purge réelle au prochain démarrage, y compris l'ancienne extraction en cache.
    const cacheImages = join(appDataDirs().local, 'story_studio_images');
    if (existsSync(cacheImages)) ageE2E(cacheImages);
  }
  await life.start(false);
  ({ page } = life.app);
  const row = page.locator('.mode-proj-row--recovery');
  await row.waitFor({ timeout: 30_000 });
  must(existsSync(snapshot) && existsSync(audioPath), 'Le démarrage conserve la session âgée de trois jours');
  if (action === 'ignorer') {
    await row.locator('.mode-proj-dismiss').click();
    await page.locator(MODALS).getByRole('button', { name: 'Supprimer', exact: true }).click();
    await until(page, 'session ignorée supprimée', () => !existsSync(dirname(snapshot)));
    must(await row.count() === 0, 'Reprise retirée de l’accueil');
  } else {
    await row.locator('.mode-proj-open').click();
    await projectMenuButton(page).waitFor();
    await treeStory(page, story.name).click();
    await storyField(page).locator('.audio-bar').waitFor();
    must(hash(audioPath) === audioHash && probeAudio(audioPath).readable, 'Audio repris intact et décodable');
    must(!await hasMissingMediaModal(page, 1500), 'Pas de média introuvable à la reprise');
    if (cover) {
      must(hash(imagePath) === imageHash, 'Pochette conservée après purge de démarrage');
      const image = editorCard(page, "L'histoire").locator('img.image-preview').first();
      await image.waitFor();
      await until(page, 'pochette reprise effectivement décodée par la WebView', () =>
        image.evaluate(element => element.complete && element.naturalWidth > 0));
    }
  }
  ctx.check(`#${cover ? 47 : 45} ${action} : session de trois jours, ${cover ? 'pochette affichée et audio intact' : 'médias présents et cycle de vie vérifié'}`, true);
}

async function cleanIdentity(ctx, app, audio) {
  const { page } = app;
  const path = await basicMenus(page, ctx, '4-identite', audio);
  await returnHome(page);
  const p = json(path);
  p.packMetadata.uuid = '';
  p.packMetadata.originalUuid = '';
  delete p.packUuid;
  writeFileSync(path, JSON.stringify(p));
  await open(page, path);
  // Aucun geste d'édition après ouverture : cas propre sans identifiant persisté.
  must(!json(path).packMetadata.uuid, 'Précondition : UUID absent sur disque');
  must(await page.locator('.chrome-titlebar-status.is-saved').count() === 1, 'Précondition : projet ouvert propre');
  const result = await save(page, path);
  must(/^[0-9a-f-]{36}$/i.test(result.packMetadata.uuid), 'Ctrl+S du projet propre écrit son UUID');
  ctx.check('#4 enregistrer un projet propre écrit son identifiant', true);
}

async function rotations(ctx, app, audio) {
  const { page } = app;
  const path = await basicMenus(page, ctx, '49-seed', audio);
  await returnHome(page);
  const dir = ctx.dir('49-projets');
  const first = join(dir, 'Contes.mbah');
  const second = join(dir, 'Contes.v2.mbah');
  // Le dossier change : figer les références des fixtures contre leur source.
  const absoluteRefs = value => {
    if (Array.isArray(value)) return value.map(absoluteRefs);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, absoluteRefs(item)]));
    return typeof value === 'string' && /^\.\.?[\\/]/.test(value) ? mediaFile(path, value) : value;
  };
  const fixture = absoluteRefs(json(path));
  writeFileSync(first, JSON.stringify({ ...fixture, projectName: 'Contes' }));
  writeFileSync(second, JSON.stringify({ ...fixture, projectName: 'Contes.v2' }));
  const backups = () => filesUnder(join(app.workspace, 'sauvegardes', 'versions-securite'));
  const rotate = async (file, label) => {
    await open(page, file);
    for (let i = 0; i < 4; i++) {
      await treeRoot(page).click();
      await renameTyping(page, treeName(page), `${label} version ${i}`);
      await save(page, file);
    }
    await returnHome(page);
  };
  await rotate(second, 'v2');
  const v2 = backups().filter(path => /^Contes\.v2--/.test(basename(path)));
  must(v2.length === 2, 'Limite de deux versions pour Contes.v2');
  const evidence = v2.map(path => [path, hash(path)]);
  await rotate(first, 'v1');
  const v1 = backups().filter(path => /^Contes--/.test(basename(path)));
  must(v1.length === 2, 'Limite de deux versions pour Contes');
  must(evidence.every(([path, digest]) => existsSync(path) && hash(path) === digest), 'Rotation de Contes sans chasser Contes.v2');
  for (const [file, prefix] of [[v1.sort()[0], 'v1'], [v2.sort()[0], 'v2']]) {
    const expected = json(file).rootName;
    must(expected.startsWith(prefix), 'Version de la bonne famille');
    await openProjectDialog(page, file);
    await treeRoot(page).click();
    must(await treeName(page).inputValue() === expected, 'Ancienne version rouvrable avec son contenu exact');
    must(!await hasMissingMediaModal(page, 1500));
    await returnHome(page);
  }
  ctx.check('#49 Contes / Contes.v2 : deux rotations indépendantes et anciennes versions rouvertes', true);
}

async function graphAndSource(ctx, app, audio) {
  const { page } = app;
  await newProject(page, 'advanced');
  await selectGraphNode(page, 'Écran 1', 'stage');
  await importGraphAudio(page, graphField(page), audio);
  const path = join(ctx.dir('6-graphe'), 'Inspecteur.mbah');
  await save(page, path, { first: true });
  const { project, view } = await readGraphView(page, path);
  const ref = view.stages[0].audio.assetRef;
  must(ref && project.authoring.mediaBindings.some(binding => binding.assetRef === ref), 'Son inspecteur enregistré et lié au graphe');
  await returnHome(page);
  await enterCatalogue(page);
  const source = ctx.dir('6-source-vide');
  // Ajouter une source vide suffit : l'oracle vérifie la source, pas une fiche.
  await addCatalogueSource(page, source);
  ctx.check('#6 son dans l’inspecteur graphe et ajout d’une source temporaire au catalogue e2e', true);
}

async function enterCatalogue(page) {
  await page.locator('#mode-open-catalogue').click();
  await page.locator('#catalogue-search').waitFor({ timeout: 30_000 });
  // La recherche est montée avant la demande asynchrone de consentement.
  const decline = page.locator(MODALS).filter({ hasText: 'Compléter les packs officiels' });
  if (await decline.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    await decline.getByRole('button', { name: 'Non', exact: true }).click();
    await decline.waitFor({ state: 'hidden' });
  }
}

async function relinkSynthetic(ctx, app, audio) {
  const { page } = app;
  const fixture = await sharedFixture(page, ctx, 'graphe', audio);
  const original = (await audioPaths(page, fixture, 'graphe'))[0];
  // Remplacer les deux emplois par l'UI : la liaison initiale devient
  // réellement inutilisée, sans fabriquer de liaison absente dans le JSON.
  for (const [index, frequency] of [660, 880].entries()) {
    const other = synthTone(ctx.dir('37-sources'), `remplacement-${index}.wav`, frequency, 3);
    await selectAudio(page, 'graphe', fixture.names[index]);
    await answerNext(page, 'open', other);
    // contextAction attend les IPC du remplacement, comme #41 et #44.
    await contextAction(page, graphField(page), 'Remplacer l’audio…');
  }
  await save(page, fixture.path);
  const paths = await audioPaths(page, fixture, 'graphe');
  must(paths[0] !== paths[1] && paths.every(path => path !== original), '#37 : deux médias distincts employés');
  const digests = paths.map(hash);
  const { project, view } = await readGraphView(page, fixture.path);
  const unused = project.authoring.mediaBindings.find(binding => mediaFile(fixture.path, binding.path) === original);
  must(unused && !view.stages.some(stage => stage.audio.assetRef === unused.assetRef),
    '#37 : ancienne liaison conservée mais plus employée après remplacement');
  await returnHome(page);
  const mediaDir = dirname(paths[0]);
  const desk = `${mediaDir}-renomme`;
  must(paths.every(path => dirname(path) === mediaDir) && dirname(original) === mediaDir,
    '#37 : les trois médias sont dans le même dossier');
  must(filesUnder(app.workspace).includes(original) && !existsSync(desk),
    '#37 : renommage borné au workspace e2e isolé, destination libre');
  renameSync(mediaDir, desk);
  await openProjectDialog(page, fixture.path);
  const modal = missingMediaModal(page);
  await modal.waitFor({ timeout: 30_000 });
  must(await modal.locator('.relink-row').count() === 2, '#37 : seuls les deux médias employés sont proposés');
  const listed = await modal.locator('.relink-row-name').allInnerTexts();
  must(paths.every(path => listed.includes(basename(path))) && !listed.includes(basename(original)),
    '#37 : noms exacts des médias employés, ancien média exclu');
  writeFileSync(join(ctx.dir('37-preuves'), 'avant-reliaison.json'), JSON.stringify({
    original, unused, paths, digests, mediaDir, desk, listed, project,
  }, null, 2));
  await ctx.shot(page, '37-medias-absents');
  await answerNext(page, 'open', desk);
  await modal.locator('.relink-gbtn').first().click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(page, '#37 : deux médias retrouvés', async () => await modal.locator('.relink-row.is-found').count() === 2);
  await ctx.shot(page, '37-dossier-retrouve');
  const before = hash(fixture.path);
  await modal.getByRole('button', { name: /Appliquer et enregistrer/ }).click();
  await modal.waitFor({ state: 'hidden', timeout: 30_000 });
  await until(page, '#37 : reliaison écrite', () => hash(fixture.path) !== before);
  await page.locator('.save-progress-box').waitFor({ state: 'hidden', timeout: 60_000 });
  const after = await audioPaths(page, fixture, 'graphe');
  writeFileSync(join(ctx.dir('37-preuves'), 'apres-reliaison.json'), JSON.stringify({
    after, hashes: after.map(hash), project: json(fixture.path),
  }, null, 2));
  must(after.every((path, i) => resolve(path) === resolve(join(desk, basename(paths[i]))) && hash(path) === digests[i]),
    '#37 : chemins reliés au dossier choisi et octets intacts');
  ctx.check('#37 graphe : deux médias déplacés, dossier choisi, reliaison enregistrée ; liaison inutilisée exclue', true);
}

async function catalogueCards(page) {
  return page.evaluate(async () => {
    const { catalogueApi } = await import('/src/store/catalogue/catalogueApi.js');
    return (await catalogueApi().listAllEntries()).cards;
  });
}

async function addCatalogueSource(page, source) {
  await page.getByRole('button', { name: /^Préférences de l’application/ }).click();
  await page.locator('.opts-nav').getByRole('button', { name: 'Catalogue', exact: true }).click();
  await page.locator('.opts-nav-item.is-active').filter({ hasText: /^Catalogue$/ }).waitFor();
  const add = page.locator('#catalogue').getByRole('button', { name: 'Ajouter des dossiers', exact: true });
  await answerNext(page, 'open', source);
  await add.first().click();
  await until(page, 'source de catalogue ajoutée', async () =>
    (await page.locator('.opts-catalogue-source .opts-catalogue-path').allInnerTexts()).includes(source));
  await page.keyboard.press('Escape');
}

export async function run(args = []) {
  if (process.env.C10_STEPS) args = process.env.C10_STEPS.split(',').map(name => name.trim()).filter(Boolean);
  const ctx = createRun('c10-recette-0912-editeurs');
  const audio = synthTone(ctx.dir('sources'), 'recit.wav', 440, 4);
  const cover = synthImage(ctx.dir('sources'), 'pochette.png', 2);
  const mp3 = join(ctx.dir('sources'), 'recit-pochette.mp3');
  ffmpeg(['-i', audio, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'png',
    '-id3v2_version', '3', '-disposition:v', 'attached_pic', mp3]);
  let sequence = 0;
  const life = {
    app: null, workspace: null,
    async start(fresh) {
      this.app = await launchApp({ runDir: ctx.dir(`lancement-${++sequence}`), fresh, workspaceDir: this.workspace });
    },
    async stop() {
      if (!this.app) return;
      const app = this.app;
      this.app = null;
      const result = await app.stop();
      ctx.check('profil réel : aucune écriture dans le workspace réel', result.polluted.length === 0, { polluted: result.polluted });
      ctx.check('aucune exception JavaScript', !app.events.faults().some(fault => fault.kind === 'pageerror'), { faults: app.events.faults() });
    },
    async restart(fresh) { await this.stop(); await this.start(fresh); },
  };
  const steps = [
    ['#37-relink-graphe', () => relinkSynthetic(ctx, life.app, audio)],
    ['#40-dupliquer', () => folders(ctx, life.app, audio, 'dupliquer')],
    ['#40-copier-coller', () => folders(ctx, life.app, audio, 'copier-coller')],
    ...['menus', 'graphe'].flatMap(mode => [
      [`#41-${mode}-ailleurs`, () => cutShared(ctx, life.app, audio, mode, false)],
      [`#41-${mode}-meme-champ`, () => cutShared(ctx, life.app, audio, mode, true)],
      [`#44-${mode}`, () => audioCopy(ctx, life.app, audio, mode)],
    ]),
    ['#43-inspecteurs', () => names(ctx, life.app, audio)],
    ...['enregistrer', 'ouvrir'].map(action => [`#38-${action}`, async () => {
      const long = synthTone(ctx.dir(`38-charge-${action}`), 'long.wav', 330, 1800);
      await generation(ctx, life.app, long, action);
    }]),
    ['#38-inaccessible', () => inaccessible(ctx, life.app, audio)],
    ...['enregistrer', 'abandonner', 'crash-rouvrir'].map(action =>
      [`#39-${action}`, () => automaticCopy(ctx, life, audio, action)]),
    ['#45-reprendre', () => recovery(ctx, life, audio, 'reprendre')],
    ['#45-ignorer', () => recovery(ctx, life, audio, 'ignorer')],
    ['#47-pochette', () => recovery(ctx, life, audio, 'reprendre', mp3)],
    ['#49-rotations', () => rotations(ctx, life.app, audio)],
    ['#4-identifiant', () => cleanIdentity(ctx, life.app, audio)],
    ['#6-graphe-source', () => graphAndSource(ctx, life.app, audio)],
  ];
  for (const [name, body] of steps) {
    if (args.length && !args.includes(name)) continue;
    life.workspace = ctx.dir('workspaces', name.replace(/[^a-z0-9-]/gi, ''));
    try {
      await life.start(true);
      await configured(life.app);
      life.app.events.setStep(name);
      await body();
      await ctx.shot(life.app.page, name.replace('#', 'point-'));
    } catch (error) {
      ctx.check(`${name} : ${error.message}`, false, { stack: error.stack });
      if (life.app) await ctx.shot(life.app.page, `echec-${name.replace('#', '')}`).catch(() => {});
    } finally { await life.stop(); }
  }
  must(!args.length || steps.some(([name]) => args.includes(name)), 'Filtre sans étape connue');
  ctx.check('🙋 Hugs : écoute et rendu visuel fin ; les octets et le décodage ne jugent pas la perception', null);
  return ctx.finish();
}
