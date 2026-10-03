// Vérifie si le KO « le projet figure dans les récents après fermeture »
// (observé dans c2-menus et c2-simple) est un artefact de l'arrêt brutal
// (taskkill /F, localStorage WebView2 pas forcément vidé) ou un vrai
// comportement applicatif. Reprend la séquence minimale qui a déclenché le KO
// (média + bascule de la préférence de copie + 2 Ctrl+S) mais ferme PROPREMENT
// (`stop({ graceful: true })`) avant de relancer.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, projectMenuButton } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { synthTone, difficultPathsRoot } from '../lib/fixtures.mjs';
import { setCopyImportedFilesPreference, dropOnTree } from '../lib/c2-helpers.mjs';

export async function run() {
  const ctx = createRun('c2-recents-graceful');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const projectPath = join(ctx.dir('projet-hors-workspace'), 'Projet C2 Recents Graceful.mbah');
  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;
  try {
    await newProject(page, 'pack');
    await setCopyImportedFilesPreference(page, true);
    const mediaA = synthTone(difficult.spaces, 'histoire avec espaces.wav', 440);
    await dropOnTree(page, mediaA);
    await answerNext(page, 'ask', true);
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    ctx.check('1er enregistrement écrit', existsSync(projectPath));

    await setCopyImportedFilesPreference(page, false);
    const mediaB = synthTone(difficult.accents, 'histoire accentuée éà.wav', 620);
    await dropOnTree(page, mediaB);
    // Projet potentiellement pas encore « propre » selon la même course que
    // le constat original : une réponse `ask` de repli est posée au cas où
    // la fermeture propre déclencherait « Enregistrer avant de quitter ? ».
    await answerNext(page, 'ask', false);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2500);

    const recentsBeforeClose = await page.evaluate(() => window.localStorage.getItem('recentProjects'));
    ctx.check('[relevé] recentProjects juste avant la fermeture propre', true, { recentsBeforeClose });

    events.setStep('fermeture-propre');
    const closeResult = await app.stop({ graceful: true });
    ctx.check('fermeture propre effective (pas de repli taskkill)', closeResult.closedGracefully === true, closeResult);
    ctx.check('rien écrit dans le vrai workspace à la fermeture propre', closeResult.polluted.length === 0, { polluted: closeResult.polluted });

    app = await launchApp({ runDir: ctx.dir('relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
    const recentRow = page.locator('button.mode-proj-row').first();
    const hasRecent = await recentRow.count() > 0;
    ctx.check('[constat] le projet figure dans les récents après une fermeture PROPRE', hasRecent);
    if (hasRecent) {
      await recentRow.click();
      const reopened = await projectMenuButton(page).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      ctx.check('réouverture par les récents aboutit', reopened);
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const lastStop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace (dernier contrôle)', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }
  return ctx.finish();
}
