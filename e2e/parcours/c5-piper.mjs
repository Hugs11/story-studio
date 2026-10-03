// Intégrations, Piper (`GenerateVoiceModal`, backend par défaut,
// zéro-config), depuis les deux éditeurs.
//
// Piper est le backend TTS actif par défaut (`xttsSettings.backend ===
// 'piper'`) : rien à configurer, rien à démarrer. Le runtime natif est
// embarqué ; seule la voix par défaut est téléchargée au premier usage
// (`piper_ensure_voice`).
//
// Croisé avec deux états de la matrice des chemins (`c2-*`) : (1) session temporaire, en
// Éditeur graphe ; (3) enregistré hors workspace, en Éditeur par menus.
//
// `node e2e/run.mjs c5-piper`
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
  runPiperGenerate, countGraphNodes, waitForGraphReady, sessionsDir, findProducedFiles,
} from '../lib/c5-helpers.mjs';

const TEXT = "Ceci est une phrase courte pour tester la synthèse vocale Piper.";
// `filenameHint` fixe posé par le toolbar (`useAiGeneration.js`, pas dérivé du
// texte) : `output_filename` (`services/piper/output.rs`) en fait
// `histoire-tts--<suffixe>.mp3` — vérifié dans `ipc.jsonl` en mettant ce
// parcours au point, jamais supposé.
const NEEDLE = 'histoire-tts';
// `onQueueGenerate` (`useAiGeneration.js:handleQueueXttsGenerate`) ne fait
// qu'empiler un job dans la file IA (`xttsStore.addJob`) puis referme la
// modale : la génération réelle (`piper_generate_audio`) et l'atterrissage du
// fichier suivent de manière asynchrone, hors de la fermeture de la modale —
// contrairement au micro/à l'import, qui n'annoncent leur fin qu'une fois le
// fichier écrit. Le fait à vérifier est donc l'apparition dans l'arbre/la
// médiathèque, avec une marge, PUIS l'inventaire — jamais l'inverse.
const QUEUE_LANDING_TIMEOUT = 45_000;

export async function run() {
  const ctx = createRun('c5-piper');
  const workspaceDir = ctx.dir('workspace');
  const allFaults = [];
  const cases = [];
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ============ Cas 1 — Graphe, session temporaire (1er usage : téléchargement de la voix) ============
    events.setStep('cas1-graphe-temp');
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    const stagesBefore1 = (await countGraphNodes(page)).stages;
    const sessionsBefore1 = inventory(sessionsDir());
    await openMediaExplorer(page);

    const res1 = await runPiperGenerate(page, { text: TEXT });
    await ctx.shot(page, 'c1-01-apres-generation');
    check('[cas1 graphe/temp] génération Piper (1er usage : téléchargement de la voix par défaut)', res1.ok, res1);
    cases.push({ id: 'graphe-temp', mode: 'graphe', etat: 'session temporaire', ...res1 });

    if (res1.ok) {
      const stagesAfter1 = (await countGraphNodes(page)).stages;
      check('[cas1] aucun Écran créé (atterrissage médiathèque)', stagesAfter1 === stagesBefore1, { stagesBefore1, stagesAfter1 });
      // La file IA traite le job de manière asynchrone : on attend d'abord le
      // signe visible que le travail est fini (média dans la médiathèque),
      // avec une marge, avant de figer un inventaire qui le trouverait sinon
      // encore absent (constaté en mettant ce parcours au point : un
      // inventaire pris juste après la fermeture de la modale ne voit rien).
      const inLibrary1 = await page.locator('.media-explorer').getByText(NEEDLE, { exact: false }).first()
        .waitFor({ timeout: QUEUE_LANDING_TIMEOUT }).then(() => true, () => false);
      check('[cas1] média visible dans la médiathèque (éditeur graphe)', inLibrary1);
      await ctx.shot(page, 'c1-02-mediatheque');
      const diff1 = inventoryDiff(sessionsBefore1, inventory(sessionsDir()));
      const produced1 = findProducedFiles(diff1, NEEDLE);
      check('[cas1] fichier produit trouvé sous la session temporaire (inventoryDiff)', produced1.length > 0, { diff: diff1 });
      for (const rel of produced1) {
        const probe = probeAudio(join(sessionsDir(), rel));
        check(`[cas1] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[cas1] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
    }
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 2 — Menus, enregistré hors workspace (2e usage : voix déjà en cache) ============
    events.setStep('cas2-menus-enregistre');
    await newProject(page, 'pack');
    const projectDir2 = ctx.dir('cas2-menus-enregistre', 'projet');
    const projectPath2 = join(projectDir2, 'Projet C5 Piper.mbah');
    await answerNext(page, 'save', projectPath2);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);
    check('[cas2] premier enregistrement écrit le .mbah', existsSync(projectPath2));

    const treeBefore2 = await page.locator('.tree-item').count();
    const before2 = { workspace: inventory(workspaceDir), projet: inventory(projectDir2) };

    const res2 = await runPiperGenerate(page, { text: TEXT });
    await ctx.shot(page, 'c2-01-apres-generation');
    check('[cas2 menus/enregistré] génération Piper (2e usage, voix déjà en cache)', res2.ok, res2);
    cases.push({ id: 'menus-enregistre', mode: 'menus', etat: 'enregistré hors workspace', elapsedMsEnqueue: res2.elapsedMs, ...res2 });

    if (res2.ok) {
      // Même remarque qu'au cas 1 : le job de la file IA est asynchrone. Le
      // nom de la nouvelle histoire vient de la première phrase du texte
      // (`getTtsStoryName`, `useAiGeneration.js`), pas du `filenameHint` du
      // fichier — on attend donc une AUGMENTATION du compte plutôt qu'un
      // texte précis, par sondage (pas de signal DOM dédié « job terminé »).
      const deadline2 = Date.now() + QUEUE_LANDING_TIMEOUT;
      let treeAfter2 = treeBefore2;
      while (Date.now() < deadline2) {
        treeAfter2 = await page.locator('.tree-item').count();
        if (treeAfter2 > treeBefore2) break;
        await page.waitForTimeout(1000);
      }
      check('[cas2] une entrée est apparue dans l’arbre (histoire)', treeAfter2 > treeBefore2, { treeBefore2, treeAfter2 });
      const diffWorkspace = inventoryDiff(before2.workspace, inventory(workspaceDir));
      const diffProjet = inventoryDiff(before2.projet, inventory(projectDir2));
      const producedWorkspace = findProducedFiles(diffWorkspace, NEEDLE);
      const producedProjet = findProducedFiles(diffProjet, NEEDLE);
      check('[cas2] chemin exact du fichier produit relevé (workspace configuré ou dossier projet, jamais supposé)', producedWorkspace.length > 0 || producedProjet.length > 0, { producedWorkspace, producedProjet });
      check('[cas2] projet enregistré : fichier produit dans l’emplacement de travail, rien à côté du .mbah', producedWorkspace.length > 0 && producedProjet.length === 0, { producedWorkspace, producedProjet });
      const landedRoot = producedWorkspace.length ? workspaceDir : projectDir2;
      const landedRel = producedWorkspace.length ? producedWorkspace : producedProjet;
      for (const rel of landedRel) {
        const probe = probeAudio(join(landedRoot, rel));
        check(`[cas2] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[cas2] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
    }
    allFaults.push(...events.faults());

    const stopAfterCas2 = await app.stop({ graceful: true });
    check('[cas2] fermeture propre', stopAfterCas2.closedGracefully !== false, stopAfterCas2);
    check('[cas2] rien écrit dans le vrai workspace avant relance', stopAfterCas2.polluted.length === 0, stopAfterCas2);

    app = await launchApp({ runDir: ctx.dir('cas2-menus-enregistre', 'relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    const reopened2 = await openProjectDialog(page, projectPath2);
    check('[cas2] réouverture aboutit', reopened2);
    if (reopened2) {
      const missing2 = await hasMissingMediaModal(page, 5000);
      check('[cas2] voix générée toujours résolue après relance+réouverture', !missing2);
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
