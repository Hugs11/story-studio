// Parité simulation projet / archive produite, Éditeur graphe.
//
// Pour 2 packs du corpus `01 - Editable` importés en Éditeur graphe :
//   trace A = simulation du projet en cours (DocumentSimulationPanel, bouton
//   « Lancer le simulateur » de la barre du canvas — même catalogue que
//   l'Éditeur par menus, `data-media-tool="simulator"`) ;
//   trace B = « Relire cette archive » (bouton du compte rendu d'export,
//   ExportReport → ZipReviewPanel), sur l'archive que la même session vient de
//   produire.
//
// Contrairement à l'Éditeur par menus, il n'y a pas de nœud d'arbre à déposer :
// le point d'entrée réel pour rejouer l'archive produite est le compte rendu
// d'export lui-même, pas une réimportation.
//
// Les nœuds du canvas graphe sont dessinés (pas des éléments DOM individuels) :
// les faits « Simuler depuis ici »/sélection du nœud en cours ne sont pas
// vérifiés ici (nécessiteraient un clic par coordonnées pixel sur le canvas,
// hors périmètre) : limite déclarée explicitement.
import { copyFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../lib/config.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { generatePack, goHome, importPack, returnHome } from '../lib/actions.mjs';
import { smallestArchives } from '../lib/corpus.mjs';
import { readStoryJson } from '../lib/oracles.mjs';
import {
  DEFAULT_SCRIPT, runTrace, compareTraces, launchSimulatorFromToolbar,
  closeSimulator, waitForSimulator,
} from '../lib/simulator.mjs';

const EDITABLE_DIR = '01 - Editable';
// Distincts des 2 plus petits, déjà utilisés par `c3b-parity-menus` : on
// prend les 2 suivants par taille pour ne pas rejouer exactement les mêmes
// archives dans les deux chaînes.
const GRAPHE_COUNT = Number(process.env.SS_E2E_C3B_GRAPHE_COUNT || 2);
const SKIP = Number(process.env.SS_E2E_C3B_GRAPHE_SKIP || 2);

function reportDataDir() {
  const dir = config.c3bReportDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTrace(dataDir, ctx, label, side, trace) {
  const dir = dataDir || ctx.dir('donnees');
  const path = join(dir, `c3b-graphe-${label}-trace-${side}.jsonl`);
  appendFileSync(path, `${trace.steps.map((s) => JSON.stringify(s)).join('\n')}\n`);
}

export async function run() {
  const ctx = createRun('c3b-parity-graphe');
  const workspaceDir = ctx.dir('workspace');
  const dataDir = reportDataDir();

  const pool = smallestArchives(EDITABLE_DIR, SKIP + GRAPHE_COUNT);
  const sample = pool.slice(SKIP);

  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const allFaults = [];
  const results = [];

  try {
    for (let i = 0; i < sample.length; i += 1) {
      const archive = sample[i];
      const copy = join(ctx.dir('entrées'), `${String(i).padStart(2, '0')}${archive.slice(archive.lastIndexOf('.'))}`);
      mkdirSync(ctx.dir('entrées'), { recursive: true });
      copyFileSync(archive, copy);
      const label = `graphe-${i}`;
      const rec = { label, sourceName: basename(archive) };

      await goHome(app.page).catch(() => {});
      await importPack(app.page, copy, { editor: 'graphe' });
      await app.page.waitForTimeout(500);

      await launchSimulatorFromToolbar(app.page);
      await waitForSimulator(app.page);
      const traceA = await runTrace(app.page, DEFAULT_SCRIPT);
      await ctx.shot(app.page, `${label}-A-projet`);
      writeTrace(dataDir, ctx, label, 'A-projet', traceA);
      // Fermeture par la commande commune du simulateur flottant.
      await closeSimulator(app.page);
      await app.page.waitForTimeout(300);

      const outDir = ctx.dir('sortie', label);
      const gen = await generatePack(app.page, outDir, { uuid: 'keep' });
      rec.generationOk = Boolean(gen.zip);
      rec.refusal = gen.refusal ?? (gen.timeout ? 'timeout' : null);
      if (!gen.zip) {
        ctx.check(`${label} : génération réussie (préalable à la parité)`, false, rec);
        results.push(rec);
        await returnHome(app.page).catch(() => {});
        continue;
      }
      rec.producedFileName = basename(gen.zip);
      const { storyJson } = await readStoryJson(app.page, gen.zip);
      rec.producedStageCount = Array.isArray(storyJson?.stageNodes) ? storyJson.stageNodes.length : null;

      // « Relire cette archive » — bouton du compte rendu d'export
      // (ExportReport), affiché juste après une génération réussie.
      const reviewBtn = app.page.getByRole('button', { name: /Relire cette archive/ }).first();
      const reviewAppeared = await reviewBtn.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      rec.reviewButtonAvailable = reviewAppeared;
      if (!reviewAppeared) {
        ctx.check(`${label} : « Relire cette archive » disponible après export`, false, rec);
        results.push(rec);
        await returnHome(app.page).catch(() => {});
        continue;
      }
      await reviewBtn.click();
      await waitForSimulator(app.page);
      const traceB = await runTrace(app.page, DEFAULT_SCRIPT);
      await ctx.shot(app.page, `${label}-B-archive`);
      writeTrace(dataDir, ctx, label, 'B-archive', traceB);
      await closeSimulator(app.page);
      await app.page.waitForTimeout(300);

      const cmp = compareTraces(traceA, traceB);
      rec.parityIdentical = cmp.identical;
      rec.firstDivergence = cmp.firstDivergence;
      rec.durationGaps = cmp.durationGaps;
      rec.stepsA = traceA.steps.length;
      rec.stepsB = traceB.steps.length;
      rec.stuckAtA = traceA.stuckAt;
      rec.stuckAtB = traceB.stuckAt;
      ctx.check(`${label} (${rec.sourceName}) : parité séquence Écoute du projet / Relire l’archive`, cmp.identical, {
        firstDivergence: cmp.firstDivergence, stepsA: rec.stepsA, stepsB: rec.stepsB,
      });
      if (cmp.durationGaps.length) {
        ctx.check(`${label} : écarts de durée après préparation audio (information non bloquante)`, null, {
          durationGapsCount: cmp.durationGaps.length, durationGapsSample: cmp.durationGaps.slice(0, 5),
        });
      }

      results.push(rec);
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

  return ctx.finish({ results });
}
