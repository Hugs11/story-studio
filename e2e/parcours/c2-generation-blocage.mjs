// Identifier ce qui bloque `generatePack` après réouverture (KO « génération
// réussie » observé en simple et menus). Reproduit la scène minimale (nouveau
// projet + 1 média audio par histoire, rien d'autre) et inspecte directement le
// panneau « à corriger » et l'état du bouton « Générer le pack », au lieu de
// lancer Ctrl+G à l'aveugle.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject } from '../lib/actions.mjs';
import { synthTone, difficultPathsRoot } from '../lib/fixtures.mjs';
import { dropOnTree } from '../lib/c2-helpers.mjs';

export async function run() {
  const ctx = createRun('c2-generation-blocage');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  try {
    await newProject(page, 'pack');
    const media = synthTone(difficult.spaces, 'histoire.wav', 440);
    await dropOnTree(page, media);
    await ctx.shot(page, '01-media-depose');

    const genButton = page.getByRole('button', { name: /Générer le pack/ }).first();
    const disabled = await genButton.isDisabled().catch(() => null);
    ctx.check('[relevé] état du bouton « Générer le pack »', true, { disabled });

    const toCorrect = page.getByRole('button', { name: /à corriger/ }).first();
    const hasToCorrect = await toCorrect.count() > 0;
    ctx.check('[relevé] présence du badge « à corriger »', true, { hasToCorrect });
    if (hasToCorrect) {
      await toCorrect.click();
      await page.waitForTimeout(500);
      await ctx.shot(page, '02-liste-a-corriger-ouverte');
      const issuesText = await page.evaluate(() => document.body.innerText);
      const relevant = issuesText.split('\n').filter((line) => /image|audio|manquant|requis|titre/i.test(line)).slice(0, 30);
      ctx.check('[relevé] extrait des lignes « à corriger »', true, { relevant });
    }

    // Tente quand même Ctrl+G pour voir si un dialogue/état apparaît.
    await page.keyboard.press('Control+g');
    await page.waitForTimeout(2000);
    await ctx.shot(page, '03-apres-ctrl-g');
    const modalCount = await page.locator('[role="dialog"], [role="alertdialog"]').count();
    ctx.check('[relevé] une boîte modale s’ouvre après Ctrl+G malgré les corrections manquantes', true, { modalCount });

    ctx.check('aucune erreur console', events.faults().length === 0, { faults: events.faults() });
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
