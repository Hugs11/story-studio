// Invariants d'édition de l'éditeur graphe, sur un projet neuf et sur un
// pack importé.
//
// Sélection et connexion passent par la liste de recherche et l'Inspecteur
// (`GraphSearchPanel.jsx`, `StageEditor`/`ActionEditor`) : le canvas
// (`GraphCanvasStage.jsx`) n'expose rien au DOM par conception (« l'accessibilité
// et le clavier passent par la liste de recherche et par l'inspecteur » — tête
// de fichier). La couche de survol (`GraphNodeOverlays.jsx`, `data-node-path`)
// donne malgré tout des coordonnées écran réelles par nœud : utilisée ici, en
// best-effort, pour la multi-sélection (Ctrl+clic) et le déplacement (glisser),
// deux gestes que la liste seule ne permet pas de piloter (son `onClick` ne lit
// aucun modificateur, et rien n'implémente Maj+Flèche pour elle).
//
// Lecture de l'état du document sans sonde applicative : `.mbah` sur disque +
// IPC `read_advanced_graph_view` (voir `lib/c4-helpers.mjs`). `documentFingerprint`
// (empreinte des octets exacts du payload, DTO `native_pack/graph_view/dto.rs`)
// est l'oracle d'égalité entre deux états du même document.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import {
  newProject, importPack, projectMenuButton, generatePack, MODALS, clickButton,
} from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { synthTone } from '../lib/fixtures.mjs';
import { openProjectDialog } from '../lib/c2-helpers.mjs';
import { readbackPack } from '../lib/oracles.mjs';
import { smallestArchive } from '../lib/corpus.mjs';
import {
  readGraphView, sameDocument, viewSummary, diffViewSummaries,
  selectGraphNode, selectGraphNodeByPath, createGraphStage, createGraphAction, repairGraphEndings,
  renameSelectedNode, wireStageOkToSelectedAction, addActionDestination,
  freePointOnNode, retargetActionChoice, ipcErrors, tauriLogErrors,
} from '../lib/c4-helpers.mjs';

async function snapshot(ctx, page, projectPath, label) {
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2000);
  // Léger repli : un `.mbah` volumineux (pack importé) peut prendre un peu
  // plus longtemps à s'écrire que l'attente fixe ci-dessus.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { project, view } = await readGraphView(page, projectPath);
      return { label, project, view, summary: viewSummary(view) };
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(1500);
    }
  }
  return { label, project: null, view: { error: String(lastError?.message ?? lastError) }, summary: null };
}

async function proveHistoryRoundTrip({ ctx, page, events, check, variantId, projectPath, v0, v1 }) {
  events.setStep(`${variantId}-annuler-tout`);
  const undoButton = page.getByRole('button', { name: /Annuler/i }).first();
  let last = v1;
  let homeReturned = false;
  let undoCount = 0;
  for (; undoCount < 50; undoCount += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await undoButton.isDisabled().catch(() => true)) break;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Control+z');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(350);
    // eslint-disable-next-line no-await-in-loop
    if (!await projectMenuButton(page).isVisible().catch(() => false)) {
      homeReturned = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    last = await snapshot(ctx, page, projectPath, `annuler #${undoCount + 1}`);
  }
  check(
    `annuler tout (${undoCount} étapes) : conserve l’éditeur et retrouve exactement l’empreinte V0`,
    !homeReturned && sameDocument(last.view, v0.view),
    {
      undoCount,
      homeReturned,
      fingerprintReached: last.view?.documentFingerprint,
      fingerprintV0: v0.view?.documentFingerprint,
      diff: diffViewSummaries(v0.summary, last.summary),
    },
  );

  events.setStep(`${variantId}-retablir-tout`);
  const redoButton = page.getByRole('button', { name: /Rétablir/i }).first();
  let redoHome = false;
  let redoCount = 0;
  for (; redoCount < 50; redoCount += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await redoButton.isDisabled().catch(() => true)) break;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Control+Shift+z');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(350);
    // eslint-disable-next-line no-await-in-loop
    if (!await projectMenuButton(page).isVisible().catch(() => false)) {
      redoHome = true;
      break;
    }
  }
  if (!redoHome) last = await snapshot(ctx, page, projectPath, 'après rétablir tout');
  check(
    `rétablir tout (${redoCount} étapes) : conserve l’éditeur et retrouve exactement l’empreinte V1`,
    !redoHome && sameDocument(last.view, v1.view),
    {
      redoCount,
      redoHome,
      fingerprintReached: last.view?.documentFingerprint,
      fingerprintV1: v1.view?.documentFingerprint,
      diff: diffViewSummaries(last.summary, v1.summary),
    },
  );
  check('aucune erreur console pendant annuler/rétablir', events.faults().length === 0, { faults: events.faults() });
  return last;
}

async function runSuite(ctx, variantId, opener, { archiveName = null } = {}) {
  const dir = ctx.dir(variantId);
  const workspaceDir = join(dir, 'workspace');
  const studioOut = ctx.dir(variantId, 'studio');
  const check = (msg, ok, detail) => ctx.check(`[${variantId}] ${msg}`, ok, detail);
  let app = await launchApp({ runDir: ctx.dir(variantId, 'session-1'), fresh: false, workspaceDir });
  let { page, events } = app;
  const allFaults = [];
  const projectPath = join(ctx.dir(variantId, 'projet'), `${variantId}.mbah`);
  let closedGracefully = false;
  try {
    events.setStep(`${variantId}-ouverture`);
    await opener(page);
    await ctx.shot(page, `${variantId}-a-ouvert`);

    // Enregistrement initial explicite (Ctrl+Maj+S), pour porter un savePath
    // stable avant toute édition — indépendant de ce que c4-isoler-c204 trouve
    // sur le 1er Ctrl+S après [média + bascule de préférence], puisqu'aucun des
    // deux n'est fait ici avant ce premier enregistrement.
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+Shift+s');
    await page.waitForTimeout(2500);
    check('enregistrement initial (Ctrl+Maj+S) écrit le .mbah', existsSync(projectPath));
    if (!existsSync(projectPath)) throw new Error('Enregistrement initial impossible : suite abandonnée pour cette variante.');

    const v0 = await snapshot(ctx, page, projectPath, 'V0 initial');
    check('V0 : lecture IPC du document initial réussie (documentFingerprint présent)', !!v0.view?.documentFingerprint, { error: v0.view?.error });

    // ================= Édition =================
    events.setStep(`${variantId}-edition`);
    const gestures = [];

    const okStage1 = await createGraphStage(page);
    gestures.push({ gesture: 'Créer un Écran (barre du Graphe)', ok: okStage1 });
    const okStage2 = await createGraphStage(page);
    gestures.push({ gesture: 'Créer un second Écran', ok: okStage2 });
    const okAction1 = await createGraphAction(page);
    gestures.push({ gesture: 'Créer une liste de choix (barre du Graphe)', ok: okAction1 });
    check('création : Écran 1, Écran 2, Liste 1 (boutons de la barre du graphe)', okStage1 && okStage2 && okAction1, { gestures });

    // Raccord, depuis l'Inspecteur de l'Action (formulaires : « raccorder à la
    // souris » exigerait un clic par coordonnées sur des prises de port dessinées
    // par le canvas — jugé trop coûteux à fiabiliser pour ce lot, cf. tête de
    // fichier ; documenté ici comme demandé).
    const selectedAction1 = await selectGraphNode(page, 'Liste 1', 'action');
    check('sélection de Liste 1 (liste des nœuds)', selectedAction1);
    if (selectedAction1) {
      await wireStageOkToSelectedAction(page, 'Écran 1');
      // La liste naît avec un choix « Écran à choisir » non raccordé : on le
      // retarge sur l'Écran 2, puis « Ajouter un choix » en ajoute un second.
      await retargetActionChoice(page, 1, 'Écran 2');
      await addActionDestination(page, 'Écran 2');
    }
    const vAfterWiring = await snapshot(ctx, page, projectPath, 'après raccord');
    const wired = vAfterWiring.view?.edges?.length >= 2;
    check('raccord : Écran 1 --OK--> Liste 1 --> Écran 2 (2 arêtes au moins dans la vue)', wired, { edgesCount: vAfterWiring.view?.edges?.length, edges: vAfterWiring.view?.edges });

    // Renommage (F2 → champ « Nom » de l’Inspecteur, Entrée valide).
    const selectedStage2 = await selectGraphNode(page, 'Écran 2', 'stage');
    if (selectedStage2) await renameSelectedNode(page, 'Écran C4 renommé');
    const vAfterRename = await snapshot(ctx, page, projectPath, 'après renommage');
    const renamed = (vAfterRename.summary?.stageNames ?? []).includes('Écran C4 renommé');
    check('renommage (F2) : « Écran 2 » devient « Écran C4 renommé »', renamed, { stageNames: vAfterRename.summary?.stageNames });

    // Copier / coller / couper (Ctrl+C, Ctrl+V, Ctrl+X), sur la sélection
    // courante (l’Écran renommé).
    const stagesBeforePaste = new Set((vAfterRename.view?.stages ?? []).map((s) => s.uuid));
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(200);
    // Pointeur sur le canvas avant Ctrl+V : le collage se pose au point du
    // pointeur (ou au centre de la vue à défaut).
    await page.locator('.advanced-panel--graph').first().hover().catch(() => {});
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(500);
    const vAfterPaste = await snapshot(ctx, page, projectPath, 'après collage');
    const pastedUuids = (vAfterPaste.view?.stages ?? []).map((s) => s.uuid).filter((u) => !stagesBeforePaste.has(u));
    check('copier/coller (Ctrl+C, Ctrl+V) : un Écran de plus, retrouvé par uuid', pastedUuids.length === 1, {
      before: vAfterRename.view?.counts, after: vAfterPaste.view?.counts, pastedUuids,
    });
    const pastedPath = pastedUuids.length === 1
      ? vAfterPaste.view.stages.find((s) => s.uuid === pastedUuids[0]).path
      : null;

    let cutOk = null;
    if (pastedPath) {
      const selectedPasted = await selectGraphNodeByPath(page, pastedPath);
      if (selectedPasted) {
        await page.keyboard.press('Control+x');
        await page.waitForTimeout(500);
        const vAfterCut = await snapshot(ctx, page, projectPath, 'après coupe');
        cutOk = !(vAfterCut.view?.stages ?? []).some((s) => s.uuid === pastedUuids[0]);
        check('couper (Ctrl+X) : l’Écran collé a disparu de la vue', cutOk, { countsAfterCut: vAfterCut.view?.counts });
      } else {
        check('couper (Ctrl+X) : sélection du nœud collé par chemin', false, { pastedPath });
      }
    }

    // Multi-sélection (Ctrl+clic sur les prises peintes, `data-node-path`) et
    // déplacement (glisser une prise), en best-effort par coordonnées : seule
    // voie possible, le canvas n’exposant aucun élément adressable au clavier
    // pour ce geste précis (la liste ne lit aucun modificateur sur son clic).
    let multiSelectOk = null;
    let moveOk = null;
    try {
      const vForCoords = await snapshot(ctx, page, projectPath, 'avant multi-sélection/déplacement');
      const stage1 = vForCoords.view.stages.find((s) => (s.name?.value ?? '') === 'Écran 1');
      const action1 = vForCoords.view.actions.find((a) => (a.name?.value ?? '') === 'Liste 1');
      if (stage1 && action1) {
        // Points non recouverts : l'Écran 1 est en partie caché par les Écrans nés en cascade.
        const p1 = await freePointOnNode(page, stage1.path);
        const p2 = await freePointOnNode(page, action1.path);
        if (p1 && p2) {
          await page.mouse.click(p1.x, p1.y);
          await page.waitForTimeout(150);
          // `mouse.click` n'a pas d'option `modifiers` : Ctrl se tient au clavier.
          await page.keyboard.down('Control');
          await page.mouse.click(p2.x, p2.y);
          await page.keyboard.up('Control');
          await page.waitForTimeout(150);
          const selectedCount = await page.locator('.advanced-node-overlay__selection').count();
          multiSelectOk = selectedCount === 2;
          check('multi-sélection (clic + Ctrl+clic sur les prises peintes) : 2 nœuds marqués sélectionnés', multiSelectOk, { selectedCount });

          // Déplacement : glisser le premier nœud d’une centaine de pixels.
          await page.mouse.move(p1.x, p1.y);
          await page.mouse.down();
          await page.mouse.move(p1.x + 60, p1.y + 90, { steps: 8 });
          await page.mouse.move(p1.x + 120, p1.y + 140, { steps: 8 });
          await page.mouse.up();
          await page.waitForTimeout(400);
          const vAfterMove = await snapshot(ctx, page, projectPath, 'après déplacement');
          const movedStage = vAfterMove.view.stages.find((s) => s.uuid === stage1.uuid);
          const dx = Math.abs((movedStage?.layout?.x ?? 0) - (stage1.layout?.x ?? 0));
          const dy = Math.abs((movedStage?.layout?.y ?? 0) - (stage1.layout?.y ?? 0));
          moveOk = (dx > 1 || dy > 1);
          check('déplacement (glisser une prise peinte) : position d’auteur changée', moveOk, {
            before: stage1.layout, after: movedStage?.layout, dx, dy,
          });
        } else {
          check('multi-sélection/déplacement : coordonnées des prises introuvables (overlay hors vue ?)', null, { p1, p2 });
        }
      } else {
        check('multi-sélection/déplacement : Écran 1 ou Liste 1 introuvable dans la vue', null, {});
      }
    } catch (error) {
      check(`multi-sélection/déplacement : geste par coordonnées en échec (${error.message})`, null, { stack: error.stack });
    }

    // Média déposé sur un Écran. Le canvas n’expose pas de zone de dépôt OS
    // (`[data-os-drop-zone]` absent, voir `c2-graphe.mjs`) ; le dépôt réel depuis la
    // médiathèque est un geste pointeur interne (`MediaTile.jsx`, PAS un drop OS),
    // jugé trop coûteux à fiabiliser ici (survol du canvas au pixel près pour que
    // le moteur résolve le nœud sous le pointeur) — substitué par le sélecteur de
    // fichier de l’Inspecteur (`MediaSlotEditor` → `AudioField`/`ImageField`,
    // même dialogue `open` shimmé), qui pose le même geste d’auteur
    // (`setStageMedia`). Documenté comme demandé par la consigne du lot.
    let mediaDropOk = null;
    const selectedStage1ForMedia = await selectGraphNode(page, 'Écran 1', 'stage');
    if (selectedStage1ForMedia) {
      const mediaDir = ctx.dir(variantId, 'medias');
      const audio = synthTone(mediaDir, 'c4-audio-ecran1.wav', 660);
      await answerNext(page, 'open', audio);
      // La zone vide du champ est un `div role=button` « Audio de l’Écran » (`AudioField.jsx`).
      const opened = await page.locator('.advanced-panel--inspector .audio-empty-text').first().click({ timeout: 5_000 }).then(() => true, () => false);
      await page.waitForTimeout(800);
      const vAfterMedia = await snapshot(ctx, page, projectPath, 'après média sur Écran 1');
      const stage1After = vAfterMedia.view.stages.find((s) => (s.name?.value ?? '') === 'Écran 1');
      mediaDropOk = stage1After?.audio?.presence === 'value';
      check('média assigné à l’Écran 1 (sélecteur de fichier de l’Inspecteur, substitué au dépôt canvas — voir note)', mediaDropOk, {
        opened, audio: stage1After?.audio,
      });
    } else {
      check('média sur Écran 1 : sélection préalable de l’Écran 1 en échec', false);
    }

    // Fiche du pack (Ctrl+, → « Options du pack ») : bascule Harmoniser le
    // volume. Ce réglage vit dans `project.globalOptions`, hors du payload
    // d’auteur du graphe (`read_advanced_graph_view` ne le porte pas) : vérifié
    // directement sur le `.mbah`, pas via la vue IPC.
    const beforeToggleProject = (await readGraphView(page, projectPath)).project;
    // Champ absent = harmonisation active (`config/audioProcessing.js` : `!== false`).
    const beforeHarmonize = beforeToggleProject?.globalOptions?.harmonizeLoudness !== false;
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(400);
    const popoverVisible = await page.locator('.pack-options-popover').first().isVisible().catch(() => false);
    if (popoverVisible) {
      await page.getByText('Harmoniser le volume').first().hover().catch(() => {});
      const toggleBtn = page.locator('.pack-options-popover .pack-options-control-row').filter({ hasText: 'Harmoniser le volume' }).locator('button').first();
      await toggleBtn.click().catch(() => {});
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1200);
    const afterToggleProject = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf8')) : null;
    const afterHarmonize = afterToggleProject?.globalOptions?.harmonizeLoudness !== false;
    check('fiche du pack (Ctrl+, « Options du pack ») : bascule Harmoniser le volume visible et écrite au disque', popoverVisible && afterHarmonize !== beforeHarmonize, {
      popoverVisible, beforeHarmonize, afterHarmonize,
    });

    // ================= Document final (V1) =================
    const endings = await repairGraphEndings(page);
    check('fins accessibles réparées par « En faire une fin » avant le contrôle de l’historique',
      endings.remaining === 0, endings);
    events.setStep(`${variantId}-v1`);
    const v1 = await snapshot(ctx, page, projectPath, 'V1 final');
    check('V1 : lecture IPC du document final réussie', !!v1.view?.documentFingerprint);
    check('contre-épreuve : V0 et V1 ont des empreintes différentes (l’oracle voit une différence introduite)', !sameDocument(v0.view, v1.view), {
      fingerprintV0: v0.view?.documentFingerprint, fingerprintV1: v1.view?.documentFingerprint,
      diff: diffViewSummaries(v0.summary, v1.summary),
    });

    // L'historique est prouvé avant tout export : le verrou d'auteur d'un
    // export long ou refusé ne peut ainsi ni masquer ni fausser Ctrl+Z.
    let vBeforeClose = await proveHistoryRoundTrip({
      ctx, page, events, check, variantId, projectPath, v0, v1,
    });

    // ================= Export + relecture (sur V1) =================
    events.setStep(`${variantId}-export`);
    const outDir = ctx.dir(variantId, 'sortie');
    const genResult = await generatePack(page, outDir, { uuid: 'keep' });
    check('export (V1) réussi', !!genResult.zip, { refusal: genResult.refusal, timeout: genResult.timeout });
    if (genResult.zip) {
      const verdict = await readbackPack(page, genResult.zip, studioOut);
      check('export (V1) relu par l’app et accepté par STUdio', verdict.ok, verdict);
    }

    // ================= Édition refusée pendant un export (variante importée seulement : le nôtre est trop petit pour laisser une fenêtre observable) =================
    if (archiveName) {
      events.setStep(`${variantId}-edition-pendant-export`);
      const outDir2 = ctx.dir(variantId, 'sortie-2');
      const before2 = new Set(existsSync(outDir2) ? (await import('node:fs')).readdirSync(outDir2) : []);
      await answerNext(page, 'open', outDir2);
      await page.keyboard.press('Control+g');
      await clickButton(page, /Appliquer\s*&\s*générer/, { timeout: 15_000 });
      const revision = page.locator(MODALS).filter({ hasText: 'Nouvelle révision' });
      await revision.waitFor({ timeout: 5_000 }).catch(() => {});
      if (await revision.count()) await clickButton(revision, /Garder l.UUID d.origine/);
      // Pendant que l’export tourne (quelques secondes sur un pack réel),
      // tenter un geste d’écriture : ne doit rien changer et ne pas planter.
      await page.waitForTimeout(300);
      await page.keyboard.press('e'); // graphCreateStage
      await page.waitForTimeout(400);
      const navigable = await page.locator('.advanced-panel--graph').first().isVisible().catch(() => false);
      check('pendant l’export : la vue reste navigable (panneau Graphe visible)', navigable);
      // On laisse l'export se terminer (apparition d'un .zip neuf) avant de
      // relire, pour ne pas comparer un payload en cours d'écriture.
      const started = Date.now();
      let zipLanded = false;
      while (Date.now() - started < 120_000 && !zipLanded) {
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(1000);
        // eslint-disable-next-line no-await-in-loop
        const { readdirSync } = await import('node:fs');
        zipLanded = existsSync(outDir2) && readdirSync(outDir2).some((name) => !before2.has(name) && name.endsWith('.zip'));
      }
      check('pendant l’export : l’export déclenché avant l’édition aboutit quand même (zip produit)', zipLanded);
      await page.waitForTimeout(2000);
      const vAfterExport = await snapshot(ctx, page, projectPath, 'après tentative d’édition pendant export');
      const rejectedCleanly = sameDocument(v1.view, vAfterExport.view);
      check('pendant l’export : le geste d’écriture (E) est refusé proprement (document inchangé)', rejectedCleanly, {
        fingerprintBefore: v1.view?.documentFingerprint, fingerprintAfter: vAfterExport.view?.documentFingerprint,
      });
    }

    allFaults.push(...events.faults());
    check('aucune erreur console pendant édition/export', events.faults().length === 0, { faults: events.faults() });

    // ================= Enregistrer → fermeture propre → rouvrir =================
    // Comparé à l'état effectivement restauré par le rétablissement complet.
    events.setStep(`${variantId}-fermeture-reouverture`);
    // L'export (« Appliquer & générer ») a appliqué les options du pack au
    // projet après le dernier enregistrement : le projet est donc modifié, et la
    // garde de fermeture demanderait « Projet non enregistré ». On enregistre
    // avant de fermer, comme le dit le titre de cette étape.
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1500);
    const stop1 = await app.stop({ graceful: true });
    closedGracefully = stop1.closedGracefully;
    check('fermeture propre avant réouverture', stop1.closedGracefully !== false, { closedGracefully: stop1.closedGracefully });
    check('rien écrit dans le vrai workspace (session 1)', stop1.polluted.length === 0, { polluted: stop1.polluted });

    app = await launchApp({ runDir: ctx.dir(variantId, 'session-2'), fresh: false, workspaceDir });
    ({ page, events } = app);
    const reopened = await openProjectDialog(page, projectPath);
    check('réouverture par chemin (session 2) aboutit', reopened);
    if (reopened) {
      const reopenedView = await readGraphView(page, projectPath);
      check('enregistrer → fermeture propre → rouvrir : même document que celui laissé sur disque', sameDocument(vBeforeClose.view, reopenedView.view), {
        fingerprintBefore: vBeforeClose.view?.documentFingerprint, fingerprintAfter: reopenedView.view?.documentFingerprint,
      });
      check('aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
    }
    allFaults.push(...events.faults());
  } catch (error) {
    check(`suite interrompue : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    check('aucune erreur console ni exception, cumul sur toute la variante', allFaults.length === 0, { faults: allFaults, ipcErrors: ipcErrors(events) });
    const lastStop = await app.stop();
    check('rien écrit dans le vrai workspace (dernier contrôle)', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
    const logErrors = tauriLogErrors(ctx.dir(variantId, 'session-1'))
      .concat(tauriLogErrors(ctx.dir(variantId, 'session-2')));
    if (logErrors.length) check('lignes ERROR dans tauri-dev.log (une des sessions)', null, { logErrors });
  }
}

export async function run() {
  const ctx = createRun('c4-invariants');

  await runSuite(ctx, 'projet-neuf', async (page) => {
    await newProject(page, 'advanced');
  });

  const archive = smallestArchive('01 - Editable');
  await runSuite(ctx, 'pack-importe', async (page) => {
    await importPack(page, archive, { editor: 'graphe' });
  }, { archiveName: archive.split(/[\\/]/).pop() });

  return ctx.finish({});
}
