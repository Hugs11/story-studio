// Poignées de raccord du graphe : visibilité et geste réel selon le zoom.
//
// Deux parties, à trois tailles de fenêtre (portable 1280×800, 1920×1080,
// 2560×1440) :
//
// 1. **Mesure**, sur un Écran survolé, pour chaque zoom : nombre de poignées,
//    taille de la zone de saisie, taille de la pastille visible, part de la
//    carte couverte, poignées d'un même nœud qui se recouvrent.
// 2. **Gestes**, à la souris réelle (CDP) :
//    - au zoom de travail et dézoomé, survoler un Écran, attraper sa prise OK
//      en traversant la carte, lâcher sur une Liste : le lien doit exister ;
//    - attraper la prise à 100 %, dézoomer **pendant** le geste à la molette,
//      finir sur une Liste éloignée : le lien doit exister.
//
// Les nœuds sont écartés par la caméra du moteur (positions de rendu), pas
// par le document : le geste ne lit que ce que la surface peint.
//
// Usage : node e2e/run.mjs c7-graphe-poignees

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome } from '../lib/actions.mjs';
import { createGraphAction, createGraphStage } from '../lib/c4-helpers.mjs';

const RESOLUTIONS = [
  { width: 1280, height: 800, label: '1280x800' },
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 2560, height: 1440, label: '2560x1440' },
];
const MEASURE_ZOOMS = [1, 0.55, 0.4, 0.3, 0.25, 0.2, 0.15, 0.12, 0.08, 0.05];
const GESTURE_ZOOMS = [1, 0.3, 0.2, 0.12, 0.06];
const STAGES = GESTURE_ZOOMS.length * 2;

async function setWindowSize(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ([w, h]) => Math.abs(innerWidth - w) <= 2 && Math.abs(innerHeight - h) <= 2,
    [width, height],
    { timeout: 15_000 },
  );
  // La fenêtre est à sa taille, mais le moteur du graphe mesure son hôte avec
  // un temps de retard : centrer ou panner avec l'ancienne mesure décale tout
  // le couple. On attend qu'il ait la taille réelle de l'hôte (et on la lui
  // impose si l'observateur de taille a été manqué).
  await page.waitForFunction(() => {
    const host = document.querySelector('.advanced-canvas__host');
    const cy = host?._cyreg?.cy;
    if (!cy) return false;
    cy.resize();
    return Math.abs(cy.width() - host.clientWidth) <= 1 && Math.abs(cy.height() - host.clientHeight) <= 1;
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(400);
}

// Les chemins des nœuds, lus sur le moteur : le premier Écran et la Liste.
async function nodePaths(page) {
  return page.evaluate(() => {
    const { cy } = document.querySelector('.advanced-canvas__host')._cyreg;
    return {
      stages: cy.nodes('[kind = "stage"]').map((node) => node.id()),
      actions: cy.nodes('[kind = "action"]').map((node) => node.id()),
    };
  });
}

// Écarte les nœuds en rendu : les Écrans en colonne à gauche, la Liste loin à
// droite, puis pose zoom et caméra. `gap` est en unités de graphe. Avec
// `pair`, la Liste se range à la hauteur de l'Écran source et la caméra se
// centre sur ce couple : l'hôte ne mesure que 470 px de large à 1280×800, et
// un centrage sur l'ensemble laisse la source hors champ (aucune carte dans la
// couche) ou la cible dans la bande d'auto-pan du bord (64 px), qui la
// déplace sous le pointeur pendant le geste.
async function layout(page, { zoom, gap, center = 'all', pair = null }) {
  await page.evaluate(([level, spread, focus, couple]) => {
    const host = document.querySelector('.advanced-canvas__host');
    const { cy } = host._cyreg;
    cy.nodes('[kind = "stage"]').forEach((node, i) => node.position({ x: 0, y: i * 200 }));
    cy.nodes('[kind = "action"]').forEach((node, i) => node.position({ x: spread, y: i * 200 }));
    cy.resize();
    cy.zoom(level);
    if (couple) {
      const from = cy.$id(couple.source);
      const to = cy.$id(couple.action);
      to.position({ x: spread, y: from.position('y') });
      cy.center(from.union(to));
    } else if (focus === 'all') cy.center(cy.nodes());
    else cy.center(cy.$id(focus));
  }, [zoom, gap, center, pair]);
  await page.waitForTimeout(500);
}

// Écart source/Liste en unités de graphe : au plus 400, et assez serré pour que
// le couple (cartes comprises, ~230 px à 100 %) laisse 90 px à chaque bord de
// l'hôte, soit hors de la bande d'auto-pan. L'hôte vaut la fenêtre moins le
// panneau de réglages (~810 px de moins à 1280×800).
function pairGap(zoom, resolution) {
  const hostWidth = resolution.width <= 1280 ? 470 : resolution.width - 600;
  return Math.max(60, Math.min(400, (hostWidth - 180 - 230 * zoom) / zoom));
}

async function nodeBox(page, path) {
  const overlay = page.locator(`[data-node-path="${path}"]`).first();
  if (await overlay.count() === 0) return null;
  return overlay.boundingBox();
}

async function edgeExists(page, source, target) {
  return page.evaluate(([from, to]) => {
    const { cy } = document.querySelector('.advanced-canvas__host')._cyreg;
    return cy.edges().some((edge) => edge.source().id() === from && edge.target().id() === to);
  }, [source, target]);
}

async function measureHandles(page, path) {
  return page.evaluate((nodePath) => {
    const overlay = document.querySelector(`[data-node-path="${CSS.escape(nodePath)}"]`);
    if (!overlay) return { handles: 0 };
    const card = overlay.getBoundingClientRect();
    const buttons = [...overlay.querySelectorAll('.advanced-node-overlay__ports button')];
    const boxes = buttons.map((button) => button.getBoundingClientRect());
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    let pairsOverlapping = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) if (overlap(boxes[i], boxes[j]) > 4) pairsOverlapping += 1;
    }
    let covered = 0;
    let samples = 0;
    for (let x = 0.5; x < 20; x += 1) {
      for (let y = 0.5; y < 20; y += 1) {
        const px = card.left + (x / 20) * card.width;
        const py = card.top + (y / 20) * card.height;
        samples += 1;
        if (boxes.some((h) => px >= h.left && px <= h.right && py >= h.top && py <= h.bottom)) covered += 1;
      }
    }
    const dot = buttons[0] ? Number.parseFloat(getComputedStyle(buttons[0], '::before').width) : null;
    return {
      card: `${Math.round(card.width)}×${Math.round(card.height)}`,
      handles: buttons.length,
      revealed: buttons.some((button) => button.classList.contains('is-revealed')),
      handlePx: boxes[0] ? Math.round(boxes[0].width) : null,
      dotPx: dot,
      cardCoveredPct: Math.round((covered / samples) * 100),
      pairsOverlapping,
    };
  }, path);
}

// Survole la carte, puis rejoint la prise OK **en glissant** depuis le centre,
// comme une main : un saut direct masquerait un interstice où le survol se perd.
async function grabOk(page, stagePath) {
  const card = await nodeBox(page, stagePath);
  if (!card) return { ok: false, why: 'carte source absente de la couche' };
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  await page.mouse.move(cx - 3, cy);
  await page.mouse.move(cx, cy, { steps: 3 });
  await page.waitForTimeout(250);
  const handle = page.locator(`[data-node-path="${stagePath}"] button.is-stage-ok`).first();
  if (await handle.count() === 0) return { ok: false, why: 'aucune poignée OK après survol' };
  const box = await handle.boundingBox();
  const hx = box.x + box.width / 2;
  const hy = box.y + box.height / 2;
  await page.mouse.move(hx, hy, { steps: 12 });
  await page.waitForTimeout(120);
  if (await handle.count() === 0) return { ok: false, why: 'la poignée a disparu pendant l’approche' };
  await page.mouse.down();
  return { ok: true };
}

async function dropOn(page, targetPath) {
  const target = await nodeBox(page, targetPath);
  if (!target) {
    await page.mouse.up();
    return { ok: false, why: 'cible absente de la couche' };
  }
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.waitForTimeout(500);
  // Relue après stabilisation de la caméra (auto-pan, zoom) puis revisée.
  const settled = await nodeBox(page, targetPath);
  if (settled) await page.mouse.move(settled.x + settled.width / 2, settled.y + settled.height / 2, { steps: 4 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(700);
  return { ok: true };
}

// Molette posée en (x, y) : zoom avant/après et dérive du point du graphe sous
// le pointeur. La molette zoome centrée sur le pointeur, donc ce point ne
// bouge pas (en pixels écran).
async function wheelAt(page, x, y, deltaY = -240) {
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(200);
  const read = () => page.evaluate(([px, py]) => {
    const host = document.querySelector('.advanced-canvas__host');
    const { cy } = host._cyreg;
    const box = host.getBoundingClientRect();
    const zoom = cy.zoom();
    const pan = cy.pan();
    return { zoom, gx: (px - box.x - pan.x) / zoom, gy: (py - box.y - pan.y) / zoom };
  }, [x, y]);
  const before = await read();
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
  const after = await read();
  const drift = Math.hypot(after.gx - before.gx, after.gy - before.gy) * after.zoom;
  return { before: before.zoom, after: after.zoom, driftPx: Math.round(drift * 10) / 10 };
}

async function centerOf(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

// Un point où le pointeur n'est sur aucun élément HTML ni nœud : le haut de
// l'hôte, au-dessus des cartes, là où seul le canvas répond.
async function voidPoint(page) {
  return page.evaluate(() => {
    const host = document.querySelector('.advanced-canvas__host');
    const box = host.getBoundingClientRect();
    for (const fy of [0.08, 0.15, 0.25]) {
      for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const x = box.x + box.width * fx;
        const y = box.y + box.height * fy;
        if (host.contains(document.elementFromPoint(x, y))) return { x, y };
      }
    }
    return null;
  });
}

// Attrape la dernière prise d'une Liste (l'emplacement d'ajout), après survol.
async function grabActionPort(page, actionPath) {
  const card = await nodeBox(page, actionPath);
  if (!card) return { ok: false, why: 'Liste absente de la couche' };
  await page.mouse.move(card.x + card.width / 2 - 3, card.y + card.height / 2);
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 3 });
  await page.waitForTimeout(250);
  const handle = page.locator(`[data-node-path="${actionPath}"] .advanced-node-overlay__ports button`).last();
  if (await handle.count() === 0) return { ok: false, why: 'aucune prise de Liste après survol' };
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.down();
  return { ok: true };
}

// Lâche le trait sur le bord extérieur du bouton d'une prise du nœud visé : la
// prise elle-même, pas la carte. Le pointeur y arrive **de l'extérieur**, sans
// avoir survolé la carte : le canvas ne sait alors rien du nœud, et seule la
// règle de cible peut le désigner.
async function dropOnPortOf(page, targetPath, which = 'last') {
  const card = await nodeBox(page, targetPath);
  const buttons = page.locator(`[data-node-path="${targetPath}"] .advanced-node-overlay__ports button`);
  if (!card || await buttons.count() === 0) {
    await page.mouse.up();
    return { ok: false, why: 'cible ou prise absente de la couche' };
  }
  const box = await (which === 'last' ? buttons.last() : buttons.first()).boundingBox();
  const centre = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
  const bx = box.x + box.width / 2;
  const by = box.y + box.height / 2;
  // Direction de la prise par rapport à la carte : le point visé est le coin
  // du bouton le plus éloigné du centre, l'approche vient de plus loin encore.
  const horizontal = Math.abs(bx - centre.x) >= Math.abs(by - centre.y);
  const sign = horizontal ? Math.sign(bx - centre.x) : Math.sign(by - centre.y);
  const edge = horizontal
    ? { x: bx + sign * (box.width / 2 - 2), y: by }
    : { x: bx, y: by + sign * (box.height / 2 - 2) };
  const outside = horizontal ? { x: edge.x + sign * 90, y: edge.y } : { x: edge.x, y: edge.y + sign * 90 };
  await page.mouse.move(outside.x, outside.y, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.move(edge.x, edge.y, { steps: 8 });
  await page.waitForTimeout(400);
  const seen = await page.evaluate(([x, y]) => {
    const frame = document.querySelector('.advanced-link-draft [data-reach]');
    return {
      framed: frame ? Number.parseFloat(frame.getAttribute('width')) > 0 : null,
      onButton: Boolean(document.elementFromPoint(x, y)?.closest('.advanced-node-overlay__ports button')),
    };
  }, [edge.x, edge.y]);
  await page.mouse.up();
  await page.waitForTimeout(700);
  return { ok: true, ...seen };
}

async function openDialog(page) {
  const dialog = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').first();
  if (await dialog.count() === 0) return null;
  const text = (await dialog.innerText()).slice(0, 200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return text;
}

export async function run() {
  const ctx = createRun('c7-graphe-poignees');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
  const rows = [];
  const gestures = [];
  try {
    const { page, events } = app;
    await newProject(page, 'advanced');
    for (let i = 0; i < STAGES; i += 1) await createGraphStage(page);
    await createGraphAction(page);
    await page.waitForTimeout(600);
    const { stages, actions } = await nodePaths(page);
    ctx.check('graphe de test : Écrans et Liste créés', stages.length >= STAGES && actions.length >= 1, { stages, actions });
    const action = actions[0];

    // Les sources déjà utilisées : un Écran raccordé n'offre plus le même
    // geste, chaque essai part donc d'un Écran neuf.
    let nextStage = 0;
    const freshStage = () => stages[nextStage++ % stages.length];

    for (const resolution of RESOLUTIONS) {
      await setWindowSize(page, resolution.width, resolution.height);

      // 1. Mesure sur l'Écran survolé.
      const probe = stages[stages.length - 1];
      for (const zoom of MEASURE_ZOOMS) {
        await layout(page, { zoom, gap: 600, center: probe });
        const card = await nodeBox(page, probe);
        if (card) await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 3 });
        await page.waitForTimeout(250);
        const metrics = await measureHandles(page, probe);
        const row = { resolution: resolution.label, zoomPct: Math.round(zoom * 100), ...metrics };
        rows.push(row);
        console.log(JSON.stringify(row));
        await page.locator('.advanced-canvas__stage').screenshot({
          path: join(ctx.runDir, `${resolution.label}-z${String(Math.round(zoom * 100)).padStart(3, '0')}.png`),
        });
        await page.mouse.move(5, 5);
      }
    }

    // 2. Gestes, à la plus petite et à la plus grande fenêtre.
    for (const resolution of [RESOLUTIONS[0], RESOLUTIONS[2]]) {
      await setWindowSize(page, resolution.width, resolution.height);
      for (const zoom of GESTURE_ZOOMS) {
        if (nextStage >= stages.length) break;
        const source = freshStage();
        await layout(page, { zoom, gap: pairGap(zoom, resolution), pair: { source, action } });
        const grabbed = await grabOk(page, source);
        let dropped = { ok: false };
        if (grabbed.ok) dropped = await dropOn(page, action);
        const linked = await edgeExists(page, source, action);
        const dialog = linked ? null : await openDialog(page);
        const result = { resolution: resolution.label, gesture: 'direct', zoomPct: Math.round(zoom * 100), grabbed, dropped, linked, dialog };
        gestures.push(result);
        console.log(JSON.stringify(result));
        await ctx.shot(page, `geste-${resolution.label}-z${Math.round(zoom * 100)}`);
        ctx.check(`${resolution.label} à ${Math.round(zoom * 100)} % : OK d’un Écran tiré jusqu’à la Liste`, linked, result);
        await page.mouse.move(5, 5);
      }
    }

    // 3. Attraper à 100 %, dézoomer pendant le geste, finir loin.
    await setWindowSize(page, RESOLUTIONS[0].width, RESOLUTIONS[0].height);
    // Un Écran de plus, pour que le geste parte d'une prise encore libre.
    await createGraphStage(page);
    await page.waitForTimeout(400);
    const refreshed = await nodePaths(page);
    const source = refreshed.stages.find((path) => !stages.includes(path)) ?? refreshed.stages[0];
    // La Liste est rangée à 520 unités, à la hauteur de la source, qu'on cale
    // près du bord gauche de l'hôte : à 100 % la Liste est hors champ.
    await layout(page, { zoom: 1, gap: 520, pair: { source, action } });
    await page.evaluate((path) => {
      const { cy } = document.querySelector('.advanced-canvas__host')._cyreg;
      cy.resize();
      cy.panBy({ x: 110 - cy.$id(path).renderedPosition('x'), y: 0 });
    }, source);
    await page.waitForTimeout(400);
    const grabbed = await grabOk(page, source);
    let zoomDuring = null;
    let linked = false;
    if (grabbed.ok) {
      const host = await page.locator('.advanced-canvas__host').boundingBox();
      const sourceBox = await nodeBox(page, source);
      // Molette posée sur du vide (une carte ne zoome pas), dans l'intervalle
      // entre la source et la Liste, sur la ligne de la source.
      const wheelX = host.x + Math.max(sourceBox.x + sourceBox.width + 60 - host.x, 300);
      const wheelY = sourceBox.y + sourceBox.height / 2;
      await page.mouse.move(wheelX, wheelY, { steps: 10 });
      for (let i = 0; i < 80 && (i === 0 || zoomDuring > 0.2); i += 1) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(60);
        zoomDuring = await page.evaluate(() => document.querySelector('.advanced-canvas__host')._cyreg.cy.zoom());
      }
      await page.waitForTimeout(400);
      const draftVisible = await page.locator('.advanced-link-draft').count() > 0;
      ctx.check('dézoom pendant le geste : le trait est toujours en cours', draftVisible, { zoomDuring });
      ctx.check('dézoom pendant le geste : la molette a bien dézoomé', zoomDuring < 0.5, { zoomDuring });
      const target = await nodeBox(page, action);
      const inView = Boolean(target) && target.x >= host.x + 64 && target.x + target.width <= host.x + host.width - 64;
      ctx.check('dézoom pendant le geste : la Liste est entrée dans le champ, hors bande d’auto-pan', inView, { target, host });
      await dropOn(page, action);
      linked = await edgeExists(page, source, action);
    }
    const dialog = linked ? null : await openDialog(page);
    const result = { gesture: 'attraper-dezoomer-finir', grabbed, zoomDuring, linked, dialog };
    gestures.push(result);
    console.log(JSON.stringify(result));
    await ctx.shot(page, 'geste-attraper-dezoomer-finir');
    ctx.check('attraper à 100 %, dézoomer à la molette, finir sur une Liste éloignée', linked, result);

    // 3 bis. Lâcher le trait sur une prise du nœud visé vaut un lâcher sur sa
    //        carte : le lien se crée, la fenêtre de création ne s'ouvre pas.
    await setWindowSize(page, RESOLUTIONS[0].width, RESOLUTIONS[0].height);
    for (const direction of ['ecran-vers-liste', 'liste-vers-ecran']) {
      await createGraphStage(page);
      await createGraphAction(page);
      await page.waitForTimeout(400);
      const now = await nodePaths(page);
      const fromStage = now.stages.find((path) => !stages.includes(path) && path !== source) ?? now.stages[now.stages.length - 1];
      const fromAction = now.actions[now.actions.length - 1];
      const pairSource = direction === 'ecran-vers-liste' ? fromStage : fromAction;
      const pairTarget = direction === 'ecran-vers-liste' ? fromAction : fromStage;
      await layout(page, { zoom: 1, gap: pairGap(1, RESOLUTIONS[0]), pair: { source: fromStage, action: fromAction } });
      const taken = direction === 'ecran-vers-liste' ? await grabOk(page, fromStage) : await grabActionPort(page, fromAction);
      let onPort = { ok: false };
      if (taken.ok) onPort = await dropOnPortOf(page, pairTarget, 'last');
      const made = await edgeExists(page, pairSource, pairTarget);
      const popup = made ? null : await openDialog(page);
      const outcome = { gesture: `prise-${direction}`, taken, onPort, made, popup };
      gestures.push(outcome);
      console.log(JSON.stringify(outcome));
      await ctx.shot(page, `geste-sur-prise-${direction}`);
      ctx.check(`lâcher sur une prise (${direction}) : le lien est créé`, made, outcome);
      ctx.check(`lâcher sur une prise (${direction}) : le pointeur était bien sur le bouton`, onPort.onButton === true, outcome);
      ctx.check(`lâcher sur une prise (${direction}) : aucune fenêtre de création`, popup === null, outcome);
      await page.mouse.move(5, 5);
    }

    // 4. La molette zoome partout sur le graphe, y compris sous un élément HTML
    //    posé sur le canvas (repère de la vue éloignée, carte, prise de lien).
    await setWindowSize(page, RESOLUTIONS[0].width, RESOLUTIONS[0].height);
    const hostBox = await page.locator('.advanced-canvas__host').boundingBox();
    const probeStage = stages[0];
    const zoomsIn = (r) => Boolean(r) && r.after > r.before * 1.05;
    const anchored = (r) => Boolean(r) && r.driftPx <= 3;

    // Référence : le vide, à 100 %. Cytoscape écrête ses premiers cran de
    // molette pour mesurer le périphérique : on les consomme d'abord.
    await layout(page, { zoom: 1, gap: 600, center: probeStage });
    const spot = await voidPoint(page);
    ctx.check('un point de vide existe dans l’hôte', Boolean(spot), { hostBox });
    await page.mouse.move(spot.x, spot.y, { steps: 3 });
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.wheel(0, i % 2 ? 240 : -240);
      await page.waitForTimeout(40);
    }
    await layout(page, { zoom: 1, gap: 600, center: probeStage });
    const empty = await wheelAt(page, spot.x, spot.y);
    ctx.check('molette au-dessus du vide : le zoom change (référence)', zoomsIn(empty), empty);

    // Une carte, à 100 %.
    await layout(page, { zoom: 1, gap: 600, center: probeStage });
    const cardPoint = await centerOf(page, `[data-node-path="${probeStage}"]`);
    const onCard = cardPoint ? await wheelAt(page, cardPoint.x, cardPoint.y) : null;
    ctx.check('molette au-dessus d’une carte à 100 % : le zoom change', zoomsIn(onCard), onCard);
    ctx.check('molette au-dessus d’une carte : zoom centré sur le pointeur', anchored(onCard), onCard);

    // Une prise de lien : survoler la carte la révèle, puis viser le bouton.
    await layout(page, { zoom: 1, gap: 600, center: probeStage });
    const cardAgain = await centerOf(page, `[data-node-path="${probeStage}"]`);
    let onPort = null;
    if (cardAgain) {
      await page.mouse.move(cardAgain.x, cardAgain.y, { steps: 3 });
      await page.waitForTimeout(300);
      const portPoint = await centerOf(page, `[data-node-path="${probeStage}"] button.is-stage-ok`);
      onPort = portPoint ? await wheelAt(page, portPoint.x, portPoint.y) : null;
    }
    ctx.check('molette au-dessus d’une prise de lien : le zoom change', zoomsIn(onPort), onPort);

    // Les repères de la vue éloignée (sous 3 %).
    await layout(page, { zoom: 0.02, gap: 600, center: 'all' });
    await page.waitForSelector('.advanced-landmark', { timeout: 5000 }).catch(() => {});
    const landmark = await centerOf(page, '.advanced-landmark');
    ctx.check('vue éloignée : un repère est affiché', Boolean(landmark), {});
    const onLandmark = landmark ? await wheelAt(page, landmark.x, landmark.y) : null;
    ctx.check('molette au-dessus d’un repère éloigné : le zoom change', zoomsIn(onLandmark), onLandmark);
    ctx.check('molette au-dessus d’un repère éloigné : zoom centré sur le pointeur', anchored(onLandmark), onLandmark);

    await layout(page, { zoom: 0.02, gap: 600, center: 'all' });
    await page.waitForSelector('.advanced-landmark-callout, .advanced-landmark__name', { timeout: 3000 }).catch(() => {});
    const nameSelector = await page.locator('.advanced-landmark-callout').count() > 0
      ? '.advanced-landmark-callout' : '.advanced-landmark__name';
    const namePoint = await centerOf(page, nameSelector);
    const onName = namePoint ? await wheelAt(page, namePoint.x, namePoint.y) : null;
    ctx.check(`molette au-dessus d’un nom éloigné (${nameSelector}) : le zoom change`, zoomsIn(onName), onName);
    await page.mouse.move(5, 5);

    await returnHome(page);
    ctx.check('parcours sans erreur console/IPC', events.faults().length === 0, { faults: events.faults() });
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    await app.stop();
  }
  writeFileSync(join(ctx.runDir, 'mesures.json'), JSON.stringify({ rows, gestures }, null, 2));
  return ctx.finish({ rows, gestures });
}
