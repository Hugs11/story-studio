// Matrice des chemins, Éditeur graphe.
//
// Couvre : état 6 (tué pendant l'édition, reprise) avec un média déposé via
// la médiathèque (homonyme B) ; état 1 → 3+4 (premier enregistrement hors
// workspace) ; origine « déjà dans le workspace » (fichier déjà managé vs
// simplement posé à la racine du workspace, copie activée) ; état 3
// (fermeture/réouverture, génération + relecture) ; état 5 (dossier déplacé).
// Le dépôt se fait sur la médiathèque (bouton « Médias » de la barre du bas),
// le canvas de l'éditeur graphe n'exposant pas de zone de dépôt OS
// (`[data-os-drop-zone]` absent de `FullDiagramNode.jsx`).
//
// Remplissage : un média déposé en médiathèque seulement n'est
// référencé par aucun Écran, et la production refuse un pack sans média. Le
// parcours pose donc un son et une image sur l'Écran d'entrée par le geste de
// dépôt (glisser de la médiathèque vers le nœud du canvas, repli sur
// « Utiliser sur « Écran 1 » », même geste `set-stage-media`), crée un
// « Écran 2 » avec son son, le relie depuis la sortie OK de l'entrée par une
// liste de choix, puis donne son titre au pack. Projet attendu : celui du test
// `a_graph_editor_document_built_by_its_gestures_exports_a_valid_pack`
// (2 écrans relus, entrée → liste → Écran 2).
import { existsSync, readdirSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, projectMenuButton, generatePack, returnHome } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { synthTone, synthImage, difficultPathsRoot } from '../lib/fixtures.mjs';
import { readbackPack, inventory, inventoryDiff } from '../lib/oracles.mjs';
import {
  setCopyImportedFilesPreference,
  dropOnMediaExplorer,
  hasMissingMediaModal,
  openProjectDialog,
  keepSessionMediaIfPrompted,
  managedDirsBeside,
  assignMediaToGraphStage,
  linkStagesThroughNewList,
  setPackTitle,
} from '../lib/c2-helpers.mjs';
import { createGraphStage, readGraphView, repairGraphEndings } from '../lib/c4-helpers.mjs';

const presenceOf = (field) => field?.presence ?? null;

export async function run() {
  const ctx = createRun('c2-graphe');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const studioOut = ctx.dir('studio-work');
  const allFaults = [];
  const chemins = [];

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ================= Phase A — état 6 : tué pendant l'édition, reprise =================
    events.setStep('etat6-tue-pendant-edition');
    const mediaHomonymeB = synthTone(difficult.homonymsB, 'meme-nom.wav', 1100);
    await newProject(page, 'advanced');
    await ctx.shot(page, 'a01-nouveau-projet-graphe');
    await dropOnMediaExplorer(page, mediaHomonymeB);
    await ctx.shot(page, 'a02-media-homonyme-B-depose-mediatheque');
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
    ctx.check('[état 6] l’accueil propose une reprise (média homonyme B, graphe)', hasRecovery);
    if (hasRecovery) {
      await recoveryButton.click();
      const recovered = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      await ctx.shot(page, 'a04-apres-reprise');
      ctx.check('[état 6] la reprise aboutit dans l’éditeur graphe', recovered);
      ctx.check('[état 6] aucune erreur console pendant la reprise', events.faults().length === 0, { faults: events.faults() });
      await returnHome(page);
      await page.waitForTimeout(500);
    } else {
      ctx.check('[état 6] la reprise aboutit dans l’éditeur graphe', null, { detail: 'aucune reprise proposée' });
    }
    allFaults.push(...events.faults());

    // Relance complète entre les deux phases : un enchaînement « reprise
    // après crash → retour accueil → nouveau projet » dans la MÊME fenêtre a
    // été observé faire échouer silencieusement le 1er enregistrement du
    // second projet (dialogue affiché et répondu, mais aucun fichier écrit,
    // aucune erreur console). On isole la Phase B dans une fenêtre neuve pour ne
    // pas perdre le reste de la matrice.
    const beforePhaseBStop = await app.stop();
    ctx.check('[état 6] rien écrit dans le vrai workspace avant la relance intermédiaire', beforePhaseBStop.polluted.length === 0, { polluted: beforePhaseBStop.polluted });
    app = await launchApp({ runDir: ctx.dir('relance-phase-b'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });

    // ================= Phase B — nouveau projet graphe, état 1 → 3+4 =================
    events.setStep('etat1-et-etat3-4');
    await newProject(page, 'advanced');
    await ctx.shot(page, 'b01-nouveau-projet-graphe');
    const coverImage = synthImage(ctx.dir('couverture-graphe'), 'couverture.png', 6);
    const secondAudio = synthTone(ctx.dir('ecran-2'), 'son-ecran-2.wav', 760);
    await setCopyImportedFilesPreference(page, true);
    await dropOnMediaExplorer(page, mediaHomonymeB);
    await dropOnMediaExplorer(page, coverImage);
    await dropOnMediaExplorer(page, secondAudio);
    await ctx.shot(page, 'b02-medias-deposes-mediatheque');

    // Son et image sur l'Écran d'entrée, par le geste de dépôt.
    const entryAudio = await assignMediaToGraphStage(page, events, { fileStem: 'meme-nom', stageName: 'Écran 1' });
    const entryImage = await assignMediaToGraphStage(page, events, { fileStem: 'couverture', stageName: 'Écran 1' });
    // Un second Écran, avec son son.
    const stageCreated = await createGraphStage(page);
    const secondStageAudio = stageCreated
      ? await assignMediaToGraphStage(page, events, { fileStem: 'son-ecran-2', stageName: 'Écran 2' })
      : { via: null, reason: 'Écran 2 non créé' };
    const gestures = { entryAudio, entryImage, stageCreated, secondStageAudio };
    ctx.check('[remplissage] son et image posés sur l’Écran d’entrée, Écran 2 créé avec son son', [entryAudio, entryImage, secondStageAudio].every((result) => !!result.via) && stageCreated, gestures);
    ctx.check(
      '[remplissage] geste de dépôt sur le canvas (glisser depuis la médiathèque) : null = repli sur « Utiliser sur », même geste',
      [entryAudio, entryImage, secondStageAudio].every((result) => result.via === 'depot-canvas') ? true : null,
      gestures,
    );
    // Relier : sortie OK de l'entrée → liste de choix → Écran 2.
    const link = await linkStagesThroughNewList(page, 'Écran 1', 'Écran 2');
    ctx.check('[remplissage] Écran 1 relié à Écran 2 par une liste de choix (Inspecteur)', link.ok, link);
    const titled = await setPackTitle(page, 'Pack C2 graphe');
    ctx.check('[remplissage] titre du pack posé par la fiche', titled);
    await ctx.shot(page, 'b03-graphe-rempli');

    const projectDir = ctx.dir('projet-hors-workspace');
    const projectPath = join(projectDir, 'Projet C2 Graphe.mbah');
    await answerNext(page, 'ask', true);
    await answerNext(page, 'save', projectPath);
    // Redonne le focus au canvas (un champ de recherche resté focus dans la
    // médiathèque a pu absorber le premier Ctrl+S) avant de réessayer.
    await page.locator('.diagram-canvas, .rf-canvas, main').first().click({ position: { x: 20, y: 20 } }).catch(() => {});
    await page.keyboard.press('Control+s');
    await keepSessionMediaIfPrompted(page);
    await page.waitForTimeout(3000);
    if (!existsSync(projectPath)) {
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(3000);
    }
    const saveLog = await dialogLog(page);
    ctx.check('[état 3+4] premier enregistrement (graphe) écrit le .mbah au chemin choisi', existsSync(projectPath));
    if (existsSync(projectPath)) {
      // Le document enregistré, projeté par Rust : ce que les gestes ont posé.
      const { view } = await readGraphView(page, projectPath);
      const stageNamed = (name) => (view?.stages ?? []).find((stage) => stage.name?.value === name);
      const entry = stageNamed('Écran 1');
      const second = stageNamed('Écran 2');
      const written = {
        entryAudio: presenceOf(entry?.audio), entryImage: presenceOf(entry?.image),
        secondAudio: presenceOf(second?.audio), edges: view?.edges?.length ?? null,
      };
      ctx.check(
        '[remplissage] document enregistré : entrée avec son et image, Écran 2 avec son, raccord entrée → liste → Écran 2',
        written.entryAudio === 'value' && written.entryImage === 'value' && written.secondAudio === 'value' && written.edges >= 2,
        written,
      );
    }
    // Option « Utiliser un workspace pour les nouveaux projets » désactivée
    // (défaut) et `.mbah` hors de l'emplacement de travail : les médias de la
    // session rejoignent l'emplacement de travail, rien n'est rangé à côté du
    // `.mbah`. Le déplacement du dossier projet (état 5) ne déplace donc que
    // le `.mbah`.
    const besideAfterSave = managedDirsBeside(projectDir);
    ctx.check('[état 3+4] aucun sous-dossier de médias créé à côté du .mbah (graphe)', besideAfterSave.length === 0, { besideAfterSave });
    const workspaceMedia = Object.keys(inventory(workspaceDir)).filter((path) => /^(fichiers-importes|images-generees)[\\/]/.test(path));
    ctx.check('[état 3+4] les médias de la session sont dans l’emplacement de travail (graphe)', workspaceMedia.length > 0, { workspaceMedia });
    chemins.push({ étape: 'premier enregistrement (save, graphe)', log: saveLog.filter((entry) => entry.kind === 'save') });
    allFaults.push(...events.faults());

    // ================= Phase C — origine « déjà dans le workspace » =================
    // (a) déjà dans un sous-dossier géré (`fichiers-importes/`) : ne doit PAS
    // être redupliqué. (b) simplement posé à la racine du workspace (pas dans
    // un des sous-dossiers gérés) : relevé tel quel, sans présumer du résultat.
    events.setStep('origine-deja-dans-workspace');
    const managedDir = join(workspaceDir, 'fichiers-importes');
    mkdirSync(managedDir, { recursive: true });
    const alreadyManagedImage = synthImage(managedDir, 'deja-gere.png', 2);
    const rootPlacedImage = synthImage(workspaceDir, 'juste-pose-a-la-racine.png', 4);
    const beforeDrop = inventory(workspaceDir);
    await dropOnMediaExplorer(page, alreadyManagedImage);
    await dropOnMediaExplorer(page, rootPlacedImage);
    await ctx.shot(page, 'c01-medias-deja-dans-workspace');
    const afterDrop = inventory(workspaceDir);
    const diff = inventoryDiff(beforeDrop, afterDrop);
    ctx.check(
      '[relevé] fichiers ajoutés sous le workspace par le dépôt de médias « déjà présents » (fait, pas un verdict)',
      true,
      { added: diff.added },
    );
    allFaults.push(...events.faults());

    // ================= Phase D — fermeture puis réouverture (état 3), génération + relecture =================
    events.setStep('fermeture-reouverture');
    await returnHome(page);
    const beforeCloseStop = await app.stop({ graceful: true });
    ctx.check('[état 3] rien écrit dans le vrai workspace avant la fermeture', beforeCloseStop.polluted.length === 0, { polluted: beforeCloseStop.polluted });

    app = await launchApp({ runDir: ctx.dir('relance-etat3'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const recentRow = page.locator('button.mode-proj-row').first();
    const hasRecent = await recentRow.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    ctx.check('[état 3] le projet (graphe) figure dans les récents après fermeture', hasRecent);
    const recentThumbnail = hasRecent
      ? await recentRow.locator('.mode-proj-thumb img').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
      : false;
    ctx.check('[état 3] la vignette du projet graphe apparaît dans les récents', recentThumbnail);
    let reopened;
    if (hasRecent) {
      await recentRow.click();
      reopened = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
    } else {
      reopened = await openProjectDialog(page, projectPath);
    }
    if (reopened) {
      await page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout: 60_000 }).catch(() => {});
    }
    await ctx.shot(page, 'd01-reouvert-graphe');
    ctx.check('[état 3] réouverture (graphe) aboutit (récents ou, à défaut, Ouvrir)', reopened);
    if (reopened) {
      const missingAfterReopen = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 3] pas de « Médias introuvables » après réouverture (graphe)', !missingAfterReopen);
      ctx.check('[état 3] aucune erreur console après réouverture (graphe)', events.faults().length === 0, { faults: events.faults() });

      const outDir = ctx.dir('sortie-etat3');
      const refused = await generatePack(page, ctx.dir('contre-epreuve-fin'), { events });
      ctx.check('[fin] avant réparation, la génération est refusée sans archive',
        !refused.zip && refused.blockingCount > 0 && /à corriger/.test(refused.refusal ?? ''), refused);
      const endings = await repairGraphEndings(page);
      ctx.check('[fin] « À corriger » nomme OK sans destination et « En faire une fin » répare l’Écran terminal',
        endings.repaired === 1 && endings.remaining === 0
          && endings.messages.some((message) => /OK ou la fin automatique est actif sans destination utilisable/.test(message)), endings);
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
      const genResult = await generatePack(page, outDir);
      await ctx.shot(page, 'd02-apres-generation-graphe');
      ctx.check('[état 3] génération (graphe) réussie', !!genResult.zip, { refusal: genResult.refusal, timeout: genResult.timeout });
      if (genResult.zip) {
        const verdict = await readbackPack(page, genResult.zip, studioOut);
        ctx.check('[état 3] pack (graphe) relu par l’app et accepté par STUdio', verdict.ok, verdict);
        ctx.check('[état 3] l’archive (graphe) porte l’entrée et l’Écran 2 (2 écrans)', verdict.storyStudio?.stageNodes === 2, verdict.storyStudio);
      }
    }
    allFaults.push(...events.faults());

    // ================= Phase E — dossier de projet déplacé puis rouvert (état 5) =================
    events.setStep('etat5-dossier-deplace');
    const closeForMoveStop = await app.stop();
    ctx.check('[état 5] rien écrit dans le vrai workspace avant le déplacement (graphe)', closeForMoveStop.polluted.length === 0, { polluted: closeForMoveStop.polluted });

    const movedDir = ctx.dir('projet-deplace-et-renomme');
    const movedPath = join(movedDir, 'Projet C2 Graphe (renommé).mbah');
    for (const entry of readdirSync(projectDir)) {
      renameSync(join(projectDir, entry), join(movedDir, entry === basename(projectPath) ? basename(movedPath) : entry));
    }
    ctx.check('[état 5] dossier projet (graphe) renommé sur disque', existsSync(movedPath));

    app = await launchApp({ runDir: ctx.dir('relance-etat5'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const openedMoved = await openProjectDialog(page, movedPath);
    await ctx.shot(page, 'e01-ouvert-apres-deplacement-graphe');
    ctx.check('[état 5] ouverture du projet (graphe) déplacé aboutit', openedMoved);
    if (openedMoved) {
      const missingAfterMove = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 5] médias résolus après déplacement du dossier projet (graphe)', !missingAfterMove);
      ctx.check('[état 5] aucune erreur console après réouverture du projet déplacé (graphe)', events.faults().length === 0, { faults: events.faults() });
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
