// Lisibilité du graphe selon le zoom : noms, compteur de choix, poignées de
// liens et logo de la Liste de choix.
//
// Parcours de **mesure**, pas de verdict : il balaie une gamme de zooms à deux
// tailles de fenêtre (portable 14" à 150 % ≈ 1280×800 CSS, écran 27" à 100 %
// ≈ 2560×1440) et relève, dans le DOM de la couche HTML :
//
// - le zoom « tout cadrer » de chaque pack, là où l'auteur arrive ;
// - la part des noms qui en chevauchent un autre ;
// - la taille de police du compteur de choix ;
// - la part d'une carte d'Écran couverte par ses poignées, et les poignées
//   d'un même nœud qui se recouvrent ;
// - la taille, en pixels, du logo de liste (calculée : il est peint dans le
//   canvas).
//
// Il n'a de sens que si les seuils d'affichage sont **abaissés** au plus bas
// le temps de la mesure : un élément masqué ne se mesure pas.
//
// Usage : node e2e/run.mjs c7-graphe-zoom-lisibilite <archive> [<archive>…]

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack } from '../lib/actions.mjs';

const RESOLUTIONS = [
  { width: 1280, height: 800, label: '14pouces' },
  { width: 2560, height: 1440, label: '27pouces' },
];
const ZOOMS = [1, 0.7, 0.55, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15];
// Le logo de liste : 24 unités de tracé à l'échelle 0,9, dans la texture de 52.
const ACTION_GLYPH_UNITS = 24 * 0.9;
const ACTION_GLYPH_STROKE_UNITS = 2.4;

async function setWindowSize(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ([w, h]) => Math.abs(innerWidth - w) <= 2 && Math.abs(innerHeight - h) <= 2,
    [width, height],
    { timeout: 15_000 },
  );
  await page.waitForTimeout(400);
}

async function fit(page) {
  await page.getByRole('button', { name: 'Cadrer tout le graphe' }).click();
  await page.waitForTimeout(700);
  return page.evaluate(() => document.querySelector('.advanced-canvas__host')._cyreg.cy.zoom());
}

// Zoom autour du centre du graphe cadré : la vue reste sur le cœur du pack.
async function zoomTo(page, level) {
  await page.evaluate((next) => {
    const host = document.querySelector('.advanced-canvas__host');
    const { cy } = host._cyreg;
    cy.zoom({ level: next, renderedPosition: { x: host.clientWidth / 2, y: host.clientHeight / 2 } });
  }, level);
  await page.waitForTimeout(600);
}

async function measure(page) {
  return page.evaluate(() => {
    const host = document.querySelector('.advanced-canvas__host').getBoundingClientRect();
    const inside = (r) => r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom;
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const overlays = [...document.querySelectorAll('.advanced-node-overlay')]
      .map((el) => ({ el, kind: el.dataset.nodeKind, box: el.getBoundingClientRect() }))
      .filter((node) => inside(node.box));

    // Noms : chevauchement d'au moins 2 px de large sur la hauteur de ligne.
    const labels = overlays
      .map((node) => node.el.querySelector('.advanced-node-overlay__label'))
      .filter(Boolean)
      .map((el) => {
        // La boîte du texte réellement écrit, pas celle de la colonne fixe.
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const width = Math.min(text.width, box.width);
        return { left: box.left + (box.width - width) / 2, right: box.left + (box.width + width) / 2, top: box.top, bottom: box.bottom, truncated: el.scrollWidth > el.clientWidth + 1 };
      });
    const clashing = new Set();
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i];
        const b = labels[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
          clashing.add(i); clashing.add(j);
        }
      }
    }
    // Un nom posé sur la carte d'un autre nœud.
    let labelOnNode = 0;
    labels.forEach((label, i) => {
      if (overlays.some((node, k) => k !== i && overlap(label, node.box) > 8)) labelOnNode += 1;
    });

    const counts = [...document.querySelectorAll('.advanced-node-overlay__action-count')]
      .filter((el) => inside(el.getBoundingClientRect()))
      .map((el) => Number.parseFloat(getComputedStyle(el).fontSize));

    // Poignées : part de la carte d'un Écran couverte (échantillonnage), et
    // paires de poignées d'un même nœud qui se recouvrent.
    const coverage = [];
    let handlePairsOverlapping = 0;
    let handlePairs = 0;
    for (const node of overlays) {
      const handles = [...node.el.querySelectorAll('.advanced-node-overlay__ports button')].map((b) => b.getBoundingClientRect());
      if (handles.length === 0) continue;
      for (let i = 0; i < handles.length; i += 1) {
        for (let j = i + 1; j < handles.length; j += 1) {
          handlePairs += 1;
          if (overlap(handles[i], handles[j]) > 4) handlePairsOverlapping += 1;
        }
      }
      if (node.kind !== 'stage') continue;
      const { left, top, width, height } = node.box;
      let covered = 0;
      let samples = 0;
      for (let x = 0.5; x < 20; x += 1) {
        for (let y = 0.5; y < 20; y += 1) {
          const px = left + (x / 20) * width;
          const py = top + (y / 20) * height;
          samples += 1;
          if (handles.some((h) => px >= h.left && px <= h.right && py >= h.top && py <= h.bottom)) covered += 1;
        }
      }
      coverage.push(covered / samples);
    }
    const stage = overlays.find((node) => node.kind === 'stage');
    const action = overlays.find((node) => node.kind === 'action');
    const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
    const handle = document.querySelector('.advanced-node-overlay__ports button')?.getBoundingClientRect();
    return {
      visibleNodes: overlays.length,
      stageCard: stage ? `${Math.round(stage.box.width)}×${Math.round(stage.box.height)}` : null,
      actionBox: action ? `${Math.round(action.box.width)}×${Math.round(action.box.height)}` : null,
      labels: labels.length,
      labelsClashingPct: labels.length ? Math.round((clashing.size / labels.length) * 100) : null,
      labelsOnNodePct: labels.length ? Math.round((labelOnNode / labels.length) * 100) : null,
      labelsTruncatedPct: labels.length ? Math.round((labels.filter((l) => l.truncated).length / labels.length) * 100) : null,
      countFontPx: counts.length ? Math.round(mean(counts) * 10) / 10 : null,
      handlePx: handle ? Math.round(handle.width) : null,
      stageCoveredByHandlesPct: coverage.length ? Math.round(mean(coverage) * 100) : null,
      handlePairsOverlappingPct: handlePairs ? Math.round((handlePairsOverlapping / handlePairs) * 100) : null,
    };
  });
}

export async function run(args = []) {
  const ctx = createRun('c7-graphe-zoom-lisibilite');
  if (args.length === 0) {
    ctx.check('archive fournie en argument', false, { usage: 'node e2e/run.mjs c7-graphe-zoom-lisibilite <archive>…' });
    return ctx.finish();
  }
  const rows = [];
  // Une application par pack : le viewport émulé d'un pack précédent décale
  // le dépôt simulé sur l'accueil, et le pack suivant n'est jamais reçu.
  for (const [packIndex, archive] of args.entries()) {
    const pack = `pack${packIndex + 1}`;
    const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir(`workspace-${pack}`) });
    try {
      const { page } = app;
      await importPack(page, archive, { editor: 'graphe' });
      await page.waitForTimeout(1500);
      for (const resolution of RESOLUTIONS) {
        await setWindowSize(page, resolution.width, resolution.height);
        const fitZoom = await fit(page);
        const nodeCount = await page.evaluate(() => document.querySelector('.advanced-canvas__host')._cyreg.cy.nodes().length);
        console.log(`${pack} (${basename(archive).length} car.) ${resolution.label} : ${nodeCount} nœuds, cadrage ${Math.round(fitZoom * 100)} %`);
        for (const zoom of ZOOMS) {
          await zoomTo(page, zoom);
          const metrics = await measure(page);
          const row = {
            pack, resolution: resolution.label, nodeCount, fitZoomPct: Math.round(fitZoom * 100), zoomPct: Math.round(zoom * 100),
            glyphPx: Math.round(ACTION_GLYPH_UNITS * zoom * 10) / 10,
            glyphStrokePx: Math.round(ACTION_GLYPH_STROKE_UNITS * zoom * 100) / 100,
            ...metrics,
          };
          rows.push(row);
          console.log(JSON.stringify(row));
          await page.locator('.advanced-canvas__stage').screenshot({
            path: join(ctx.runDir, `${pack}-${resolution.label}-z${String(Math.round(zoom * 100)).padStart(3, '0')}.png`),
          });
        }
      }
    } finally {
      await app.stop();
    }
  }
  writeFileSync(join(ctx.runDir, 'mesures.json'), JSON.stringify(rows, null, 2));
  ctx.check('mesures relevées', rows.length > 0, { rows: rows.length });
  return ctx.finish();
}
