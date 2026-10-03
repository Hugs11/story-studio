// La vignette catalogue se choisit dans la fiche du pack, et nulle part
// ailleurs.
//
// Pour chaque éditeur (menus, puis graphe), sur le même pack :
//
// - la racine (menu racine, Écran d'entrée) ne montre plus qu'une image, sans
//   interrupteur « même image », et rien n'y déborde, à la largeur par défaut
//   comme au minimum du panneau ;
// - la fiche montre la vignette dans sa colonne de 200 px, outils compris,
//   sans débordement ;
// - choisir une image puis fermer sans appliquer ne change rien ;
// - choisir puis appliquer la garde ; la retirer puis appliquer revient à
//   l'image racine.
//
// Usage : node e2e/run.mjs c7-vignette-catalogue <archive>

import { join } from 'node:path';

import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { extractFixtureMedia } from '../lib/fixtures.mjs';
import { resizeSettingsToMinimum } from '../lib/settings-panel.mjs';

const SAME_IMAGE = 'Utiliser la même image pour la Lunii et la vignette catalogue';

// Ce qui sort de la boîte qui le contient, rognages des ancêtres compris.
async function overflowsIn(page, selector) {
  return page.locator(selector).first().evaluate((box) => {
    const bounds = box.getBoundingClientRect();
    const out = [];
    for (const node of box.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || getComputedStyle(node).visibility === 'hidden') continue;
      if (node.closest('.tooltip-bubble')) continue;
      let left = rect.left;
      let right = rect.right;
      for (let parent = node.parentElement; parent && parent !== box; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (right - left <= 1) continue;
      if (right > bounds.right + 1 || left < bounds.left - 1) {
        out.push({ node: String(node.className || node.tagName).slice(0, 60), text: node.textContent.trim().slice(0, 30) });
      }
    }
    return { width: Math.round(bounds.width), overflows: out.slice(0, 6), count: out.length };
  });
}

async function openSheet(page) {
  await page.locator('.chrome-titlebar-pack-recap').click();
  const panel = page.locator('.pack-meta-cover-panel--editable');
  await panel.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  return panel;
}

// Choisir une image passe par l'éditeur d'image, comme partout ailleurs.
async function pickCatalogImage(page, panel, image) {
  await answerNext(page, 'open', image);
  await panel.getByRole('button', { name: 'Remplacer l’image' }).click();
  const confirm = page.getByRole('button', { name: 'Utiliser cette image' });
  await confirm.waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Utiliser cette image');
    return button && !button.disabled;
  }, null, { timeout: 15_000 });
  await confirm.click();
  await page.waitForFunction(() => /propre/.test(document.querySelector('.pack-meta-cover-copy')?.textContent ?? ''), null, { timeout: 15_000 });
  await page.waitForTimeout(400);
}

const footerButton = (page, name) => page.locator('.pack-meta-modal').getByRole('contentinfo').getByRole('button', { name, exact: true });

async function applySheet(page) {
  await footerButton(page, 'Appliquer').click();
  await page.locator('.pack-meta-modal').waitFor({ state: 'hidden', timeout: 15_000 });
}

async function caption(panel) {
  return (await panel.locator('.pack-meta-cover-copy').innerText()).trim();
}

async function sheetScenario(page, ctx, label, image) {
  const sheet = '.pack-meta-modal';
  let panel = await openSheet(page);
  const initial = await caption(panel);
  await page.locator(sheet).screenshot({ path: join(ctx.runDir, `${label}-fiche-initiale.png`) });
  // Un pack importé peut porter sa propre vignette : on part alors de la
  // retirer, ce qui vérifie aussi le retour à l'image racine.
  if (/propre/.test(initial)) {
    await panel.getByRole('button', { name: 'Supprimer l’image' }).click();
    await applySheet(page);
    panel = await openSheet(page);
  }
  const rootOnly = await caption(panel);
  ctx.check(`${label} — la fiche montre la vignette qui reprend l’image racine`, /^Reprend l/.test(rootOnly), { initial, rootOnly });
  const column = await overflowsIn(page, '.pack-meta-cover-panel--editable');
  ctx.check(`${label} — la colonne vignette de la fiche ne déborde pas`, column.count === 0, column);

  // Choisir puis fermer sans appliquer : rien n'est écrit.
  await pickCatalogImage(page, panel, image);
  const picked = await overflowsIn(page, '.pack-meta-cover-panel--editable');
  ctx.check(`${label} — avec une image propre, la colonne ne déborde pas`, picked.count === 0, picked);
  await page.locator(sheet).screenshot({ path: join(ctx.runDir, `${label}-fiche-image-propre.png`) });
  await footerButton(page, 'Annuler').click();
  await page.waitForTimeout(400);
  panel = await openSheet(page);
  const afterCancel = await caption(panel);
  ctx.check(`${label} — fermer sans appliquer ne garde pas l’image`, /^Reprend l/.test(afterCancel), { afterCancel });

  // Choisir puis appliquer : l'image reste.
  await pickCatalogImage(page, panel, image);
  await applySheet(page);
  panel = await openSheet(page);
  const afterApply = await caption(panel);
  ctx.check(`${label} — appliquer garde l’image propre`, /propre/.test(afterApply), { afterApply });

  // Retirer puis appliquer : retour à l'image racine.
  await panel.getByRole('button', { name: 'Supprimer l’image' }).click();
  await applySheet(page);
  panel = await openSheet(page);
  const afterClear = await caption(panel);
  ctx.check(`${label} — retirer puis appliquer revient à l’image racine`, /^Reprend l/.test(afterClear), { afterClear });
  await footerButton(page, 'Annuler').click();
  await page.waitForTimeout(300);
}

async function rootChecks(page, ctx, label, cardSelector) {
  const card = page.locator(cardSelector).first();
  await card.waitFor({ timeout: 15_000 });
  const sameImageToggle = await page.getByText(SAME_IMAGE).count();
  const images = await card.locator('.image-field').count();
  ctx.check(`${label} — plus d’interrupteur « même image » ni de double image`, sameImageToggle === 0 && images === 1, { sameImageToggle, images });
  const wide = await overflowsIn(page, cardSelector);
  ctx.check(`${label} — la carte racine ne déborde pas (largeur par défaut)`, wide.count === 0, wide);
  await card.screenshot({ path: join(ctx.runDir, `${label}-racine-defaut.png`) });
  // La fenêtre à sa taille minimale, puis, côté graphe, l'Inspecteur à sa
  // largeur minimale. Côté menus, la racine vit dans la colonne principale.
  await page.setViewportSize({ width: 1100, height: 680 });
  await page.waitForTimeout(500);
  const small = await overflowsIn(page, cardSelector);
  ctx.check(`${label} — la carte racine ne déborde pas (fenêtre 1100×680, ${small.width} px)`, small.count === 0, small);
  await card.screenshot({ path: join(ctx.runDir, `${label}-racine-1100.png`) });
  if (await page.getByRole('separator', { name: 'Redimensionner les réglages' }).isVisible()) {
    const minimum = await resizeSettingsToMinimum(page);
    const narrow = await overflowsIn(page, cardSelector);
    ctx.check(`${label} — la carte racine ne déborde pas (panneau à ${Math.round(minimum.width)} px)`, narrow.count === 0, narrow);
    await card.screenshot({ path: join(ctx.runDir, `${label}-racine-minimum.png`) });
  }
}

export async function run(args = []) {
  const [archive] = args;
  const ctx = createRun('c7-vignette-catalogue');
  if (!archive) {
    ctx.check('archive fournie en argument', false, { usage: 'node e2e/run.mjs c7-vignette-catalogue <archive>' });
    return ctx.finish();
  }
  const { image } = extractFixtureMedia(ctx.dir('medias'));

  for (const editor of ['menus', 'graphe']) {
    const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir(`workspace-${editor}`) });
    try {
      const { page, events } = app;
      await importPack(page, archive, { editor });
      await page.waitForTimeout(1500);
      if (editor === 'menus') {
        await page.locator('[data-media-node-type="root"]').first().click({ position: { x: 40, y: 12 } });
        await rootChecks(page, ctx, 'menus', '.root-identity-card');
      } else {
        const root = page.locator('li[role="option"][data-kind="stage"]').filter({ has: page.locator('.advanced-search__root-badge') }).first();
        await root.click();
        await rootChecks(page, ctx, 'graphe', '.advanced-editor__media-card');
      }
      await sheetScenario(page, ctx, editor, image);
      ctx.check(`${editor} — aucune erreur console ni exception`, events.faults().length === 0, { faults: events.faults().slice(0, 5) });
    } finally {
      await app.stop();
    }
  }
  return ctx.finish();
}
