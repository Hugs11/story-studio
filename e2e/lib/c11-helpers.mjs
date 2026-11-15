import { until, save } from './c10-helpers.mjs';
import { answerNext } from './dialogs.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { newProject, generatePack, returnHome } from './actions.mjs';
import { dropOnTree, setPackTitle, editorCard, pickImageField, pickAudioField } from './c2-helpers.mjs';
import { synthTone, synthImage } from './fixtures.mjs';

export async function catalogueRead(page, method) {
  return page.evaluate(async method => {
    const { catalogueApi } = await import('/src/store/catalogue/catalogueApi.js');
    const result = await catalogueApi()[method]();
    return method === 'listAllEntries' ? result.cards : result.items;
  }, method);
}
export const cards = page => catalogueRead(page, 'listAllEntries');
export const operations = page => catalogueRead(page, 'listOperations');
export async function settledScans(page) {
  return until(page, 'scans terminés', async () => {
    const ops = await operations(page);
    return ops.every(op => ['success', 'partial', 'failed', 'cancelled'].includes(op.status)) && ops;
  }, 120_000);
}
export async function preferences(page) {
  await page.getByRole('button', { name: /^Préférences de l’application/ }).click();
  await page.locator('.opts-nav').getByRole('button', { name: 'Catalogue', exact: true }).click();
  await page.locator('#catalogue').getByRole('button', { name: 'Forcer la ré-analyse de tous les packs', exact: true }).waitFor();
}
export async function closePreferences(page) {
  await page.locator('.opts-modal-box .modal-close').click();
  await page.locator('.opts-modal-box').waitFor({ state: 'hidden' });
}
export async function openCatalogue(page) {
  await page.locator('#mode-open-catalogue').click();
  await page.locator('main.catalogue-screen').waitFor();
  const no = page.getByRole('alertdialog').getByRole('button', { name: 'Non', exact: true });
  if (await no.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await no.click();
}
export async function addSource(page, path) {
  const before = (await operations(page)).length;
  await answerNext(page, 'open', path);
  await page.locator('#catalogue').getByRole('button', { name: 'Ajouter des dossiers', exact: true }).click();
  await until(page, 'départ du scan ajouté', async () => (await operations(page)).length > before);
}

export async function packFixture(ctx, app, title = 'Pack témoin', destination = null, projectPath = null) {
  const { page, events } = app;
  const audio = synthTone(ctx.dir('medias'), `${title}.wav`, 440, 2);
  const image = synthImage(ctx.dir('medias'), `${title}.png`);
  await newProject(page, 'pack');
  const root = page.locator('.root-identity-card');
  assert(await pickImageField(page, root, image));
  assert(await pickAudioField(page, root, 'Titre audio', audio));
  await dropOnTree(page, audio);
  const story = editorCard(page, "L'histoire");
  assert(await pickImageField(page, story, image));
  assert(await pickAudioField(page, story, 'Audio de sélection', audio));
  assert(await setPackTitle(page, title), 'Titre du pack appliqué');
  const result = await generatePack(page, ctx.dir('exports', title), { events });
  assert(result.zip, JSON.stringify(result));
  if (projectPath) await save(page, projectPath, { first: true });
  await returnHome(page);
  if (!destination) return result.zip;
  const target = join(destination, `${title}.zip`);
  renameSync(result.zip, target);
  return target;
}
export async function indexed(ctx, app, count = 2, long = false) {
  const source = long ? ctx.dir('sources', 'emplacement connu avec espaces et accents é'.repeat(2), 'chemin long pour le dernier emplacement'.repeat(2)) : ctx.dir('source');
  const paths = [];
  for (let i = 0; i < count; i++) paths.push(await packFixture(ctx, app, `Témoin ${i + 1}`, source));
  await openCatalogue(app.page);
  await preferences(app.page);
  await addSource(app.page, source);
  await settledScans(app.page);
  await closePreferences(app.page);
  await until(app.page, 'fiches des packs fabriqués', async () => (await cards(app.page)).length === count);
  return { source, paths, cards: await cards(app.page) };
}
export async function refreshAll(page) {
  await preferences(page);
  const before = (await operations(page)).map(op => op.operationId ?? op.id);
  await page.locator('#catalogue').getByRole('button', { name: 'Forcer la ré-analyse de tous les packs', exact: true }).click();
  await until(page, 'scan forcé créé', async () => (await operations(page)).some(op => !before.includes(op.operationId ?? op.id)));
  await settledScans(page);
  await closePreferences(page);
}
