// le panneau d'un Écran et d'une Liste de choix du graphe, à 200 px.
//
// Chaque Écran du pack est sélectionné tour à tour. Sur chacun, deux faits
// mesurés dans le DOM, sans spécification :
//
// - rien ne sort de sa carte (un nom, un bouton, une ligne plus large que la
//   carte qui la porte) ;
// - aucun libellé ne passe sous l'interrupteur de sa ligne, et l'interrupteur
//   reste dans le cadre de sa ligne.
//
// Les cartes des premiers Écrans et Listes sont capturées une par une, pour la
// relecture humaine : une coupure au milieu d'un mot ne se mesure pas bien.
//
// Usage : node e2e/run.mjs c7-s9-panneau-ecran-etroit <archive> [nombre de captures]

import { join } from 'node:path';

import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack } from '../lib/actions.mjs';
import { resizeSettingsToMinimum } from '../lib/settings-panel.mjs';

const CARDS = '.advanced-inspector--editor .advanced-editor > .card, .advanced-inspector--editor .advanced-editor > .advanced-editor__section';

async function inspectPanel(page) {
  return page.locator('.advanced-panel-slot--advanced-inspector').evaluate((panel, selector) => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const intersects = (a, b) => a && b
      && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    // Ce qui se voit d'un nœud : sa boîte rognée par les ancêtres qui
    // coupent leur contenu (forme d'onde, zones défilantes).
    const shownBox = (node, card) => {
      const box = node.getBoundingClientRect();
      let left = box.left;
      let right = box.right;
      for (let parent = node.parentElement; parent && parent !== card; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      return { left, right, width: right - left, height: box.height };
    };
    const cards = [...panel.querySelectorAll(selector)].filter(visible);
    const overflows = [];
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const title = card.querySelector('.card-title, h2, .card-danger-title')?.textContent?.trim() ?? card.className;
      for (const node of card.querySelectorAll('*')) {
        if (!visible(node) || node.closest('.tooltip-bubble')) continue;
        const box = shownBox(node, card);
        // Rogné entièrement, ou zone d'accessibilité de 1 px hors écran.
        if (box.width <= 1 || box.height <= 1) continue;
        if (box.right > rect.right + 1 || box.left < rect.left - 1) {
          overflows.push({ card: title, node: String(node.className || node.tagName).slice(0, 60), text: node.textContent.trim().slice(0, 40) });
        }
      }
    }
    const overlaps = [...panel.querySelectorAll('.sequence-control')].filter(visible).flatMap((row) => {
      const toggle = row.querySelector('.tog')?.getBoundingClientRect();
      const label = row.querySelector(':scope > span');
      if (!label) return [];
      const range = document.createRange();
      range.selectNodeContents(label);
      const hit = [...range.getClientRects()].some((line) => intersects(line, toggle));
      const own = row.getBoundingClientRect();
      const outside = toggle && (toggle.right > own.right + 1 || toggle.left < own.left - 1);
      return hit || outside ? [{ label: label.textContent.trim(), underLabel: hit, outsideRow: !!outside }] : [];
    });
    return {
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      cards: cards.length,
      overflows: overflows.slice(0, 8),
      overflowCount: overflows.length,
      overlaps,
    };
  }, CARDS);
}

async function captureCards(page, ctx, prefix) {
  const cards = page.locator(CARDS);
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    if (!await card.isVisible()) continue;
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    await card.screenshot({ path: join(ctx.runDir, `${prefix}-${String(index + 1).padStart(2, '0')}.png`) });
  }
}

async function scan(page, ctx, kind, capturesWanted) {
  const items = page.locator(`li[role="option"][data-kind="${kind}"]`);
  const count = await items.count();
  const faults = [];
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const name = (await item.innerText()).trim().split('\n')[0];
    await item.click();
    await page.waitForTimeout(120);
    const layout = await inspectPanel(page);
    if (layout.overflowCount > 0 || layout.overlaps.length > 0) faults.push({ name, ...layout });
    if (index < capturesWanted) {
      await captureCards(page, ctx, `${kind}-${String(index + 1).padStart(2, '0')}`);
    }
  }
  return { count, faults };
}

export async function run(args = []) {
  const [archive, capturesArg] = args;
  const captures = Number(capturesArg ?? 6);
  const ctx = createRun('c7-s9-panneau-ecran-etroit');
  if (!archive) {
    ctx.check('archive fournie en argument', false, { usage: 'node e2e/run.mjs c7-s9-panneau-ecran-etroit <archive> [captures]' });
    return ctx.finish();
  }

  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  try {
    const { page, events } = app;
    await importPack(page, archive, { editor: 'graphe' });
    const width = await resizeSettingsToMinimum(page);
    ctx.check('l’Inspecteur est à 200 px', width.value === width.minimum && Math.abs(width.width - 200) <= 2, width);

    const stages = await scan(page, ctx, 'stage', captures);
    ctx.check('Écrans : rien ne sort de sa carte, aucun libellé sous un interrupteur',
      stages.count > 0 && stages.faults.length === 0, { stageCount: stages.count, faults: stages.faults });

    const actions = await scan(page, ctx, 'action', Math.min(captures, 3));
    ctx.check('Listes de choix : rien ne sort de sa carte',
      actions.count > 0 && actions.faults.length === 0, { actionCount: actions.count, faults: actions.faults });

    ctx.check('aucune erreur console ni exception', events.faults().length === 0, { faults: events.faults().slice(0, 5) });
  } finally {
    await app.stop();
  }
  return ctx.finish();
}
