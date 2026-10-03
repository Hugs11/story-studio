// Médias déplacés d'un projet graphe : session reprise, puis relink.
//
// Phase A — session non enregistrée : un pack importé dans l'Éditeur graphe,
// deux de ses médias de session déplacés pendant que l'app est tuée, reprise,
// remise en place, puis premier enregistrement. Relève la proposition de
// relier (aucun chemin d'enregistrement : rien n'est attendu) et le tri
// « Médias non utilisés », qui ne doit lister aucun média lié au graphe.
//
// Phase B — projet enregistré : deux médias liés déplacés hors du projet,
// réouverture, « Médias introuvables », « Choisir le dossier » vers le
// dossier où ils sont. Le retour d'une vraie boîte de dialogue redonne le
// focus à la fenêtre : le parcours rejoue ce `focus` après la réponse.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack, projectMenuButton } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { smallestArchive } from '../lib/corpus.mjs';
import { managedDirsBeside, missingMediaModal, openMediaExplorer, openProjectDialog } from '../lib/c2-helpers.mjs';

const SESSIONS_DIR = join(process.env.LOCALAPPDATA ?? '', 'com.hugs11.story-studio.e2e', 'sessions');

function readBindings(projectPath) {
  const file = JSON.parse(readFileSync(projectPath, 'utf8'));
  return { bindings: file.authoring?.mediaBindings ?? [], library: file.mediaLibraryPaths ?? [] };
}

// Chemin sur disque d'une liaison : absolu (emplacement de travail) ou relatif
// au dossier du `.mbah` (anciens projets).
function bindingFile(projectDir, path) {
  return isAbsolute(path) ? path : join(projectDir, path);
}

function isInside(path, dir) {
  const rel = relative(dir, path);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function latestSessionDir() {
  if (!existsSync(SESSIONS_DIR)) return null;
  const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return dirs.length ? join(SESSIONS_DIR, dirs[dirs.length - 1].name) : null;
}

function filesUnder(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

// Les deux plus gros médias audio : ceux d'un vrai contenu, pas d'un menu muet.
function pickTwoMedia(files) {
  return files
    .filter((path) => /\.(mp3|ogg|wav)$/i.test(path))
    .map((path) => ({ path, size: readFileSync(path).length }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 2)
    .map((item) => item.path);
}

async function relinkState(page) {
  const modal = missingMediaModal(page);
  return {
    open: await modal.count() > 0,
    rows: await modal.locator('.relink-row').count().catch(() => 0),
    found: await modal.locator('.relink-row.is-found').count().catch(() => 0),
    progress: await modal.locator('.relink-progress-label').innerText().catch(() => null),
  };
}

// Arguments : `copie` active « Copier les fichiers importés » ; `attente`
// laisse l'app tourner 20 s avec les médias absents avant de les remettre.
export async function run(args = []) {
  const ctx = createRun('c6-medias-graphe');
  const workspaceDir = ctx.dir('workspace');
  const outside = ctx.dir('hors-projet');
  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page } = app;
  try {
    // ================= Phase A — session reprise =================
    if (args.includes('copie')) {
      await page.evaluate(() => localStorage.setItem('copyImportedFiles', 'true'));
      await page.reload();
      await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    }
    const archive = smallestArchive('01 - Editable');
    await importPack(page, archive, { editor: 'graphe' });
    await page.waitForTimeout(8000);
    const sessionDir = latestSessionDir();
    const sessionFiles = filesUnder(sessionDir).filter((path) => !path.endsWith('.mbah'));
    ctx.check('[A] session créée avec ses médias', !!sessionDir && sessionFiles.length > 0, { sessionDir, count: sessionFiles.length, files: sessionFiles.map((path) => path.slice(sessionDir.length + 1)) });
    await app.stop();

    const moved = pickTwoMedia(sessionFiles);
    const parked = moved.map((path) => join(outside, `session-${path.split(/[\\/]/).pop()}`));
    moved.forEach((path, index) => renameSync(path, parked[index]));
    ctx.check('[A] deux médias de session déplacés pendant l’arrêt', moved.length === 2, { moved });

    app = await launchApp({ runDir: ctx.dir('relance-reprise'), fresh: false, workspaceDir });
    ({ page } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    await page.locator('.mode-proj-row--recovery .mode-proj-open').first().click();
    await projectMenuButton(page).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(4000);
    await openMediaExplorer(page);
    const missingBadges = await page.locator('.media-missing-badge').count();
    const relinkOnRecovery = await missingMediaModal(page).count() > 0;
    await ctx.shot(page, 'a01-reprise-medias-manquants');
    ctx.check('[A] médiathèque : les deux médias déplacés sont marqués introuvables', missingBadges >= 2, { missingBadges });
    ctx.check('[A] fait : « Médias introuvables » proposé à la reprise (null = non)', relinkOnRecovery ? true : null);

    // L'app tourne un moment avec les médias absents (instantané de reprise
    // réécrit entre-temps), comme un auteur qui constate puis va les chercher.
    await page.waitForTimeout(args.includes('attente') ? 20_000 : 0);
    moved.forEach((path, index) => renameSync(parked[index], path));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(3000);
    const badgesAfterRestore = await page.locator('.media-missing-badge').count();
    ctx.check('[A] médias remis en place : plus aucun marqué introuvable', badgesAfterRestore === 0, { badgesAfterRestore });

    const projectDir = ctx.dir('projet');
    const projectPath = join(projectDir, 'Projet relink.mbah');
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    const triage = page.locator('.session-triage-box');
    const triageShown = await triage.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const triageItems = triageShown ? await triage.locator('.session-triage-name').allInnerTexts() : [];
    const triageTitles = triageShown
      ? await triage.locator('.session-triage-name').evaluateAll((nodes) => nodes.map((node) => node.title))
      : [];
    await ctx.shot(page, 'a02-tri-medias-session');
    if (triageShown) await triage.getByRole('button', { name: /Conserver la sélection/ }).click();
    await page.waitForTimeout(5000);
    ctx.check('[A] enregistrement écrit le .mbah', existsSync(projectPath));
    ctx.check('[A] « Médias non utilisés » ne propose aucun média de session', !triageShown, { triageItems, triageTitles, moved });
    if (existsSync(projectPath)) {
      const { bindings, library } = readBindings(projectPath);
      const missing = bindings.filter((binding) => !binding.path || !existsSync(bindingFile(projectDir, binding.path)));
      ctx.check('[A] toutes les liaisons du graphe désignent un fichier existant', missing.length === 0, { missing, libraryCount: library.length, bindingCount: bindings.length });
      // Option workspace désactivée, `.mbah` hors de l'emplacement de travail :
      // les médias de la session ont rejoint l'emplacement de travail.
      const outside = bindings.filter((binding) => binding.path && !isInside(bindingFile(projectDir, binding.path), workspaceDir));
      ctx.check('[A] toutes les liaisons désignent un fichier de l’emplacement de travail', outside.length === 0, { outside });
      const beside = managedDirsBeside(projectDir);
      ctx.check('[A] aucun sous-dossier de médias créé à côté du .mbah', beside.length === 0, { beside });
    }

    // ================= Phase B — relink d'un projet enregistré =================
    await app.stop();
    const { bindings } = readBindings(projectPath);
    const bound = bindings.slice(0, 2).map((binding) => bindingFile(projectDir, binding.path));
    const desk = ctx.dir('bureau');
    bound.forEach((path) => renameSync(path, join(desk, path.split(/[\\/]/).pop())));
    ctx.check('[B] deux médias liés déplacés hors du projet', bound.every((path) => !existsSync(path)), { bound });

    app = await launchApp({ runDir: ctx.dir('relance-relink'), fresh: false, workspaceDir });
    ({ page } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    await openProjectDialog(page, projectPath);
    const modalShown = await missingMediaModal(page).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    ctx.check('[B] « Médias introuvables » s’ouvre à la réouverture', modalShown, await relinkState(page));

    if (modalShown) {
      // Choix du dossier, puis retour de focus comme après une vraie boîte.
      await answerNext(page, 'open', desk);
      await page.locator('.relink-gbtn').first().click();
      await page.waitForTimeout(1500);
      const beforeFocus = await relinkState(page);
      ctx.check('[B] fait : état juste après la réponse du dialogue, avant le retour de focus', true, { beforeFocus, dialogs: (await dialogLog(page)).slice(-2) });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForTimeout(3000);
      const afterFolder = await relinkState(page);
      await ctx.shot(page, 'b01-apres-choix-du-dossier');
      ctx.check('[B] « Choisir le dossier » relie les deux médias (retour de focus compris)', afterFolder.found === 2, afterFolder);

      if (afterFolder.found === 2) {
        await missingMediaModal(page).getByRole('button', { name: /Appliquer et enregistrer/ }).click();
        await page.waitForTimeout(6000);
        const after = readBindings(projectPath).bindings.slice(0, 2);
        ctx.check('[B] le fichier enregistré désigne les médias reliés', after.every((binding) => existsSync(bindingFile(projectDir, binding.path))), { after });
        ctx.check('[B] la boîte se ferme après application', !(await relinkState(page)).open);
      }
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    await app.stop();
  }
  return ctx.finish();
}
