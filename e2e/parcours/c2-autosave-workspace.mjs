// État 2 : autosave dans le workspace.
//
// N'existe que pour un projet en mode « project » (pas éphémère), donc
// seulement si « Utiliser un workspace pour les nouveaux projets » est
// activé (préférence par défaut désactivée — voir
// `ProjectsMediaSection.jsx`) : `useAutosave.js` écrit alors, toutes les
// 5 minutes, dans `workspace/sauvegardes/<nom>_<horodatage>.mbah`, SANS
// jamais poser `store.savePath` (recherché en vain dans les récents/en-tête
// tant que l'auteur n'a pas enregistré explicitement). Attente réelle du
// palier (~5 min) : parcours volontairement long, à lancer isolément.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome, projectMenuButton, generatePack } from '../lib/actions.mjs';
import { synthTone, difficultPathsRoot } from '../lib/fixtures.mjs';
import { readbackPack, inventory } from '../lib/oracles.mjs';
import { setUseWorkspaceForNewProjectsPreference, dropOnTree, hasMissingMediaModal, openProjectDialog } from '../lib/c2-helpers.mjs';

const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;
const MARGIN_MS = 60_000;

export async function run() {
  const ctx = createRun('c2-autosave-workspace');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const studioOut = ctx.dir('studio-work');
  const allFaults = [];

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // Activer la préférence exige d'être dans un éditeur (Ctrl+Maj+O n'agit
    // pas depuis l'accueil) : projet jetable, réglage, retour accueil.
    events.setStep('activation-preference');
    await newProject(page, 'pack');
    await setUseWorkspaceForNewProjectsPreference(page, true);
    await returnHome(page);
    await page.waitForTimeout(500);

    // Nouveau projet : doit maintenant démarrer directement en mode
    // « project » (pas de session éphémère), workspace = celui injecté.
    events.setStep('nouveau-projet-mode-workspace');
    await newProject(page, 'pack');
    await ctx.shot(page, '01-nouveau-projet-mode-workspace');
    const media = synthTone(difficult.spaces, 'histoire avec espaces.wav', 440);
    await dropOnTree(page, media);
    await ctx.shot(page, '02-media-depose');

    const sauvegardesDir = join(workspaceDir, 'sauvegardes');
    const before = inventory(sauvegardesDir);
    ctx.check('[relevé] contenu de workspace/sauvegardes/ avant le palier d’autosave', true, { before });

    events.setStep('attente-palier-autosave');
    console.log(`Attente du palier d’autosave (~${Math.round((AUTOSAVE_INTERVAL_MS + MARGIN_MS) / 1000)} s)...`);
    await page.waitForTimeout(AUTOSAVE_INTERVAL_MS + MARGIN_MS);

    const after = inventory(sauvegardesDir);
    const newFiles = Object.keys(after).filter((name) => !(name in before) && name.endsWith('.mbah'));
    ctx.check('[état 2] un fichier autosauvegardé apparaît dans workspace/sauvegardes/ sans action de l’auteur', newFiles.length > 0, { newFiles, after });
    allFaults.push(...events.faults());

    let autosavePath = null;
    if (newFiles.length > 0) {
      autosavePath = join(sauvegardesDir, newFiles[0]);
      const stat = statSync(autosavePath);
      ctx.check('[relevé] chemin et taille du fichier autosauvegardé', true, { autosavePath, size: stat.size });
    }

    // L'autosave ne pose jamais `store.savePath` : le fil d'Ariane doit
    // rester « Projet non enregistré » malgré l'écriture disque.
    const breadcrumb = await projectMenuButton(page).innerText().catch(() => null);
    ctx.check('[relevé] fil d’Ariane après le palier d’autosave (fait, pas un verdict)', true, { breadcrumb });

    events.setStep('fermeture-reouverture');
    const beforeCloseStop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace avant la fermeture', beforeCloseStop.polluted.length === 0, { polluted: beforeCloseStop.polluted });

    if (autosavePath) {
      app = await launchApp({ runDir: ctx.dir('relance'), fresh: false, workspaceDir });
      ({ page, events } = app);
      await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
      const recentRow = page.locator('button.mode-proj-row').first();
      const hasRecent = await recentRow.count() > 0;
      ctx.check('[relevé] le fichier autosauvegardé figure (ou non) dans les récents (fait, pas un verdict)', true, { hasRecent });

      const opened = await openProjectDialog(page, autosavePath);
      await ctx.shot(page, '03-reouvert-fichier-autosauvegarde');
      ctx.check('[état 2] le fichier autosauvegardé s’ouvre correctement (Ouvrir)', opened);
      if (opened) {
        const missing = await hasMissingMediaModal(page, 4000);
        ctx.check('[état 2] le média se résout après réouverture du fichier autosauvegardé', !missing);
        ctx.check('[état 2] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });

        const outDir = ctx.dir('sortie-etat2');
        const genResult = await generatePack(page, outDir);
        ctx.check('[état 2] génération depuis le fichier autosauvegardé réussie', !!genResult.zip, { refusal: genResult.refusal, timeout: genResult.timeout });
        if (genResult.zip) {
          const verdict = await readbackPack(page, genResult.zip, studioOut);
          ctx.check('[état 2] pack relu par l’app et accepté par STUdio', verdict.ok, verdict);
        }
      }
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception sur tout le parcours (cumul)', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace sur tout le parcours (dernier contrôle)', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }
  return ctx.finish();
}
