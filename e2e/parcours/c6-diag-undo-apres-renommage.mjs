// Non-régression : après annulation d'un renommage par Échap, le premier
// Ctrl+Z retire exactement le dossier qui venait d'être créé. La sortie du
// champ et la transaction d'ajout ne doivent ni bloquer ni décaler l'historique.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject } from '../lib/actions.mjs';

export async function run() {
  const ctx = createRun('c6-diag-undo-apres-renommage');
  const session = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  try {
    await newProject(session.page, 'pack');
    const count0 = await session.page.locator('[data-tree-node-id]').count();

    await session.page.keyboard.press('Control+Shift+N'); // addFolder : ouvre le renommage du nœud créé
    await session.page.waitForTimeout(500);
    await session.page.keyboard.press('Escape'); // sort du renommage
    await session.page.waitForTimeout(300);
    const count1 = await session.page.locator('[data-tree-node-id]').count();
    ctx.check('un dossier a bien été créé', count1 === count0 + 1, { count0, count1 });

    const undoButton = session.page.getByRole('button', { name: /Annuler/i }).first();
    const undoDisabled = await undoButton.isDisabled().catch(() => null);
    ctx.check('le bouton « Annuler » de la barre d’outils est actif juste après', undoDisabled === false, { undoDisabled });

    await session.page.keyboard.press('Control+z'); // Annuler par défaut, SANS clic préalable
    await session.page.waitForTimeout(500);
    const countAfterKeyboardUndo = await session.page.locator('[data-tree-node-id]').count();
    ctx.check(
      'Ctrl+Z juste après Échap retire exactement le dossier créé',
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
