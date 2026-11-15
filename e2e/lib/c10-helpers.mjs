// Recette 0.9.12 : attentes sur disque et gestes UI, sans mutation du store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { appDataDirs, APP_IDENTIFIER } from './config.mjs';
import { answerNext } from './dialogs.mjs';
import { keepSessionMediaIfPrompted, saveProjectAs } from './c2-helpers.mjs';

export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    assert(!entry.isSymbolicLink(), `Lien inattendu dans les fixtures : ${path}`);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

export async function until(page, description, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(`Attente expirée : ${description} (${timeout} ms)`);
}

export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const mediaFile = (projectPath, ref) => isAbsolute(ref) ? ref : resolve(dirname(projectPath), ref);

// networkidle peut être déjà atteint au moment où un clic lance son async
// onPick. Observer les requêtes avant le geste et une période calme après.
export async function settledGesture(page, action) {
  const pending = new Set();
  let changed = Date.now();
  const start = request => {
    if (!request.url().startsWith('http://ipc.localhost/')) return;
    pending.add(request);
    changed = Date.now();
  };
  const end = request => {
    if (pending.delete(request)) changed = Date.now();
  };
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  try {
    await action();
    changed = Date.now();
    await until(page, 'fin des IPC du geste utilisateur', () => !pending.size && Date.now() - changed >= 750, 60_000);
  } finally {
    page.off('request', start);
    page.off('requestfinished', end);
    page.off('requestfailed', end);
  }
}

export async function save(page, path, { first = false } = {}) {
  await page.locator('.save-progress-box').waitFor({ state: 'hidden', timeout: 60_000 });
  const before = existsSync(path) ? statSync(path).mtimeMs : null;
  if (first) await saveProjectAs(page, path);
  else {
    await page.keyboard.press('Control+s');
    await keepSessionMediaIfPrompted(page);
  }
  await until(page, `écriture de ${path}`, () => existsSync(path)
    && statSync(path).mtimeMs !== before && statSync(path).size > 0);
  // Le rename disque précède la publication React et la fermeture de la
  // progression. Un raccourci lancé dans cet intervalle est perdu ou rend
  // l'enregistrement courant périmé ; le disque seul n'est pas une barrière UI.
  await page.locator('.save-progress-box').waitFor({ state: 'hidden', timeout: 60_000 });
  return json(path);
}

export async function contextAction(page, field, name) {
  await field.click({ button: 'right' });
  await settledGesture(page, () => page.locator('.ctx-menu').getByRole('menuitem', { name, exact: true }).click());
  // La fermeture du menu précède l'import, l'extraction de pochette et, dans
  // le graphe, le geste Rust. Attendre ces IPC avant de lire/enregistrer.
}

export async function editAudio(page, field, { fade = 'in', cancel = false, restore = false } = {}) {
  await field.getByRole('button', { name: 'Éditer l’audio', exact: true }).click();
  const modal = page.locator('.audio-editor-modal');
  await modal.waitFor();
  await until(page, 'forme d’onde chargée', async () => !await modal.locator('.audio-editor-zoom-slider').isDisabled());
  if (restore) await settledGesture(page, () => modal.getByRole('button', { name: 'Restaurer l’original', exact: true }).click());
  else {
    await modal.locator('.audio-editor-fade-chip').nth(fade === 'in' ? 0 : 1).click();
    const popover = page.locator('.audio-editor-fade-popover');
    const slider = popover.locator('input[type="range"]');
    await slider.focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    await popover.getByRole('button', { name: 'OK', exact: true }).click();
    const apply = modal.getByRole('button', { name: 'Valider les modifications', exact: true });
    await apply.waitFor({ timeout: 60_000 });
    await until(page, 'aperçu prêt à valider', async () => !await apply.isDisabled(), 60_000);
    await settledGesture(page, () => modal.getByRole('button', { name: cancel ? 'Annuler' : 'Valider les modifications', exact: true }).click());
  }
  await modal.waitFor({ state: 'hidden', timeout: 60_000 });
  // onConfirm ferme la modale avant la fin du onPick asynchrone du champ.
}

export function sessionSnapshots() {
  const root = appDataDirs().local;
  assert(root && root.endsWith(APP_IDENTIFIER), 'Profil e2e requis');
  return filesUnder(join(root, 'sessions')).filter(path => path.endsWith('.session-recovery.mbah'));
}

// Ne touche qu'au profil e2e, après app.stop(). Régression : purge à 24 h.
export function ageE2E(path) {
  const root = appDataDirs().local;
  assert(root && root.endsWith(APP_IDENTIFIER));
  const rel = relative(root, path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Antidatage hors profil e2e interdit');
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const file of filesUnder(path)) utimesSync(file, old, old);
  utimesSync(path, old, old);
}

export async function importGraphAudio(page, field, audio) {
  await answerNext(page, 'open', audio);
  await field.locator('.audio-empty-import').click();
  await field.locator('.audio-bar').waitFor({ timeout: 30_000 });
}
