// Intégrations, micro (`RecordModal`), depuis les deux éditeurs.
//
// Croisé avec deux états de la matrice des chemins (`c2-*`) : (1) session temporaire jamais
// enregistrée, (3) enregistré hors workspace. Pour chaque cas : le fichier
// produit apparaît-il au bon endroit (médiathèque côté graphe, sans Écran
// créé ; histoire dans l'arbre côté menus), est-il lisible par FFmpeg (durée
// > 0), et reste-t-il résolu après fermeture propre + relance + réouverture ?
//
// Autonome, sans clic : la config e2e (`src-tauri/tauri.e2e.conf.json`) passe
// à la WebView2 `--use-fake-ui-for-media-stream` (la demande d'accès micro est
// acceptée sans boîte native) et `--use-fake-device-for-media-stream` (micro
// factice, bip). Ces arguments n'existent que dans l'app e2e. La vraie boîte
// d'autorisation Windows n'est donc PAS exercée ici : elle se vérifie à la main
// dans la recette.
//
// `node e2e/run.mjs c5-micro allow`  : cas 1-4, un seul profil (fresh la
//   première fois seulement). Sans autorisation sous 20 s : échec.
// `node e2e/run.mjs c5-micro refuse` : contre-épreuve, profil NEUF
//   (fresh:true) ; le refus est simulé (`getUserMedia` rejeté en
//   NotAllowedError), car l'acceptation automatique ne se laisse pas
//   contredire par CDP. Il vérifie la réaction de l'app, pas la boîte native.
//
// Le geste « Éditeur simplifié » n'est pas couvert : `canRecord` y vaut
// `canImportStories`, faux pour un projet mono-histoire
// (`useAppDerivedState.js`) — le bouton micro de la barre y est désactivé, ce
// n'est pas un oubli de ce parcours.
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
  performRecording, closeRecordModalAfterError, countGraphNodes, recordModal, waitForGraphReady,
} from '../lib/c5-helpers.mjs';

function sessionsDir() {
  return join(process.env.LOCALAPPDATA, 'com.hugs11.story-studio.e2e', 'sessions');
}

// Le fichier produit vit sous un sous-dossier `enregistrements/` (nom fixe,
// `services/project_files/recording.rs`) ; on le retrouve par ce segment et,
// si fourni, par le nom donné dans la modale — jamais par supposition du
// dossier parent exact (session vs projet), qui est justement le fait à
// relever.
function findRecordedFile(diff, expectedName) {
  const needle = expectedName?.toLowerCase();
  return diff.added.find((p) => p.toLowerCase().includes('enregistrements')
    && (!needle || p.toLowerCase().includes(needle)));
}

// Snapshot AVANT enregistrement de tous les dossiers candidats : le fichier
// est cherché partout, et le parcours vérifie ensuite qu'un projet enregistré
// le reçoit dans l'emplacement de travail configuré, jamais à côté du `.mbah`
// (`media_output_root`, `services/project_files/paths.rs`).
function snapshotCandidates(candidates) {
  return candidates.map((c) => ({ ...c, before: inventory(c.dir) }));
}

// Cherche le fichier produit dans CHAQUE dossier candidat (jamais un seul
// supposé a priori) et rapporte lequel a effectivement reçu l'écriture — un
// fait, pas une hypothèse.
async function checkLanded(ctx, label, snapshots, fileName) {
  for (const { name, dir, before } of snapshots) {
    const diff = inventoryDiff(before, inventory(dir));
    const found = findRecordedFile(diff, fileName);
    if (found) {
      const abs = join(dir, found);
      const probe = probeAudio(abs);
      ctx.check(`${label} fichier produit trouvé dans « ${name} » (inventoryDiff)`, true, { root: dir, added: diff.added });
      ctx.check(`${label} lisible par FFmpeg`, probe.readable, probe);
      ctx.check(`${label} durée > 0`, (probe.durationSec ?? 0) > 0, probe);
      return { landedIn: name, path: abs, probe };
    }
  }
  ctx.check(`${label} fichier produit trouvé (aucun des dossiers candidats)`, false, { candidates: snapshots.map((c) => c.dir) });
  return null;
}

async function runAllow() {
  const ctx = createRun('c5-micro-allow');
  const workspaceDir = ctx.dir('workspace'); // workspace configuré : reçoit les prises d'un projet enregistré
  const allFaults = [];
  const cases = [];
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ============ Cas 1 — Graphe, session temporaire (jamais enregistrée) ============
    events.setStep('cas1-graphe-temp');
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    await ctx.shot(page, 'c1-01-nouveau-graphe');
    const stagesBefore1 = (await countGraphNodes(page)).stages;
    const candidates1 = snapshotCandidates([{ name: 'session temporaire', dir: sessionsDir() }]);
    await openMediaExplorer(page);

    const rec1 = await performRecording(page, { fileName: 'c5-graphe-temp' });
    await ctx.shot(page, 'c1-02-apres-enregistrement');
    check('[cas1 graphe/temp] autorisation accordée (1re demande)', rec1.outcome === 'granted', rec1);
    cases.push({ id: 'graphe-temp', mode: 'graphe', etat: 'session temporaire', ...rec1 });

    if (rec1.outcome === 'granted') {
      const stagesAfter1 = (await countGraphNodes(page)).stages;
      check('[cas1] aucun Écran créé par le seul fait d’enregistrer', stagesAfter1 === stagesBefore1, { stagesBefore1, stagesAfter1 });
      const landed1 = await checkLanded(ctx, '[cas1]', candidates1, 'c5-graphe-temp');
      if (landed1) Object.assign(cases.at(-1), landed1);
      const inLibrary1 = await page.locator('.media-explorer').getByText('c5-graphe-temp', { exact: false }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas1] média visible dans la médiathèque (éditeur graphe)', inLibrary1);
      await ctx.shot(page, 'c1-03-mediatheque');
    }
    allFaults.push(...events.faults());
    await returnHome(page); // abandonne + nettoie la session éphémère

    // ============ Cas 2 — Graphe, enregistré hors workspace ============
    events.setStep('cas2-graphe-enregistre');
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    const projectDir2 = ctx.dir('cas2-graphe-enregistre', 'projet');
    const projectPath2 = join(projectDir2, 'Projet C5 Graphe.mbah');
    // Premier enregistrement AVANT tout média/préférence (ordre sûr connu,
    // contournement de l'échec du premier enregistrement : voir
    // `c4-chemins-graphe.mjs`).
    await answerNext(page, 'save', projectPath2);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);
    check('[cas2] premier enregistrement écrit le .mbah', existsSync(projectPath2));

    const stagesBefore2 = (await countGraphNodes(page)).stages;
    // Deux dossiers candidats : le workspace CONFIGURÉ pour ce lancement et le
    // dossier du projet lui-même — ne jamais supposer lequel avant de vérifier
    // (un dossier tiers, le vrai workspace réel, a été observé
    // une fois en pratique ; capturé par le garde-fou de `launch.mjs`, jamais
    // ajouté ici en dur).
    const candidates2 = snapshotCandidates([
      { name: 'workspace configuré', dir: workspaceDir },
      { name: 'dossier projet', dir: projectDir2 },
    ]);
    await openMediaExplorer(page);
    const rec2 = await performRecording(page, { fileName: 'c5-graphe-enregistre' });
    await ctx.shot(page, 'c2-01-apres-enregistrement');
    check('[cas2 graphe/enregistré] pas de nouvelle demande d’autorisation', rec2.outcome === 'granted', rec2);
    cases.push({ id: 'graphe-enregistre', mode: 'graphe', etat: 'enregistré hors workspace', ...rec2 });

    if (rec2.outcome === 'granted') {
      const stagesAfter2 = (await countGraphNodes(page)).stages;
      check('[cas2] aucun Écran créé', stagesAfter2 === stagesBefore2, { stagesBefore2, stagesAfter2 });
      const landed2 = await checkLanded(ctx, '[cas2]', candidates2, 'c5-graphe-enregistre');
      if (landed2) Object.assign(cases.at(-1), landed2);
      check('[cas2] prise rangée dans l’emplacement de travail, pas à côté du .mbah', landed2?.landedIn === 'workspace configuré', landed2);
      const inLibrary2 = await page.locator('.media-explorer').getByText('c5-graphe-enregistre', { exact: false }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas2] média visible dans la médiathèque (éditeur graphe)', inLibrary2);
      // Sauvegarde explicite avant fermeture : le test qui suit (fermer /
      // relancer / rouvrir) porte sur « un enregistrement sauvegardé
      // reste-t-il résolu », pas sur la gestion d'une fermeture avec
      // modifications non enregistrées (question distincte).
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
    }
    allFaults.push(...events.faults());

    // ---- fermer proprement / relancer / rouvrir : le média reste résolu ? ----
    const stopAfterCas2 = await app.stop({ graceful: true });
    check('[cas2] fermeture propre', stopAfterCas2.closedGracefully !== false, stopAfterCas2);
    check('[cas2] rien écrit dans le vrai workspace avant relance', stopAfterCas2.polluted.length === 0, stopAfterCas2);

    app = await launchApp({ runDir: ctx.dir('cas2-graphe-enregistre', 'relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    const reopened2 = await openProjectDialog(page, projectPath2);
    check('[cas2] réouverture aboutit', reopened2);
    if (reopened2) {
      const missing2 = await hasMissingMediaModal(page, 5000);
      check('[cas2] média enregistré toujours résolu après relance+réouverture', !missing2);
      check('[cas2] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
      await ctx.shot(page, 'c2-02-apres-relance-reouverture');
    }
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 3 — Menus (Éditeur par menus), session temporaire ============
    // Mode 'pack' (hiérarchique), pas 'simple' : `canRecord` est faux en mode
    // simple (projet mono-histoire, voir en-tête de ce fichier).
    events.setStep('cas3-menus-temp');
    await newProject(page, 'pack');
    await ctx.shot(page, 'c3-01-nouveau-menus');
    const candidates3 = snapshotCandidates([{ name: 'session temporaire', dir: sessionsDir() }]);
    const treeBefore3 = await page.locator('.tree-item').count();

    const rec3 = await performRecording(page, { fileName: 'c5-menus-temp' });
    await ctx.shot(page, 'c3-02-apres-enregistrement');
    check('[cas3 menus/temp] pas de nouvelle demande d’autorisation', rec3.outcome === 'granted', rec3);
    cases.push({ id: 'menus-temp', mode: 'menus', etat: 'session temporaire', ...rec3 });

    if (rec3.outcome === 'granted') {
      const treeAfter3 = await page.locator('.tree-item').count();
      check('[cas3] une entrée est apparue dans l’arbre (relevé factuel, pas un jugement de libellé)', treeAfter3 > treeBefore3, { treeBefore3, treeAfter3 });
      const storyVisible3 = await page.locator('.tree-item').filter({ hasText: 'c5-menus-temp' }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas3] l’histoire enregistrée apparaît dans l’arbre (dossier visé)', storyVisible3);
      const landed3 = await checkLanded(ctx, '[cas3]', candidates3, 'c5-menus-temp');
      if (landed3) Object.assign(cases.at(-1), landed3);
    }
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 4 — Menus (pack), enregistré hors workspace ============
    events.setStep('cas4-menus-enregistre');
    await newProject(page, 'pack');
    const projectDir4 = ctx.dir('cas4-menus-enregistre', 'projet');
    const projectPath4 = join(projectDir4, 'Projet C5 Menus.mbah');
    await answerNext(page, 'save', projectPath4);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);
    check('[cas4] premier enregistrement écrit le .mbah', existsSync(projectPath4));

    const candidates4 = snapshotCandidates([
      { name: 'workspace configuré', dir: workspaceDir },
      { name: 'dossier projet', dir: projectDir4 },
    ]);
    const treeBefore4 = await page.locator('.tree-item').count();
    const rec4 = await performRecording(page, { fileName: 'c5-menus-enregistre' });
    await ctx.shot(page, 'c4-01-apres-enregistrement');
    check('[cas4 menus/enregistré] pas de nouvelle demande d’autorisation', rec4.outcome === 'granted', rec4);
    cases.push({ id: 'menus-enregistre', mode: 'menus', etat: 'enregistré hors workspace', ...rec4 });

    if (rec4.outcome === 'granted') {
      const treeAfter4 = await page.locator('.tree-item').count();
      check('[cas4] une entrée est apparue dans l’arbre', treeAfter4 > treeBefore4, { treeBefore4, treeAfter4 });
      const storyVisible4 = await page.locator('.tree-item').filter({ hasText: 'c5-menus-enregistre' }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas4] l’histoire enregistrée apparaît dans l’arbre (dossier visé)', storyVisible4);
      const landed4 = await checkLanded(ctx, '[cas4]', candidates4, 'c5-menus-enregistre');
      if (landed4) Object.assign(cases.at(-1), landed4);
      check('[cas4] prise rangée dans l’emplacement de travail, pas à côté du .mbah', landed4?.landedIn === 'workspace configuré', landed4);
      // Sauvegarde explicite avant fermeture (rien n'indique que
      // l'ajout d'une histoire soit persisté sans passage par une sauvegarde,
      // à la différence du graphe où la référence média a été vue persistée
      // aussitôt lors de la mise au point).
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
    }
    allFaults.push(...events.faults());

    const stopAfterCas4 = await app.stop({ graceful: true });
    check('[cas4] fermeture propre', stopAfterCas4.closedGracefully !== false, stopAfterCas4);
    check('[cas4] rien écrit dans le vrai workspace avant relance', stopAfterCas4.polluted.length === 0, stopAfterCas4);

    app = await launchApp({ runDir: ctx.dir('cas4-menus-enregistre', 'relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    const reopened4 = await openProjectDialog(page, projectPath4);
    check('[cas4] réouverture aboutit', reopened4);
    if (reopened4) {
      const missing4 = await hasMissingMediaModal(page, 5000);
      check('[cas4] média enregistré toujours résolu après relance+réouverture', !missing4);
      check('[cas4] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
      await ctx.shot(page, 'c4-02-apres-relance-reouverture');
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

// Contre-épreuve : profil NEUF (fresh:true) pour être certain qu'aucune
// autorisation n'a déjà été accordée, puis refus simulé côté API.
async function runRefuse() {
  const ctx = createRun('c5-micro-refuse');
  const workspaceDir = ctx.dir('workspace');
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  try {
    // L'argument d'acceptation automatique l'emporte sur `Browser.setPermission`
    // (essayé : la demande reste accordée). Le refus est donc simulé au niveau
    // de l'API : `getUserMedia` rejette comme le fait WebView2 quand
    // l'utilisateur clique « Refuser » (NotAllowedError).
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(
        new DOMException('Permission denied', 'NotAllowedError'),
      );
    });
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    await ctx.shot(page, '01-avant-refus');
    const sessionsBefore = inventory(sessionsDir());
    const before = await countGraphNodes(page);

    const rec = await performRecording(page, { fileName: 'c5-refus', permissionTimeout: 20_000 });
    await ctx.shot(page, '02-issue-refus');
    check('[refus] issue = refusée (phase erreur de la modale)', rec.outcome === 'denied', rec);
    if (rec.outcome === 'denied') {
      check(
        '[refus] message lisible affiché',
        typeof rec.message === 'string' && rec.message.includes("Impossible d'accéder au micro"),
        rec,
      );
      await closeRecordModalAfterError(page);
      check('[refus] modale refermée, app non bloquée', await recordModal(page).count() === 0);
    }
    const after = await countGraphNodes(page);
    check('[refus] aucun Écran créé', after.stages === before.stages, { before, after });
    const diff = inventoryDiff(sessionsBefore, inventory(sessionsDir()));
    check('[refus] aucun fichier laissé derrière (inventoryDiff)', diff.added.length === 0, diff);
    check('[refus] aucune erreur console/exception non gérée', events.faults().length === 0, { faults: events.faults() });
    await ctx.shot(page, '03-apres-fermeture-modale');
  } catch (error) {
    check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop();
    check('rien écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}

export async function run(args = []) {
  const mode = args[0] ?? 'allow';
  if (mode === 'refuse') return runRefuse();
  return runAllow();
}
