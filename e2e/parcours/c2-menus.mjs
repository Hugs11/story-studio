// Matrice des chemins, Éditeur par menus.
//
// Couvre, dans ce mode : session temporaire jamais enregistrée (état 1),
// enregistrement hors workspace depuis cette session (états 3+4, la même
// géste — premier enregistrement d'une session éphémère — promeut la session
// ET écrit hors du workspace configuré), fermeture puis réouverture par les
// récents, dossier de projet déplacé puis rouvert (état 5), et processus tué
// pendant l'édition puis reprise (état 6). Origine des médias : espaces
// (copie activée) et accents (copie désactivée). Contre-épreuve obligatoire :
// un média déplacé après enregistrement doit faire échouer l'oracle de
// résolution.
//
// Remplissage : le projet est rempli par les champs de l'éditeur,
// comme un auteur. Médias racine (image de couverture, « Titre audio »), un
// dossier (« Créer un dossier » du menu contextuel de la racine, image et
// « Audio de sélection »), deux histoires importées DANS ce dossier
// (« Importer audio ou archive » du menu contextuel du dossier : un dépôt sur
// l'arbre les rangerait à la racine), chacune avec image et « Audio de
// sélection », puis le titre par la fiche du pack. Les deux histoires sont
// les médias à espaces (copie activée) et à accents (copie désactivée) de la
// matrice. Projet attendu : scripts/fixtures/ui-built-projects/menus.json,
// sans ses réglages de fin, soit 6 écrans relus.
import { existsSync, readdirSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import {
  newProject, returnHome, projectMenuButton, generatePack, MODALS,
} from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { synthTone, synthImage, difficultPathsRoot } from '../lib/fixtures.mjs';
import { readbackPack, inventory, inventoryDiff } from '../lib/oracles.mjs';
import { requireConfig } from '../lib/config.mjs';
import {
  setCopyImportedFilesPreference, dropOnTree, hasMissingMediaModal, openProjectDialog,
  editorCard, pickAudioField, pickImageField, setPackTitle, treeNodeAction, treeRoot, treeFolder,
  managedDirsBeside, findManagedCopy,
} from '../lib/c2-helpers.mjs';

// « Importer audio ou archive » sur le dossier (dialogue `open` multiple), puis
// la carte « L'histoire » de l'histoire importée, que l'import sélectionne :
// image et « Audio de sélection » par leurs champs.
async function importStoryIntoFolder(page, ctx, audioPath, imagePath, label) {
  await answerNext(page, 'open', [audioPath]);
  const imported = await treeNodeAction(page, treeFolder(page), /Importer audio ou archive/);
  const card = editorCard(page, "L'histoire");
  const shown = imported && await card.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const imagePosed = shown && await pickImageField(page, card, imagePath);
  const titlePosed = shown && await pickAudioField(page, card, 'Audio de sélection', synthTone(ctx.dir('titres'), `titre-${label}.wav`, 520 + label.length * 40));
  await ctx.shot(page, `b-histoire-${label}-remplie`);
  ctx.check(`[remplissage] histoire « ${label} » importée dans le dossier, image et « Audio de sélection » posés`, !!(imported && shown && imagePosed && titlePosed), {
    imported, shown, imagePosed, titlePosed,
  });
}

export async function run() {
  const ctx = createRun('c2-menus');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const studioOut = ctx.dir('studio-work');
  const allFaults = [];
  const chemins = []; // faits relevés : { étape, chemin }

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ================= Phase A — état 6 : tué pendant l'édition, reprise =================
    events.setStep('etat6-tue-pendant-edition');
    const mediaHomonymeA = synthTone(difficult.homonymsA, 'meme-nom.wav', 300);
    await newProject(page, 'pack');
    await ctx.shot(page, 'a01-nouveau-projet-menus');
    await dropOnTree(page, mediaHomonymeA);
    await ctx.shot(page, 'a02-media-homonyme-A-depose');
    await page.waitForTimeout(6000); // laisse le filet anti-crash écrire son snapshot
    allFaults.push(...events.faults());

    const beforeKillSessionsInv = inventory(join(process.env.LOCALAPPDATA, 'com.hugs11.story-studio.e2e', 'sessions'));
    const killStop = await app.stop();
    ctx.check('[état 6] rien écrit dans le vrai workspace avant l’arrêt brutal', killStop.polluted.length === 0, { polluted: killStop.polluted });

    app = await launchApp({ runDir: ctx.dir('relance-etat6'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    await ctx.shot(page, 'a03-accueil-apres-kill');
    const recoveryButton = page.locator('.mode-proj-row--recovery .mode-proj-open').first();
    const hasRecovery = await recoveryButton.count() > 0;
    ctx.check('[état 6] l’accueil propose une reprise (média homonyme A en cours d’édition)', hasRecovery);
    if (hasRecovery) {
      await recoveryButton.click();
      const recovered = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      await ctx.shot(page, 'a04-apres-reprise');
      ctx.check('[état 6] la reprise aboutit dans l’éditeur', recovered);
      const missingAfterRecovery = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 6] média résolu après reprise (pas de « Médias introuvables »)', !missingAfterRecovery);
      ctx.check('[état 6] aucune erreur console pendant la reprise', events.faults().length === 0, { faults: events.faults() });
      await returnHome(page); // abandonne + nettoie la session éphémère
      await page.waitForTimeout(1000);
    } else {
      ctx.check('[état 6] la reprise aboutit dans l’éditeur', null, { detail: 'aucune reprise proposée' });
    }
    const afterAbandonSessionsInv = inventory(join(process.env.LOCALAPPDATA, 'com.hugs11.story-studio.e2e', 'sessions'));
    const abandonDiff = inventoryDiff(beforeKillSessionsInv, afterAbandonSessionsInv);
    ctx.check('[état 6] le dossier de session abandonné est nettoyé (aucun fichier en trop dans sessions/)', abandonDiff.added.length === 0, { added: abandonDiff.added });

    // ================= Phase B — état 1 → 3+4 : session temporaire, puis premier enregistrement hors workspace =================
    events.setStep('etat1-session-temporaire');
    await newProject(page, 'pack');
    await ctx.shot(page, 'b01-nouveau-projet-menus');
    // Le raccourci Préférences (Ctrl+Maj+O) n'est câblé que dans l'éditeur :
    // on le pose ici, une fois l'éditeur ouvert, pas depuis l'accueil.
    await setCopyImportedFilesPreference(page, true);

    // Racine : image de couverture et « Titre audio » (carte « Menu Racine »).
    await treeRoot(page).click();
    const rootCard = page.locator('.root-identity-card').first();
    const images = ctx.dir('images');
    const rootImagePosed = await pickImageField(page, rootCard, synthImage(images, 'couverture.png', 0));
    const rootTitlePosed = await pickAudioField(page, rootCard, 'Titre audio', synthTone(ctx.dir('titres'), 'titre-racine.wav', 330));
    ctx.check('[remplissage] image de couverture et « Titre audio » posés par leurs champs', rootImagePosed && rootTitlePosed, { rootImagePosed, rootTitlePosed });

    // Un dossier : « Créer un dossier » sur la racine, puis sa carte « Dossier ».
    const folderCreated = await treeNodeAction(page, treeRoot(page), /Créer un dossier/);
    const folderCard = editorCard(page, 'Dossier');
    const folderShown = folderCreated && await folderCard.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const folderImagePosed = folderShown && await pickImageField(page, folderCard, synthImage(images, 'dossier.png', 1));
    const folderAudioPosed = folderShown && await pickAudioField(page, folderCard, 'Audio de sélection', synthTone(ctx.dir('titres'), 'titre-dossier.wav', 380));
    await ctx.shot(page, 'b02-dossier-rempli');
    ctx.check('[remplissage] dossier créé, image et « Audio de sélection » posés', !!(folderShown && folderImagePosed && folderAudioPosed), {
      folderCreated, folderShown, folderImagePosed, folderAudioPosed,
    });

    // Média A : chemin avec ESPACES, hors workspace, copie ACTIVÉE — importé
    // dans le dossier.
    const mediaSpaces = synthTone(difficult.spaces, 'histoire avec espaces.wav', 440);
    await importStoryIntoFolder(page, ctx, mediaSpaces, synthImage(images, 'histoire-espaces.png', 2), 'espaces');
    const missingBeforeSave = await hasMissingMediaModal(page, 3000);
    ctx.check('[état 1] média (chemin à espaces) accepté sans « Médias introuvables » en session temporaire', !missingBeforeSave);

    // Premier enregistrement (Ctrl+S depuis une session jamais enregistrée =
    // promotion + `saveProject` sans `existingPath`, donc dialogue `save`) :
    // couvre à la fois « enregistré hors workspace » (état 3) et « Save As
    // depuis une session temporaire » (état 4), même geste ici.
    const projectDir = ctx.dir('projet-hors-workspace');
    const projectPath = join(projectDir, 'Projet C2 Menus.mbah');
    await answerNext(page, 'ask', true); // accepte un éventuel « Transférer les fichiers existants ? »
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    const saveLog = await dialogLog(page);
    ctx.check('[état 3+4] premier enregistrement écrit le .mbah au chemin choisi', existsSync(projectPath));
    // Option workspace désactivée (défaut), `.mbah` hors de l'emplacement de
    // travail : la copie du média importé (copie activée) est dans
    // l'emplacement de travail, et rien n'est rangé à côté du `.mbah`.
    const besideAfterSave = managedDirsBeside(projectDir);
    ctx.check('[état 3+4] aucun sous-dossier de médias créé à côté du .mbah', besideAfterSave.length === 0, { besideAfterSave });
    const spacesCopyAfterSave = findManagedCopy(workspaceDir, basename(mediaSpaces));
    ctx.check('[état 3+4] la copie du média importé est dans <workspace>/fichiers-importes', !!spacesCopyAfterSave, { spacesCopyAfterSave });
    chemins.push({ étape: 'premier enregistrement (save)', log: saveLog.filter((entry) => entry.kind === 'save') });

    // Média B : chemin ACCENTUÉ, hors workspace, copie DÉSACTIVÉE.
    await setCopyImportedFilesPreference(page, false);
    const mediaAccents = synthTone(difficult.accents, 'histoire accentuée éà.wav', 620);
    await importStoryIntoFolder(page, ctx, mediaAccents, synthImage(images, 'histoire-accents.png', 4), 'accents');
    const titled = await setPackTitle(page, 'Pack C2 menus');
    ctx.check('[remplissage] titre du pack posé par la fiche', titled);
    await ctx.shot(page, 'b03-projet-rempli');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);

    const mbahAfterSave = existsSync(projectPath) ? (await import('node:fs')).readFileSync(projectPath, 'utf8') : '';
    chemins.push({ étape: 'contenu du .mbah après 2e enregistrement (extrait des chemins médias)', extrait: [...mbahAfterSave.matchAll(/"(?:path|audio|itemImage|image)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).slice(0, 20) });

    allFaults.push(...events.faults());

    // ================= Phase C — fermeture puis réouverture par les récents =================
    events.setStep('fermeture-reouverture');
    const beforeCloseStop = await app.stop({ graceful: true });
    ctx.check('[état 3] rien écrit dans le vrai workspace avant la fermeture', beforeCloseStop.polluted.length === 0, { polluted: beforeCloseStop.polluted });

    app = await launchApp({ runDir: ctx.dir('relance-etat3'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const recentRow = page.locator('button.mode-proj-row').first();
    const hasRecent = await recentRow.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    ctx.check('[état 3] le projet figure dans les récents après fermeture', hasRecent);
    {
      // Repli : si les récents ne le montrent pas (la promotion du projet
      // dans les récents est parfois non publiée), on rouvre quand même par le dialogue
      // « Ouvrir » pour ne pas perdre la suite de la vérification (état 3).
      let reopened;
      if (hasRecent) {
        await recentRow.click();
        reopened = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      } else {
        reopened = await openProjectDialog(page, projectPath);
      }
      await ctx.shot(page, 'c01-reouvert-par-recents');
      ctx.check('[état 3] réouverture aboutit (récents ou, à défaut, Ouvrir)', reopened);
      const missingAfterReopen = await hasMissingMediaModal(page, 4000);
      ctx.check('[état 3] les 2 médias (espaces + accents) se résolvent après réouverture', !missingAfterReopen);
      ctx.check('[état 3] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });

      // Génération + relecture depuis cet état.
      const outDir = ctx.dir('sortie-etat3');
      const genResult = await generatePack(page, outDir);
      await ctx.shot(page, 'c02-apres-generation');
      ctx.check('[état 3] génération réussie', !!genResult.zip, { refusal: genResult.refusal, timeout: genResult.timeout });
      if (genResult.zip) {
        const verdict = await readbackPack(page, genResult.zip, studioOut);
        ctx.check('[état 3] pack relu par l’app et accepté par STUdio', verdict.ok, verdict);
        ctx.check('[état 3] l’archive porte couverture, dossier, deux titres et deux récits (6 écrans)', verdict.storyStudio?.stageNodes === 6, verdict.storyStudio);
      }
    }
    allFaults.push(...events.faults());

    // ================= Phase D — dossier de projet déplacé puis rouvert (état 5) =================
    events.setStep('etat5-dossier-deplace');
    const closeForMoveStop = await app.stop();
    ctx.check('[état 5] rien écrit dans le vrai workspace avant le déplacement', closeForMoveStop.polluted.length === 0, { polluted: closeForMoveStop.polluted });

    const movedDir = ctx.dir('projet-deplace-et-renomme');
    const movedPath = join(movedDir, 'Projet C2 Menus (renommé).mbah');
    // Déplace tout le dossier projet : il ne contient que le .mbah, les médias
    // copiés restent dans l'emplacement de travail.
    for (const entry of readdirSync(projectDir)) {
      renameSync(join(projectDir, entry), join(movedDir, entry === basename(projectPath) ? basename(movedPath) : entry));
    }
    ctx.check('[état 5] dossier projet renommé sur disque', existsSync(movedPath));

    app = await launchApp({ runDir: ctx.dir('relance-etat5'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    // Ouverture par « Ouvrir un projet » (dialogue shimmé) vers le nouvel emplacement,
    // pas par les récents : l'ancien chemin des récents ne pointe plus vers rien.
    const openedMoved = await openProjectDialog(page, movedPath);
    await ctx.shot(page, 'd01-ouvert-apres-deplacement');
    ctx.check('[état 5] ouverture du projet déplacé aboutit', openedMoved);
    if (openedMoved) {
      const missingAfterMove = await hasMissingMediaModal(page, 4000);
      // Fait, pas un verdict : selon que les médias sont référencés en absolu
      // (hors workspace) ou copiés dans un dossier géré déplacé avec le projet,
      // le résultat diffère. Les deux chemins sources d'origine (espaces,
      // accents) restent en dehors du dossier projet déplacé : c'est le cas
      // « référence absolue vers un fichier qui n'a pas bougé », qui doit se
      // résoudre puisque le fichier source, lui, est resté en place.
      ctx.check('[état 5] médias résolus après déplacement du dossier projet (sources non déplacées)', !missingAfterMove);
      ctx.check('[état 5] aucune erreur console après réouverture du projet déplacé', events.faults().length === 0, { faults: events.faults() });
    }
    allFaults.push(...events.faults());

    // ================= Phase E — contre-épreuve obligatoire =================
    // On déplace maintenant le MÉDIA (pas le projet) hors de son emplacement
    // enregistré : l'oracle « chaque média se résout » doit échouer, sinon il
    // ne prouve rien.
    events.setStep('contre-epreuve');
    // On déplace le média à ESPACES (copie ACTIVÉE), pas celui à accents :
    // avec la copie activée, le .mbah référence la copie rangée dans
    // `<workspace>/fichiers-importes/`, pas le fichier source original — c'est
    // donc CETTE copie qu'il faut déplacer pour que le projet perde réellement
    // sa référence.
    const spacesCopyPath = findManagedCopy(workspaceDir, basename(mediaSpaces));
    const displacedMediaDir = ctx.dir('media-deplace-contre-epreuve');
    mkdirSync(displacedMediaDir, { recursive: true });
    if (spacesCopyPath && existsSync(spacesCopyPath)) {
      renameSync(spacesCopyPath, join(displacedMediaDir, basename(spacesCopyPath)));
    } else if (existsSync(mediaSpaces)) {
      // Repli si le nom de copie réel diffère de ce qui est anticipé ici :
      // déplace au moins la source d'origine (fait relevé quand même).
      renameSync(mediaSpaces, join(displacedMediaDir, basename(mediaSpaces)));
    }
    const closeForCounterProofStop = await app.stop();
    app = await launchApp({ runDir: ctx.dir('relance-contre-epreuve'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const openedAfterMove = await openProjectDialog(page, movedPath);
    ctx.check('[contre-épreuve] réouverture aboutit malgré le média déplacé', openedAfterMove);
    if (openedAfterMove) {
      const missingDetected = await hasMissingMediaModal(page, 6000);
      await ctx.shot(page, 'e01-contre-epreuve-media-manquant');
      ctx.check('[contre-épreuve] « Médias introuvables » apparaît bien quand un média a été déplacé (l’oracle détecte réellement une régression)', missingDetected);
    }

    allFaults.push(...events.faults());
    chemins.push({
      étape: 'chemins de sortie (dossier scripté vs defaultPath naturel)',
      note: 'Le tableau complet des dialogLog est dans les données du parcours.',
    });
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
