// Application Linux réelle : aucun index ni résultat IPC simulé.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { requireConfig } from '../lib/config.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { prepareCatalogueFixtures } from '../lib/catalogue-fixtures.mjs';
import { CATALOGUE_DENSITY, setCatalogueDensity } from '../lib/actions.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const terminal = new Set(['success', 'partial', 'failed', 'cancelled']);

async function until(page, read, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(`Délai dépassé : ${label}`);
}

// Le pilote Linux n'expose pas fill/selectOption ; gestes natifs W3C locaux.
async function fill(page, selector, value) {
  if (selector === '#catalogue-search') {
    await page.keyboard.press('Control+f');
    await until(page, () => page.evaluate(() => document.activeElement?.id === 'catalogue-search'), 'focus recherche catalogue');
  }
  const element = await page.locator(selector).find();
  const path = `/element/${element[ELEMENT]}`;
  await page.client.command('POST', `${path}/click`, {});
  // Envoyer de vraies touches : W3C clear seul ne déclenche pas toujours
  // onChange sur les champs contrôlés React.
  try {
    await page.client.command('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [
      { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '\uE009' },
      { type: 'keyDown', value: '\uE003' }, { type: 'keyUp', value: '\uE003' },
    ] }] });
  } finally { await page.client.command('DELETE', '/actions'); }
  if (value) await page.client.command('POST', `${path}/value`, { text: value });
  await page.drain();
}

async function operations(page) {
  return page.evaluate(async () => {
    const { catalogueApi } = await import('/src/store/catalogue/catalogueApi.js');
    return (await catalogueApi().listOperations()).items;
  });
}

async function cards(page) {
  return page.evaluate(async () => {
    const { catalogueApi } = await import('/src/store/catalogue/catalogueApi.js');
    return (await catalogueApi().listAllEntries()).cards;
  });
}

export async function run() {
  const ctx = createRun('c8-catalogue');
  writeFileSync(join(ctx.runDir, 'events.jsonl'), '');
  let app;
  let windowSize;
  let fixtures;
  try {
    if (process.platform !== 'linux') throw new Error('c8-catalogue requiert le pilote Linux WebKitGTK');
    fixtures = prepareCatalogueFixtures({ corpusDir: requireConfig('corpusDir'),
      demoDir: requireConfig('catalogueDemoDir'), runDir: ctx.runDir });
    ctx.check('copies du corpus et des quatre formats préparées', true, { archiveCount: fixtures.archiveCount });
    app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir: ctx.dir('workspace') });
    const { page, events } = app;
    try {
      await page.client.command('POST', '/window/rect', { width: 1440, height: 900 });
      windowSize = { mode: 'rect', ...await page.client.command('GET', '/window/rect') };
      if (windowSize.width !== 1440 || windowSize.height !== 900) throw new Error('Dimensions non appliquées');
    } catch (error) {
      await page.client.command('POST', '/window/maximize', {});
      windowSize = { mode: 'maximized', reason: error.message, ...await page.client.command('GET', '/window/rect') };
    }
    windowSize.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    ctx.check('dimensions de capture relevées', true, windowSize);
    events.setStep('accueil-catalogue');
    await page.locator('#mode-open-catalogue').click();
    await page.locator('main.catalogue-screen').waitFor();
    ctx.check('écran Catalogue affiché', true);
    // Le profil neuf propose l'accès réseau aux métadonnées Lunii : refuser
    // par l'interface pour conserver une recette indépendante du réseau.
    const no = page.getByRole('alertdialog').getByRole('button', { name: 'Non', exact: true });
    try { await no.waitFor({ timeout: 5000 }); }
    catch { ctx.check('consentement Lunii', null, { reason: 'Dialogue absent dans cette version' }); }
    if (await no.count()) await no.click();
    await until(page, async () => (await operations(page)).every(op => terminal.has(op.status)), 'scan initial');
    const baseline = await cards(page);
    ctx.check('profil neuf sans fiche', baseline.length === 0, { count: baseline.length });
    const startCount = events.ipc().filter(entry => entry.cmd === 'catalogue_start_scan').length;
    const add = page.getByRole('button', { name: 'Ajouter des dossiers', exact: true });
    let viaPreferences = false;
    if (!await add.count()) {
      await page.getByRole('button', { name: /^Préférences de l’application/ }).click();
      await page.locator('.opts-nav').getByRole('button', { name: 'Catalogue', exact: true }).click();
      viaPreferences = true;
    }
    await answerNext(page, 'open', fixtures.directory);
    await add.click();
    events.setStep('analyse');
    const scans = await until(page, async () => {
      await page.drain();
      const starts = events.ipc().filter(entry => entry.cmd === 'catalogue_start_scan').slice(startCount);
      if (!starts.length) return null;
      const requests = new Set(starts.map(entry => entry.body?.requestId));
      const added = (await operations(page)).filter(op => requests.has(op.requestId));
      return added.length === requests.size && added.every(op => terminal.has(op.status)) ? added : null;
    }, 'fin réelle de l’analyse', 10 * 60_000);
    if (viaPreferences) {
      await page.keyboard.press('Escape');
      await page.locator('.opts-modal-box').waitFor({ state: 'hidden' });
    }
    ctx.check('analyse terminée', scans.every(op => op.scanComplete === true && ['success', 'partial'].includes(op.status)), { scans });
    const expected = baseline.length + scans.reduce((sum, op) => sum + (op.cards?.created ?? 0), 0);
    const indexed = await cards(page);
    ctx.check('nombre de fiches attendu selon le bilan du scan', indexed.length === expected && expected > 0,
      { expected, actual: indexed.length, oracle: 'somme cards.created des nouveaux scans + état initial' });
    ctx.check('démo regroupée dans les quatre formats', indexed.some(card =>
      ['project', 'zip', 'sevenZip', 'folder'].every(format => card.exemplars.some(exemplar => exemplar.format === format))));
    ctx.check('jeu de fiches varié', indexed.length >= 8, { count: indexed.length, target: 'environ dix fiches' });
    await until(page, async () => Number(await page.locator('[role="grid"][aria-rowcount]').getAttribute('aria-rowcount')) === expected,
      'rendu de toutes les fiches');

    // L'absence d'une commande est sautée ; une commande présente qui échoue
    // reste un échec et n'est jamais masquée par un catch de convenance.
    // Capturer une fois les jaquettes visibles chargées (au plus 20 s, sinon capture telle quelle).
    async function shot(target, label) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && await target.evaluate(() => [...document.querySelectorAll('.catalogue-cover--missing span')]
        .some(node => node.textContent.trim() === 'Chargement de la jaquette'))) await new Promise(done => setTimeout(done, 250));
      return ctx.shot(target, label);
    }
    async function optional(label, locator, action) {
      events.setStep(label);
      if (!await locator.count()) { ctx.check(label, null, { reason: 'Commande absente dans cette version' }); return false; }
      await action();
      await shot(page, label);
      return true;
    }
    const rows = () => page.locator('[data-card-id]');
    await rows().first().locator('.catalogue-card-title').click();
    await page.locator('#catalogue-fiche-panel').waitFor();
    await shot(page, 'grille-et-fiche');
    events.setStep('fiche-invalide-retour-accueil');
    await page.locator('#catalogue-fiche-pencil-age').click();
    const ageInput = '#catalogue-fiche-panel .catalogue-inline-editor input[type="number"]';
    await page.locator(ageInput).waitFor();
    const ageLayout = await page.evaluate(selector => {
      const input = document.querySelector(selector);
      const shell = input.closest('.catalogue-inline-editor');
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas').getContext('2d');
      canvas.font = style.font;
      const rect = element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right }; };
      // − champ + puis ✓ ✕ : un conflit ajoute ses propres boutons sur une autre ligne.
      const row = input.closest('.catalogue-inline-input');
      const controls = [...row.querySelectorAll(':scope > button, :scope > input'),
        ...shell.querySelectorAll(':scope > .btn-icon')].map(rect);
      return { textWidth: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        requiredTextWidth: canvas.measureText('18').width, controls, panel: rect(document.querySelector('#catalogue-fiche-panel')) };
    }, ageInput);
    ctx.check('âge en ligne lisible, boutons distincts et contenus dans la fiche',
      ageLayout.textWidth >= ageLayout.requiredTextWidth && ageLayout.controls.length === 5 &&
      ageLayout.controls.every((box, index, boxes) => box.left >= ageLayout.panel.left && box.right <= ageLayout.panel.right &&
        (index === 0 || box.left >= boxes[index - 1].right)), ageLayout);
    await fill(page, ageInput, '19');
    await page.locator('#catalogue-menu').click();
    await page.getByRole('menuitem', { name: 'Retour à l’accueil', exact: true }).click();
    await page.drain();
    const refusedDeparture = await page.evaluate(selector => {
      const input = document.querySelector(selector);
      return { catalogue: Boolean(document.querySelector('main.catalogue-screen')),
        value: input?.value, invalid: input?.getAttribute('aria-invalid'),
        error: Boolean(document.querySelector('#catalogue-fiche-panel [role="alert"]')) };
    }, ageInput);
    ctx.check('retour accueil refusé : fiche, brouillon et erreur conservés',
      refusedDeparture.catalogue && refusedDeparture.value === '19' && refusedDeparture.invalid === 'true' && refusedDeparture.error, refusedDeparture);
    await page.locator('#catalogue-fiche-panel .catalogue-inline-editor').getByRole('button', { name: 'Annuler', exact: true }).click();
    const densityBefore = Number(await page.locator(CATALOGUE_DENSITY).getAttribute('value'));
    for (const index of [0, 1, 2]) {
      await setCatalogueDensity(page, index);
      const density = await page.evaluate(selector => {
        const input = document.querySelector(selector);
        return { value: Number(input.value), disabled: input.disabled, name: input.getAttribute('aria-valuetext') };
      }, CATALOGUE_DENSITY);
      ctx.check(`densité au clavier : cran ${index}`, density.value === index && !density.disabled && Boolean(density.name), density);
    }
    await setCatalogueDensity(page, densityBefore);
    await optional('panneau-masque', page.getByRole('button', { name: 'Fermer la fiche', exact: true }), async () => {
      await page.getByRole('button', { name: 'Fermer la fiche', exact: true }).click();
      await page.locator('#catalogue-fiche-panel').waitFor({ state: 'hidden' });
    });
    await optional('vue-liste', page.getByRole('button', { name: 'Liste', exact: true }), async () => {
      await page.getByRole('button', { name: 'Liste', exact: true }).click();
      await page.locator('.catalogue-table--list').waitFor();
      const density = await page.evaluate(selector => {
        const input = document.querySelector(selector);
        return { disabled: input.disabled, visible: input.getBoundingClientRect().width > 0 };
      }, CATALOGUE_DENSITY);
      ctx.check('densité visible et désactivée en liste', density.visible && density.disabled, density);
    });
    const grid = page.getByRole('button', { name: 'Vignettes', exact: true });
    if (await grid.count()) await grid.click();
    events.setStep('grande-modale');
    const cardTitle = await rows().first().locator('.catalogue-card-title').find();
    // Deux clics natifs rapprochés : le second porte detail=2 dans WebKitGTK.
    try {
      await page.client.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', duration: 0, origin: cardTitle, x: 0, y: 0 },
        { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
        { type: 'pause', duration: 100 },
        { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
      ] }] });
    } finally { await page.client.command('DELETE', '/actions'); }
    const largeModal = page.locator('.catalogue-fiche-modal[role="dialog"]');
    await largeModal.waitFor();
    ctx.check('grande modale visible après double-clic', true);
    await shot(page, 'grande-modale');
    await page.keyboard.press('Escape');
    await largeModal.waitFor({ state: 'hidden' });
    ctx.check('grande modale fermée par Échap', true);

    const age = page.getByRole('button', { name: 'Âge recommandé', exact: true });
    const ageOpened = await optional('popover-age', age, async () => {
      await age.click();
      await page.locator('.catalogue-age-editor').waitFor();
      await page.locator('.catalogue-age-presets').getByRole('button', { name: '5', exact: true }).click();
      await until(page, () => page.locator('.catalogue-age-presets').getByRole('button', { name: '5', exact: true })
        .getAttribute('aria-pressed').then(value => value === 'true'), 'âge 5 appliqué en direct');
    });
    if (ageOpened) {
      await page.keyboard.press('Escape');
      await page.locator('.catalogue-age-editor').waitFor({ state: 'hidden' });
      await page.locator('.catalogue-filter-line').waitFor();
      const count = await page.locator('.catalogue-filter-line .catalogue-result-count').innerText();
      ctx.check('compteur des filtres N sur Total', /^\d+ sur \d+$/.test(count.trim()), { count });
      // L'état vide filtré a aussi son « Tout effacer » : viser celui de la ligne des filtres.
      await page.locator('.catalogue-filter-line button').filter({ hasText: 'Tout effacer' }).click();
    }
    const filters = page.getByRole('button', { name: 'Filtres', exact: true });
    const filterMenu = await optional('menu-filtres', filters, () => filters.click());
    if (filterMenu) {
      // Le pilote ne couvre pas getByRole(menuitemcheckbox) : viser le rôle en CSS.
      const favorite = page.locator('[role="menuitemcheckbox"]').filter({ hasText: 'Favoris' });
      await favorite.click();
      await until(page, () => favorite.getAttribute('aria-checked').then(value => value === 'true'), 'filtre Favoris coché');
      await page.keyboard.press('Escape');
      await page.locator('.catalogue-filter-line').waitFor();
      await page.locator('.catalogue-filter-chip').filter({ hasText: 'Favoris' }).waitFor();
      await shot(page, 'ligne-filtres-active');
      // L'état vide filtré a aussi son « Tout effacer » : viser celui de la ligne des filtres.
      await page.locator('.catalogue-filter-line button').filter({ hasText: 'Tout effacer' }).click();
    } else ctx.check('ligne-filtres-active', null, { reason: 'Menu Filtres absent' });
    await fill(page, '#catalogue-search', 'zzzz-e2e-aucune-fiche-7f638b20');
    await page.keyboard.press('Escape');
    await page.locator('[data-empty-state="filtered"]').waitFor();
    await shot(page, 'vide-filtre');
    await fill(page, '#catalogue-search', '');
    await page.keyboard.press('Escape');

    const multiple = indexed.find(card => new Set(card.exemplars.map(exemplar => exemplar.format)).size === 4)
      ?? indexed.find(card => card.exemplars.length > 1);
    if (multiple) {
      await page.locator(`[data-card-id=${JSON.stringify(multiple.id)}] .catalogue-card-title`).click();
      await until(page, () => page.locator('#catalogue-fiche-copies > li').count().then(count => count === multiple.exemplars.length), 'lignes des exemplaires');
      await page.evaluate(() => document.getElementById('catalogue-fiche-copies').scrollIntoView({ block: 'nearest' }));
      const trashRows = await page.evaluate(() => [...document.querySelectorAll('#catalogue-fiche-copies > li')].map(row => ({
        id: row.id, trash: !!row.querySelector('button[aria-label="Mettre à la corbeille"]'),
      })));
      ctx.check('lignes d’exemplaire avec bouton corbeille', trashRows.length > 1 && trashRows.every(row => row.trash), { rows: trashRows });
      await shot(page, 'plusieurs-exemplaires-et-corbeilles');
    } else ctx.check('plusieurs-exemplaires-et-corbeilles', false, { reason: 'Aucune fiche regroupée malgré la copie et la démo' });

    if (await rows().count() >= 2) {
      await rows().first().locator('.catalogue-card-title').click();
      await page.client.command('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE009' }] }] });
      try { await rows().nth(1).locator('.catalogue-card-title').click(); }
      finally { await page.client.command('DELETE', '/actions'); }
      await page.locator('.catalogue-selection-panel').waitFor();
      ctx.check('sélection multiple', await page.locator('[data-card-id][aria-selected="true"]').count() >= 2);
      await shot(page, 'selection-multiple');
    } else ctx.check('selection-multiple', null, { reason: 'Moins de deux fiches visibles' });
    await rows().first().locator('.catalogue-card-title').click();
    for (const [value, label] of [['light', 'theme-clair'], ['dark', 'theme-sombre']]) {
      const prefs = page.getByRole('button', { name: /^Préférences de l’application/ });
      if (!await prefs.count()) { ctx.check(label, null, { reason: 'Préférences absentes' }); continue; }
      await prefs.click();
      const select = page.locator('#interface select').filter({ has: page.locator('option[value="dark"]') });
      if (!await select.count()) {
        ctx.check(label, null, { reason: 'Sélecteur de thème absent' });
        await page.keyboard.press('Escape'); continue;
      }
      const option = select.locator(`option[value="${value}"]`);
      const optionElement = await option.find({ state: 'attached' });
      await page.client.command('POST', `/element/${optionElement[ELEMENT]}/click`, {});
      await page.drain();
      await until(page, () => page.evaluate(v => document.documentElement.dataset.theme === v, value), label);
      await page.keyboard.press('Escape');
      await page.locator('.opts-modal-box').waitFor({ state: 'hidden' });
      await shot(page, label);
    }
  } catch (error) {
    ctx.check('parcours Catalogue', false, { reason: error.stack || error.message });
    if (app) await ctx.shot(app.page, 'echec').catch(() => {});
  } finally {
    if (app) {
      try { await app.stop(); } catch (error) { ctx.check('arrêt application', false, { reason: error.message }); }
      // Le pilote vide la file avant arrêt ; vérifier le fichier effectivement livré.
      const file = join(ctx.runDir, 'events.jsonl');
      const faults = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(event => ['pageerror', 'console.error', 'ipc.error'].includes(event.kind))
        // Changer de fiche annule la recherche de copies identiques de la précédente ;
        // le front ignore ce refus attendu (useCatalogueIdenticalCopies).
        .filter(event => !(event.kind === 'ipc.error' && event.cmd === 'catalogue_identical_copies'
          && /"code":"GENERATION_CANCELLED"/.test(event.text ?? '')));
      ctx.check('aucune exception, erreur console ou IPC en échec dans events.jsonl', faults.length === 0, { faults });
    }
  }
  return ctx.finish({ window: windowSize, fixtures: fixtures && { directory: fixtures.directory, archiveCount: fixtures.archiveCount } });
}
