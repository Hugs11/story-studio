// Matrice des chemins côté graphe : états que `c2-graphe.mjs` n'a pas atteints (sa
// Phase B s'arrête sur l'échec du premier enregistrement, avant les états 3/4/5).
//
// (3) enregistré hors workspace, fermé, rouvert ;
// (4) « Enregistrer sous » (Ctrl+Maj+S) depuis une session temporaire ;
// (5) dossier projet déplacé/renommé puis rouvert — média copie ON et copie
//     OFF, chemins à espaces/accents.
//
// Chaque état est isolé dans sa propre fenêtre (même précaution que
// `c2-graphe.mjs` : un enchaînement d'actions dans la MÊME fenêtre a déjà fait
// échouer silencieusement un enregistrement suivant, sans rapport avec l'état
// testé). Contournement : le premier enregistrement se fait TOUJOURS avant
// toute bascule de préférence ou tout dépôt de média (ordre sûr, déjà confirmé
// pour l'état neuf-vide) ; l'état (4) teste néanmoins une fois l'ordre à
// risque, pour voir si le raccourci explicite « Enregistrer sous » est logé à
// la même enseigne que le Ctrl+S simple.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome, generatePack, clickButton, MODALS } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { synthTone, difficultPathsRoot } from '../lib/fixtures.mjs';
import { readbackPack } from '../lib/oracles.mjs';
import {
  setCopyImportedFilesPreference, dropOnMediaExplorer, hasMissingMediaModal, openProjectDialog,
  saveProjectAsExplicit, managedDirsBeside, findManagedCopy, assignMediaToGraphStage,
  linkStagesThroughNewList,
} from '../lib/c2-helpers.mjs';
import { tauriLogErrors, createGraphStage, repairGraphEndings } from '../lib/c4-helpers.mjs';

// L'entrée garde sa sortie OK vers une liste ; seul le second Écran devient
// une fin. Accueil sans destination sur l'entrée serait une boucle sur soi.
async function createEndingRoute(page) {
  if (!await createGraphStage(page)) throw new Error('Création de l’Écran terminal impossible');
  const link = await linkStagesThroughNewList(page, 'Écran 1', 'Écran 2');
  if (!link.ok) throw new Error(`Raccord de la fin impossible : ${JSON.stringify(link)}`);
  return repairGraphEndings(page);
}

async function saveInPlace(page) {
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2500);
}

export async function run() {
  const ctx = createRun('c4-chemins-graphe');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const chemins = [];
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);

  // ================= État 3 — enregistré hors workspace, fermé, rouvert =====
  // Média copie ON, chemin de projet à espaces, source média accentuée.
  {
    const dir = ctx.dir('etat3');
    const workspaceDir = join(dir, 'workspace');
    const projectDir = join(dir, 'projet avec espaces');
    const projectPath = join(projectDir, 'Projet État 3.mbah');
    let app = await launchApp({ runDir: ctx.dir('etat3', 'session-1'), fresh: false, workspaceDir });
    let { page, events } = app;
    try {
      events.setStep('etat3-creation');
      await newProject(page, 'advanced');
      // Contournement : enregistrement AVANT toute bascule/tout dépôt.
      mkdirSync(projectDir, { recursive: true });
      await answerNext(page, 'save', projectPath);
      await page.keyboard.press('Control+Shift+s');
      await page.waitForTimeout(2500);
      check('[état 3] premier enregistrement (avant média/préférence) écrit le .mbah', existsSync(projectPath));

      await setCopyImportedFilesPreference(page, true);
      const media = synthTone(difficult.accents, 'média accentué éàç.wav', 990);
      await dropOnMediaExplorer(page, media);
      await saveInPlace(page);
      const savedAfterEdit = existsSync(projectPath) && statSync(projectPath).size > 0;
      check('[état 3] enregistrement après média+préférence (Ctrl+S en place) réussi', savedAfterEdit);

      const stop1 = await app.stop({ graceful: true });
      check('[état 3] fermeture propre', stop1.closedGracefully !== false, { closedGracefully: stop1.closedGracefully });
      check('[état 3] rien écrit dans le vrai workspace (session 1)', stop1.polluted.length === 0, { polluted: stop1.polluted });

      app = await launchApp({ runDir: ctx.dir('etat3', 'session-2'), fresh: false, workspaceDir });
      ({ page, events } = app);
      const reopened = await openProjectDialog(page, projectPath);
      check('[état 3] réouverture aboutit', reopened);
      if (reopened) {
        const missing = await hasMissingMediaModal(page, 5000);
        check('[état 3] pas de « Médias introuvables » après réouverture (copie ON, chemin à espaces, source accentuée)', !missing);
        check('[état 3] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
        const outDir = ctx.dir('etat3', 'sortie');
        const ending = await createEndingRoute(page);
        check('[état 3] entrée raccordée à une fin valide par les gestes de l’app', ending.repaired === 1 && ending.remaining === 0, ending);
        // Une présence en médiathèque seule ne suffit pas à fabriquer un pack.
        const empty = await generatePack(page, ctx.dir('etat3', 'sortie-sans-media'));
        check('[état 3] génération sans média lié refusée avec un message lisible',
          !empty.zip && /pack sans média/i.test(empty.refusal ?? '')
            && /ajoute au moins un média à un Écran/i.test(empty.refusal ?? ''),
          { refusal: empty.refusal, timeout: empty.timeout });
        await ctx.shot(page, 'etat3-refus-sans-media');
        await clickButton(page.locator(MODALS).filter({ hasText: /Fabrication impossible — pack sans média/ }).first(), /^Fermer$/);
        const binding = await assignMediaToGraphStage(page, events, { fileStem: 'média accentué éàç', stageName: 'Écran 1' });
        check('[état 3] son lié à un Écran par un geste de l’app', !!binding.via, binding);
        await saveInPlace(page);
        const gen = await generatePack(page, outDir);
        check('[état 3] génération réussie', !!gen.zip, { refusal: gen.refusal, timeout: gen.timeout });
        if (gen.zip) {
          const verdict = await readbackPack(page, gen.zip, ctx.dir('etat3', 'studio'));
          check('[état 3] pack relu par l’app et accepté par STUdio', verdict.ok, verdict);
        }
      }
      chemins.push({ état: 3, dialogLog: (await dialogLog(page)).filter((e) => e.kind === 'save' || e.kind === 'open') });
    } catch (error) {
      check(`[état 3] parcours interrompu : ${error.message}`, false, { stack: error.stack });
    } finally {
      const stop = await app.stop();
      check('[état 3] rien écrit dans le vrai workspace (dernier contrôle)', stop.polluted.length === 0, { polluted: stop.polluted });
      const logErrors = tauriLogErrors(ctx.dir('etat3', 'session-1')).concat(tauriLogErrors(ctx.dir('etat3', 'session-2')));
      if (logErrors.length) check('[état 3] lignes ERROR dans tauri-dev.log', null, { logErrors });
    }
  }

  // ================= État 4 — « Enregistrer sous » depuis une session temporaire =================
  {
    const dir = ctx.dir('etat4');
    const workspaceDir = join(dir, 'workspace');
    const app = await launchApp({ runDir: ctx.dir('etat4', 'session-1'), fresh: false, workspaceDir });
    const { page, events } = app;
    try {
      events.setStep('etat4-risque');
      await newProject(page, 'advanced');
      await setCopyImportedFilesPreference(page, true);
      const media = synthTone(difficult.accents, 'média État4 éàç.wav', 770);
      await dropOnMediaExplorer(page, media);
      const riskyPath = join(ctx.dir('etat4', 'risque'), 'Projet État 4 (risqué).mbah');
      await saveProjectAsExplicit(page, riskyPath);
      await page.waitForTimeout(500);
      const riskyWritten = existsSync(riskyPath);
      check(
        '[état 4] Ctrl+Maj+S après [média+préférence], sans enregistrement préalable : fait relevé (verdict dans c4-isoler-c204)',
        riskyWritten ? true : null,
        { riskyWritten, note: riskyWritten ? 'écrit malgré la séquence à risque' : 'non écrit — cohérent avec un premier enregistrement défaillant si confirmé sur le Ctrl+S simple' },
      );

      // Contournement pour poursuivre la matrice, quel que soit le résultat
      // ci-dessus : un nouveau projet, enregistré-sous AVANT tout média.
      // Retour à l'accueil d'abord : `newProject` part de l'accueil, et cette
      // fenêtre est encore dans l'éditeur ouvert par le premier `newProject`.
      await returnHome(page);
      await newProject(page, 'advanced');
      const safePath = join(ctx.dir('etat4', 'sur'), 'Projet État 4.mbah');
      await saveProjectAsExplicit(page, safePath);
      const safeWritten = existsSync(safePath);
      check('[état 4] Ctrl+Maj+S en tout premier geste (session temporaire, sans média) écrit le .mbah', safeWritten);
      check('[état 4] aucune erreur console', events.faults().length === 0, { faults: events.faults() });
    } catch (error) {
      check(`[état 4] parcours interrompu : ${error.message}`, false, { stack: error.stack });
    } finally {
      const stop = await app.stop();
      check('[état 4] rien écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
    }
  }

  // ================= État 5a — dossier déplacé/renommé, média copie ON, chemin accentué =================
  {
    const dir = ctx.dir('etat5a');
    const workspaceDir = join(dir, 'workspace');
    const originalDir = join(dir, 'dossier original');
    const originalPath = join(originalDir, 'Projet État 5a.mbah');
    let app = await launchApp({ runDir: ctx.dir('etat5a', 'session-1'), fresh: false, workspaceDir });
    let { page, events } = app;
    try {
      events.setStep('etat5a-creation');
      await newProject(page, 'advanced');
      mkdirSync(originalDir, { recursive: true });
      await answerNext(page, 'save', originalPath);
      await page.keyboard.press('Control+Shift+s');
      await page.waitForTimeout(2500);
      check('[état 5a] premier enregistrement écrit le .mbah', existsSync(originalPath));

      await setCopyImportedFilesPreference(page, true);
      const media = synthTone(difficult.accents, 'média 5a éàçßÉ.wav', 1220);
      await dropOnMediaExplorer(page, media);
      await saveInPlace(page);
      // Projet enregistré hors de l'emplacement de travail, option workspace
      // désactivée : la copie va dans `<workspace>/fichiers-importes`, jamais
      // à côté du `.mbah`.
      const copy5a = findManagedCopy(workspaceDir, basename(media));
      check('[état 5a] la copie du média est dans l’emplacement de travail', !!copy5a, { copy5a });
      const beside5a = managedDirsBeside(originalDir);
      check('[état 5a] aucun sous-dossier de médias à côté du .mbah', beside5a.length === 0, { beside5a });

      const stop1 = await app.stop({ graceful: true });
      check('[état 5a] fermeture propre avant déplacement', stop1.closedGracefully !== false, { closedGracefully: stop1.closedGracefully });
      check('[état 5a] rien écrit dans le vrai workspace (session 1)', stop1.polluted.length === 0, { polluted: stop1.polluted });

      const movedDir = join(dir, 'dossier déplacé éàç');
      mkdirSync(movedDir, { recursive: true });
      for (const entry of readdirSync(originalDir)) {
        renameSync(join(originalDir, entry), join(movedDir, entry));
      }
      const movedPath = join(movedDir, basename(originalPath));
      check('[état 5a] dossier projet déplacé/renommé sur disque', existsSync(movedPath));

      app = await launchApp({ runDir: ctx.dir('etat5a', 'session-2'), fresh: false, workspaceDir });
      ({ page, events } = app);
      const reopened = await openProjectDialog(page, movedPath);
      check('[état 5a] ouverture du projet déplacé aboutit', reopened);
      if (reopened) {
        const missing = await hasMissingMediaModal(page, 5000);
        check('[état 5a] médias résolus après déplacement (copie ON)', !missing);
        check('[état 5a] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
      }
    } catch (error) {
      check(`[état 5a] parcours interrompu : ${error.message}`, false, { stack: error.stack });
    } finally {
      const stop = await app.stop();
      check('[état 5a] rien écrit dans le vrai workspace (dernier contrôle)', stop.polluted.length === 0, { polluted: stop.polluted });
    }
  }

  // ================= État 5b — dossier déplacé/renommé, média copie OFF, source à espaces =================
  {
    const dir = ctx.dir('etat5b');
    const workspaceDir = join(dir, 'workspace');
    const originalDir = join(dir, 'dossier original');
    const originalPath = join(originalDir, 'Projet État 5b.mbah');
    let app = await launchApp({ runDir: ctx.dir('etat5b', 'session-1'), fresh: false, workspaceDir });
    let { page, events } = app;
    try {
      events.setStep('etat5b-creation');
      await newProject(page, 'advanced');
      mkdirSync(originalDir, { recursive: true });
      await answerNext(page, 'save', originalPath);
      await page.keyboard.press('Control+Shift+s');
      await page.waitForTimeout(2500);
      check('[état 5b] premier enregistrement écrit le .mbah', existsSync(originalPath));

      await setCopyImportedFilesPreference(page, false);
      // Source laissée en place (hors du dossier projet) : seul le dossier
      // projet est déplacé ci-dessous, jamais cette source.
      const media = synthTone(difficult.spaces, 'média avec espaces 5b.wav', 550);
      await dropOnMediaExplorer(page, media);
      await saveInPlace(page);
      // Copie désactivée : le fichier reste référencé à sa place, rien n'est
      // copié, ni dans l'emplacement de travail ni à côté du `.mbah`.
      const copy5b = findManagedCopy(workspaceDir, basename(media));
      const beside5b = managedDirsBeside(originalDir);
      check('[état 5b] média référencé à sa place, sans copie', !copy5b && beside5b.length === 0, { copy5b, beside5b });

      const stop1 = await app.stop({ graceful: true });
      check('[état 5b] fermeture propre avant déplacement', stop1.closedGracefully !== false, { closedGracefully: stop1.closedGracefully });
      check('[état 5b] rien écrit dans le vrai workspace (session 1)', stop1.polluted.length === 0, { polluted: stop1.polluted });

      const movedDir = join(dir, 'dossier déplacé avec espaces');
      mkdirSync(movedDir, { recursive: true });
      for (const entry of readdirSync(originalDir)) {
        renameSync(join(originalDir, entry), join(movedDir, entry));
      }
      const movedPath = join(movedDir, basename(originalPath));
      check('[état 5b] dossier projet déplacé/renommé sur disque', existsSync(movedPath));
      check('[état 5b] la source média (copie OFF) n’a pas bougé', existsSync(join(difficult.spaces, 'média avec espaces 5b.wav')));

      app = await launchApp({ runDir: ctx.dir('etat5b', 'session-2'), fresh: false, workspaceDir });
      ({ page, events } = app);
      const reopened = await openProjectDialog(page, movedPath);
      check('[état 5b] ouverture du projet déplacé aboutit', reopened);
      if (reopened) {
        const missing = await hasMissingMediaModal(page, 5000);
        check('[état 5b] médias résolus après déplacement (copie OFF, source non déplacée)', !missing);
        check('[état 5b] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
        const outDir = ctx.dir('etat5b', 'sortie');
        const ending = await createEndingRoute(page);
        check('[état 5b] entrée raccordée à une fin valide par les gestes de l’app', ending.repaired === 1 && ending.remaining === 0, ending);
        const binding = await assignMediaToGraphStage(page, events, { fileStem: 'média avec espaces 5b', stageName: 'Écran 1' });
        check('[état 5b] son lié à un Écran par un geste de l’app', !!binding.via, binding);
        await saveInPlace(page);
        const gen = await generatePack(page, outDir);
        check('[état 5b] génération réussie', !!gen.zip, { refusal: gen.refusal, timeout: gen.timeout });
        if (gen.zip) {
          const verdict = await readbackPack(page, gen.zip, ctx.dir('etat5b', 'studio'));
          check('[état 5b] pack relu par l’app et accepté par STUdio', verdict.ok, verdict);
        }
      }
    } catch (error) {
      check(`[état 5b] parcours interrompu : ${error.message}`, false, { stack: error.stack });
    } finally {
      const stop = await app.stop();
      check('[état 5b] rien écrit dans le vrai workspace (dernier contrôle)', stop.polluted.length === 0, { polluted: stop.polluted });
    }
  }

  return ctx.finish({ chemins });
}
