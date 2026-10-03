// Matrice des chemins, Éditeur simplifié.
//
// Couvre : processus tué pendant l'édition puis reprise (état 6, média à
// CHEMIN LONG, copie désactivée) ; depuis la session reprise, bascule de la
// préférence de copie puis premier enregistrement hors workspace (états 3+4,
// média à HOMONYME copie activée) ; fermeture puis réouverture (récents, à
// défaut Ouvrir) avec génération + relecture ; dossier de projet déplacé puis
// rouvert par Ouvrir (état 5).
//
// Remplissage : l'éditeur simplifié est rempli par les champs de `RootEditor`,
// comme un auteur — « Audio du récit » (média à chemin long), « Nom de
// l'histoire », image de couverture et « Titre audio » (média homonyme). Un
// dépôt sur l'arbre n'est plus le geste : un second son déposé sur un récit
// déjà posé est refusé. Le projet attendu est celui de
// scripts/fixtures/ui-built-projects/simple.json : une couverture qui mène au
// récit, deux écrans relus.
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome, projectMenuButton, generatePack } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { synthTone, synthImage, difficultPathsRoot } from '../lib/fixtures.mjs';
import { readbackPack, inventory, inventoryDiff } from '../lib/oracles.mjs';
import {
  setCopyImportedFilesPreference, hasMissingMediaModal, openProjectDialog,
  editorCard, pickAudioField, pickImageField, treeRoot, managedDirsBeside,
} from '../lib/c2-helpers.mjs';

// Le panneau de réglages montre `RootEditor` quand la racine est sélectionnée :
// c'est le cas d'un projet neuf ; le clic la resélectionne après une reprise.
async function showRootEditor(page) {
  const root = treeRoot(page);
  if (await root.count()) await root.click();
  await page.locator('.root-identity-card').first().waitFor({ timeout: 15_000 });
}

export async function run() {
  const ctx = createRun('c2-simple');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const studioOut = ctx.dir('studio-work');
  const allFaults = [];
  const chemins = [];

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ================= Phase A — état 6 : tué pendant l'édition, reprise (chemin long, copie OFF) =================
    events.setStep('etat6-tue-pendant-edition');
    const mediaLong = synthTone(difficult.long, 'histoire-longue.wav', 350);
    ctx.check('[relevé] longueur du chemin du média (chemin long)', true, { path: mediaLong, length: mediaLong.length });
    await newProject(page, 'simple');
    await ctx.shot(page, 'a01-nouveau-projet-simple');
    await showRootEditor(page);
    const recitPosed = await pickAudioField(page, editorCard(page, 'Récit complet'), 'Audio du récit', mediaLong);
    await ctx.shot(page, 'a02-media-long-pose-audio-du-recit');
    ctx.check('[remplissage] « Audio du récit » posé par son champ (média à chemin long)', recitPosed);
    await page.waitForTimeout(6000);
    allFaults.push(...events.faults());

    const killStop = await app.stop();
    ctx.check('[état 6] rien écrit dans le vrai workspace avant l’arrêt brutal', killStop.polluted.length === 0, { polluted: killStop.polluted });

    app = await launchApp({ runDir: ctx.dir('relance-etat6'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    await ctx.shot(page, 'a03-accueil-apres-kill');
    const recoveryButton = page.locator('.mode-proj-row--recovery .mode-proj-open').first();
    const hasRecovery = await recoveryButton.count() > 0;
    ctx.check('[état 6] l’accueil propose une reprise (média à chemin long en cours d’édition)', hasRecovery);
    if (hasRecovery) {
      await recoveryButton.click();
      const recovered = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      await ctx.shot(page, 'a04-apres-reprise');
      ctx.check('[état 6] la reprise aboutit dans l’éditeur', recovered);
      const missingAfterRecovery = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 6] média résolu après reprise (pas de « Médias introuvables »)', !missingAfterRecovery);
      ctx.check('[état 6] aucune erreur console pendant la reprise', events.faults().length === 0, { faults: events.faults() });
    } else {
      ctx.check('[état 6] la reprise aboutit dans l’éditeur', null, { detail: 'aucune reprise proposée' });
    }
    allFaults.push(...events.faults());

    // ================= Phase B — état 1 → 3+4 : depuis la session reprise, 1er enregistrement hors workspace =================
    events.setStep('etat1-et-etat3-4');
    await setCopyImportedFilesPreference(page, true);
    await showRootEditor(page);
    // « Nom de l'histoire » : titre du pack et nom de l'archive
    // (`hasExplicitExportPackName`), la fiche n'est donc pas redemandée.
    await page.locator('#root-simple-name').fill('Histoire C2 simplifiée');
    await page.locator('#root-simple-name').blur();
    const rootCard = page.locator('.root-identity-card').first();
    const coverImage = synthImage(ctx.dir('couverture-simple'), 'couverture.png', 3);
    const coverPosed = await pickImageField(page, rootCard, coverImage);
    const mediaHomonyme = synthTone(difficult.homonymsA, 'meme-nom.wav', 900);
    const titlePosed = await pickAudioField(page, rootCard, 'Titre audio', mediaHomonyme);
    await ctx.shot(page, 'b01-racine-remplie');
    ctx.check('[remplissage] nom de l’histoire, image de couverture et « Titre audio » (média homonyme) posés par leurs champs', coverPosed && titlePosed, { coverPosed, titlePosed });
    const missingBeforeSave = await hasMissingMediaModal(page, 3000);
    ctx.check('[état 1] média homonyme accepté sans « Médias introuvables » en session temporaire', !missingBeforeSave);

    const projectDir = ctx.dir('projet-hors-workspace');
    const projectPath = join(projectDir, 'Projet C2 Simple.mbah');
    await answerNext(page, 'ask', true);
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    const saveLog = await dialogLog(page);
    ctx.check('[état 3+4] premier enregistrement écrit le .mbah au chemin choisi', existsSync(projectPath));
    // Option workspace désactivée (défaut) : l'image de couverture retouchée
    // rejoint l'emplacement de travail, rien n'est rangé à côté du `.mbah`.
    const besideAfterSave = managedDirsBeside(projectDir);
    ctx.check('[état 3+4] aucun sous-dossier de médias créé à côté du .mbah', besideAfterSave.length === 0, { besideAfterSave });
    chemins.push({ étape: 'premier enregistrement (save)', log: saveLog.filter((entry) => entry.kind === 'save') });
    allFaults.push(...events.faults());

    // ================= Phase C — fermeture puis réouverture (état 3) =================
    events.setStep('fermeture-reouverture');
    const beforeCloseStop = await app.stop({ graceful: true });
    ctx.check('[état 3] rien écrit dans le vrai workspace avant la fermeture', beforeCloseStop.polluted.length === 0, { polluted: beforeCloseStop.polluted });

    app = await launchApp({ runDir: ctx.dir('relance-etat3'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const recentRow = page.locator('button.mode-proj-row').first();
    const hasRecent = await recentRow.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    ctx.check('[état 3] le projet figure dans les récents après fermeture', hasRecent);
    let reopened;
    if (hasRecent) {
      await recentRow.click();
      reopened = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
    } else {
      reopened = await openProjectDialog(page, projectPath);
    }
    await ctx.shot(page, 'c01-reouvert');
    ctx.check('[état 3] réouverture aboutit (récents ou, à défaut, Ouvrir)', reopened);
    if (reopened) {
      const missingAfterReopen = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 3] le média (chemin long) se résout après réouverture', !missingAfterReopen);
      ctx.check('[état 3] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });

      const outDir = ctx.dir('sortie-etat3');
      const genResult = await generatePack(page, outDir);
      await ctx.shot(page, 'c02-apres-generation');
      ctx.check('[état 3] génération réussie', !!genResult.zip, { refusal: genResult.refusal, timeout: genResult.timeout });
      if (genResult.zip) {
        const verdict = await readbackPack(page, genResult.zip, studioOut);
        ctx.check('[état 3] pack relu par l’app et accepté par STUdio', verdict.ok, verdict);
        ctx.check('[état 3] l’archive a la forme de l’éditeur simplifié : couverture puis récit (2 écrans)', verdict.storyStudio?.stageNodes === 2, verdict.storyStudio);
      }
    }
    allFaults.push(...events.faults());

    // ================= Phase D — dossier de projet déplacé puis rouvert (état 5) =================
    events.setStep('etat5-dossier-deplace');
    const closeForMoveStop = await app.stop();
    ctx.check('[état 5] rien écrit dans le vrai workspace avant le déplacement', closeForMoveStop.polluted.length === 0, { polluted: closeForMoveStop.polluted });

    const movedDir = ctx.dir('projet-deplace-et-renomme');
    const movedPath = join(movedDir, 'Projet C2 Simple (renommé).mbah');
    for (const entry of readdirSync(projectDir)) {
      renameSync(join(projectDir, entry), join(movedDir, entry === basename(projectPath) ? basename(movedPath) : entry));
    }
    ctx.check('[état 5] dossier projet renommé sur disque', existsSync(movedPath));

    app = await launchApp({ runDir: ctx.dir('relance-etat5'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const openedMoved = await openProjectDialog(page, movedPath);
    await ctx.shot(page, 'd01-ouvert-apres-deplacement');
    ctx.check('[état 5] ouverture du projet déplacé aboutit', openedMoved);
    if (openedMoved) {
      const missingAfterMove = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 5] média résolu après déplacement du dossier projet (source non déplacée)', !missingAfterMove);
      ctx.check('[état 5] aucune erreur console après réouverture du projet déplacé', events.faults().length === 0, { faults: events.faults() });
    }
    allFaults.push(...events.faults());
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception sur tout le parcours (cumul)', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace sur tout le parcours (dernier contrôle)', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }
  return ctx.finish({ chemins });
}
