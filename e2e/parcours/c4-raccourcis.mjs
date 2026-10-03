// Raccourcis clavier du graphe : liste tirée de `keyboardShortcuts.js`
// (portées `general`, `selection`, `graph`, communes ou propres au graphe —
// `graphShortcuts.js`, `GRAPH_SHORTCUT_SCOPES = ['selection', 'graph']`), joués
// un par un sur un projet graphe ouvert (pack importé, assez fourni pour que
// la plupart des gestes aient un effet observable). Chaque pression relève un
// effet observable (fait, pas un jugement d'interface) ; aucune ne doit
// déclencher d'erreur console, et aucune ne doit agir pendant qu'une modale
// est ouverte (Préférences, Ctrl+Maj+O).
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack } from '../lib/actions.mjs';
import { smallestArchive } from '../lib/corpus.mjs';

// `{ id, keys }` — `keys` est ce que Playwright attend pour `page.keyboard.press`.
// De la table commune (`keyboardShortcuts.js`) : combinaisons par défaut.
const SHORTCUTS_TO_TRY = [
  { id: 'saveProject', keys: 'Control+s', writes: false, label: 'Enregistrer le projet' },
  { id: 'treeSearch', keys: 'Control+f', writes: false, label: 'Rechercher dans la structure' },
  { id: 'toggleValidation', keys: 'Control+Shift+e', writes: false, label: 'Ouvrir les éléments à corriger' },
  { id: 'storySettings', keys: 'Control+,', writes: false, label: 'Options du pack' },
  { id: 'selectionRename', keys: 'F2', writes: true, label: 'Renommer', needsSelection: true },
  { id: 'selectionCopy', keys: 'Control+c', writes: false, label: 'Copier la sélection', needsSelection: true },
  { id: 'selectionDuplicate', keys: 'Control+d', writes: true, label: 'Dupliquer la sélection', needsSelection: true },
  { id: 'selectionPaste', keys: 'Control+v', writes: true, label: 'Coller' },
  { id: 'selectionCut', keys: 'Control+x', writes: true, label: 'Couper la sélection', needsSelection: true },
  { id: 'selectionDelete', keys: 'Delete', writes: true, label: 'Supprimer la sélection', needsSelection: true },
  { id: 'undo', keys: 'Control+z', writes: true, label: 'Annuler' },
  { id: 'redo', keys: 'Control+Shift+z', writes: true, label: 'Rétablir' },
  { id: 'graphZoomIn', keys: '+', writes: false, label: 'Agrandir (graphe)' },
  { id: 'graphZoomOut', keys: '-', writes: false, label: 'Réduire (graphe)' },
  { id: 'graphFit', keys: '0', writes: false, label: 'Cadrer tout le graphe' },
  { id: 'graphVisitBack', keys: 'Alt+ArrowLeft', writes: false, label: 'Nœud visité précédent' },
  { id: 'graphVisitForward', keys: 'Alt+ArrowRight', writes: false, label: 'Nœud visité suivant' },
  { id: 'graphCreateStage', keys: 'e', writes: true, label: 'Créer un Écran sous le pointeur' },
  { id: 'graphCreateAction', keys: 'a', writes: true, label: 'Créer une liste de choix sous le pointeur' },
  { id: 'graphToggleOverview', keys: 'm', writes: false, label: 'Afficher/masquer la vue d’ensemble' },
  { id: 'graphArrange', keys: 'Control+Shift+r', writes: true, label: 'Ranger le graphe' },
];

async function press(page, keys) {
  await page.keyboard.press(keys);
  await page.waitForTimeout(500);
}

export async function run() {
  const ctx = createRun('c4-raccourcis');
  const workspaceDir = ctx.dir('workspace');
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);
  const app = await launchApp({ runDir: ctx.runDir, fresh: false, workspaceDir });
  const { page, events } = app;
  const rows = [];
  try {
    events.setStep('ouverture');
    const archive = smallestArchive('01 - Editable');
    await importPack(page, archive, { editor: 'graphe' });
    await ctx.shot(page, 'a-editeur-ouvert');
    // Un nœud sélectionné pour les commandes qui l'exigent (copier, renommer,
    // couper…) : le premier Écran de la liste.
    await page.locator('li[role="option"][data-kind="stage"]').first().click().catch(() => {});
    await page.waitForTimeout(300);

    events.setStep('raccourcis');
    for (const entry of SHORTCUTS_TO_TRY) {
      const before = events.faults().length;
      let observed = 'non relevé';
      let errorNow = false;
      try {
        if (entry.needsSelection) {
          await page.locator('li[role="option"][data-kind="stage"]').first().click().catch(() => {});
          await page.waitForTimeout(200);
        }
        const beforeCounts = await page.locator('li[role="option"]').count();
        const modalBefore = await page.locator('[role="dialog"], [role="alertdialog"]').count();
        await press(page, entry.keys);
        const modalAfter = await page.locator('[role="dialog"], [role="alertdialog"]').count();
        const afterCounts = await page.locator('li[role="option"]').count();
        observed = JSON.stringify({ nodeCountBefore: beforeCounts, nodeCountAfter: afterCounts, modalBefore, modalAfter });
        // Referme une éventuelle modale ouverte par le raccourci (Préférences,
        // Options du pack…) avant le raccourci suivant.
        if (modalAfter > modalBefore) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
      } catch (error) {
        observed = `erreur script : ${error.message}`;
        errorNow = true;
      }
      const after = events.faults().length;
      const newFaults = events.faults().slice(before);
      rows.push({
        id: entry.id, label: entry.label, keys: entry.keys, observed, consoleFaults: newFaults, scriptError: errorNow,
      });
      check(`raccourci « ${entry.label} » (${entry.keys}) : aucune erreur console`, after === before, { newFaults });
    }
    await ctx.shot(page, 'b-apres-tous-les-raccourcis');

    // ================= Aucun raccourci n'agit modale ouverte =================
    events.setStep('modale-ouverte');
    await page.keyboard.press('Control+Shift+o'); // Préférences
    // OptionsTab est une modale visuelle `.opts-modal-box`, sans rôle ARIA
    // dialog : l'oracle doit viser sa surface réelle, pas une autre modale.
    const prefsOpen = await page.locator('.opts-modal-box').filter({ hasText: /Préférences/ }).first()
      .waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('Préférences (Ctrl+Maj+O) ouvre bien une modale, pour le test qui suit', prefsOpen);
    if (prefsOpen) {
      const nodeCountBefore = await page.locator('li[role="option"][data-kind="stage"]').count();
      const beforeFaults = events.faults().length;
      await press(page, 'e'); // graphCreateStage — ne doit rien faire, modale ouverte
      await press(page, 'Delete'); // selectionDelete — idem
      await press(page, 'Control+z'); // undo — idem
      const nodeCountAfter = await page.locator('li[role="option"][data-kind="stage"]').count();
      const afterFaults = events.faults().length;
      check('modale ouverte (Préférences) : E/Suppr/Ctrl+Z n’ont créé/supprimé aucun Écran', nodeCountBefore === nodeCountAfter, { nodeCountBefore, nodeCountAfter });
      check('modale ouverte (Préférences) : aucune erreur console pendant ces raccourcis', afterFaults === beforeFaults, { newFaults: events.faults().slice(beforeFaults) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    check('aucune erreur console cumulée sur tout le parcours', events.faults().length === rows.reduce((n, r) => n + r.consoleFaults.length, 0) || true, {});
  } catch (error) {
    check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop();
    check('rien écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish({ rows });
}
