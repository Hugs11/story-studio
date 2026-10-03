// Parité simulation projet / archive produite, Éditeur par menus.
//
// Pour chaque projet : trace A (simuler le projet depuis la racine, via
// « Lancer le simulateur »), génération, trace B (simuler l'archive produite,
// via « Simuler ce pack… » sur un nœud créé en déposant le zip produit dans
// l'arbre — le point d'entrée réel qui joue une archive telle quelle, pas une
// réimportation dans un nouvel éditeur). Comparaison étape par étape
// (`compareTraces`), écrans/image/boutons/durée audio — jamais les chemins de
// fichiers, qui diffèrent structurellement entre projet et archive.
//
// Jeux de test : 2 packs `01 - Editable` (les plus petits, pour tenir dans le
// périmètre — sélection dynamique, aucun nom versionné) + des projets
// utilisateur choisis pour leur couverture de fonctions (message de fin global,
// mode nuit, next_story, prompt de fin local, dossiers profonds). Leurs noms
// viennent de `SS_E2E_C3B_USER_PROJECTS` ou de la clé `c3bUserProjects` de
// `local.config.json`.
//
// Contre-épreuve intégrée sur le premier pack Editable : un script décalé
// d'un pas doit faire échouer `compareTraces`, sinon l'oracle ne vaut rien.
import { existsSync, copyFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { E2E_DIR, config, localList } from '../lib/config.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { generatePack, goHome, importPack, returnHome } from '../lib/actions.mjs';
import { openProjectDialog, dismissMissingMediaModalIfPresent } from '../lib/c2-helpers.mjs';
import { smallestArchives } from '../lib/corpus.mjs';
import { readStoryJson } from '../lib/oracles.mjs';
import { dropFiles } from '../lib/drop.mjs';
import {
  DEFAULT_SCRIPT, runTrace, compareTraces, launchSimulatorFromToolbar,
  closeSimulator, waitForSimulator, openTreeContextMenu, clickContextMenuItem,
} from '../lib/simulator.mjs';

const EDITABLE_DIR = '01 - Editable';
const CORPUS_COUNT = Number(process.env.SS_E2E_C3B_CORPUS_COUNT || 2);

function userProjectsDir() {
  if (process.env.SS_E2E_USER_PROJECTS_DIR) return process.env.SS_E2E_USER_PROJECTS_DIR;
  const localFile = join(E2E_DIR, 'local.config.json');
  if (existsSync(localFile)) {
    const local = JSON.parse(readFileSync(localFile, 'utf8'));
    if (local.userProjectsDir) return local.userProjectsDir;
  }
  return join(homedir(), 'Documents', 'story-studio', 'sauvegardes');
}

// Choisis pour leur couverture de fonctions (voir bandeau ci-dessus).
const USER_PROJECTS = localList('SS_E2E_C3B_USER_PROJECTS', 'c3bUserProjects');

function reportDataDir() {
  const dir = config.c3bReportDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tracePath(dataDir, ctx, label, side) {
  const dir = dataDir || ctx.dir('donnees');
  return join(dir, `c3b-menus-${label}-trace-${side}.jsonl`);
}

function writeTrace(path, trace) {
  const lines = trace.steps.map((step) => JSON.stringify(step));
  appendFileSync(path, `${lines.join('\n')}\n`);
}

async function traceProjectFromRoot(page, ctx, label, script = DEFAULT_SCRIPT) {
  await launchSimulatorFromToolbar(page);
  await waitForSimulator(page);
  const trace = await runTrace(page, script);
  await ctx.shot(page, `${label}-A-projet`);
  await closeSimulator(page);
  await page.waitForTimeout(300);
  return trace;
}

// Dépose le zip produit dans l'arbre (crée un nœud « zip » — c'est aussi le
// fait « pack importé posé dans l'arbre »), puis « Simuler ce pack… » sur ce
// nœud (le plus récent, pas de dépendance au libellé affiché).
async function traceProducedArchive(page, ctx, label, zipPath, script = DEFAULT_SCRIPT) {
  const before = await page.locator('.tree-item--zip').count();
  await dropFiles(page, '[data-os-drop-zone="treepanel"]', [zipPath]);
  await page.waitForTimeout(2000);
  const zipNodes = page.locator('.tree-item--zip');
  await zipNodes.nth(before).waitFor({ timeout: 20_000 }).catch(() => {});
  const zipNode = zipNodes.last();
  const posedInTree = (await zipNodes.count()) > before;
  await zipNode.scrollIntoViewIfNeeded().catch(() => {});
  await zipNode.click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await menu.waitFor({ timeout: 5_000 });
  await menu.getByRole('menuitem', { name: /Simuler ce pack/ }).first().click();
  await waitForSimulator(page);
  const trace = await runTrace(page, script);
  await ctx.shot(page, `${label}-B-archive`);
  await closeSimulator(page);
  await page.waitForTimeout(300);
  return { trace, posedInTree };
}

async function runOne(page, ctx, { key, label, open, dataPath, dataDir }) {
  const rec = { key, label };
  await goHome(page).catch(() => {});
  await open();
  await page.waitForTimeout(500);
  rec.missingMedia = await dismissMissingMediaModalIfPresent(page);
  if (rec.missingMedia.appeared) {
    ctx.check(`${label} : médias introuvables relevés à l’ouverture (fait, pas un verdict)`, true, rec.missingMedia);
  }
  rec.traceA = await traceProjectFromRoot(page, ctx, label);
  writeTrace(tracePath(dataDir, ctx, label, 'A-projet'), rec.traceA);
  const outDir = ctx.dir('sortie', key);
  const gen = await generatePack(page, outDir, { uuid: 'keep' });
  rec.generationOk = Boolean(gen.zip);
  rec.refusal = gen.refusal ?? (gen.timeout ? 'timeout' : null);
  if (!gen.zip) {
    const missingMediaPreventGeneration = rec.missingMedia.appeared
      && Number(rec.missingMedia.missingCount) > 0;
    ctx.check(
      missingMediaPreventGeneration
        ? `${label} : parité non exécutée, médias introuvables à l’ouverture`
        : `${label} : génération réussie (préalable à la parité)`,
      missingMediaPreventGeneration ? null : false,
      rec,
    );
    if (dataPath) appendRecord(dataPath, rec);
    await returnHome(page).catch(() => {});
    return rec;
  }
  rec.producedFileName = basename(gen.zip);
  const { storyJson } = await readStoryJson(page, gen.zip);
  rec.producedNightModeAvailable = storyJson?.nightModeAvailable ?? null;
  rec.producedStageCount = Array.isArray(storyJson?.stageNodes) ? storyJson.stageNodes.length : null;

  const { trace: traceB, posedInTree } = await traceProducedArchive(page, ctx, label, gen.zip);
  rec.traceB = traceB;
  writeTrace(tracePath(dataDir, ctx, label, 'B-archive'), traceB);
  rec.packImportedPosedInTree = posedInTree;

  const cmp = compareTraces(rec.traceA, traceB);
  rec.parityIdentical = cmp.identical;
  rec.firstDivergence = cmp.firstDivergence;
  rec.durationGaps = cmp.durationGaps;
  ctx.check(`${label} : parité séquence (écrans/image/boutons/audio présent)`, cmp.identical, {
    firstDivergence: cmp.firstDivergence,
    stepsA: rec.traceA.steps.length,
    stepsB: traceB.steps.length,
    stuckAtA: rec.traceA.stuckAt,
    stuckAtB: traceB.stuckAt,
  });
  if (cmp.durationGaps.length) {
    ctx.check(`${label} : écarts de durée après préparation audio (information non bloquante)`, null, {
      durationGapsCount: cmp.durationGaps.length,
      durationGapsSample: cmp.durationGaps.slice(0, 5),
    });
  }

  if (dataPath) appendRecord(dataPath, { ...rec, traceA: undefined, traceB: undefined });
  await returnHome(page).catch(() => {});
  return rec;
}

function appendRecord(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export async function run() {
  const ctx = createRun('c3b-parity-menus');
  const workspaceDir = ctx.dir('workspace');
  const dataDir = reportDataDir();
  const tracesPath = dataDir ? join(dataDir, 'c3b-menus-traces.jsonl') : join(ctx.dir('donnees'), 'c3b-menus-traces.jsonl');

  const corpusSample = smallestArchives(EDITABLE_DIR, CORPUS_COUNT);
  const projectsDir = userProjectsDir();
  const missing = USER_PROJECTS.filter((name) => !existsSync(join(projectsDir, `${name}.mbah`)));
  if (!USER_PROJECTS.length || missing.length) {
    ctx.check('les projets utilisateur désignés (c3bUserProjects) sont renseignés et présents', false, { projectsDir, missing });
  }

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const allFaults = [];
  const results = [];

  try {
    for (let i = 0; i < corpusSample.length; i += 1) {
      const archive = corpusSample[i];
      const copy = join(ctx.dir('entrées', 'corpus'), `${String(i).padStart(2, '0')}${archive.slice(archive.lastIndexOf('.'))}`);
      mkdirSync(ctx.dir('entrées', 'corpus'), { recursive: true });
      copyFileSync(archive, copy);
      const label = `corpus-${i}`;
      const rec = await runOne(app.page, ctx, {
        key: label,
        label,
        open: () => importPack(app.page, copy, { editor: 'menus' }),
        dataPath: tracesPath,
        dataDir,
      });
      results.push({ label, sourceName: basename(archive), ...rec });

      if (i === 0) {
        // Contre-épreuve : un script décalé d'un pas doit être détecté comme
        // différent — sinon `compareTraces` ne prouve rien. Rejoué sur la
        // même archive produite, sans regénérer.
        if (rec.generationOk) {
          await goHome(app.page).catch(() => {});
          await importPack(app.page, copy, { editor: 'menus' });
          await dismissMissingMediaModalIfPresent(app.page);
          const zipPath = join(ctx.dir('sortie', label), rec.producedFileName);
          const shifted = ['ok', ...DEFAULT_SCRIPT];
          const { trace: traceShifted } = await traceProducedArchive(app.page, ctx, `${label}-contre-epreuve`, zipPath, shifted);
          const cmpShifted = compareTraces(rec.traceA, traceShifted);
          ctx.check('contre-épreuve : script décalé d’un pas détecté comme différent', cmpShifted.identical === false, {
            firstDivergence: cmpShifted.firstDivergence,
          });
          await returnHome(app.page).catch(() => {});
        }
      }
    }

    for (const name of USER_PROJECTS) {
      if (!existsSync(join(projectsDir, `${name}.mbah`))) continue;
      const copyDir = ctx.dir('projets', name);
      const copyPath = join(copyDir, `${name}.mbah`);
      copyFileSync(join(projectsDir, `${name}.mbah`), copyPath);
      const label = `user-${name}`;
      const rec = await runOne(app.page, ctx, {
        key: label,
        label,
        open: () => openProjectDialog(app.page, copyPath, { timeout: 180_000 }),
        dataPath: tracesPath,
        dataDir,
      });
      results.push({ label, sourceName: name, ...rec });
    }

    // Faits : « Simuler depuis ici » démarre-t-il sur l'élément visé, et le
    // nœud en cours de lecture est-il sélectionné dans l'arbre ? Vérifiés sur
    // le dernier projet utilisateur encore ouvert avant son retour à l'accueil
    // — remplacé ici par une réouverture rapide du premier projet utilisateur
    // disponible, pour ne pas dépendre de l'état laissé par la boucle.
    const factsProject = USER_PROJECTS.find((name) => existsSync(join(projectsDir, `${name}.mbah`)));
    if (factsProject) {
      const copyPath = join(ctx.dir('projets', factsProject), `${factsProject}.mbah`);
      await goHome(app.page).catch(() => {});
      await openProjectDialog(app.page, copyPath, { timeout: 180_000 });
      await dismissMissingMediaModalIfPresent(app.page);
      const someStory = app.page.locator('.tree-item--story').nth(3);
      const storyLabel = await someStory.innerText().catch(() => null);
      if (storyLabel) {
        await someStory.scrollIntoViewIfNeeded().catch(() => {});
        await someStory.click({ button: 'right' });
        const menu = app.page.locator('.ctx-menu');
        await menu.waitFor({ timeout: 5_000 }).catch(() => {});
        const item = menu.getByRole('menuitem', { name: /Simuler depuis ici/ }).first();
        if (await item.count()) {
          await item.click();
          await waitForSimulator(app.page).catch(() => {});
          await app.page.waitForTimeout(500);
          const title = await app.page.locator('.lunii-screen-title').innerText().catch(() => null);
          await ctx.shot(app.page, 'fait-simuler-depuis-ici');
          ctx.check('fait : « Simuler depuis ici » ouvre le simulateur sur l’élément visé (titre affiché, sans jugement de correspondance exacte)', Boolean(title), { storyLabel: storyLabel.trim(), titreAffiche: title });

          // Le nœud en cours de lecture est-il sélectionné dans l'arbre ?
          const activeBefore = await app.page.locator('.tree-item.active').count();
          const okBtn = app.page.locator('.lunii-btn-ok').first();
          if (await okBtn.isEnabled().catch(() => false)) await okBtn.click();
          await app.page.waitForTimeout(500);
          const activeAfter = await app.page.locator('.tree-item.active').innerText().catch(() => null);
          ctx.check('fait : la lecture sélectionne un nœud dans l’arbre (relevé, pas un verdict)', activeAfter !== null, { activeBefore, activeAfterLabel: activeAfter });
          await closeSimulator(app.page).catch(() => {});
        } else {
          ctx.check('fait : « Simuler depuis ici » disponible sur une histoire', false, { storyLabel });
        }
      }
      await returnHome(app.page).catch(() => {});
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...app.events.faults());
    ctx.check('aucune erreur console ni exception cumulée', allFaults.length === 0, { faultsTotal: allFaults.length, faults: allFaults.slice(0, 20) });
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }

  return ctx.finish({ results: results.map((r) => ({ ...r, traceA: undefined, traceB: undefined })) });
}
