// Ouvrir un projet, récents, reprise de session après arrêt brutal.
// Projet vierge créé par le script (aucune donnée personnelle).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { goHome, newProject, projectMenuButton, returnHome } from '../lib/actions.mjs';
import { createGraphStage, graphNodeListItem } from '../lib/c4-helpers.mjs';
import { answerNext } from '../lib/dialogs.mjs';

export async function run() {
  const ctx = createRun('c1-ouverture');
  const workspaceDir = ctx.dir('workspace');
  const projectPath = join(ctx.dir('projet'), 'Projet C1.mbah');

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;
  const allFaults = [];
  try {
    events.setStep('creation');
    await goHome(page);
    await newProject(page, 'pack');

    events.setStep('enregistrement');
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    ctx.check('projet vierge enregistré à l’emplacement choisi', existsSync(projectPath));
    await returnHome(page);

    // --- Ouvrir un projet (dialogue, via le shim) ---
    events.setStep('ouvrir-dialogue');
    await answerNext(page, 'open', projectPath);
    await page.getByText('Ouvrir un projet', { exact: true }).click();
    const openedByDialog = await projectMenuButton(page)
      .waitFor({ timeout: 60_000 }).then(() => true, () => false);
    await ctx.shot(page, 'ouvert-par-dialogue');
    ctx.check('« Ouvrir un projet » (dialogue shimmé) ouvre l’éditeur', openedByDialog);
    ctx.check('aucune erreur console après ouverture par dialogue', events.faults().length === 0, { faults: events.faults() });
    if (openedByDialog) await returnHome(page);

    // --- Récents ---
    events.setStep('recents');
    const recentRow = page.locator('button.mode-proj-row').first();
    const hasRecent = await recentRow.count() > 0;
    ctx.check('le projet figure dans les récents de l’accueil', hasRecent);
    if (hasRecent) {
      await recentRow.click();
      const openedByRecent = await projectMenuButton(page)
        .waitFor({ timeout: 60_000 }).then(() => true, () => false);
      await ctx.shot(page, 'ouvert-par-recents');
      ctx.check('ouverture par les récents aboutit', openedByRecent);
      if (openedByRecent) await returnHome(page);
    } else {
      ctx.check('ouverture par les récents aboutit', null, { detail: 'aucune ligne récente trouvée' });
    }

    // --- Reprise de session après arrêt brutal ---
    // D2 (19fb29cf) : aucune reprise pour un projet intact.
    events.setStep('contre-epreuve-projet-intact');
    await newProject(page, 'advanced');
    await page.waitForTimeout(6000);
    allFaults.push(...events.faults());
    const intactStop = await app.stop();
    ctx.check('projet intact : workspace réel intact', intactStop.polluted.length === 0, intactStop);
    app = await launchApp({ runDir: ctx.dir('relance-intact'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await goHome(page);
    const unexpectedRecovery = await page.locator('.mode-proj-row--recovery').first()
      .waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);
    ctx.check('projet non modifié : aucune reprise proposée (D2)', !unexpectedRecovery);
    events.setStep('reprise-preparation');
    await newProject(page, 'advanced');
    const addedAt = Date.now();
    await createGraphStage(page);
    // Référence v3 (91b0a051), payload IPC : le graphe neuf possède déjà
    // Écran 1. Le geste ajoute Écran 2, qui est la modification à conserver.
    await graphNodeListItem(page, 'Écran 2', 'stage').waitFor({ timeout: 60_000 });
    const snapshot = await waitPublishedStage(page, events, addedAt, 'Écran 2');
    ctx.check('snapshot final publié avec l’Écran ajouté avant le kill', !!snapshot.uuid, snapshot);
    allFaults.push(...events.faults());
    events.setStep('reprise-kill');
    const firstStop = await app.stop(); // taskkill /F : ni beforeunload, ni fermeture propre
    ctx.check('rien d’écrit dans le vrai workspace avant l’arrêt brutal', firstStop.polluted.length === 0, { polluted: firstStop.polluted });

    app = await launchApp({ runDir: ctx.dir('relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await goHome(page);
    await ctx.shot(page, 'accueil-apres-crash');
    const recoveryButton = page.locator('.mode-proj-row--recovery .mode-proj-open').first();
    const hasRecovery = await recoveryButton.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    ctx.check('l’accueil propose une reprise après arrêt brutal', hasRecovery);
    if (hasRecovery) {
      await recoveryButton.click();
      const recovered = await projectMenuButton(page)
        .waitFor({ timeout: 60_000 }).then(() => true, () => false);
      const stageRecovered = await graphNodeListItem(page, 'Écran 2', 'stage')
        .waitFor({ timeout: 60_000 }).then(() => true, () => false);
      await ctx.shot(page, 'apres-reprise');
      ctx.check('la reprise proposée aboutit dans l’éditeur', recovered);
      const restoredPayload = events.ipc().filter(entry => entry.cmd === 'validate_advanced_payload')
        .some(entry => JSON.parse(entry.body.payload).document.stageNodes.some(stage => stage.uuid === snapshot.uuid && stage.name === 'Écran 2'));
      ctx.check('la reprise conserve l’Écran ajouté avant le kill', stageRecovered && restoredPayload, { uuid: snapshot.uuid });
      ctx.check('aucune erreur console pendant la reprise', events.faults().length === 0, { faults: events.faults() });
    } else {
      ctx.check('la reprise proposée aboutit dans l’éditeur', null, { detail: 'aucune reprise proposée' });
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false);
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception sur tout le parcours', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    ctx.check('rien d’écrit dans le vrai workspace', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }
  return ctx.finish();
}

async function waitPublishedStage(page, events, after, name) {
  const deadline = Date.now() + 60_000;
  do {
    const paths = events.ipc().filter(entry => entry.at >= after && entry.cmd === 'plugin:fs|rename'
      && entry.body?.newPath?.endsWith('.session-recovery.mbah')).map(entry => entry.body.newPath);
    for (const path of new Set(paths)) {
      try {
        const project = JSON.parse(readFileSync(path, 'utf8'));
        const stage = JSON.parse(project.authoring.payload).document.stageNodes.find(node => node.name === name);
        if (stage?.uuid) return { path, uuid: stage.uuid };
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error('Snapshot final contenant ' + name + ' non publié sous 60 s');
}
