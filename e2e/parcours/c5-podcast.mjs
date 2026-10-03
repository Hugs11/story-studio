// Intégrations, Podcast (`PodcastImportModal`), depuis les deux
// éditeurs.
//
// Flux fixe, public : « 60-Second Science » (Scientific American), dont les
// épisodes les plus anciens du flux durent ~2-3 min (les récents, sous le nom
// « Science Quickly », durent 15-30 min) — le filtre de la modale isole un
// épisode ancien précis par un fragment de titre distinctif, sans dépendre du
// rang dans une liste de ~2000 entrées. URL publique, pas un nom de pack.
//
// Croisé avec deux états de la matrice des chemins (`c2-*`) : (1) session temporaire, en
// Éditeur graphe ; (3) enregistré hors workspace, en Éditeur par menus.
//
// `node e2e/run.mjs c5-podcast`
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { probeAudio } from '../lib/fixtures.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';
import { openMediaExplorer, hasMissingMediaModal, openProjectDialog } from '../lib/c2-helpers.mjs';
import {
  runPodcastImport, countGraphNodes, waitForGraphReady, sessionsDir, findProducedFiles,
} from '../lib/c5-helpers.mjs';

const FEED_URL = 'http://rss.sciam.com/sciam/60secsciencepodcast/';
// Fragment distinctif d'un épisode ancien (~166 s d'après le flux), qui
// n'apparaît qu'une fois dans tout le flux.
const EPISODE_QUERY = '21-Second Rule';
const TITLE_NEEDLE = 'micturition'; // fragment alphanumérique robuste à l'assainissement du nom de fichier

export async function run() {
  const ctx = createRun('c5-podcast');
  const workspaceDir = ctx.dir('workspace');
  const allFaults = [];
  const cases = [];
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ============ Cas 1 — Graphe, session temporaire ============
    events.setStep('cas1-graphe-temp');
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    const stagesBefore1 = (await countGraphNodes(page)).stages;
    const sessionsBefore1 = inventory(sessionsDir());
    await openMediaExplorer(page);

    const res1 = await runPodcastImport(page, { feedUrl: FEED_URL, episodeQuery: EPISODE_QUERY });
    await ctx.shot(page, 'c1-01-apres-import');
    check('[cas1 graphe/temp] import podcast (flux ~2000 épisodes, filtré)', res1.ok, res1);
    cases.push({ id: 'graphe-temp', mode: 'graphe', etat: 'session temporaire', ...res1 });

    if (res1.ok) {
      const stagesAfter1 = (await countGraphNodes(page)).stages;
      check('[cas1] aucun Écran créé (atterrissage médiathèque)', stagesAfter1 === stagesBefore1, { stagesBefore1, stagesAfter1 });
      const diff1 = inventoryDiff(sessionsBefore1, inventory(sessionsDir()));
      const produced1 = findProducedFiles(diff1, TITLE_NEEDLE);
      check('[cas1] fichier produit trouvé sous la session temporaire (inventoryDiff)', produced1.length > 0, { diff: diff1 });
      for (const rel of produced1.filter((p) => /\.(mp3|wav|m4a)$/i.test(p))) {
        const probe = probeAudio(join(sessionsDir(), rel));
        check(`[cas1] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[cas1] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
      const inLibrary1 = await page.locator('.media-explorer').getByText(TITLE_NEEDLE, { exact: false }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas1] média visible dans la médiathèque (éditeur graphe)', inLibrary1);
      await ctx.shot(page, 'c1-02-mediatheque');
    }
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 2 — Menus, enregistré hors workspace ============
    events.setStep('cas2-menus-enregistre');
    await newProject(page, 'pack');
    const projectDir2 = ctx.dir('cas2-menus-enregistre', 'projet');
    const projectPath2 = join(projectDir2, 'Projet C5 Podcast.mbah');
    await answerNext(page, 'save', projectPath2);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);
    check('[cas2] premier enregistrement écrit le .mbah', existsSync(projectPath2));

    const treeBefore2 = await page.locator('.tree-item').count();
    const before2 = { workspace: inventory(workspaceDir), projet: inventory(projectDir2) };

    const res2 = await runPodcastImport(page, { feedUrl: FEED_URL, episodeQuery: EPISODE_QUERY });
    await ctx.shot(page, 'c2-01-apres-import');
    check('[cas2 menus/enregistré] import podcast', res2.ok, res2);
    cases.push({ id: 'menus-enregistre', mode: 'menus', etat: 'enregistré hors workspace', ...res2 });

    if (res2.ok) {
      const treeAfter2 = await page.locator('.tree-item').count();
      check('[cas2] une entrée est apparue dans l’arbre (histoire)', treeAfter2 > treeBefore2, { treeBefore2, treeAfter2 });
      const storyVisible2 = await page.locator('.tree-item').filter({ hasText: /21-Second|Micturition/i }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas2] l’histoire importée apparaît dans l’arbre', storyVisible2);
      const diffWorkspace = inventoryDiff(before2.workspace, inventory(workspaceDir));
      const diffProjet = inventoryDiff(before2.projet, inventory(projectDir2));
      const producedWorkspace = findProducedFiles(diffWorkspace, TITLE_NEEDLE);
      const producedProjet = findProducedFiles(diffProjet, TITLE_NEEDLE);
      check('[cas2] chemin exact du fichier produit relevé (workspace configuré ou dossier projet, jamais supposé)', producedWorkspace.length > 0 || producedProjet.length > 0, { producedWorkspace, producedProjet });
      check('[cas2] projet enregistré : fichier produit dans l’emplacement de travail, rien à côté du .mbah', producedWorkspace.length > 0 && producedProjet.length === 0, { producedWorkspace, producedProjet });
      const landedRoot = producedWorkspace.length ? workspaceDir : projectDir2;
      const landedRel = producedWorkspace.length ? producedWorkspace : producedProjet;
      for (const rel of landedRel.filter((p) => /\.(mp3|wav|m4a)$/i.test(p))) {
        const probe = probeAudio(join(landedRoot, rel));
        check(`[cas2] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[cas2] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
    }
    allFaults.push(...events.faults());

    // ---- fermer proprement / relancer / rouvrir : le média reste résolu ? ----
    const stopAfterCas2 = await app.stop({ graceful: true });
    check('[cas2] fermeture propre', stopAfterCas2.closedGracefully !== false, stopAfterCas2);
    check('[cas2] rien écrit dans le vrai workspace avant relance', stopAfterCas2.polluted.length === 0, stopAfterCas2);

    app = await launchApp({ runDir: ctx.dir('cas2-menus-enregistre', 'relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    const reopened2 = await openProjectDialog(page, projectPath2);
    check('[cas2] réouverture aboutit', reopened2);
    if (reopened2) {
      const missing2 = await hasMissingMediaModal(page, 5000);
      check('[cas2] média podcast importé toujours résolu après relance+réouverture', !missing2);
      check('[cas2] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
      await ctx.shot(page, 'c2-02-apres-relance-reouverture');
    }
    allFaults.push(...events.faults());
  } catch (error) {
    check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    check('aucune erreur console ni exception sur tout le parcours (cumul)', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    check('rien écrit dans le vrai workspace (dernier contrôle)', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }
  return ctx.finish({ cases });
}
