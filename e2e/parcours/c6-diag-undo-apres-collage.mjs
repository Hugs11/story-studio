// Non-régression : le premier Ctrl+Z après collage retire exactement le
// nœud collé. La transaction gardée par la profondeur ne doit plus empiler une
// étape fantôme contenant deux fois l'état final.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject } from '../lib/actions.mjs';

export async function run() {
  const ctx = createRun('c6-diag-undo-apres-collage');
  const session = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  try {
    await newProject(session.page, 'pack');
    await session.page.keyboard.press('Control+Shift+N'); // addFolder, pour avoir un nœud à copier
    await session.page.waitForTimeout(500);
    await session.page.keyboard.press('Escape');
    await session.page.waitForTimeout(300);
    const node = session.page.locator('[data-tree-node-id]').last();
    await node.click();
    const count0 = await session.page.locator('[data-tree-node-id]').count();

    await session.page.keyboard.press('Control+c'); // Copier par défaut
    await session.page.keyboard.press('Control+v'); // Coller par défaut
    await session.page.waitForTimeout(500);
    const count1 = await session.page.locator('[data-tree-node-id]').count();
    ctx.check('le collage par défaut ajoute bien un nœud', count1 === count0 + 1, { count0, count1 });

    const activeElement = await session.page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, cls: el.className } : null;
    });
    ctx.check('le focus est neutre après le collage (pas un champ éditable)', activeElement?.tag === 'DIV', { activeElement });

    const undoButton = session.page.getByRole('button', { name: /Annuler/i }).first();
    const undoDisabled = await undoButton.isDisabled().catch(() => null);
    ctx.check('le bouton « Annuler » de la barre d’outils est actif juste après le collage', undoDisabled === false, { undoDisabled });

    await session.page.keyboard.press('Control+z'); // Annuler par défaut, focus neutre, bouton actif
    await session.page.waitForTimeout(500);
    const countAfterKeyboardUndo = await session.page.locator('[data-tree-node-id]').count();
    ctx.check(
      'Ctrl+Z par défaut retire exactement le nœud collé',
      countAfterKeyboardUndo === count0,
      { countAfterKeyboardUndo, count1 },
    );

    ctx.check('aucune erreur console ni exception cumulée', session.events.faults().length === 0, { faults: session.events.faults() });
  } finally {
    const stop = await session.stop({ graceful: false });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
