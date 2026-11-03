// Identifier ce qui bloque `generatePack` après réouverture (KO « génération
// réussie » observé en simple et menus). Reproduit la scène minimale (nouveau
// projet + 1 média audio par histoire, rien d'autre) et inspecte directement le
// panneau « à corriger » et l'état du bouton « Générer le pack », au lieu de
// lancer Ctrl+G à l'aveugle.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, waitValidationSettled } from '../lib/actions.mjs';
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

    const validation = await waitValidationSettled(page);
    ctx.check('vérification achevée avec corrections requises', validation.settled && validation.count > 0, validation);
    const genButton = page.getByRole('button', { name: /Générer le pack/ }).first();
    const disabled = await genButton.isDisabled().catch(() => null);
    ctx.check('génération désactivée tant que le projet est incomplet', disabled === true, { disabled });

    const toCorrect = page.getByRole('button', { name: /à corriger/ }).first();
    const hasToCorrect = await toCorrect.count() > 0;
    ctx.check('badge « à corriger » présent', hasToCorrect, { hasToCorrect });
    if (hasToCorrect) {
      await toCorrect.hover();
      const diagnostics = page.locator('.validation-pill-dd');
      if (!await diagnostics.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) await toCorrect.click();
      await diagnostics.waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      await ctx.shot(page, '02-liste-a-corriger-ouverte');
      const items = diagnostics.locator('.validation-pill-item-label');
      const labels = [];
      for (let i = 0, count = await items.count(); i < count; i += 1) labels.push(await items.nth(i).innerText());
      const issuesText = labels.join('\n');
      const relevant = issuesText.split('\n').filter((line) => /image|audio|manquant|requis|titre/i.test(line)).slice(0, 30);
      ctx.check('diagnostics de champs requis présents', relevant.length > 0 && labels.length === validation.count, { relevant, labels });
    }

    await page.keyboard.press('Escape');
    // Tente quand même Ctrl+G pour voir si un dialogue/état apparaît.
    await page.keyboard.press('Control+g');
    await page.waitForTimeout(2000);
    await ctx.shot(page, '03-apres-ctrl-g');
    const modalCount = await page.locator('[role="dialog"], [role="alertdialog"]').count();
    ctx.check('Ctrl+G garde la génération bloquée sans modale', modalCount === 0, { modalCount });

    ctx.check('aucune erreur console', events.faults().length === 0, { faults: events.faults() });
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
