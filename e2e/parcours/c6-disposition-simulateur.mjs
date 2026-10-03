// Dispositions propres aux deux éditeurs et géométrie persistante du
// simulateur commun. Une seule app à la fois ; le second lancement reprend le
// profil du premier pour exercer une vraie relance WebView2.
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack, returnHome } from '../lib/actions.mjs';
import { smallestArchive } from '../lib/corpus.mjs';

const GEOMETRY_KEYS = {
  menus: 'storyStudio.free.floatingSimulatorGeometry',
  graphe: 'storyStudio.advanced.floatingSimulatorGeometry',
};

const BOTTOM_KEYS = {
  menus: {
    open: 'storyStudio.free.bottomPanelOpen',
    tab: 'storyStudio.free.bottomPanelTab',
    height: 'storyStudio.free.bottomPanelHeight',
  },
  graphe: {
    open: 'storyStudio.advanced.bottomPanelOpen',
    tab: 'storyStudio.advanced.bottomPanelTab',
    height: 'storyStudio.advanced.bottomPanelHeight',
  },
};

function closeEnough(actual, expected, tolerance = 3) {
  return Math.abs(actual - expected) <= tolerance;
}

function sameBox(actual, expected, tolerance = 3) {
  return ['x', 'y', 'width', 'height'].every((field) => closeEnough(actual[field], expected[field], tolerance));
}

async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('poignée sans géométrie');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function openEditor(page, editor) {
  await importPack(page, smallestArchive('01 - Editable'), { editor });
}

async function configureBottomPanel(page, editor) {
  const tab = editor === 'menus' ? 'File IA' : 'File de rendu';
  await page.locator('.rq-bottombar-btn').filter({ hasText: tab }).click();
  const panel = page.locator('.bottom-workspace-panel');
  await panel.waitFor({ timeout: 15_000 });
  await panel.getByRole('button', { name: tab }).click();
  await dragBy(page, panel.locator('.bottom-workspace-resize-handle'), 0, editor === 'menus' ? -55 : -145);
  const box = await panel.boundingBox();
  const storedHeight = Number(await page.evaluate(
    (key) => localStorage.getItem(key),
    BOTTOM_KEYS[editor].height,
  ));
  return { box, storedHeight };
}

async function assertBottomPanel(ctx, page, editor, expectedHeight, label) {
  const panel = page.locator('.bottom-workspace-panel');
  await panel.waitFor({ timeout: 15_000 });
  const expectedTab = editor === 'menus' ? 'File IA' : 'File de rendu';
  const tab = panel.getByRole('button', { name: expectedTab });
  const box = await panel.boundingBox();
  ctx.check(`${label} : panneau inférieur ouvert sur ${expectedTab}`, await tab.evaluate((node) => node.classList.contains('is-active')));
  ctx.check(`${label} : hauteur propre conservée`, closeEnough(box.height, expectedHeight), { expectedHeight, actualHeight: box.height });
  return box;
}

async function openSimulator(page) {
  const launcher = page.getByRole('button', { name: 'Lancer le simulateur' }).first();
  await launcher.waitFor({ timeout: 30_000 });
  await launcher.click();
  const simulator = page.locator('.floating-simulator:not(.floating-simulator--notice)');
  await simulator.waitFor({ timeout: 120_000 });
  await simulator.locator('.lunii-sim').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(350);
  return simulator;
}

async function closeSimulator(page, simulator) {
  await simulator.getByRole('button', { name: 'Fermer le simulateur' }).click();
  await simulator.waitFor({ state: 'hidden', timeout: 10_000 });
}

async function configureSimulator(page, editor) {
  let simulator = await openSimulator(page);
  const initial = await simulator.boundingBox();
  await dragBy(page, simulator.getByRole('button', { name: 'Déplacer le simulateur' }), editor === 'menus' ? -150 : 120, editor === 'menus' ? 70 : 35);
  await dragBy(page, simulator.locator('.floating-simulator-resize'), editor === 'menus' ? -70 : -85, editor === 'menus' ? -45 : -55);
  const changed = await simulator.boundingBox();

  await closeSimulator(page, simulator);
  simulator = await openSimulator(page);
  const reopened = await simulator.boundingBox();
  await closeSimulator(page, simulator);
  simulator = await openSimulator(page);
  const reopenedAgain = await simulator.boundingBox();
  return { simulator, initial, changed, reopened, reopenedAgain };
}

async function storedState(page) {
  return page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), [
    ...Object.values(GEOMETRY_KEYS),
    ...Object.values(BOTTOM_KEYS).flatMap((entry) => Object.values(entry)),
  ]);
}

export async function run() {
  const ctx = createRun('c6-disposition-simulateur');
  const workspaceDir = ctx.dir('workspace');
  const archive = smallestArchive('01 - Editable');
  const expected = {};
  let app = await launchApp({ runDir: ctx.dir('premier-lancement'), fresh: true, workspaceDir });

  try {
    const { page, events } = app;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    ctx.check('dimensions d’écran compatibles avec les parcours existants', viewport.width >= 1100 && viewport.height >= 680, viewport);

    await importPack(page, archive, { editor: 'menus' });
    await configureBottomPanel(page, 'menus');
    const freeSimulator = await configureSimulator(page, 'menus');
    expected.menus = {
      bottomHeight: Number(await page.evaluate((key) => localStorage.getItem(key), BOTTOM_KEYS.menus.height)),
      simulator: freeSimulator.reopenedAgain,
    };
    ctx.check('menus : déplacement et redimensionnement ont changé la géométrie', !sameBox(freeSimulator.reopened, freeSimulator.initial, 10), { initial: freeSimulator.initial, changed: freeSimulator.changed, reopened: freeSimulator.reopened });
    ctx.check('menus : fermeture/réouverture conserve la géométrie', sameBox(freeSimulator.reopenedAgain, freeSimulator.reopened), { reopened: freeSimulator.reopened, reopenedAgain: freeSimulator.reopenedAgain });
    await ctx.shot(page, 'menus-disposition-et-simulateur');
    await closeSimulator(page, freeSimulator.simulator);
    await returnHome(page);

    await importPack(page, archive, { editor: 'graphe' });
    await configureBottomPanel(page, 'graphe');
    const advancedSimulator = await configureSimulator(page, 'graphe');
    expected.graphe = {
      bottomHeight: Number(await page.evaluate((key) => localStorage.getItem(key), BOTTOM_KEYS.graphe.height)),
      simulator: advancedSimulator.reopenedAgain,
    };
    ctx.check('graphe : déplacement et redimensionnement ont changé la géométrie', !sameBox(advancedSimulator.reopened, advancedSimulator.initial, 10), { initial: advancedSimulator.initial, changed: advancedSimulator.changed, reopened: advancedSimulator.reopened });
    ctx.check('graphe : fermeture/réouverture conserve la géométrie', sameBox(advancedSimulator.reopenedAgain, advancedSimulator.reopened), { reopened: advancedSimulator.reopened, reopenedAgain: advancedSimulator.reopenedAgain });

    const stored = await storedState(page);
    ctx.check('les onglets et hauteurs des deux éditeurs sont distincts', stored[BOTTOM_KEYS.menus.tab] === 'ai'
      && stored[BOTTOM_KEYS.graphe.tab] === 'queue'
      && stored[BOTTOM_KEYS.menus.height] !== stored[BOTTOM_KEYS.graphe.height], stored);
    ctx.check('les géométries du simulateur sont enregistrées séparément', Boolean(stored[GEOMETRY_KEYS.menus])
      && Boolean(stored[GEOMETRY_KEYS.graphe])
      && stored[GEOMETRY_KEYS.menus] !== stored[GEOMETRY_KEYS.graphe], stored);
    ctx.check('premier lancement sans erreur console/IPC', events.faults().length === 0, { faults: events.faults() });
    await ctx.shot(page, 'graphe-disposition-et-simulateur');
    await closeSimulator(page, advancedSimulator.simulator);
    await returnHome(page);
  } finally {
    const stop = await app.stop({ graceful: true });
    ctx.check('premier lancement : fermeture propre et workspace réel intact', stop.closedGracefully && stop.polluted.length === 0, stop);
  }

  app = await launchApp({ runDir: ctx.dir('relance'), fresh: false, workspaceDir });
  try {
    const { page, events } = app;
    await openEditor(page, 'menus');
    await assertBottomPanel(ctx, page, 'menus', expected.menus.bottomHeight, 'relance menus');
    let simulator = await openSimulator(page);
    const freeRelaunched = await simulator.boundingBox();
    ctx.check('relance menus : géométrie du simulateur conservée', sameBox(freeRelaunched, expected.menus.simulator), { expected: expected.menus.simulator, actual: freeRelaunched });
    await closeSimulator(page, simulator);
    await returnHome(page);

    await openEditor(page, 'graphe');
    await assertBottomPanel(ctx, page, 'graphe', expected.graphe.bottomHeight, 'relance graphe');
    simulator = await openSimulator(page);
    const advancedRelaunched = await simulator.boundingBox();
    ctx.check('relance graphe : géométrie du simulateur conservée', sameBox(advancedRelaunched, expected.graphe.simulator), { expected: expected.graphe.simulator, actual: advancedRelaunched });
    ctx.check('relance : les géométries restent différentes entre les éditeurs', !sameBox(freeRelaunched, advancedRelaunched, 10), { menus: freeRelaunched, graphe: advancedRelaunched });
    ctx.check('relance sans erreur console/IPC', events.faults().length === 0, { faults: events.faults() });
    await ctx.shot(page, 'relance-graphe');
    await closeSimulator(page, simulator);
    await returnHome(page);
  } finally {
    const stop = await app.stop({ graceful: true });
    ctx.check('relance : fermeture propre et workspace réel intact', stop.closedGracefully && stop.polluted.length === 0, stop);
  }

  return ctx.finish({ expected });
}
