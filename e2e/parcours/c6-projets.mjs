// Projets `.mbah` réels de l'auteur (`Documents\story-studio\sauvegardes`,
// forme 0.9.8 : schéma 3, mode Libre). Noms réels dans `e2e/local.config.json`
// (clé `c6Projects`, ignorée par git) ou `SS_E2E_C6_PROJECTS` ; jamais
// versionnés ici. Toujours sur une **copie** du `.mbah` ; les médias qu'il
// référence par chemin absolu restent lus à leur place dans le vrai workspace,
// jamais modifiés (garde-fou `stop().polluted`) ; ceux qu'il référence par
// chemin relatif sont recopiés à côté de la copie.
//
// Une passe, et chaque projet de la liste la fait en entier :
// 1. ouvert : ouverture de la copie ; une boîte « Médias introuvables » est
//    relevée puis fermée par « Ignorer tout » (rien n'est relié) ;
// 2. enregistré : Ctrl+S réécrit le fichier (date de modification), puis
//    retour à l'accueil, réouverture, et même nombre de nœuds de l'arbre
//    (`[data-tree-node-id]`) avant et après ;
// 3. régénéré : génération (`generatePack`, qui échoue sous 30 s si aucune
//    commande de génération ne part) ;
// 4. relu : validateur Lunii, lecteur de l'app et STUdio (`readbackPack`).
// Un verdict par projet porte ces quatre faits.
//
// Chaque étape passe par `withStallGuard` : si ni l'écran ni l'IPC ne bougent
// pendant 60 s, l'étape échoue tout de suite avec ce qui est à l'écran, au lieu
// d'attendre son plafond. L'app est alors relancée pour le projet suivant.
import { existsSync, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { E2E_DIR, localList } from '../lib/config.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { generatePack, goHome, returnHome, projectMenuButton } from '../lib/actions.mjs';
import { openProjectDialog, dismissMissingMediaModalIfPresent, keepSessionMediaIfPrompted } from '../lib/c2-helpers.mjs';
import { withStallGuard, describeScreen } from '../lib/c6-helpers.mjs';
import { readbackPack } from '../lib/oracles.mjs';

function projectsDir() {
  if (process.env.SS_E2E_C6_PROJECTS_DIR) return process.env.SS_E2E_C6_PROJECTS_DIR;
  const localFile = join(E2E_DIR, 'local.config.json');
  if (existsSync(localFile)) {
    const local = JSON.parse(readFileSync(localFile, 'utf8'));
    if (local.c6ProjectsDir) return local.c6ProjectsDir;
  }
  return join(homedir(), 'Documents', 'story-studio', 'sauvegardes');
}

const PROJECT_NAMES = localList('SS_E2E_C6_PROJECTS', 'c6Projects');

// Un chemin relatif (`./voix-generees/…`) se résout contre le dossier du
// `.mbah` : la copie ne le retrouverait pas. On recopie ces fichiers à côté
// d'elle, au même chemin relatif ; les chemins absolus restent lus en place.
function copyRelativeMedia(source, copyDir) {
  const sourceDir = dirname(source);
  const relative = new Set();
  (function walk(value) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    else if (typeof value === 'string' && /^\.\.?[\\/]/.test(value)) relative.add(value);
  })(JSON.parse(readFileSync(source, 'utf8')));
  let copied = 0;
  for (const ref of relative) {
    const from = resolve(sourceDir, ref);
    if (!existsSync(from) || !statSync(from).isFile()) continue;
    const to = resolve(copyDir, ref);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

async function treeNodeCount(page) {
  return page.locator('[data-tree-node-id]').count();
}

// Ouvre la copie et ferme « Médias introuvables » si elle vient.
async function openCopy(page, copyPath) {
  // Depuis un éditeur seulement : sur l'accueil, le bouton « Projet » n'existe
  // pas et `returnHome` attendrait pour rien.
  if (await projectMenuButton(page).count()) await returnHome(page);
  await goHome(page);
  const opened = await openProjectDialog(page, copyPath, { timeout: 180_000 });
  const missingMedia = opened ? await dismissMissingMediaModalIfPresent(page) : null;
  return { opened, missingMedia };
}

// Ctrl+S sur le chemin déjà connu : aucun dialogue, le fichier est réécrit.
async function saveInPlace(page, copyPath) {
  const before = statSync(copyPath).mtimeMs;
  await page.keyboard.press('Control+s');
  await keepSessionMediaIfPrompted(page);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (statSync(copyPath).mtimeMs > before) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function checkProject(ctx, session, name, source) {
  const { page, events } = session;
  const guard = (label, action, options) => withStallGuard(page, events, `${name} — ${label}`, action, options);
  const copyPath = join(ctx.dir('projets', name), `${name}.mbah`);
  copyFileSync(source, copyPath);
  const rec = {
    name,
    sizeBytes: statSync(source).size,
    relativeMediaCopied: copyRelativeMedia(source, dirname(copyPath)),
    verdict: { ouvert: null, enregistre: null, regenere: null, relu: null },
  };

  // 1. Ouvert.
  events.setStep(`ouverture-${name}`);
  const first = await guard('ouverture', () => openCopy(page, copyPath));
  rec.verdict.ouvert = first.opened;
  rec.missingMediaAtOpen = first.missingMedia;
  if (!first.opened) {
    rec.reason = 'ouverture échouée ou trop lente (> 180 s)';
    return rec;
  }
  const pill = page.locator('[data-toolbar-id="toggleValidation"]').first();
  rec.validationPillText = await pill.count() ? await pill.innerText().catch(() => null) : null;
  rec.treeNodeCountBeforeSave = await treeNodeCount(page);
  await ctx.shot(page, `${name}-ouvert`);

  // 2. Enregistré : réécriture, puis aller-retour disque.
  events.setStep(`enregistrement-${name}`);
  rec.rewritten = await guard('enregistrement', () => saveInPlace(page, copyPath));
  const second = await guard('réouverture', () => openCopy(page, copyPath));
  rec.reopenedOk = second.opened;
  rec.missingMediaAtReopen = second.missingMedia;
  if (second.opened) {
    rec.treeNodeCountAfterReopen = await treeNodeCount(page);
    rec.sameNodeCountAfterRoundTrip = rec.treeNodeCountAfterReopen === rec.treeNodeCountBeforeSave;
  }
  rec.verdict.enregistre = Boolean(rec.rewritten && second.opened && rec.sameNodeCountAfterRoundTrip);
  await ctx.shot(page, `${name}-apres-aller-retour`);
  if (!second.opened) {
    rec.reason = 'réouverture après enregistrement impossible';
    return rec;
  }

  // 3. Régénéré. Un projet sans type n'affiche aucun bouton « Générer le
  // pack » : c'est un échec de régénération, dit comme tel.
  events.setStep(`generation-${name}`);
  if (await page.getByRole('button', { name: /Générer le pack/ }).first().count() === 0) {
    rec.verdict.regenere = false;
    rec.reason = 'aucun bouton « Générer le pack » (projet sans type ?)';
    return rec;
  }
  const outDir = ctx.dir('sortie', name);
  const startedAt = Date.now();
  const gen = await guard('génération', () => generatePack(page, outDir, { uuid: 'keep', timeout: 600_000, events }));
  rec.generationMs = Date.now() - startedAt;
  rec.verdict.regenere = Boolean(gen.zip);
  if (!gen.zip) {
    rec.reason = gen.timeout ? 'génération au-delà de 10 min' : (gen.refusal ?? 'aucune archive');
    rec.screenAfterGeneration = await describeScreen(page);
    return rec;
  }

  // 4. Relu.
  events.setStep(`relecture-${name}`);
  const readback = await readbackPack(page, gen.zip, ctx.dir('studio', name));
  rec.verdict.relu = readback.ok;
  rec.appScreens = readback.storyStudio?.stageNodes ?? null;
  rec.studioScreens = readback.studio?.stageNodes ?? null;
  rec.readback = readback;
  await ctx.shot(page, `${name}-regenere`);
  return rec;
}

export async function run() {
  const ctx = createRun('c6-projets');
  const dir = projectsDir();
  const workspaceDir = ctx.dir('workspace');
  const missing = PROJECT_NAMES.filter((name) => !existsSync(join(dir, `${name}.mbah`)));
  if (!PROJECT_NAMES.length || missing.length) {
    ctx.check('les projets désignés (c6Projects) sont renseignés et présents', false, { dir, missing });
    return ctx.finish();
  }

  let session = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const allFaults = [];
  const results = [];

  for (const name of PROJECT_NAMES) {
    let rec;
    try {
      rec = await checkProject(ctx, session, name, join(dir, `${name}.mbah`));
    } catch (error) {
      rec = {
        name,
        verdict: { ouvert: null, enregistre: null, regenere: null, relu: null },
        reason: String(error?.message ?? error),
        stall: error?.name === 'ScreenStalledError' ? error.detail : null,
      };
      await ctx.shot(session.page, `${name}-interrompu`).catch(() => {});
    }
    allFaults.push(...session.events.faults());
    const { ouvert, enregistre, regenere, relu } = rec.verdict;
    ctx.check(
      `${name} : ouvert ${ouvert ? 'oui' : 'non'}, enregistré ${enregistre ? 'oui' : 'non'}, régénéré ${regenere ? 'oui' : 'non'}, relu ${relu ? 'oui' : 'non'}`
        + (rec.reason ? ` — ${rec.reason}` : ''),
      Boolean(ouvert && enregistre && regenere && relu),
      rec,
    );
    results.push(rec);

    // Après un échec (écran figé, exception, refus), l'état de la fenêtre est
    // inconnu : le projet suivant repart d'une app relancée.
    if (!(ouvert && enregistre && regenere && relu)) {
      const stop = await session.stop();
      if (stop.polluted.length) ctx.check(`${name} : rien d’écrit dans le vrai workspace`, false, { polluted: stop.polluted });
      session = await launchApp({ runDir: ctx.dir('relance', name), fresh: false, workspaceDir });
    }
  }

  // Relevé, comme avant : des projets réels peuvent journaliser des erreurs
  // sans que leur parcours échoue ; le verdict est porté par projet.
  ctx.check('[relevé] erreurs console et exceptions cumulées', true, { faultsTotal: allFaults.length, faults: allFaults.slice(0, 20) });
  const stop = await session.stop({ graceful: true });
  ctx.check('rien d’écrit dans le vrai workspace (fin de parcours)', stop.polluted.length === 0, { polluted: stop.polluted });

  return ctx.finish({
    results: results.map(({ readback, ...rest }) => ({ ...rest, readbackOk: readback?.ok ?? null })),
  });
}
