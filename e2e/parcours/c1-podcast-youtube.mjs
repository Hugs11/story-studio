// Podcast et YouTube : ouvrir le funnel depuis l'accueil puis annuler
// (l'import réel est couvert par les parcours c5-*). Vérifie que l'annulation ne
// laisse rien dans le workspace et que l'accueil reste utilisable ensuite.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { MODALS, closeFunnel, goHome } from '../lib/actions.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';

const ENTRIES = [
  { tile: 'Créer un pack depuis un podcast', label: 'Podcast' },
  { tile: 'Créer un pack depuis YouTube', label: 'YouTube' },
];

export async function run() {
  const ctx = createRun('c1-podcast-youtube');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];
  try {
    for (const { tile, label } of ENTRIES) {
      events.setStep(`ouverture-${label}`);
      await goHome(page);
      const before = inventory(workspaceDir);
      await page.getByText(tile, { exact: true }).click();
      const opened = await page.locator(MODALS).first()
        .waitFor({ timeout: 30_000 }).then(() => true, () => false);
      await ctx.shot(page, `${label.toLowerCase()}-ouvert`);
      ctx.check(`« ${tile} » ouvre le funnel`, opened);

      events.setStep(`annulation-${label}`);
      const closed = await closeFunnel(page);
      await goHome(page);
      await ctx.shot(page, `${label.toLowerCase()}-annule`);
      const after = inventory(workspaceDir);
      ctx.check(`« ${label} » : annuler ferme le funnel`, closed);
      ctx.check(`« ${label} » : annuler ne laisse rien dans le workspace`, inventoryDiff(before, after).added.length === 0, {
        diff: inventoryDiff(before, after),
      });
      ctx.check(`« ${label} » : l'accueil reste utilisable après annulation`, await page.locator('.mode-selector').isVisible().catch(() => false));
      ctx.check(`« ${label} » : aucune erreur console`, events.faults().length === 0, { faults: events.faults() });
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false);
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception sur tout le parcours', allFaults.length === 0, { faults: allFaults });
    const stop = await app.stop();
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
