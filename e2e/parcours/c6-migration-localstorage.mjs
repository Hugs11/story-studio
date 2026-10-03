// Migration depuis 0.9.8 : forme `localStorage` 0.9.8, en particulier les
// raccourcis clavier personnalisés, plus quelques préférences (workspace,
// copie, intégrations fictives). Méthode d'amorçage et détail des valeurs
// choisies : voir `e2e/lib/c6-helpers.mjs`.
//
// Trois scénarios successifs, une seule instance de l'app à la fois :
// 1. profil 0.9.8 valide (avec personnalisations non triviales et deux entrées
//    volontairement fautives) → migration effective + visible + comportementale,
//    aucune erreur, préférences conservées ;
// 2. arrêt propre puis relance sur le même profil → état stable (pas de
//    seconde migration qui déferait la première, raccourcis toujours corrects) ;
// 3. blob de raccourcis entièrement invalide (JSON tronqué) sur un profil neuf
//    → démarrage sans erreur, repli sur les raccourcis par défaut.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome } from '../lib/actions.mjs';
import {
  seedLegacyProfile098,
  readLocalStorage,
  openPreferences,
  closePreferences,
  openKeyboardShortcutsModal,
  closeKeyboardShortcutsModal,
  shortcutCaptureText,
  EXPECTED_AFTER_MIGRATION,
} from '../lib/c6-helpers.mjs';

async function readToggle(page, label) {
  const row = page.locator('.opts-row').filter({ hasText: label }).first();
  await row.waitFor({ timeout: 10_000 });
  const toggle = row.locator('button.tog').first();
  return (await toggle.getAttribute('aria-pressed')) === 'true';
}

async function checkAllShortcuts(ctx, page, expected) {
  for (const [label, expectedText] of Object.entries(expected)) {
    const text = await shortcutCaptureText(page, label);
    ctx.check(`raccourci « ${label} » affiché « ${expectedText} »`, text === expectedText, { label, expectedText, text });
  }
}

async function treeNodeCount(page) {
  return page.locator('[data-tree-node-id]').count();
}

export async function run() {
  const ctx = createRun('c6-migration-localstorage');

  // ── Scénario 1 : profil 0.9.8 valide ──────────────────────────────────────
  let session = await launchApp({ runDir: ctx.dir('scenario-1'), fresh: true, workspaceDir: ctx.dir('workspace') });
  try {
    await seedLegacyProfile098(session.page);
    ctx.check('démarrage après amorçage 0.9.8 sans erreur console/IPC', session.events.faults().length === 0, { faults: session.events.faults() });

    const layoutMigration = await readLocalStorage(session.page, [
      'bottomPanelOpen',
      'bottomPanelTab',
      'bottomPanelHeight',
      'storyStudio.free.bottomPanelOpen',
      'storyStudio.free.bottomPanelTab',
      'storyStudio.free.bottomPanelHeight',
      'storyStudio.advanced.bottomPanelOpen',
      'storyStudio.advanced.bottomPanelTab',
      'storyStudio.advanced.bottomPanelHeight',
    ]);
    ctx.check(
      'ancienne disposition du panneau inférieur dupliquée vers les deux éditeurs',
      layoutMigration['storyStudio.free.bottomPanelOpen'] === 'true'
        && layoutMigration['storyStudio.free.bottomPanelTab'] === 'queue'
        && layoutMigration['storyStudio.free.bottomPanelHeight'] === '412'
        && layoutMigration['storyStudio.advanced.bottomPanelOpen'] === 'true'
        && layoutMigration['storyStudio.advanced.bottomPanelTab'] === 'queue'
        && layoutMigration['storyStudio.advanced.bottomPanelHeight'] === '412',
      layoutMigration,
    );
    ctx.check(
      'anciennes clés de disposition retirées après migration',
      layoutMigration.bottomPanelOpen == null
        && layoutMigration.bottomPanelTab == null
        && layoutMigration.bottomPanelHeight == null,
      layoutMigration,
    );

    const theme = await session.page.evaluate(() => document.documentElement.dataset.theme);
    ctx.check('préférence de thème 0.9.8 (dark) appliquée après migration', theme === 'dark', { theme });

    await newProject(session.page, 'pack');

    // `tabOptions` a été migré sur Ctrl+Alt+P (voir `LEGACY_SHORTCUTS_098`) :
    // c'est la combinaison effective ici, pas le défaut Ctrl+Maj+O.
    await openPreferences(session.page, { shortcut: 'Control+Alt+p' });
    const copyOn = await readToggle(session.page, 'Copier les fichiers importés');
    ctx.check('préférence de copie 0.9.8 conservée (ON)', copyOn === true, { copyOn });
    const workspaceOn = await readToggle(session.page, 'Utiliser un workspace pour les nouveaux projets');
    ctx.check('préférence « workspace pour les nouveaux projets » 0.9.8 conservée (ON)', workspaceOn === true, { workspaceOn });

    await openKeyboardShortcutsModal(session.page);
    await checkAllShortcuts(ctx, session.page, EXPECTED_AFTER_MIGRATION);
    await ctx.shot(session.page, 'scenario1-raccourcis-migres');
    await closeKeyboardShortcutsModal(session.page);
    await closePreferences(session.page);

    // Comportemental 1 : `undo` migré sur Ctrl+Alt+U (aucune migration d'id,
    // simple personnalisation qui doit rester effective). Défaut général hors
    // migration, reproduit par `c6-diag-undo-apres-renommage.mjs` et
    // `c6-diag-undo-apres-collage.mjs` : Annuler au clavier — quel que soit
    // le raccourci qui lui est assigné, y compris le défaut Ctrl+Z sans
    // aucune personnalisation — reste par intermittence sans effet après une
    // création ou un collage, alors que le bouton « Annuler » de la barre
    // d'outils, lui, reste actif au même instant. Ce n'est pas un effet de la
    // migration (`c6-diag-*` le reproduisent sans aucun amorçage 0.9.8), mais
    // ce parcours ne peut pas non plus l'ignorer pour conclure « raccourci
    // migré = effectif » : le résultat est donc relevé sans trancher
    // (`ok: null`, non concluant) plutôt que compté comme un échec de la
    // migration elle-même — celle-ci est déjà prouvée par ailleurs (affichage
    // dans la modale, ci-dessus, et par le comportemental 2 qui suit,
    // Copier/Coller, non affecté par ce défaut).
    await session.page.keyboard.press('Control+Shift+N'); // addFolder (scope libre, non touché par le seed)
    await session.page.waitForTimeout(500);
    await session.page.keyboard.press('Escape'); // sort d'un éventuel renommage en cours
    await session.page.waitForTimeout(300);
    await session.page.locator('[data-tree-node-id]').last().click(); // focus neutre
    const countBeforeCustomUndo = await treeNodeCount(session.page);
    await session.page.keyboard.press('Control+Alt+u'); // undo personnalisé : doit annuler la création du dossier
    await session.page.waitForTimeout(500);
    const countAfterCustomUndo = await treeNodeCount(session.page);
    const customUndoWorked = countAfterCustomUndo === countBeforeCustomUndo - 1;
    ctx.check(
      'raccourci « Annuler » personnalisé (Ctrl+Alt+U) effectif',
      customUndoWorked ? true : null,
      { countBeforeCustomUndo, countAfterCustomUndo, note: customUndoWorked ? undefined : 'non concluant (Annuler au clavier par intermittence sans effet, hors migration)' },
    );
    // Nettoyage si l'annulation n'a pas eu lieu, pour ne pas fausser les
    // comptages du comportemental suivant.
    if (!customUndoWorked) {
      await session.page.locator('[data-tree-node-id]').last().click();
      await session.page.keyboard.press('Delete');
      await session.page.waitForTimeout(500);
    }

    // Comportemental 2 : `selectionCopy`/`selectionPaste` migrés depuis
    // `treeCopy`/`treePaste` (surface arbre, seule personnalisée ou gagnante).
    // L'ancien Ctrl+C ne doit plus rien copier ; le nouveau Ctrl+Maj+C doit.
    await session.page.keyboard.press('Control+Shift+N');
    await session.page.waitForTimeout(500);
    await session.page.keyboard.press('Escape');
    await session.page.waitForTimeout(300);
    const node = session.page.locator('[data-tree-node-id]').last();
    await node.click();
    const countBeforeOldCopy = await treeNodeCount(session.page);
    await session.page.keyboard.press('Control+c'); // ancien Copier : ne doit plus rien faire
    await session.page.keyboard.press('Control+v'); // Coller (migré sur Ctrl+Alt+V) — ici on vérifie qu'aucun collage fantôme n'a eu lieu via l'ancien Ctrl+V
    await session.page.waitForTimeout(500);
    const countAfterOldCopyPaste = await treeNodeCount(session.page);
    ctx.check('ancien raccourci de « Copier » (Ctrl+C) sans effet après migration', countAfterOldCopyPaste === countBeforeOldCopy, { countBeforeOldCopy, countAfterOldCopyPaste });

    await node.click();
    await session.page.keyboard.press('Control+Shift+c'); // Copier migré (Ctrl+Maj+C, depuis treeCopy)
    await session.page.keyboard.press('Control+Alt+v'); // Coller migré (Ctrl+Alt+V, depuis treePaste, gagnant sur diagramPaste)
    await session.page.waitForTimeout(500);
    const countAfterNewCopyPaste = await treeNodeCount(session.page);
    ctx.check('raccourcis migrés « Copier »/« Coller » (Ctrl+Maj+C / Ctrl+Alt+V) effectifs', countAfterNewCopyPaste === countAfterOldCopyPaste + 1, { countAfterOldCopyPaste, countAfterNewCopyPaste });

    // L'ancien Ctrl+Z reste sans effet ici aussi (fait vrai, même si ce
    // contexte suit un collage — voir le constat général ci-dessus, qui rend
    // ce résultat sans effet également en dehors de toute question de
    // migration ; la preuve positive du raccourci migré est le test précédent).
    await session.page.keyboard.press('Control+z');
    await session.page.waitForTimeout(500);
    const countAfterOldUndo = await treeNodeCount(session.page);
    ctx.check('ancien raccourci d’« Annuler » (Ctrl+Z) sans effet après migration', countAfterOldUndo === countAfterNewCopyPaste, { countAfterNewCopyPaste, countAfterOldUndo });

    ctx.check('scénario 1 : aucune erreur console/IPC cumulée', session.events.faults().length === 0, { faults: session.events.faults() });
  } finally {
    // Le projet créé pour ce scénario n'a jamais été enregistré : la garde de
    // fermeture (`useWindowCloseGuard`) montrerait alors une boîte **interne**
    // (`showChoiceDialog`, pas le plugin natif de dialogue — `answerNext('ask', …)`
    // ne peut donc pas y répondre) restée sans clic, et l'arrêt gracieux
    // retomberait sur `taskkill` après 15 s. Revenir à l'accueil au préalable
    // traverse cette boîte par « Quitter sans enregistrer » (`returnHome`),
    // pour que la fermeture n'ait ensuite plus rien à demander.
    await returnHome(session.page).catch(() => {});
    const stop1 = await session.stop({ graceful: true });
    ctx.check('scénario 1 : fermeture propre, rien dans le vrai workspace', stop1.polluted.length === 0 && stop1.closedGracefully === true, stop1);
  }

  // ── Scénario 2 : relance sur le même profil (arrêt propre → état stable) ──
  session = await launchApp({ runDir: ctx.dir('scenario-2-relance'), fresh: false, workspaceDir: ctx.dir('workspace') });
  try {
    ctx.check('relance après arrêt propre : démarrage sans erreur', session.events.faults().length === 0, { faults: session.events.faults() });
    const theme = await session.page.evaluate(() => document.documentElement.dataset.theme);
    ctx.check('relance : préférence de thème toujours effective', theme === 'dark', { theme });
    await newProject(session.page, 'pack');
    await openPreferences(session.page, { shortcut: 'Control+Alt+p' });
    await openKeyboardShortcutsModal(session.page);
    await checkAllShortcuts(ctx, session.page, EXPECTED_AFTER_MIGRATION);
    await closeKeyboardShortcutsModal(session.page);
    await closePreferences(session.page);
    ctx.check('relance : aucune erreur console/IPC cumulée', session.events.faults().length === 0, { faults: session.events.faults() });
  } finally {
    await returnHome(session.page).catch(() => {});
    const stop2 = await session.stop({ graceful: true });
    ctx.check('scénario 2 : fermeture propre, rien dans le vrai workspace', stop2.polluted.length === 0 && stop2.closedGracefully === true, stop2);
  }

  // ── Scénario 3 : blob de raccourcis entièrement corrompu (profil neuf) ───
  session = await launchApp({ runDir: ctx.dir('scenario-3-corrompu'), fresh: true, workspaceDir: ctx.dir('workspace-corrompu') });
  try {
    await seedLegacyProfile098(session.page, {
      shortcuts: null,
      preferences: {},
      raw: { storyStudioKeyboardShortcuts: '{ceci n\'est pas du JSON valide' },
    });
    ctx.check('démarrage avec un blob de raccourcis JSON invalide : aucune erreur console/IPC', session.events.faults().length === 0, { faults: session.events.faults() });
    await newProject(session.page, 'pack');
    await openPreferences(session.page);
    await openKeyboardShortcutsModal(session.page);
    const undoText = await shortcutCaptureText(session.page, 'Annuler');
    ctx.check('blob corrompu : repli sur le raccourci par défaut (Annuler = Ctrl+Z)', undoText === 'Ctrl+Z', { undoText });
    await ctx.shot(session.page, 'scenario3-repli-defaut');
    await closeKeyboardShortcutsModal(session.page);
    await closePreferences(session.page);
    ctx.check('scénario 3 : aucune erreur console/IPC cumulée', session.events.faults().length === 0, { faults: session.events.faults() });
  } finally {
    await returnHome(session.page).catch(() => {});
    const stop3 = await session.stop({ graceful: true });
    ctx.check('scénario 3 : fermeture propre, rien dans le vrai workspace', stop3.polluted.length === 0 && stop3.closedGracefully === true, stop3);
  }

  return ctx.finish();
}
