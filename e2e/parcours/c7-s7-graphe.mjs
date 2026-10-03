// textes, simulation et mise en page de la sélection multiple du graphe.
//
// Une seule session couvre les deux résolutions demandées. Pour chacune, la
// largeur du panneau Réglages est amenée à ses bornes par son séparateur
// glissé : la preuve porte donc sur la largeur réelle de la colonne, pas sur
// une classe ajoutée artificiellement par le test.

import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome } from '../lib/actions.mjs';
import {
  createGraphStage,
  graphNodeListItem,
  nodeOverlayCenter,
} from '../lib/c4-helpers.mjs';
import { closeSimulator, waitForSimulator } from '../lib/simulator.mjs';

const RESOLUTIONS = [
  { width: 1366, height: 768, label: '1366x768' },
  { width: 1920, height: 1080, label: '1920x1080' },
];

async function setWindowSize(page, width, height) {
  // La configuration E2E n'accorde volontairement pas à l'application la
  // permission native `core:window:allow-set-size`. Playwright applique ici
  // le viewport CDP à la WebView : CSS et captures voient donc exactement la
  // résolution testée, sans élargir les droits du binaire.
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ([nextWidth, nextHeight]) => Math.abs(innerWidth - nextWidth) <= 2
      && Math.abs(innerHeight - nextHeight) <= 2,
    [width, height],
    { timeout: 15_000 },
  );
  await page.waitForTimeout(300);
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

async function graphPath(page, name) {
  const item = graphNodeListItem(page, name, 'stage');
  await item.waitFor({ timeout: 15_000 });
  const id = await item.getAttribute('id');
  const prefix = 'advanced-option-';
  if (!id?.startsWith(prefix)) throw new Error(`Chemin de ${name} absent de la liste.`);
  return decodeURIComponent(id.slice(prefix.length));
}

async function selectTwoStages(page, leftPath, rightPath) {
  await page.keyboard.press('0');
  await page.waitForTimeout(400);
  // La liste sélectionne sans ambiguïté le premier Écran. Le canvas ne sert
  // qu'au geste additif qu'elle ne sait pas exprimer.
  const leftItem = page.locator(`[id="advanced-option-${encodeURIComponent(leftPath)}"]`);
  await leftItem.click();
  await page.waitForTimeout(250);
  const selectedBeforeAdd = await page.locator('.advanced-node-overlay__selection').count();
  // L'ouverture de l'Inspecteur peut déplacer le canvas : relever ensuite la
  // position du second nœud.
  const left = await nodeOverlayCenter(page, leftPath);
  const right = await nodeOverlayCenter(page, rightPath);
  if (!right) return {
    ok: false, left, right, selectedBeforeAdd, selectedCount: selectedBeforeAdd,
  };
  await page.keyboard.down('Control');
  try {
    await page.mouse.click(right.x, right.y);
  } finally {
    await page.keyboard.up('Control');
  }
  await page.waitForTimeout(250);
  const selectedCount = await page.locator('.advanced-node-overlay__selection').count();
  return { ok: selectedCount === 2, left, right, selectedBeforeAdd, selectedCount };
}

async function setInspectorBoundary(page, boundary) {
  const separator = page.getByRole('separator', { name: 'Redimensionner les réglages' });
  await separator.waitFor({ timeout: 15_000 });
  const targetAttribute = boundary === 'min' ? 'aria-valuemin' : 'aria-valuemax';
  const target = Number(await separator.getAttribute(targetAttribute));
  const current = Number(await separator.getAttribute('aria-valuenow'));
  if (current === target) return target;
  const box = await separator.boundingBox();
  if (!box) throw new Error('Séparateur des réglages sans géométrie.');
  const viewport = page.viewportSize();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  // Dans l'ordre par défaut frais, l'Inspecteur est à droite : déplacer sa
  // frontière vers la droite le réduit, vers la gauche l'agrandit.
  await page.mouse.move(boundary === 'min' ? viewport.width - 1 : 1, y);
  await page.mouse.up();
  await page.waitForTimeout(250);
  return Number(await separator.getAttribute('aria-valuenow'));
}

async function batchLayout(page) {
  const row = page.locator('.editor-setting-row.is-action-row')
    .filter({ hasText: 'Générer à partir des noms' }).first();
  await row.waitFor({ timeout: 15_000 });
  return row.evaluate((element) => {
    const copy = element.querySelector('.editor-setting-copy');
    const actions = element.querySelector('.editor-setting-actions');
    const buttons = [...element.querySelectorAll('.batch-generate-btn')];
    const rect = element.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const buttonRects = buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const inside = (box) => box.left >= rect.left - 1 && box.right <= rect.right + 1
      && box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1;
    return {
      panelWidth: element.closest('.advanced-panel-slot--advanced-inspector')?.getBoundingClientRect().width ?? null,
      rowWidth: rect.width,
      copyWidth: copyRect.width,
      actionsBelowCopy: actionsRect.top >= copyRect.bottom - 1,
      gridTemplateColumns: getComputedStyle(element).gridTemplateColumns,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      buttonsInside: buttonRects.every(inside),
      buttonCount: buttons.length,
    };
  });
}

async function proveSimulationFromSelectedStage(ctx, page, stageName) {
  const item = graphNodeListItem(page, stageName, 'stage');
  await item.click({ button: 'right' });
  const command = page.getByRole('menuitem', { name: 'Simuler depuis ici', exact: true });
  const available = await command.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  ctx.check('menu graphe : « Simuler depuis ici » est proposé sur un Écran', available);
  await ctx.shot(page, 'menu-simuler-depuis-ici');
  if (!available) return;

  await command.click();
  await waitForSimulator(page, { timeout: 30_000 });
  const simulator = page.locator('.floating-simulator').first();
  const title = (await simulator.locator('.lunii-screen-title').innerText()).trim();
  const commonClose = simulator.getByRole('button', { name: 'Fermer le simulateur' });
  ctx.check('simulation : départ réel sur l’Écran sélectionné', title === stageName, { expected: stageName, actual: title });
  ctx.check('simulation : aucun bandeau ni bouton de fermeture propre au graphe',
    await page.locator('.advanced-review-banner').count() === 0
      && await page.getByRole('button', { name: 'Fermer l’écoute' }).count() === 0);
  ctx.check('simulation : la commande de fermeture commune reste disponible', await commonClose.isVisible());
  await ctx.shot(page, 'simulation-sans-bandeau');
  await closeSimulator(page);
  ctx.check('simulation : la commande commune ferme le simulateur',
    await simulator.waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false));
}

export async function run() {
  const ctx = createRun('c7-s7-graphe');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  const layouts = [];
  try {
    const { page, events } = app;
    await newProject(page, 'advanced');
    await createGraphStage(page);
    await createGraphStage(page);

    await proveSimulationFromSelectedStage(ctx, page, 'Écran 2');

    const firstPath = await graphPath(page, 'Écran 1');
    const secondPath = await graphPath(page, 'Écran 2');
    const selection = await selectTwoStages(page, firstPath, secondPath);
    ctx.check('génération groupée : deux Écrans sont réellement multiselectionnés', selection.ok, selection);
    await page.getByText('Génération groupée', { exact: true }).waitFor({ timeout: 15_000 });

    for (const resolution of RESOLUTIONS) {
      const actualResolution = await setWindowSize(page, resolution.width, resolution.height);
      ctx.check(`${resolution.label} : taille de fenêtre appliquée`,
        actualResolution.width === resolution.width && actualResolution.height === resolution.height,
        actualResolution);

      for (const boundary of ['min', 'max']) {
        const storedWidth = await setInspectorBoundary(page, boundary);
        const metrics = await batchLayout(page);
        layouts.push({ resolution: resolution.label, boundary, storedWidth, ...metrics });
        ctx.check(`${resolution.label} / largeur ${boundary} : texte et boutons restent dans la carte`,
          metrics.noHorizontalOverflow && metrics.buttonsInside
            && metrics.buttonCount === 2 && metrics.copyWidth >= 180,
          { storedWidth, ...metrics });
        if (boundary === 'min') {
          ctx.check(`${resolution.label} / largeur minimale : actions empilées sous le texte`,
            metrics.actionsBelowCopy, metrics);
        }
        await ctx.shot(page, `${resolution.label}-reglages-${boundary}`);
      }
    }

    await returnHome(page);
    ctx.check('parcours sans erreur console/IPC', events.faults().length === 0, { faults: events.faults() });
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop({ graceful: true });
    ctx.check('fermeture propre et workspace réel intact', stop.closedGracefully && stop.polluted.length === 0, stop);
  }
  return ctx.finish({ layouts });
}
